// api/promo.js
// POST /api/promo
// Body: { userId, code }
//
// Promo code redeem করে।
// একজন user একটি code একবারই use করতে পারবে।
// Code limit আছে কিনা check করে।
// Atomic: code usedBy update + user gold বাড়ানো

const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'POST only' });

  const { userId, code } = req.body || {};
  if (!userId || !code)
    return res.status(400).json({ ok: false, error: 'userId and code required' });

  const db          = getDb();
  const cleanCode   = String(code).trim().toUpperCase();
  const promoRef    = db.collection('promo_codes').doc(cleanCode);
  const userRef     = db.collection('users').doc(String(userId));

  try {
    await db.runTransaction(async (t) => {
      const [promoSnap, userSnap] = await Promise.all([
        t.get(promoRef),
        t.get(userRef),
      ]);

      // ── Promo code exists? ──
      if (!promoSnap.exists)
        throw Object.assign(new Error('Invalid promo code'), { code: 'INVALID' });

      // ── User exists? ──
      if (!userSnap.exists)
        throw Object.assign(new Error('User not found'), { code: 'NO_USER' });

      const user  = userSnap.data();
      if (user.isBanned)
        throw Object.assign(new Error('Banned'), { code: 'BANNED' });

      const promo = promoSnap.data();

      // ── Already used by this user? ──
      const usedBy = promo.usedBy || [];
      if (usedBy.includes(String(userId)))
        throw Object.assign(new Error('Already used this code'), { code: 'ALREADY_USED' });

      // ── Code active? ──
      if (promo.isActive === false)
        throw Object.assign(new Error('Promo code expired'), { code: 'EXPIRED' });

      // ── Limit check ──
      if (promo.maxUses && promo.maxUses > 0 && usedBy.length >= promo.maxUses)
        throw Object.assign(new Error('Promo code limit reached'), { code: 'LIMIT' });

      const rewardGold    = promo.rewardGold    || promo.goldAmount    || 0;
      const rewardDiamond = promo.rewardDiamond || promo.diamondAmount || 0;

      if (rewardGold === 0 && rewardDiamond === 0)
        throw Object.assign(new Error('No reward set for this code'), { code: 'NO_REWARD' });

      // ── Atomic update ──
      const userUpdate = {};
      if (rewardGold > 0) {
        userUpdate.goldBalance        = admin.firestore.FieldValue.increment(rewardGold);
        userUpdate.lifetimeGoldEarned = admin.firestore.FieldValue.increment(rewardGold);
      }
      if (rewardDiamond > 0) {
        userUpdate.diamondBalance         = admin.firestore.FieldValue.increment(rewardDiamond);
        userUpdate.lifetimeDiamondsEarned = admin.firestore.FieldValue.increment(rewardDiamond);
      }
      t.update(userRef, userUpdate);

      // code usedBy তে userId যোগ করা
      t.update(promoRef, {
        usedBy:    admin.firestore.FieldValue.arrayUnion(String(userId)),
        usedCount: admin.firestore.FieldValue.increment(1),
        // maxUses পূর্ণ হলে auto deactivate
        ...(promo.maxUses && (usedBy.length + 1) >= promo.maxUses
          ? { isActive: false }
          : {}),
      });

      // transaction result return করার জন্য
      t._rewardGold    = rewardGold;
      t._rewardDiamond = rewardDiamond;
    });

    // Transaction এর ভেতর থেকে value বের করা যায় না, তাই আবার read
    const promoSnap  = await promoRef.get();
    const promo      = promoSnap.data();
    const rewardGold    = promo.rewardGold    || promo.goldAmount    || 0;
    const rewardDiamond = promo.rewardDiamond || promo.diamondAmount || 0;

    return res.status(200).json({
      ok: true,
      message:     'Promo code redeemed!',
      rewardGold,
      rewardDiamond,
    });

  } catch (err) {
    console.error('promo error:', err);
    const status = ['INVALID','ALREADY_USED','EXPIRED','LIMIT'].includes(err.code) ? 200 : 500;
    return res.status(status).json({ ok: false, error: err.message, code: err.code });
  }
};
