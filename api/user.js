// api/user.js — CONSOLIDATED + SECURITY FIX (Telegram initData verification)
//
// Key change: previously the client-supplied userId was trusted as-is — anyone
// could open browser DevTools, call the API directly, and pass someone else's
// userId. Now every request requires Telegram's `initData` (a signed string)
// which the server verifies cryptographically — nobody can forge it without
// the bot token, so userId can no longer be spoofed.
//
//   POST /api/user   body: { action: 'init', initData, fingerprint }
//   GET  /api/user?action=checkJoin&initData=...
//   GET  /api/user?action=profile&initData=...

import { connectToDatabase } from '../lib/mongodb.js';
import { todayBD } from '../lib/constants.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { checkAndRecordFingerprint } from '../lib/fingerprintCheck.js';
import { isMember, OFFICIAL_CHANNEL, COMMUNITY_GROUP } from '../lib/telegram.js';
import { maybeAwardReferralMilestones } from '../lib/referral.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { getClientIp, checkIp, claimIp, claimIpForUser, getOwnerPublicInfo } from '../lib/ipRegistry.js';

async function handleInit(req, res, db) {
    const initData = req.body?.initData;
    const verified = verifyTelegramInitData(initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });

    const userId = String(verified.user.id);
    const firstName = verified.user.first_name;
    const username = verified.user.username;
    const referrerCode = verified.startParam; // ✅ comes from verified initData — client can't send a different one separately
    const { fingerprint } = req.body;

    // ── Season 3: pure IP gate, checked on EVERY init (new or returning
    // user) since the client calls action:init on every app boot. A
    // different account already owning this IP blocks entry outright —
    // the client shows the "IP Already In Use" screen with the owner's
    // public info and lets the person switch network or force-claim it.
    const clientIp = getClientIp(req);
    const ipCheck = await checkIp(db, clientIp, userId);
    if (ipCheck.blocked) {
        const owner = await getOwnerPublicInfo(db, ipCheck.ownerId);
        return res.status(409).json({ ok: false, error: 'ip_in_use', owner });
    }

    const users = db.collection('users');
    const existing = await users.findOne({ _id: userId });
    if (existing) {
        if (ipCheck.unclaimed) await claimIp(db, clientIp, userId); // link a fresh IP to a returning user
        return res.status(200).json({ ok: true, alreadyExists: true });
    }

    // after 60 days, a banned user's full `users` document auto-deletes
    // (see models/schema.js TTL index) to free up free-tier storage.
    // Without this check, that would silently look like a brand new user
    // here and hand them a fresh, un-banned account — undoing the ban.
    const stillBanned = await db.collection('bannedTelegramIds').findOne({ _id: userId });
    if (stillBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const newUser = {
        _id: userId,
        firstName: firstName || 'User',
        telegramUsername: username || 'N/A',
        wtcBalance: 0,
        usdtBalance: 0,
        lifetimeWtcEarned: 0,
        pendingVideoWTC: 0,
        referralCount: 0,
        weeklyReferralCount: 0,
        totalInvites: 0,
        referredBy: (referrerCode && referrerCode !== userId) ? String(referrerCode) : null,
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
        withdrawLevel: 1,          // ⚠️ NEW — Season 3 level system, see lib/constants.js WITHDRAW_LEVELS
        withdrawsUsedAtLevel: 0,
    };

    try {
        await users.insertOne(newUser);
    } catch (err) {
        if (err.code === 11000) return res.status(200).json({ ok: true, alreadyExists: true });
        throw err;
    }

    if (newUser.referredBy) {
        await users.updateOne({ _id: newUser.referredBy }, { $inc: { referralCount: 1, weeklyReferralCount: 1, totalInvites: 1 } });
    }

    await claimIp(db, clientIp, userId); // first account on this IP — claim it

    // ⚠️ CHANGED — checkAndRecordFingerprint (lib/fingerprintCheck.js) now
    // auto-suspends THIS account itself (isBanned:true + bannedTelegramIds
    // registry) the moment a duplicate-device match is found, instead of
    // only setting multiAccountFlag for later admin review. See that file
    // for the full reasoning/trade-off note. The ORIGINAL (first) account on
    // that device is never touched by this — only the newly-created one.
    const fpResult = await checkAndRecordFingerprint(db, userId, fingerprint);
    return res.status(200).json({ ok: true, created: true, multiAccountFlagged: fpResult.flagged });
}

// Season 3 "Switch account" — the way forward from the IP-in-use block
// screen besides changing network. Force-claims the IP for the CALLER's
// Telegram account and wipes their balance as the anti-abuse cost of doing
// so. See lib/ipRegistry.js:claimIpForUser for exactly what gets reset.
async function handleSwitchAccount(req, res, db) {
    const initData = req.body?.initData;
    const verified = verifyTelegramInitData(initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const stillBanned = await db.collection('bannedTelegramIds').findOne({ _id: userId });
    if (stillBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const existing = await db.collection('users').findOne({ _id: userId });
    if (!existing) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const clientIp = getClientIp(req);
    await claimIpForUser(db, clientIp, userId);
    return res.status(200).json({ ok: true, switched: true });
}

async function handleCheckJoin(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ joined: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    try {
        const [inChannel, inGroup] = await Promise.all([
            isMember(userId, OFFICIAL_CHANNEL),
            isMember(userId, COMMUNITY_GROUP),
        ]);
        const joined = inChannel && inGroup;

        if (joined) {
            try {
                await db.collection('users').updateOne({ _id: userId }, { $set: { channelVerified: true } });
                await maybeAwardReferralMilestones(db, userId, { channelVerified: true });
            } catch { /* non-blocking */ }
        } else {
            const existing = await db.collection('users').findOne({ _id: userId }, { projection: { channelVerified: 1 } });
            if (existing?.channelVerified) {
                await db.collection('users').updateOne({ _id: userId }, { $set: { channelVerified: false } });
                return res.status(200).json({ joined: false, inChannel, inGroup, leftAfterVerifying: true });
            }
        }

        return res.status(200).json({ joined, inChannel, inGroup });
    } catch (err) {
        console.error('checkJoin error:', err);
        return res.status(200).json({ joined: true, error: 'check_failed' });
    }
}

async function handleProfile(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const users = db.collection('users');
    await ensureDailyReset(users, userId);

    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const { multiAccountSiblings, multiAccountFingerprint, ...safeUser } = user;
    return res.status(200).json({ ok: true, user: safeUser });
}

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    if (req.method === 'POST') {
        const { action } = req.body || {};
        if (action === 'init') return handleInit(req, res, db);
        if (action === 'switchAccount') return handleSwitchAccount(req, res, db);
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
