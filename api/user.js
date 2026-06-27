// api/user.js — CONSOLIDATED (Vercel Hobby-র ১২ ফাংশন সীমার মধ্যে থাকার জন্য)
//
// init.js + checkJoin.js এর সব লজিক একটা ফাইলে — আলাদা ফাইল না করে একটা
// "action" প্যারামিটার দিয়ে রুট করা হচ্ছে। নতুন UI থেকে কল করার ধরন:
//   POST /api/user   body: { action: 'init', userId, firstName, username, referrerCode, fingerprint }
//   GET  /api/user?action=checkJoin&userId=123
//   GET  /api/user?action=profile&userId=123   ← নতুন, UI-এর ব্যালেন্স/প্রোফাইল দেখানোর জন্য

import { connectToDatabase } from '../lib/mongodb.js';
import { todayBD } from '../lib/constants.js';
import { checkAndRecordFingerprint } from '../lib/fingerprintCheck.js';
import { isMember, OFFICIAL_CHANNEL, COMMUNITY_GROUP } from '../lib/telegram.js';
import { maybeAwardReferralMilestones } from '../lib/referral.js';

async function handleInit(req, res, db) {
    const { userId, firstName, username, referrerCode, fingerprint } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: 'missing_userId' });

    const users = db.collection('users');
    const existing = await users.findOne({ _id: String(userId) });
    if (existing) return res.status(200).json({ ok: true, alreadyExists: true });

    const newUser = {
        _id: String(userId),
        firstName: firstName || 'User',
        telegramUsername: username || 'N/A',
        wtcBalance: 0,
        lifetimeWtcEarned: 0,
        pendingVideoWTC: 0,
        referralCount: 0,
        totalInvites: 0,
        referredBy: (referrerCode && referrerCode !== String(userId)) ? String(referrerCode) : null,
        referralStep1Done: false,
        referralStep2Done: false,
        referralStep3Done: false,
        completedTasks: [],
        isBanned: false,
        channelVerified: false,
        withdrawalCount: 0,
        lastWithdrawDate: '',
        lifetimeAdsWatched: 0,
        adsWatchedToday: 0,
        adsgramDailyCountToday: 0,
        adsgramSpecialCountToday: 0,
        monetagCountToday: 0,
        gigaCountToday: 0,
        dailyVideoWtcMined: 0,
        tasksCompletedToday: 0,
        lastResetDate: todayBD(),
        welcomeBonusClaimed: false,
        createdAt: new Date(),
        multiAccountFlag: false,
        multiAccountSiblings: [],
    };

    try {
        await users.insertOne(newUser);
    } catch (err) {
        if (err.code === 11000) return res.status(200).json({ ok: true, alreadyExists: true });
        throw err;
    }

    if (newUser.referredBy) {
        await users.updateOne({ _id: newUser.referredBy }, { $inc: { referralCount: 1, totalInvites: 1 } });
    }

    const fpResult = await checkAndRecordFingerprint(db, String(userId), fingerprint);
    return res.status(200).json({ ok: true, created: true, multiAccountFlagged: fpResult.flagged });
}

async function handleCheckJoin(req, res, db) {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ joined: false, error: 'missing_userId' });

    try {
        const [inChannel, inGroup] = await Promise.all([
            isMember(userId, OFFICIAL_CHANNEL),
            isMember(userId, COMMUNITY_GROUP),
        ]);
        const joined = inChannel && inGroup;
        if (joined) {
            try {
                await db.collection('users').updateOne({ _id: String(userId) }, { $set: { channelVerified: true } });
                await maybeAwardReferralMilestones(db, String(userId), { channelVerified: true });
            } catch { /* non-blocking */ }
        }
        return res.status(200).json({ joined, inChannel, inGroup });
    } catch (err) {
        console.error('checkJoin error:', err);
        return res.status(200).json({ joined: true, error: 'check_failed' });
    }
}

async function handleProfile(req, res, db) {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ ok: false, error: 'missing_userId' });

    const user = await db.collection('users').findOne({ _id: String(userId) });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    // পাসওয়ার্ড/সেনসিটিভ কিছু নেই এই কালেকশনে, কিন্তু internal flag গুলো client-কে না দেখানোই ভালো
    const { multiAccountSiblings, multiAccountFingerprint, ...safeUser } = user;
    return res.status(200).json({ ok: true, user: safeUser });
}

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    if (req.method === 'POST') {
        const { action } = req.body || {};
        if (action === 'init') return handleInit(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'checkJoin') return handleCheckJoin(req, res, db);
        if (action === 'profile') return handleProfile(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}
