// api/claimPromo.js
// Handles promo code claiming — server-side via Firebase Admin SDK
// No client Firestore permissions needed

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function getAdminApp() {
    if (getApps().length > 0) return getApps()[0];
    return initializeApp({
        credential: cert({
            projectId:   process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
    });
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, code } = req.body || {};
    if (!userId || !code) {
        return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    try {
        const app = getAdminApp();
        const db  = getFirestore(app);

        const promoRef = db.collection('promo_codes').doc(code.trim().toUpperCase());
        const userRef  = db.collection('users').doc(String(userId));

        const rewardAmount = await db.runTransaction(async (t) => {
            const [promoSnap, userSnap] = await Promise.all([
                t.get(promoRef),
                t.get(userRef),
            ]);

            // Promo checks
            if (!promoSnap.exists) throw { code: 'invalid_code', message: 'Invalid promo code.' };
            const promo = promoSnap.data();
            if (!promo.isActive)                          throw { code: 'inactive', message: 'This code is no longer active.' };
            if (promo.currentUses >= promo.maxUses)       throw { code: 'limit_reached', message: 'This code has reached its usage limit.' };
            if (promo.usersClaimed?.includes(String(userId))) throw { code: 'already_used', message: 'You have already used this code.' };

            // User checks
            if (!userSnap.exists) throw { code: 'user_not_found', message: 'User not found.' };
            const user = userSnap.data();
            if (user.isBanned) throw { code: 'banned', message: 'Your account is banned.' };

            const reward = promo.rewardAmount || 0;

            // Credit gold + mark promo used
            t.update(userRef, {
                goldBalance:        FieldValue.increment(reward),
                lifetimeGoldEarned: FieldValue.increment(reward),
            });
            t.update(promoRef, {
                currentUses:  FieldValue.increment(1),
                usersClaimed: FieldValue.arrayUnion(String(userId)),
            });

            return reward;
        });

        return res.status(200).json({ ok: true, rewardAmount });

    } catch (err) {
        if (err.code) {
            return res.status(200).json({ ok: false, error: err.code, message: err.message });
        }
        console.error('[claimPromo]', err);
        return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
    }
}
