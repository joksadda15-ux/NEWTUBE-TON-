// api/data.js — public read-only data for the mini app.
//   GET /api/data?type=videos
//   GET /api/data?type=tasks
//   GET /api/data?type=leaderboard        (top 20 by referralCount)
//   GET /api/data?type=logo&task=<taskId>  (28 Oct 2026: a task's logo picture, taken from the photo the admin sent to the bot)

import { ObjectId } from 'mongodb';
import { connectToDatabase } from '../lib/mongodb.js';
import { tgApi } from '../lib/telegram.js';

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
            res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=1800, stale-while-revalidate=3600'); // 29 Oct 2026: videos rarely change → phone keeps it 2 min, edge 30 min
            const videos = await db.collection('videos')
                .find({ isActive: true })
                .sort({ createdAt: -1 })
                .limit(50)
                .toArray();
            return res.status(200).json({ ok: true, videos });
        }

        if (type === 'tasks') {
            res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600'); // 29 Oct 2026: phone keeps it 1 min, edge 5 min (was 2 min)
            const tasks = await db.collection('tasks')
                .find({ isApproved: true })
                .sort({ createdAt: -1 })
                .limit(50)
                .toArray();
            // 28 Oct 2026: task logo. A photo logo is served through ?type=logo (so the Telegram file id / bot token never reach the phone);
            // a link logo is passed as it is. The app shows `logo` if there is one.
            for (const t of tasks) {
                if (t.logoFileId) t.logo = `data?type=logo&task=${t._id}`;
                else if (t.logoUrl) t.logo = t.logoUrl;
                delete t.logoFileId;
                delete t.logoUrl;
            }
            return res.status(200).json({ ok: true, tasks });
        }

        if (type === 'logo') {
            let oid;
            try { oid = new ObjectId(String(req.query.task || '')); } catch { return res.status(400).json({ ok: false, error: 'bad_task' }); }
            const t = await db.collection('tasks').findOne({ _id: oid }, { projection: { logoFileId: 1 } });
            if (!t || !t.logoFileId) return res.status(404).json({ ok: false, error: 'no_logo' });
            const info = await tgApi('getFile', { file_id: t.logoFileId });
            const filePath = info?.result?.file_path;
            if (!filePath) return res.status(404).json({ ok: false, error: 'no_logo' });
            const img = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${filePath}`);
            if (!img.ok) return res.status(502).json({ ok: false, error: 'logo_fetch_failed' });
            const buf = Buffer.from(await img.arrayBuffer());
            const ext = String(filePath).split('.').pop().toLowerCase();
            res.setHeader('Content-Type', ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800'); // a logo almost never changes
            return res.status(200).send(buf);
        }

        return res.status(400).json({ ok: false, error: 'unknown_type' });
    } catch (err) {
        console.error('data error:', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
}
