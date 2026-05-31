// api/withdraw.js
// Handles: exchange, milestone, eventClaim (with server verification), approve, reject, withdraw

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const BOT_TOKEN        = process.env.BOT_TOKEN;
const ADMIN_CHAT       = process.env.ADMIN_TELEGRAM_ID;
const GOLD_PER_DIAMOND = 1000;

const WITHDRAW_CONFIG = {
    binance:   { min: 100, rate: 1/1000,    unit: 'USDT' },
    tonkeeper: { min: 50,  rate: 0.45/1000, unit: 'TON'  },
    bkash:     { min: 80,  rate: 120/1000,  unit: 'BDT'  },
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
    } catch(e) { console.warn('[withdraw] TG:', e.message); }
}

function getTodayString() { return new Date().toISOString().slice(0, 10); }

// ── EVENT CLAIM — server-side activity verification ──
const VALID_EVENT_DEFS = {
    daily_ads20:     { reward: 500,  target: 20, field: 'adsWatchedToday'     },
    daily_video1h:   { reward: 500,  target: 60, field: 'videoMinutesToday'   },
    daily_task3:     { reward: 300,  target: 3,  field: 'tasksCompletedToday' },
    daily_invite1:   { reward: 500,  target: 1,  field: 'dailyInviteCount'    },
    weekly_invite5:  { reward: 3000, target: 5,  field: 'weeklyInviteCount'   },
    weekly_invite10: { reward: 7000, target: 10, field: 'weeklyInviteCount'   },
};

async function handleEventClaim(db, userId, eventId, reward) {
    const evDef = VALID_EVENT_DEFS[eventId];
    if (!evDef) throw { code: 'invalid_event', message: 'Invalid event.' };
    if (evDef.reward !== reward) throw { code: 'invalid_reward', message: 'Reward mismatch.' };

    const userRef = db.collection('users').doc(String(userId));
    const snap    = await userRef.get();
    if (!snap.exists) throw { code: 'user_not_found', message: 'User not found.' };
    const user = snap.data();
    if (user.isBanned) throw { code: 'banned', message: 'Account is banned.' };

    // Check already claimed today
    const today      = getTodayString();
    const claimedKey = `claimed_${eventId}_${today}`;
    if (user[claimedKey]) throw { code: 'already_claimed', message: 'Already claimed today.' };

    // ── Server-side progress verification ──
    let serverProgress = 0;
    if      (evDef.field === 'adsWatchedToday')     serverProgress = user.adsWatchedToday     || 0;
    else if (evDef.field === 'tasksCompletedToday') serverProgress = user.tasksCompletedToday  || 0;
    else if (evDef.field === 'dailyInviteCount')    serverProgress = user.dailyInviteCount     || 0;
    else if (evDef.field === 'weeklyInviteCount')   serverProgress = user.weeklyInviteCount    || 0;
    else if (evDef.field === 'videoMinutesToday')
        serverProgress = Math.floor((user.dailyVideoMined || 0) / 500 * 60);

    if (serverProgress < evDef.target) {
        throw {
            code: 'insufficient_progress',
            message: `Progress: ${serverProgress}/${evDef.target}. Complete the activity first.`
        };
    }

    await userRef.update({
        goldBalance:        FieldValue.increment(evDef.reward),
        lifetimeGoldEarned: FieldValue.increment(evDef.reward),
        [claimedKey]:       true,
    });

    return { ok: true, reward: evDef.reward };
}

// ── MILESTONE HANDLER ──
const VALID_MILESTONES = { 5:2000,10:6000,15:10000,20:15000,30:20000,50:45000,100:100000,200:250000,500:1000000 };

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
    if (isNaN(gold) || gold < 5000) throw { code: 'below_minimum',    message: 'Minimum 5,000 Gold to convert.' };
    if (gold > 100000)              throw { code: 'above_maximum',     message: 'Maximum 100,000 Gold per exchange.' };
    const diamondOut = Math.floor(gold / GOLD_PER_DIAMOND);
    if (diamondOut < 1)             throw { code: 'insufficient_gold', message: 'Not enough Gold.' };

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
async function verifyAdminToken(adminToken) {
    if (!adminToken) throw { code: 'unauthorized', message: 'Missing admin token.' };
    const { getAuth } = await import('firebase-admin/auth');
    const decoded = await getAuth().verifyIdToken(adminToken);
    if (decoded.uid !== '6Mmtx15v09fxM22R8Sg2x9vYjtG3') throw { code: 'unauthorized', message: 'Not admin account.' };
}

async function handleApprove(db, withdrawalId, adminToken) {
    await verifyAdminToken(adminToken);
    if (!withdrawalId) throw { code: 'missing_fields', message: 'Missing withdrawalId.' };
    const wRef  = db.collection('withdrawals').doc(withdrawalId);
    const wSnap = await wRef.get();
    if (!wSnap.exists) throw { code: 'not_found', message: 'Withdrawal not found.' };
    const wd = wSnap.data();
    if (wd.status !== 'pending') throw { code: 'already_processed', message: `Already ${wd.status}.` };
    await wRef.update({ status: 'approved', processedAt: FieldValue.serverTimestamp() });
    const userSnap = await db.collection('users').doc(String(wd.userId)).get();
    const chatId   = userSnap.exists ? (userSnap.data().telegramId || wd.userId) : wd.userId;
    await sendTelegramMsg(chatId,
        `✅ <b>Withdrawal Approved!</b>\n\n💎 Amount: <b>${wd.diamondAmount?.toLocaleString()} Diamonds</b>\n💳 Method: <b>${wd.method}</b>\n📋 Address: <code>${wd.walletAddress}</code>\n\n💸 Your payment has been sent. Thank you!`
    );
    return { ok: true, message: 'Approved and user notified.' };
}

// ── REJECT HANDLER ──
async function handleReject(db, withdrawalId, adminToken) {
    await verifyAdminToken(adminToken);
    if (!withdrawalId) throw { code: 'missing_fields', message: 'Missing withdrawalId.' };
    const wRef  = db.collection('withdrawals').doc(withdrawalId);
    const wSnap = await wRef.get();
    if (!wSnap.exists) throw { code: 'not_found', message: 'Withdrawal not found.' };
    const wd = wSnap.data();
    if (wd.status !== 'pending') throw { code: 'already_processed', message: `Already ${wd.status}.` };
    const userRef = db.collection('users').doc(String(wd.userId));
    await db.runTransaction(async (t) => {
        t.update(userRef, {
            diamondBalance:   FieldValue.increment(wd.diamondAmount),
            lastWithdrawDate: null,
            withdrawalCount:  FieldValue.increment(-1),
        });
        t.update(wRef, { status: 'rejected', processedAt: FieldValue.serverTimestamp() });
    });
    const userSnap = await userRef.get();
    const chatId   = userSnap.exists ? (userSnap.data().telegramId || wd.userId) : wd.userId;
    await sendTelegramMsg(chatId,
        `❌ <b>Withdrawal Rejected</b>\n\n💎 <b>${wd.diamondAmount?.toLocaleString()} Diamonds</b> refunded to your account.\n💳 Method: <b>${wd.method}</b>\n\nPlease try again or contact support.`
    );
    return { ok: true, message: 'Rejected, diamonds refunded, user notified.' };
}

// ── WITHDRAW HANDLER ──
async function handleWithdraw(db, body) {
    const { userId, method, details, amount } = body;
    if (!userId || !method || !details || !amount) throw { code: 'missing_fields', message: 'Missing required fields.' };

    const cfg = WITHDRAW_CONFIG[method];
    if (!cfg) throw { code: 'invalid_method', message: 'Invalid withdrawal method.' };

    const diamondAmount = Math.floor(Number(amount));
    if (isNaN(diamondAmount) || diamondAmount <= 0) throw { code: 'invalid_amount', message: 'Invalid amount.' };
    if (diamondAmount < cfg.min) throw { code: 'below_minimum', message: `Minimum ${cfg.min} Diamonds for ${method}.` };

    const convertedValue = (diamondAmount * cfg.rate).toFixed(method === 'bkash' ? 2 : 4);
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
        if (isFirstWithdraw && (user.completedTasks?.length || 0) < 5) {
            throw { code: 'need_5_tasks', message: `Complete 5 tasks first. Done: ${user.completedTasks?.length || 0}/5` };
        }

        t.update(userRef, {
            diamondBalance:   FieldValue.increment(-diamondAmount),
            lastWithdrawDate: today,
            withdrawalCount:  FieldValue.increment(1),
        });
        const wRef = db.collection('withdrawals').doc();
        t.set(wRef, {
            userId: String(userId), method, walletAddress: details,
            diamondAmount, convertedValue: `${convertedValue} ${cfg.unit}`,
            status: 'pending', createdAt: FieldValue.serverTimestamp(),
        });
        return {
            withdrawId: wRef.id,
            username:   user.telegramUsername || user.firstName || userId,
            chatId:     user.telegramId || userId,
            convertedValue, unit: cfg.unit,
        };
    });

    await sendTelegramMsg(result.chatId,
        `✅ <b>Withdraw Request Received</b>\n\n💎 Amount: <b>${diamondAmount.toLocaleString()} Diamonds</b>\n💱 Value: <b>${result.convertedValue} ${result.unit}</b>\n💳 Method: <b>${method}</b>\n⏳ Processing: 12–48 hours\n\nID: <code>${result.withdrawId}</code>`
    );
    await sendTelegramMsg(ADMIN_CHAT,
        `💸 <b>New Withdrawal Request</b>\n\n👤 User: <b>${result.username}</b> (${userId})\n💎 Amount: <b>${diamondAmount.toLocaleString()}</b>\n💱 Value: <b>${result.convertedValue} ${result.unit}</b>\n💳 Method: <b>${method}</b>\n📋 Address: <code>${details}</code>\n🆔 ID: <code>${result.withdrawId}</code>`
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

        if      (action === 'exchange')   return res.status(200).json(await handleExchange(db, body.userId, body.goldAmount));
        else if (action === 'eventClaim') return res.status(200).json(await handleEventClaim(db, body.userId, body.eventId, body.reward));
        else if (action === 'milestone')  return res.status(200).json(await handleMilestone(db, body.userId, body.refers));
        else if (action === 'approve')    return res.status(200).json(await handleApprove(db, body.withdrawalId, body.adminToken));
        else if (action === 'reject')     return res.status(200).json(await handleReject(db, body.withdrawalId, body.adminToken));
        else                              return res.status(200).json(await handleWithdraw(db, body));

    } catch (err) {
        if (err.code) return res.status(200).json({ ok: false, error: err.code, message: err.message });
        console.error('[withdraw]', err);
        return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
    }
    }
