// api/checkMember.js
// GET /api/checkMember?userId=123&channel=@SomeChannel
// Used by the task system to verify if user joined a task channel.

const { handleCors } = require('./utils/cors');

const BOT_TOKEN = process.env.BOT_TOKEN;

module.exports = async function handler(req, res) {
    if (handleCors(req, res)) return;

    const { userId, channel } = req.query;

    if (!userId || !channel) {
        return res.status(400).json({ ok: false, error: 'userId and channel required' });
    }

    try {
        const joined = await checkMember(userId, channel);
        return res.status(200).json({ ok: true, joined });
    } catch (err) {
        console.error('checkMember error:', err);
        return res.status(500).json({ ok: false, error: err.message, joined: false });
    }
};

async function checkMember(userId, chatId) {
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (!data.ok) return false;
        const status = data.result?.status;
        return ['member', 'administrator', 'creator'].includes(status);
    } catch (e) {
        return false;
    }
}
