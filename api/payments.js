// api/payments.js — ⚠️ MERGED (this update) — Vercel's Hobby/free plan caps
// a project at 12 serverless functions total, and this project was already
// at 11 before any of this TON-payment work. Rather than add 4 new files
// (api/punchkey.js, api/taskcreate.js, api/cron/checkPunchKeyDeposits.js,
// api/cron/checkTaskCreateDeposits.js) and blow past the cap, all four are
// combined into this ONE file. Nothing about the underlying design
// changed — separate DB collections (punchKeyOrders / taskCreateOrders),
// separate memo prefixes ("PK"/"TC"), separate validation — this file is
// just a thin dispatcher on top of the same logic, split into clearly
// marked sections below. If you're ever on a plan without the function
// cap, these sections can be split back into their own files verbatim
// with zero behavior change.
//
// ── user-facing endpoints (called by the Mini App, index.html) ──
//   POST /api/payments   { resource:'punchkey',   action:'create'|'cancel', initData, ... }
//   GET  /api/payments?resource=punchkey&action=status&initData=...&orderId=...
//   POST /api/payments   { resource:'taskcreate', action:'create'|'cancel', initData, ... }
//   GET  /api/payments?resource=taskcreate&action=status|myTasks&initData=...&orderId=...
//
// ── cron entry point (called by an EXTERNAL cron service, e.g. cron-job.org —
//    Vercel's own Cron Triggers only run once/day on the Hobby plan, far
//    too slow for a "credited within 1-5 minutes" promise) ──
//   POST /api/payments?cron=checkDeposits
//   Header: Authorization: Bearer <CRON_SECRET>
//   Runs BOTH the Punch Key and Create Task on-chain deposit checks in one
//   request — this also means only ONE cron-job.org schedule is needed
//   total, instead of two.

import { connectToDatabase } from '../lib/mongodb.js';
import { ObjectId } from 'mongodb';
import { tgSend } from '../lib/telegram.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    PUNCH_KEY_PRICE_NANOTON, PUNCH_KEY_ORDER_EXPIRY_MINUTES, PUNCH_KEY_MAX_PURCHASES,
    TASK_CREATE_PACKAGES, TASK_CREATE_ORDER_EXPIRY_MINUTES, TASK_CREATE_REWARD_PER_TASK_WTC,
} from '../lib/constants.js';
import { TON_RECEIVE_ADDRESS, randomTonMemo, buildTonDeepLink, fetchRecentTonTransactions } from '../lib/tonPay.js';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
const TASK_MODERATOR_ID = process.env.TASK_MODERATOR_ID;
// A payment is accepted if it's at least this fraction of the sticker
// price — a small tolerance for any wallet-side rounding of nanoTON.
// ASSUMED 97% (not specified) — tune freely. Shared by both cron checks below.
const MIN_ACCEPT_RATIO = 0.97;

// ════════════════════════════════════════════════════════════════════
// PUNCH KEY — buy a valid-referral credit directly with TON, instead of
// waiting for an organic referral to finish all 3 milestones (see
// lib/referral.js). Fixed price regardless of TON/USD swings
// (PUNCH_KEY_PRICE_NANOTON in lib/constants.js). Was api/punchkey.js.
// ════════════════════════════════════════════════════════════════════

// 'PK' + 6 random base36 chars, e.g. "PK7X9K2A" — short enough to type by
// hand if a wallet's deep-link prefill ever fails, but with enough entropy
// (36^6 ≈ 2.1 billion combos) that a real collision is a non-issue; the
// unique index on `memo` (models/schema.js) is the actual backstop.
const pkRandomMemo = () => randomTonMemo('PK');

function pkOrderResponse(order) {
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

async function pkHandleCreate(req, res, db) {
    if (!TON_RECEIVE_ADDRESS) {
        // ⚠️ misconfigured deploy (env var not set) — fail loud instead of
        // creating an order nobody can actually pay into.
        console.error('payments/punchkey create: TON_RECEIVE_ADDRESS env var not set');
        return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    }
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const users = db.collection('users');
    const orders = db.collection('punchKeyOrders');

    const user = await users.findOne({ _id: userId }, { projection: { isBanned: 1, punchKeysPurchased: 1 } });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    // ⚠️ NEW — lifetime cap on Punch Key purchases (see PUNCH_KEY_MAX_PURCHASES,
    // lib/constants.js). Checked here (before an order can even be created) —
    // the counter itself only increments on CONFIRMED payment (see
    // cronCheckPunchKey below), so this can't be bypassed by creating orders
    // that never get paid.
    if ((user.punchKeysPurchased || 0) >= PUNCH_KEY_MAX_PURCHASES) {
        return res.status(400).json({ ok: false, error: 'punch_key_limit_reached', limit: PUNCH_KEY_MAX_PURCHASES });
    }

    // ── resume an existing still-valid pending order instead of making a
    // new one — one pending order per user at a time, so memos can't pile
    // up unbounded from someone repeatedly tapping "Buy". ──
    const now = new Date();
    const existing = await orders.findOne({ userId, status: 'pending', expiresAt: { $gt: now } });
    if (existing) return res.status(200).json(pkOrderResponse(existing));

    const expiresAt = new Date(now.getTime() + PUNCH_KEY_ORDER_EXPIRY_MINUTES * 60 * 1000);

    let order = null;
    // A memo collision is astronomically unlikely (see pkRandomMemo above),
    // but retry a couple of times on the freak chance rather than fail the
    // whole request — the unique index on `memo` is what actually catches it.
    for (let attempt = 0; attempt < 3 && !order; attempt++) {
        try {
            const doc = {
                userId,
                memo: pkRandomMemo(),
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

    return res.status(200).json(pkOrderResponse(order));
}

async function pkHandleStatus(req, res, db) {
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

async function pkHandleCancel(req, res, db) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    let objId;
    try { objId = new ObjectId(orderId); } catch { return res.status(400).json({ ok: false, error: 'invalid_order_id' }); }

    // ⚠️ Cancelling here is a UI convenience only — if the user actually
    // sends the TON anyway after tapping Cancel, the cron check below will
    // find no 'pending' order left to match against, so a late payment
    // against a cancelled order is NOT auto-credited. The frontend shows a
    // confirmation warning about exactly this before calling here.
    await db.collection('punchKeyOrders').updateOne(
        { _id: objId, userId, status: 'pending' },
        { $set: { status: 'expired', expiredAt: new Date(), cancelledByUser: true } }
    );
    return res.status(200).json({ ok: true });
}

async function punchkeyRouter(req, res, db) {
    if (req.method === 'POST') {
        const { action } = req.body || {};
        if (action === 'create') return pkHandleCreate(req, res, db);
        if (action === 'cancel') return pkHandleCancel(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
    if (req.method === 'GET') {
        if (req.query.action === 'status') return pkHandleStatus(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}

// ════════════════════════════════════════════════════════════════════
// CREATE TASK — a user pays TON to get their OWN task queued for admin
// review, and once approved (api/bot.js "🕐 Pending Review"), it goes live
// in the Exclusive task section. This section NEVER inserts the real task
// itself — that only happens in the cron section further down, once
// payment is independently verified on-chain. Was api/taskcreate.js.
// ════════════════════════════════════════════════════════════════════

const TC_MAX_TITLE_LENGTH = 80;

const tcRandomMemo = () => randomTonMemo('TC');

function tcOrderResponse(order) {
    const deepLink = buildTonDeepLink(order.amountNanoTon, order.memo);
    return {
        ok: true,
        order: {
            id: String(order._id),
            memo: order.memo,
            amountNanoTon: order.amountNanoTon,
            taskCount: order.taskCount,
            address: TON_RECEIVE_ADDRESS,
            status: order.status,
            expiresAt: order.expiresAt,
            deepLink,
        },
    };
}

// Validates + normalizes the task draft the user is paying to publish.
// Mirrors api/bot.js's admin add-task flow's own channelId/url conventions
// exactly (e.g. auto-prefixing '@', deriving the t.me link) so a
// user-created task is indistinguishable in shape from an admin one.
function tcBuildDraft(body) {
    const title = String(body.title || '').trim();
    if (!title) return { error: 'missing_fields' };
    if (title.length > TC_MAX_TITLE_LENGTH) return { error: 'title_too_long' };

    const verifyType = body.verifyType === 'api' ? 'api' : (body.verifyType === 'link' ? 'link' : null);
    if (!verifyType) return { error: 'missing_fields' };

    if (verifyType === 'api') {
        let channelUsername = String(body.channelUsername || '').trim().replace(/^@/, '');
        // also accept a pasted https://t.me/<name> link
        const tMeMatch = channelUsername.match(/t\.me\/([a-zA-Z0-9_]+)/);
        if (tMeMatch) channelUsername = tMeMatch[1];
        if (!channelUsername) return { error: 'missing_fields' };
        const channelId = `@${channelUsername}`;
        return { draft: { title, verifyType, channelId, url: `https://t.me/${channelUsername}` } };
    }

    // verifyType === 'link'
    const url = String(body.url || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) return { error: 'invalid_url' };
    return { draft: { title, verifyType, channelId: null, url } };
}

async function tcHandleCreate(req, res, db) {
    if (!TON_RECEIVE_ADDRESS) {
        console.error('payments/taskcreate create: TON_RECEIVE_ADDRESS env var not set');
        return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    }
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const users = db.collection('users');
    const orders = db.collection('taskCreateOrders');

    const user = await users.findOne({ _id: userId }, { projection: { isBanned: 1 } });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const pkg = TASK_CREATE_PACKAGES[String(req.body?.package)];
    if (!pkg) return res.status(400).json({ ok: false, error: 'invalid_package' });

    const { draft, error } = tcBuildDraft(req.body || {});
    if (error) return res.status(400).json({ ok: false, error });

    // ── one pending order per user at a time (same reasoning as Punch Key above) ──
    const now = new Date();
    const existing = await orders.findOne({ userId, status: 'pending', expiresAt: { $gt: now } });
    if (existing) return res.status(200).json(tcOrderResponse(existing));

    const expiresAt = new Date(now.getTime() + TASK_CREATE_ORDER_EXPIRY_MINUTES * 60 * 1000);

    let order = null;
    for (let attempt = 0; attempt < 3 && !order; attempt++) {
        try {
            const doc = {
                userId,
                memo: tcRandomMemo(),
                package: String(req.body.package),
                taskCount: pkg.taskCount,
                amountNanoTon: pkg.priceNanoTon,
                draft,
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

    return res.status(200).json(tcOrderResponse(order));
}

async function tcHandleStatus(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { orderId } = req.query;
    if (!orderId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    let objId;
    try { objId = new ObjectId(orderId); } catch { return res.status(400).json({ ok: false, error: 'invalid_order_id' }); }

    const order = await db.collection('taskCreateOrders').findOne({ _id: objId, userId });
    if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });

    return res.status(200).json({ ok: true, status: order.status, expiresAt: order.expiresAt });
}

async function tcHandleCancel(req, res, db) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    let objId;
    try { objId = new ObjectId(orderId); } catch { return res.status(400).json({ ok: false, error: 'invalid_order_id' }); }

    // ⚠️ same caveat as Punch Key's cancel above — a late payment against a
    // cancelled order is NOT auto-credited, the frontend warns about this.
    await db.collection('taskCreateOrders').updateOne(
        { _id: objId, userId, status: 'pending' },
        { $set: { status: 'expired', expiredAt: new Date(), cancelledByUser: true } }
    );
    return res.status(200).json({ ok: true });
}

async function tcHandleMyTasks(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const taskDocs = await db.collection('tasks')
        .find({ createdBy: userId, isUserCreated: true })
        .project({ title: 1, limit: 1, completionCount: 1, createdAt: 1, completedAt: 1, category: 1, isApproved: 1, reviewStatus: 1 })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();

    return res.status(200).json({ ok: true, tasks: taskDocs });
}

async function taskcreateRouter(req, res, db) {
    if (req.method === 'POST') {
        const { action } = req.body || {};
        if (action === 'create') return tcHandleCreate(req, res, db);
        if (action === 'cancel') return tcHandleCancel(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'status') return tcHandleStatus(req, res, db);
        if (action === 'myTasks') return tcHandleMyTasks(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}

// ════════════════════════════════════════════════════════════════════
// CRON — verifies BOTH Punch Key and Create Task TON payments ON-CHAIN in
// one run. Nothing about a payment is ever trusted from the client — this
// is the ONLY place a punchKeyOrders/taskCreateOrders doc is ever allowed
// to flip 'pending' → 'paid'. Was api/cron/checkPunchKeyDeposits.js +
// api/cron/checkTaskCreateDeposits.js.
//
// No separate "already-processed transaction" table is needed for either
// half — the atomic status:'pending'→'paid' gate on each ORDER itself is
// what prevents double-crediting (same pattern as the atomic gates in
// lib/referral.js).
// ════════════════════════════════════════════════════════════════════

async function cronCheckPunchKey(db, txs, now) {
    const orders = db.collection('punchKeyOrders');
    const users = db.collection('users');

    const expireResult = await orders.updateMany(
        { status: 'pending', expiresAt: { $lte: now } },
        { $set: { status: 'expired', expiredAt: now } }
    );

    const pendingCount = await orders.countDocuments({ status: 'pending' });
    if (pendingCount === 0) return { expired: expireResult.modifiedCount, matched: 0 };

    let matched = 0;
    for (const tx of txs) {
        const inMsg = tx.in_msg;
        if (!inMsg || !inMsg.message) continue; // no comment → can't belong to any order
        const memo = String(inMsg.message).trim();
        if (!memo.startsWith('PK')) continue; // not one of ours — skip fast without a DB round-trip
        const receivedNanoTon = Number(inMsg.value || 0);
        if (!receivedNanoTon) continue;

        const order = await orders.findOne({ memo, status: 'pending' });
        if (!order) continue; // no matching pending order (already paid/expired/never existed)
        const requiredNanoTon = order.amountNanoTon || PUNCH_KEY_PRICE_NANOTON;
        if (receivedNanoTon < requiredNanoTon * MIN_ACCEPT_RATIO) continue; // underpaid — leave pending; a top-up tx before expiry would still match on a later run

        const txHash = tx.transaction_id?.hash || null;

        // ⚠️ ATOMIC — gated on status:'pending' so this exact order can
        // never be credited twice, no matter how many times this loop (or
        // a concurrent/later cron run) sees the same transaction.
        const claimed = await orders.findOneAndUpdate(
            { _id: order._id, status: 'pending' },
            { $set: { status: 'paid', paidAt: now, txHash, receivedNanoTon } },
            { returnDocument: 'after' }
        );
        if (!claimed) continue; // lost the race to another concurrent run — already credited

        const userUpdate = await users.findOneAndUpdate(
            { _id: claimed.userId, isBanned: { $ne: true } },
            { $inc: { validReferralCount: 1, punchKeysPurchased: 1 } }, // ⚠️ CHANGED — also tracks lifetime purchase count for PUNCH_KEY_MAX_PURCHASES
            { returnDocument: 'after' }
        );
        if (userUpdate) {
            matched++;
            tgSend(claimed.userId,
                `✅ <b>Punch Key কেনা সফল হয়েছে!</b>\n\n` +
                `আপনার পেমেন্ট কনফার্ম হয়েছে এবং <b>+1 Valid Referral</b> যোগ হয়েছে — এখন এটা দিয়ে withdraw করতে পারবেন। 🎉`
            ).catch(() => {});
        }
        // Note: if the user turned out to be banned in the meantime, the
        // order still correctly shows 'paid' (they did pay), it's just not
        // credited to a banned account — no silent fund loss on our side
        // to reconcile, and nothing here refunds TON automatically.
    }
    return { expired: expireResult.modifiedCount, matched };
}

async function cronCheckTaskCreate(db, txs, now) {
    const orders = db.collection('taskCreateOrders');
    const tasks = db.collection('tasks');

    const expireResult = await orders.updateMany(
        { status: 'pending', expiresAt: { $lte: now } },
        { $set: { status: 'expired', expiredAt: now } }
    );

    const pendingCount = await orders.countDocuments({ status: 'pending' });
    if (pendingCount === 0) return { expired: expireResult.modifiedCount, matched: 0 };

    let matched = 0;
    for (const tx of txs) {
        const inMsg = tx.in_msg;
        if (!inMsg || !inMsg.message) continue; // no comment → can't belong to any order
        const memo = String(inMsg.message).trim();
        if (!memo.startsWith('TC')) continue; // not one of ours — skip fast without a DB round-trip
        const receivedNanoTon = Number(inMsg.value || 0);
        if (!receivedNanoTon) continue;

        const order = await orders.findOne({ memo, status: 'pending' });
        if (!order) continue; // no matching pending order (already paid/expired/never existed)
        if (receivedNanoTon < order.amountNanoTon * MIN_ACCEPT_RATIO) continue; // underpaid — leave pending until it expires

        const txHash = tx.transaction_id?.hash || null;

        // ⚠️ ATOMIC — gated on status:'pending' so this exact order (and
        // therefore the task insert below) can never fire twice, no matter
        // how many times this loop or a later run sees the tx again.
        const claimed = await orders.findOneAndUpdate(
            { _id: order._id, status: 'pending' },
            { $set: { status: 'paid', paidAt: now, txHash, receivedNanoTon } },
            { returnDocument: 'after' }
        );
        if (!claimed) continue; // lost the race to another concurrent run — already handled

        // ── publish the task doc as pending-review, exactly once, gated
        // behind the atomic flip above — see api/bot.js "🕐 Pending Review" ──
        const taskDoc = {
            title: claimed.draft.title,
            url: claimed.draft.url,
            channelId: claimed.draft.channelId,
            category: 'exclusive',
            verifyType: claimed.draft.verifyType,
            rewardWtc: TASK_CREATE_REWARD_PER_TASK_WTC,
            rewardCurrency: 'wtc',
            rewardUsdt: null,
            limit: claimed.taskCount,
            completionCount: 0,
            isApproved: false, // ⚠️ NOT live yet — see reviewStatus below
            reviewStatus: 'pending_review',
            createdAt: now,
            createdBy: claimed.userId,
            isUserCreated: true, // gates the 5-day post-completion TTL (models/schema.js), distinguishes from admin-created tasks with the same shape
        };
        const insertResult = await tasks.insertOne(taskDoc);
        await orders.updateOne({ _id: claimed._id }, { $set: { createdTaskId: insertResult.insertedId } });

        matched++;
        // ⚠️ CHANGED (admin request) — task-marketplace notifications
        // switched from Bangla to English.
        tgSend(claimed.userId,
            `✅ <b>Payment Confirmed!</b>\n\n` +
            `📋 ${taskDoc.title}\n` +
            `👥 ${taskDoc.limit} people will be able to complete it (+${TASK_CREATE_REWARD_PER_TASK_WTC} WTC each)\n\n` +
            `⏳ It's now waiting for admin review — once approved, it'll go live for everyone in the "⭐ Exclusive" tab. 🎉`
        ).catch(() => {});

        // ⚠️ ping admin + task moderator so a paid task doesn't sit
        // unnoticed in the queue. Best-effort, doesn't block the loop.
        const reviewMsg =
            `🆕 <b>নতুন Task Review-এর জন্য অপেক্ষা করছে</b>\n\n` +
            `📋 ${taskDoc.title}\n` +
            `🔗 ${taskDoc.url}\n` +
            `👤 Type: ${taskDoc.verifyType === 'api' ? 'Channel/Group Join (API)' : 'Link'}\n` +
            `👥 ${taskDoc.limit} slots · 💰 ${taskDoc.rewardWtc} WTC/জন\n\n` +
            `Admin panel থেকে "🕐 Pending Review" এ গিয়ে approve/reject করুন।`;
        if (ADMIN_ID) tgSend(ADMIN_ID, reviewMsg).catch(() => {});
        if (TASK_MODERATOR_ID) tgSend(TASK_MODERATOR_ID, reviewMsg).catch(() => {});
    }
    return { expired: expireResult.modifiedCount, matched };
}

async function handleCronCheckDeposits(req, res, db) {
    const authHeader = req.headers['authorization'];
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    if (!TON_RECEIVE_ADDRESS) {
        console.error('payments cron checkDeposits: TON_RECEIVE_ADDRESS env var not set');
        return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    }

    try {
        const now = new Date();

        // Both order types share the SAME receiving wallet, so one
        // TonCenter fetch covers both checks below — no reason to hit the
        // API twice per cron run.
        const txs = await fetchRecentTonTransactions();

        const punchKeyResult = await cronCheckPunchKey(db, txs, now);
        const taskCreateResult = await cronCheckTaskCreate(db, txs, now);

        return res.status(200).json({
            ok: true,
            checked: txs.length,
            punchKey: punchKeyResult,
            taskCreate: taskCreateResult,
        });
    } catch (err) {
        console.error('payments cron checkDeposits error:', err);
        if (ADMIN_ID) {
            await tgSend(ADMIN_ID, `🚨 <b>TON Deposit Check FAILED</b>\n\n<code>${String(err?.message || err).slice(0, 500)}</code>`).catch(() => {});
        }
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
}

// ════════════════════════════════════════════════════════════════════
// TOP-LEVEL DISPATCH
// ════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    // ── cron: POST /api/payments?cron=checkDeposits ──
    if (req.method === 'POST' && req.query.cron === 'checkDeposits') {
        return handleCronCheckDeposits(req, res, db);
    }

    // ── user-facing: dispatched by `resource` (body for POST, query for GET) ──
    const resource = req.method === 'GET' ? req.query.resource : req.body?.resource;
    if (resource === 'punchkey') return punchkeyRouter(req, res, db);
    if (resource === 'taskcreate') return taskcreateRouter(req, res, db);
    return res.status(400).json({ ok: false, error: 'unknown_resource' });
}
