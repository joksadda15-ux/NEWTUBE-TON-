// api/withdraw.js
// Handles withdrawal requests with server-side validation.
// First withdraw: needs 5 tasks + 20 ads today
// Next withdraws: needs only 20 ads today

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const BOT_TOKEN  = process.env.BOT_TOKEN;
const ADMIN_CHAT = process.env.ADMIN_TELEGRAM_ID;

function getAdminApp() {
    if (getApps().length > 0) return getApps()[0];
    return initializeApp({
        credential: cert({
            projectId:   process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
    });
}

async function sendTelegramMsg(chatId, text) {
    if (!BOT_TOKEN || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
        });
    } catch (e) {
        console.warn('[withdraw] Telegram notify failed:', e.message);
    }
}

function getTodayString() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, method, details, amount } = req.body || {};
    if (!userId || !method || !details || !amount) {
        return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    const diamondAmount = Math.floor(Number(amount));
    if (isNaN(diamondAmount) || diamondAmount <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_amount' });
    }

    try {
        const app = getAdminApp();
        const db  = getFirestore(app);
        const userRef = db.collection('users').doc(String(userId));

        const result = await db.runTransaction(async (t) => {
            const snap = await t.get(userRef);
            if (!snap.exists) throw { code: 'user_not_found' };

            const user  = snap.data();
            const today = getTodayString();

            if (user.isBanned) throw { code: 'banned' };

            // 1. One withdrawal per day
            if (user.lastWithdrawDate === today) throw { code: 'already_withdrawn_today' };

            // 2. Sufficient diamonds
            if ((user.diamondBalance || 0) < diamondAmount) throw { code: 'insufficient_diamonds' };

            // 3. Min amount check
            const MINS = { binance: 1000, tonkeeper: 500, bkash: 500 };
            const minAmt = MINS[method] || 1000;
            if (diamondAmount < minAmt) throw { code: 'below_minimum' };

            // 4. Ads check (always required: 20 ads today)
            const adsToday = user.adsWatchedToday || 0;
            if (adsToday < 20) throw { code: 'need_20_ads_today' };

            // 5. Tasks check (only for first withdrawal)
            const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
            if (isFirstWithdraw) {
                const tasksTotal = user.completedTasks?.length || 0;
                if (tasksTotal < 5) throw { code: 'need_5_tasks' };
            }

            // 6. Duplicate address check (same address used by another user)
            const dupSnap = await db.collection('withdrawals')
                .where('walletAddress', '==', details)
                .where('method', '==', method)
                .limit(1).get();
            if (!dupSnap.empty && dupSnap.docs[0].data().userId !== String(userId)) {
                throw { code: 'address_used_by_other' };
            }

            // 7. All checks passed — deduct diamonds + save withdrawal
            t.update(userRef, {
                diamondBalance:   FieldValue.increment(-diamondAmount),
                lastWithdrawDate: today,
                withdrawalCount:  FieldValue.increment(1),
            });

            const wRef = db.collection('withdrawals').doc();
            t.set(wRef, {
                userId:       String(userId),
                method,
                walletAddress: details,
                diamondAmount,
                status:       'pending',
                createdAt:    FieldValue.serverTimestamp(),
            });

            return {
                withdrawId: wRef.id,
                username:   user.telegramUsername || user.firstName || userId,
                chatId:     user.telegramId || userId,
            };
        });

        // Notify user
        await sendTelegramMsg(result.chatId,
            `✅ <b>Withdraw Request Received</b>\n\n` +
            `💎 Amount: <b>${diamondAmount.toLocaleString()} Diamonds</b>\n` +
            `💳 Method: <b>${method}</b>\n` +
            `⏳ Processing: 12–48 hours\n\n` +
            `ID: <code>${result.withdrawId}</code>`
        );

        // Notify admin
        await sendTelegramMsg(ADMIN_CHAT,
            `💸 <b>New Withdrawal Request</b>\n\n` +
            `👤 User: <b>${result.username}</b> (${userId})\n` +
            `💎 Amount: <b>${diamondAmount.toLocaleString()}</b>\n` +
            `💳 Method: <b>${method}</b>\n` +
            `📋 Address: <code>${details}</code>\n` +
            `🆔 ID: <code>${result.withdrawId}</code>`
        );

        return res.status(200).json({ ok: true, withdrawId: result.withdrawId });

    } catch (err) {
        if (err.code) {
            return res.status(200).json({ ok: false, error: err.code });
        }
        console.error('[withdraw]', err);
        return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
    }
}
