// api/punchkey.js — ⚠️ NEW — "Punch Key" = buy a valid-referral credit
// directly with TON, instead of waiting for an organic referral to finish
// all 3 milestones (see lib/referral.js). Fixed price regardless of TON/USD
// swings (PUNCH_KEY_PRICE_NANOTON in lib/constants.js).
//
// This endpoint NEVER credits anything itself — it only creates/reads
// orders. Payment is verified fully on-chain by
// api/cron/checkPunchKeyDeposits.js (polls TonCenter every ~1 min via an
// EXTERNAL cron — see that file's header for why). Each order gets a
// unique `memo` (TON transfer comment) the user must include — that's the
// only way to tell WHICH user a given incoming transaction belongs to,
// since there's just one single receiving wallet shared by everyone.
//
//   POST /api/punchkey   { action:'create', initData }             → creates (or resumes) a pending order
//   GET  /api/punchkey?action=status&initData=...&orderId=...      → poll this order's current status
//   POST /api/punchkey   { action:'cancel', initData, orderId }    → user-initiated early cancel

import { connectToDatabase } from '../lib/mongodb.js';
import { ObjectId } from 'mongodb';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { PUNCH_KEY_PRICE_NANOTON, PUNCH_KEY_ORDER_EXPIRY_MINUTES } from '../lib/constants.js';
import { TON_RECEIVE_ADDRESS, randomTonMemo, buildTonDeepLink } from '../lib/tonPay.js';

// 'PK' + 6 random base36 chars, e.g. "PK7X9K2A" — short enough to type by
// hand if a wallet's deep-link prefill ever fails, but with enough entropy
// (36^6 ≈ 2.1 billion combos) that a real collision is a non-issue; the
// unique index on `memo` (models/schema.js) is the actual backstop.
const randomMemo = () => randomTonMemo('PK');

function orderResponse(order) {
    const deepLink = buildTonDeepLink(order.amountNanoTon, order.memo);
    return {
        ok: true,
        order: {
            id: String(order._id),
            memo: order.memo,
            amountNanoTon: order.amountNanoTon,
            address: TON_RECEIVE_ADDRESS,
            status: order.status,
            expiresAt: order.expiresAt,
            deepLink,
        },
    };
}

async function handleCreate(req, res, db) {
    if (!TON_RECEIVE_ADDRESS) {
        // ⚠️ misconfigured deploy (env var not set) — fail loud instead of
        // creating an order nobody can actually pay into.
        console.error('punchkey handleCreate: TON_RECEIVE_ADDRESS env var not set');
        return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    }
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const users = db.collection('users');
    const orders = db.collection('punchKeyOrders');

    const user = await users.findOne({ _id: userId }, { projection: { isBanned: 1 } });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    // ── resume an existing still-valid pending order instead of making a
    // new one — one pending order per user at a time, so memos can't pile
    // up unbounded from someone repeatedly tapping "Buy". ──
    const now = new Date();
    const existing = await orders.findOne({ userId, status: 'pending', expiresAt: { $gt: now } });
    if (existing) return res.status(200).json(orderResponse(existing));

    const expiresAt = new Date(now.getTime() + PUNCH_KEY_ORDER_EXPIRY_MINUTES * 60 * 1000);

    let order = null;
    // A memo collision is astronomically unlikely (see randomMemo above),
    // but retry a couple of times on the freak chance rather than fail the
    // whole request — the unique index on `memo` is what actually catches it.
    for (let attempt = 0; attempt < 3 && !order; attempt++) {
        try {
            const doc = {
                userId,
                memo: randomMemo(),
                amountNanoTon: PUNCH_KEY_PRICE_NANOTON,
                status: 'pending',
                createdAt: now,
                expiresAt,
            };
            const result = await orders.insertOne(doc);
            order = { ...doc, _id: result.insertedId };
        } catch (e) {
            if (e?.code === 11000 && attempt < 2) continue; // duplicate memo — retry with a fresh one
            throw e;
        }
    }
    if (!order) return res.status(500).json({ ok: false, error: 'server_error' });

    return res.status(200).json(orderResponse(order));
}

async function handleStatus(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { orderId } = req.query;
    if (!orderId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    let objId;
    try { objId = new ObjectId(orderId); } catch { return res.status(400).json({ ok: false, error: 'invalid_order_id' }); }

    const order = await db.collection('punchKeyOrders').findOne({ _id: objId, userId });
    if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });

    return res.status(200).json({ ok: true, status: order.status, expiresAt: order.expiresAt });
}

async function handleCancel(req, res, db) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    let objId;
    try { objId = new ObjectId(orderId); } catch { return res.status(400).json({ ok: false, error: 'invalid_order_id' }); }

    // ⚠️ Cancelling here is a UI convenience only — if the user actually
    // sends the TON anyway after tapping Cancel, the cron's on-chain check
    // will find no 'pending' order left to match against, so a late
    // payment against a cancelled order is NOT auto-credited. The frontend
    // shows a confirmation warning about exactly this before calling here.
    await db.collection('punchKeyOrders').updateOne(
        { _id: objId, userId, status: 'pending' },
        { $set: { status: 'expired', expiredAt: new Date(), cancelledByUser: true } }
    );
    return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    if (req.method === 'POST') {
        const { action } = req.body || {};
        if (action === 'create') return handleCreate(req, res, db);
        if (action === 'cancel') return handleCancel(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'status') return handleStatus(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}
