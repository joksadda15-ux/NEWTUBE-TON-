// api/payments.js — ⚠️ MERGED (this update) — Vercel's Hobby/free plan caps
// a project at 12 serverless functions total, and this project was already
// at 11 before any of this TON-payment work. Rather than add 4 new files
// (api/taskcreate.js, api/cron/checkTaskCreateDeposits.js) and blow past
// the cap, they are combined into this ONE file.
// ⚠️ REMOVED (update) — the "Punch Key" (buy a valid referral with TON)
// system was removed completely. Only Create Task payments remain here.
//
// ── user-facing endpoints (called by the Mini App, index.html) ──
//   POST /api/payments   { resource:'taskcreate', action:'create'|'cancel', initData, ... }
//   GET  /api/payments?resource=taskcreate&action=status|myTasks&initData=...&orderId=...
//
// ── cron entry point (called by an EXTERNAL cron service, e.g. cron-job.org —
//    Vercel's own Cron Triggers only run once/day on the Hobby plan, far
//    too slow for a "credited within 1-5 minutes" promise) ──
//   POST /api/payments?cron=checkDeposits
//   Header: Authorization: Bearer <CRON_SECRET>
//   Runs the Create Task on-chain deposit check.

import { connectToDatabase } from '../lib/mongodb.js';
import { ObjectId } from 'mongodb';
import { tgSend, tgApi } from '../lib/telegram.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { isCronAuthorized } from '../lib/cronAuth.js';
import {
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

// ⚠️ NEW — "Verify bot": confirms the NEWTUBE bot is really an admin in the
// channel/group the user typed, BEFORE they pay (and again inside create, so
// the check can't be skipped by calling the API directly). Fails closed.
let __tcBotId = null;
async function tcGetBotId() {
    if (__tcBotId) return __tcBotId;
    try {
        const r = await tgApi('getMe', {});
        if (r?.ok && r.result?.id) __tcBotId = r.result.id;
    } catch (e) { console.error('tcGetBotId failed:', e.message); }
    return __tcBotId;
}
async function tcCheckBotAdmin(channelId) {
    const botId = await tcGetBotId();
    if (!botId) return { ok: false, error: 'server_error' };
    let r;
    try { r = await tgApi('getChatMember', { chat_id: channelId, user_id: botId }); }
    catch (e) { return { ok: false, error: 'server_error' }; }
    if (!r?.ok || !['administrator', 'creator'].includes(r.result?.status)) return { ok: false, error: 'bot_not_admin' };
    let title = null;
    try { const c = await tgApi('getChat', { chat_id: channelId }); if (c?.ok) title = c.result?.title || null; } catch (e) {}
    return { ok: true, title };
}

async function tcHandleVerifyBot(req, res) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const { draft, error } = tcBuildDraft({ title: 'x', verifyType: 'api', channelUsername: req.body?.channelUsername });
    if (error) return res.status(400).json({ ok: false, error });
    const chk = await tcCheckBotAdmin(draft.channelId);
    if (!chk.ok) return res.status(200).json({ ok: false, error: chk.error });
    return res.status(200).json({ ok: true, channel: draft.channelId, title: chk.title });
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

    // ⚠️ NEW — channel/group tasks: bot must be admin there (fail closed), so nobody pays for a task that can never be verified
    if (draft.verifyType === 'api') {
        const chk = await tcCheckBotAdmin(draft.channelId);
        if (!chk.ok) return res.status(chk.error === 'server_error' ? 500 : 400).json({ ok: false, error: chk.error });
    }

    // ── one pending order per user at a time  ──
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

    // ⚠️ same caveat as any cancelled order — a late payment against a
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
        if (action === 'verifyBot') return tcHandleVerifyBot(req, res);
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
// CRON — verifies Create Task TON payments ON-CHAIN. Nothing about a payment is ever trusted from the client — this
// is the ONLY place a taskCreateOrders doc is ever allowed
// to flip 'pending' → 'paid'. Was api/cron/checkPunchKeyDeposits.js +
// api/cron/checkTaskCreateDeposits.js.
//
// No separate "already-processed transaction" table is needed for either
// half — the atomic status:'pending'→'paid' gate on each ORDER itself is
// what prevents double-crediting (same pattern as the atomic gates in
// lib/referral.js).
// ════════════════════════════════════════════════════════════════════

// 15 Oct 2026 — FIX "user paid (twice), nothing credited, no task":
//  1) a payment that arrived AFTER the 15-min order expiry (slow wallet confirm / cron delay) was ignored forever,
//     and the app then told the user "expired — try again", so they paid a 2nd time. Now a late payment still credits its order
//     (up to LATE_PAYMENT_GRACE_MS), unless the user explicitly cancelled that order.
//  2) the memo had to match character-for-character; now case / spaces / extra words around it are tolerated.
//  3) the old early-return skipped the matching step whenever no order was 'pending' — which is exactly when a late payment arrives.
//  4) every incoming payment that still can't be matched (unknown comment, underpaid, duplicate, cancelled, too old) is stored once
//     in `unmatchedTonDeposits` and the admin gets ONE Telegram alert with amount / comment / sender / tx hash — never silent again.
const LATE_PAYMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PACKAGE_NANOTON = Math.min(...Object.values(TASK_CREATE_PACKAGES).map(p => Number(p.priceNanoTon) || Infinity));
const tcEsc = (v) => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const TC_REASON_TEXT = {
    no_matching_order: 'No order matches this comment (missing / wrong comment, or not a Create Task payment)',
    underpaid: 'Paid LESS than the package price',
    duplicate_payment: 'Second payment for an order that is already paid (user paid twice)',
    order_cancelled_by_user: 'Order was cancelled by the user before this payment arrived',
    order_too_old: 'Order expired more than 7 days ago',
};

async function cronCheckTaskCreate(db, txs, now) {
    const orders = db.collection('taskCreateOrders');
    const tasks = db.collection('tasks');
    const unmatched = db.collection('unmatchedTonDeposits');

    const expireResult = await orders.updateMany(
        { status: 'pending', expiresAt: { $lte: now } },
        { $set: { status: 'expired', expiredAt: now } }
    );

    // incoming transfers only (outgoing payouts from the same wallet have no `source`)
    const incoming = [];
    for (const tx of txs) {
        const inMsg = tx.in_msg;
        if (!inMsg || !inMsg.source) continue;
        const value = Number(inMsg.value || 0);
        if (!value) continue;
        const text = String(inMsg.message || '').trim();
        const tokens = text.toUpperCase().split(/[^A-Z0-9]+/).filter(t => t.startsWith('TC') && t.length >= 4);
        incoming.push({ value, text, tokens, hash: tx.transaction_id?.hash || null, source: inMsg.source });
    }
    if (incoming.length === 0) return { expired: expireResult.modifiedCount, matched: 0, flagged: 0 };

    // two batched reads instead of one query per transaction
    const memos = [...new Set(incoming.flatMap(i => i.tokens))];
    const orderDocs = memos.length ? await orders.find({ memo: { $in: memos } }).toArray() : [];
    const byMemo = new Map(orderDocs.map(o => [o.memo, o]));
    const hashes = incoming.map(i => i.hash).filter(Boolean);
    const seenDocs = hashes.length ? await unmatched.find({ _id: { $in: hashes } }, { projection: { _id: 1 } }).toArray() : [];
    const seen = new Set(seenDocs.map(d => d._id));

    let flagged = 0;
    const flag = async (item, reason, order) => {
        if (!item.hash || seen.has(item.hash)) return; // already reported on an earlier run
        seen.add(item.hash);
        const r = await unmatched.updateOne(
            { _id: item.hash },
            { $setOnInsert: { reason, amountNanoTon: item.value, comment: item.text.slice(0, 200), source: item.source, orderId: order?._id || null, orderUserId: order?.userId || null, createdAt: now } },
            { upsert: true }
        );
        if (!r.upsertedCount) return;
        flagged++;
        if (ADMIN_ID) {
            tgSend(ADMIN_ID,
                `\u26a0\ufe0f <b>Unmatched TON deposit</b>\n\n` +
                `Reason: ${tcEsc(TC_REASON_TEXT[reason] || reason)}\n` +
                `Amount: <b>${(item.value / 1e9).toFixed(4)} TON</b>\n` +
                `Comment: <code>${tcEsc(item.text || '(none)')}</code>\n` +
                `From: <code>${tcEsc(item.source)}</code>\n` +
                (order ? `Order user: <code>${tcEsc(order.userId)}</code> \u00b7 expected ${(order.amountNanoTon / 1e9).toFixed(4)} TON\n` : '') +
                `Tx: <code>${tcEsc(item.hash)}</code>\n\n` +
                `Not credited automatically \u2014 please check and add the task manually if the payment is real.`
            ).catch(() => {});
        }
    };

    let matched = 0;
    for (const item of incoming) {
        const order = item.tokens.map(t => byMemo.get(t)).find(Boolean);
        if (!order) {
            // only worth an alert if it is big enough to be a Create Task package
            if (item.value >= MIN_PACKAGE_NANOTON * MIN_ACCEPT_RATIO) await flag(item, 'no_matching_order', null);
            continue;
        }
        if (order.status === 'paid') {
            if (!order.txHash || order.txHash === item.hash) continue; // normal: this is the very tx that paid it
            await flag(item, 'duplicate_payment', order);
            continue;
        }
        if (item.value < order.amountNanoTon * MIN_ACCEPT_RATIO) { await flag(item, 'underpaid', order); continue; }
        if (order.cancelledByUser) { await flag(item, 'order_cancelled_by_user', order); continue; }
        if (order.status === 'expired' && order.expiresAt && now.getTime() - new Date(order.expiresAt).getTime() > LATE_PAYMENT_GRACE_MS) {
            await flag(item, 'order_too_old', order);
            continue;
        }

        // \u26a0\ufe0f ATOMIC - gated on status so this exact order (and therefore the task insert below)
        // can never fire twice, no matter how many times this loop or a later run sees the tx again.
        const claimed = await orders.findOneAndUpdate(
            { _id: order._id, status: { $in: ['pending', 'expired'] }, cancelledByUser: { $ne: true } },
            { $set: { status: 'paid', paidAt: now, txHash: item.hash, receivedNanoTon: item.value, paidLate: order.status === 'expired' } },
            { returnDocument: 'after' }
        );
        if (!claimed) continue; // lost the race to another concurrent run - already handled

        // \u2500\u2500 publish the task doc as pending-review, exactly once, gated
        // behind the atomic flip above - see api/bot.js "\ud83d\udd50 Pending Review" \u2500\u2500
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
            isApproved: false, // \u26a0\ufe0f NOT live yet - see reviewStatus below
            reviewStatus: 'pending_review',
            createdAt: now,
            createdBy: claimed.userId,
            isUserCreated: true, // gates the 5-day post-completion TTL (models/schema.js), distinguishes from admin-created tasks with the same shape
        };
        const insertResult = await tasks.insertOne(taskDoc);
        await orders.updateOne({ _id: claimed._id }, { $set: { createdTaskId: insertResult.insertedId } });

        matched++;
        tgSend(claimed.userId,
            `\u2705 <b>Payment Confirmed!</b>\n\n` +
            `\ud83d\udccb ${taskDoc.title}\n` +
            `\ud83d\udc65 ${taskDoc.limit} people will be able to complete it (+${TASK_CREATE_REWARD_PER_TASK_WTC} WTC each)\n\n` +
            `\u23f3 It's now waiting for admin review - once approved, it'll go live for everyone in the "\u2b50 Exclusive" tab. \ud83c\udf89`
        ).catch(() => {});

        // ping admin + task moderator so a paid task doesn't sit unnoticed in the queue. Best-effort.
        const reviewMsg =
            `\ud83c\udd95 <b>New Task Waiting for Review</b>${order.status === 'expired' ? ' (late payment, auto-credited)' : ''}\n\n` +
            `\ud83d\udccb ${taskDoc.title}\n` +
            `\ud83d\udd17 ${taskDoc.url}\n` +
            `\ud83d\udc64 Type: ${taskDoc.verifyType === 'api' ? 'Channel/Group Join (API)' : 'Link'}\n` +
            `\ud83d\udc65 ${taskDoc.limit} slots \u00b7 \ud83d\udcb0 ${taskDoc.rewardWtc} WTC/person\n\n` +
            `Go to "\ud83d\udd50 Pending Review" in the admin panel to approve/reject.`;
        if (ADMIN_ID) tgSend(ADMIN_ID, reviewMsg).catch(() => {});
        if (TASK_MODERATOR_ID) tgSend(TASK_MODERATOR_ID, reviewMsg).catch(() => {});
    }
    return { expired: expireResult.modifiedCount, matched, flagged };
}

async function handleCronCheckDeposits(req, res, db) {
    const authHeader = req.headers['authorization'];
    if (!isCronAuthorized(req)) {
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

        const taskCreateResult = await cronCheckTaskCreate(db, txs, now);

        return res.status(200).json({
            ok: true,
            checked: txs.length,
            taskCreate: taskCreateResult,
        });
    } catch (err) {
        console.error('payments cron checkDeposits error:', err);
        // alert the admin at most once per 30 min (the cron runs every minute — no spam)
        let shouldAlert = true;
        try {
            const st = await db.collection('settings').findOne({ _id: 'tonDepositAlert' });
            if (st?.lastAt && Date.now() - new Date(st.lastAt).getTime() < 30 * 60 * 1000) shouldAlert = false;
            else await db.collection('settings').updateOne({ _id: 'tonDepositAlert' }, { $set: { lastAt: new Date() } }, { upsert: true });
        } catch (e) {}
        if (ADMIN_ID && shouldAlert) {
            await tgSend(ADMIN_ID, `🚨 <b>TON Deposit Check FAILED</b>\n\n<code>${String(err?.message || err).slice(0, 500)}</code>`).catch(() => {});
        }
        return res.status(500).json({ ok: false, error: 'server_error', detail: String(err?.message || err).slice(0, 300) }); // cron is secret-protected, so showing the reason here is safe
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
    if (resource === 'taskcreate') return taskcreateRouter(req, res, db);
    return res.status(400).json({ ok: false, error: 'unknown_resource' });
}
