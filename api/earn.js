// api/earn.js — CONSOLIDATED (videoStart + videoClaim + claimLootbox + claimAdReward + taskComplete + claimPromo)
//
// সব POST, action ফিল্ড দিয়ে রুট হয়:
//   { action: 'videoStart', userId }
//   { action: 'videoClaim', userId, startTime, signature, claimedPoints }
//   { action: 'claimLootbox', userId, adWatched }
//   { action: 'claimAdReward', userId, network }
//   { action: 'taskComplete', userId, taskId }
//   { action: 'claimPromo', userId, code }

import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { connectToDatabase } from '../lib/mongodb.js';
import { isMember } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { maybeAwardReferralMilestones } from '../lib/referral.js';
import {
    LOOTBOX_CLAIM_MIN, LOOTBOX_CLAIM_MAX, DAILY_VIDEO_WTC_MAX, VIDEO_WTC_PER_SECOND,
    AD_NETWORK_REWARDS,
} from '../lib/constants.js';

const SECRET = process.env.VIDEO_SIGNING_SECRET;
const sign = (userId, startTime) => crypto.createHmac('sha256', SECRET).update(`${userId}:${startTime}`).digest('hex');

// ── videoStart ──
async function handleVideoStart(req, res) {
    if (!SECRET) return res.status(500).json({ success: false, error: 'server_misconfigured' });
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'missing_userId' });
    const startTime = Date.now();
    return res.status(200).json({ success: true, startTime, signature: sign(String(userId), startTime) });
}

// ── videoClaim ──
async function handleVideoClaim(req, res, db) {
    const { userId, startTime, signature, claimedPoints } = req.body;
    if (!userId || !startTime || !signature || claimedPoints === undefined) {
        return res.status(400).json({ ok: false, error: 'missing_fields' });
    }
    if (sign(String(userId), startTime) !== signature) {
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
    const id = String(userId);
    await ensureDailyReset(users, id);

    const userCheck = await users.findOne({ _id: id }, { projection: { isBanned: 1 } });
    if (!userCheck) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (userCheck.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if (award > DAILY_VIDEO_WTC_MAX) return res.status(400).json({ ok: false, error: 'amount_exceeds_daily_cap' });

    const gate = await users.findOneAndUpdate(
        { _id: id, dailyVideoWtcMined: { $lt: DAILY_VIDEO_WTC_MAX } },
        [
            { $set: { _newDailyMined: { $min: [DAILY_VIDEO_WTC_MAX, { $add: ['$dailyVideoWtcMined', award] }] } } },
            { $set: {
                pendingVideoWTC: { $add: ['$pendingVideoWTC', { $subtract: ['$_newDailyMined', '$dailyVideoWtcMined'] }] },
                dailyVideoWtcMined: '$_newDailyMined',
            } },
            { $unset: '_newDailyMined' },
        ],
        { returnDocument: 'after' }
    );
    if (!gate) return res.status(400).json({ ok: false, error: 'daily_watch_limit_reached' });

    return res.status(200).json({ ok: true, success: true, pendingVideoWTC: gate.pendingVideoWTC || 0, dailyVideoWtcMined: gate.dailyVideoWtcMined });
}

// ── claimLootbox ──
async function handleClaimLootbox(req, res, db) {
    const { userId, adWatched } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: 'missing_userId' });
    if (!adWatched) return res.status(400).json({ ok: false, error: 'ad_required' });

    const users = db.collection('users');
    const id = String(userId);
    const gate = await users.findOneAndUpdate(
        { _id: id, isBanned: { $ne: true }, pendingVideoWTC: { $gte: LOOTBOX_CLAIM_MIN } },
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
        const exists = await users.findOne({ _id: id }, { projection: { isBanned: 1 } });
        if (!exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (exists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        return res.status(400).json({ ok: false, error: 'below_minimum', message: `Minimum ${LOOTBOX_CLAIM_MIN} WTC প্রয়োজন।` });
    }

    return res.status(200).json({ ok: true, pointsAdded: gate.pendingVideoWTC || 0 });
}

// ── claimAdReward ──
const COUNTER_FIELD = {
    adsgramDaily: 'adsgramDailyCountToday', adsgramSpecial: 'adsgramSpecialCountToday',
    monetag: 'monetagCountToday', giga: 'gigaCountToday',
};
async function handleClaimAdReward(req, res, db) {
    const { userId, network } = req.body;
    const config = AD_NETWORK_REWARDS[network];
    if (!userId || !config) return res.status(400).json({ ok: false, error: 'invalid_network' });

    const users = db.collection('users');
    const id = String(userId);
    const counterField = COUNTER_FIELD[network];
    await ensureDailyReset(users, id);

    const gate = await users.findOneAndUpdate(
        { _id: id, isBanned: { $ne: true }, [counterField]: { $lt: config.dailyLimit } },
        { $inc: { wtcBalance: config.reward, lifetimeWtcEarned: config.reward, lifetimeAdsWatched: 1, adsWatchedToday: 1, [counterField]: 1 } },
        { returnDocument: 'after' }
    );

    if (!gate) {
        const exists = await users.findOne({ _id: id }, { projection: { isBanned: 1 } });
        if (!exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (exists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        return res.status(400).json({ ok: false, error: 'daily_limit_reached' });
    }

    await maybeAwardReferralMilestones(db, id, { lifetimeAdsWatched: gate.lifetimeAdsWatched });
    return res.status(200).json({ ok: true, reward: config.reward, countToday: gate[counterField], dailyLimit: config.dailyLimit });
}

// ── taskComplete ──
async function handleTaskComplete(req, res, db) {
    const { userId, taskId } = req.body;
    if (!userId || !taskId) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const users = db.collection('users');
    const tasks = db.collection('tasks');
    const id = String(userId);
    await ensureDailyReset(users, id);

    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if ((user.completedTasks || []).includes(taskId)) return res.status(200).json({ ok: false, alreadyDone: true });

    let task;
    try { task = await tasks.findOne({ _id: new ObjectId(taskId) }); } catch { return res.status(400).json({ ok: false, error: 'invalid_task_id' }); }
    if (!task || !task.isApproved) return res.status(404).json({ ok: false, error: 'task_not_found' });
    if (task.limit > 0 && (task.completionCount || 0) >= task.limit) return res.status(400).json({ ok: false, error: 'task_full' });
    if (task.category === 'channel') {
        const member = await isMember(userId, task.channelId);
        if (!member) return res.status(200).json({ ok: false, error: 'not_member' });
    }

    const rewardWtc = task.rewardWtc || task.rewardGold || task.rewardPoints || 250;
    const gate = await users.findOneAndUpdate(
        { _id: id, completedTasks: { $ne: taskId } },
        { $inc: { wtcBalance: rewardWtc, lifetimeWtcEarned: rewardWtc, tasksCompletedToday: 1 }, $addToSet: { completedTasks: taskId } },
        { returnDocument: 'after' }
    );
    if (!gate) return res.status(200).json({ ok: false, alreadyDone: true });

    await tasks.updateOne({ _id: new ObjectId(taskId) }, { $inc: { completionCount: 1 } });
    await maybeAwardReferralMilestones(db, id, { completedTasksCount: gate.completedTasks.length });
    return res.status(200).json({ ok: true, rewardWtc });
}

// ── claimPromo ──
async function handleClaimPromo(req, res, db) {
    const { userId, code } = req.body;
    if (!userId || !code) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const promos = db.collection('promos');
    const users = db.collection('users');
    const id = String(userId);

    const promo = await promos.findOne({ code: String(code).trim() });
    if (!promo) return res.status(404).json({ ok: false, error: 'invalid_code' });
    if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) return res.status(400).json({ ok: false, error: 'expired' });

    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const maxUses = promo.maxUses || 9999;
    const promoGate = await promos.findOneAndUpdate(
        { _id: promo._id, usedCount: { $lt: maxUses }, redeemedBy: { $ne: id } },
        { $inc: { usedCount: 1 }, $addToSet: { redeemedBy: id } },
        { returnDocument: 'after' }
    );
    if (!promoGate) {
        const fresh = await promos.findOne({ _id: promo._id });
        if ((fresh.redeemedBy || []).includes(id)) return res.status(400).json({ ok: false, error: 'already_used' });
        return res.status(400).json({ ok: false, error: 'fully_used' });
    }

    const reward = promo.reward || 0;
    await users.updateOne({ _id: id }, { $inc: { wtcBalance: reward, lifetimeWtcEarned: reward } });
    return res.status(200).json({ ok: true, reward });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const { action } = req.body || {};
    if (action === 'videoStart') return handleVideoStart(req, res); // DB লাগে না

    const { db } = await connectToDatabase();
    switch (action) {
        case 'videoClaim':     return handleVideoClaim(req, res, db);
        case 'claimLootbox':   return handleClaimLootbox(req, res, db);
        case 'claimAdReward':  return handleClaimAdReward(req, res, db);
        case 'taskComplete':   return handleTaskComplete(req, res, db);
        case 'claimPromo':     return handleClaimPromo(req, res, db);
        default: return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
}
