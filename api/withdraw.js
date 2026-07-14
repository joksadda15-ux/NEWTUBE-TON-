// api/withdraw.js — TIERED WITHDRAW SYSTEM + ADDRESS LOCK
//
// ⚠️ Withdrawals are a fixed $ tier (WITHDRAW_TIERS in lib/constants.js),
// not a free-text WTC amount. Each tier has its own claim limit that now
// resets every 6 MONTHS (Bangladesh time, via currentHalfYearBD()) instead
// of every calendar month, and a lifetime referral-count threshold to
// unlock it (referrals are never "spent" — once you have enough, the tier
// stays unlocked). Ad-watch and task-completion requirements are unchanged.
//
// ⚠️ NEW — 30-day address lock: the first method+address a user withdraws
// to becomes their fixed payout destination for WITHDRAW_ADDRESS_LOCK_DAYS
// (30) days. Any withdraw attempt with a DIFFERENT method or address during
// that window is rejected with a clear "locked until" message. Once the
// lock expires, the next withdrawal sets a fresh lock to whatever
// method+address is used at that time. This stops an account (or a
// compromised one) from rapidly cycling payouts across many wallets.
//
// The balance check + deduction + tier-counter increment + address-lock
// set/refresh all happen in a single atomic findOneAndUpdate — a user
// firing off multiple requests at once can't double-spend, blow past a
// tier's limit, or slip past the lock in a race window.
//
//   GET  /api/withdraw?action=history&initData=...   → the user's withdraw history
//   GET  /api/withdraw?action=tiers&initData=...      → tier list + this user's eligibility for each + address-lock status
//   POST /api/withdraw   body: { initData, method, details, tierId }

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    WITHDRAW_METHODS, WITHDRAW_FEE_PERCENT, WITHDRAW_TIERS, WITHDRAW_ADDRESS_LOCK_DAYS,
    FIRST_WITHDRAW_MIN_TASKS, calcAdsRequired, todayBD, currentHalfYearBD, WTC_PER_USD,
} from '../lib/constants.js';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
const LOCK_MS = WITHDRAW_ADDRESS_LOCK_DAYS * 24 * 60 * 60 * 1000;

// Ensures the per-tier claim counters are reset if the 6-month period has
// rolled over since the user's last withdrawal. Returns the (possibly
// freshly-reset) tier-count map and the current period key.
// ⚠️ field name kept as "withdrawTierMonth" even though it now holds a
// half-year key (e.g. "2026-H2") — renaming the field isn't necessary
// (it's just an opaque string compared for equality) and keeps this diff
// minimal. Anyone with an old "MM/YYYY"-style value will simply get a
// one-time automatic reset on their next withdrawal, which is harmless.
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

// ── GET ?action=tiers — tier list + this user's eligibility for each + address-lock status ──
async function handleTiers(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const users = db.collection('users');
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const { counts } = await ensureTierPeriodReset(users, id, user);
    const tiers = WITHDRAW_TIERS.map(t => tierEligibility(t, user.referralCount || 0, counts[t.id] || 0));
    const addressLock = getAddressLockStatus(user);
    return res.status(200).json({ ok: true, tiers, wtcBalance: user.wtcBalance || 0, addressLock });
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

    // ── ⚠️ NEW: 30-day address lock ──
    const lockStatus = getAddressLockStatus(user);
    if (lockStatus && (lockStatus.method !== method || lockStatus.address !== details)) {
        return res.status(400).json({
            ok: false, error: 'address_locked',
            lockedMethod: lockStatus.method, lockedAddress: lockStatus.address, daysLeft: lockStatus.daysLeft,
            message: `Your withdraw address is locked to ${WITHDRAW_METHODS[lockStatus.method]?.label || lockStatus.method} (${lockStatus.address}) for ${lockStatus.daysLeft} more day(s).`,
        });
    }

    // ── tier eligibility: lifetime referral threshold (not consumed) + claim limit ──
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
    // ATOMIC GATE — balance check, once-per-day check, the tier's claim-limit
    // check, and the address-lock condition are all re-verified + applied in
    // one operation, with no race window between "check" and "deduct".
    // ══════════════════════════════════════════════════════════
    const tierCountField = `withdrawTierCounts.${tier.id}`;
    const lockFilter = lockStatus
        // already locked to this exact method+address — just proceed, don't touch the lock fields
        ? { lockedWithdrawMethod: method, lockedWithdrawAddress: details }
        // no active lock (first withdrawal, or previous lock expired) — filter just needs the
        // user doc to still not have an active lock at write time (re-checked via addressLockedAt)
        : { $or: [{ addressLockedAt: { $exists: false } }, { addressLockedAt: { $lt: new Date(Date.now() - LOCK_MS) } }] };

    const gate = await users.findOneAndUpdate(
        {
            _id: id,
            isBanned: { $ne: true },
            wtcBalance: { $gte: wtcAmount },
            lastWithdrawDate: { $ne: today },
            withdrawTierMonth: tierPeriod,
            $or: [
                { [tierCountField]: { $exists: false } },
                { [tierCountField]: { $lt: tier.monthlyLimit } },
            ],
            ...lockFilter,
        },
        {
            $inc: { wtcBalance: -wtcAmount, withdrawalCount: 1, [tierCountField]: 1 },
            $set: {
                lastWithdrawDate: today,
                // only (re)sets the lock when there wasn't already an active one — once locked,
                // it stays pointed at the same method+address until it naturally expires
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
        method, details, tierId: tier.id, wtcAmount, feeWtc,
        feePercent: WITHDRAW_FEE_PERCENT, netWtc,
        cashAmount: netCurrencyAmount, currency: methodConfig.currency,
        adsRequired, status: 'pending', createdAt: new Date(),
    });

    if (ADMIN_ID) {
        tgSend(ADMIN_ID,
            `💸 <b>Withdrawal Request</b>\n\n` +
            `👤 <code>${id}</code> (@${user.telegramUsername || '?'})\n` +
            `🎯 Tier: <b>$${tier.usd}</b> (${claimsUsed + 1}/${tier.monthlyLimit} this period)\n` +
            `💰 ${wtcAmount.toLocaleString()} WTC (fee ${feeWtc.toLocaleString()} WTC) → <b>${netCurrencyAmount.toFixed(4)} ${methodConfig.currency}</b>\n` +
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
