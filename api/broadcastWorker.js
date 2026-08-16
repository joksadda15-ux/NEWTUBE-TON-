// api/broadcastWorker.js — NEW
//
// Processes ONE chunk (BROADCAST_CHUNK_SIZE users) of a broadcastJobs doc,
// then fire-and-forgets a call to itself to process the next chunk — so a
// 3000+ user broadcast survives Vercel Hobby's 10s function timeout instead
// of dying mid-loop with no resume (see lib/broadcastJob.js for why).
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
import {
    getBroadcastJob, tryLockJob, updateJobProgress, markJobDone,
    BROADCAST_CHUNK_SIZE, BROADCAST_MSG_DELAY_MS,
} from '../lib/broadcastJob.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
// ⚠️ Same URL as APP_URL in api/bot.js — keep these in sync if you change domains.
const APP_URL = 'https://newtube-ton.vercel.app';

function triggerNextChunk(jobId) {
    // Fire-and-forget — do NOT await, so this function can return its
    // response immediately instead of waiting on the next chunk too.
    fetch(`${APP_URL}/api/broadcastWorker?jobId=${jobId}&secret=${BOT_TOKEN}`).catch((err) => {
        console.error(`broadcastWorker: failed to trigger next chunk for job ${jobId}:`, err.message);
    });
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

    // More users left → chain to the next chunk. Otherwise the *next*
    // invocation (triggered right now) will find an empty chunk and finalize.
    triggerNextChunk(jobId);

    return res.status(200).json({ ok: true, sentThisChunk: sentDelta, failedThisChunk: failedDelta });
}
