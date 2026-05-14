// api/videoStart.js
// Called when user starts playing a video.
// Returns a signed startTime that videoClaim will verify — prevents fake claims.

import crypto from 'crypto';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const SECRET = process.env.VIDEO_HMAC_SECRET || 'newtube_video_secret_2025';
const DAILY_VIDEO_MAX = 5000; // must match frontend constant

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
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    try {
        const app = getAdminApp();
        const db  = getFirestore(app);

        // Check user exists and daily limit
        const userSnap = await db.collection('users').doc(String(userId)).get();
        if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

        const user = userSnap.data();
        if (user.isBanned) return res.status(403).json({ error: 'banned' });

        const dailyMined = user.dailyVideoMined || 0;
        if (dailyMined >= DAILY_VIDEO_MAX) {
            return res.status(200).json({ success: false, error: 'daily_limit_reached', dailyMined });
        }

        // Generate signed token: HMAC(userId + startTime)
        const startTime = Date.now();
        const payload   = `${userId}:${startTime}`;
        const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

        return res.status(200).json({ success: true, startTime, signature });

    } catch (err) {
        console.error('[videoStart]', err);
        return res.status(500).json({ error: 'server_error', message: err.message });
    }
}
