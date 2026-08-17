// api/broadcastWorker.js — NEW / ⚠️ FIXED (this update, 4th fix)
//
// Processes users from a broadcastJobs doc in small batches, then triggers
// a call to itself to keep going — so a 3000+ user broadcast survives
// Vercel Hobby's ~10s function timeout instead of dying mid-loop with no
// resume (see lib/broadcastJob.js for why).
//
// ⚠️ BUG FIX #1: the original version used a plain `fetch(...)` without
// `await` to trigger the next chunk. Vercel freezes execution the instant
// a response is sent, killing any un-awaited network call — the very first
// self-trigger never actually went out, so NOTHING was ever sent.
//
// ⚠️ BUG FIX #2: switching to `waitUntil()` alone wasn't enough — that
// promise is bound by the SAME maxDuration deadline as the invocation.
// Fixed by aborting our own wait after a short timeout — we only need the
// request dispatched, not answered.
//
// ⚠️ BUG FIX #3: chunk size was sized only around the artificial
// inter-message delay, ignoring that `await tgSend(...)` is itself a real
// network round-trip. Switched from a fixed head-count to a time budget.
//
// ⚠️ BUG FIX #4 (this one — the actual reason chains kept dying after
// EXACTLY one chunk, every single time, not randomly): the time budget in
// fix #3 was measured starting from the beginning of the SEND LOOP only —
// it never accounted for the time already spent on connectToDatabase(),
// tryLockJob(), and the candidates query, all of which happen BEFORE the
// loop starts. So real total elapsed time (DB overhead + 7s loop +
// updateJobProgress + trigger dispatch) was landing at or past Vercel's
// real cutoff — late enough that updateJobProgress usually still squeezed
// in (explaining why partial progress like "83 sent" WAS saved), but the
// self-trigger line right after it almost never got to run at all. That's
// why the first hop (triggered by api/bot.js, which starts its own fresh
// budget) always worked, while every self-triggered hop after it reliably
// died — consistent, not probabilistic.
// Fixed by measuring elapsed time from the true start of the ENTIRE
// invocation (before any DB call), and reserving a fixed chunk of time at
// the end — no matter how long the DB overhead ends up being — for
// updateJobProgress + dispatching the next trigger. Also guarantees at
// least one user gets sent per invocation regardless of the clock, so a
// slow-DB day can never fully stall the job (no progress, no retry).
//
// Triggered by:
//   1) api/bot.js right after the admin confirms the broadcast (bc_confirm)
//   2) itself, repeatedly, until the job is done
//
// GET/POST /api/broadcastWorker?jobId=...&secret=<BOT_TOKEN>
// ⚠️ secret reuses BOT_TOKEN as a shared secret, same pattern as
// api/admin/setup-indexes.js — no new env var needed, and it's never sent
// to end users so it's safe to reuse here.

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend, tgSendPhoto } from '../lib/telegram.js';
import { waitUntil } from '@vercel/functions';
import {
    getBroadcastJob, tryLockJob, updateJobProgress, markJobDone,
    BROADCAST_MSG_DELAY_MS,
} from '../lib/broadcastJob.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
// ⚠️ Same URL as APP_URL in api/bot.js — keep these in sync if you change domains.
const APP_URL = 'https://newtube-ton.vercel.app';

// How many candidate users to pull from the DB per invocation — just an
// upper ceiling; the time budget below decides how many actually get sent.
const CANDIDATE_BATCH_SIZE = 500;

// ⚠️ FIX #4 — deliberately conservative overall budget, measured from the
// TRUE top of the invocation (see FUNCTION_START below), not just the send
// loop. Vercel Hobby's real cutoff is ~10s; this stays well under it.
const TOTAL_BUDGET_MS = 8000;
// Reserved out of the budget above for updateJobProgress's DB write + the
// self-trigger dispatch — guaranteed available no matter how long
// connectToDatabase/candidates-query/tryLockJob took up front.
const WRAPUP_RESERVE_MS = 2500;
// Trigger dispatch aborts our own wait after this long — we only need the
// request sent, not answered, and this must fit inside WRAPUP_RESERVE_MS
// alongside updateJobProgress's own DB write.
const TRIGGER_ABORT_MS = 1500;

function triggerNextChunkPromise(jobId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRIGGER_ABORT_MS);
    return fetch(`${APP_URL}/api/broadcastWorker?jobId=${jobId}&secret=${BOT_TOKEN}`, { signal: controller.signal })
        .catch(() => {}) // expected: AbortError once the cutoff hits — not a real failure
        .finally(() => clearTimeout(timeout));
}

export default async function handler(req, res) {
    // ⚠️ FIX #4 — clock starts here, BEFORE any DB call, so the send-loop
    // deadline below correctly accounts for connectToDatabase/tryLockJob/
    // candidates-query overhead instead of ignoring it.
    const FUNCTION_START = Date.now();

    if (!BOT_TOKEN || req.query.secret !== BOT_TOKEN) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const jobId = req.query.jobId;
    if (!jobId) return res.status(400).json({ ok: false, error: 'missing_job_id' });

    const job = await tryLockJob(jobId);
    if (!job) {
        // Either the job doesn't exist, already finished, or another
        // invocation currently holds the lock — nothing to do here.
        return res.status(200).json({ ok: true, skipped: true });
    }

    const { db } = await connectToDatabase();
    const users = db.collection('users');

    const query = job.lastUserId ? { _id: { $gt: job.lastUserId } } : {};
    const candidates = await users.find(query, { projection: { _id: 1 } })
        .sort({ _id: 1 })
        .limit(CANDIDATE_BATCH_SIZE)
        .toArray();

    if (candidates.length === 0) {
        await markJobDone(jobId);
        await tgSend(ADMIN_ID, `✅ <b>Broadcast Done!</b>\n\nSent: <b>${job.sentCount}</b> | Failed: <b>${job.failedCount}</b>`, {
            reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] },
        });
        return res.status(200).json({ ok: true, done: true, sentCount: job.sentCount, failedCount: job.failedCount });
    }

    const extra = {};
    if (job.buttonText && job.buttonUrl) {
        extra.reply_markup = { inline_keyboard: [[{ text: job.buttonText, url: job.buttonUrl }]] };
    }

    let sentDelta = 0, failedDelta = 0;
    let lastUserId = job.lastUserId;
    // Whatever's left of the budget once we get here, after DB overhead —
    // could be less than TOTAL_BUDGET_MS - WRAPUP_RESERVE_MS if
    // connectToDatabase/tryLockJob/the query were slow this time.
    const sendDeadline = FUNCTION_START + TOTAL_BUDGET_MS - WRAPUP_RESERVE_MS;

    for (let i = 0; i < candidates.length; i++) {
        const u = candidates[i];
        try {
            if (job.photoFileId) {
                await tgSendPhoto(u._id, job.photoFileId, job.text, extra);
            } else {
                await tgSend(u._id, job.text, extra);
            }
            sentDelta++;
        } catch {
            failedDelta++;
        }
        lastUserId = u._id;
        // ⚠️ Checked AFTER processing the current user, not before — this
        // guarantees at least one user gets sent per invocation even on a
        // slow-DB day, so the job can never fully livelock at zero progress.
        if (Date.now() >= sendDeadline) break;
        if (i < candidates.length - 1) await new Promise((r) => setTimeout(r, BROADCAST_MSG_DELAY_MS));
    }

    await updateJobProgress(jobId, { lastUserId, sentDelta, failedDelta });

    waitUntil(triggerNextChunkPromise(jobId));

    return res.status(200).json({ ok: true, sentThisChunk: sentDelta, failedThisChunk: failedDelta });
}
