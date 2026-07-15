// api/withdraw.js — CONVERT-FIRST FLOW + TIERED WITHDRAW + ADDRESS LOCK
//
// ⚠️ MAJOR CHANGE: withdrawals no longer deduct WTC (or a fee) directly.
// Users must first CONVERT WTC into a USDT balance — that's where the 25%
// fee is now taken (see handleConvert). Withdrawals then spend from that
// already-fee-deducted `usdtBalance` with NO additional fee at this step.
// (A withdraw-time fee can be added back later if ever needed — not now.)
//
// Tier claim limits reset every 6 MONTHS (Bangladesh time, currentHalfYearBD())
// instead of every calendar month. A 30-day address lock still applies: the
// first method+address a user withdraws to becomes fixed for that long.
//
//   GET  /api/withdraw?action=history&initData=...
//   GET  /api/withdraw?action=tiers&initData=...              → tier list + eligibility (now against usdtBalance) + address-lock status
//   POST /api/withdraw   body: { initData, action:'convert', wtcAmount }
//   POST /api/withdraw   body: { initData, action:'create',  method, details, tierId }   (action defaults to 'create' if omitted)

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    WITHDRAW_METHODS, WITHDRAW_FEE_PERCENT, WITHDRAW_TIERS, WITHDRAW_ADDRESS_LOCK_DAYS, MIN_CONVERT_WTC,
    FIRST_WITHDRAW_MIN_TASKS, calcAdsRequired, todayBD, currentHalfYearBD, WTC_PER_USD,
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

// ⚠️ NEW semantics: `usd` is deducted straight from usdtBalance, no fee
// here (fee already happened at convert time) — so "net" is just `usd`.
function tierEligibility(tier, referralCount, claimsUsedThisMonth, usdtBalance) {
    return {
        id: tier.id,
        usd: tier.usd,
        netUsd: tier.usd, // kept for frontend compatibility — no fee at this step anymore
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
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const { counts } = await ensureTierPeriodReset(users, id, user);
    const usdtBalance = user.usdtBalance || 0;
    const tiers = WITHDRAW_TIERS.map(t => tierEligibility(t, user.referralCount || 0, counts[t.id] || 0, usdtBalance));
    const addressLock = getAddressLockStatus(user);
    return res.status(200).json({
        ok: true, tiers, usdtBalance, wtcBalance: user.wtcBalance || 0, addressLock,
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

    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    if (isFirstWithdraw && (user.completedTasks?.length || 0) < FIRST_WITHDRAW_MIN_TASKS) {
        return res.status(400).json({ ok: false, error: 'need_5_tasks' });
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

    // ── tier eligibility: lifetime referral threshold + claim limit ──
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

    // ⚠️ NEW: no more WTC/fee math here — ads-required is based directly on
    // the tier's USD value, and the balance check below is against usdtBalance.
    if ((user.usdtBalance || 0) < tier.usd) {
        return res.status(400).json({ ok: false, error: 'insufficient_balance', message: `You need $${tier.usd} in your converted balance. Convert more WTC first.` });
    }

    const adsRequired = calcAdsRequired(tier.usd);
    const adsToday = user.lastResetDate === today ? (user.adsWatchedToday || 0) : 0;
    if (adsToday < adsRequired) {
        return res.status(400).json({ ok: false, error: 'insufficient_ads', adsRequired, adsToday });
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

    // ⚠️ These wtcAmount/feeWtc fields are kept purely for display/compatibility
    // with the admin bot's existing message templates — no WTC is actually
    // deducted here anymore (that already happened at convert time). feeWtc is
    // 0 because the fee was already taken during conversion, not now.
    const result = await withdrawals.insertOne({
        userId: id,
        username: user.telegramUsername || 'N/A',
        method, details, tierId: tier.id,
        wtcAmount: Math.round(tier.usd * WTC_PER_USD), feeWtc: 0, netWtc: Math.round(tier.usd * WTC_PER_USD),
        cashAmount: tier.usd, currency: methodConfig.currency,
        adsRequired, status: 'pending', createdAt: new Date(),
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
