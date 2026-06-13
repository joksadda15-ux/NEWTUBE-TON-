// api/broadcast.js
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

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

async function sendTelegramMsg(botToken, chatId, text, replyMarkup = null) {
    try {
        const body = { chat_id: chatId, text, parse_mode: 'HTML' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
        });
        const data = await res.json();
        return data.ok;
    } catch {
        return false;
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { message, userIds, replyMarkup } = req.body || {};

    if (!message) return res.status(400).json({ error: 'message required' });
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0)
        return res.status(400).json({ error: 'userIds array required' });

    const botToken = process.env.BOT_TOKEN;
    if (!botToken) return res.status(500).json({ error: 'BOT_TOKEN not set' });

    // Process this chunk (max 300 per call to stay within Vercel 10s limit)
    const chunk = userIds.slice(0, 300);

    let sent = 0, failed = 0;

    for (const uid of chunk) {
        const ok = await sendTelegramMsg(botToken, uid, message, replyMarkup || null);
        if (ok) sent++; else failed++;
        // 30 msg/sec Telegram limit — 35ms delay = ~28/sec, safe
        await sleep(35);
    }

    // Save to Firestore if this is the last chunk (caller passes isLast flag)
    if (req.body.isLast) {
        try {
            const db = getFirestore(getAdminApp());
            await db.collection('broadcasts').add({
                message,
                sentCount:  (req.body.totalSent || 0) + sent,
                failCount:  (req.body.totalFailed || 0) + failed,
                totalUsers: req.body.grandTotal || chunk.length,
                sentAt:     new Date(),
            });
        } catch(e) {
            console.warn('Broadcast log failed:', e.message);
        }
    }

    return res.status(200).json({ ok: true, sent, failed, processed: chunk.length });
}
