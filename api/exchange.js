// api/exchange.js
// POST /api/exchange
// Body: { userId, goldAmount }
//
// Gold → Diamond convert করে।
// Rate: 1000 Gold = 1 Diamond (Firestore config থেকে নেওয়া হয়)
// Minimum: 1000 Gold
// Atomic: gold কমানো + diamond বাড়ানো একসাথে

const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

const DEFAULT_RATE    = 1000; // 1000 gold = 1 diamond
const MIN_GOLD        = 1000;

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'POST only' });

  const { userId, goldAmount } = req.body || {};

  if (!userId || typeof goldAmount !== 'number')
    return res.status(400).json({ ok: false, error: 'userId and goldAmount required' });

  if (goldAmount < MIN_GOLD)
    return res.status(400).json({ ok: false, error: `Minimum ${MIN_GOLD} Gold required` });

  if (goldAmount % MIN_GOLD !== 0)
    return res.status(400).json({ ok: false, error: `Gold must be multiple of ${MIN_GOLD}` });

  const db = getDb();

  try {
    // ── Config থেকে rate নেওয়া (admin panel থেকে set করা যাবে) ──
    let rate = DEFAULT_RATE;
    try {
      const cfgSnap = await db.collection('config').doc('exchange').get();
      if (cfgSnap.exists && cfgSnap.data().goldPerDiamond) {
        rate = cfgSnap.data().goldPerDiamond;
      }
    } catch (_) { /* config না পেলে default use */ }

    const diamondToAdd = Math.floor(goldAmount / rate);
    if (diamondToAdd < 1)
      return res.status(400).json({ ok: false, error: 'Not enough gold for 1 diamond' });

    const userRef = db.collection('users').doc(String(userId));

    // ── Transaction: balance check + atomic update ──
    await db.runTransaction(async (t) => {
      const snap = await t.get(userRef);
      if (!snap.exists) throw new Error('User not found');

      const user = snap.data();
      if (user.isBanned) throw new Error('Banned');

      const currentGold = user.goldBalance || 0;
      if (currentGold < goldAmount)
        throw new Error(`Insufficient gold. You have ${currentGold}, need ${goldAmount}`);

      t.update(userRef, {
        goldBalance:            admin.firestore.FieldValue.increment(-goldAmount),
        diamondBalance:         admin.firestore.FieldValue.increment(diamondToAdd),
        lifetimeDiamondsEarned: admin.firestore.FieldValue.increment(diamondToAdd),
      });
    });

    return res.status(200).json({
      ok:           true,
      goldSpent:    goldAmount,
      diamondAdded: diamondToAdd,
      rate,
    });

  } catch (err) {
    console.error('exchange error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
