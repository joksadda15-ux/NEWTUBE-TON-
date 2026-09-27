// api/broadcastTick.js — UPDATED (this update)
//
// This is what actually keeps a broadcast moving — see
// lib/broadcastProcessor.js for why self-triggering was abandoned.
//
// No jobId needed: picks whatever the most recent broadcast job is, and if
// it isn't finished yet, processes its next chunk. If there's no job or the
// latest one is already done, it now ALSO checks whether the 12-hour "Daily
// Complete Ads Earn" auto-reminder is due — if so it queues that as a new
// broadcast job right here. Otherwise this is a harmless no-op.
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
//
// ⚠️ MERGED IN (this update) — the 12h auto-reminder used to be planned as
// its own new file (api/cron/autoEarnReminder.js), but Vercel's Hobby plan
// caps a project at 12 serverless functions total, and this project was
// already sitting at exactly 12. Adding a 13th file would have broken the
// whole deployment. Since this endpoint is ALREADY pinged every 1 minute
// by the external cron-job.org job (see setup above), the reminder check
// piggybacks on that SAME ping instead of needing its own separate cron —
// no new cron-job.org entry needed at all.
//
// The reminder only fires when NO broadcast is currently running (never
// stacks a new job on top of an in-progress one — see the comment below),
// and it self-throttles via a stored `lastSentAt` timestamp in the
// `settings` collection, so being pinged every minute is harmless — it
// only actually queues+sends once every 12 hours.

import { connectToDatabase } from '../lib/mongodb.js';
import { getLatestBroadcastJob, createBroadcastJob } from '../lib/broadcastJob.js';
import { processBroadcastChunk } from '../lib/broadcastProcessor.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = 'https://t.me/NewTube12_bot/WatchTo_Earn'; // ⚠️ must match api/bot.js's MINI_APP_URL

const REMINDER_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

// ✏️ চাইলে এই টেক্সট/বাটন যা খুশি বদলে ফেলুন — নিচের broadcast এই টেক্সটটাই পাঠাবে।
const REMINDER_TEXT =
    `🎬 <b>Daily Complete Ads Earn 0.1$!</b>\n\n` +
    `আজকের earning miss করবেন না —\n\n` +
    `1️⃣ প্রথমে <b>Task</b> complete করুন ✅\n` +
    `2️⃣ তারপর <b>Video Watch</b> করে reward নিন ▶️\n\n` +
    `👇 এখনই App খুলে শুরু করুন:`;

export default async function handler(req, res) {
    if (!BOT_TOKEN || req.query.secret !== BOT_TOKEN) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const job = await getLatestBroadcastJob();

    if (job && job.status !== 'done') {
        // একটা broadcast (manual admin broadcast হোক বা auto-reminder) already
        // চলছে — সেটাই চালিয়ে যাও, নতুন কিছু চেক করার দরকার নেই এই tick-এ।
        const result = await processBroadcastChunk(String(job._id));
        return res.status(200).json({ ...result, jobId: String(job._id) });
    }

    // কোনো broadcast এই মুহূর্তে চলছে না (হয় কখনো হয়নি, নয়তো শেষ হয়ে গেছে) —
    // তাহলে দেখো auto-reminder-এর পালা এসেছে কিনা।
    const { db } = await connectToDatabase();
    const settings = db.collection('settings');
    const state = await settings.findOne({ _id: 'autoEarnReminder' });
    const now = Date.now();
    const lastSentAt = state?.lastSentAt ? new Date(state.lastSentAt).getTime() : 0;

    if (now - lastSentAt < REMINDER_INTERVAL_MS) {
        // এখনো 12h পার হয়নি — সত্যিকারের harmless idle tick।
        return res.status(200).json({ ok: true, idle: true });
    }

    const users = db.collection('users');
    const totalUsers = await users.countDocuments({});

    const newJob = await createBroadcastJob({
        text: REMINDER_TEXT,
        buttonText: '🚀 Open NEWTUBE',
        buttonUrl: MINI_APP_URL,
        photoFileId: null,
        createdBy: 'auto-cron-12h',
        totalUsers,
    });

    // lastSentAt সাথে সাথেই lock করে ফেলা হচ্ছে (job তৈরির পরপরই) — পরের
    // মিনিটের tick এসে দ্বিতীয়বার নতুন job বানানো আটকাবে (তখন getLatestBroadcastJob
    // এই নতুন job-টাই ফেরত দেবে, status 'done' না হওয়া পর্যন্ত উপরের ব্লকেই ঢুকবে)।
    await settings.updateOne(
        { _id: 'autoEarnReminder' },
        { $set: { lastSentAt: new Date(now) } },
        { upsert: true }
    );

    const result = await processBroadcastChunk(String(newJob._id));
    return res.status(200).json({ ...result, jobId: String(newJob._id), autoReminder: true });
}
