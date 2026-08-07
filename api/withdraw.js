// api/withdraw.js — CONVERT-FIRST FLOW + TIERED WITHDRAW + ADDRESS LOCK
//
// ⚠️ MAJOR CHANGE: withdrawals no longer deduct WTC (or a fee) directly.
// Users must first CONVERT WTC into a USDT balance — that's where the 25%
// fee is now taken (see handleConvert). Withdrawals then spend from that
// already-fee-deducted `usdtBalance` with NO additional fee at this step.
//
// Tier claim limits reset every 6 MONTHS (Bangladesh time, currentHalfYearBD()).
// A 30-day address lock still applies: the first method+address a user
// withdraws to becomes fixed for that long.
//
// ⚠️ NEW (this update): every withdraw request — regardless of tier size —
// now requires:
//   - WITHDRAW_ADS_REQUIRED (15) ads watched TODAY (Bangladesh calendar day)
//   - FIRST_WITHDRAW_MIN_TASKS (10) tasks completed LIFETIME
// These replace the old per-tier calcAdsRequired(tier.usd) scaling and the
// "only checked on the very first withdraw" task gate. Referral requirements
// (per-tier, in WITHDRAW_TIERS) are UNCHANGED.
//
//   GET  /api/withdraw?action=history&initData=...
//   GET  /api/withdraw?action=tiers&initData=...              → tier list + eligibility + global ads/task requirement status + address-lock status
//   POST /api/withdraw   body: { initData, action:'convert', wtcAmount }
//   POST /api/withdraw   body: { initData, action:'create',  method, details, tierId }   (action defaults to 'create' if omitted)

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    WITHDRAW_METHODS, WITHDRAW_FEE_PERCENT, WITHDRAW_TIERS, WITHDRAW_ADDRESS_LOCK_DAYS, MIN_CONVERT_WTC,
    WITHDRAW_TASKS_REQUIRED, WITHDRAW_ADS_REQUIRED, WITHDRAW_LEVELS, todayBD, currentHalfYearBD, WTC_PER_USD, WITHDRAWALS_OPEN,
} from '../lib/constants.js';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
const LOCK_MS = WITHDRAW_ADDRESS_LOCK_DAYS * 24 * 60 * 60 * 1000;

// Ensures the per-tier claim counters are reset if the 6-month period has
// rolled over since the user's last withdrawal. Returns the (possibly
// freshly-reset) tier-count map and the current period key.
async function ensureTierPeriodReset(users, userId, user) {
    const period = currentHalfYearBD();
    if (user.withdrawTierMonth === period) {
        return { counts: user.withdrawTierCounts || {}, period };
    }
    await users.updateOne({ _id: userId }, { $set: { withdrawTierCounts: {}, withdrawTierMonth: period } });
    return { counts: {}, period };
}

// Resets the level-6 (final level) recurring withdraw counter if the
// 6-month period rolled over — same period key as the tier system
// (currentHalfYearBD()), so both reset in sync. Levels 1-5 never need a
// reset: they're one-way (spend the allowance, then level up for more).
async function ensureLevelSixPeriodReset(users, userId, user) {
    const period = currentHalfYearBD();
    if (user.level6WithdrawPeriod === period) {
        return { count: user.level6WithdrawCount || 0, period };
    }
    await users.updateOne({ _id: userId }, { $set: { level6WithdrawCount: 0, level6WithdrawPeriod: period } });
    return { count: 0, period };
}

// Figures out whether the user CAN withdraw right now under the level
// system, auto-leveling them up in the DB if they've spent their current
// level's allowance and already qualify (referral-wise) for the next one.
// Returns either { ok:true, level, isFinal, period? } or { ok:false, ... }
// with enough detail for the frontend's hidden-until-withdraw level screen.
async function resolveWithdrawLevel(users, userId, user) {
    const currentLevel = user.withdrawLevel || 1;
    const cfg = WITHDRAW_LEVELS.find(l => l.level === currentLevel) || WITHDRAW_LEVELS[0];

    if (cfg.final) {
        const { count, period } = await ensureLevelSixPeriodReset(users, userId, user);
        if (count >= cfg.withdrawsAllowed) {
            return {
                ok: false, error: 'level_limit_reached', level: currentLevel, isFinal: true,
                message: `You've used all ${cfg.withdrawsAllowed} withdrawals for this 6-month period at level ${currentLevel} (max level). It resets automatically every 6 months.`,
            };
        }
        return { ok: true, level: currentLevel, isFinal: true, period, usedSoFar: count };
    }

    const usedAtLevel = user.withdrawsUsedAtLevel || 0;
    if (usedAtLevel < cfg.withdrawsAllowed) {
        return { ok: true, level: currentLevel, isFinal: false, usedSoFar: usedAtLevel };
    }

    // Allowance spent at this level — see if they already qualify to level up.
    const nextCfg = WITHDRAW_LEVELS.find(l => l.level === currentLevel + 1);
    if (!nextCfg || (user.referralCount || 0) < nextCfg.referralsRequired) {
        return {
            ok: false, error: 'level_up_required', level: currentLevel,
            nextLevel: nextCfg?.level ?? null,
            referralsRequired: nextCfg?.referralsRequired ?? null,
            referralsHave: user.referralCount || 0,
            message: nextCfg
                ? `You've used all ${cfg.withdrawsAllowed} withdrawals at level ${currentLevel}. Refer ${Math.max(0, nextCfg.referralsRequired - (user.referralCount || 0))} more people to reach level ${nextCfg.level} and unlock ${nextCfg.withdrawsAllowed} more withdrawals.`
                : `You've used all withdrawals at level ${currentLevel}.`,
        };
    }

    // Qualifies — level up now, allowance resets to 0 used at the new level.
    await users.updateOne({ _id: userId }, { $set: { withdrawLevel: nextCfg.level, withdrawsUsedAtLevel: 0 } });
    return { ok: true, level: nextCfg.level, isFinal: !!nextCfg.final, usedSoFar: 0, leveledUp: true };
}

// Address-lock status for a user — null if not currently locked (either
// never withdrawn, or the lock has expired).
function getAddressLockStatus(user) {
    if (!user.addressLockedAt) return null;
    const elapsed = Date.now() - new Date(user.addressLockedAt).getTime();
    if (elapsed >= LOCK_MS) return null; // expired
    return {
        method: user.lockedWithdrawMethod,
        address: user.lockedWithdrawAddress,
        daysLeft: Math.max(1, Math.ceil((LOCK_MS - elapsed) / (24 * 60 * 60 * 1000))),
    };
}

// `usd` is deducted straight from usdtBalance, no fee here (fee already
// happened at convert time) — so "net" is just `usd`.
function tierEligibility(tier, referralCount, claimsUsedThisMonth, usdtBalance) {
    return {
        id: tier.id,
        usd: tier.usd,
        netUsd: tier.usd, // kept for frontend compatibility — no fee at this step
        monthlyLimit: tier.monthlyLimit,
        claimsUsed: claimsUsedThisMonth,
        claimsLeft: Math.max(0, tier.monthlyLimit - claimsUsedThisMonth),
        referralsRequired: tier.referralsRequired,
        referralsHave: referralCount,
        referralsMet: referralCount >= tier.referralsRequired,
        monthlyLimitReached: claimsUsedThisMonth >= tier.monthlyLimit,
        balanceOk: usdtBalance >= tier.usd,
    };
}

// ── GET ?action=tiers ──
async function handleTiers(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const users = db.collection('users');
    // ⚠️ NEW: reset applied here too (previously only handleCreate called
    // this), so adsWatchedToday shown in the "tiers" GET response can't be
    // stale from a previous calendar day.
    const today = await ensureDailyReset(users, id);
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const { counts } = await ensureTierPeriodReset(users, id, user);
    const usdtBalance = user.usdtBalance || 0;
    const tiers = WITHDRAW_TIERS.map(t => tierEligibility(t, user.referralCount || 0, counts[t.id] || 0, usdtBalance));
    const addressLock = getAddressLockStatus(user);

    // ⚠️ NEW — global (level-independent... wait, tier-independent) requirement
    // status, for the multi-step withdraw wizard's "Requirements" screen (ads
    // progress bar, TODAY's task progress bar — matches the reference
    // screenshot's UI). tasksHave is now tasksCompletedToday (Season 3 — was
    // lifetime completedTasks.length).
    const adsToday = user.lastResetDate === today ? (user.adsWatchedToday || 0) : 0;
    const tasksToday = user.lastResetDate === today ? (user.tasksCompletedToday || 0) : 0;
    const withdrawRequirements = {
        adsRequired: WITHDRAW_ADS_REQUIRED,
        adsWatchedToday: adsToday,
        adsMet: adsToday >= WITHDRAW_ADS_REQUIRED,
        tasksRequired: WITHDRAW_TASKS_REQUIRED,
        tasksHave: tasksToday,
        tasksMet: tasksToday >= WITHDRAW_TASKS_REQUIRED,
    };

    // ⚠️ NEW — Season 3 level system. Deliberately only exposed from THIS
    // endpoint (called when the withdraw screen opens), not from
    // action=profile or anywhere else — the whole ladder stays hidden until
    // the user actually goes to withdraw, per the spec.
    const currentLevel = user.withdrawLevel || 1;
    const levelCfg = WITHDRAW_LEVELS.find(l => l.level === currentLevel) || WITHDRAW_LEVELS[0];
    const levelUsed = levelCfg.final
        ? (user.level6WithdrawPeriod === currentHalfYearBD() ? (user.level6WithdrawCount || 0) : 0)
        : (user.withdrawsUsedAtLevel || 0);
    const nextLevelCfg = WITHDRAW_LEVELS.find(l => l.level === currentLevel + 1) || null;
    const withdrawLevelInfo = {
        level: currentLevel,
        isFinal: !!levelCfg.final,
        withdrawsAllowed: levelCfg.withdrawsAllowed,
        withdrawsUsed: levelUsed,
        withdrawsLeft: Math.max(0, levelCfg.withdrawsAllowed - levelUsed),
        nextLevel: nextLevelCfg?.level ?? null,
        nextLevelReferralsRequired: nextLevelCfg?.referralsRequired ?? null,
        referralsHave: user.referralCount || 0,
        canLevelUpNow: nextLevelCfg ? (user.referralCount || 0) >= nextLevelCfg.referralsRequired : false,
    };

    return res.status(200).json({
        ok: true, tiers, usdtBalance, wtcBalance: user.wtcBalance || 0, addressLock,
        withdrawRequirements, withdrawLevelInfo,
        withdrawalsOpen: WITHDRAWALS_OPEN, // ⚠️ NEW — frontend checks this first to show a closed banner instead of the full wizard
        minConvertWtc: MIN_CONVERT_WTC, convertFeePercent: WITHDRAW_FEE_PERCENT,
    });
}

// ── GET ?action=history ──
async function handleHistory(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const withdrawals = db.collection('withdrawals');
    const list = await withdrawals
        .find({ userId: id, status: { $in: ['pending', 'approved'] } })
        .sort({ createdAt: -1 })
        .limit(30)
        .project({ userId: 0, username: 0 })
        .toArray();

    return res.status(200).json({ ok: true, history: list });
}

// ── POST action:'convert' — WTC → usdtBalance, fee taken HERE ──
async function handleConvert(req, res, db) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const wtcAmount = Math.floor(Number(req.body?.wtcAmount));
    if (!wtcAmount || isNaN(wtcAmount) || wtcAmount <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_amount' });
    }
    if (wtcAmount < MIN_CONVERT_WTC) {
        return res.status(400).json({ ok: false, error: 'below_minimum', message: `Minimum ${MIN_CONVERT_WTC.toLocaleString()} WTC required to convert.` });
    }

    const users = db.collection('users');
    const user = await users.findOne({ _id: id }, { projection: { isBanned: 1, wtcBalance: 1 } });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const grossUsd = wtcAmount / WTC_PER_USD;
    const feeUsd = grossUsd * (WITHDRAW_FEE_PERCENT / 100);
    const netUsd = grossUsd - feeUsd;

    // ── ATOMIC — balance check + deduct WTC + credit usdtBalance, one operation ──
    const gate = await users.findOneAndUpdate(
        { _id: id, isBanned: { $ne: true }, wtcBalance: { $gte: wtcAmount } },
        { $inc: { wtcBalance: -wtcAmount, usdtBalance: netUsd } },
        { returnDocument: 'after' }
    );
    if (!gate) return res.status(409).json({ ok: false, error: 'insufficient_balance' });

    return res.status(200).json({
        ok: true, wtcConverted: wtcAmount, feeUsd, netUsd,
        newWtcBalance: gate.wtcBalance, newUsdtBalance: gate.usdtBalance,
    });
}

// ── POST action:'create' (default) — spend usdtBalance against a tier ──
async function handleCreate(req, res, db) {
    // ⚠️ SEASON END — checked FIRST, before auth/DB, so a closed season
    // fails fast and cheap. Already-submitted ('pending') withdrawals are
    // untouched by this — only NEW submissions are blocked here.
    if (!WITHDRAWALS_OPEN) {
        return res.status(403).json({ ok: false, error: 'withdrawals_closed', message: 'Withdrawals are currently closed. Any previously submitted request will still be processed.' });
    }

    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const { method, details, tierId } = req.body;
    if (!method || !details || !tierId) {
        return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    const methodConfig = WITHDRAW_METHODS[method];
    if (!methodConfig) return res.status(400).json({ ok: false, error: 'invalid_method' });

    const tier = WITHDRAW_TIERS.find(t => t.id === tierId);
    if (!tier) return res.status(400).json({ ok: false, error: 'invalid_tier' });

    const users = db.collection('users');
    const today = await ensureDailyReset(users, id);

    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    // ⚠️ SEASON 3 CHANGE: was a lifetime completedTasks.length gate — now
    // checked against TODAY's tasksCompletedToday instead (resets daily,
    // same boundary as ads below).
    const tasksToday = user.lastResetDate === today ? (user.tasksCompletedToday || 0) : 0;
    if (tasksToday < WITHDRAW_TASKS_REQUIRED) {
        return res.status(400).json({
            ok: false, error: 'need_5_tasks', // ⚠️ error code name kept as-is for frontend errorText() compatibility — semantics updated, code string unchanged
            tasksRequired: WITHDRAW_TASKS_REQUIRED, tasksHave: tasksToday,
            message: `Complete at least ${WITHDRAW_TASKS_REQUIRED} tasks today before withdrawing (you have ${tasksToday} today).`,
        });
    }

    // ── 30-day address lock ──
    const lockStatus = getAddressLockStatus(user);
    if (lockStatus && (lockStatus.method !== method || lockStatus.address !== details)) {
        return res.status(400).json({
            ok: false, error: 'address_locked',
            lockedMethod: lockStatus.method, lockedAddress: lockStatus.address, daysLeft: lockStatus.daysLeft,
            message: `Your withdraw address is locked to ${WITHDRAW_METHODS[lockStatus.method]?.label || lockStatus.method} (${lockStatus.address}) for ${lockStatus.daysLeft} more day(s).`,
        });
    }

    // ── tier eligibility: lifetime referral threshold + claim limit (UNCHANGED logic; monthlyLimit values updated in constants.js) ──
    const { counts: tierCounts, period: tierPeriod } = await ensureTierPeriodReset(users, id, user);
    if ((user.referralCount || 0) < tier.referralsRequired) {
        return res.status(400).json({
            ok: false, error: 'referral_required',
            referralsNeeded: tier.referralsRequired, referralsHave: user.referralCount || 0,
            message: `This tier needs ${tier.referralsRequired} total referrals (you have ${user.referralCount || 0}).`,
        });
    }
    const claimsUsed = tierCounts[tier.id] || 0;
    if (claimsUsed >= tier.monthlyLimit) {
        return res.status(400).json({
            ok: false, error: 'tier_monthly_limit_reached',
            message: `You've used all ${tier.monthlyLimit} claim(s) for this tier this period. It resets every 6 months.`,
        });
    }

    if ((user.usdtBalance || 0) < tier.usd) {
        return res.status(400).json({ ok: false, error: 'insufficient_balance', message: `You need $${tier.usd} in your converted balance. Convert more WTC first.` });
    }

    // ⚠️ CHANGED: fixed WITHDRAW_ADS_REQUIRED (15) instead of
    // calcAdsRequired(tier.usd) — same requirement regardless of tier size.
    const adsToday = user.lastResetDate === today ? (user.adsWatchedToday || 0) : 0;
    if (adsToday < WITHDRAW_ADS_REQUIRED) {
        return res.status(400).json({ ok: false, error: 'insufficient_ads', adsRequired: WITHDRAW_ADS_REQUIRED, adsToday });
    }

    // ⚠️ NEW — Season 3 level gate. Separate from the tier's own
    // referralsRequired above: this caps the total number of withdrawal
    // ACTIONS allowed at the user's current level, auto-leveling them up
    // (and resetting their per-level count) if they already qualify.
    const levelResolution = await resolveWithdrawLevel(users, id, user);
    if (!levelResolution.ok) {
        return res.status(400).json(levelResolution);
    }

    const withdrawals = db.collection('withdrawals');
    const addressUsedByOther = await withdrawals.findOne({
        details, userId: { $ne: id }, status: { $ne: 'rejected' },
    });
    if (addressUsedByOther) {
        return res.status(400).json({ ok: false, error: 'address_used_by_other' });
    }

    // ══════════════════════════════════════════════════════════
    // ATOMIC GATE — usdtBalance check, once-per-day check, tier's claim-limit
    // check, and the address-lock condition all re-verified + applied here.
    //
    // ⚠️ NEW: lastResetDate + adsWatchedToday are now ALSO part of this
    // atomic filter (previously the ads check above was a plain read with no
    // atomic re-verification). Without this, a request landing right at the
    // Bangladesh midnight boundary could pass the non-atomic ads check above
    // and then have adsWatchedToday reset to 0 by a concurrent/later request
    // before this update runs — letting a withdrawal through with 0 ads
    // watched today. Now that gap is closed.
    // ══════════════════════════════════════════════════════════
    const tierCountField = `withdrawTierCounts.${tier.id}`;
    const lockFilter = lockStatus
        ? { lockedWithdrawMethod: method, lockedWithdrawAddress: details }
        : { $or: [{ addressLockedAt: { $exists: false } }, { addressLockedAt: { $lt: new Date(Date.now() - LOCK_MS) } }] };

    // ⚠️ NEW — level-specific filter/update fragment, re-verified atomically
    // here (resolveWithdrawLevel's read above is non-atomic, same tradeoff
    // the tier system already accepts for its own period-reset check).
    // withdrawLevel is unset for anyone who has never leveled up yet (still
    // level 1 by default) — plain equality wouldn't match a missing field,
    // so level 1 needs the $exists:false fallback too.
    const levelEqFilter = levelResolution.level === 1
        ? { $or: [{ withdrawLevel: { $exists: false } }, { withdrawLevel: 1 }] }
        : { withdrawLevel: levelResolution.level };

    const updateOps = { $inc: { usdtBalance: -tier.usd, [tierCountField]: 1 } };
    if (levelResolution.isFinal) {
        updateOps.$inc.level6WithdrawCount = 1;
    } else {
        updateOps.$inc.withdrawsUsedAtLevel = 1;
    }
    if (!lockStatus) {
        updateOps.$set = {
            addressLockedAt: new Date(),
            lockedWithdrawMethod: method,
            lockedWithdrawAddress: details,
        };
    }

    const gate = await users.findOneAndUpdate(
        {
            _id: id,
            isBanned: { $ne: true },
            usdtBalance: { $gte: tier.usd },
            lastResetDate: today,
            adsWatchedToday: { $gte: WITHDRAW_ADS_REQUIRED },
            [tierCountField]: { $lt: tier.monthlyLimit },
            ...lockFilter,
            ...levelEqFilter,
        },
        updateOps,
        { returnDocument: 'after' }
    );

    if (!gate) {
        return res.status(409).json({
            ok: false, error: 'gate_failed',
            message: 'Could not process the withdrawal — your balance, ad progress, or level may have changed. Please refresh and try again.',
        });
    }

    const withdrawDoc = {
        userId: id,
        username: verified.user.username || null,
        method,
        details,
        tierId: tier.id,
        usdAmount: tier.usd,
        cashAmount: tier.usd,           // kept for frontend compatibility (history render)
        currency: methodConfig.currency,
        wtcAmount: 0,                   // ⚠️ no WTC deducted at this step anymore — conversion already happened earlier (handleConvert)
        adsRequired: WITHDRAW_ADS_REQUIRED,
        status: 'pending',
        createdAt: new Date(),
    };
    const inserted = await withdrawals.insertOne(withdrawDoc);

    if (ADMIN_ID) {
        tgSend(
            ADMIN_ID,
            `💸 <b>New Withdraw Request</b>\n\n👤 User: <code>${id}</code>${verified.user.username ? ' (@' + verified.user.username + ')' : ''}\n💰 Amount: $${tier.usd} via ${methodConfig.label}\n📮 Details: <code>${details}</code>\n🆔 Request: <code>${inserted.insertedId}</code>`
        ).catch(() => {});
    }

    return res.status(200).json({
        ok: true,
        withdrawId: inserted.insertedId,
        usdAmount: tier.usd,
        newUsdtBalance: gate.usdtBalance,
        status: 'pending',
    });
}

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'tiers') return handleTiers(req, res, db);
        if (action === 'history') return handleHistory(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    if (req.method === 'POST') {
        const { action } = req.body || {};
        if (action === 'convert') return handleConvert(req, res, db);
        if (!action || action === 'create') return handleCreate(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}
