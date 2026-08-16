// api/broadcastWorker.js — NEW / ⚠️ FIXED (this update, 3rd fix)
//
// Processes users from a broadcastJobs doc in small batches, then triggers
// a call to itself to keep going — so a 3000+ user broadcast survives
// Vercel Hobby's 10s function timeout instead of dying mid-loop with no
// resume (see lib/broadcastJob.js for why).
//
// ⚠️ BUG FIX #1: the original version used a plain `fetch(...)` without
// `await` to trigger the next chunk. Vercel freezes execution the instant
// a response is sent, killing any un-awaited network call — the very first
// self-trigger never actually went out, so NOTHING was ever sent.
//
// ⚠️ BUG FIX #2: switching to `waitUntil()` alone wasn't enough — that
// promise is bound by the SAME maxDuration deadline as the invocation, and
// the original code awaited the next chunk's FULL response (which itself
// takes several seconds), risking the parent getting killed mid-wait.
// Fixed by aborting our own wait after 3s (see triggerNextChunkPromise) —
// we only need the request dispatched, not answered.
//
// ⚠️ BUG FIX #3 (this one): chunk SIZE was sized only around the artificial
// inter-message delay (BROADCAST_MSG_DELAY_MS), completely ignoring that
// `await tgSend(...)` is a REAL network round-trip to Telegram's API —
// typically 150-500ms on its own. 120 users × (real latency + delay) blew
// way past Hobby's 10s cap, so the function got killed mid-loop on THE
// VERY FIRST CHUNK, before ever reaching updateJobProgress — which is also
// what triggers the next chunk. Result: job permanently stuck at
// status:"running", sentCount:0, nothing ever retried automatically.
// Fixed by switching from a fixed head-count per chunk to a TIME BUDGET:
// keep sending for up to SEND_TIME_BUDGET_MS of real wall-clock time,
// however many users that turns out to be, then stop and hand off the rest
// via the cursor — this is safe regardless of how slow/fast Telegram's API
// responds on any given invocation.
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

// How many candidate users to pull from the DB per invocation. This is just
// an upper ceiling — SEND_TIME_BUDGET_MS decides how many of them actually
// get processed before this invocation stops and hands off the rest.
const CANDIDATE_BATCH_SIZE = 500;
// Stop sending once this much wall-clock time has passed in THIS invocation
// (measured from the start of the send loop), leaving headroom under
// Hobby's 10s cap for connectToDatabase, the DB query, updateJobProgress,
// and dispatching the next trigger. Deliberately conservative — better to
// under-fill a chunk and take one extra hop than to risk getting killed
// before updateJobProgress runs (which is what caused bug #3 above).
const SEND_TIME_BUDGET_MS = 7000;

// Returns the promise (does NOT fire it bare) — caller hands this to
// waitUntil() so Vercel keeps the function alive until the request is sent.
// Aborts its own wait after 3s — we only need the request dispatched, not
// answered; the next invocation runs independently on Vercel once
// triggered, regardless of whether we're still listening for its response.
function triggerNextChunkPromise(jobId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    return fetch(`${APP_URL}/api/broadcastWorker?jobId=${jobId}&secret=${BOT_TOKEN}`, { signal: controller.signal })
        .catch(() => {}) // expected: AbortError once the 3s cutoff hits — not a real failure
        .finally(() => clearTimeout(timeout));
}

export default async function handler(req, res) {
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
    const loopStart = Date.now();

    for (const u of candidates) {
        // ⚠️ THE FIX — stop based on real elapsed time, not a fixed count.
        // Whatever's left over just gets picked up by the next invocation
        // via the lastUserId cursor.
        if (Date.now() - loopStart > SEND_TIME_BUDGET_MS) break;
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
        await new Promise((r) => setTimeout(r, BROADCAST_MSG_DELAY_MS));
    }

    await updateJobProgress(jobId, { lastUserId, sentDelta, failedDelta });

    waitUntil(triggerNextChunkPromise(jobId));

    return res.status(200).json({ ok: true, sentThisChunk: sentDelta, failedThisChunk: failedDelta });
}
