// api/init.js
// Called when a new user joins via referral link.
// Credits 2000 Gold to the referrer + sends Telegram notification.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TG_ID     = process.env.ADMIN_TELEGRAM_ID;
const REFERRAL_REWARD = 2000;

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
            body: JSON.stringify({
                chat_id:    chatId,
                text:       text,
                parse_mode: 'HTML',
            }),
        });
    } catch {}
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, firstName, username, referrerCode } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!referrerCode || referrerCode === userId) return res.status(200).json({ ok: true, skipped: true });

    try {
        const app = getAdminApp();
        const db  = getFirestore(app);

        const referrerRef  = db.collection('users').doc(String(referrerCode));
        const referrerSnap = await referrerRef.get();
        if (!referrerSnap.exists) return res.status(200).json({ ok: true, skipped: 'referrer_not_found' });

        const referrer = referrerSnap.data();

        // Credit referrer gold
        await referrerRef.update({
            goldBalance:        FieldValue.increment(REFERRAL_REWARD),
            lifetimeGoldEarned: FieldValue.increment(REFERRAL_REWARD),
            referralCount:      FieldValue.increment(1),
            totalInvites:       FieldValue.increment(1),
        });

        // ── Referrer notification ──
        // referrerCode IS the Telegram user ID (document ID = telegram ID)
        const referrerTgId   = referrerCode;
        const newUserName    = firstName || 'A new friend';
        const newUserHandle  = username  ? `@${username}` : '';

        const referrerMsg =
`🎉 <b>You received a Referral Bonus!</b>

👤 <b>${newUserName}</b> ${newUserHandle}
just joined NEWTUBE TON using your referral link!

💰 Your Reward:
<b>+${REFERRAL_REWARD.toLocaleString()} 🪙 Gold</b> has been added to your account!

🔗 Keep inviting friends and earn <b>2,000 Gold</b> for each one!
💎 1,000 Gold = 1 Diamond | 1,000 Diamond = $1`;

        await sendTelegramMsg(referrerTgId, referrerMsg);

        // ── Admin notification ──
        if (ADMIN_TG_ID) {
            const adminMsg =
`🆕 <b>New Referral Join!</b>

👤 New User: <b>${newUserName}</b> ${newUserHandle}
🆔 ID: <code>${userId}</code>
🔗 Referred by: <code>${referrerCode}</code> (${referrer.firstName || 'Unknown'})
🪙 Referrer credited: +${REFERRAL_REWARD.toLocaleString()} Gold`;

            await sendTelegramMsg(ADMIN_TG_ID, adminMsg);
        }

        return res.status(200).json({ ok: true });

    } catch (err) {
        console.error('[init]', err);
        return res.status(500).json({ error: 'server_error', message: err.message });
    }
}
