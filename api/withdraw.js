// api/withdraw.js
// Handles THREE actions:
//   action=exchange   → convert gold to diamond
//   action=milestone  → claim referral milestone reward
//   default           → withdrawal request

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const BOT_TOKEN        = process.env.BOT_TOKEN;
const ADMIN_CHAT       = process.env.ADMIN_TELEGRAM_ID;
const GOLD_PER_DIAMOND = 1000;

// ── WITHDRAW CONFIG ──
// Min Diamond amounts and conversion rates
// IMPORTANT: Keep min values in sync with WITHDRAW_METHODS in index.html
const WITHDRAW_CONFIG = {
    binance:   { min: 100,  rate: 1/1000,         unit: 'USDT' },   // 1,000 💎 = 1 USDT
    tonkeeper: { min: 50,   rate: 0.45/1000,      unit: 'TON'  },   // 1,000 💎 = 0.45 TON
    bkash:     { min: 80,   rate: 120/1000,       unit: 'BDT'  },   // 1,000 💎 = 120 BDT
};

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

// ── EVENT CLAIM HANDLER ──
const VALID_EVENT_REWARDS = {
    daily_ads20: 500, daily_video1h: 500, daily_task3: 300, daily_invite1: 500,
    weekly_invite5: 3000, weekly_invite10: 7000,
};

async function handleEventClaim(db, userId, eventId, reward) {
    const expectedReward = VALID_EVENT_REWARDS[eventId];
    if (!expectedReward || expectedReward !== reward) throw { code: 'invalid_event', message: 'Invalid event.' };

    const userRef = db.collection('users').doc(String(userId));
    await db.runTransaction(async (t) => {
        const snap = await t.get(userRef);
        if (!snap.exists) throw { code: 'user_not_found', message: 'User not found.' };
        const user = snap.data();
        if (user.isBanned) throw { code: 'banned', message: 'Account is banned.' };
        t.update(userRef, {
            goldBalance:        FieldValue.increment(expectedReward),
            lifetimeGoldEarned: FieldValue.increment(expectedReward),
        });
    });
    return { ok: true, reward: expectedReward };
}

// ── MILESTONE HANDLER ──
const VALID_MILESTONES = { 5:2000, 10:6000, 15:10000, 20:15000, 30:20000, 50:45000, 100:100000, 200:250000, 500:1000000 };

async function handleMilestone(db, userId, refers) {
    const refCount = parseInt(refers);
    const expectedReward = VALID_MILESTONES[refCount];
    if (!expectedReward) throw { code: 'invalid_milestone', message: 'Invalid milestone.' };

    const userRef = db.collection('users').doc(String(userId));
    const reward  = await db.runTransaction(async (t) => {
        const snap = await t.get(userRef);
        if (!snap.exists) throw { code: 'user_not_found', message: 'User not found.' };
        const user = snap.data();
        if (user.isBanned) throw { code: 'banned', message: 'Account is banned.' };
        if ((user.claimedMilestones || []).includes(refCount)) throw { code: 'already_claimed', message: 'Already claimed.' };
        if ((user.totalInvites || 0) < refCount) throw { code: 'not_enough_invites', message: `Need ${refCount} invites. You have ${user.totalInvites || 0}.` };
        t.update(userRef, {
            goldBalance:        FieldValue.increment(expectedReward),
            lifetimeGoldEarned: FieldValue.increment(expectedReward),
            claimedMilestones:  FieldValue.arrayUnion(refCount),
        });
        return expectedReward;
    });
    return { ok: true, reward };
}

// ── EXCHANGE HANDLER ──
async function handleExchange(db, userId, goldAmount) {
    const gold = Math.floor(Number(goldAmount));
    if (isNaN(gold) || gold < 5000)  throw { code: 'below_minimum',    message: 'Minimum 5,000 Gold to convert.' };
    if (gold > 100000)               throw { code: 'above_maximum',     message: 'Maximum 100,000 Gold per exchange.' };

    const diamondOut = Math.floor(gold / GOLD_PER_DIAMOND);
    if (diamondOut < 1)              throw { code: 'insufficient_gold', message: 'Not enough Gold.' };

    const userRef = db.collection('users').doc(String(userId));

    await db.runTransaction(async (t) => {
        const snap = await t.get(userRef);
        if (!snap.exists)                   throw { code: 'user_not_found',    message: 'User not found.' };
        const user = snap.data();
        if (user.isBanned)                  throw { code: 'banned',            message: 'Account is banned.' };
        if ((user.goldBalance || 0) < gold) throw { code: 'insufficient_gold', message: 'Insufficient Gold balance.' };

        t.update(userRef, {
            goldBalance:    FieldValue.increment(-gold),
            diamondBalance: FieldValue.increment(diamondOut),
        });
    });

    return { ok: true, goldSpent: gold, diamondReceived: diamondOut };
}

// ── APPROVE HANDLER ──
async function handleApprove(db, withdrawalId, adminSecret) {
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
        throw { code: 'unauthorized', message: 'Invalid admin secret.' };
    }
    if (!withdrawalId) throw { code: 'missing_fields', message: 'Missing withdrawalId.' };

    const wRef   = db.collection('withdrawals').doc(withdrawalId);
    const wSnap  = await wRef.get();
    if (!wSnap.exists) throw { code: 'not_found', message: 'Withdrawal not found.' };

    const wd = wSnap.data();
    if (wd.status !== 'pending') throw { code: 'already_processed', message: `Already ${wd.status}.` };

    await wRef.update({ status: 'approved', processedAt: FieldValue.serverTimestamp() });

    // Notify user
    const userSnap = await db.collection('users').doc(String(wd.userId)).get();
    const user     = userSnap.exists ? userSnap.data() : {};
    const chatId   = user.telegramId || wd.userId;

    await sendTelegramMsg(chatId,
        `✅ <b>Withdrawal Approved!</b>\n\n` +
        `💎 Amount: <b>${wd.diamondAmount?.toLocaleString()} Diamonds</b>\n` +
        `💳 Method: <b>${wd.method}</b>\n` +
        `📋 Address: <code>${wd.walletAddress}</code>\n\n` +
        `💸 Your payment has been sent. Thank you!`
    );

    return { ok: true, message: 'Approved and user notified.' };
}

// ── REJECT HANDLER ──
async function handleReject(db, withdrawalId, adminSecret) {
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
        throw { code: 'unauthorized', message: 'Invalid admin secret.' };
    }
    if (!withdrawalId) throw { code: 'missing_fields', message: 'Missing withdrawalId.' };

    const wRef  = db.collection('withdrawals').doc(withdrawalId);
    const wSnap = await wRef.get();
    if (!wSnap.exists) throw { code: 'not_found', message: 'Withdrawal not found.' };

    const wd = wSnap.data();
    if (wd.status !== 'pending') throw { code: 'already_processed', message: `Already ${wd.status}.` };

    const userRef = db.collection('users').doc(String(wd.userId));

    await db.runTransaction(async (t) => {
        // Refund diamonds
        t.update(userRef, {
            diamondBalance:  FieldValue.increment(wd.diamondAmount),
            lastWithdrawDate: null,
            withdrawalCount: FieldValue.increment(-1),
        });
        t.update(wRef, { status: 'rejected', processedAt: FieldValue.serverTimestamp() });
    });

    // Notify user
    const userSnap = await userRef.get();
    const user     = userSnap.exists ? userSnap.data() : {};
    const chatId   = user.telegramId || wd.userId;

    await sendTelegramMsg(chatId,
        `❌ <b>Withdrawal Rejected</b>\n\n` +
        `💎 <b>${wd.diamondAmount?.toLocaleString()} Diamonds</b> have been refunded to your account.\n` +
        `💳 Method: <b>${wd.method}</b>\n\n` +
        `Please try again or contact support.`
    );

    return { ok: true, message: 'Rejected, diamonds refunded, user notified.' };
}

// ── WITHDRAW HANDLER ──
async function handleWithdraw(db, body) {
    const { userId, method, details, amount } = body;
    if (!userId || !method || !details || !amount) {
        throw { code: 'missing_fields', message: 'Missing required fields.' };
    }

    const cfg = WITHDRAW_CONFIG[method];
    if (!cfg) throw { code: 'invalid_method', message: 'Invalid withdrawal method.' };

    const diamondAmount = Math.floor(Number(amount));
    if (isNaN(diamondAmount) || diamondAmount <= 0) {
        throw { code: 'invalid_amount', message: 'Invalid amount.' };
    }

    // Check minimum BEFORE hitting Firestore
    if (diamondAmount < cfg.min) {
        throw { code: 'below_minimum', message: `Minimum ${cfg.min} Diamonds for ${method}.` };
    }

    // Calculate converted currency value for notification
    const convertedValue = (diamondAmount * cfg.rate).toFixed(method === 'binance' ? 4 : method === 'tonkeeper' ? 4 : 2);

    const userRef = db.collection('users').doc(String(userId));

    const result = await db.runTransaction(async (t) => {
        const snap = await t.get(userRef);
        if (!snap.exists) throw { code: 'user_not_found', message: 'User not found.' };
        const user  = snap.data();
        const today = getTodayString();

        if (user.isBanned)                               throw { code: 'banned',                 message: 'Account is banned.' };
        if (user.lastWithdrawDate === today)             throw { code: 'already_withdrawn_today', message: 'Already withdrawn today.' };
        if ((user.diamondBalance || 0) < diamondAmount) throw { code: 'insufficient_diamonds',   message: 'Insufficient Diamond balance.' };

        const adsToday = user.adsWatchedToday || 0;
        if (adsToday < 5) throw { code: 'need_20_ads_today', message: `Watch 5 ads today. Done: ${adsToday}/5` };

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
            convertedValue: `${convertedValue} ${cfg.unit}`,
            status:    'pending',
            createdAt: FieldValue.serverTimestamp(),
        });

        return {
            withdrawId:     wRef.id,
            username:       user.telegramUsername || user.firstName || userId,
            chatId:         user.telegramId || userId,
            convertedValue,
            unit:           cfg.unit,
        };
    });

    // Notify user
    await sendTelegramMsg(result.chatId,
        `✅ <b>Withdraw Request Received</b>\n\n` +
        `💎 Amount: <b>${diamondAmount.toLocaleString()} Diamonds</b>\n` +
        `💱 Value: <b>${result.convertedValue} ${result.unit}</b>\n` +
        `💳 Method: <b>${method}</b>\n` +
        `⏳ Processing: 12–48 hours\n\n` +
        `ID: <code>${result.withdrawId}</code>`
    );

    // Notify admin
    await sendTelegramMsg(ADMIN_CHAT,
        `💸 <b>New Withdrawal Request</b>\n\n` +
        `👤 User: <b>${result.username}</b> (${userId})\n` +
        `💎 Amount: <b>${diamondAmount.toLocaleString()}</b>\n` +
        `💱 Value: <b>${result.convertedValue} ${result.unit}</b>\n` +
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
        } else if (action === 'eventClaim') {
            const result = await handleEventClaim(db, body.userId, body.eventId, body.reward);
            return res.status(200).json(result);
        } else if (action === 'milestone') {
            const result = await handleMilestone(db, body.userId, body.refers);
            return res.status(200).json(result);
        } else if (action === 'approve') {
            const result = await handleApprove(db, body.withdrawalId, body.adminSecret);
            return res.status(200).json(result);
        } else if (action === 'reject') {
            const result = await handleReject(db, body.withdrawalId, body.adminSecret);
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
