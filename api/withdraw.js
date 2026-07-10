// api/withdraw.js — SEASON 2 UPDATE + RACE-CONDITION FIX + HISTORY (received/pending)
//
// Important: the balance check and deduction happen in a single atomic
// findOneAndUpdate. The conditions (sufficient balance, no withdrawal today,
// not banned) are all in the filter — MongoDB guarantees the update won't
// happen if the condition isn't met, so even if the same user fires off
// 2-3 withdraw requests at once, only one can succeed.
//
//   POST /api/withdraw                body: { initData, method, details, amount }
//   GET  /api/withdraw?action=history&initData=...   → the user's withdraw history

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    WITHDRAW_METHODS, WITHDRAW_MIN_WTC, WITHDRAW_FEE_PERCENT,
    FIRST_WITHDRAW_MIN_TASKS, calcAdsRequired, todayBD,
} from '../lib/constants.js';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

// ── GET ?action=history — the user's recent withdraw requests (pending/approved/rejected) ──
async function handleHistory(req, res, db) {
    // ⚠️ Explicitly no-store so no caching layer (CDN/edge) ever caches a
    // stale/empty response for this GET request.
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
    // ── SECURITY FIX: this endpoint moves real money, so initData
    // verification matters most right here — the client-supplied userId
    // is no longer trusted.
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const { method, details, amount } = req.body;
    if (!method || !details || amount === undefined) {
        return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    const methodConfig = WITHDRAW_METHODS[method];
    if (!methodConfig) {
        return res.status(400).json({ ok: false, error: 'invalid_method' });
    }

    const wtcAmount = Math.floor(Number(amount));
    const minWtc = WITHDRAW_MIN_WTC[method];
    if (isNaN(wtcAmount) || wtcAmount < minWtc) {
        return res.status(400).json({ ok: false, error: 'below_minimum', message: `Minimum ${minWtc.toLocaleString()} WTC required.` });
    }

    const users = db.collection('users');
    const today = await ensureDailyReset(users, id);

    // soft checks (for clear error messages) — these still use a plain read,
    // but the actual balance deduction below is protected by an atomic filter
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    if (isFirstWithdraw && (user.completedTasks?.length || 0) < FIRST_WITHDRAW_MIN_TASKS) {
        return res.status(400).json({ ok: false, error: 'need_5_tasks' });
    }

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
    // ATOMIC GATE — the balance/once-per-day condition check and the deduction
    // both happen in this single operation, with no race window.
    // ══════════════════════════════════════════════════════════
    const gate = await users.findOneAndUpdate(
        {
            _id: id,
            isBanned: { $ne: true },
            wtcBalance: { $gte: wtcAmount },
            lastWithdrawDate: { $ne: today },
        },
        {
            $inc: { wtcBalance: -wtcAmount, withdrawalCount: 1 },
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
        method, details, wtcAmount, feeWtc,
        feePercent: WITHDRAW_FEE_PERCENT, netWtc,
        cashAmount: netCurrencyAmount, currency: methodConfig.currency,
        adsRequired, status: 'pending', createdAt: new Date(),
    });

    if (ADMIN_ID) {
        tgSend(ADMIN_ID,
            `💸 <b>Withdrawal Request</b>\n\n` +
            `👤 <code>${id}</code> (@${user.telegramUsername || '?'})\n` +
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
            return res.status(400).json({ ok: false, error: 'unknown_action' });
        }

        if (req.method === 'POST') return handleCreate(req, res, db);

        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    } catch (err) {
        console.error('withdraw error:', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
        }
