// api/data.js — নতুন (পরে UI বানানোর সময় লাগবে)
//
// নতুন UI-তে video section আর task list দেখানোর জন্য পাবলিক read-only ডেটা।
//   GET /api/data?type=videos
//   GET /api/data?type=tasks
//   GET /api/data?type=leaderboard   (lifetimeWtcEarned অনুযায়ী টপ ২০)

import { connectToDatabase } from '../lib/mongodb.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    try {
        const { type } = req.query;
        const { db } = await connectToDatabase();

        if (type === 'videos') {
            const videos = await db.collection('videos')
                .find({ isActive: true })
                .sort({ createdAt: -1 })
                .limit(50)
                .toArray();
            return res.status(200).json({ ok: true, videos });
        }

        if (type === 'tasks') {
            const tasks = await db.collection('tasks')
                .find({ isApproved: true })
                .sort({ createdAt: -1 })
                .limit(50)
                .toArray();
            return res.status(200).json({ ok: true, tasks });
        }

        if (type === 'leaderboard') {
            // ফিক্স: আগে ভুলে lifetimeWtcEarned দিয়ে সর্ট হতো, কিন্তু লেবেল ছিল "Top Referrer" —
            // এখন আসল referralCount দিয়েই সর্ট ও দেখানো হচ্ছে
            const top = await db.collection('users')
                .find({ isBanned: { $ne: true } })
                .project({ telegramUsername: 1, firstName: 1, referralCount: 1 })
                .sort({ referralCount: -1 })
                .limit(20)
                .toArray();
            return res.status(200).json({ ok: true, leaderboard: top });
        }

        return res.status(400).json({ ok: false, error: 'unknown_type' });
    } catch (err) {
        console.error('data error:', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
}
