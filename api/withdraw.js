// api/withdraw.js
// POST /api/withdraw
// action: 'approve' | 'reject' | 'referral_notify'

const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

const MINI_APP_URL = process.env.MINI_APP_URL || 'https://t.me/NewTube12_bot/WatchTo_Earn';
const BOT_TOKEN    = process.env.BOT_TOKEN;

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { action, adminSecret, withdrawalId, referrerId, newUserName } = req.body || {};

  // ── Referral notification (Mini App থেকে, internal secret)
  if (action === 'referral_notify') {
    if (adminSecret !== 'referral_internal')
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (!referrerId)
      return res.status(400).json({ ok: false, error: 'referrerId required' });
    const msg =
      `🎉 <b>Referral Reward!</b>\n\n` +
      `👤 <b>${newUserName || 'A friend'}</b> joined using your link!\n\n` +
      `💰 You received: <b>+2,000 🪙 Gold</b>\n\n` +
      `🚀 Keep inviting friends to earn more!`;
    await tgSend(String(referrerId), msg);
    return res.status(200).json({ ok: true });
  }

  // ── Approve / Reject (Admin Panel থেকে)
  if (adminSecret !== process.env.ADMIN_SECRET)
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
      const batch = db.batch();
      batch.update(wRef, { status: 'rejected', rejectedAt: admin.firestore.FieldValue.serverTimestamp() });
      batch.update(db.collection('users').doc(userId), {
        diamondBalance: admin.firestore.FieldValue.increment(diamondAmt)
      });
      await batch.commit();
      await sendRejectMsg(telegramId, diamondAmt, method);
      return res.status(200).json({ ok: true, message: `Rejected, refunded & notification sent` });
    }
  } catch(err) {
    console.error('withdraw error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

async function sendApproveMsg(chatId, diamondAmt, method, wallet) {
  const usdt = (diamondAmt / 1000).toFixed(4);
  const ton  = (diamondAmt / 1000 * 0.45).toFixed(4);
  const bdt  = (diamondAmt / 1000 * 120).toFixed(2);
  await tgSend(chatId,
    `🎉 <b>Withdrawal Approved!</b>\n\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `💎 <b>${diamondAmt.toLocaleString()} Diamond</b>\n` +
    `💵 ≈ ${usdt} USDT | 💠 ≈ ${ton} TON | 🇧🇩 ≈ ${bdt} BDT\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `📤 Method: <b>${method}</b>\n` +
    `👛 <code>${wallet}</code>\n\n` +
    `⏳ Payment within <b>12–48 hours</b>.\nThank you for using <b>NEWTUBE</b>! 🎮`
  );
}

async function sendRejectMsg(chatId, diamondAmt, method) {
  await tgSend(chatId,
    `❌ <b>Withdrawal Rejected</b>\n\n` +
    `💎 <b>${diamondAmt.toLocaleString()} Diamond</b> refunded to your account.\n` +
    `📤 Method: <b>${method}</b>\n\n` +
    `Keep earning on <b>NEWTUBE</b>! 🎮`
  );
}

async function tgSend(chatId, text) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, text, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🎮 Open NEWTUBE', url: MINI_APP_URL }]] }
      })
    });
  } catch(e) { console.error('tgSend error:', e); }
}
