// api/videoStart.js
// POST /api/videoStart
// Body: { userId }
//
// Creates a signed video session so the claim endpoint can verify
// the user actually watched. Returns { startTime, signature }.

const crypto        = require('crypto');
const { handleCors } = require('./utils/cors');

const SECRET = process.env.VIDEO_SECRET || 'newtube_video_secret_2025';

module.exports = async function handler(req, res) {
    if (handleCors(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'POST only' });
    }

    const { userId } = req.body || {};
    if (!userId) {
        return res.status(400).json({ ok: false, error: 'userId required' });
    }

    const startTime = Date.now();
    const signature = crypto
        .createHmac('sha256', SECRET)
        .update(`${userId}:${startTime}`)
        .digest('hex');

    return res.status(200).json({
        ok: true,
        success: true,
        startTime,
        signature,
    });
};
