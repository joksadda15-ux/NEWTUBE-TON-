// api/withdraw.js — TIERED WITHDRAW SYSTEM
//
// ⚠️ MAJOR CHANGE: withdrawals are no longer a free-text WTC amount — the
// user picks one of the fixed $ tiers in WITHDRAW_TIERS (lib/constants.js).
// Each tier has its own monthly claim limit (resets at the start of each
// calendar month, Bangladesh time) and a lifetime referral-count threshold
// to unlock it (referrals are never "spent" — once you have enough, the
// tier stays unlocked). Ad-watch and task-completion requirements are
// unchanged from before.
//
// The balance check + deduction + tier-counter increment all happen in a
// single atomic findOneAndUpdate, same race-condition-safe pattern as
// before — a user firing off multiple requests at once can't double-spend
// or blow past a tier's monthly limit.
//
//   GET  /api/withdraw?action=history&initData=...   → the user's withdraw history
//   GET  /api/withdraw?action=tiers&initData=...      → tier list + this user's eligibility for each
//   POST /api/withdraw   body: { initData, method, details, tierId }

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    WITHDRAW_METHODS, WITHDRAW_FEE_PERCENT, WITHDRAW_TIERS,
    FIRST_WITHDRAW_MIN_TASKS, calcAdsRequired, todayBD, currentMonthBD, WTC_PER_USD,
} from '../lib/constants.js';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

// Ensures the per-tier monthly claim counters are reset if the calendar
// month has rolled over since the user's last withdrawal. Returns the
// (possibly freshly-reset) tier-count map and the current month key.
async function ensureTierMonthReset(users, userId, user) {
    const month = currentMonthBD();
    if (user.withdrawTierMonth === month) {
        return { counts: user.withdrawTierCounts || {}, month };
    }
    await users.updateOne({ _id: userId }, { $set: { withdrawTierCounts: {}, withdrawTierMonth: month } });
    return { counts: {}, month };
}

function tierEligibility(tier, referralCount, claimsUsedThisMonth) {
    return {
        id: tier.id,
        usd: tier.usd,
        wtc: Math.round(tier.usd * WTC_PER_USD),
        netUsd: tier.usd * (1 - WITHDRAW_FEE_PERCENT / 100),
        monthlyLimit: tier.monthlyLimit,
        claimsUsed: claimsUsedThisMonth,
        claimsLeft: Math.max(0, tier.monthlyLimit - claimsUsedThisMonth),
        referralsRequired: tier.referralsRequired,
        referralsHave: referralCount,
        referralsMet: referralCount >= tier.referralsRequired,
        monthlyLimitReached: claimsUsedThisMonth >= tier.monthlyLimit,
    };
}

// ── GET ?action=tiers — tier list + this user's eligibility for each ──
async function handleTiers(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const users = db.collection('users');
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const { counts } = await ensureTierMonthReset(users, id, user);
    const tiers = WITHDRAW_TIERS.map(t => tierEligibility(t, user.referralCount || 0, counts[t.id] || 0));
    return res.status(200).json({ ok: true, tiers, wtcBalance: user.wtcBalance || 0 });
}

// ── GET ?action=history — the user's recent withdraw requests (pending/approved/rejected) ──
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

// ── POST — create a new withdraw request ──
async function handleCreate(req, res, db) {
    // ── SECURITY: this endpoint moves real money, so initData verification
    // matters most right here — the client-supplied userId is never trusted.
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

    // soft checks (for clear error messages) — the actual atomic deduction
    // below is still protected against races regardless of these reads
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    if (isFirstWithdraw && (user.completedTasks?.length || 0) < FIRST_WITHDRAW_MIN_TASKS) {
        return res.status(400).json({ ok: false, error: 'need_5_tasks' });
    }

    // ── tier eligibility: lifetime referral threshold (not consumed) + monthly claim limit ──
    const { counts: tierCounts, month: tierMonth } = await ensureTierMonthReset(users, id, user);
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
            message: `You've used all ${tier.monthlyLimit} claim(s) for this tier this month. It resets next month.`,
        });
    }

    const wtcAmount = Math.round(tier.usd * WTC_PER_USD);

    const grossCurrencyAmount = methodConfig.wtcToCurrency(wtcAmount);
    const adsRequired = calcAdsRequired(grossCurrencyAmount);
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

    const feeWtc = Math.floor(wtcAmount * (WITHDRAW_FEE_PERCENT / 100));
    const netWtc = wtcAmount - feeWtc;
    const netCurrencyAmount = methodConfig.wtcToCurrency(netWtc);

    // ══════════════════════════════════════════════════════════
    // ATOMIC GATE — balance check, once-per-day check, and the tier's
    // monthly-limit check all re-verified + applied in one operation, with
    // no race window between "check" and "deduct".
    // ══════════════════════════════════════════════════════════
    const tierCountField = `withdrawTierCounts.${tier.id}`;
    const gate = await users.findOneAndUpdate(
        {
            _id: id,
            isBanned: { $ne: true },
            wtcBalance: { $gte: wtcAmount },
            lastWithdrawDate: { $ne: today },
            withdrawTierMonth: tierMonth,
            $or: [
                { [tierCountField]: { $exists: false } },
                { [tierCountField]: { $lt: tier.monthlyLimit } },
            ],
        },
        {
            $inc: { wtcBalance: -wtcAmount, withdrawalCount: 1, [tierCountField]: 1 },
            $set: { lastWithdrawDate: today },
        },
        { returnDocument: 'after' }
    );

    if (!gate) {
        return res.status(409).json({ ok: false, error: 'conflict_retry' });
    }

    const result = await withdrawals.insertOne({
        userId: id,
        username: user.telegramUsername || 'N/A',
        method, details, tierId: tier.id, wtcAmount, feeWtc,
        feePercent: WITHDRAW_FEE_PERCENT, netWtc,
        cashAmount: netCurrencyAmount, currency: methodConfig.currency,
        adsRequired, status: 'pending', createdAt: new Date(),
    });

    if (ADMIN_ID) {
        tgSend(ADMIN_ID,
            `💸 <b>Withdrawal Request</b>\n\n` +
            `👤 <code>${id}</code> (@${user.telegramUsername || '?'})\n` +
            `🎯 Tier: <b>$${tier.usd}</b> (${claimsUsed + 1}/${tier.monthlyLimit} this month)\n` +
            `💰 ${wtcAmount.toLocaleString()} WTC (fee ${feeWtc.toLocaleString()} WTC) → <b>${netCurrencyAmount.toFixed(4)} ${methodConfig.currency}</b>\n` +
            `📤 Method: <b>${methodConfig.label}</b>\n` +
            `📍 Address: <code>${details}</code>\n` +
            `📊 Total withdrawals so far: <b>${gate.withdrawalCount || 1}</b>\n` +
            `👥 Total referrals: <b>${user.referralCount || 0}</b>\n` +
            `📅 ${new Date().toLocaleString()}`,
            { reply_markup: { inline_keyboard: [[
                { text: '✅ Approve', callback_data: `wd_approve_${result.insertedId}` },
                { text: '❌ Reject',  callback_data: `wd_reject_${result.insertedId}` },
            ]]}}
        ).catch((e) => console.error('admin notify failed:', e));
    }

    return res.status(200).json({ ok: true, withdrawalId: result.insertedId, netCurrencyAmount, feeWtc });
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

        if (req.method === 'POST') return handleCreate(req, res, db);

        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    } catch (err) {
        console.error('withdraw error:', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
        }
