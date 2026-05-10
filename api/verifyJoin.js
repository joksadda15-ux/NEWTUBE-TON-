// api/verifyJoin.js
// Handles 3 routes:
//   GET /api/checkMember?userId=&channel=   → task channel check
//   GET /api/checkJoin?userId=              → official channel+group check
//   GET/POST /api/verifyJoin?userId=        → official channel+group check

const { getDb } = require('./utils/firebase');
const { handleCors } = require('./utils/cors');

const BOT_TOKEN        = process.env.BOT_TOKEN;
const OFFICIAL_CHANNEL = process.env.CHANNEL_ID || '@NEEWTON_OFFICIAL';
const OFFICIAL_GROUP   = process.env.GROUP_ID   || '@newTon_Gc';

module.exports = async function handler(req, res) {
    if (handleCors(req, res)) return;

    const path = req.url || '';
    const query = req.query || {};

    // ── Route: checkMember (for task channel verification) ──
    if (path.includes('checkMember') || (query.channel && query.userId)) {
        const { userId, channel } = query;
        if (!userId || !channel) {
            return res.status(400).json({ ok: false, error: 'userId and channel required' });
        }
        if (!BOT_TOKEN) {
            return res.status(200).json({ ok: true, joined: true }); // don't block if no token
        }
        try {
            const joined = await checkMember(userId, channel);
            return res.status(200).json({ ok: true, joined });
        } catch (err) {
            return res.status(200).json({ ok: false, joined: false, error: err.message });
        }
    }

    // ── Route: verifyJoin / checkJoin (official channels) ──
    const userId = req.method === 'POST'
        ? req.body?.userId
        : query.userId;

    if (!userId) {
        return res.status(400).json({ ok: false, error: 'userId required' });
    }

    if (!BOT_TOKEN) {
        return res.status(200).json({ ok: true, joined: true });
    }

    try {
        const [chanOk, groupOk] = await Promise.all([
            checkMember(userId, OFFICIAL_CHANNEL),
            checkMember(userId, OFFICIAL_GROUP),
        ]);

        const joined = chanOk && groupOk;

        if (joined) {
            try {
                const db = getDb();
                await db.collection('users').doc(String(userId)).update({ channelVerified: true });
            } catch(e) {}
        }

        return res.status(200).json({ ok: true, joined, chanOk, groupOk });

    } catch (err) {
        console.error('verifyJoin error:', err);
        return res.status(200).json({ ok: false, joined: false, error: err.message });
    }
};

async function checkMember(userId, chatId) {
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) return false;
        const data = await resp.json();
        if (!data.ok) return false;
        return ['member', 'administrator', 'creator'].includes(data.result?.status);
    } catch(e) {
        return false;
    }
}
