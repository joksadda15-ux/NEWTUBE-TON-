// api/gift.js — New — endpoint to check and claim admin-sent surprise gifts
//
//   GET  /api/gift?action=check&initData=...              → returns the oldest pending gift, if any
//   POST /api/gift   { action:'claim', initData, giftId }  → claims the gift and credits the balance
//
// ⚠️ NEW — GigaPub server-to-server (S2S) postback receiver, MERGED into this file
// (Vercel Hobby plan = max 12 serverless functions, so no separate api/postback.js):
//   GET  /api/gift?network=gigapub&uid={user_id}&event=ad_shown&token=<POSTBACK_SECRET>
//   GigaPub calls this from THEIR server after an ad is shown. We MUST always answer
//   HTTP 200 (their rule) — every path of the postback handler returns 200, even for a
//   bad token / bad params (those are simply not recorded).
//   LOG MODE ONLY: records each valid postback in `gigaPostbacks` (auto-deleted after
//   7 days) and changes NOTHING about rewards. Needs env var POSTBACK_SECRET in Vercel.

import { connectToDatabase } from '../lib/mongodb.js';
import { cyInc, cyMin } from '../lib/cycleStats.js'; // 18 Oct 2026 — cycle counters
import { ObjectId } from 'mongodb';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import crypto from 'crypto';

async function handleCheck(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const gift = await db.collection('gifts').findOne(
        { userId, status: 'pending' },
        { sort: { createdAt: 1 } }
    );

    if (!gift) return res.status(200).json({ ok: true, gift: null });
    return res.status(200).json({ ok: true, gift: { id: gift._id, amount: gift.amount, reason: gift.reason } });
}

async function handleClaim(req, res, db) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { giftId } = req.body;
    if (!giftId) return res.status(400).json({ ok: false, error: 'missing_fields' });

    let giftObjId;
    try { giftObjId = new ObjectId(giftId); } catch { return res.status(400).json({ ok: false, error: 'invalid_gift_id' }); }

    const gifts = db.collection('gifts');
    const users = db.collection('users');

    // ── ATOMIC — claim gated on status: 'pending' to prevent the same gift being claimed twice ──
    const gate = await gifts.findOneAndUpdate(
        { _id: giftObjId, userId, status: 'pending' },
        { $set: { status: 'claimed', claimedAt: new Date() } },
        { returnDocument: 'after' }
    );
    if (!gate) return res.status(400).json({ ok: false, error: 'already_claimed_or_not_found' });

    const user = await users.findOne({ _id: userId }, { projection: { isBanned: 1 } });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    await users.updateOne({ _id: userId }, { $inc: { wtcBalance: gate.amount, lifetimeWtcEarned: gate.amount, ...cyInc('gift', gate.amount) }, $min: cyMin() });

    return res.status(200).json({ ok: true, amount: gate.amount });
}

// ── GigaPub S2S postback (log mode) ─────────────────────────────────────────
let postbackIndexReady = false;

function postbackSafeEqual(a, b) {
    const A = Buffer.from(String(a || ''));
    const B = Buffer.from(String(b || ''));
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
}

async function handlePostback(req, res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    try {
        const secret = process.env.POSTBACK_SECRET;
        if (!secret) {
            console.error('postback: POSTBACK_SECRET env var is not set — nothing recorded');
            return res.status(200).send('ok');
        }

        const q = req.query || {};
        const network = String(q.network || '').toLowerCase();
        const uid = String(q.uid || '').trim();
        const event = String(q.event || '').trim();

        if (network !== 'gigapub' || event !== 'ad_shown' || !/^\d{1,15}$/.test(uid) || !postbackSafeEqual(q.token, secret)) {
            return res.status(200).send('ok'); // always 200, record nothing
        }

        const { db } = await connectToDatabase();
        const col = db.collection('gigaPostbacks');
        if (!postbackIndexReady) {
            await col.createIndex({ receivedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
            await col.createIndex({ uid: 1, receivedAt: -1 });
            postbackIndexReady = true;
        }
        await col.insertOne({
            uid,
            event,
            network,
            receivedAt: new Date(),
            ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
        });
        return res.status(200).send('ok');
    } catch (e) {
        console.error('postback error:', e.message);
        return res.status(200).send('ok'); // never fail the caller
    }
}

export default async function handler(req, res) {
    // ⚠️ NEW — GigaPub postback is checked FIRST and has its own try/catch,
    // so a DB hiccup can never turn it into a non-200 answer.
    if (req.method === 'GET' && req.query?.network) return handlePostback(req, res);

    const { db } = await connectToDatabase();

    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'check') return handleCheck(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    if (req.method === 'POST') {
        const { action } = req.body || {};
        if (action === 'claim') return handleClaim(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
        }
