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
import { isCronAuthorized } from '../lib/cronAuth.js';
import { getLatestBroadcastJob, createBroadcastJob } from '../lib/broadcastJob.js';
import { processBroadcastChunk } from '../lib/broadcastProcessor.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = 'https://t.me/NewTube12_bot/WatchTo_Earn'; // ⚠️ must match api/bot.js's MINI_APP_URL

const REMINDER_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours

// ✏️ ROTATING CAPTIONS — the 8-hour reminder cycles through these short captions
// in order (1st send = #1, next = #2, … then starts again from #1). Edit / add /
// remove freely (the position is saved in `settings` → autoEarnReminder.captionIndex).
const REMINDER_CAPTIONS = [
    `📺 <b>Daily ads are ready!</b>\nClaim today's limit and keep your balance growing.`,
    `🆕 <b>New tasks added!</b>\nCheck them out and earn WTC.`,
    `⛏️ <b>Mining is ready!</b>\nCollect your mining reward now.`,
    `▶️ <b>Watch and earn!</b>\nFill your video lootbox today.`,
    `🎁 <b>Promo codes drop in our channel!</b>\nOpen the channel, grab a code, redeem it in the app.`,
    `👥 <b>Invite friends, earn more!</b>\nGet WTC every time a friend completes the steps.`,
    `💸 <b>Ready to withdraw?</b>\nFinish today's tasks and ads, then cash out.`,
    `⏰ <b>Time to earn again!</b>\nYour tasks, ads and mining are open.`,
    `🏆 <b>Weekly referral contest is live!</b>\nInvite friends and climb the leaderboard.`,
    `🔥 <b>Don't miss today's rewards!</b>\nYour daily limits are open — claim them now.`,
    `✅ <b>Check today's tasks!</b>\nFinish them for instant WTC.`,
];


export default async function handler(req, res) {
    if (!isCronAuthorized(req)) {
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
    // v1.5 (saves Vercel usage): once we know when the reminder is next due, a warm instance remembers it and skips the
    // settings read on idle ticks (only a "not due yet" answer is ever cached, so a due reminder is never missed).
    const now = Date.now();
    if (global._reminderNextDueAt && now < global._reminderNextDueAt) {
        return res.status(200).json({ ok: true, idle: true });
    }
    const { db } = await connectToDatabase();
    const settings = db.collection('settings');
    const state = await settings.findOne({ _id: 'autoEarnReminder' });
    const lastSentAt = state?.lastSentAt ? new Date(state.lastSentAt).getTime() : 0;

    if (now - lastSentAt < REMINDER_INTERVAL_MS) {
        // এখনো 8h পার হয়নি — সত্যিকারের harmless idle tick।
        global._reminderNextDueAt = lastSentAt + REMINDER_INTERVAL_MS;
        return res.status(200).json({ ok: true, idle: true });
    }

    const users = db.collection('users');
    const totalUsers = await users.countDocuments({});

    // pick the next caption in rotation (saved position + 1 each time).
    const captionIndex = (Number(state?.captionIndex) || 0) % REMINDER_CAPTIONS.length;

    const newJob = await createBroadcastJob({
        text: REMINDER_CAPTIONS[captionIndex],
        buttonText: '🚀 Open NEWTUBE',
        buttonUrl: MINI_APP_URL,
        photoFileId: null,
        createdBy: 'auto-cron-8h',
        totalUsers,
    });

    // lastSentAt সাথে সাথেই lock করে ফেলা হচ্ছে (job তৈরির পরপরই) — পরের
    // মিনিটের tick এসে দ্বিতীয়বার নতুন job বানানো আটকাবে (তখন getLatestBroadcastJob
    // এই নতুন job-টাই ফেরত দেবে, status 'done' না হওয়া পর্যন্ত উপরের ব্লকেই ঢুকবে)।
    global._reminderNextDueAt = now + REMINDER_INTERVAL_MS;
    await settings.updateOne(
        { _id: 'autoEarnReminder' },
        { $set: { lastSentAt: new Date(now), captionIndex: (captionIndex + 1) % REMINDER_CAPTIONS.length } },
        { upsert: true }
    );

    const result = await processBroadcastChunk(String(newJob._id));
    return res.status(200).json({ ...result, jobId: String(newJob._id), autoReminder: true, caption: captionIndex + 1 });
}
