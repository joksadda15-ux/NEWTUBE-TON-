// api/data.js — নতুন UI-তে video section, task list, ও recent-withdrawals ticker-এর জন্য
// পাবলিক read-only ডেটা।
//   GET /api/data?type=videos
//   GET /api/data?type=tasks
//   GET /api/data?type=leaderboard        (referralCount অনুযায়ী টপ ২০)
//   GET /api/data?type=recentWithdrawals   (Home-এ "social proof" ticker-এর জন্য — সত্যিকারের approved withdraw, username মাস্ক করা)

import { connectToDatabase } from '../lib/mongodb.js';

// প্রাইভেসির জন্য username আংশিক মাস্ক করা হয় — যেমন "Rashu_Xansi" → "Ras***si"
function maskUsername(name) {
    if (!name || name === 'N/A') return 'User';
    if (name.length <= 4) return name[0] + '***';
    return name.slice(0, 3) + '***' + name.slice(-2);
}

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

        if (type === 'recentWithdrawals') {
            const recent = await db.collection('withdrawals')
                .find({ status: 'approved' })
                .project({ username: 1, cashAmount: 1, currency: 1, processedAt: 1 })
                .sort({ processedAt: -1 })
                .limit(15)
                .toArray();
            const items = recent.map(w => ({
                username: maskUsername(w.username),
                cashAmount: w.cashAmount,
                currency: w.currency,
            }));
            return res.status(200).json({ ok: true, items });
        }

        return res.status(400).json({ ok: false, error: 'unknown_type' });
    } catch (err) {
        console.error('data error:', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
}
