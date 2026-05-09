// api/claimLootbox.js
// POST /api/claimLootbox
// Body: { userId, points (gold), adsWatched, adsWatchedAdsgramDaily,
//         adsWatchedAdsgramSpecial, adsWatchedMonetag, adsWatchedGiga }
//
// Validates gold amount, writes to Firestore atomically.
// Max 500 gold per claim. Gives referrer bonus on FIRST lootbox claim.

const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

const MAX_LOOTBOX_GOLD   = 3000;
const REFERRAL_BONUS_GOLD = 2000; // referrer bonus on first lootbox claim

module.exports = async function handler(req, res) {
    if (handleCors(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'POST only' });
    }

    const {
        userId,
        points: goldAmount,
        adsWatched,
        adsWatchedAdsgramDaily,
        adsWatchedAdsgramSpecial,
        adsWatchedMonetag,
        adsWatchedGiga,
    } = req.body || {};

    if (!userId || typeof goldAmount !== 'number') {
        return res.status(400).json({ ok: false, error: 'userId and points required' });
    }

    // Security: cap gold amount
    if (goldAmount < 600 || goldAmount > MAX_LOOTBOX_GOLD) {
        return res.status(400).json({ ok: false, error: `Gold must be 600–${MAX_LOOTBOX_GOLD}` });
    }

    const db      = getDb();
    const userRef = db.collection('users').doc(String(userId));

    try {
        const snap = await userRef.get();
        if (!snap.exists) {
            return res.status(404).json({ ok: false, error: 'User not found' });
        }
        const user = snap.data();
        if (user.isBanned) {
            return res.status(403).json({ ok: false, error: 'Banned' });
        }

        // Atomic update
        const batch = db.batch();

        const userUpdate = {
            goldBalance:              admin.firestore.FieldValue.increment(goldAmount),
            lifetimeGoldEarned:       admin.firestore.FieldValue.increment(goldAmount),
            lifetimeAdsWatched:       admin.firestore.FieldValue.increment(adsWatched || 0),
            adsWatchedAdsgramDaily:   admin.firestore.FieldValue.increment(adsWatchedAdsgramDaily  || 0),
            adsWatchedAdsgramSpecial: admin.firestore.FieldValue.increment(adsWatchedAdsgramSpecial|| 0),
            adsWatchedMonetag:        admin.firestore.FieldValue.increment(adsWatchedMonetag       || 0),
            adsWatchedGiga:           admin.firestore.FieldValue.increment(adsWatchedGiga          || 0),
            adsWatchedToday:          admin.firestore.FieldValue.increment(adsWatched || 0),
        };

        // First lootbox claim → activate referral
        let refBonusGiven = false;
        if (!user.firstLootboxClaimed && user.referredBy) {
            userUpdate.firstLootboxClaimed = true;
            const refRef = db.collection('users').doc(String(user.referredBy));
            batch.update(refRef, {
                goldBalance:        admin.firestore.FieldValue.increment(REFERRAL_BONUS_GOLD),
                lifetimeGoldEarned: admin.firestore.FieldValue.increment(REFERRAL_BONUS_GOLD),
            });
            refBonusGiven = true;
        }

        batch.update(userRef, userUpdate);
        await batch.commit();

        return res.status(200).json({
            ok: true,
            success: true,
            goldAdded: goldAmount,
            refBonusGiven,
        });

    } catch (err) {
        console.error('claimLootbox error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
};
