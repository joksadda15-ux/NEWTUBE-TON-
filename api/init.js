// api/init.js
// POST /api/init
// Header: x-telegram-init-data
// Body: { telegramId, username, referredBy?, syncOnly? }
//
// User init এবং sync — Mini App open করলে প্রথমে call হয়
// Returns: { success: true, user: { coins, gems, ... } }

const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

const REFERRAL_BONUS = 2000; // gold

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST')
    return res.status(405).json({ success: false, error: 'POST only' });

  const telegramInitData = req.headers['x-telegram-init-data'] || '';
  const { telegramId, username, referredBy, syncOnly } = req.body || {};

  if (!telegramId)
    return res.status(400).json({ success: false, error: 'telegramId required' });

  const db      = getDb();
  const userId  = String(telegramId);
  const userRef = db.collection('users').doc(userId);
  const today   = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  try {
    const snap = await userRef.get();

    // ── Existing user ──
    if (snap.exists) {
      const user = snap.data();

      if (user.isBanned)
        return res.status(403).json({ success: false, error: 'Banned' });

      // Daily reset
      const updates = {};
      if (user.lastResetDate !== today) {
        updates.lastResetDate      = today;
        updates.adsgramCount       = 0;
        updates.adsgramDailyCount  = 0;
        updates.gigapubCount       = 0;
        updates.monetagCount       = 0;
        updates.adxiumCount        = 0;
        updates.dailyVideoMined    = 0;
        updates.tasksCompletedToday = 0;
        updates.tokenRefill        = Date.now() + 30 * 60 * 1000; // 30 min
      }

      updates.lastSeen = admin.firestore.FieldValue.serverTimestamp();
      if (username) updates.username = username;

      await userRef.update(updates);

      const fresh = { ...user, ...updates, lastResetDate: today };
      return res.status(200).json({ success: true, user: formatUser(fresh) });
    }

    // ── New user ──
    if (syncOnly)
      return res.status(404).json({ success: false, error: 'User not found' });

    const tokenRefillTime = Date.now() + 30 * 60 * 1000;
    const newUser = {
      telegramId:          userId,
      username:            username || '',
      coins:               0,       // goldBalance
      gems:                0,       // diamondBalance
      lootboxPoints:       0,
      tokens:              10,
      tokenRefill:         tokenRefillTime,
      stage:               1,
      referCode:           `NT${userId}`,
      referredBy:          referredBy ? String(referredBy) : null,
      referCount:          0,
      referDiamonds:       0,
      completedTasks:      [],
      lifetimeCoins:       0,
      lifetimeGems:        0,
      adsgramCount:        0,
      adsgramDailyCount:   0,
      gigapubCount:        0,
      monetagCount:        0,
      adxiumCount:         0,
      dailyVideoMined:     0,
      tasksCompletedToday: 0,
      firstLootboxClaimed: false,
      isBanned:            false,
      lastResetDate:       today,
      lastSeen:            admin.firestore.FieldValue.serverTimestamp(),
      createdAt:           admin.firestore.FieldValue.serverTimestamp(),
    };

    await userRef.set(newUser);

    // Referral bonus — referrer কে gold দেওয়া
    if (referredBy && String(referredBy) !== userId) {
      try {
        const refRef  = db.collection('users').doc(String(referredBy));
        const refSnap = await refRef.get();
        if (refSnap.exists && !refSnap.data().isBanned) {
          await refRef.update({
            coins:         admin.firestore.FieldValue.increment(REFERRAL_BONUS),
            lifetimeCoins: admin.firestore.FieldValue.increment(REFERRAL_BONUS),
            referCount:    admin.firestore.FieldValue.increment(1),
          });

          // Bot notification
          const newName = username ? `@${username}` : `User ${userId}`;
          sendReferralNotif(String(referredBy), newName).catch(() => {});
        }
      } catch (_) { /* referral bonus failure should not block init */ }
    }

    return res.status(200).json({ success: true, user: formatUser(newUser), isNewUser: true });

  } catch (err) {
    console.error('init error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ── Format user for client ──
function formatUser(u) {
  return {
    coins:               u.coins               || 0,
    gems:                u.gems                || 0,
    lootboxPoints:       u.lootboxPoints       || 0,
    tokens:              u.tokens              || 0,
    tokenRefill:         u.tokenRefill         || 0,
    stage:               u.stage               || 1,
    referCode:           u.referCode           || '',
    referCount:          u.referCount          || 0,
    referDiamonds:       u.referDiamonds       || 0,
    completedTasks:      u.completedTasks      || [],
    adsgramCount:        u.adsgramCount        || 0,
    adsgramDailyCount:   u.adsgramDailyCount   || 0,
    gigapubCount:        u.gigapubCount        || 0,
    monetagCount:        u.monetagCount        || 0,
    adxiumCount:         u.adxiumCount         || 0,
    dailyVideoMined:     u.dailyVideoMined     || 0,
    firstLootboxClaimed: u.firstLootboxClaimed || false,
    isBanned:            u.isBanned            || false,
    username:            u.username            || '',
  };
}

// ── Referral Telegram notification ──
async function sendReferralNotif(chatId, newUserName) {
  const token = process.env.BOT_TOKEN;
  const url   = process.env.MINI_APP_URL || 'https://t.me/NewTube12_bot/WatchTo_Earn';
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    chatId,
      parse_mode: 'HTML',
      text:
        `🎉 <b>Referral Reward!</b>\n\n` +
        `👤 <b>${newUserName}</b> joined using your link!\n` +
        `💰 You received: <b>+2,000 🪙 Gold</b>\n\n` +
        `🚀 Keep inviting to earn more!`,
      reply_markup: { inline_keyboard: [[{ text: '🎮 Open NEWTUBE', url }]] }
    })
  }).catch(() => {});
}
