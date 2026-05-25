// api/init.js
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const BOT_TOKEN       = process.env.BOT_TOKEN;
const ADMIN_TG_ID     = process.env.ADMIN_TELEGRAM_ID;
const REFERRAL_REWARD = 3500; // ← updated from 2000

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

async function sendTelegramMsg(chatId, text, replyMarkup = null) {
    if (!BOT_TOKEN || !chatId) return;
    try {
        const body = { chat_id: chatId, text, parse_mode: 'HTML' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
        });
    } catch(e) {
        console.warn('[init] Telegram send failed:', e.message);
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, firstName, username, referrerCode } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    if (!referrerCode || String(referrerCode) === String(userId)) {
        return res.status(200).json({ ok: true, skipped: true });
    }

    try {
        const app = getAdminApp();
        const db  = getFirestore(app);

        const referrerRef = db.collection('users').doc(String(referrerCode));
        const newUserRef  = db.collection('users').doc(String(userId));

        const [referrerSnap, newUserSnap] = await Promise.all([
            referrerRef.get(),
            newUserRef.get(),
        ]);

        if (!referrerSnap.exists) {
            return res.status(200).json({ ok: true, skipped: 'referrer_not_found' });
        }

        if (newUserSnap.exists && newUserSnap.data().referredBy) {
            return res.status(200).json({ ok: true, skipped: 'already_referred' });
        }

        const referrer      = referrerSnap.data();
        const newUserName   = firstName || 'A new friend';
        const newUserHandle = username ? `@${username}` : '';

        // Credit referrer + mark new user as referred
        const batch = db.batch();
        batch.update(referrerRef, {
            goldBalance:        FieldValue.increment(REFERRAL_REWARD),
            lifetimeGoldEarned: FieldValue.increment(REFERRAL_REWARD),
            referralCount:      FieldValue.increment(1),
            totalInvites:       FieldValue.increment(1),
        });
        if (newUserSnap.exists) {
            batch.update(newUserRef, { referredBy: String(referrerCode) });
        }
        await batch.commit();

        // ── Referrer notification with Open App button ──
        await sendTelegramMsg(
            referrerCode,
`✅🎁 <b>You have received ${REFERRAL_REWARD.toLocaleString()} Gold!</b>

👤 <b>${newUserName}</b> ${newUserHandle}
just joined NEWTUBE TON using your referral link!

💰 <b>+${REFERRAL_REWARD.toLocaleString()} 🪙 Gold</b> added to your account!

🔗 Keep inviting — earn <b>${REFERRAL_REWARD.toLocaleString()} Gold</b> per referral!`,
            {
                inline_keyboard: [[
                    { text: '🎮 Open NEWTUBE TON', url: 'http://t.me/NewTube12_bot/WatchTo_Earn' }
                ]]
            }
        );

        // ── Admin notification ──
        if (ADMIN_TG_ID) {
            await sendTelegramMsg(ADMIN_TG_ID,
`🆕 <b>New Referral!</b>

👤 New User: <b>${newUserName}</b> ${newUserHandle}
🆔 ID: <code>${userId}</code>
🔗 Referred by: <b>${referrer.firstName || 'Unknown'}</b> (<code>${referrerCode}</code>)
🪙 Credited: +${REFERRAL_REWARD.toLocaleString()} Gold`
            );
        }

        return res.status(200).json({ ok: true });

    } catch (err) {
        console.error('[init]', err);
        return res.status(500).json({ error: 'server_error', message: err.message });
    }
}
