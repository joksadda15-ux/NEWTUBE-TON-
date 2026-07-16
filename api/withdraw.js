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
    FIRST_WITHDRAW_MIN_TASKS, WITHDRAW_ADS_REQUIRED, todayBD, currentHalfYearBD, WTC_PER_USD,
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

    // ⚠️ NEW — global (tier-independent) requirement status, for the
    // multi-step withdraw wizard's "Requirements" screen (ads progress bar,
    // lifetime task progress bar — matches the reference screenshot's UI).
    const adsToday = user.lastResetDate === today ? (user.adsWatchedToday || 0) : 0;
    const tasksHave = (user.completedTasks || []).length;
    const withdrawRequirements = {
        adsRequired: WITHDRAW_ADS_REQUIRED,
        adsWatchedToday: adsToday,
        adsMet: adsToday >= WITHDRAW_ADS_REQUIRED,
        tasksRequired: FIRST_WITHDRAW_MIN_TASKS,
        tasksHave,
        tasksMet: tasksHave >= FIRST_WITHDRAW_MIN_TASKS,
    };

    return res.status(200).json({
        ok: true, tiers, usdtBalance, wtcBalance: user.wtcBalance || 0, addressLock,
        withdrawRequirements,
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

    // ⚠️ CHANGED: was "only on the very first withdraw, need 5" — now a
    // LIFETIME gate re-checked on every request, threshold 10. Since
    // completedTasks only grows, once a user crosses 10 this always passes —
    // functionally still a "one-time" wall, just re-verified each time
    // instead of gated behind a withdrawalCount===0 flag.
    const tasksHave = (user.completedTasks || []).length;
    if (tasksHave < FIRST_WITHDRAW_MIN_TASKS) {
        return res.status(400).json({
            ok: false, error: 'need_5_tasks', // ⚠️ error code name kept as-is for frontend errorText() compatibility — semantics updated, code string unchanged
            tasksRequired: FIRST_WITHDRAW_MIN_TASKS, tasksHave,
            message: `Complete at least ${FIRST_WITHDRAW_MIN_TASKS} tasks before withdrawing (you have ${tasksHave}).`,
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

    const gate = await users.findOneAndUpdate(
        {
            _id: id,
            isBanned: { $ne: true },
            usdtBalance: { $gte: tier.usd },
            lastWithdrawDate: { $ne: today },
            lastResetDate: today,                              // ⚠️ NEW
            adsWatchedToday: { $gte: WITHDRAW_ADS_REQUIRED },   // ⚠️ NEW
            withdrawTierMonth: tierPeriod,
            $or: [
                { [tierCountField]: { $exists: false } },
                { [tierCountField]: { $lt: tier.monthlyLimit } },
            ],
            ...lockFilter,
        },
        {
            $inc: { usdtBalance: -tier.usd, withdrawalCount: 1, [tierCountField]: 1 },
            $set: {
                lastWithdrawDate: today,
                ...(!lockStatus ? { lockedWithdrawMethod: method, lockedWithdrawAddress: details, addressLockedAt: new Date() } : {}),
            },
        },
        { returnDocument: 'after' }
    );

    if (!gate) {
        return res.status(409).json({ ok: false, error: 'conflict_retry' });
    }

    const result = await withdrawals.insertOne({
        userId: id,
        username: user.telegramUsername || 'N/A',
        method, details, tierId: tier.id,
        wtcAmount: Math.round(tier.usd * WTC_PER_USD), feeWtc: 0, netWtc: Math.round(tier.usd * WTC_PER_USD),
        cashAmount: tier.usd, currency: methodConfig.currency,
        adsRequired: WITHDRAW_ADS_REQUIRED, // ⚠️ CHANGED — fixed value, not tier-dependent anymore
        status: 'pending', createdAt: new Date(),
    });

    if (ADMIN_ID) {
        tgSend(ADMIN_ID,
            `💸 <b>Withdrawal Request</b>\n\n` +
            `👤 <code>${id}</code> (@${user.telegramUsername || '?'})\n` +
            `🎯 Tier: <b>$${tier.usd}</b> (${claimsUsed + 1}/${tier.monthlyLimit} this period)\n` +
            `💰 <b>${tier.usd.toFixed(2)} ${methodConfig.currency}</b> (already fee-deducted at convert time — no fee here)\n` +
            `📤 Method: <b>${methodConfig.label}</b>\n` +
            `📍 Address: <code>${details}</code>${lockStatus ? '' : ' 🔒 (newly locked for 30 days)'}\n` +
            `📊 Total withdrawals so far: <b>${gate.withdrawalCount || 1}</b>\n` +
            `👥 Total referrals: <b>${user.referralCount || 0}</b>\n` +
            `📅 ${new Date().toLocaleString()}`,
            { reply_markup: { inline_keyboard: [[
                { text: '✅ Approve', callback_data: `wd_approve_${result.insertedId}` },
                { text: '❌ Reject',  callback_data: `wd_reject_${result.insertedId}` },
            ]]}}
        ).catch((e) => console.error('admin notify failed:', e));
    }

    return res.status(200).json({ ok: true, withdrawalId: result.insertedId, netCurrencyAmount: tier.usd, feeWtc: 0 });
}

export default async function handler(req, res) {
    try {
        const { db } = await connectToDatabase();

        if (req.method === 'GET') {
            const { action } = req.query;
            if (action === 'history') return handleHistory(req, res, db);
            if (action === 'tiers') return handleTiers(req, res, db);
            return res.status(400).json({ ok: false, error: 'unknown_action' });
        }

        if (req.method === 'POST') {
            const action = req.body?.action || 'create';
            if (action === 'convert') return handleConvert(req, res, db);
            if (action === 'create') return handleCreate(req, res, db);
            return res.status(400).json({ ok: false, error: 'unknown_action' });
        }

        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    } catch (err) {
        console.error('withdraw error:', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
        }
