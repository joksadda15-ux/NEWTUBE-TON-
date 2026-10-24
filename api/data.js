// api/data.js — public read-only data for the mini app.
//   GET /api/data?type=videos
//   GET /api/data?type=tasks
//   GET /api/data?type=leaderboard        (top 20 by referralCount)

import { connectToDatabase } from '../lib/mongodb.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    try {
        const { type } = req.query;
        const { db } = await connectToDatabase();

        // v1.2 (saves Vercel usage): these lists are the same for everybody, so Vercel's edge cache answers them
        // (no function run, no database read) for a few minutes instead of every single request.
        if (type === 'videos') {
            res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
            const videos = await db.collection('videos')
                .find({ isActive: true })
                .sort({ createdAt: -1 })
                .limit(50)
                .toArray();
            return res.status(200).json({ ok: true, videos });
        }

        if (type === 'tasks') {
            res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
            const tasks = await db.collection('tasks')
                .find({ isApproved: true })
                .sort({ createdAt: -1 })
                .limit(50)
                .toArray();
            return res.status(200).json({ ok: true, tasks });
        }

        return res.status(400).json({ ok: false, error: 'unknown_type' });
    } catch (err) {
        console.error('data error:', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
}
