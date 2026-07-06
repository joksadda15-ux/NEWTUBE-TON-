// api/withdraw.js — SEASON 2 আপডেট + RACE-CONDITION FIX
//
// গুরুত্বপূর্ণ: balance check আর deduct একটাই atomic findOneAndUpdate-এ।
// filter-এর মধ্যেই শর্ত বসানো আছে (balance যথেষ্ট, আজ withdraw করা হয়নি, banned না) —
// MongoDB গ্যারান্টি দেয় শর্ত সত্য না থাকলে update হবেই না, তাই একই ইউজার
// একসাথে ২-৩টা withdraw request পাঠালেও মাত্র ১টা-ই সফল হতে পারবে।

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    WITHDRAW_METHODS, WITHDRAW_MIN_WTC, WITHDRAW_FEE_PERCENT,
    FIRST_WITHDRAW_MIN_TASKS, calcAdsRequired, todayBD,
} from '../lib/constants.js';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    try {
        // ── SECURITY FIX: এখন real money নড়াচড়া করে এই endpoint, তাই
        // initData verification সবচেয়ে জরুরি এখানেই — client-পাঠানো userId
        // আর বিশ্বাস করা হয় না।
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

        const { db } = await connectToDatabase();
        const users = db.collection('users');

        const today = await ensureDailyReset(users, id);

        // soft checks (clear error messages) — এগুলো এখনও একটা read দিয়ে করা হচ্ছে,
        // কিন্তু আসল balance-deduction নিচে atomic filter দিয়ে protected
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
        // ATOMIC GATE — এই একটা অপারেশনেই balance/once-per-day শর্ত যাচাই + deduct
        // হয়, কোনো race window ছাড়াই।
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
                `📅 ${new Date().toLocaleString()}`,
                { reply_markup: { inline_keyboard: [[
                    { text: '✅ Approve', callback_data: `wd_approve_${result.insertedId}` },
                    { text: '❌ Reject',  callback_data: `wd_reject_${result.insertedId}` },
                ]]}}
            ).catch((e) => console.error('admin notify failed:', e));
        }

        return res.status(200).json({ ok: true, withdrawalId: result.insertedId, netCurrencyAmount, feeWtc });
    } catch (err) {
        console.error('withdraw error:', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
                       }
