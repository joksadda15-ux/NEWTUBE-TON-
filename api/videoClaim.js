// api/videoClaim.js
// Verifies the signed session from videoStart, checks minimum watch time,
// then credits gold to the user in Firestore.

import crypto from 'crypto';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const SECRET           = process.env.VIDEO_HMAC_SECRET || 'newtube_video_secret_2025';
const MIN_WATCH_MS     = 60 * 1000;        // minimum 60 seconds watch time
const MAX_SESSION_MS   = 12 * 60 * 60 * 1000; // session token expires after 12 hours
const VIDEO_BOX_MAX    = 2000;             // must match frontend
const DAILY_VIDEO_MAX  = 5000;            // must match frontend

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

    const { userId, startTime, signature, claimedPoints } = req.body || {};
    if (!userId || !startTime || !signature || !claimedPoints) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // 1. Verify HMAC signature
    const expectedSig = crypto
        .createHmac('sha256', SECRET)
        .update(`${userId}:${startTime}`)
        .digest('hex');

    if (expectedSig !== signature) {
        return res.status(403).json({ success: false, error: 'invalid_signature' });
    }

    // 2. Check minimum watch time (at least 60 seconds)
    const elapsed = Date.now() - Number(startTime);
    if (elapsed < MIN_WATCH_MS) {
        return res.status(400).json({ success: false, error: 'watch_time_too_short', message: 'Watch at least 1 minute.' });
    }

    // 3. Check session not expired (> 12h is suspicious)
    if (elapsed > MAX_SESSION_MS) {
        return res.status(400).json({ success: false, error: 'session_expired', message: 'Session expired. Reload app.' });
    }

    // 4. Clamp claimed points to safe range
    const pts = Math.min(Math.floor(Number(claimedPoints)), VIDEO_BOX_MAX);
    if (pts <= 0) {
        return res.status(400).json({ success: false, error: 'invalid_points' });
    }

    try {
        const app = getAdminApp();
        const db  = getFirestore(app);
        const userRef = db.collection('users').doc(String(userId));

        // 5. Firestore transaction — check daily cap + add gold atomically
        const pointsAdded = await db.runTransaction(async (t) => {
            const snap = await t.get(userRef);
            if (!snap.exists) throw new Error('user_not_found');

            const data = snap.data();
            if (data.isBanned) throw new Error('banned');

            const dailyMined = data.dailyVideoMined || 0;
            const remaining  = DAILY_VIDEO_MAX - dailyMined;
            if (remaining <= 0) throw new Error('daily_limit_reached');

            const toAdd = Math.min(pts, remaining);
            t.update(userRef, {
                goldBalance:        FieldValue.increment(toAdd),
                lifetimeGoldEarned: FieldValue.increment(toAdd),
                dailyVideoMined:    FieldValue.increment(toAdd),
            });
            return toAdd;
        });

        return res.status(200).json({ success: true, ok: true, pointsAdded });

    } catch (err) {
        console.error('[videoClaim]', err);
        if (err.message === 'daily_limit_reached') {
            return res.status(200).json({ success: false, error: 'daily_limit_reached', message: 'Daily video limit reached.' });
        }
        if (err.message === 'banned') {
            return res.status(403).json({ success: false, error: 'banned' });
        }
        return res.status(500).json({ success: false, error: 'server_error', message: err.message });
    }
}
