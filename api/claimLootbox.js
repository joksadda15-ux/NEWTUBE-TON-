// api/claimLootbox.js
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const LOOTBOX_MIN     = 1000; // ← updated from 600
const LOOTBOX_MAX     = 5000; // ← updated from 3000
const DAILY_CLAIM_MAX = 3;

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

function getTodayString() {
    return new Date().toISOString().slice(0, 10);
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const {
        userId, points,
        adsWatched = 0,
        adsWatchedAdsgramDaily = 0,
        adsWatchedAdsgramSpecial = 0,
        adsWatchedMonetag = 0,
        adsWatchedGiga = 0,
    } = req.body || {};

    if (!userId) return res.status(400).json({ ok: false, error: 'missing_userId' });

    const claimGold = Math.min(Math.floor(Number(points) || 0), LOOTBOX_MAX);
    if (claimGold < LOOTBOX_MIN) {
        return res.status(400).json({ ok: false, error: 'below_minimum', min: LOOTBOX_MIN });
    }

    try {
        const app     = getAdminApp();
        const db      = getFirestore(app);
        const userRef = db.collection('users').doc(String(userId));

        const pointsAdded = await db.runTransaction(async (t) => {
            const snap = await t.get(userRef);
            if (!snap.exists) throw new Error('user_not_found');
            const user = snap.data();
            if (user.isBanned) throw new Error('banned');

            const today           = getTodayString();
            const lastClaimDate   = user.lastLootboxClaimDate || '';
            const dailyClaimCount = lastClaimDate === today ? (user.dailyLootboxClaims || 0) : 0;
            if (dailyClaimCount >= DAILY_CLAIM_MAX) throw new Error('daily_limit_reached');

            t.update(userRef, {
                goldBalance:              FieldValue.increment(claimGold),
                lifetimeGoldEarned:       FieldValue.increment(claimGold),
                adsWatchedToday:          FieldValue.increment(adsWatched),
                lifetimeAdsWatched:       FieldValue.increment(adsWatched),
                adsWatchedAdsgramDaily:   FieldValue.increment(adsWatchedAdsgramDaily),
                adsWatchedAdsgramSpecial: FieldValue.increment(adsWatchedAdsgramSpecial),
                adsWatchedMonetag:        FieldValue.increment(adsWatchedMonetag),
                adsWatchedGiga:           FieldValue.increment(adsWatchedGiga),
                dailyLootboxClaims:       dailyClaimCount + 1,
                lastLootboxClaimDate:     today,
            });
            return claimGold;
        });

        return res.status(200).json({ ok: true, pointsAdded });

    } catch (err) {
        if (err.message === 'daily_limit_reached')
            return res.status(200).json({ ok: false, error: 'daily_limit_reached' });
        if (err.message === 'banned')
            return res.status(403).json({ ok: false, error: 'banned' });
        return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
    }
}
