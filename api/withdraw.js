// api/withdraw.js
// POST /api/withdraw
// Body: { withdrawalId, action ('approve'|'reject'), adminSecret }
//
// Admin approve/reject করলে:
//   approve → Firestore status update + user Bot notification
//   reject  → diamond refund (transaction) + user Bot notification

const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

const MINI_APP_URL = process.env.MINI_APP_URL || 'https://t.me/NewTube12_bot/WatchTo_Earn';
const BOT_TOKEN    = process.env.BOT_TOKEN;

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { withdrawalId, action, adminSecret } = req.body || {};

  // ── Admin auth ──
  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ ok: false, error: 'Unauthorized' });

  if (!withdrawalId || !['approve','reject'].includes(action))
    return res.status(400).json({ ok: false, error: 'withdrawalId and action required' });

  const db = getDb();

  try {
    const wRef  = db.collection('withdrawals').doc(withdrawalId);
    const wSnap = await wRef.get();

    if (!wSnap.exists)
      return res.status(404).json({ ok: false, error: 'Withdrawal not found' });

    const wd = wSnap.data();
    if (wd.status !== 'pending')
      return res.status(400).json({ ok: false, error: `Already ${wd.status}` });

    const userId     = String(wd.userId);
    const diamondAmt = wd.diamondAmount || wd.amount || 0;
    const method     = wd.method || 'TON';
    const wallet     = wd.walletAddress || wd.address || '—';

    // user telegramId নেওয়া
    let telegramId = userId;
    try {
      const uSnap = await db.collection('users').doc(userId).get();
      if (uSnap.exists) telegramId = String(uSnap.data().telegramId || uSnap.data().userId || userId);
    } catch(_) {}

    if (action === 'approve') {
      await wRef.update({ status: 'approved', approvedAt: admin.firestore.FieldValue.serverTimestamp() });
      await sendApproveMsg(telegramId, diamondAmt, method, wallet);
      return res.status(200).json({ ok: true, message: 'Approved & notification sent' });

    } else {
      // reject: diamond ফেরত দেওয়া — atomic
      const batch = db.batch();
      batch.update(wRef, { status: 'rejected', rejectedAt: admin.firestore.FieldValue.serverTimestamp() });
      batch.update(db.collection('users').doc(userId), {
        diamondBalance: admin.firestore.FieldValue.increment(diamondAmt)
      });
      await batch.commit();
      await sendRejectMsg(telegramId, diamondAmt, method);
      return res.status(200).json({ ok: true, message: `Rejected, ${diamondAmt} Diamond refunded & notification sent` });
    }

  } catch(err) {
    console.error('withdraw API error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

async function sendApproveMsg(chatId, diamondAmt, method, wallet) {
  const usdt = (diamondAmt / 1000).toFixed(4);
  const ton  = (diamondAmt / 1000 * 0.45).toFixed(4);
  const bdt  = (diamondAmt / 1000 * 120).toFixed(2);
  const text =
    `🎉 <b>Withdrawal Approved!</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `💎 Amount: <b>${diamondAmt.toLocaleString()} Diamond</b>\n` +
    `💵 ≈ <b>${usdt} USDT</b>\n` +
    `💠 ≈ <b>${ton} TON</b>\n` +
    `🇧🇩 ≈ <b>${bdt} BDT</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `📤 Method: <b>${method}</b>\n` +
    `👛 Wallet: <code>${wallet}</code>\n\n` +
    `⏳ Payment will be sent within <b>12–48 hours</b>.\n` +
    `Thank you for using <b>NEWTUBE</b>! 🎮✨`;
  await tgSend(chatId, text);
}

async function sendRejectMsg(chatId, diamondAmt, method) {
  const text =
    `❌ <b>Withdrawal Rejected</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `💎 Amount: <b>${diamondAmt.toLocaleString()} Diamond</b>\n` +
    `📤 Method: <b>${method}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✅ Your <b>${diamondAmt.toLocaleString()} Diamond</b> has been <b>refunded</b> to your account.\n\n` +
    `❓ Questions? Contact support.\n\n` +
    `Keep earning on <b>NEWTUBE</b>! 🎮`;
  await tgSend(chatId, text);
}

async function tgSend(chatId, text) {
  if (!BOT_TOKEN) return console.error('BOT_TOKEN not set');
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
