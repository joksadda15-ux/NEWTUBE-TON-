// api/init.js
// POST /api/init
// Body: { userId, firstName, username, referrerCode }
//
// শুধু referral bonus দেওয়ার জন্য call হয়
// User create/read সরাসরি Mini App এর Firebase client SDK করে
// তাই loading stuck হবে না

const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

const REFERRAL_BONUS   = 2000;
const MINI_APP_URL     = process.env.MINI_APP_URL || 'https://t.me/NewTube12_bot/WatchTo_Earn';
const BOT_TOKEN        = process.env.BOT_TOKEN;

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'POST only' });

  const { userId, firstName, username, referrerCode } = req.body || {};

  if (!userId)
    return res.status(400).json({ ok: false, error: 'userId required' });

  // referrerCode না থাকলে সাথে সাথে ok return
  if (!referrerCode || String(referrerCode) === String(userId)) {
    return res.status(200).json({ ok: true, message: 'No referral' });
  }

  try {
    const db      = getDb();
    const refId   = String(referrerCode);
    const refRef  = db.collection('users').doc(refId);
    const refSnap = await refRef.get();

    if (!refSnap.exists || refSnap.data().isBanned) {
      return res.status(200).json({ ok: true, message: 'Referrer not found' });
    }

    // Referrer কে gold দেওয়া
    await refRef.update({
      goldBalance:        admin.firestore.FieldValue.increment(REFERRAL_BONUS),
      lifetimeGoldEarned: admin.firestore.FieldValue.increment(REFERRAL_BONUS),
      referralCount:      admin.firestore.FieldValue.increment(1),
    });

    // Bot notification
    const name = username ? `@${username}` : (firstName || `User ${userId}`);
    await tgSend(refId, name);

    return res.status(200).json({ ok: true, referralBonusGiven: true });

  } catch (err) {
    console.error('init error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

async function tgSend(chatId, newUserName) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
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
        reply_markup: { inline_keyboard: [[{ text: '🎮 Open NEWTUBE', url: MINI_APP_URL }]] }
      })
    });
  } catch(e) { console.error('tgSend error:', e); }
}
