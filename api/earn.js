// api/earn.js — CONSOLIDATED + SECURITY FIX (Telegram initData verification)
//
// Previously every action trusted the client-supplied userId. Now every
// request requires a verified initData, and the userId extracted from it is
// the only one used — the client can never act as someone else by sending a
// different userId.
//
//   { action: 'videoStart',    initData }
//   { action: 'videoClaim',    initData, startTime, signature, claimedPoints }
//   { action: 'claimLootbox',  initData, adWatched }
//   { action: 'claimAdReward', initData, network }
//   { action: 'taskComplete',  initData, taskId }
//   { action: 'claimPromo',    initData, code }

import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { connectToDatabase } from '../lib/mongodb.js';
import { isMember } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { maybeAwardReferralMilestones } from '../lib/referral.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    LOOTBOX_CLAIM_MIN, LOOTBOX_CLAIM_MAX, DAILY_VIDEO_WTC_MAX, VIDEO_WTC_PER_SECOND,
    AD_NETWORK_REWARDS,
} from '../lib/constants.js';

const SECRET = process.env.VIDEO_SIGNING_SECRET;
const sign = (userId, startTime) => crypto.createHmac('sha256', SECRET).update(`${userId}:${startTime}`).digest('hex');

// ── videoClaim ──
// ⚠️ SECURITY FIX: the previous version verified the signature correctly, but
// never recorded that a given (userId, startTime) session had already been
// claimed. That meant the *same* signed startTime could be replayed via
// repeated claimAdReward-style calls — each replay recomputed `award` from
// the FULL elapsed time since the original startTime (not since the last
// claim), so spacing out replays over real wall-clock time compounded into
// far more WTC than a single honest claim would ever yield, letting someone
// script their way to the daily cap without watching anything. Now each
// startTime is single-use: it's atomically added to `usedVideoStarts` in the
// very same update that credits the reward, and the filter rejects any
// startTime already present in that array — so a replayed session earns
// nothing the second time around, full stop.
async function handleVideoClaim(req, res, db, userId) {
    const { startTime, signature, claimedPoints } = req.body;
    if (!startTime || !signature || claimedPoints === undefined) {
        return res.status(400).json({ ok: false, error: 'missing_fields' });
    }
    if (sign(userId, startTime) !== signature) {
        return res.status(400).json({ ok: false, error: 'invalid_signature' });
    }
    const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
    if (elapsedSeconds < 0) return res.status(400).json({ ok: false, error: 'invalid_time' });

    const maxEarnable = Math.min(LOOTBOX_CLAIM_MAX, Math.floor(elapsedSeconds * VIDEO_WTC_PER_SECOND));
    const requested = Math.floor(Number(claimedPoints));
    if (isNaN(requested) || requested <= 0) return res.status(400).json({ ok: false, error: 'invalid_amount' });
    const award = Math.min(requested, maxEarnable);
    if (award <= 0) return res.status(400).json({ ok: false, error: 'insufficient_watch_time' });

    const users = db.collection('users');
    await ensureDailyReset(users, userId);

    const userCheck = await users.findOne({ _id: userId }, { projection: { isBanned: 1, pendingVideoWTC: 1 } });
    if (!userCheck) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (userCheck.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if (award > DAILY_VIDEO_WTC_MAX) return res.status(400).json({ ok: false, error: 'amount_exceeds_daily_cap' });

    // ⚠️ NEW: once the pending lootbox has reached the claimable minimum, stop
    // crediting further video WTC until the user actually claims it. Otherwise
    // WTC just keeps silently piling up in pendingVideoWTC (we've seen users
    // sit on 60+ WTC unclaimed) — this forces a claim (and its ad) before more
    // can accumulate, which is also what nudges the "please claim" UI below.
    if ((userCheck.pendingVideoWTC || 0) >= LOOTBOX_CLAIM_MIN) {
        return res.status(400).json({ ok: false, error: 'lootbox_claim_required' });
    }

    const startTimeKey = String(startTime);
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            dailyVideoWtcMined: { $lt: DAILY_VIDEO_WTC_MAX },
            usedVideoStarts: { $ne: startTimeKey }, // ⚠️ this exact session hasn't been claimed yet today
        },
        [
            { $set: { _newDailyMined: { $min: [DAILY_VIDEO_WTC_MAX, { $add: ['$dailyVideoWtcMined', award] }] } } },
            { $set: {
                pendingVideoWTC: { $add: ['$pendingVideoWTC', { $subtract: ['$_newDailyMined', '$dailyVideoWtcMined'] }] },
                dailyVideoWtcMined: '$_newDailyMined',
                // ⚠️ $setUnion here acts like $addToSet inside an aggregation-pipeline
                // update — atomically records this startTime as spent, in the SAME
                // operation that grants the reward, so there's no race window between
                // "check if used" and "mark as used".
                usedVideoStarts: { $setUnion: [{ $ifNull: ['$usedVideoStarts', []] }, [startTimeKey]] },
            } },
            { $unset: '_newDailyMined' },
        ],
        { returnDocument: 'after' }
    );
    if (!gate) {
        // Distinguish "already claimed this exact session" from "daily cap reached" for a clearer client error.
        const already = await users.findOne({ _id: userId, usedVideoStarts: startTimeKey }, { projection: { _id: 1 } });
        return res.status(400).json({ ok: false, error: already ? 'session_already_claimed' : 'daily_watch_limit_reached' });
    }

    return res.status(200).json({ ok: true, success: true, pendingVideoWTC: gate.pendingVideoWTC || 0, dailyVideoWtcMined: gate.dailyVideoWtcMined });
}

// ── claimLootbox ──
async function handleClaimLootbox(req, res, db, userId) {
    const { adWatched } = req.body;
    if (!adWatched) return res.status(400).json({ ok: false, error: 'ad_required' });

    const users = db.collection('users');
    const gate = await users.findOneAndUpdate(
        { _id: userId, isBanned: { $ne: true }, pendingVideoWTC: { $gte: LOOTBOX_CLAIM_MIN } },
        [
            { $set: {
                wtcBalance: { $add: ['$wtcBalance', '$pendingVideoWTC'] },
                lifetimeWtcEarned: { $add: ['$lifetimeWtcEarned', '$pendingVideoWTC'] },
            } },
            { $set: { pendingVideoWTC: 0 } },
        ],
        { returnDocument: 'before' }
    );

    if (!gate) {
        const exists = await users.findOne({ _id: userId }, { projection: { isBanned: 1 } });
        if (!exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (exists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        return res.status(400).json({ ok: false, error: 'below_minimum', message: `Minimum ${LOOTBOX_CLAIM_MIN} WTC required.` });
    }

    return res.status(200).json({ ok: true, pointsAdded: gate.pendingVideoWTC || 0 });
}

// ── claimAdReward ──
const COUNTER_FIELD = {
    adsgramDaily: 'adsgramDailyCountToday', adsgramSpecial: 'adsgramSpecialCountToday',
    monetag: 'monetagCountToday', giga: 'gigaCountToday',
};
async function handleClaimAdReward(req, res, db, userId) {
    const { network } = req.body;
    const config = AD_NETWORK_REWARDS[network];
    if (!config) return res.status(400).json({ ok: false, error: 'invalid_network' });

    const users = db.collection('users');
    const counterField = COUNTER_FIELD[network];
    await ensureDailyReset(users, userId);

    const gate = await users.findOneAndUpdate(
        { _id: userId, isBanned: { $ne: true }, [counterField]: { $lt: config.dailyLimit } },
        { $inc: { wtcBalance: config.reward, lifetimeWtcEarned: config.reward, lifetimeAdsWatched: 1, adsWatchedToday: 1, [counterField]: 1 } },
        { returnDocument: 'after' }
    );

    if (!gate) {
        const exists = await users.findOne({ _id: userId }, { projection: { isBanned: 1 } });
        if (!exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (exists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        return res.status(400).json({ ok: false, error: 'daily_limit_reached' });
    }

    await maybeAwardReferralMilestones(db, userId, { lifetimeAdsWatched: gate.lifetimeAdsWatched });
    return res.status(200).json({ ok: true, reward: config.reward, countToday: gate[counterField], dailyLimit: config.dailyLimit });
}

// ── taskComplete ──
// ⚠️ SECURITY FIX: previously the task.limit check used a plain read
// (`task.completionCount >= task.limit`), and completionCount was incremented
// separately with an unconditional updateOne — leaving a race window between
// the two. If many users completed the same limited task at almost the exact
// same moment, they could all see "not full yet" and pass, letting
// completionCount overshoot the task's limit (low severity, but a real bug).
// Now claiming the task's "slot" is also atomic — the check+increment of the
// task's own completionCount+limit condition happens in the same
// findOneAndUpdate, and if crediting the user's record fails afterward (e.g.
// a double-click race), the slot is rolled back.
async function handleTaskComplete(req, res, db, userId) {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const users = db.collection('users');
    const tasks = db.collection('tasks');
    await ensureDailyReset(users, userId);

    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if ((user.completedTasks || []).includes(taskId)) return res.status(200).json({ ok: false, alreadyDone: true });

    let taskObjId;
    try { taskObjId = new ObjectId(taskId); } catch { return res.status(400).json({ ok: false, error: 'invalid_task_id' }); }

    const task = await tasks.findOne({ _id: taskObjId });
    if (!task || !task.isApproved) return res.status(404).json({ ok: false, error: 'task_not_found' });
    if (task.category === 'channel') {
        const member = await isMember(userId, task.channelId);
        if (!member) return res.status(200).json({ ok: false, error: 'not_member' });
    }

    // ── STEP 1: atomically claim the task's "slot" (limit check + increment together) ──
    const taskGate = await tasks.findOneAndUpdate(
        { _id: taskObjId, $or: [{ limit: { $lte: 0 } }, { limit: { $exists: false } }, { $expr: { $lt: ['$completionCount', '$limit'] } }] },
        { $inc: { completionCount: 1 } },
        { returnDocument: 'after' }
    );
    if (!taskGate) return res.status(400).json({ ok: false, error: 'task_full' });

    const rewardWtc = task.rewardWtc || task.rewardGold || task.rewardPoints || 250;

    // ── STEP 2: atomically credit the user (a double-claim by the same user is caught right here) ──
    const gate = await users.findOneAndUpdate(
        { _id: userId, completedTasks: { $ne: taskId } },
        { $inc: { wtcBalance: rewardWtc, lifetimeWtcEarned: rewardWtc, tasksCompletedToday: 1 }, $addToSet: { completedTasks: taskId } },
        { returnDocument: 'after' }
    );
    if (!gate) {
        // Crediting the user failed (e.g. already done in a race) — give the task's slot back
        await tasks.updateOne({ _id: taskObjId }, { $inc: { completionCount: -1 } });
        return res.status(200).json({ ok: false, alreadyDone: true });
    }

    await maybeAwardReferralMilestones(db, userId, { completedTasksCount: gate.completedTasks.length });
    return res.status(200).json({ ok: true, rewardWtc });
}

// ── claimPromo ──
async function handleClaimPromo(req, res, db, userId) {
    const { code } = req.body;
    if (!code) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const promos = db.collection('promos');
    const users = db.collection('users');

    const promo = await promos.findOne({ code: String(code).trim() });
    if (!promo) return res.status(404).json({ ok: false, error: 'invalid_code' });
    if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) return res.status(400).json({ ok: false, error: 'expired' });

    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const maxUses = promo.maxUses || 9999;
    const promoGate = await promos.findOneAndUpdate(
        { _id: promo._id, usedCount: { $lt: maxUses }, redeemedBy: { $ne: userId } },
        { $inc: { usedCount: 1 }, $addToSet: { redeemedBy: userId } },
        { returnDocument: 'after' }
    );
    if (!promoGate) {
        const fresh = await promos.findOne({ _id: promo._id });
        if ((fresh.redeemedBy || []).includes(userId)) return res.status(400).json({ ok: false, error: 'already_used' });
        return res.status(400).json({ ok: false, error: 'fully_used' });
    }

    const reward = promo.reward || 0;
    await users.updateOne({ _id: userId }, { $inc: { wtcBalance: reward, lifetimeWtcEarned: reward } });
    return res.status(200).json({ ok: true, reward });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const { action } = req.body || {};

    // videoStart only HMAC-signs a timestamp — no DB, no user data touched.
    // Keeping it outside initData verification prevents session renewal failures
    // when TG_INIT_DATA expires mid-session (which would break the 30-second ticker).
    if (action === 'videoStart') {
        if (!SECRET) return res.status(500).json({ success: false, error: 'video_secret_missing' });
        const startTime = Date.now();
        const userId = req.body?.userId || 'anon';
        return res.status(200).json({ success: true, startTime, signature: sign(userId, startTime) });
    }

    // All other actions require a valid Telegram session
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { db } = await connectToDatabase();
    switch (action) {
        case 'videoClaim':     return handleVideoClaim(req, res, db, userId);
        case 'claimLootbox':   return handleClaimLootbox(req, res, db, userId);
        case 'claimAdReward':  return handleClaimAdReward(req, res, db, userId);
        case 'taskComplete':   return handleTaskComplete(req, res, db, userId);
        case 'claimPromo':     return handleClaimPromo(req, res, db, userId);
        default: return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
}
