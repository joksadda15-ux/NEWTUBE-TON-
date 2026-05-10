// api/videoStart.js
// POST /api/videoStart
// Body: { userId }
//
// User video দেখা শুরু করলে call হবে।
// HMAC signature তৈরি করে return করে।
// videoClaim.js এই signature verify করে gold দেবে।
// এতে কেউ fake time দিয়ে gold নিতে পারবে না।

const crypto             = require('crypto');
const { getDb }          = require('./utils/firebase');
const { handleCors }     = require('./utils/cors');

const SECRET = process.env.VIDEO_SECRET || 'newtube_video_secret_2025';

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'POST only' });

  const { userId } = req.body || {};
  if (!userId)
    return res.status(400).json({ ok: false, error: 'userId required' });

  try {
    const db   = getDb();
    const snap = await db.collection('users').doc(String(userId)).get();

    if (!snap.exists)
      return res.status(404).json({ ok: false, error: 'User not found' });

    const user = snap.data();
    if (user.isBanned)
      return res.status(403).json({ ok: false, error: 'Banned' });

    // Daily limit check — আগেই বলে দেওয়া ভালো
    const DAILY_MAX   = 200;
    const dailyMined  = user.dailyVideoMined || 0;
    if (dailyMined >= DAILY_MAX)
      return res.status(400).json({ ok: false, error: 'Daily video limit reached', dailyMined, DAILY_MAX });

    const startTime = Date.now();

    // HMAC signature — userId + startTime দিয়ে তৈরি
    const signature = crypto
      .createHmac('sha256', SECRET)
      .update(`${userId}:${startTime}`)
      .digest('hex');

    return res.status(200).json({
      ok: true,
      startTime,
      signature,
      dailyMined,
      remaining: DAILY_MAX - dailyMined,
    });

  } catch (err) {
    console.error('videoStart error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
