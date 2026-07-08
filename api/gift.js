// api/gift.js — নতুন — অ্যাডমিনের পাঠানো surprise gift চেক ও claim করার endpoint
//
//   GET  /api/gift?action=check&initData=...              → pending gift (সবচেয়ে পুরনোটা) থাকলে ফেরত দেয়
//   POST /api/gift   { action:'claim', initData, giftId }  → gift claim করে balance-এ যোগ করে

import { connectToDatabase } from '../lib/mongodb.js';
import { ObjectId } from 'mongodb';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';

async function handleCheck(req, res, db) {
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

    // ── ATOMIC — status: 'pending' শর্তসহ claim, একই gift দুইবার claim হওয়া ঠেকাতে ──
    const gate = await gifts.findOneAndUpdate(
        { _id: giftObjId, userId, status: 'pending' },
        { $set: { status: 'claimed', claimedAt: new Date() } },
        { returnDocument: 'after' }
    );
    if (!gate) return res.status(400).json({ ok: false, error: 'already_claimed_or_not_found' });

    const user = await users.findOne({ _id: userId }, { projection: { isBanned: 1 } });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    await users.updateOne({ _id: userId }, { $inc: { wtcBalance: gate.amount, lifetimeWtcEarned: gate.amount } });

    return res.status(200).json({ ok: true, amount: gate.amount });
}

export default async function handler(req, res) {
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
