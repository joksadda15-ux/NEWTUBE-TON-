// api/notify.js
// POST /api/notify
// Body: { type, referrerId, newUserName }
//
// Server-side থেকে Telegram notification পাঠায়
// Bot Token client-side এ নেই — সম্পূর্ণ নিরাপদ

const { handleCors } = require('./utils/cors');

const BOT_TOKEN    = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://t.me/NewTube12_bot/WatchTo_Earn';

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'POST only' });

  const { type, referrerId, newUserName } = req.body || {};

  if (!type)
    return res.status(400).json({ ok: false, error: 'type required' });

  try {
    if (type === 'referral') {
      if (!referrerId) return res.status(400).json({ ok: false, error: 'referrerId required' });

      const msg =
        `🎉 <b>Referral Reward!</b>\n\n` +
        `👤 <b>${newUserName || 'A friend'}</b> has joined using your referral link!\n\n` +
        `💰 You have received: <b>+2,000 🪙 Gold</b>\n\n` +
        `🚀 Keep inviting friends to earn more Gold!`;

      await tgSend(referrerId, msg);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Unknown type' });

  } catch (err) {
    console.error('notify error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

async function tgSend(chatId, text) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🎮 Open NEWTUBE', url: MINI_APP_URL }]] }
      })
    });
  } catch(e) { console.error('tgSend error:', e); }
}
