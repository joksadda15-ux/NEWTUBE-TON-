// api/verifyJoin.js
// Called when user clicks "Verify & Continue" button in the join popup
// POST /api/verifyJoin  body: { userId }

const BOT_TOKEN  = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GROUP_ID   = process.env.GROUP_ID;

async function isMember(chatId, userId) {
    try {
        const url  = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`;
        const res  = await fetch(url);
        const data = await res.json();
        if (!data.ok) return false;
        const status = data.result?.status;
        return ['member', 'administrator', 'creator'].includes(status);
    } catch (e) {
        return false;
    }
}

export default async function handler(req, res) {
    const userId = req.query?.userId || req.body?.userId;

    if (!userId) {
        return res.status(400).json({ ok: false, error: 'missing_userId' });
    }

    try {
        const [inChannel, inGroup] = await Promise.all([
            isMember(CHANNEL_ID, userId),
            isMember(GROUP_ID,   userId),
        ]);

        const joined = inChannel && inGroup;

        return res.status(200).json({
            ok:      true,
            joined,
            channel: inChannel,
            group:   inGroup,
        });
    } catch (err) {
        console.error('[verifyJoin] error:', err.message);
        // Fail open on error
        return res.status(200).json({ ok: true, joined: true });
    }
}
