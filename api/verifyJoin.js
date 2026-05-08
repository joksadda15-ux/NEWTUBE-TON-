// api/verifyJoin.js
// GET  /api/verifyJoin?userId=123
// POST /api/verifyJoin  { userId }
//
// Checks if user has joined the required Telegram channel & group.

const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

const BOT_TOKEN        = process.env.BOT_TOKEN;
const OFFICIAL_CHANNEL = process.env.CHANNEL_ID  || '@NEEWTON_OFFICIAL';
const OFFICIAL_GROUP   = process.env.GROUP_ID    || '@newTon_Gc';

module.exports = async function handler(req, res) {
    if (handleCors(req, res)) return;

    const userId = req.method === 'POST'
        ? (req.body?.userId)
        : (req.query?.userId || req.query?.userId);

    // Also support /api/checkJoin route
    if (!userId) {
        return res.status(400).json({ ok: false, error: 'userId required' });
    }

    if (!BOT_TOKEN) {
        console.error('BOT_TOKEN not set');
        // Don't block user if token missing
        return res.status(200).json({ ok: true, joined: true, error: 'BOT_TOKEN not configured' });
    }

    try {
        const [chanOk, groupOk] = await Promise.all([
            checkMember(userId, OFFICIAL_CHANNEL),
            checkMember(userId, OFFICIAL_GROUP),
        ]);

        const joined = chanOk && groupOk;

        if (joined) {
            // Mark verified in Firestore
            try {
                const db = getDb();
                await db.collection('users').doc(String(userId)).update({
                    channelVerified: true
                });
            } catch(e) { /* ignore */ }
        }

        return res.status(200).json({
            ok: true,
            joined,
            chanOk,
            groupOk,
        });

    } catch (err) {
        console.error('verifyJoin error:', err);
        // On unexpected error, don't block user
        return res.status(200).json({ ok: false, joined: false, error: err.message });
    }
};

async function checkMember(userId, chatId) {
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) {
            console.error('Telegram API HTTP error:', resp.status, chatId);
            return false;
        }
        const data = await resp.json();
        if (!data.ok) {
            console.error('Telegram API error:', data.description, chatId);
            return false;
        }
        const status = data.result?.status;
        return ['member', 'administrator', 'creator'].includes(status);
    } catch (e) {
        console.error('checkMember error for', chatId, ':', e.message);
        return false;
    }
}
