// api/broadcast.js
// POST /api/broadcast
// Headers: { x-admin-secret: "..." }
// Body: { message, target }
//
// Arrow/Batch System:
// - Users কে 50টি করে batch এ message পাঠায়
// - প্রতি batch এর মাঝে 500ms delay → Telegram rate limit এড়ানো
// - Firebase থেকে শুধু userId গুলো পড়ে, পুরো user document নয়
//   → Firebase read count অনেক কম হয়

const { getDb } = require('./utils/firebase');
const { handleCors } = require('./utils/cors');

const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const BATCH_SIZE   = 50;   // per batch
const BATCH_DELAY  = 500;  // ms between batches

module.exports = async function handler(req, res) {
    if (handleCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

    // Auth check
    const secret = req.headers['x-admin-secret'];
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
        return res.status(403).json({ ok: false, message: 'Unauthorized' });
    }

    const { message, target = 'all' } = req.body || {};
    if (!message || message.length < 5) {
        return res.status(400).json({ ok: false, message: 'Message too short' });
    }
    if (message.length > 1000) {
        return res.status(400).json({ ok: false, message: 'Message too long (max 1000 chars)' });
    }
    if (!BOT_TOKEN) {
        return res.status(500).json({ ok: false, message: 'BOT_TOKEN not configured' });
    }

    const db = getDb();

    try {
        // ── Fetch user IDs only (minimal Firebase reads) ──
        let q = db.collection('users').select('adsWatchedToday', 'withdrawalCount', 'isBanned');

        // Apply target filter
        // Note: Firestore doesn't support complex OR in one query easily,
        // so we do lightweight filtering after fetch.
        const snap = await q.limit(5000).get();

        const userIds = [];
        snap.forEach(doc => {
            const u = doc.data();
            if (u.isBanned) return;

            if (target === 'active') {
                if ((u.adsWatchedToday || 0) < 1 && (u.lifetimeAdsWatched || 0) < 5) return;
            }
            if (target === 'no_withdraw') {
                if ((u.withdrawalCount || 0) > 0) return;
            }

            userIds.push(doc.id);
        });

        const total = userIds.length;
        let sent = 0;
        let failed = 0;

        // ── Arrow Batch System ──
        // Split into batches of BATCH_SIZE
        for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
            const batch = userIds.slice(i, i + BATCH_SIZE);

            // Send to all users in this batch concurrently
            await Promise.all(batch.map(async (userId) => {
                try {
                    const tgRes = await fetch(
                        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                chat_id:    userId,
                                text:       message,
                                parse_mode: 'HTML',
                                reply_markup: {
                                    inline_keyboard: [[
                                        { text: '🎮 Open NEWTUBE', url: 'http://t.me/NewTube12_bot/WatchTo_Earn' }
                                    ]]
                                }
                            }),
                            signal: AbortSignal.timeout(8000),
                        }
                    );
                    const data = await tgRes.json();
                    if (data.ok) { sent++; } else { failed++; }
                } catch (e) {
                    failed++;
                }
            }));

            // Delay between batches to avoid Telegram rate limit
            if (i + BATCH_SIZE < userIds.length) {
                await sleep(BATCH_DELAY);
            }
        }

        return res.status(200).json({
            ok: true,
            total,
            sent,
            failed,
            message: `Broadcast complete. Sent: ${sent}, Failed: ${failed}`,
        });

    } catch (err) {
        console.error('broadcast error:', err);
        return res.status(500).json({ ok: false, message: err.message });
    }
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
