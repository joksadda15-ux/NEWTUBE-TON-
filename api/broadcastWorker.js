// api/broadcastWorker.js — NEW / ⚠️ FIXED (this update)
//
// Processes ONE chunk (BROADCAST_CHUNK_SIZE users) of a broadcastJobs doc,
// then triggers a call to itself to process the next chunk — so a 3000+
// user broadcast survives Vercel Hobby's 10s function timeout instead of
// dying mid-loop with no resume (see lib/broadcastJob.js for why).
//
// ⚠️ BUG FIX (this update): the original version used a plain `fetch(...)`
// without `await` to trigger the next chunk ("fire-and-forget"). On Vercel,
// once a function sends its response, the execution environment is
// FROZEN — any in-flight network call that hasn't finished sending gets
// killed right there. So the very first self-trigger never actually went
// out, the chain never started, and NOTHING ever got sent (confirmed:
// admin got the "queued" message — that part is synchronous — but zero
// users received anything, because the worker was never really invoked).
// Fix: wrap the trigger call in `waitUntil()` from `@vercel/functions`,
// which explicitly tells Vercel to keep the function alive until that
// promise settles, even after the response has already been sent.
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
    BROADCAST_CHUNK_SIZE, BROADCAST_MSG_DELAY_MS,
} from '../lib/broadcastJob.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
// ⚠️ Same URL as APP_URL in api/bot.js — keep these in sync if you change domains.
const APP_URL = 'https://newtube-ton.vercel.app';

// Returns the promise (does NOT fire it bare) — caller hands this to
// waitUntil() so Vercel keeps the function alive until the request is sent.
//
// ⚠️ BUG FIX #2 (this update): waitUntil()'s promise is bound by the SAME
// maxDuration deadline as the invocation itself (confirmed in Vercel's own
// docs). The first version just did `waitUntil(fetch(nextChunkUrl))`, which
// waits for the FULL response — but the next chunk takes ~6-8s to process
// before it responds, so the CURRENT invocation (which already spent ~6-8s
// sending this chunk) would need to survive well past Hobby's 10s cap to
// see that fetch resolve. It got killed mid-wait, so the trigger sometimes
// went out and sometimes didn't — explains the sporadic, unreliable delivery.
// Fix: abort our own wait after 3s. That's enough time for the request to
// actually be dispatched; we don't need to see its response — the next
// invocation runs independently on Vercel once triggered, regardless of
// whether our end is still listening (aborting our side doesn't cancel it).
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
    const chunk = await users.find(query, { projection: { _id: 1 } })
        .sort({ _id: 1 })
        .limit(BROADCAST_CHUNK_SIZE)
        .toArray();

    if (chunk.length === 0) {
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

    for (const u of chunk) {
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

    // ⚠️ FIXED — was a bare, un-awaited `fetch(...)` before. Now the
    // trigger promise is registered with waitUntil() so Vercel actually
    // lets it complete instead of killing it the instant res.json() below
    // sends the response. This is the root cause of the "queued but nobody
    // ever received it" bug.
    waitUntil(triggerNextChunkPromise(jobId));

    return res.status(200).json({ ok: true, sentThisChunk: sentDelta, failedThisChunk: failedDelta });
            }
