// api/verifyJoin.js
// Handles BOTH routes in ONE file (saves serverless function count):
//   /api/verifyJoin  → check official channel+group
//   /api/checkMember → check any single channel (task system)
//   /api/checkJoin   → alias for verifyJoin

const { getDb } = require('./utils/firebase');
const { handleCors } = require('./utils/cors');

const BOT_TOKEN        = process.env.BOT_TOKEN;
const OFFICIAL_CHANNEL = process.env.CHANNEL_ID || '@NEEWTON_OFFICIAL';
const OFFICIAL_GROUP   = process.env.GROUP_ID   || '@newTon_Gc';

module.exports = async function handler(req, res) {
    if (handleCors(req, res)) return;

    const urlPath = req.url || '';

    // ── /api/checkMember?userId=&channel= ──
    // Task system: check single channel membership
    if (urlPath.includes('checkMember') || (req.query.channel && !req.query.checkJoin)) {
        const { userId, channel } = req.query;
        if (!userId || !channel) {
            return res.status(400).json({ ok: false, error: 'userId and channel required' });
        }
        try {
            const joined = await checkMember(userId, channel);
            return res.status(200).json({ ok: true, joined });
        } catch (err) {
            return res.status(200).json({ ok: false, joined: false, error: err.message });
        }
    }

    // ── /api/verifyJoin or /api/checkJoin ──
    const userId = req.method === 'POST'
        ? req.body?.userId
        : req.query?.userId;

    if (!userId) {
        return res.status(400).json({ ok: false, error: 'userId required' });
    }

    if (!BOT_TOKEN) {
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
            try {
                const db = getDb();
                await db.collection('users').doc(String(userId)).update({ channelVerified: true });
            } catch(e) { /* ignore */ }
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
        return ['member','administrator','creator'].includes(data.result?.status);
    } catch(e) { return false; }
}
