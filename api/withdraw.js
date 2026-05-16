// api/withdraw.js
// Handles TWO actions:
//   action=exchange  → convert gold to diamond (client sends action:'exchange')
//   default          → withdrawal request

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const BOT_TOKEN       = process.env.BOT_TOKEN;
const ADMIN_CHAT      = process.env.ADMIN_TELEGRAM_ID;
const GOLD_PER_DIAMOND = 1000;

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
    } catch(e) {
        console.warn('[withdraw] Telegram notify failed:', e.message);
    }
}

function getTodayString() {
    return new Date().toISOString().slice(0, 10);
}

// ── EXCHANGE HANDLER ──
async function handleExchange(db, userId, goldAmount) {
    const gold = Math.floor(Number(goldAmount));
    if (isNaN(gold) || gold < 5000)  throw { code: 'below_minimum',    message: 'Minimum 5,000 Gold to convert.' };
    if (gold > 100000)               throw { code: 'above_maximum',    message: 'Maximum 100,000 Gold per exchange.' };

    const diamondOut = Math.floor(gold / GOLD_PER_DIAMOND);
    if (diamondOut < 1)              throw { code: 'insufficient_gold', message: 'Not enough Gold.' };

    const userRef = db.collection('users').doc(String(userId));

    await db.runTransaction(async (t) => {
        const snap = await t.get(userRef);
        if (!snap.exists)              throw { code: 'user_not_found',    message: 'User not found.' };
        const user = snap.data();
        if (user.isBanned)             throw { code: 'banned',            message: 'Account is banned.' };
        if ((user.goldBalance || 0) < gold) throw { code: 'insufficient_gold', message: 'Insufficient Gold balance.' };

        t.update(userRef, {
            goldBalance:    FieldValue.increment(-gold),
            diamondBalance: FieldValue.increment(diamondOut),
        });
    });

    return { ok: true, goldSpent: gold, diamondReceived: diamondOut };
}

// ── WITHDRAW HANDLER ──
async function handleWithdraw(db, body) {
    const { userId, method, details, amount } = body;
    if (!userId || !method || !details || !amount) {
        throw { code: 'missing_fields', message: 'Missing required fields.' };
    }

    const diamondAmount = Math.floor(Number(amount));
    if (isNaN(diamondAmount) || diamondAmount <= 0) {
        throw { code: 'invalid_amount', message: 'Invalid amount.' };
    }

    const userRef = db.collection('users').doc(String(userId));

    const result = await db.runTransaction(async (t) => {
        const snap = await t.get(userRef);
        if (!snap.exists) throw { code: 'user_not_found', message: 'User not found.' };
        const user  = snap.data();
        const today = getTodayString();

        if (user.isBanned)                          throw { code: 'banned',                  message: 'Account is banned.' };
        if (user.lastWithdrawDate === today)        throw { code: 'already_withdrawn_today', message: 'Already withdrawn today.' };
        if ((user.diamondBalance || 0) < diamondAmount) throw { code: 'insufficient_diamonds',  message: 'Insufficient Diamond balance.' };

        const MINS   = { binance: 1000, tonkeeper: 500, bkash: 500 };
        const minAmt = MINS[method] || 1000;
        if (diamondAmount < minAmt) throw { code: 'below_minimum', message: `Minimum ${minAmt} Diamonds for ${method}.` };

        const adsToday = user.adsWatchedToday || 0;
        if (adsToday < 20) throw { code: 'need_20_ads_today', message: `Watch 20 ads today. Done: ${adsToday}/20` };

        const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
        if (isFirstWithdraw) {
            const tasksTotal = user.completedTasks?.length || 0;
            if (tasksTotal < 5) throw { code: 'need_5_tasks', message: `Complete 5 tasks first. Done: ${tasksTotal}/5` };
        }

        t.update(userRef, {
            diamondBalance:   FieldValue.increment(-diamondAmount),
            lastWithdrawDate: today,
            withdrawalCount:  FieldValue.increment(1),
        });

        const wRef = db.collection('withdrawals').doc();
        t.set(wRef, {
            userId: String(userId),
            method,
            walletAddress: details,
            diamondAmount,
            status:    'pending',
            createdAt: FieldValue.serverTimestamp(),
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

    return { ok: true, withdrawId: result.withdrawId };
}

// ── MAIN HANDLER ──
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body   = req.body || {};
    const action = body.action || req.query?.action || 'withdraw';

    try {
        const app = getAdminApp();
        const db  = getFirestore(app);

        if (action === 'exchange') {
            const result = await handleExchange(db, body.userId, body.goldAmount);
            return res.status(200).json(result);
        } else {
            const result = await handleWithdraw(db, body);
            return res.status(200).json(result);
        }

    } catch (err) {
        if (err.code) {
            return res.status(200).json({ ok: false, error: err.code, message: err.message });
        }
        console.error('[withdraw]', err);
        return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
    }
        }
