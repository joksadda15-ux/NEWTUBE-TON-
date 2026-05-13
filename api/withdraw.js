// api/withdraw.js
// Processes Diamond withdrawal request:
//   1. Validates all requirements server-side
//   2. Deducts diamonds & saves request in Firestore (transaction)
//   3. Sends Telegram notification to USER (confirmation)
//   4. Sends Telegram notification to ADMIN (new request alert)
// POST /api/withdraw  body: { userId, method, details, amount }

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue }      from 'firebase-admin/firestore';

if (!getApps().length) {
    initializeApp({
        credential: cert({
            projectId:   process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
    });
}
const db = getFirestore();

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID  = process.env.ADMIN_TELEGRAM_ID; // Your personal Telegram user ID

const METHODS = {
    binance:   { label: 'Binance UID',       min: 100 },
    tonkeeper: { label: 'Tonkeeper Address', min: 50  },
    bkash:     { label: 'bKash Number',      min: 80  },
};

// Send a Telegram message (HTML parse mode)
async function sendTG(chatId, text) {
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
        });
    } catch (e) {
        console.error('[sendTG] failed:', e.message);
    }
}

// Convert diamond amount to readable string
function convertDisplay(method, amount) {
    if (method === 'binance')   return `${(amount / 1000).toFixed(4)} USDT`;
    if (method === 'tonkeeper') return `${(amount / 1000 * 0.45).toFixed(4)} TON`;
    if (method === 'bkash')     return `${(amount / 1000 * 120).toFixed(2)} BDT`;
    return '';
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    const { userId, method, details, amount } = req.body || {};

    if (!userId || !method || !details || !amount) {
        return res.status(400).json({ ok: false, error: 'missing_params' });
    }

    const methodCfg = METHODS[method];
    if (!methodCfg) {
        return res.status(400).json({ ok: false, error: 'invalid_method' });
    }

    const diamondAmt = parseFloat(amount);
    if (isNaN(diamondAmt) || diamondAmt < methodCfg.min) {
        return res.status(400).json({ ok: false, error: `min_${methodCfg.min}_diamonds` });
    }

    const today = new Date().toLocaleDateString('en-US', {
        timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
    });

    try {
        // ── Load user ──
        const userRef  = db.collection('users').doc(String(userId));
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
            return res.status(404).json({ ok: false, error: 'user_not_found' });
        }
        const user = userSnap.data();

        // ── Server-side guards ──
        if (user.lastWithdrawDate === today) {
            return res.status(400).json({ ok: false, error: 'already_withdrawn_today' });
        }
        if ((user.diamondBalance || 0) < diamondAmt) {
            return res.status(400).json({ ok: false, error: 'insufficient_diamonds' });
        }
        if ((user.completedTasks?.length || 0) < 5) {
            return res.status(400).json({ ok: false, error: 'need_5_tasks' });
        }
        if ((user.adsWatchedToday || 0) < 20) {
            return res.status(400).json({ ok: false, error: 'need_20_ads_today' });
        }

        // ── Duplicate address check ──
        const dupSnap = await db.collection('withdrawals')
            .where('details', '==', details)
            .limit(5)
            .get();
        let usedByOther = false;
        dupSnap.forEach(d => { if (d.data().userId !== String(userId)) usedByOther = true; });
        if (usedByOther) {
            return res.status(400).json({ ok: false, error: 'address_used_by_other' });
        }

        // ── Firestore transaction ──
        const converted  = convertDisplay(method, diamondAmt);
        const withdrawRef = db.collection('withdrawals').doc();

        await db.runTransaction(async t => {
            const freshUser = (await t.get(userRef)).data();
            if (freshUser.lastWithdrawDate === today)     throw new Error('already_withdrawn_today');
            if ((freshUser.diamondBalance || 0) < diamondAmt) throw new Error('insufficient_diamonds');

            t.set(withdrawRef, {
                userId:           String(userId),
                firstName:        user.firstName        || 'User',
                telegramUsername: user.telegramUsername || 'N/A',
                method,
                details,
                diamondAmount:    diamondAmt,
                convertedDisplay: converted,
                status:           'pending',
                createdAt:        FieldValue.serverTimestamp(),
            });
            t.update(userRef, {
                diamondBalance:   FieldValue.increment(-diamondAmt),
                withdrawalCount:  FieldValue.increment(1),
                lastWithdrawDate: today,
            });
        });

        // ── Telegram Notifications (non-blocking) ──
        const userName   = user.firstName || 'User';
        const userTgName = user.telegramUsername ? `@${user.telegramUsername}` : `ID: ${userId}`;

        const userMsg =
            `✅ <b>Withdrawal Request Received!</b>\n\n` +
            `💎 Amount: <b>${diamondAmt.toLocaleString()} Diamond</b>\n` +
            `💱 You will receive: <b>${converted}</b>\n` +
            `🏦 Method: <b>${methodCfg.label}</b>\n` +
            `📋 Details: <code>${details}</code>\n\n` +
            `⏳ Processing time: <b>12–48 hours</b>\n` +
            `📌 Status: <b>Pending ⏳</b>\n\n` +
            `Thank you for using NEWTUBE TON! 🚀`;

        const adminMsg =
            `🔔 <b>New Withdrawal Request!</b>\n\n` +
            `👤 User: <b>${userName}</b> (${userTgName})\n` +
            `🆔 UserID: <code>${userId}</code>\n` +
            `💎 Amount: <b>${diamondAmt.toLocaleString()} 💎</b>\n` +
            `💱 Converted: <b>${converted}</b>\n` +
            `🏦 Method: <b>${methodCfg.label}</b>\n` +
            `📋 Details: <code>${details}</code>\n` +
            `🗓 Date: ${today}\n\n` +
            `⚡ Please process via admin panel.`;

        // Send both (non-blocking)
        Promise.allSettled([
            sendTG(userId, userMsg),
            ADMIN_ID ? sendTG(ADMIN_ID, adminMsg) : Promise.resolve(),
        ]);

        return res.status(200).json({ ok: true, withdrawId: withdrawRef.id });

    } catch (err) {
        console.error('[withdraw] error:', err.message);
        if (['already_withdrawn_today', 'insufficient_diamonds'].includes(err.message)) {
            return res.status(400).json({ ok: false, error: err.message });
        }
        return res.status(500).json({ ok: false, error: 'server_error', details: err.message });
    }
        }
