// lib/broadcastJob.js — NEW
//
// পুরনো broadcast implementation একটা single request-এর ভেতর সব user-কে
// loop করে message পাঠাতো (api/bot.js এর bc_confirm handler)। 3000+ user
// এ Vercel Hobby-র 10s timeout-এ function মাঝপথে মরে যেত, "Done" কখনো
// আসতো না, আর কোনো resume/checkpoint না থাকায় বেশিরভাগ user কখনোই
// message পেতো না।
//
// এখন broadcast একটা persisted job (`broadcastJobs` collection) — cursor
// (lastUserId) দিয়ে ট্র্যাক হয়, প্রতিবার ছোট একটা chunk পাঠিয়ে
// self-trigger করে পরের chunk চালায় (api/broadcastWorker.js দেখুন)।

import { connectToDatabase } from './mongodb.js';

export const BROADCAST_CHUNK_SIZE = 75;       // ~7.5s at 100ms/msg — safely under the 10s Hobby limit
export const BROADCAST_MSG_DELAY_MS = 100;     // 10 msg/sec, under Telegram's 30/sec cap
export const BROADCAST_LOCK_STALE_MS = 30_000; // if a "running" lock is older than this, assume the previous invocation died and allow retry

export async function createBroadcastJob({ text, buttonText, buttonUrl, photoFileId, createdBy, totalUsers }) {
    const { db } = await connectToDatabase();
    const doc = {
        status: 'pending',
        text, buttonText: buttonText || null, buttonUrl: buttonUrl || null, photoFileId: photoFileId || null,
        totalUsers,
        lastUserId: null,
        sentCount: 0,
        failedCount: 0,
        createdBy: String(createdBy),
        createdAt: new Date(),
        updatedAt: new Date(),
        lockedAt: null,
        finishedAt: null,
    };
    const { insertedId } = await db.collection('broadcastJobs').insertOne(doc);
    return { ...doc, _id: insertedId };
}

export async function getBroadcastJob(jobId) {
    const { db } = await connectToDatabase();
    const { ObjectId } = await import('mongodb');
    return db.collection('broadcastJobs').findOne({ _id: new ObjectId(jobId) });
}

// চাল-নেওয়ার আগে lock নেয় — একই job দুইবার একসাথে না চলার জন্য (self-trigger
// double-fire বা worker manually re-visit করলে ওভারল্যাপ ঠেকায়)।
// stale lock (আগের invocation crash করেছে ধরে) হলে override করে নিয়ে নেয়।
export async function tryLockJob(jobId) {
    const { db } = await connectToDatabase();
    const { ObjectId } = await import('mongodb');
    const staleThreshold = new Date(Date.now() - BROADCAST_LOCK_STALE_MS);
    const result = await db.collection('broadcastJobs').findOneAndUpdate(
        {
            _id: new ObjectId(jobId),
            status: { $in: ['pending', 'running'] },
            $or: [{ lockedAt: null }, { lockedAt: { $lt: staleThreshold } }],
        },
        { $set: { status: 'running', lockedAt: new Date(), updatedAt: new Date() } },
        { returnDocument: 'after' }
    );
    return result?.value || result || null; // driver-version-safe
}

export async function updateJobProgress(jobId, { lastUserId, sentDelta, failedDelta }) {
    const { db } = await connectToDatabase();
    const { ObjectId } = await import('mongodb');
    await db.collection('broadcastJobs').updateOne(
        { _id: new ObjectId(jobId) },
        {
            $set: { lastUserId, updatedAt: new Date(), lockedAt: null },
            $inc: { sentCount: sentDelta, failedCount: failedDelta },
        }
    );
}

export async function markJobDone(jobId) {
    const { db } = await connectToDatabase();
    const { ObjectId } = await import('mongodb');
    await db.collection('broadcastJobs').updateOne(
        { _id: new ObjectId(jobId) },
        { $set: { status: 'done', finishedAt: new Date(), lockedAt: null, updatedAt: new Date() } }
    );
}
