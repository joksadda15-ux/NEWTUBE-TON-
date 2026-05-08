// api/exchange.js
// POST /api/exchange
// Body: { userId, goldAmount }
//
// Converts Gold → Diamond
// Rate: 1,000 Gold = 1 Diamond
// Min: 5,000 Gold | Max: 100,000 Gold per transaction

const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

const GOLD_PER_DIAMOND = 1000;
const MIN_GOLD         = 5000;
const MAX_GOLD         = 100000;

module.exports = async function handler(req, res) {
    if (handleCors(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'POST only' });
    }

    const { userId, goldAmount } = req.body || {};

    if (!userId || typeof goldAmount !== 'number') {
        return res.status(400).json({ ok: false, error: 'userId and goldAmount required' });
    }

    if (goldAmount < MIN_GOLD) {
        return res.status(400).json({ ok: false, error: `Minimum ${MIN_GOLD} Gold required` });
    }

    if (goldAmount > MAX_GOLD) {
        return res.status(400).json({ ok: false, error: `Maximum ${MAX_GOLD} Gold per exchange` });
    }

    const diamondOut = Math.floor(goldAmount / GOLD_PER_DIAMOND);
    if (diamondOut < 1) {
        return res.status(400).json({ ok: false, error: 'Not enough Gold for 1 Diamond' });
    }

    const db      = getDb();
    const userRef = db.collection('users').doc(String(userId));

    try {
        // Run in Firestore transaction to prevent race conditions
        const result = await db.runTransaction(async (t) => {
            const snap = await t.get(userRef);

            if (!snap.exists) throw new Error('User not found');
            const user = snap.data();
            if (user.isBanned) throw new Error('Account banned');

            const currentGold = user.goldBalance || 0;
            if (currentGold < goldAmount) {
                throw new Error(`Insufficient Gold. You have ${currentGold}, need ${goldAmount}`);
            }

            t.update(userRef, {
                goldBalance:    admin.firestore.FieldValue.increment(-goldAmount),
                diamondBalance: admin.firestore.FieldValue.increment(diamondOut),
            });

            // Log the exchange
            const logRef = db.collection('exchanges').doc();
            t.set(logRef, {
                userId:      String(userId),
                goldSpent:   goldAmount,
                diamondGained: diamondOut,
                rate:        GOLD_PER_DIAMOND,
                createdAt:   admin.firestore.FieldValue.serverTimestamp(),
            });

            return { goldSpent: goldAmount, diamondGained: diamondOut };
        });

        return res.status(200).json({
            ok:            true,
            success:       true,
            goldSpent:     result.goldSpent,
            diamondGained: result.diamondGained,
            message:       `Converted ${result.goldSpent} Gold → ${result.diamondGained} Diamond`,
        });

    } catch (err) {
        console.error('exchange error:', err);
        return res.status(400).json({ ok: false, error: err.message });
    }
};
