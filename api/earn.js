// api/earn.js — CONSOLIDATED + SECURITY FIX (Telegram initData verification)
//
// Previously every action trusted the client-supplied userId. Now every
// request requires a verified initData, and the userId extracted from it is
// the only one used — the client can never act as someone else by sending a
// different userId.
//
// every WTC-crediting action now also checks
// REWARD_ELIGIBLE_FILTER — a multi-account-flagged user earns NOTHING new
// until they verify channel+community membership. This is NOT retroactive
// (no held/pending balance to release later) — reward simply stays blocked
// until verified, then unblocks going forward. Progress/counters still
// advance normally EXCEPT completedTasks (see handleTaskComplete for why).
//
// claimAdReward used to trust the client's
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
import { cyInc, cyMin } from '../lib/cycleStats.js'; // 18 Oct 2026 — "since last withdraw" counters (users.cy), see lib/cycleStats.js
import { isMember, tgSend, tgEdit, tgEditCaption, OFFICIAL_CHANNEL } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { maybeAwardReferralMilestones } from '../lib/referral.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { detectBotPattern, detectVideoBotPattern, lockForBotPattern, AD_CLAIM_HISTORY_KEEP, VIDEO_CLAIM_HISTORY_KEEP } from '../lib/botGuard.js';
import {
    LOOTBOX_CLAIM_MIN, LOOTBOX_CLAIM_MAX, DAILY_VIDEO_WTC_MAX, VIDEO_WTC_PER_SECOND,
    AD_NETWORK_REWARDS, AD_MIN_WATCH_SECONDS, AD_VIEW_TOLERANCE_SECONDS, AD_COOLDOWN_SECONDS, TASK_MIN_WAIT_SECONDS, TASK_COOLDOWN_SECONDS,
    MINING_REWARD, MINING_COOLDOWN_HOURS, MINING_AD_NETWORKS, MINING_BOOST_TIERS,
    LOOTBOX_AD_NETWORKS, PROMO_FAIL_LIMIT, PROMO_FAIL_WINDOW_MS,
    todayStartBD,
} from '../lib/constants.js';

const SECRET = process.env.VIDEO_SIGNING_SECRET;
const sign = (userId, startTime) => crypto.createHmac('sha256', SECRET).update(`${userId}:${startTime}`).digest('hex');

// separate signing namespace for ad-watch tokens (same secret, but
// prefixed + includes the network name, so an ad-token can never be replayed
// as a video-token or vice versa, and a token for one network can't be
// reused to claim a different network's reward).
const signAdStart = (userId, network, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`ad:${userId}:${network}:${startTime}`).digest('hex');

// separate signing namespace for the
// lootbox ad-gate token. Mirrors signAdStart exactly. See handleClaimLootbox
// for why this was added: the previous version trusted a bare client-sent
// `{ adWatched: true }` boolean with zero proof, letting anyone skip the
// mandatory ad via a direct API call (found during a security review — same
// exploit class as the earlier Termux ad-farming bot, just on a different
// endpoint that never got the same fix at the time).
const signLootboxStart = (userId, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`lootbox:${userId}:${startTime}`).digest('hex');

// separate signing namespace for task-claim tokens. Mirrors
// signAdStart exactly: includes taskId so a token for one task can never be
// replayed to claim a different task.
const signTaskStart = (userId, taskId, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`task:${userId}:${taskId}:${startTime}`).digest('hex');

// 17 Oct 2026: the Spin Wheel (and its signSpinStart token) was fully removed.

// the channelVerified bypass below used to
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
// the previous version verified the signature correctly, but
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
    // this token had no upper-bound expiry,
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

    const maxEarnable = Math.min(LOOTBOX_CLAIM_MAX, Math.floor(elapsedSeconds * VIDEO_WTC_PER_SECOND + 1e-6)); // +1e-6: float safety (100/3600 is not exact)
    const requested = Math.floor(Number(claimedPoints));
    if (isNaN(requested) || requested <= 0) return res.status(400).json({ ok: false, error: 'invalid_amount' });
    const award = Math.min(requested, maxEarnable);
    if (award <= 0) return res.status(400).json({ ok: false, error: 'insufficient_watch_time' });

    const users = db.collection('users');
    await ensureDailyReset(users, userId);

    const userCheck = await users.findOne({ _id: userId }, { projection: { isBanned: 1, pendingVideoWTC: 1, accountLocked: 1, accountLockedReason: 1, recentVideoClaims: 1 } });
    if (!userCheck) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (userCheck.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    // anti-script guard for the video section (lib/botGuard.js, rules V1/V2).
    if (userCheck.accountLocked && userCheck.accountLockedReason === 'bot_pattern') {
        return res.status(403).json({ ok: false, error: 'account_locked' });
    }
    const videoSample = { s: Number(startTime), c: Date.now(), a: award };
    const videoHit = detectVideoBotPattern([...(userCheck.recentVideoClaims || []), videoSample]);
    if (videoHit) {
        // V1/V2 detect things a real person cannot do (overlapping sessions) → always lock
        await lockForBotPattern(db, userId, videoHit, tgSend, 'Section: video', { forceLock: true });
        return res.status(403).json({ ok: false, error: 'account_locked' });
    }
    if (award > DAILY_VIDEO_WTC_MAX) return res.status(400).json({ ok: false, error: 'amount_exceeds_daily_cap' });

    // once the pending lootbox has reached the claimable minimum, stop
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
                // 18 Oct 2026 — cycle counters (admin 📊 Cycle Report): this video tick + the WTC it added to the pending lootbox
                'cy.videoN': { $add: [{ $ifNull: ['$cy.videoN', 0] }, 1] },
                'cy.videoW': { $add: [{ $ifNull: ['$cy.videoW', 0] }, { $subtract: ['$_newDailyMined', '$dailyVideoWtcMined'] }] },
                'cy.since': { $ifNull: ['$cy.since', '$$NOW'] },
                // ⚠️ $setUnion here acts like $addToSet inside an aggregation-pipeline
                // update — atomically records this startTime as spent, in the SAME
                // operation that grants the reward, so there's no race window between
                // "check if used" and "mark as used".
                usedVideoStarts: { $setUnion: [{ $ifNull: ['$usedVideoStarts', []] }, [startTimeKey]] },
                recentVideoClaims: { $slice: [{ $concatArrays: [{ $ifNull: ['$recentVideoClaims', []] }, [videoSample]] }, -VIDEO_CLAIM_HISTORY_KEEP] }, // ⚠️ NEW — feeds lib/botGuard.js
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
// 17 Oct 2026 — HOW THE LOOTBOX NOW WORKS (kono script eta fake korte pare na):
//   1) lootboxAdStart  → server checks the user really has >= LOOTBOX_CLAIM_MIN pending, then PICKS the ad network itself
//                        (Adsgram Special or GigaPub, never Monetag), saves it as `lootboxPending {net, at}` and, for Adsgram,
//                        marks the intent 'lootbox' so Adsgram's Reward-URL callback is stored as a one-time proof.
//   2) the app shows THAT network's ad (the client cannot choose).
//   3) claimLootbox    → server consumes ONE proof (Adsgram callback / GigaPub postback) made by the ad network's own server.
//                        No proof (= no real ad) → 409 proof_pending → nothing is paid. The video WTC only moves to the balance after it.
async function handleLootboxAdStart(req, res, db, userId) {
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    const users = db.collection('users');
    const u = await users.findOne({ _id: userId }, { projection: { isBanned: 1, pendingVideoWTC: 1 } });
    if (!u) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (u.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    // refuse BEFORE the ad, so an honest user never watches an ad for a claim that would be rejected
    if ((u.pendingVideoWTC || 0) < LOOTBOX_CLAIM_MIN) return res.status(400).json({ ok: false, error: 'below_minimum' });
    const network = pickRandom(verifiedNets(LOOTBOX_AD_NETWORKS));
    const startTime = Date.now();
    await users.updateOne({ _id: userId }, { $set: { lootboxPending: { net: network, at: startTime } } });
    await setAdsgramIntent(users, userId, network === 'adsgramSpecial' ? 'lootbox' : null);
    return res.status(200).json({ ok: true, startTime, signature: signLootboxStart(userId, startTime), network });
}

// ── claimLootbox ── ⚠️ NOW GATED by REWARD_ELIGIBLE_FILTER — this is where
// pendingVideoWTC actually becomes real wtcBalance, so it's the correct
// choke point for the video-earning path.
// previously this trusted a bare client-sent
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
    // 17 Oct 2026: the old "wait 15s" timer check was removed here — a timer proves nothing (a script waits too).
    // The REAL proof is the ad network's own server confirmation, consumed below (consumeAdProof).
    if (elapsedSeconds > 600) {
        return res.status(400).json({ ok: false, error: 'ad_token_expired' });
    }

    const users = db.collection('users');
    const lootboxStartKey = String(startTime);
    // the lootbox claim is an ad watch: run the same ad bot rules (A/B/C).
    const lbDoc = await users.findOne({ _id: userId }, { projection: { accountLocked: 1, accountLockedReason: 1, recentAdClaims: 1, lootboxPending: 1 } });
    if (lbDoc?.accountLocked && lbDoc.accountLockedReason === 'bot_pattern') {
        return res.status(403).json({ ok: false, error: 'account_locked' });
    }
    const lbSample = { s: Number(startTime), c: Date.now(), w: Math.round(elapsedSeconds * 10) / 10 };
    const lbHit = detectBotPattern([...(lbDoc?.recentAdClaims || []), lbSample]);
    if (lbHit) {
        // only rejects when the account was really locked (🔴 Likely script);
        // otherwise the admin is just notified and the claim continues.
        const lbLocked = await lockForBotPattern(db, userId, lbHit, tgSend, 'Section: video lootbox', { samples: [...(lbDoc?.recentAdClaims || []), lbSample] });
        if (lbLocked) return res.status(403).json({ ok: false, error: 'account_locked' });
    }
    // 17 Oct 2026 — REAL AD PROOF. The network that lootboxAdStart picked must have confirmed the view from ITS OWN server.
    const lbPend = lbDoc?.lootboxPending;
    if (!lbPend || lbPend.at !== Number(startTime)) return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    const lbProof = await consumeAdProof(db, userId, lbPend.net, 'lootbox', lbPend.at);
    if (!lbProof.ok) {
        if (lbProof.pending) return res.status(409).json({ ok: false, error: 'proof_pending' }); // the app retries a few times
        return res.status(400).json({ ok: false, error: lbProof.error });
    }
    // 🛡️ NEW — cross-system anti-farming cooldown (see file header note on
    // "shared lastAdClaimAt" above claimAdReward). Every ad-gated reward
    // path — network ads, lootbox, streak — now shares the SAME
    // lastAdClaimAt/AD_COOLDOWN_SECONDS gate, so a script can't dodge the
    // pacing limit by round-robining between different claim endpoints
    // (e.g. a network ad claim immediately followed by a lootbox claim
    // immediately followed by another claim, each individually "legal" but
    // collectively impossible for a human watching one ad at a time).
    const cooldownCutoff = new Date(Date.now() - AD_COOLDOWN_SECONDS * 1000);
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            isBanned: { $ne: true },
            pendingVideoWTC: { $gte: LOOTBOX_CLAIM_MIN },
            usedLootboxStarts: { $ne: lootboxStartKey }, // ⚠️ single-use, same pattern as usedAdStarts
            $and: [
                { $or: [{ lastAdClaimAt: { $exists: false } }, { lastAdClaimAt: { $lte: cooldownCutoff } }] },
                REWARD_ELIGIBLE_FILTER,
            ],
        },
        [
            { $set: {
                wtcBalance: { $add: ['$wtcBalance', '$pendingVideoWTC'] },
                lifetimeWtcEarned: { $add: ['$lifetimeWtcEarned', '$pendingVideoWTC'] },
                // tracks lifetime lootbox claims so we can
                // tell whether THIS claim is the user's first ever (see
                // referral-milestone hook below). Kept separate from
                // usedLootboxStarts (which is single-use-token replay
                // protection, reset daily) — this counter is lifetime and
                // never reset.
                lootboxClaimCount: { $add: [{ $ifNull: ['$lootboxClaimCount', 0] }, 1] },
                // 18 Oct 2026 — cycle counters (admin 📊 Cycle Report): this lootbox claim + the WTC it paid out
                'cy.lootboxN': { $add: [{ $ifNull: ['$cy.lootboxN', 0] }, 1] },
                'cy.lootboxW': { $add: [{ $ifNull: ['$cy.lootboxW', 0] }, '$pendingVideoWTC'] },
                'cy.since': { $ifNull: ['$cy.since', '$$NOW'] },
            } },
            { $set: {
                pendingVideoWTC: 0,
                usedLootboxStarts: { $setUnion: [{ $ifNull: ['$usedLootboxStarts', []] }, [lootboxStartKey]] },
                lootboxPending: '$$REMOVE', // 17 Oct 2026 — the proof was used, so the pending lootbox-ad record is cleared
                lastAdClaimAt: new Date(), // 🛡️ NEW — feeds the shared cross-system cooldown above
                recentAdClaims: { $slice: [{ $concatArrays: [{ $ifNull: ['$recentAdClaims', []] }, [lbSample]] }, -AD_CLAIM_HISTORY_KEEP] }, // ⚠️ NEW — feeds lib/botGuard.js
            } },
        ],
        { returnDocument: 'before' }
    );

    if (!gate) {
        await lbProof.restore(); // the claim could not be paid → hand the ad proof back so the user's real ad view isn't wasted
        const exists = await users.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1, pendingVideoWTC: 1, usedLootboxStarts: 1, lastAdClaimAt: 1 } });
        if (!exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (exists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if ((exists.usedLootboxStarts || []).includes(lootboxStartKey)) {
            return res.status(400).json({ ok: false, error: 'ad_token_already_used' });
        }
        // distinguish "flagged & unverified" from a plain below-minimum case
        if (exists.multiAccountFlag && !exists.channelVerified) {
            return res.status(403).json({ ok: false, error: 'account_under_review' });
        }
        if (exists.lastAdClaimAt && exists.lastAdClaimAt > cooldownCutoff) {
            return res.status(400).json({ ok: false, error: 'ad_cooldown', retryAfterMs: exists.lastAdClaimAt.getTime() + AD_COOLDOWN_SECONDS * 1000 - Date.now() });
        }
        return res.status(400).json({ ok: false, error: 'below_minimum', message: `Minimum ${LOOTBOX_CLAIM_MIN} WTC required.` });
    }

    // awards the referrer's 4th milestone
    // (REFERRAL_REWARDS.step4_firstLootbox, lib/constants.js) the first time
    // THIS user ever successfully claims a lootbox. `gate` here is the
    // document from BEFORE this update (returnDocument: 'before'), so
    // !gate.lootboxClaimCount means this claim is their first ever.
    if (!gate.lootboxClaimCount) {
        await maybeAwardReferralMilestones(db, userId, { lootboxClaimed: true });
    }

    // 17 Oct 2026 — LOOTBOX HISTORY LOG (admin panel: "📦 Lootbox History (30d)" ar "🔍 Fake/Real Report" ei data theke ashe).
    // Prottek successful claim-er ekta chhoto row: kokhon, koto WTC, kon network, tap→claim koto sec. Non-blocking: log fail korle claim-er kichu hoy na.
    await logLootboxClaim(db, userId, gate.pendingVideoWTC || 0, lbPend.net, lbSample.w);

    return res.status(200).json({ ok: true, pointsAdded: gate.pendingVideoWTC || 0 });
}

// Collection `lootboxLogs`: { userId, amount, net, waitSec, createdAt }. MongoDB nijei 30 din por muche dey (TTL index niche, ekbar-i toiri hoy).
// Withdraw approve hole oi user-er rows muche jay (lib/cycleCleanup.js).
let lootLogIndexReady = false;
async function logLootboxClaim(db, userId, amount, net, waitSec) {
    try {
        const col = db.collection('lootboxLogs');
        if (!lootLogIndexReady) {
            lootLogIndexReady = true;
            await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: 2592000 }).catch(() => {});
            await col.createIndex({ userId: 1, createdAt: -1 }).catch(() => {});
        }
        await col.insertOne({ userId: String(userId), amount, net: net || null, waitSec: waitSec ?? null, createdAt: new Date() });
    } catch (e) { console.error('lootbox log failed:', e.message); }
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
    // networks marked enabled:false (pending approval)
    // are visible in the UI as "Coming Soon" but can't actually be started.
    if (netConfig.enabled === false) return res.status(400).json({ ok: false, error: 'coming_soon' });
    if (netConfig.s2s) return res.status(400).json({ ok: false, error: 'server_confirmed_only' }); // Adsgram S2S networks are paid by api/earn.js?s2s=adsgram, never by the client
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });

    const startTime = Date.now();
    return res.status(200).json({ ok: true, startTime, signature: signAdStart(userId, network, startTime) });
}

// ── claimAdReward ── ⚠️ NOW GATED + TOKEN-VERIFIED (see file header for why)
const COUNTER_FIELD = {
    adsgramDaily: 'adsgramDailyCountToday',
    adsgramSpecial: 'adsgramSpecialCountToday', // ⚠️ NEW — re-added Special Ads network
    adsgramTask: 'adsgramTaskCountToday',    // 🎯 NEW — Adsgram Task ad format
    monetag: 'monetagCountToday', giga: 'gigaCountToday',
};
// ── GigaPub claim, verified by GigaPub's own server-to-server postback ─────────
// ⚠️ NEW (14 Oct 2026) — active only when Vercel env GIGA_S2S_ENFORCE === '1'.
// GigaPub calls api/gift.js?network=gigapub&uid=...&event=ad_shown after an ad is shown;
// that handler stores it in `gigaPostbacks`. Here a claim CONSUMES exactly one unused
// postback (atomic findOneAndUpdate) for this user from the last few minutes — so every
// reward needs a real ad impression reported by GigaPub's server, and one postback can
// never pay twice. No adStart token / timer / viewMs / cooldown / bot-pattern needed.
// If the postback hasn't arrived yet the answer is 409 postback_pending and the app retries.
const GIGA_POSTBACK_WINDOW_MS = 5 * 60 * 1000;
async function handleGigaPostbackClaim(res, db, userId, network, config) {
    const users = db.collection('users');
    const field = COUNTER_FIELD[network];
    await ensureDailyReset(users, userId);

    const lock = await users.findOne({ _id: userId }, { projection: { accountLocked: 1, accountLockedReason: 1 } });
    if (lock?.accountLocked && lock.accountLockedReason === 'bot_pattern') {
        return res.status(403).json({ ok: false, error: 'account_locked' });
    }

    // 14 Oct 2026 (admin): minimum gap between two GigaPub rewards (config.minGapSeconds = 10s).
    // Checked BEFORE the postback is consumed, so a too-early tap never wastes a real ad impression.
    const gapField = 'lastNsClaimAt_' + network;
    if (config.minGapSeconds) {
        const g = await users.findOne({ _id: userId }, { projection: { [gapField]: 1 } });
        const wait = g?.[gapField] ? new Date(g[gapField]).getTime() + config.minGapSeconds * 1000 - Date.now() : 0;
        if (wait > 0) return res.status(400).json({ ok: false, error: 'ad_cooldown', retryAfterMs: wait });
    }

    const pbs = db.collection('gigaPostbacks');
    const pb = await pbs.findOneAndUpdate(
        { uid: String(userId), consumed: { $ne: true }, receivedAt: { $gte: new Date(Date.now() - GIGA_POSTBACK_WINDOW_MS) } },
        { $set: { consumed: true, consumedAt: new Date() } },
        { sort: { receivedAt: 1 }, returnDocument: 'after' }
    );
    if (!pb) return res.status(409).json({ ok: false, error: 'postback_pending' });

    const gapAnd = [];
    if (config.minGapSeconds) {
        const gapCutoff = new Date(Date.now() - config.minGapSeconds * 1000);
        gapAnd.push({ $or: [{ [gapField]: { $exists: false } }, { [gapField]: { $lte: gapCutoff } }] });
    }
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            isBanned: { $ne: true },
            $and: [
                REWARD_ELIGIBLE_FILTER,
                { $or: [{ [field]: { $exists: false } }, { [field]: { $lt: config.dailyLimit } }] },
                ...gapAnd,
            ],
        },
        {
            $inc: { wtcBalance: config.reward, lifetimeWtcEarned: config.reward, lifetimeAdsWatched: 1, adsWatchedToday: 1, [field]: 1, ...cyInc(network, config.reward) },
            $min: cyMin(),
            $set: { lastAdClaimAt: new Date(), [gapField]: new Date() },
            $push: { adTimes24h: { $each: [Date.now()], $slice: -30 } }, // 17 Oct 2026: exact time of this counted ad → withdraw needs 6 in the last 24h (api/withdraw.js)
        },
        { returnDocument: 'after' }
    );
    if (!gate) {
        // not paid → give the postback back so it isn't wasted
        await pbs.updateOne({ _id: pb._id }, { $set: { consumed: false }, $unset: { consumedAt: '' } });
        const ex = await users.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1, [field]: 1, [gapField]: 1 } });
        if (!ex) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (ex.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if (ex.multiAccountFlag && !ex.channelVerified) return res.status(403).json({ ok: false, error: 'account_under_review' });
        if ((ex[field] || 0) < config.dailyLimit && config.minGapSeconds && ex[gapField]) {
            const wait = new Date(ex[gapField]).getTime() + config.minGapSeconds * 1000 - Date.now();
            if (wait > 0) return res.status(400).json({ ok: false, error: 'ad_cooldown', retryAfterMs: wait });
        }
        return res.status(400).json({ ok: false, error: 'daily_limit_reached' });
    }

    await maybeAwardReferralMilestones(db, userId, { lifetimeAdsWatched: gate.lifetimeAdsWatched });
    return res.status(200).json({ ok: true, reward: config.reward, countToday: gate[field], dailyLimit: config.dailyLimit });
}

async function handleClaimAdReward(req, res, db, userId) {
    const { network, startTime, signature, viewMs } = req.body;
    const config = AD_NETWORK_REWARDS[network];
    if (!config) return res.status(400).json({ ok: false, error: 'invalid_network' });
    // mirrors handleAdStart's guard, in case a stale/forged token
    // is ever replayed against a network that's disabled (coming soon).
    if (config.enabled === false) return res.status(400).json({ ok: false, error: 'coming_soon' });
    if (config.s2s) return res.status(400).json({ ok: false, error: 'server_confirmed_only' }); // see handleAdsgramS2S

    // ⚠️ NEW — GigaPub: postback-verified claim (only while env GIGA_S2S_ENFORCE === '1'; otherwise the old barriers below run unchanged)
    if (config.postbackS2S && process.env.GIGA_S2S_ENFORCE === '1') {
        return handleGigaPostbackClaim(res, db, userId, network, config);
    }

    // 12 Oct 2026 (admin request) — networks flagged `noSecurity` (Monetag + Monetag Popup)
    // skip EVERYTHING ad-specific: no adStart token, no min-watch timer, no viewMs check,
    // no single-use key, no AD cooldown, no bot-pattern scoring. What still applies:
    // banned / bot-locked accounts, multi-account review gate, and the daily limit
    // (the atomic counter below is the only thing capping how much a user can take).
    if (config.noSecurity) {
        const nsUsers = db.collection('users');
        const nsField = COUNTER_FIELD[network];
        await ensureDailyReset(nsUsers, userId);
        const nsLock = await nsUsers.findOne({ _id: userId }, { projection: { accountLocked: 1, accountLockedReason: 1 } });
        if (nsLock?.accountLocked && nsLock.accountLockedReason === 'bot_pattern') {
            return res.status(403).json({ ok: false, error: 'account_locked' });
        }
        // dailyLimit === null means UNLIMITED (adsgramTask). minGapSeconds (optional) = anti-spam gap between claims.
        const nsLimited = config.dailyLimit != null;
        const nsGapField = 'lastNsClaimAt_' + network;
        const nsAnd = [REWARD_ELIGIBLE_FILTER];
        if (nsLimited) nsAnd.push({ $or: [{ [nsField]: { $exists: false } }, { [nsField]: { $lt: config.dailyLimit } }] }); // missing counter (new network, user already reset today) counts as 0
        if (config.minGapSeconds) {
            const nsCutoff = new Date(Date.now() - config.minGapSeconds * 1000);
            nsAnd.push({ $or: [{ [nsGapField]: { $exists: false } }, { [nsGapField]: { $lte: nsCutoff } }] });
        }
        const nsGate = await nsUsers.findOneAndUpdate(
            { _id: userId, isBanned: { $ne: true }, $and: nsAnd },
            { $inc: { wtcBalance: config.reward, lifetimeWtcEarned: config.reward, [nsField]: 1, ...cyInc(network, config.reward) }, $min: cyMin(), ...(config.minGapSeconds ? { $set: { [nsGapField]: new Date() } } : {}) }, // deliberately NOT counted in adsWatchedToday / lifetimeAdsWatched (not a real ad-view proof)
            { returnDocument: 'after' }
        );
        if (!nsGate) {
            const nsExists = await nsUsers.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1, [nsGapField]: 1 } });
            if (nsExists) nsExists.lastNsGapAt = nsExists[nsGapField];
            if (!nsExists) return res.status(404).json({ ok: false, error: 'user_not_found' });
            if (nsExists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
            if (nsExists.multiAccountFlag && !nsExists.channelVerified) return res.status(403).json({ ok: false, error: 'account_under_review' });
            // was: any failure on a limited network said "daily_limit_reached" — wrong now that Adsgram Daily also has a 60s gap.
            if (config.minGapSeconds && nsExists.lastNsGapAt) {
                const wait = new Date(nsExists.lastNsGapAt).getTime() + config.minGapSeconds * 1000 - Date.now();
                if (wait > 0) return res.status(400).json({ ok: false, error: 'ad_cooldown', retryAfterMs: wait });
            }
            return res.status(400).json({ ok: false, error: nsLimited ? 'daily_limit_reached' : 'ad_cooldown' });
        }
        return res.status(200).json({ ok: true, reward: config.reward, countToday: nsGate[nsField], dailyLimit: config.dailyLimit });
    }

    // the token issued by adStart is now mandatory.
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
    // was the shared AD_MIN_WATCH_SECONDS floor for every
    // network. Now uses THIS network's own minWatchSeconds (see
    // AD_NETWORK_REWARDS in lib/constants.js), falling back to the shared
    // constant for any network that doesn't set one. Must have taken at
    // least that many seconds since the token was issued — a genuine ad SDK
    // flow always takes real wall-clock time (loading + showing the ad); an
    // instant claim right after adStart means no ad was actually shown.
    const minWatchSeconds = config.minWatchSeconds ?? AD_MIN_WATCH_SECONDS;
    if (elapsedSeconds < minWatchSeconds) {
        return res.status(400).json({ ok: false, error: 'watch_time_too_short' });
    }
    // real ad-on-screen time, measured by the client from
    // "ad shown" to "ad finished/closed". Must be >= this network's
    // minWatchSeconds (closing earlier = no reward) and can't exceed the whole
    // adStart→claim time (it is a part of it). Missing/invalid value = rejected.
    const viewSeconds = Number(viewMs) / 1000;
    if (!Number.isFinite(viewSeconds) || viewSeconds < 0) {
        return res.status(400).json({ ok: false, error: 'missing_view_time' });
    }
    if (viewSeconds < minWatchSeconds) {
        return res.status(400).json({ ok: false, error: 'watch_time_too_short' });
    }
    if (viewSeconds > elapsedSeconds + AD_VIEW_TOLERANCE_SECONDS) {
        return res.status(400).json({ ok: false, error: 'invalid_view_time' });
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

    // anti-script guard (see lib/botGuard.js). Accounts already
    // locked for a bot pattern earn nothing more; otherwise the last few ad
    // claims + this one are checked for mechanical timing (no gap, ultra-fast,
    // identical cycles). A hit locks the account, alerts the admin, and rejects
    // this claim without paying.
    const guardDoc = await users.findOne({ _id: userId }, { projection: { accountLocked: 1, accountLockedReason: 1, recentAdClaims: 1 } });
    if (guardDoc?.accountLocked && guardDoc.accountLockedReason === 'bot_pattern') {
        return res.status(403).json({ ok: false, error: 'account_locked' });
    }
    const nowMs = Date.now();
    const adSample = { s: Number(startTime), c: nowMs, w: Math.round(elapsedSeconds * 10) / 10, v: Math.round(viewSeconds * 10) / 10 }; // w = tap→claim (server-measured, incl. loading), v = ad on screen (client-reported)
    const botHit = detectBotPattern([...(guardDoc?.recentAdClaims || []), adSample]);
    if (botHit) {
        // only rejects when the account was really locked (🔴 Likely script);
        // otherwise the admin is just notified and the claim continues.
        const adLocked = await lockForBotPattern(db, userId, botHit, tgSend, `Network: ${network}`, { samples: [...(guardDoc?.recentAdClaims || []), adSample] });
        if (adLocked) return res.status(403).json({ ok: false, error: 'account_locked' });
    }

    // AD_COOLDOWN_SECONDS was defined in constants.js but never
    // actually enforced anywhere. Wired in here: reject if the user's last
    // successful ad claim (any network) was less than AD_COOLDOWN_SECONDS
    // ago, so a script can't fire adStart→claimAdReward back-to-back with
    // zero pacing between ads.
    const cooldownCutoff = new Date(Date.now() - AD_COOLDOWN_SECONDS * 1000);

    // the token itself is single-use: `${network}:${startTime}` is
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
            // the cooldown `$or` used to sit next to `...REWARD_ELIGIBLE_FILTER`,
            // which ALSO has a top-level `$or`. In a JS object the later key wins, so the
            // cooldown check was silently thrown away. Both conditions now live in `$and`.
            $and: [
                { $or: [{ lastAdClaimAt: { $exists: false } }, { lastAdClaimAt: { $lte: cooldownCutoff } }] },
                REWARD_ELIGIBLE_FILTER,
            ],
        },
        {
            $inc: { wtcBalance: config.reward, lifetimeWtcEarned: config.reward, lifetimeAdsWatched: 1, adsWatchedToday: 1, [counterField]: 1, ...cyInc(network, config.reward) },
            $min: cyMin(),
            $addToSet: { usedAdStarts: adStartKey },
            $set: { lastAdClaimAt: new Date() },
            $push: { recentAdClaims: { $each: [adSample], $slice: -AD_CLAIM_HISTORY_KEEP }, adTimes24h: { $each: [Date.now()], $slice: -30 } }, // recentAdClaims feeds lib/botGuard.js; adTimes24h = exact time of this counted ad (withdraw needs 6 in the last 24h)
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

// ══════════════════════════════════════════════════════════════
// AD PROOFS shared by Mining + Lootbox (14 Oct 2026; Spin was removed 17 Oct 2026)
// Both play ONE ad picked by the SERVER (random: GigaPub or Adsgram Special). The reward is paid only after the
// ad network's OWN server confirmed the view:
//   • Adsgram Special → Reward URL callback stored as `adsgramProof` (see handleAdsgramS2S)
//   • GigaPub         → postback stored in `gigaPostbacks` (api/gift.js) — only while env GIGA_S2S_ENFORCE === '1';
//                       otherwise the old timer fallback (elapsed >= AD_MIN_WATCH_SECONDS since the server-recorded start) is used.
// ══════════════════════════════════════════════════════════════
const ADS_PROOF_WINDOW_MS = 5 * 60 * 1000;
const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

// 17 Oct 2026 — SECURITY: which ad networks can the server really VERIFY?
//   • adsgramSpecial → always (Adsgram's own server calls our Reward URL).
//   • giga           → ONLY when Vercel env GIGA_S2S_ENFORCE = '1' (GigaPub's own server sends the postback).
//                      With the env OFF, GigaPub is just a timer a script can fake, so the server never picks it for
//                      Spin / Mining / Lootbox. (Turn the env ON after you see real rows in the `gigaPostbacks` collection.)
const verifiedNets = (list) => {
    const ok = list.filter(n => n === 'adsgramSpecial' || (n === 'giga' && process.env.GIGA_S2S_ENFORCE === '1'));
    return ok.length ? ok : ['adsgramSpecial'];
};

// Marks WHY the next Adsgram Special callback will arrive. purpose: 'mining' | 'lootbox' | 'earn' ('earn' / null = clear).
async function setAdsgramIntent(users, userId, purpose) {
    if (purpose === 'mining' || purpose === 'lootbox') {
        await users.updateOne({ _id: userId }, { $set: { adsgramIntent: { purpose, at: new Date() } }, $unset: { adsgramProof: '' } });
    } else {
        await users.updateOne({ _id: userId }, { $unset: { adsgramIntent: '' } });
    }
}
// action: adIntent — the Earn tab's Special button calls this with purpose 'earn' right before showing the ad, so a
// leftover spin/mining intent (ad closed early) can never swallow a real Special reward.
async function handleAdIntent(req, res, db, userId) {
    await setAdsgramIntent(db.collection('users'), userId, null); // the Earn button never needs a spin/mining intent
    return res.status(200).json({ ok: true });
}

// Verifies + consumes ONE proof for `net`/`purpose`. Returns { ok:true, restore } or { ok:false, pending:true } / { ok:false, error }.
// `restore()` hands the proof back if the reward then could not be paid.
async function consumeAdProof(db, userId, net, purpose, startedAtMs) {
    const users = db.collection('users');
    if (net === 'adsgramSpecial') {
        const got = await users.findOneAndUpdate(
            { _id: userId, 'adsgramProof.purpose': purpose, 'adsgramProof.at': { $gte: new Date(Date.now() - ADS_PROOF_WINDOW_MS) } },
            { $unset: { adsgramProof: '' } },
            { returnDocument: 'before' }
        );
        if (!got) return { ok: false, pending: true };
        const old = got.adsgramProof;
        return { ok: true, restore: () => users.updateOne({ _id: userId }, { $set: { adsgramProof: old } }) };
    }
    if (net === 'giga') {
        if (process.env.GIGA_S2S_ENFORCE === '1') {
            const pbs = db.collection('gigaPostbacks');
            const pb = await pbs.findOneAndUpdate(
                { uid: String(userId), consumed: { $ne: true }, receivedAt: { $gte: new Date(Date.now() - ADS_PROOF_WINDOW_MS) } },
                { $set: { consumed: true, consumedAt: new Date() } },
                { sort: { receivedAt: 1 }, returnDocument: 'after' }
            );
            if (!pb) return { ok: false, pending: true };
            return { ok: true, restore: () => pbs.updateOne({ _id: pb._id }, { $set: { consumed: false }, $unset: { consumedAt: '' } }) };
        }
        // 17 Oct 2026 — the old "just wait 15s" fallback is GONE: a timer proves nothing (a script can wait too).
        // Without GIGA_S2S_ENFORCE=1 a GigaPub ad can't be proof, so the server never hands out a giga proof-task (see verifiedNets).
        return { ok: false, error: 'ad_not_verified' };
    }
    return { ok: false, error: 'invalid_network' };
}

// ── mineStart / mineClaim ── ⚠️ NEW (14 Oct 2026, admin) — Mining: 50 WTC every 2 hours, one ad (Giga or Adsgram Special, random).
// ══ 17 Oct 2026 (admin) — MINING BOOST (AJKER DIN, BANGLADESH TIME ONUJAYI) ══
// Niyom: AJKE (Bangladesh-er raat 12:00-er por theke ekhon porjonto) user-er link diye je friend-ra join korechhe, tader shonkha onujayi
// mining-er prottek collect-e beshi WTC. Boost-er meyad shesh hoy AJKE RAAT 12:00-e (BD time) — tarpor shonkha abar 0 theke shuru.
//   Example: friend 2:00 PM-e join korle boost ~10 ghonta (raat 12-ta porjonto) cholbe; 7:00 PM-e join korle ~5 ghonta.
// Tiers lib/constants.js MINING_BOOST_TIERS-e: 2+ friend → 60, 5+ → 80, 10+ → 120 (normal 50).
// Kon friend gonay: ajke join + channel/community verify korechhe + ban/lock na + multi-account flag na (fake account thekate).
// Eta SERVER-e hishab hoy (collect-er shomoy) — app shudhu dekhay, client kono reward pathay na, tai fake kora jay na.
async function getMiningBoost(db, userId) {
    const dayStart = todayStartBD();                                   // ajker BD raat 12:00 (Date)
    const resetsAt = dayStart.getTime() + 24 * 3600 * 1000;            // ajker raat 12:00 = boost shesh hobar shomoy
    const count = await db.collection('users').countDocuments({
        referredBy: userId,
        createdAt: { $gte: dayStart },
        channelVerified: true,
        isBanned: { $ne: true }, accountLocked: { $ne: true }, multiAccountFlag: { $ne: true },
    });
    const tier = MINING_BOOST_TIERS.find(t => count >= t.minRefs) || null;            // highest tier reached
    const next = [...MINING_BOOST_TIERS].reverse().find(t => t.minRefs > count) || null; // lowest tier still ahead
    return {
        count,
        reward: tier ? tier.reward : MINING_REWARD,
        base: MINING_REWARD,
        boosted: !!tier,
        endsAt: tier ? resetsAt : null,   // boost chole raat 12:00 porjonto
        resetsAt,                          // ajker din kokhon shesh (count 0 hoye jabe)
        next: next ? { minRefs: next.minRefs, reward: next.reward, need: next.minRefs - count } : null,
        tiers: [...MINING_BOOST_TIERS].reverse(), // lowest → highest, for the app's tier list
    };
}
// mineInfo — read-only: the app calls it to draw the boost box + timer on the Mining card (no reward, no ad).
async function handleMineInfo(req, res, db, userId) {
    const boost = await getMiningBoost(db, userId);
    return res.status(200).json({ ok: true, boost, serverNow: Date.now() });
}
async function handleMineStart(req, res, db, userId) {
    const users = db.collection('users');
    const u = await users.findOne({ _id: userId }, { projection: { lastMineAt: 1, isBanned: 1 } });
    if (!u) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (u.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if (u.lastMineAt) {
        const wait = new Date(u.lastMineAt).getTime() + MINING_COOLDOWN_HOURS * 3600 * 1000 - Date.now();
        if (wait > 0) return res.status(400).json({ ok: false, error: 'mining_not_ready', retryAfterMs: wait });
    }
    const network = pickRandom(verifiedNets(MINING_AD_NETWORKS));
    const startedAt = Date.now();
    await users.updateOne({ _id: userId }, { $set: { miningPending: { net: network, at: startedAt } } });
    await setAdsgramIntent(users, userId, network === 'adsgramSpecial' ? 'mining' : null);
    const boost = await getMiningBoost(db, userId);
    return res.status(200).json({ ok: true, network, reward: boost.reward, boost });
}
async function handleMineClaim(req, res, db, userId) {
    const users = db.collection('users');
    await ensureDailyReset(users, userId);
    const u = await users.findOne({ _id: userId }, { projection: { miningPending: 1, lastMineAt: 1, accountLocked: 1, accountLockedReason: 1 } });
    if (!u) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (u.accountLocked && u.accountLockedReason === 'bot_pattern') return res.status(403).json({ ok: false, error: 'account_locked' });
    const pend = u.miningPending;
    if (!pend || !pend.at || Date.now() - pend.at > 10 * 60 * 1000) return res.status(400).json({ ok: false, error: 'mining_not_started' });

    const cooldownCutoff = new Date(Date.now() - MINING_COOLDOWN_HOURS * 3600 * 1000);
    if (u.lastMineAt && new Date(u.lastMineAt) > cooldownCutoff) {
        return res.status(400).json({ ok: false, error: 'mining_not_ready', retryAfterMs: new Date(u.lastMineAt).getTime() + MINING_COOLDOWN_HOURS * 3600 * 1000 - Date.now() });
    }

    const proof = await consumeAdProof(db, userId, pend.net, 'mining', pend.at);
    if (!proof.ok) {
        if (proof.pending) return res.status(409).json({ ok: false, error: 'proof_pending' }); // the app retries a few times
        return res.status(400).json({ ok: false, error: proof.error });
    }
    // 17 Oct 2026: the reward is decided HERE, on the server, from the friends who joined in the last 24h (getMiningBoost above).
    const boost = await getMiningBoost(db, userId);
    const reward = boost.reward;

    const gate = await users.findOneAndUpdate(
        {
            _id: userId, isBanned: { $ne: true }, 'miningPending.at': pend.at,
            $and: [
                { $or: [{ lastMineAt: { $exists: false } }, { lastMineAt: { $lte: cooldownCutoff } }] },
                REWARD_ELIGIBLE_FILTER,
            ],
        },
        {
            $inc: { wtcBalance: reward, lifetimeWtcEarned: reward, lifetimeMined: 1, ...cyInc('mining', reward) },
            $min: cyMin(),
            $set: { lastMineAt: new Date(), lastMineReward: reward },
            $unset: { miningPending: '' },
        },
        { returnDocument: 'after' }
    );
    if (!gate) {
        await proof.restore();
        const ex = await users.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1 } });
        if (ex?.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if (ex?.multiAccountFlag && !ex.channelVerified) return res.status(403).json({ ok: false, error: 'account_under_review' });
        return res.status(400).json({ ok: false, error: 'mining_not_ready' });
    }
    // 20 Oct 2026 (admin): referral milestone 5 — the referrer gets a bonus when this user has collected Mining 2 times.
    await maybeAwardReferralMilestones(db, userId, { lifetimeMined: gate.lifetimeMined });
    return res.status(200).json({ ok: true, reward, boosted: boost.boosted, lastMineAt: gate.lastMineAt });
}

// 17 Oct 2026 (admin): SPIN WHEEL REMOVED — spinStart / spin handlers, spin logs, bot alerts and bonus spins no longer exist.

// ── taskComplete ── ⚠️ NOW GATED (STEP 2 only — see comment below on why STEP 1's slot-claim stays ungated)
// previously the task.limit check used a plain read
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
// previously the task.limit check used a plain read
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
// for every category EXCEPT 'channel', this
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
    // API-verified join tasks are no longer tied
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
        // cross-task cooldown (see TASK_COOLDOWN_SECONDS in
        // lib/constants.js). A quick pre-check here just for a clean, fast
        // rejection before wasting a task "slot" claim below — the REAL
        // enforcement (closing the race window) is the atomic filter on
        // lastTaskClaimAt in the STEP 2 update further down.
        if (user.lastTaskClaimAt && new Date(user.lastTaskClaimAt).getTime() > Date.now() - TASK_COOLDOWN_SECONDS * 1000) {
            return res.status(400).json({
                ok: false, error: 'task_cooldown',
                retryAfterMs: new Date(user.lastTaskClaimAt).getTime() + TASK_COOLDOWN_SECONDS * 1000 - Date.now(),
            });
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
    // also requires REWARD_ELIGIBLE_FILTER, and (for non-channel
    // categories) the taskStart token is atomically marked spent in the same
    // update that credits the reward — same single-use pattern as
    // usedAdStarts/usedVideoStarts.
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            completedTasks: { $ne: taskId },
            ...(taskStartKey ? {
                usedTaskStarts: { $ne: taskStartKey },
                // atomic re-check of the cooldown pre-check above, closing
                // the race window (e.g. two rapid double-taps landing near the
                // boundary, or two different tasks' claims arriving milliseconds
                // apart). Only applies to non-channel tasks (taskStartKey set).
            } : {}),
            // same duplicate-`$or` problem as the ad claim above: the task
            // cooldown re-check was overwritten by REWARD_ELIGIBLE_FILTER's `$or`.
            $and: [
                ...(taskStartKey ? [{ $or: [{ lastTaskClaimAt: { $exists: false } }, { lastTaskClaimAt: { $lte: new Date(Date.now() - TASK_COOLDOWN_SECONDS * 1000) } }] }] : []),
                REWARD_ELIGIBLE_FILTER,
            ],
        },
        {
            $inc: { wtcBalance: rewardWtc, lifetimeWtcEarned: rewardWtc, tasksCompletedToday: 1, ...cyInc('task', rewardWtc) },
            $min: cyMin(),
            $addToSet: taskStartKey ? { completedTasks: taskId, usedTaskStarts: taskStartKey } : { completedTasks: taskId },
            // only stamped for non-channel tasks; channel/api-verified
            // tasks aren't subject to the cooldown so there's no need to track it
            // for them (and no reason to make an unrelated 'channel' claim wait on
            // an earlier non-channel task's timer, or vice versa).
            ...(taskStartKey ? { $set: { lastTaskClaimAt: new Date() } } : {}),
        },
        { returnDocument: 'after' }
    );
    if (!gate) {
        // Crediting the user failed (e.g. already done in a race, OR blocked by
        // the multi-account review gate) — give the task's slot back either way.
        await tasks.updateOne({ _id: taskObjId }, { $inc: { completionCount: -1 } });
        const exists = await users.findOne({ _id: userId }, { projection: { completedTasks: 1, multiAccountFlag: 1, channelVerified: 1, usedTaskStarts: 1, lastTaskClaimAt: 1 } });
        if (taskStartKey && (exists?.usedTaskStarts || []).includes(taskStartKey)) {
            return res.status(400).json({ ok: false, error: 'task_token_already_used' });
        }
        // surface the cooldown specifically (instead of falling through
        // to the generic alreadyDone below) if that's what actually blocked it.
        if (taskStartKey && exists?.lastTaskClaimAt && new Date(exists.lastTaskClaimAt).getTime() > Date.now() - TASK_COOLDOWN_SECONDS * 1000) {
            return res.status(400).json({
                ok: false, error: 'task_cooldown',
                retryAfterMs: new Date(exists.lastTaskClaimAt).getTime() + TASK_COOLDOWN_SECONDS * 1000 - Date.now(),
            });
        }
        if (exists?.multiAccountFlag && !exists.channelVerified && !(exists.completedTasks || []).includes(taskId)) {
            return res.status(403).json({ ok: false, error: 'account_under_review' });
        }
        return res.status(200).json({ ok: false, alreadyDone: true });
    }

    await maybeAwardReferralMilestones(db, userId, { completedTasksCount: gate.completedTasks.length });

    // user-created tasks (see api/payments.js (resource:'taskcreate')) auto-delete
    // USER_TASK_COMPLETED_TTL_DAYS after they hit their completion limit
    // (TTL index in models/schema.js). Only fires for isUserCreated:true
    // tasks — an admin-set limit on a normal task is never auto-deleted
    // this way. Placed AFTER the reward-credit gate above succeeds (not
    // right after taskGate) so a completion that gets rolled back (STEP 2
    // failing, slot given back at line ~597) never wrongly marks the task
    // "completed" while its real completionCount is actually back below limit.
    if (taskGate.isUserCreated && taskGate.limit > 0 && taskGate.completionCount >= taskGate.limit) {
        tasks.updateOne({ _id: taskObjId, completedAt: { $exists: false } }, { $set: { completedAt: new Date() } }).catch(() => {});
    }

    return res.status(200).json({ ok: true, rewardWtc });
}

// 16 Oct 2026 — promo codes copied from the channel / broadcast carry invisible characters (see obscureCode() in api/bot.js),
// which made a correctly copied code fail with "Invalid code". Strip every invisible char + space before matching,
// so both typed and pasted codes work.
function cleanPromoCode(code) {
    return String(code).replace(/[\u200B-\u200F\u2060-\u2064\u00AD\uFEFF\s]/g, '');
}

// ── checkPromo ── ⚠️ NEW — read-only pre-validation, called BEFORE the ad
// is shown (see redeemPromoCode() in index.html). Previously the ad played
// unconditionally, so an invalid/expired/already-used code still cost the
// user a full ad watch before they found out it failed. This mirrors every
// validation in handleClaimPromo below EXCEPT it never mutates the promo
// doc — the real, atomic redemption still happens in claimPromo after the
// ad, so a code that becomes invalid in the few seconds between the two
// calls (a genuine race, not a UX annoyance) is still safely caught there.
// 17 Oct 2026 — wrong-code guessing limit. A script trying random codes gets blocked after PROMO_FAIL_LIMIT misses in
// PROMO_FAIL_WINDOW_MS. Counter lives in users.promoFails = { n, at }. A correct code never touches it.
async function promoBlocked(users, userId) {
    const u = await users.findOne({ _id: userId }, { projection: { promoFails: 1 } });
    const f = u?.promoFails;
    return !!(f && f.n >= PROMO_FAIL_LIMIT && Date.now() - f.at < PROMO_FAIL_WINDOW_MS);
}
async function promoFailed(users, userId) {
    const u = await users.findOne({ _id: userId }, { projection: { promoFails: 1 } });
    const f = u?.promoFails;
    const fresh = f && Date.now() - f.at < PROMO_FAIL_WINDOW_MS;
    await users.updateOne({ _id: userId }, { $set: { promoFails: { n: fresh ? f.n + 1 : 1, at: fresh ? f.at : Date.now() } } });
}
async function handleCheckPromo(req, res, db, userId) {
    const { code } = req.body;
    if (!code) return res.status(400).json({ ok: false, error: 'missing_fields' });
    if (await promoBlocked(db.collection('users'), userId)) return res.status(429).json({ ok: false, error: 'too_many_attempts' });

    const promos = db.collection('promos');
    const promo = await promos.findOne({ code: cleanPromoCode(code) });
    if (!promo) { await promoFailed(db.collection('users'), userId); return res.status(404).json({ ok: false, error: 'invalid_code' }); }
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

    if (await promoBlocked(users, userId)) return res.status(429).json({ ok: false, error: 'too_many_attempts' }); // 17 Oct 2026 — brute-force guard
    const promo = await promos.findOne({ code: cleanPromoCode(code) });
    if (!promo) { await promoFailed(users, userId); return res.status(404).json({ ok: false, error: 'invalid_code' }); }
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

    // 15 Oct 2026 — if this promo was auto-posted to the official channel and EVERY code of that post is now used up,
    // edit the post to "all claimed" (creates urgency, stops people trying dead codes). Best-effort, never blocks the claim.
    if (promoGate.channelMsgId && (promoGate.usedCount || 0) >= maxUses) {
        try {
            const left = await promos.countDocuments({ channelMsgId: promoGate.channelMsgId, $expr: { $lt: ['$usedCount', '$maxUses'] } });
            if (left === 0) {
                const doneText = '🎁 <b>Promo Code — ALL CLAIMED ✅</b>\n\n⚡ Too slow this time! Every code was redeemed.\nStay in the channel — the next code is coming soon.';
                const kb = { reply_markup: { inline_keyboard: [[{ text: '🚀 Open NEWTUBE', url: 'https://t.me/NewTube12_bot/WatchTo_Earn' }]] } };
                if (promoGate.channelPostIsPhoto) await tgEditCaption(OFFICIAL_CHANNEL, promoGate.channelMsgId, doneText, kb);
                else await tgEdit(OFFICIAL_CHANNEL, promoGate.channelMsgId, doneText, kb);
            }
        } catch (e) { console.error('promo channel edit failed:', e.message); }
    }

    // the promo code itself is already marked used above (promoGate)
    // even if the credit below is blocked by REWARD_ELIGIBLE_FILTER —
    // otherwise a flagged user could keep retrying the same code after
    // verifying, defeating the code's single-use-per-user limit. Trade-off:
    // a flagged user "burns" a promo code with zero reward if they redeem it
    // while still unverified. Accepted, since promo codes are typically
    // low-value and this closes an easy retry-abuse path.
    const reward = promo.reward || 0;
    const creditResult = await users.updateOne(
        { _id: userId, ...REWARD_ELIGIBLE_FILTER },
        { $inc: { wtcBalance: reward, lifetimeWtcEarned: reward, ...cyInc('promo', reward) }, $min: cyMin() }
    );
    if (creditResult.matchedCount === 0) {
        return res.status(403).json({ ok: false, error: 'account_under_review' });
    }

    return res.status(200).json({ ok: true, reward });
}

// ⚠️ REMOVED (this update) — Monetag S2S postback system
// (handleMonetagPostback + the `?pb=monetag` GET route). Admin decision:
// reverted back to the ordinary signed-token + timer flow every other
// network uses (see AD_NETWORK_REWARDS in lib/constants.js — monetag and
// monetagPopup now both have a plain `minWatchSeconds: 6`). No more
// MONETAG_POSTBACK_SECRET, no more `monetagProcessedYmids` collection, no
// more per-user ymid generation in index.html.

// ══════════════════════════════════════════════════════════════
// 🔒 ADSGRAM S2S (server-to-server reward confirmation)
// Adsgram's OWN server calls:
//   GET /api/earn?s2s=adsgram&net=<adsgramSpecial|adsgramTask>&userid=[userId]&token=<ADSGRAM_S2S_SECRET>
// after the user really earned the reward (set as the "Reward URL" of each Adsgram block).
// The reward is credited HERE, so nothing the phone sends can mint WTC for these networks.
// Always answers 200 once the token is valid (even if nothing was paid) so Adsgram never retries
// a request that was deliberately refused (limit reached, banned, too fast...).
// ══════════════════════════════════════════════════════════════
function safeEqualStr(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function handleAdsgramS2S(req, res) {
    const S2S_SECRET = process.env.ADSGRAM_S2S_SECRET;
    if (!S2S_SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    const q = req.query || {};
    if (!safeEqualStr(q.token || '', S2S_SECRET)) return res.status(403).json({ ok: false, error: 'forbidden' });

    const network = String(q.net || '');
    const config = AD_NETWORK_REWARDS[network];
    if (!config || !config.s2s) return res.status(400).json({ ok: false, error: 'invalid_network' });
    const userId = String(q.userid || '').trim();
    if (!/^\d{1,15}$/.test(userId)) return res.status(400).json({ ok: false, error: 'invalid_user' });

    const { db } = await connectToDatabase();
    const users = db.collection('users');
    const field = COUNTER_FIELD[network];
    await ensureDailyReset(users, userId);

    const lock = await users.findOne({ _id: userId }, { projection: { accountLocked: 1, accountLockedReason: 1 } });
    if (lock?.accountLocked && lock.accountLockedReason === 'bot_pattern') return res.status(200).json({ ok: false, error: 'account_locked' });

    // 14 Oct 2026 — Spin Wheel + Mining also play an Adsgram Special ad. Adsgram calls this same Reward URL for
    // EVERY view of that block, so the server must know WHY the ad was started. spinStart/mineStart (and adIntent for the
    // normal Earn button) record `adsgramIntent`. If the intent is spin/mining and fresh, this callback is stored as a
    // one-time PROOF (adsgramProof) that handleSpin/handleMineClaim consume — NO WTC is paid here (it would double-pay).
    if (network === 'adsgramSpecial') {
        const proofHit = await users.findOneAndUpdate(
            { _id: userId, 'adsgramIntent.purpose': { $in: ['mining', 'lootbox'] }, 'adsgramIntent.at': { $gte: new Date(Date.now() - ADS_PROOF_WINDOW_MS) } },
            [{ $set: { adsgramProof: { purpose: '$adsgramIntent.purpose', at: '$$NOW' } } }, { $unset: 'adsgramIntent' }],
            { returnDocument: 'after' }
        );
        if (proofHit) return res.status(200).json({ ok: true, proof: proofHit.adsgramProof?.purpose || true });
    }

    const limited = config.dailyLimit != null;
    const gapField = 'lastS2sAt_' + network;
    const and = [REWARD_ELIGIBLE_FILTER];
    if (limited) and.push({ $or: [{ [field]: { $exists: false } }, { [field]: { $lt: config.dailyLimit } }] });
    if (config.s2sMinGapSeconds) {
        const cutoff = new Date(Date.now() - config.s2sMinGapSeconds * 1000);
        and.push({ $or: [{ [gapField]: { $exists: false } }, { [gapField]: { $lte: cutoff } }] }); // swallows an immediate duplicate callback
    }
    const inc = { wtcBalance: config.reward, lifetimeWtcEarned: config.reward, [field]: 1, ...cyInc(network, config.reward) };
    const set = { [gapField]: new Date() };
    if (config.countsAsAd) { inc.lifetimeAdsWatched = 1; inc.adsWatchedToday = 1; set.lastAdClaimAt = new Date(); }

    const gate = await users.findOneAndUpdate(
        { _id: userId, isBanned: { $ne: true }, $and: and },
        { $inc: inc, $min: cyMin(), $set: set, ...(config.countsAsAd ? { $push: { adTimes24h: { $each: [Date.now()], $slice: -30 } } } : {}) }, // 17 Oct 2026: counted ads also record their exact time for the withdraw 24h rule
        { returnDocument: 'after' }
    );
    if (!gate) {
        const ex = await users.findOne({ _id: userId }, { projection: { isBanned: 1, multiAccountFlag: 1, channelVerified: 1 } });
        if (!ex) return res.status(200).json({ ok: false, error: 'user_not_found' });
        if (ex.isBanned) return res.status(200).json({ ok: false, error: 'banned' });
        if (ex.multiAccountFlag && !ex.channelVerified) return res.status(200).json({ ok: false, error: 'account_under_review' });
        return res.status(200).json({ ok: false, error: limited ? 'daily_limit_reached_or_duplicate' : 'duplicate' });
    }
    if (config.countsAsAd) await maybeAwardReferralMilestones(db, userId, { lifetimeAdsWatched: gate.lifetimeAdsWatched });
    return res.status(200).json({ ok: true, reward: config.reward, countToday: gate[field] });
}

export default async function handler(req, res) {
    // Adsgram's server calls us with GET (no Telegram session) — handled before the POST-only / initData gate.
    if (req.method === 'GET' && req.query && req.query.s2s === 'adsgram') return handleAdsgramS2S(req, res);
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const { action } = req.body || {};

    // All actions require a valid Telegram session
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    // videoStart used to be handled BEFORE the
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
        case 'adIntent':        return handleAdIntent(req, res, db, userId);
        case 'mineStart':       return handleMineStart(req, res, db, userId);
        case 'mineClaim':       return handleMineClaim(req, res, db, userId);
        case 'mineInfo':        return handleMineInfo(req, res, db, userId);
        case 'taskStart':       return handleTaskStart(req, res, db, userId);
        case 'taskComplete':   return handleTaskComplete(req, res, db, userId);
        case 'checkPromo':      return handleCheckPromo(req, res, db, userId);
        case 'claimPromo':     return handleClaimPromo(req, res, db, userId);
        default: return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
}
