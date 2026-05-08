// api/promo.js
// POST /api/promo
// Body: { userId, code }
//
// Validates and redeems a promo code for Gold.
// Each code has maxUses limit and per-user single-use enforcement.

const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

module.exports = async function handler(req, res) {
    if (handleCors(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'POST only' });
    }

    const { userId, code } = req.body || {};

    if (!userId || !code) {
        return res.status(400).json({ ok: false, error: 'userId and code required' });
    }

    const db        = getDb();
    const promoRef  = db.collection('promo_codes').doc(code.trim().toUpperCase());
    const userRef   = db.collection('users').doc(String(userId));

    try {
        const rewardAmount = await db.runTransaction(async (t) => {
            const [promoSnap, userSnap] = await Promise.all([
                t.get(promoRef),
                t.get(userRef),
            ]);

            if (!promoSnap.exists) throw new Error('Invalid promo code');
            const promo = promoSnap.data();

            if (!promo.isActive)                        throw new Error('This code is no longer active');
            if (promo.currentUses >= promo.maxUses)     throw new Error('Promo code is fully redeemed');
            if ((promo.usersClaimed || []).includes(String(userId))) {
                throw new Error('You already used this code');
            }

            if (!userSnap.exists) throw new Error('User not found');
            const user = userSnap.data();
            if (user.isBanned)    throw new Error('Account banned');

            const gold = promo.rewardAmount || 0;

            // Award gold to user
            t.update(userRef, {
                goldBalance:        admin.firestore.FieldValue.increment(gold),
                lifetimeGoldEarned: admin.firestore.FieldValue.increment(gold),
            });

            // Update promo usage
            t.update(promoRef, {
                currentUses:  admin.firestore.FieldValue.increment(1),
                usersClaimed: admin.firestore.FieldValue.arrayUnion(String(userId)),
            });

            return gold;
        });

        return res.status(200).json({
            ok:          true,
            success:     true,
            goldAwarded: rewardAmount,
            message:     `+${rewardAmount} Gold added!`,
        });

    } catch (err) {
        console.error('promo error:', err);
        return res.status(400).json({ ok: false, error: err.message });
    }
};
