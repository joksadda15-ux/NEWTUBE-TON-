// api/broadcastTick.js — NEW (this update)
//
// This is what actually keeps a broadcast moving now — see
// lib/broadcastProcessor.js for why self-triggering was abandoned.
//
// No jobId needed: picks whatever the most recent broadcast job is, and if
// it isn't finished yet, processes its next chunk. If there's no job or the
// latest one is already done, this is a harmless no-op.
//
// GET /api/broadcastTick?secret=<BOT_TOKEN>
//
// ⚠️ SETUP REQUIRED (one-time, outside this codebase): point a free
// external cron service at this URL, running every 1 minute, indefinitely.
// cron-job.org (free, no cost, 1-minute granularity) is a good option:
//   1. Sign up free at https://cron-job.org
//   2. Create a new cronjob:
//      URL: https://newtube-ton.vercel.app/api/broadcastTick?secret=<BOT_TOKEN>
//      Schedule: every 1 minute
//   3. Save and enable it — leave it running permanently.
// Once set up, every broadcast queued from the admin panel will keep
// getting nudged forward automatically, a chunk at a time, until done —
// no manual visits needed, regardless of how many users there are.

import { getLatestBroadcastJob } from '../lib/broadcastJob.js';
import { processBroadcastChunk } from '../lib/broadcastProcessor.js';

const BOT_TOKEN = process.env.BOT_TOKEN;

export default async function handler(req, res) {
    if (!BOT_TOKEN || req.query.secret !== BOT_TOKEN) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const job = await getLatestBroadcastJob();
    if (!job || job.status === 'done') {
        return res.status(200).json({ ok: true, idle: true });
    }

    const result = await processBroadcastChunk(String(job._id));
    return res.status(200).json({ ...result, jobId: String(job._id) });
}
