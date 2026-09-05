// api/earn.js — CONSOLIDATED + SECURITY FIX (Telegram initData verification)
//
// Previously every action trusted the client-supplied userId. Now every
// request requires a verified initData, and the userId extracted from it is
// the only one used — the client can never act as someone else by sending a
// different userId.
//
// ⚠️ NEW (this update): every WTC-crediting action now also checks
// REWARD_ELIGIBLE_FILTER — a multi-account-flagged user earns NOTHING new
// until they verify channel+community membership. This is NOT retroactive
// (no held/pending balance to release later) — reward simply stays blocked
// until verified, then unblocks going forward. Progress/counters still
// advance normally EXCEPT completedTasks (see handleTaskComplete for why).
//
// ⚠️ SECURITY FIX (this update) — claimAdReward used to trust the client's
// bare `{ network }` with zero proof an ad was ever shown. A script that
// simply replayed the same POST request (found being distributed publicly —
// a Termux-based auto-farming bot targeting this exact endpoint) could drain
// the daily ad reward in seconds without watching anything. Fixed the same
// way videoClaim already protects itself: the client must first request a
// short-lived signed token (adStart) — issued the moment the user taps
// "Watch" — then submit that exact token back with claimAdReward. The
// server verifies: (1) the HMAC signature is genuine, (2) at least
// AD_MIN_WATCH_SECONDS has elapsed since the token was issued, (3) the token
// hasn't been spent already (single-use, atomic, mirrors usedVideoStarts).
// This doesn't require watching pixel-perfect ad content, but it closes the
// "call claimAdReward directly with no ad token at all" hole that the bot
// script exploited, and rate-limits any script that adapts to still call
// adStart first.
//
//   { action: 'videoStart',    initData }
//   { action: 'videoClaim',    initData, startTime, signature, claimedPoints }
//   { action: 'lootboxAdStart', initData }                                    — ⚠️ NEW, security fix
//   { action: 'claimLootbox',  initData, startTime, signature }               — ⚠️ CHANGED, was { adWatched: true }
//   { action: 'adStart',       initData, network }
//   { action: 'claimAdReward', initData, network, startTime, signature }
//   { action: 'taskComplete',  initData, taskId, startTime?, signature? }  — ⚠️ CHANGED, startTime/signature now required for non-'channel' categories
//   { action: 'taskStart',     initData, taskId }                          — ⚠️ NEW, security fix
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
    AD_NETWORK_REWARDS, AD_MIN_WATCH_SECONDS, AD_COOLDOWN_SECONDS, TASK_MIN_WAIT_SECONDS,
} from '../lib/constants.js';

const SECRET = process.env.VIDEO_SIGNING_SECRET;
const sign = (userId, startTime) => crypto.createHmac('sha256', SECRET).update(`${userId}:${startTime}`).digest('hex');

// ⚠️ NEW — separate signing namespace for ad-watch tokens (same secret, but
// prefixed + includes the network name, so an ad-token can never be replayed
// as a video-token or vice versa, and a token for one network can't be
// reused to claim a different network's reward).
const signAdStart = (userId, network, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`ad:${userId}:${network}:${startTime}`).digest('hex');

// ⚠️ SECURITY FIX (this update) — separate signing namespace for the
// lootbox ad-gate token. Mirrors signAdStart exactly. See handleClaimLootbox
// for why this was added: the previous version trusted a bare client-sent
// `{ adWatched: true }` boolean with zero proof, letting anyone skip the
// mandatory ad via a direct API call (found during a security review — same
// exploit class as the earlier Termux ad-farming bot, just on a different
// endpoint that never got the same fix at the time).
const signLootboxStart = (userId, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`lootbox:${userId}:${startTime}`).digest('hex');

// ⚠️ NEW — separate signing namespace for task-claim tokens. Mirrors
// signAdStart exactly: includes taskId so a token for one task can never be
// replayed to claim a different task.
const signTaskStart = (userId, taskId, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`task:${userId}:${taskId}:${startTime}`).digest('hex');

// ⚠️ SECURITY FIX (this update) — the channelVerified bypass below used to
// apply unconditionally to ANY flagged account. Since joining the
// channel/community is mandatory just to use the app at all (the join-gate
// every user passes through), that bypass was satisfied automatically by
// normal use — in practice it blocked nobody. Combined with the
// zero-cost-for-fresh-accounts "Switch Account" gap (see lib/ipRegistry.js),
// someone could spin up unlimited fresh accounts on one device and each one
// would earn completely normally the moment they joined the channel (which
// they'd do anyway). Now the bypass only applies up to
// MULTI_ACCOUNT_SIBLING_HARD_LIMIT other accounts sharing this device's
// fingerprint — plausible for a family/shared device. Beyond that (a device
// with many more accounts on it — a much stronger farming signal), earning
// stays blocked even after channel-verifying; unblocking those needs an
// admin to actually clear multiAccountFlag after review (admin-panel button
// for that is a separate follow-up, not yet built).
const MULTI_ACCOUNT_SIBLING_HARD_LIMIT = 2;
const REWARD_ELIGIBLE_FILTER = {
    $or: [
        { multiAccountFlag: { $ne: true } },
        {
            $and: [
                { channelVerified: true },
                { $expr: { $lte: [{ $size: { $ifNull: ['$multiAccountSiblings', []] } }, MULTI_ACCOUNT_SIBLING_HARD_LIMIT] } },
            ],
        },
    ],
};

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
//
// ⚠️ NOTE: no REWARD_ELIGIBLE_FILTER here on purpose — videoClaim only moves
// WTC into `pendingVideoWTC` (not yet real balance), the actual credit
// happens at claimLootbox, which IS gated. Blocking here too would just
// silently stall the pending-accrual UI with no benefit.
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
    // ⚠️ SECURITY FIX (this update) — this token had no upper-bound expiry,
    // unlike its siblings (adStart/lootboxAdStart/taskStart tokens all
    // expire after 300s). Combined with the videoStart auth bypass above (now
    // fixed), a token could be minted once and held indefinitely, then
    // claimed later using pure elapsed real time with no session/ad ever
    // open. The daily/per-claim caps already limited the payout size, but
    // this closes the token-hoarding angle entirely, matching the pattern
    // used everywhere else in this file. Legit flow is unaffected — the
    // client requests a fresh token immediately after every successful
    // claim (see index.html startVideoSession, ~30s cadence).
    if (elapsedSeconds > 300) return res.status(400).json({ ok: false, error: 'video_token_expired' });

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

// ── lootboxAdStart ── ⚠️ NEW (security fix) — issues a short-lived signed
// token the instant the user taps the lootbox, BEFORE the ad SDK is called.
// Mirrors adStart exactly — no DB write, just a signature the client must
// carry through the real ad and hand back to claimLootbox.
async function handleLootboxAdStart(req, res, db, userId) {
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    const startTime = Date.now();
    return res.status(200).json({ ok: true, startTime, signature: signLootboxStart(userId, startTime) });
}

// ── claimLootbox ── ⚠️ NOW GATED by REWARD_ELIGIBLE_FILTER — this is where
// pendingVideoWTC actually becomes real wtcBalance, so it's the correct
// choke point for the video-earning path.
// ⚠️ SECURITY FIX (this update) — previously this trusted a bare client-sent
// `{ adWatched: true }` boolean with NO verification at all, meaning anyone
// could call this endpoint directly (Termux/DevTools) and skip the mandatory
// ad entirely — the pendingVideoWTC amount itself was already safe (earned
// through the properly-gated videoClaim flow), but the ad-watch requirement
// itself was pure theater, costing real ad revenue on every claim. Now this
// requires the same signed startTime/signature token pattern as
// claimAdReward: issued by lootboxAdStart right before the ad plays, must
// reflect at least AD_MIN_WATCH_SECONDS of real elapsed time, expires after
// 5 minutes, and is single-use (usedLootboxStarts, atomic).
async function handleClaimLootbox(req, res, db, userId) {
    const { startTime, signature } = req.body;
    if (!startTime || !signature) {
        return res.status(400).json({ ok: false, error: 'missing_ad_token' });
    }
    if (signLootboxStart(userId, startTime) !== signature) {
        return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    }
    const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
    if (isNaN(elapsedSeconds) || elapsedSeconds < 0) {
        return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    }
    if (elapsedSeconds < AD_MIN_WATCH_SECONDS) {
        return res.status(400).json({ ok: false, error: 'watch_time_too_short' });
    }
    if (elapsedSeconds > 300) {
        return res.status(400).json({ ok: false, error: 'ad_token_expired' });
    }

    const users = db.collection('users');
    const lootboxStartKey = String(startTime);
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            isBanned: { $ne: true },
            pendingVideoWTC: { $gte: LOOTBOX_CLAIM_MIN },
            usedLootboxStarts: { $ne: lootboxStartKey }, // ⚠️ single-use, same pattern as usedAdStarts
            ...REWARD_ELIGIBLE_FILTER,
        },
        [
            { $set: {
                wtcBalance: { $add: ['$wtcBalance', '$pendingVideoWTC'] },
                lifetimeWtcEarned: { $add: ['$lifetimeWtcEarned', '$pendingVideoWTC'] },
            } },
            { $set: {
                pendingVideoWTC: 0,
                usedLootboxStarts: { $setUnion: [{ $ifNull: ['$usedLootboxStarts', []] }, [lootboxStartKey]] },
            } },
        ],
        { returnDocument: 'before' }
    );

    if (!gate) {
        const exists = await users.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1, pendingVideoWTC: 1, usedLootboxStarts: 1 } });
        if (!exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (exists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if ((exists.usedLootboxStarts || []).includes(lootboxStartKey)) {
            return res.status(400).json({ ok: false, error: 'ad_token_already_used' });
        }
        // ⚠️ NEW — distinguish "flagged & unverified" from a plain below-minimum case
        if (exists.multiAccountFlag && !exists.channelVerified) {
            return res.status(403).json({ ok: false, error: 'account_under_review' });
        }
        return res.status(400).json({ ok: false, error: 'below_minimum', message: `Minimum ${LOOTBOX_CLAIM_MIN} WTC required.` });
    }

    return res.status(200).json({ ok: true, pointsAdded: gate.pendingVideoWTC || 0 });
}

// ── adStart ── ⚠️ NEW — issues a short-lived signed token the instant the
// user taps "Watch" on an ad-network card, BEFORE the ad SDK is even called.
// No DB write, no reward — just a signature the client must carry through
// the real ad flow and hand back to claimAdReward. A script that skips
// straight to claimAdReward with no token (or a stale/forged one) is
// rejected outright.
async function handleAdStart(req, res, db, userId) {
    const { network } = req.body;
    const netConfig = AD_NETWORK_REWARDS[network];
    if (!netConfig) return res.status(400).json({ ok: false, error: 'invalid_network' });
    // ⚠️ NEW — networks marked enabled:false (e.g. "usl", pending approval)
    // are visible in the UI as "Coming Soon" but can't actually be started.
    if (netConfig.enabled === false) return res.status(400).json({ ok: false, error: 'coming_soon' });
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });

    const startTime = Date.now();
    return res.status(200).json({ ok: true, startTime, signature: signAdStart(userId, network, startTime) });
}

// ── claimAdReward ── ⚠️ NOW GATED + TOKEN-VERIFIED (see file header for why)
const COUNTER_FIELD = {
    adsgramDaily: 'adsgramDailyCountToday',
    adsgramSpecial: 'adsgramSpecialCountToday', // ⚠️ NEW — re-added Special Ads network
    monetag: 'monetagCountToday', giga: 'gigaCountToday',
    usl: 'uslCountToday', // ⚠️ NEW — ready for when "usl" is enabled
};
async function handleClaimAdReward(req, res, db, userId) {
    const { network, startTime, signature } = req.body;
    const config = AD_NETWORK_REWARDS[network];
    if (!config) return res.status(400).json({ ok: false, error: 'invalid_network' });
    // ⚠️ NEW — mirrors handleAdStart's guard, in case a stale/forged token
    // is ever replayed against a network that's disabled ("usl", coming soon).
    if (config.enabled === false) return res.status(400).json({ ok: false, error: 'coming_soon' });

    // ⚠️ NEW — the token issued by adStart is now mandatory.
    if (!startTime || !signature) {
        return res.status(400).json({ ok: false, error: 'missing_ad_token' });
    }
    if (signAdStart(userId, network, startTime) !== signature) {
        return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    }
    const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
    if (isNaN(elapsedSeconds) || elapsedSeconds < 0) {
        return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    }
    // ⚠️ Must have taken at least AD_MIN_WATCH_SECONDS since the token was
    // issued — a genuine ad SDK flow always takes real wall-clock time
    // (loading + showing the ad); an instant claim right after adStart means
    // no ad was actually shown.
    if (elapsedSeconds < AD_MIN_WATCH_SECONDS) {
        return res.status(400).json({ ok: false, error: 'watch_time_too_short' });
    }
    // ⚠️ Token also expires after 5 minutes — prevents a script from
    // stockpiling many pre-signed tokens ahead of time and burning through
    // them later in a burst.
    if (elapsedSeconds > 300) {
        return res.status(400).json({ ok: false, error: 'ad_token_expired' });
    }

    const users = db.collection('users');
    const counterField = COUNTER_FIELD[network];
    await ensureDailyReset(users, userId);

    // ⚠️ FIX — AD_COOLDOWN_SECONDS was defined in constants.js but never
    // actually enforced anywhere. Wired in here: reject if the user's last
    // successful ad claim (any network) was less than AD_COOLDOWN_SECONDS
    // ago, so a script can't fire adStart→claimAdReward back-to-back with
    // zero pacing between ads.
    const cooldownCutoff = new Date(Date.now() - AD_COOLDOWN_SECONDS * 1000);

    // ⚠️ NEW — the token itself is single-use: `${network}:${startTime}` is
    // atomically checked-and-recorded in `usedAdStarts` in the very same
    // update that credits the reward, mirroring usedVideoStarts. Replaying
    // the exact same token twice earns nothing the second time.
    const adStartKey = `${network}:${startTime}`;
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            isBanned: { $ne: true },
            [counterField]: { $lt: config.dailyLimit },
            usedAdStarts: { $ne: adStartKey },
            $or: [{ lastAdClaimAt: { $exists: false } }, { lastAdClaimAt: { $lte: cooldownCutoff } }],
            ...REWARD_ELIGIBLE_FILTER,
        },
        {
            $inc: { wtcBalance: config.reward, lifetimeWtcEarned: config.reward, lifetimeAdsWatched: 1, adsWatchedToday: 1, [counterField]: 1 },
            $addToSet: { usedAdStarts: adStartKey },
            $set: { lastAdClaimAt: new Date() },
        },
        { returnDocument: 'after' }
    );

    if (!gate) {
        const exists = await users.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1, usedAdStarts: 1, lastAdClaimAt: 1 } });
        if (!exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (exists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if ((exists.usedAdStarts || []).includes(adStartKey)) {
            return res.status(400).json({ ok: false, error: 'ad_token_already_used' });
        }
        if (exists.multiAccountFlag && !exists.channelVerified) {
            return res.status(403).json({ ok: false, error: 'account_under_review' });
        }
        if (exists.lastAdClaimAt && exists.lastAdClaimAt > cooldownCutoff) {
            return res.status(400).json({ ok: false, error: 'ad_cooldown', retryAfterMs: exists.lastAdClaimAt.getTime() + AD_COOLDOWN_SECONDS * 1000 - Date.now() });
        }
        return res.status(400).json({ ok: false, error: 'daily_limit_reached' });
    }

    await maybeAwardReferralMilestones(db, userId, { lifetimeAdsWatched: gate.lifetimeAdsWatched });
    return res.status(200).json({ ok: true, reward: config.reward, countToday: gate[counterField], dailyLimit: config.dailyLimit });
}

// ── claimTadsClick ── ⚠️ NEW. TADS (tads.me) TGB/static banner reward.
// Unlike the 5 networks above, TADS has no "start" step we control — the
// widget renders itself passively (see initTadsAd() in index.html) and the
// only signal we get is the SDK's onClickReward callback firing on a real
// click, whenever that happens. That means the replay-proof
// token-anchored-to-a-prior-server-call trick every other network uses
// (adStartKey / usedAdStarts) doesn't apply here — there's no "start" call
// to anchor one to. The daily cap + the shared any-network lastAdClaimAt
// cooldown below are the only real defenses, which is exactly why
// AD_NETWORK_REWARDS.tads was given a deliberately small reward and a tight
// daily cap (see constants.js) rather than matching the other networks.
async function handleClaimTadsClick(req, res, db, userId) {
    const users = db.collection('users');
    await ensureDailyReset(users, userId);
    const config = AD_NETWORK_REWARDS.tads;
    if (!config || config.enabled === false) return res.status(400).json({ ok: false, error: 'network_disabled' });

    const cooldownCutoff = new Date(Date.now() - AD_COOLDOWN_SECONDS * 1000);
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            isBanned: { $ne: true },
            tadsCountToday: { $lt: config.dailyLimit },
            $or: [{ lastAdClaimAt: { $exists: false } }, { lastAdClaimAt: { $lte: cooldownCutoff } }],
            ...REWARD_ELIGIBLE_FILTER,
        },
        {
            $inc: { wtcBalance: config.reward, lifetimeWtcEarned: config.reward, tadsCountToday: 1 },
            $set: { lastAdClaimAt: new Date() },
        },
        { returnDocument: 'after' }
    );

    if (!gate) {
        const exists = await users.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1, lastAdClaimAt: 1 } });
        if (!exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (exists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if (exists.multiAccountFlag && !exists.channelVerified) return res.status(403).json({ ok: false, error: 'account_under_review' });
        if (exists.lastAdClaimAt && exists.lastAdClaimAt > cooldownCutoff) {
            return res.status(400).json({ ok: false, error: 'ad_cooldown', retryAfterMs: exists.lastAdClaimAt.getTime() + AD_COOLDOWN_SECONDS * 1000 - Date.now() });
        }
        return res.status(400).json({ ok: false, error: 'daily_limit_reached' });
    }

    return res.status(200).json({ ok: true, reward: config.reward, tadsCountToday: gate.tadsCountToday, dailyLimit: config.dailyLimit });
}

// ── taskComplete ── ⚠️ NOW GATED (STEP 2 only — see comment below on why STEP 1's slot-claim stays ungated)
// ⚠️ SECURITY FIX (pre-existing): previously the task.limit check used a plain read
// (`task.completionCount >= task.limit`), and completionCount was incremented
// separately with an unconditional updateOne — leaving a race window between
// the two. If many users completed the same limited task at almost the exact
// same moment, they could all see "not full yet" and pass, letting
// completionCount overshoot the task's limit (low severity, but a real bug).
// Now claiming the task's "slot" is also atomic — the check+increment of the
// task's own completionCount+limit condition happens in the same
// findOneAndUpdate, and if crediting the user's record fails afterward (e.g.
// a double-click race, OR the new multi-account review gate), the slot is
// rolled back.
// ── taskStart ── ⚠️ NEW (security fix) — issues a short-lived signed token
// the instant the user taps "Start" on a task (before they even leave the
// app for the link). Mirrors adStart/lootboxAdStart exactly. Not required
// for 'channel' tasks — those are independently verified via real Telegram
// membership, which is already proof enough on its own.
async function handleTaskStart(req, res, db, userId) {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    const startTime = Date.now();
    return res.status(200).json({ ok: true, startTime, signature: signTaskStart(userId, taskId, startTime) });
}

// ── taskComplete ── ⚠️ NOW GATED (STEP 2 only — see comment below on why STEP 1's slot-claim stays ungated)
// ⚠️ SECURITY FIX (pre-existing): previously the task.limit check used a plain read
// (`task.completionCount >= task.limit`), and completionCount was incremented
// separately with an unconditional updateOne — leaving a race window between
// the two. If many users completed the same limited task at almost the exact
// same moment, they could all see "not full yet" and pass, letting
// completionCount overshoot the task's limit (low severity, but a real bug).
// Now claiming the task's "slot" is also atomic — the check+increment of the
// task's own completionCount+limit condition happens in the same
// findOneAndUpdate, and if crediting the user's record fails afterward (e.g.
// a double-click race, OR the new multi-account review gate), the slot is
// rolled back.
//
// ⚠️ SECURITY FIX (this update) — for every category EXCEPT 'channel', this
// used to credit the full reward the instant taskComplete was called, with
// ZERO proof the user ever opened the link/article/faucet — the frontend's
// 10-second "Claim in 10s..." countdown was pure UI, never enforced
// server-side. A script with a valid initData could loop every open taskId
// and instant-claim the full reward for each one, never visiting anything.
// Now (mirroring the ad/lootbox pattern) these categories require a signed
// taskStart token issued when the task sheet opens, and taskComplete
// verifies: (1) the signature is genuine and matches this exact taskId, (2)
// at least TASK_MIN_WAIT_SECONDS has passed since it was issued, (3) the
// token hasn't been spent already (usedTaskStarts, atomic, single-use). This
// doesn't prove the link was actually read — no server-side check can fully
// prove that for an external site — but it closes the "claim every task in
// under a second via direct API calls" hole, which is the actual exploit.
// 'channel' tasks are unaffected — Telegram membership is real proof and
// doesn't need this.
async function handleTaskComplete(req, res, db, userId) {
    const { taskId, startTime, signature } = req.body;
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

    let taskStartKey = null;
    // ⚠️ CHANGED (this update) — API-verified join tasks are no longer tied
    // to the 'channel' category only. Any category can now be marked
    // verifyType: 'api' from the admin panel (see api/bot.js task_verify_api).
    // Old tasks created before this field existed still work — they fall
    // back to the category check.
    const isApiVerified = task.verifyType === 'api' || (!task.verifyType && task.category === 'channel');
    if (isApiVerified) {
        const member = await isMember(userId, task.channelId);
        if (!member) return res.status(200).json({ ok: false, error: 'not_member' });
    } else {
        // ── non-channel categories now require a valid taskStart token ──
        if (!startTime || !signature) return res.status(400).json({ ok: false, error: 'missing_task_token' });
        if (signTaskStart(userId, taskId, startTime) !== signature) {
            return res.status(400).json({ ok: false, error: 'invalid_task_token' });
        }
        const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
        if (isNaN(elapsedSeconds) || elapsedSeconds < 0) {
            return res.status(400).json({ ok: false, error: 'invalid_task_token' });
        }
        if (elapsedSeconds < TASK_MIN_WAIT_SECONDS) {
            return res.status(400).json({ ok: false, error: 'claimed_too_fast' });
        }
        if (elapsedSeconds > 300) {
            return res.status(400).json({ ok: false, error: 'task_token_expired' });
        }
        if ((user.usedTaskStarts || []).includes(`${taskId}:${startTime}`)) {
            return res.status(400).json({ ok: false, error: 'task_token_already_used' });
        }
        taskStartKey = `${taskId}:${startTime}`;
    }

    // ── STEP 1: atomically claim the task's "slot" (limit check + increment together) ──
    // ⚠️ Intentionally NOT gated by REWARD_ELIGIBLE_FILTER — this is a shared,
    // limited-quota resource across ALL users, not this user's own reward. A
    // flagged user's failed claim below correctly gives this slot back (see
    // STEP 2), so legit users' quota is never actually consumed by them.
    const taskGate = await tasks.findOneAndUpdate(
        { _id: taskObjId, $or: [{ limit: { $lte: 0 } }, { limit: { $exists: false } }, { $expr: { $lt: ['$completionCount', '$limit'] } }] },
        { $inc: { completionCount: 1 } },
        { returnDocument: 'after' }
    );
    if (!taskGate) return res.status(400).json({ ok: false, error: 'task_full' });

    const rewardWtc = task.rewardWtc || task.rewardGold || task.rewardPoints || 10; // default fallback if admin left it blank

    // ── STEP 2: atomically credit the user (a double-claim by the same user is caught right here) ──
    // ⚠️ NEW: also requires REWARD_ELIGIBLE_FILTER, and (for non-channel
    // categories) the taskStart token is atomically marked spent in the same
    // update that credits the reward — same single-use pattern as
    // usedAdStarts/usedVideoStarts.
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            completedTasks: { $ne: taskId },
            ...(taskStartKey ? { usedTaskStarts: { $ne: taskStartKey } } : {}),
            ...REWARD_ELIGIBLE_FILTER,
        },
        {
            $inc: { wtcBalance: rewardWtc, lifetimeWtcEarned: rewardWtc, tasksCompletedToday: 1 },
            $addToSet: taskStartKey ? { completedTasks: taskId, usedTaskStarts: taskStartKey } : { completedTasks: taskId },
        },
        { returnDocument: 'after' }
    );
    if (!gate) {
        // Crediting the user failed (e.g. already done in a race, OR blocked by
        // the multi-account review gate) — give the task's slot back either way.
        await tasks.updateOne({ _id: taskObjId }, { $inc: { completionCount: -1 } });
        const exists = await users.findOne({ _id: userId }, { projection: { completedTasks: 1, multiAccountFlag: 1, channelVerified: 1, usedTaskStarts: 1 } });
        if (taskStartKey && (exists?.usedTaskStarts || []).includes(taskStartKey)) {
            return res.status(400).json({ ok: false, error: 'task_token_already_used' });
        }
        if (exists?.multiAccountFlag && !exists.channelVerified && !(exists.completedTasks || []).includes(taskId)) {
            return res.status(403).json({ ok: false, error: 'account_under_review' });
        }
        return res.status(200).json({ ok: false, alreadyDone: true });
    }

    await maybeAwardReferralMilestones(db, userId, { completedTasksCount: gate.completedTasks.length });
    return res.status(200).json({ ok: true, rewardWtc });
}

// ── checkPromo ── ⚠️ NEW — read-only pre-validation, called BEFORE the ad
// is shown (see redeemPromoCode() in index.html). Previously the ad played
// unconditionally, so an invalid/expired/already-used code still cost the
// user a full ad watch before they found out it failed. This mirrors every
// validation in handleClaimPromo below EXCEPT it never mutates the promo
// doc — the real, atomic redemption still happens in claimPromo after the
// ad, so a code that becomes invalid in the few seconds between the two
// calls (a genuine race, not a UX annoyance) is still safely caught there.
async function handleCheckPromo(req, res, db, userId) {
    const { code } = req.body;
    if (!code) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const promos = db.collection('promos');
    const promo = await promos.findOne({ code: String(code).trim() });
    if (!promo) return res.status(404).json({ ok: false, error: 'invalid_code' });
    if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) return res.status(400).json({ ok: false, error: 'expired' });
    if ((promo.redeemedBy || []).includes(userId)) return res.status(400).json({ ok: false, error: 'already_used' });
    const maxUses = promo.maxUses || 9999;
    if ((promo.usedCount || 0) >= maxUses) return res.status(400).json({ ok: false, error: 'fully_used' });

    const users = db.collection('users');
    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    return res.status(200).json({ ok: true });
}

// ── claimPromo ── ⚠️ NOW GATED
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

    // ⚠️ NEW: the promo code itself is already marked used above (promoGate)
    // even if the credit below is blocked by REWARD_ELIGIBLE_FILTER —
    // otherwise a flagged user could keep retrying the same code after
    // verifying, defeating the code's single-use-per-user limit. Trade-off:
    // a flagged user "burns" a promo code with zero reward if they redeem it
    // while still unverified. Accepted, since promo codes are typically
    // low-value and this closes an easy retry-abuse path.
    const reward = promo.reward || 0;
    const creditResult = await users.updateOne(
        { _id: userId, ...REWARD_ELIGIBLE_FILTER },
        { $inc: { wtcBalance: reward, lifetimeWtcEarned: reward } }
    );
    if (creditResult.matchedCount === 0) {
        return res.status(403).json({ ok: false, error: 'account_under_review' });
    }

    return res.status(200).json({ ok: true, reward });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const { action } = req.body || {};

    // All actions require a valid Telegram session
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    // ⚠️ SECURITY FIX (this update) — videoStart used to be handled BEFORE the
    // initData check above, deliberately bypassing it, and signed whatever
    // `userId` the client sent in the request body with zero verification.
    // That meant a plain script (no Telegram session at all) could mint an
    // unlimited number of valid (startTime, signature) pairs for a
    // self-chosen userId — no ad SDK, no video element, no app even open —
    // then simply wait real wall-clock time and call videoClaim to fill
    // pendingVideoWTC. Every other reward-start endpoint here (adStart,
    // lootboxAdStart, taskStart) already required a verified session; this
    // one was the one gap. The client (apiPost, index.html) already sends
    // `initData` on every call including this one, so nothing on the
    // frontend needs to change — this just stops the server from ignoring
    // it for this specific action. The old justification ("prevents session
    // renewal failures when TG_INIT_DATA expires mid-session") doesn't hold
    // up: Telegram initData stays valid for 24h (see telegramAuth.js
    // MAX_AUTH_AGE_SECONDS), far longer than any realistic single video
    // session, let alone the 5-hour daily cap on watch time.
    if (action === 'videoStart') {
        if (!SECRET) return res.status(500).json({ success: false, error: 'video_secret_missing' });
        const startTime = Date.now();
        return res.status(200).json({ success: true, startTime, signature: sign(userId, startTime) });
    }

    const { db } = await connectToDatabase();
    switch (action) {
        case 'videoClaim':     return handleVideoClaim(req, res, db, userId);
        case 'lootboxAdStart': return handleLootboxAdStart(req, res, db, userId);
        case 'claimLootbox':   return handleClaimLootbox(req, res, db, userId);
        case 'adStart':        return handleAdStart(req, res, db, userId);
        case 'claimAdReward':  return handleClaimAdReward(req, res, db, userId);
        case 'claimTadsClick': return handleClaimTadsClick(req, res, db, userId);
        case 'taskStart':       return handleTaskStart(req, res, db, userId);
        case 'taskComplete':   return handleTaskComplete(req, res, db, userId);
        case 'checkPromo':      return handleCheckPromo(req, res, db, userId);
        case 'claimPromo':     return handleClaimPromo(req, res, db, userId);
        default: return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
}
