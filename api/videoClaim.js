// api/videoClaim.js
// POST /api/videoClaim
// Body: { userId, startTime, signature, claimedPoints (gold) }
//
// Verifies HMAC signature from videoStart.
// Checks minimum watch duration.
// Awards gold capped at VIDEO_BOX_MAX and daily limit.

const crypto        = require('crypto');
const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

const SECRET        = process.env.VIDEO_SECRET || 'newtube_video_secret_2025';
const MIN_SECONDS   = 60;       // user must have watched at least 60 seconds
const VIDEO_BOX_MIN = 100;      // minimum gold to claim
const VIDEO_BOX_MAX = 200;      // maximum gold per box
const DAILY_MAX     = 200;      // max gold from videos per day

module.exports = async function handler(req, res) {
    if (handleCors(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'POST only' });
    }

    const { userId, startTime, signature, claimedPoints } = req.body || {};

    if (!userId || !startTime || !signature || typeof claimedPoints !== 'number') {
        return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    // ── 1. Verify HMAC signature ──
    const expected = crypto
        .createHmac('sha256', SECRET)
        .update(`${userId}:${startTime}`)
        .digest('hex');

    if (expected !== signature) {
        return res.status(403).json({ ok: false, error: 'Invalid signature' });
    }

    // ── 2. Verify watch duration ──
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    if (elapsedSeconds < MIN_SECONDS) {
        return res.status(400).json({
            ok: false,
            error: `Watch at least ${MIN_SECONDS} seconds. You watched: ${Math.floor(elapsedSeconds)}s`,
        });
    }

    // ── 3. Validate gold amount ──
    const goldToClaim = Math.min(
        Math.max(Math.floor(claimedPoints), VIDEO_BOX_MIN),
        VIDEO_BOX_MAX
    );

    const db      = getDb();
    const userRef = db.collection('users').doc(String(userId));

    try {
        const snap = await userRef.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: 'User not found' });
        const user = snap.data();
        if (user.isBanned) return res.status(403).json({ ok: false, error: 'Banned' });

        // ── 4. Check daily limit ──
        const dailyMined = user.dailyVideoMined || 0;
        if (dailyMined >= DAILY_MAX) {
            return res.status(400).json({ ok: false, error: `Daily limit reached (${DAILY_MAX} Gold/day)` });
        }

        const actualGold = Math.min(goldToClaim, DAILY_MAX - dailyMined);

        await userRef.update({
            goldBalance:        admin.firestore.FieldValue.increment(actualGold),
            lifetimeGoldEarned: admin.firestore.FieldValue.increment(actualGold),
            dailyVideoMined:    admin.firestore.FieldValue.increment(actualGold),
        });

        return res.status(200).json({
            ok: true,
            success: true,
            pointsAdded: actualGold,
            goldAdded:   actualGold,
        });

    } catch (err) {
        console.error('videoClaim error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
};
