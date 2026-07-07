// api/bot.js — NEWTUBE Admin Panel Bot (Season 2)
//
// bot__4_.js রেফারেন্স থেকে অ্যাডাপ্ট করা হয়েছে, কিন্তু কয়েকটা গুরুত্বপূর্ণ
// পরিবর্তন/ফিক্স সহ:
//   ১) ADMIN_ID → ADMIN_TELEGRAM_ID (Vercel-এ যে নামে env var আছে তার সাথে মিলিয়ে)
//   ২) in-memory state{} বাদ — MongoDB-তে persist করা হচ্ছে (lib/adminState.js),
//      কারণ Vercel serverless-এ in-memory state cold-start-এ হারিয়ে যেতে পারে
//   ৩) telegramId ফিল্ডের বদলে _id ব্যবহার (আমাদের users schema অনুযায়ী)
//   ৪) egBalance → wtcBalance, একটাই কারেন্সি
//   ৫) নতুন: 🎬 Add Video (NEWTUBE-এর মূল ফিচার — ভিডিও দেখে আয়)
//   ৬) নতুন: 🚩 Multi-Account Flags review (fingerprint flagging সিস্টেমের admin UI)
//   ৭) Withdraw reject হলে পুরো wtcAmount রিফান্ড হয় (fee সহ — কারণ আসল টাকা কখনো পাঠানো হয়নি)

import { ObjectId } from 'mongodb';
import { connectToDatabase } from '../lib/mongodb.js';
import { tgApi, tgSend, tgEdit, tgSendPhoto, tgAnswerCallback, isMember, OFFICIAL_CHANNEL, COMMUNITY_GROUP } from '../lib/telegram.js';
import { getAdminState, setAdminState, clearAdminState } from '../lib/adminState.js';
import { maybeAwardReferralMilestones } from '../lib/referral.js';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

// ⚠️ এই দুটো লাইন আপনার আসল তথ্য দিয়ে বদলে নিন:
const APP_URL = 'https://newtube-ton.vercel.app';                       // আপনার মিনি অ্যাপের Vercel URL
const MINI_APP_URL = 'https://t.me/NewTube12_bot/WatchTo_Earn';         // ✅ আপডেট হয়েছে
const BOT_USERNAME = 'NewTube12_bot';                                    // ⚠️ MINI_APP_URL-এর সাথে মিলিয়ে — appeal deep-link বানাতে লাগে
const COVER_PHOTO = 'https://i.postimg.cc/Gtp63QQV/file-000000007fa87207ae71dda1cde1426b.png'; // শুধু ইউজারদের /start-এ দেখাবে, admin-এ না

function extractYoutubeId(input) {
    const s = input.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
    const patterns = [
        /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
        /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    ];
    for (const p of patterns) {
        const m = s.match(p);
        if (m) return m[1];
    }
    return null;
}

const adminKb = {
    inline_keyboard: [
        [{ text: '📊 Dashboard', callback_data: 'a_stats' }, { text: '💸 Withdrawals', callback_data: 'a_pending' }],
        [{ text: '👤 User Lookup', callback_data: 'a_user' }, { text: '👥 All Users', callback_data: 'a_allusers_0' }],
        [{ text: '🚩 Multi-Acc Flags', callback_data: 'a_flags' }],
        [{ text: '🏆 Top Referrers', callback_data: 'a_toprefer' }, { text: '📅 Weekly Refer', callback_data: 'a_weekly' }],
        [{ text: '📋 Add Task', callback_data: 'a_addtask' }, { text: '🎬 Add Video', callback_data: 'a_addvideo' }],
        [{ text: '🗑 Manage Tasks', callback_data: 'a_managetasks_0' }, { text: '🗑 Manage Videos', callback_data: 'a_managevideos_0' }],
        [{ text: '🎟 Add Promo', callback_data: 'a_addpromo' }, { text: '📋 View Promos', callback_data: 'a_viewpromos_0' }],
        [{ text: '📢 Broadcast', callback_data: 'a_broadcast' }],
        [{ text: '💰 Send WTC', callback_data: 'a_sendwtc' }],
    ],
};
const backKb = { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] };
const cancelKb = { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] };

// broadcast প্রিভিউ পাঠায় — admin শেষবার দেখে নিশ্চিত হতে পারে কী যাবে
async function sendBroadcastPreview(chatId, bs) {
    const extra = {};
    if (bs.buttonText && bs.buttonUrl) {
        extra.reply_markup = { inline_keyboard: [[{ text: bs.buttonText, url: bs.buttonUrl }], [{ text: '✅ Confirm & Send', callback_data: 'bc_confirm' }], [{ text: '◀️ Cancel', callback_data: 'a_menu' }]] };
    } else {
        extra.reply_markup = { inline_keyboard: [[{ text: '✅ Confirm & Send', callback_data: 'bc_confirm' }], [{ text: '◀️ Cancel', callback_data: 'a_menu' }]] };
    }

    await tgSend(chatId, '📢 <b>Broadcast — Step 4/4: Preview</b>\n\nThis is exactly what users will receive:');
    if (bs.photoFileId) {
        await tgSendPhoto(chatId, bs.photoFileId, bs.text, extra);
    } else {
        await tgSend(chatId, bs.text, extra);
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).json({ ok: true });

    const update = req.body;
    const { db } = await connectToDatabase();
    const users = db.collection('users');
    const withdrawals = db.collection('withdrawals');
    const tasks = db.collection('tasks');
    const promos = db.collection('promos');
    const videos = db.collection('videos');

    // ══════════════════════════════════════════════════════════════
    // CALLBACK QUERY
    // ══════════════════════════════════════════════════════════════
    if (update.callback_query) {
        const cb = update.callback_query;
        const fromId = String(cb.from.id);
        const data = cb.data;
        const chatId = cb.message.chat.id;
        const msgId = cb.message.message_id;

        await tgAnswerCallback(cb.id);

        // ── User: check channel + community join ──
        if (data.startsWith('check_join_')) {
            const userId = data.replace('check_join_', '');
            if (fromId !== userId) { await tgAnswerCallback(cb.id, '⛔ Not your button'); return res.status(200).json({ ok: true }); }
            const [ch, com] = await Promise.all([isMember(userId, OFFICIAL_CHANNEL), isMember(userId, COMMUNITY_GROUP)]);
            if (!ch || !com) {
                await tgAnswerCallback(cb.id, '❌ Join both channel & community first!', true);
                return res.status(200).json({ ok: true });
            }
            await users.updateOne({ _id: userId }, { $set: { channelVerified: true } });
            await maybeAwardReferralMilestones(db, userId, { channelVerified: true });
            await tgSendPhoto(chatId, COVER_PHOTO,
                `✅ <b>Verified! Welcome to NEWTUBE!</b>\n\n🎬 Watch videos · Earn WTC · Withdraw crypto!`,
                { reply_markup: { inline_keyboard: [
                    [{ text: '🚀 Open NEWTUBE', web_app: { url: APP_URL } }],
                    [{ text: '👥 Share & Earn', url: `https://t.me/share/url?url=${encodeURIComponent(MINI_APP_URL + '?startapp=' + userId)}&text=${encodeURIComponent('🎬 Join NEWTUBE! Watch videos, earn WTC!')}` }],
                ] } }
            );
            return res.status(200).json({ ok: true });
        }

        // সব নিচের callback admin-only
        if (fromId !== String(ADMIN_ID)) return res.status(200).json({ ok: true });

        // ── Withdrawal Approve / Reject ──
        if (data.startsWith('wd_approve_') || data.startsWith('wd_reject_')) {
            const approve = data.startsWith('wd_approve_');
            const wid = data.replace('wd_approve_', '').replace('wd_reject_', '');
            const w = await withdrawals.findOne({ _id: new ObjectId(wid) });
            if (!w || w.status !== 'pending') {
                await tgAnswerCallback(cb.id, 'Already processed', true);
                return res.status(200).json({ ok: true });
            }
            if (!approve) {
                // রিজেক্ট হলে পুরো wtcAmount ফিরিয়ে দিন (fee সহ — আসল টাকা কখনো পাঠানো হয়নি)
                await users.updateOne({ _id: w.userId }, { $inc: { wtcBalance: w.wtcAmount, withdrawalCount: -1 }, $set: { lastWithdrawDate: '' } });
            }
            await withdrawals.updateOne({ _id: new ObjectId(wid) }, { $set: { status: approve ? 'approved' : 'rejected', processedAt: new Date() } });
            await tgAnswerCallback(cb.id, approve ? '✅ Approved' : '❌ Rejected', true);
            const notif = approve
                ? `✅ <b>Withdrawal Approved!</b>\n\n💰 ${w.wtcAmount.toLocaleString()} WTC → ${w.cashAmount.toFixed(4)} ${w.currency}\n📤 ${w.method}\n📍 <code>${w.details}</code>`
                : `❌ <b>Withdrawal Rejected.</b>\nYour ${w.wtcAmount.toLocaleString()} WTC has been refunded.`;
            await tgSend(w.userId, notif);

            // ⚠️ FIX: admin-এর চ্যাটে যে original withdrawal request message-টা ছিল
            // (Approve/Reject বাটন সহ), সেটা এখন edit করে বাটন সরিয়ে ফেলা হচ্ছে এবং
            // status দেখানো হচ্ছে — আগে এই edit-টা মিসিং ছিল, তাই বাটনসহ notice
            // Telegram-এ থেকেই যেত (process হওয়ার পরেও)।
            const processedText =
                `💸 <b>Withdrawal Request</b>\n\n` +
                `👤 <code>${w.userId}</code> (@${w.username || '?'})\n` +
                `💰 ${w.wtcAmount.toLocaleString()} WTC (fee ${w.feeWtc.toLocaleString()}) → <b>${w.cashAmount.toFixed(4)} ${w.currency}</b>\n` +
                `📤 Method: <b>${w.method}</b>\n` +
                `📍 Address: <code>${w.details}</code>\n` +
                `📅 ${new Date(w.createdAt).toLocaleString()}\n\n` +
                (approve ? `✅ <b>APPROVED</b> — ${new Date().toLocaleString()}` : `❌ <b>REJECTED (refunded)</b> — ${new Date().toLocaleString()}`);
            // ⚠️ Telegram-এ reply_markup omit করলে পুরোনো বাটন থেকেই যায় — তাই খালি
            // inline_keyboard পাঠিয়ে সরাসরি বাটন রিমুভ করা হচ্ছে।
            await tgEdit(chatId, msgId, processedText, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
            return res.status(200).json({ ok: true });
        }

        // ── Ban / Unban ──
        // ⚠️ BUG FIX: আগে `data.replace('ban_','').replace('unban_','')` ব্যবহার হতো —
        // কিন্তু "unban_123" স্ট্রিং-এর মধ্যেই "ban_" সাবস্ট্রিং লুকিয়ে আছে (u-n-[ban_]-123),
        // তাই .replace('ban_','') সেটাকে ভুলভাবে কেটে ফেলে "un123" বানিয়ে দিতো — ফলে Unban
        // বাটনে চাপলে ভুল/অস্তিত্বহীন আইডি আপডেট হতো, আসল ইউজার কখনো unban হতোই না।
        // এখন শুধু prefix-টুকু নির্দিষ্টভাবে কেটে নেওয়া হচ্ছে।
        if (data.startsWith('ban_') || data.startsWith('unban_')) {
            const isBan = data.startsWith('ban_');
            const target = isBan ? data.slice('ban_'.length) : data.slice('unban_'.length);
            await users.updateOne({ _id: target }, { $set: { isBanned: isBan } });
            await tgEdit(chatId, msgId, `${isBan ? '🚫 Banned' : '✅ Unbanned'}: <code>${target}</code>`, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        // ── Multi-account flag clear (review করার পর সমস্যা না থাকলে) ──
        if (data.startsWith('flagclear_')) {
            const target = data.replace('flagclear_', '');
            await users.updateOne({ _id: target }, { $set: { multiAccountFlag: false } });
            await tgEdit(chatId, msgId, `✅ Flag cleared for <code>${target}</code>`, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        // ── Task category পছন্দ (Add Task ফ্লো-র অংশ) ──
        if (data === 'task_cat_channel' || data === 'task_cat_partner') {
            const s = await getAdminState(fromId);
            if (!s || s.step !== 'task_category') return res.status(200).json({ ok: true });
            if (data === 'task_cat_channel') {
                s.category = 'channel';
                s.step = 'task_channelid';
                await setAdminState(fromId, s);
                await tgEdit(chatId, msgId, `📋 Title: ✅ <b>${s.title}</b>\n\nএবার <b>channel/group @username</b> দিন (যেটাতে join verify হবে):`, { reply_markup: cancelKb });
            } else {
                s.category = 'partner';
                s.step = 'task_url';
                await setAdminState(fromId, s);
                await tgEdit(chatId, msgId, `📋 Title: ✅ <b>${s.title}</b>\n\nএবার task-এর <b>লিংক</b> দিন (YouTube/FB/Bot ইত্যাদি):`, { reply_markup: cancelKb });
            }
            return res.status(200).json({ ok: true });
        }

        // ── Task confirm preview-এ Save/Cancel বাটন না, এটা টেক্সটে CONFIRM লিখে হয় (নিচে দেখুন) ──

        // ── Admin menu ──
        if (data === 'a_menu') {
            await clearAdminState(fromId);
            await tgEdit(chatId, msgId, '👑 <b>NEWTUBE Admin Panel</b>\n\nSelect an option:', { reply_markup: adminKb });
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_stats') {
            const total = await users.countDocuments();
            const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
            const newToday = await users.countDocuments({ createdAt: { $gte: todayStart } });
            const pendingW = await withdrawals.countDocuments({ status: 'pending' });
            const taskCnt = await tasks.countDocuments({ isApproved: true });
            const videoCnt = await videos.countDocuments({ isActive: true });
            const flagCnt = await users.countDocuments({ multiAccountFlag: true });
            const wtcAgg = await users.aggregate([{ $group: { _id: null, t: { $sum: '$wtcBalance' } } }]).toArray();
            await tgEdit(chatId, msgId,
                `📊 <b>Dashboard</b>\n\n` +
                `👥 Total Users: <b>${total}</b>\n` +
                `🆕 Today Joined: <b>${newToday}</b>\n` +
                `📋 Active Tasks: <b>${taskCnt}</b>\n` +
                `🎬 Active Videos: <b>${videoCnt}</b>\n` +
                `⏳ Pending Withdrawals: <b>${pendingW}</b>\n` +
                `🚩 Multi-Acc Flags: <b>${flagCnt}</b>\n` +
                `💰 Total WTC (all users): <b>${(wtcAgg[0]?.t || 0).toLocaleString()}</b>`,
                { reply_markup: backKb }
            );
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_pending') {
            const list = await withdrawals.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(10).toArray();
            if (!list.length) {
                await tgEdit(chatId, msgId, '✅ No pending withdrawals.', { reply_markup: backKb });
                return res.status(200).json({ ok: true });
            }
            await tgEdit(chatId, msgId, `💸 <b>${list.length} pending withdrawal(s)</b>`, { reply_markup: backKb });
            for (const w of list) {
                await tgSend(chatId,
                    `💸 <b>Withdrawal Request</b>\n\n` +
                    `👤 <code>${w.userId}</code> (@${w.username || '?'})\n` +
                    `💰 ${w.wtcAmount.toLocaleString()} WTC (fee ${w.feeWtc.toLocaleString()}) → <b>${w.cashAmount.toFixed(4)} ${w.currency}</b>\n` +
                    `📤 Method: <b>${w.method}</b>\n` +
                    `📍 Address: <code>${w.details}</code>\n` +
                    `📅 ${new Date(w.createdAt).toLocaleString()}`,
                    { reply_markup: { inline_keyboard: [[
                        { text: '✅ Approve', callback_data: `wd_approve_${w._id}` },
                        { text: '❌ Reject', callback_data: `wd_reject_${w._id}` },
                    ]] } }
                );
            }
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_user') {
            await setAdminState(fromId, { step: 'user_lookup' });
            await tgEdit(chatId, msgId, '👤 ইউজারের <b>Telegram numeric ID</b> দিন, অথবা <b>নাম/username</b> দিয়ে search করুন:', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_flags') {
            const flagged = await users.find({ multiAccountFlag: true }).limit(15).toArray();
            if (!flagged.length) {
                await tgEdit(chatId, msgId, '✅ No multi-account flags found.', { reply_markup: backKb });
                return res.status(200).json({ ok: true });
            }
            await tgEdit(chatId, msgId, `🚩 <b>${flagged.length} flagged account(s)</b>`, { reply_markup: backKb });

            // একটা fingerprint → সব related accounts একসাথে দেখানো হচ্ছে।
            // ⚠️ নতুন নিয়ম: পুরো গ্রুপ ব্যান করা হয় না। ডিভাইসে সবচেয়ে আগে তৈরি
            // হওয়া অ্যাকাউন্টটাকে (Main) active রাখা হয়, বাকিগুলো suspend করা হয়।
            // অ্যাডমিন চাইলে নিচের বাটন দিয়ে অন্য কোনো অ্যাকাউন্টকে Main বানাতে
            // পারবেন — তখন সেটা active হয়ে যাবে আর আগের Main সহ বাকি সব suspend হবে।
            const seen = new Set();
            const groupMap = {}; // adminState-এ রাখার জন্য — callback_data ছোট রাখতে (Telegram 64-byte সীমা)
            for (const u of flagged) {
                if (seen.has(u._id)) continue;
                seen.add(u._id);
                const siblings = (u.multiAccountSiblings || []).filter(id => !seen.has(id));
                siblings.forEach(id => seen.add(id));

                const allInGroup = [u._id, ...siblings];
                const siblingDocs = await users.find({ _id: { $in: siblings } }).toArray();
                const allDocs = [u, ...siblingDocs];

                // সবচেয়ে পুরোনো অ্যাকাউন্ট (প্রথম তৈরি হওয়া) = Main, বাকিগুলো suspend
                const sorted = [...allDocs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
                const mainAcc = sorted[0];
                const others = sorted.slice(1);
                groupMap[mainAcc._id] = allInGroup;

                let groupText = `🖥️ <b>Device Group (${allDocs.length} accounts)</b>\n\n`;
                sorted.forEach(d => {
                    const tag = d._id === mainAcc._id ? '👑 Main (active)' : '⛔ Suspended';
                    groupText += `${tag} <code>${d._id}</code> @${d.telegramUsername || '?'} — ${d.wtcBalance || 0} WTC\n`;
                });
                groupText += `\n⚠️ One device = one active account. The oldest account stays active; the rest are suspended (not permanently banned). If the user wants a different account to be the main one, use a button below.`;

                // Main অ্যাকাউন্ট active থাকবে, বাকিগুলো suspend হবে — পুরো গ্রুপ ব্যান নয়
                await users.updateOne({ _id: mainAcc._id }, { $set: { isBanned: false, multiAccountFlag: false } });
                if (others.length) {
                    await users.updateMany({ _id: { $in: others.map(o => o._id) } }, { $set: { isBanned: true, multiAccountFlag: false } });
                }

                // Suspended অ্যাকাউন্টগুলোকে জানিয়ে দিন — সাথে এক-ট্যাপ Appeal বাটন
                for (const o of others) {
                    await tgSend(o._id,
                        `⛔ <b>Account Suspended</b>\n\nMultiple accounts were detected on the same device. Only one account per device is allowed, so your other (main) account stays active and this one has been suspended.\n\nIf you'd like this account to become the main one instead, tap below to request a review from the admin.`,
                        { reply_markup: { inline_keyboard: [[{ text: '🆘 Request Review from Admin', url: `https://t.me/${BOT_USERNAME}?start=appeal_${o._id}` }]] } }
                    ).catch(() => {});
                }

                const rows = others.map(o => ([{ text: `🔁 Make Main: ${o.telegramUsername || o._id}`, callback_data: `devmain_${mainAcc._id}_${o._id}` }]));
                rows.push([{ text: '✅ Unban All (mistake)', callback_data: `devban_clearall_${allInGroup.join(',')}` }]);
                await tgSend(chatId, groupText + `\n\n✅ <b>Main kept active, ${others.length} account(s) suspended.</b>`, { reply_markup: { inline_keyboard: rows } });
            }
            // ছোট callback_data থেকে পুরো গ্রুপ resolve করার জন্য admin state-এ সেভ রাখা হচ্ছে
            const prevState = (await getAdminState(fromId)) || {};
            await setAdminState(fromId, { ...prevState, deviceGroups: { ...(prevState.deviceGroups || {}), ...groupMap } });
            return res.status(200).json({ ok: true });
        }

        // ── Device: অন্য একটা অ্যাকাউন্টকে Main বানানো (সুইচ) ──
        // যে অ্যাকাউন্টে ক্লিক করা হয়েছে সেটা active হবে, গ্রুপের বাকি সব suspend হবে।
        if (data.startsWith('devmain_')) {
            const [, mainId, targetId] = data.split('_');
            const st = await getAdminState(fromId);
            let allIds = st?.deviceGroups?.[mainId];
            if (!allIds) {
                // fallback — adminState হারিয়ে গেলে target-এর নিজের siblings ফিল্ড থেকে গ্রুপ পুনর্গঠন
                const targetDoc = await users.findOne({ _id: targetId });
                allIds = targetDoc?.multiAccountSiblings ? [...new Set([targetDoc._id, ...targetDoc.multiAccountSiblings])] : [mainId, targetId];
            }
            const rest = allIds.filter(id => id !== targetId);

            await users.updateOne({ _id: targetId }, { $set: { isBanned: false, multiAccountFlag: false } });
            if (rest.length) await users.updateMany({ _id: { $in: rest } }, { $set: { isBanned: true, multiAccountFlag: false } });

            await tgAnswerCallback(cb.id, `✅ ${targetId} is now the Main account`, true);
            await tgSend(targetId, `✅ <b>Account Reactivated</b>\n\nThis account is now the main active account for this device. Other accounts on this device have been suspended.`).catch(() => {});
            for (const id of rest) {
                await tgSend(id, `⛔ <b>Account Suspended</b>\n\nA different account was set as the main account for this device, so this account has been suspended.\n\nIf you think this is a mistake, tap below to request a review from the admin.`,
                    { reply_markup: { inline_keyboard: [[{ text: '🆘 Request Review from Admin', url: `https://t.me/${BOT_USERNAME}?start=appeal_${id}` }]] } }
                ).catch(() => {});
            }
            return res.status(200).json({ ok: true });
        }

        // ── Device bulk-unban: admin decides the whole flag was a mistake, reinstate everyone ──
        if (data.startsWith('devban_clearall_')) {
            const allIds = data.replace('devban_clearall_', '').split(',');
            await users.updateMany({ _id: { $in: allIds } }, { $set: { isBanned: false, multiAccountFlag: false } });
            await tgAnswerCallback(cb.id, `✅ Unbanned ${allIds.length} account(s)`, true);
            for (const id of allIds) {
                await tgSend(id, `✅ <b>Account Unbanned</b>\n\nYour account has been reinstated. Please use only one account going forward.`).catch(() => {});
            }
            return res.status(200).json({ ok: true });
        }

        // ── All Users — পেজিনেটেড লিস্ট, প্রতি পেজে ১৫ জন, withdraw/refer count সহ ──
        if (data.startsWith('a_allusers_')) {
            const page = parseInt(data.replace('a_allusers_', '')) || 0;
            const PER_PAGE = 15;
            const total = await users.countDocuments();
            const pageUsers = await users.find()
                .sort({ createdAt: -1 })
                .skip(page * PER_PAGE)
                .limit(PER_PAGE)
                .toArray();

            if (!pageUsers.length) {
                await tgEdit(chatId, msgId, '📭 কোনো ইউজার নেই।', { reply_markup: backKb });
                return res.status(200).json({ ok: true });
            }

            let out = `👥 <b>All Users</b> (${total} total) — Page ${page + 1}/${Math.ceil(total / PER_PAGE)}\n\n`;
            pageUsers.forEach((u, i) => {
                const serial = page * PER_PAGE + i + 1;
                out += `<b>${serial}.</b> ${u.firstName || 'User'} (@${u.telegramUsername || 'n/a'})\n` +
                       `   ID: <code>${u._id}</code> | 💰 ${u.wtcBalance || 0} WTC\n` +
                       `   📤 Withdrawals: ${u.withdrawalCount || 0} | 👥 Referrals: ${u.referralCount || 0}\n\n`;
            });

            const navRow = [];
            if (page > 0) navRow.push({ text: '◀️ Prev', callback_data: `a_allusers_${page - 1}` });
            if ((page + 1) * PER_PAGE < total) navRow.push({ text: 'Next ▶️', callback_data: `a_allusers_${page + 1}` });

            await tgEdit(chatId, msgId, out, { reply_markup: { inline_keyboard: [navRow, [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]].filter(r => r.length) } });
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_toprefer') {
            const top = await users.find().sort({ referralCount: -1 }).limit(20).toArray();
            let out = '🏆 <b>All-time Top 20 Referrers</b>\n\n';
            top.forEach((u, i) => { out += `${i + 1}. @${u.telegramUsername || u.firstName} — <b>${u.referralCount || 0}</b> refs\n`; });
            await tgEdit(chatId, msgId, out || 'No data yet.', { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_weekly') {
            const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const pipeline = [
                { $match: { createdAt: { $gte: weekAgo }, referredBy: { $ne: null } } },
                { $group: { _id: '$referredBy', count: { $sum: 1 } } },
                { $sort: { count: -1 } }, { $limit: 20 },
            ];
            const weekly = await users.aggregate(pipeline).toArray();
            let out = '📅 <b>Weekly Top 20 Referrers</b>\n\n';
            for (let i = 0; i < weekly.length; i++) {
                const u = await users.findOne({ _id: weekly[i]._id });
                out += `${i + 1}. @${u?.telegramUsername || u?.firstName || weekly[i]._id} — <b>${weekly[i].count}</b> refs\n`;
            }
            await tgEdit(chatId, msgId, out === '📅 <b>Weekly Top 20 Referrers</b>\n\n' ? 'No data this week.' : out, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_addtask') {
            await setAdminState(fromId, { step: 'task_title' });
            await tgEdit(chatId, msgId, `📋 <b>Add Task — Step 1/5</b>\n\nTask-এর <b>title</b> দিন:`, { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_addvideo') {
            await setAdminState(fromId, { step: 'video_id' });
            await tgEdit(chatId, msgId, `🎬 <b>Add Video — Step 1/2</b>\n\nYouTube ভিডিওর <b>লিংক</b> অথবা সরাসরি <b>video ID</b> পাঠান:`, { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        // ── 🗑 Manage Videos — লিস্ট দেখুন + প্রতিটার পাশে Remove বাটন ──
        if (data.startsWith('a_managevideos_')) {
            const page = parseInt(data.replace('a_managevideos_', '')) || 0;
            const perPage = 8;
            const all = await videos.find({}).sort({ createdAt: -1 }).skip(page * perPage).limit(perPage).toArray();
            const totalCount = await videos.countDocuments({});
            if (!all.length) {
                await tgEdit(chatId, msgId, page === 0 ? '📭 কোনো ভিডিও নেই।' : '📭 আর কোনো ভিডিও নেই।', { reply_markup: backKb });
                return res.status(200).json({ ok: true });
            }
            const rows = all.map(v => ([{ text: `${v.isActive ? '🟢' : '⚪'} ${(v.title || v.videoId).slice(0, 28)}`, callback_data: `noop_dismiss` }, { text: '🗑 Remove', callback_data: `delvideo_${v._id}` }]));
            const navRow = [];
            if (page > 0) navRow.push({ text: '◀️ Prev', callback_data: `a_managevideos_${page - 1}` });
            if ((page + 1) * perPage < totalCount) navRow.push({ text: 'Next ▶️', callback_data: `a_managevideos_${page + 1}` });
            if (navRow.length) rows.push(navRow);
            rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
            await tgEdit(chatId, msgId, `🎬 <b>Manage Videos</b> (${totalCount} total)\n\n🟢 = active, ⚪ = inactive`, { reply_markup: { inline_keyboard: rows } });
            return res.status(200).json({ ok: true });
        }

        if (data.startsWith('delvideo_')) {
            const vid = data.replace('delvideo_', '');
            try {
                await videos.deleteOne({ _id: new ObjectId(vid) });
                await tgAnswerCallback(cb.id, '🗑 Video removed', true);
            } catch (e) {
                await tgAnswerCallback(cb.id, '❌ Failed to remove', true);
            }
            // লিস্ট রিফ্রেশ — একই পেজে ফিরিয়ে দেখানো হচ্ছে
            const perPage = 8;
            const all = await videos.find({}).sort({ createdAt: -1 }).limit(perPage).toArray();
            const totalCount = await videos.countDocuments({});
            const rows = all.map(v => ([{ text: `${v.isActive ? '🟢' : '⚪'} ${(v.title || v.videoId).slice(0, 28)}`, callback_data: `noop_dismiss` }, { text: '🗑 Remove', callback_data: `delvideo_${v._id}` }]));
            rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
            await tgEdit(chatId, msgId, `🎬 <b>Manage Videos</b> (${totalCount} total)\n\n🟢 = active, ⚪ = inactive`, { reply_markup: { inline_keyboard: rows } });
            return res.status(200).json({ ok: true });
        }

        // ── 🗑 Manage Tasks — কতগুলো complete হয়েছে দেখান + Remove বাটন ──
        if (data.startsWith('a_managetasks_')) {
            const page = parseInt(data.replace('a_managetasks_', '')) || 0;
            const perPage = 8;
            const all = await tasks.find({}).sort({ createdAt: -1 }).skip(page * perPage).limit(perPage).toArray();
            const totalCount = await tasks.countDocuments({});
            if (!all.length) {
                await tgEdit(chatId, msgId, page === 0 ? '📭 কোনো টাস্ক নেই।' : '📭 আর কোনো টাস্ক নেই।', { reply_markup: backKb });
                return res.status(200).json({ ok: true });
            }
            let text_ = `📋 <b>Manage Tasks</b> (${totalCount} total)\n\n`;
            all.forEach(t => {
                text_ += `<b>${t.title}</b>\n✅ Completed: <b>${t.completionCount || 0}</b>${t.limit ? ` / ${t.limit}` : ' (unlimited)'} · 💰 ${t.rewardWtc} WTC\n\n`;
            });
            const rows = all.map(t => ([{ text: `🗑 Remove: ${t.title.slice(0, 24)}`, callback_data: `deltask_${t._id}` }]));
            const navRow = [];
            if (page > 0) navRow.push({ text: '◀️ Prev', callback_data: `a_managetasks_${page - 1}` });
            if ((page + 1) * perPage < totalCount) navRow.push({ text: 'Next ▶️', callback_data: `a_managetasks_${page + 1}` });
            if (navRow.length) rows.push(navRow);
            rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
            await tgEdit(chatId, msgId, text_, { reply_markup: { inline_keyboard: rows } });
            return res.status(200).json({ ok: true });
        }

        if (data.startsWith('deltask_')) {
            const tid = data.replace('deltask_', '');
            try {
                await tasks.deleteOne({ _id: new ObjectId(tid) });
                await tgAnswerCallback(cb.id, '🗑 Task removed', true);
            } catch (e) {
                await tgAnswerCallback(cb.id, '❌ Failed to remove', true);
            }
            const perPage = 8;
            const all = await tasks.find({}).sort({ createdAt: -1 }).limit(perPage).toArray();
            const totalCount = await tasks.countDocuments({});
            let text_ = `📋 <b>Manage Tasks</b> (${totalCount} total)\n\n`;
            all.forEach(t => {
                text_ += `<b>${t.title}</b>\n✅ Completed: <b>${t.completionCount || 0}</b>${t.limit ? ` / ${t.limit}` : ' (unlimited)'} · 💰 ${t.rewardWtc} WTC\n\n`;
            });
            const rows = all.map(t => ([{ text: `🗑 Remove: ${t.title.slice(0, 24)}`, callback_data: `deltask_${t._id}` }]));
            rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
            await tgEdit(chatId, msgId, text_, { reply_markup: { inline_keyboard: rows } });
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_addpromo') {
            await setAdminState(fromId, { step: 'promo_count' });
            await tgEdit(chatId, msgId, '🎟 <b>Create Promo Codes</b>\n\nকতটা কোড বানাতে চান?', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        // ── 🎟 View Promos — কোন কোন promo code active আছে, কতজন claim করেছে ──
        if (data.startsWith('a_viewpromos_')) {
            const page = parseInt(data.replace('a_viewpromos_', '')) || 0;
            const perPage = 8;
            const totalCount = await promos.countDocuments({});
            const list = await promos.find({}).sort({ createdAt: -1 }).skip(page * perPage).limit(perPage).toArray();

            if (!list.length) {
                await tgEdit(chatId, msgId, page === 0 ? '📭 কোনো promo code তৈরি হয়নি এখনো।' : '📭 আর কোনো promo code নেই।', { reply_markup: backKb });
                return res.status(200).json({ ok: true });
            }

            const now = Date.now();
            let out = `🎟 <b>Promo Codes</b> (${totalCount} total) — Page ${page + 1}/${Math.ceil(totalCount / perPage)}\n\n`;
            list.forEach(p => {
                const used = p.usedCount || 0;
                const max = p.maxUses || 0;
                const expired = p.expiresAt && new Date(p.expiresAt).getTime() < now;
                const soldOut = max > 0 && used >= max;
                const status = expired ? '🔴 Expired' : soldOut ? '⚪ Fully Claimed' : '🟢 Active';
                out += `<code>${p.code}</code> — ${status}\n` +
                       `   💰 ${p.reward} WTC · 👥 Claimed: <b>${used}</b>${max ? ` / ${max}` : ' (unlimited)'}\n` +
                       `   ⏰ ${expired ? 'Expired' : 'Expires'}: ${p.expiresAt ? new Date(p.expiresAt).toLocaleString() : 'never'}\n\n`;
            });

            const navRow = [];
            if (page > 0) navRow.push({ text: '◀️ Prev', callback_data: `a_viewpromos_${page - 1}` });
            if ((page + 1) * perPage < totalCount) navRow.push({ text: 'Next ▶️', callback_data: `a_viewpromos_${page + 1}` });
            const rows = [];
            if (navRow.length) rows.push(navRow);
            rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
            await tgEdit(chatId, msgId, out, { reply_markup: { inline_keyboard: rows } });
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_broadcast') {
            await setAdminState(fromId, { step: 'bc_text' });
            await tgEdit(chatId, msgId, '📢 <b>Broadcast — Step 1/4</b>\n\nMessage এর টেক্সট টাইপ করুন:', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        // ── Broadcast flow — button-skip / photo-skip / confirm / cancel ──
        if (data === 'bc_skip_button') {
            const bs = await getAdminState(fromId);
            if (!bs || bs.step !== 'bc_button_text') return res.status(200).json({ ok: true });
            bs.buttonText = null; bs.buttonUrl = null; bs.step = 'bc_photo';
            await setAdminState(fromId, bs);
            await tgEdit(chatId, msgId, '📢 <b>Broadcast — Step 3/4</b>\n\nSend a photo to attach (or skip):', { reply_markup: { inline_keyboard: [[{ text: '⏭ Skip photo', callback_data: 'bc_skip_photo' }], [{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
            return res.status(200).json({ ok: true });
        }

        if (data === 'bc_skip_photo') {
            const bs = await getAdminState(fromId);
            if (!bs || bs.step !== 'bc_photo') return res.status(200).json({ ok: true });
            bs.photoFileId = null; bs.step = 'bc_confirm';
            await setAdminState(fromId, bs);
            await sendBroadcastPreview(chatId, bs);
            return res.status(200).json({ ok: true });
        }

        if (data === 'bc_confirm') {
            const bs = await getAdminState(fromId);
            if (!bs || bs.step !== 'bc_confirm') return res.status(200).json({ ok: true });
            await clearAdminState(fromId);

            const all = await users.find({}, { projection: { _id: 1 } }).toArray();
            let sent = 0, failed = 0;
            await tgEdit(chatId, msgId, `📢 Broadcasting to <b>${all.length}</b> users...`);

            const extra = {};
            if (bs.buttonText && bs.buttonUrl) {
                extra.reply_markup = { inline_keyboard: [[{ text: bs.buttonText, url: bs.buttonUrl }]] };
            }

            for (const u of all) {
                try {
                    if (bs.photoFileId) {
                        await tgSendPhoto(u._id, bs.photoFileId, bs.text, extra);
                    } else {
                        await tgSend(u._id, bs.text, extra);
                    }
                    sent++;
                } catch { failed++; }
                await new Promise((r) => setTimeout(r, 100)); // 10 msg/sec — safely under Telegram's 30/sec limit
            }
            await tgSend(chatId, `✅ Done! Sent: <b>${sent}</b> | Failed: <b>${failed}</b>`, { reply_markup: adminKb });
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_sendwtc') {
            await setAdminState(fromId, { step: 'sendwtc_id' });
            await tgEdit(chatId, msgId, '💰 যাকে WTC দিতে চান তার <b>Telegram ID</b> দিন:', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        return res.status(200).json({ ok: true });
    }

    // ══════════════════════════════════════════════════════════════
    // TEXT / PHOTO MESSAGES
    // ══════════════════════════════════════════════════════════════
    const msg = update.message;
    if (!msg) return res.status(200).json({ ok: true });

    const fromId = String(msg.from.id);
    const chatId = msg.chat.id;

    // ── ছবি পাঠানো হলে — শুধু broadcast flow-এর bc_photo স্টেপে প্রযোজ্য ──
    if (msg.photo && fromId === String(ADMIN_ID)) {
        const bs = await getAdminState(fromId);
        if (bs && bs.step === 'bc_photo') {
            const largest = msg.photo[msg.photo.length - 1]; // Telegram সবচেয়ে বড় resolution শেষে দেয়
            bs.photoFileId = largest.file_id;
            bs.step = 'bc_confirm';
            await setAdminState(fromId, bs);
            await sendBroadcastPreview(chatId, bs);
            return res.status(200).json({ ok: true });
        }
        return res.status(200).json({ ok: true }); // অন্য কোনো স্টেপে ছবি এলে ইগনোর করুন
    }

    if (!msg.text) return res.status(200).json({ ok: true });
    const text = msg.text.trim();

    // ── /start ──
    if (text.startsWith('/start')) {
        // ── Appeal deep-link: ব্যানড/সাসপেন্ডেড ইউজার "Request Review" বাটনে চাপলে
        // এখানে আসে (/start appeal_<id>) — সরাসরি অ্যাডমিনকে এক-ট্যাপ Unban বাটন সহ পাঠানো হয়।
        const payload = text.split(' ')[1] || '';
        if (payload.startsWith('appeal_')) {
            const targetId = payload.replace('appeal_', '');
            if (fromId === targetId) { // নিজের অ্যাকাউন্টের জন্যই appeal করছে কিনা যাচাই — অন্য কারো আইডি দিয়ে স্প্যাম আটকাতে
                const targetUser = await users.findOne({ _id: targetId });
                await tgSend(chatId, `📨 <b>Your review request has been sent to the admin.</b>\n\nWe'll get back to you soon. Thanks for your patience!`);
                if (ADMIN_ID) {
                    await tgSend(ADMIN_ID,
                        `🆘 <b>Appeal / Review Request</b>\n\n` +
                        `User <code>${targetId}</code> (@${targetUser?.telegramUsername || 'n/a'}, ${targetUser?.firstName || 'User'}) says their account was suspended/banned by mistake and wants it reviewed.\n\n` +
                        `💰 Balance: <b>${targetUser?.wtcBalance || 0} WTC</b>\n` +
                        `🚫 Currently banned: <b>${targetUser?.isBanned ? 'YES ⛔' : 'No ✅'}</b>`,
                        { reply_markup: { inline_keyboard: [[
                            { text: '✅ Unban this account', callback_data: `unban_${targetId}` },
                            { text: '🚫 Keep Suspended', callback_data: `noop_dismiss` },
                        ]] } }
                    ).catch(() => {});
                }
                return res.status(200).json({ ok: true });
            }
        }

        if (fromId === String(ADMIN_ID)) {
            // ⚠️ অ্যাডমিনের জন্য ছবি দেখানো হয় না — শুধু টেক্সট প্যানেল
            await tgSend(chatId, `👑 <b>NEWTUBE Admin Panel</b>\n\nWelcome back, Admin!`, { reply_markup: adminKb });
            return res.status(200).json({ ok: true });
        }

        const [ch, com] = await Promise.all([isMember(fromId, OFFICIAL_CHANNEL), isMember(fromId, COMMUNITY_GROUP)]);
        if (!ch || !com) {
            await tgSendPhoto(chatId, COVER_PHOTO,
                `🎬 <b>Welcome to NEWTUBE!</b>\n\n` +
                `Earn free crypto (WTC → TON/USDT) by watching videos — no investment required! 💰\n\n` +
                `⚠️ Joining our official channel and community is required before you can start.`,
                { reply_markup: { inline_keyboard: [
                    [{ text: '📢 Official Channel', url: `https://t.me/${OFFICIAL_CHANNEL.replace('@', '')}` }, { text: '💬 Community', url: `https://t.me/${COMMUNITY_GROUP.replace('@', '')}` }],
                    [{ text: '✅ Check & Open App', callback_data: `check_join_${fromId}` }],
                ] } }
            );
            return res.status(200).json({ ok: true });
        }

        await tgSendPhoto(chatId, COVER_PHOTO,
            `🎬 <b>Welcome to NEWTUBE!</b>\n\n` +
            `Watch videos · Earn WTC · Withdraw crypto!\n\n` +
            `💰 Withdraw directly in TON or USDT\n` +
            `👥 Refer friends for bonus WTC\n` +
            `🎁 Completely free — no investment required\n\n` +
            `👇 Tap the button below to get started!`,
            { reply_markup: { inline_keyboard: [
                [{ text: '🚀 Open NEWTUBE', web_app: { url: APP_URL } }],
                [{ text: '👥 Share & Earn', url: `https://t.me/share/url?url=${encodeURIComponent(MINI_APP_URL + '?startapp=' + fromId)}&text=${encodeURIComponent('🎬 Join NEWTUBE! Watch videos, earn WTC!')}` }],
            ] } }
        );
        return res.status(200).json({ ok: true });
    }

    // ── বাকি সব শুধু admin-এর জন্য ──
    if (fromId !== String(ADMIN_ID)) return res.status(200).json({ ok: true });

    const s = await getAdminState(fromId);
    if (!s) {
        await tgSend(chatId, '👑 <b>NEWTUBE Admin Panel</b>', { reply_markup: adminKb });
        return res.status(200).json({ ok: true });
    }

    // ── User lookup ──
    if (s.step === 'user_lookup') {
        await clearAdminState(fromId);

        // সংখ্যা না হলে ধরে নিন এটা নাম/username দিয়ে search — একাধিক ম্যাচ হতে পারে
        if (!/^\d+$/.test(text)) {
            const regex = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            const matches = await users.find({ $or: [{ firstName: regex }, { telegramUsername: regex }] }).limit(15).toArray();
            if (!matches.length) { await tgSend(chatId, `❌ "${text}" দিয়ে কোনো ইউজার পাওয়া যায়নি।`, { reply_markup: adminKb }); return res.status(200).json({ ok: true }); }

            let out = `🔍 <b>Search results for "${text}"</b> (${matches.length})\n\n`;
            matches.forEach((u, i) => {
                out += `<b>${i + 1}.</b> ${u.firstName || 'User'} (@${u.telegramUsername || 'n/a'})\n   ID: <code>${u._id}</code> | 💰 ${u.wtcBalance || 0} WTC | 👥 ${u.referralCount || 0} refs | 📤 ${u.withdrawalCount || 0} withdraws\n\n`;
            });
            await tgSend(chatId, out, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        const u = await users.findOne({ _id: text });
        if (!u) { await tgSend(chatId, '❌ User not found.', { reply_markup: adminKb }); return res.status(200).json({ ok: true }); }
        const wCount = await withdrawals.countDocuments({ userId: text });
        const accountAgeDays = Math.floor((Date.now() - new Date(u.createdAt).getTime()) / 86400000);
        await tgSend(chatId,
            `👤 <b>User Info</b>\n\n` +
            `ID: <code>${u._id}</code>\n` +
            `Name: <b>${u.firstName}</b> (@${u.telegramUsername || 'none'})\n` +
            `💰 Balance: <b>${u.wtcBalance || 0} WTC</b>\n` +
            `💎 Lifetime Earned: <b>${u.lifetimeWtcEarned || 0} WTC</b>\n` +
            `📦 Pending Video Lootbox: <b>${u.pendingVideoWTC || 0} WTC</b>\n` +
            `✅ Tasks Completed: <b>${(u.completedTasks || []).length}</b>\n` +
            `👥 Referrals: <b>${u.referralCount || 0}</b>\n` +
            `📤 Withdrawals: <b>${wCount}</b>\n` +
            `📺 Ads Watched (lifetime): <b>${u.lifetimeAdsWatched || 0}</b> · today: <b>${u.adsWatchedToday || 0}</b>\n` +
            `🚩 Multi-Acc Flag: <b>${u.multiAccountFlag ? 'YES ⚠️' : 'No'}</b>\n` +
            `🚫 Banned: <b>${u.isBanned ? 'YES ⛔' : 'No ✅'}</b>\n` +
            `📅 Joined: ${new Date(u.createdAt).toLocaleDateString()} (${accountAgeDays} day${accountAgeDays === 1 ? '' : 's'} ago)`,
            { reply_markup: { inline_keyboard: [
                [u.isBanned ? { text: '✅ Unban User', callback_data: `unban_${u._id}` } : { text: '🚫 Ban User', callback_data: `ban_${u._id}` }],
                [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
            ] } }
        );
        return res.status(200).json({ ok: true });
    }

    // ── Send WTC ──
    if (s.step === 'sendwtc_id') {
        s.targetId = text; s.step = 'sendwtc_amount';
        await setAdminState(fromId, s);
        await tgSend(chatId, `💰 কত <b>WTC</b> পাঠাবেন <code>${text}</code> কে?`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'sendwtc_amount') {
        const amt = parseInt(text);
        if (!amt || isNaN(amt)) { await tgSend(chatId, '❌ সঠিক সংখ্যা দিন'); return res.status(200).json({ ok: true }); }
        const u = await users.findOne({ _id: s.targetId });
        await clearAdminState(fromId);
        if (!u) { await tgSend(chatId, '❌ User not found.', { reply_markup: adminKb }); return res.status(200).json({ ok: true }); }
        await users.updateOne({ _id: s.targetId }, { $inc: { wtcBalance: amt, lifetimeWtcEarned: amt } });
        await tgSend(chatId, `✅ <b>${amt} WTC</b> পাঠানো হয়েছে <code>${s.targetId}</code> কে`, { reply_markup: adminKb });
        await tgSend(s.targetId, `🎁 আপনি admin থেকে <b>${amt} WTC</b> পেয়েছেন!`);
        return res.status(200).json({ ok: true });
    }

    // ── Broadcast — multi-step: text → button (optional) → photo (optional) → confirm ──
    if (s.step === 'bc_text') {
        s.text = text; s.step = 'bc_button_text';
        await setAdminState(fromId, s);
        await tgSend(chatId, '📢 <b>Broadcast — Step 2/4</b>\n\nAdd an inline button? Send the button text, or skip:', { reply_markup: { inline_keyboard: [[{ text: '⏭ Skip button', callback_data: 'bc_skip_button' }], [{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'bc_button_text') {
        s.buttonText = text; s.step = 'bc_button_url';
        await setAdminState(fromId, s);
        await tgSend(chatId, `Button text: ✅ <b>${text}</b>\n\nNow send the button's URL (https://...):`, { reply_markup: cancelKb });
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'bc_button_url') {
        if (!/^https?:\/\//.test(text)) { await tgSend(chatId, '❌ URL must start with http:// or https:// — try again:'); return res.status(200).json({ ok: true }); }
        s.buttonUrl = text; s.step = 'bc_photo';
        await setAdminState(fromId, s);
        await tgSend(chatId, '📢 <b>Broadcast — Step 3/4</b>\n\nSend a photo to attach (or skip):', { reply_markup: { inline_keyboard: [[{ text: '⏭ Skip photo', callback_data: 'bc_skip_photo' }], [{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
        return res.status(200).json({ ok: true });
    }

    // ── Promo — auto generate ──
    if (s.step === 'promo_count') {
        const count = parseInt(text);
        if (!count || isNaN(count) || count < 1 || count > 50) { await tgSend(chatId, '❌ ১ থেকে ৫০ এর মধ্যে একটা সংখ্যা দিন:'); return res.status(200).json({ ok: true }); }
        s.count = count; s.step = 'promo_reward';
        await setAdminState(fromId, s);
        await tgSend(chatId, `🎟 <b>${count}</b> টা কোড বানানো হবে\n\nপ্রতি কোডে কত <b>WTC reward</b>?`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'promo_reward') {
        s.reward = parseInt(text);
        if (!s.reward || isNaN(s.reward)) { await tgSend(chatId, '❌ সঠিক সংখ্যা দিন:'); return res.status(200).json({ ok: true }); }
        s.step = 'promo_maxuses';
        await setAdminState(fromId, s);
        await tgSend(chatId, `Reward: <b>${s.reward} WTC</b>\n\nপ্রতি কোড সর্বোচ্চ কতবার ব্যবহার হতে পারবে? (0 = unlimited):`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'promo_maxuses') {
        const maxUses = parseInt(text) || 9999;
        await clearAdminState(fromId);
        const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const generated = [];
        for (let i = 0; i < s.count; i++) {
            const code = String(Math.floor(100000 + Math.random() * 900000));
            await promos.insertOne({ code, reward: s.reward, maxUses, usedCount: 0, redeemedBy: [], expiresAt: expireAt, createdAt: new Date() });
            generated.push(code);
        }
        const codeList = generated.map((c, i) => `${i + 1}. <code>${c}</code>`).join('\n');
        await tgSend(chatId,
            `✅ <b>${s.count} Promo Code(s) তৈরি হয়েছে!</b>\n\n💰 Reward: <b>${s.reward} WTC</b> প্রতিটায়\n👥 Max uses: <b>${maxUses}</b>\n⏰ Expires: <b>24 hours</b>\n\n📋 <b>Codes:</b>\n${codeList}`,
            { reply_markup: adminKb }
        );
        return res.status(200).json({ ok: true });
    }

    // ── Add Video — ২ স্টেপ ──
    if (s.step === 'video_id') {
        const videoId = extractYoutubeId(text);
        if (!videoId) { await tgSend(chatId, '❌ সঠিক YouTube লিংক বা ID দিন (১১ ক্যারেক্টার):'); return res.status(200).json({ ok: true }); }
        s.videoId = videoId; s.step = 'video_title';
        await setAdminState(fromId, s);
        await tgSend(chatId, `🎬 <b>Step 2/2</b>\n\nVideo ID: ✅ <code>${videoId}</code>\n\nভিডিওর <b>title</b> দিন:`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'video_title') {
        await clearAdminState(fromId);
        // YouTube থাম্বনেইল URL প্যাটার্ন প্রেডিক্টেবল — আলাদা API কল লাগে না, সরাসরি বানিয়ে নেওয়া যায়
        const thumbnail = `https://img.youtube.com/vi/${s.videoId}/hqdefault.jpg`;
        await videos.insertOne({ videoId: s.videoId, title: text, thumbnail, isActive: true, createdAt: new Date() });
        await tgSend(chatId, `✅ <b>Video যুক্ত হয়েছে!</b>\n\n🎬 ${text}\n🔗 <code>${s.videoId}</code>\n🖼 Thumbnail auto-added`, { reply_markup: adminKb });
        return res.status(200).json({ ok: true });
    }

    // ── Add Task — ৫ স্টেপ ──
    if (s.step === 'task_title') {
        s.title = text; s.step = 'task_category';
        await setAdminState(fromId, s);
        await tgSend(chatId, `📋 <b>Step 2/5</b>\n\nTitle: ✅ <b>${s.title}</b>\n\nTask টাইপ বাছুন:`, { reply_markup: { inline_keyboard: [
            [{ text: '✅ Channel/Group Join', callback_data: 'task_cat_channel' }],
            [{ text: '🌐 Partner Link (YouTube/FB)', callback_data: 'task_cat_partner' }],
        ] } });
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'task_channelid') {
        s.channelId = text.startsWith('@') ? text : `@${text}`;
        s.url = `https://t.me/${s.channelId.replace('@', '')}`;
        s.step = 'task_reward';
        await setAdminState(fromId, s);
        await tgSend(chatId, `📋 <b>Step 3/5</b>\n\nChannel: ✅ <code>${s.channelId}</code>\n\nকত <b>WTC reward</b> দিতে চান?`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'task_url') {
        s.url = text; s.channelId = null; s.step = 'task_reward';
        await setAdminState(fromId, s);
        await tgSend(chatId, `📋 <b>Step 3/5</b>\n\nLink: ✅ ${s.url}\n\nকত <b>WTC reward</b> দিতে চান?`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'task_reward') {
        s.reward = parseInt(text);
        if (!s.reward || isNaN(s.reward)) { await tgSend(chatId, '❌ সঠিক সংখ্যা দিন:'); return res.status(200).json({ ok: true }); }
        s.step = 'task_quantity';
        await setAdminState(fromId, s);
        await tgSend(chatId, `📋 <b>Step 4/5</b>\n\nকতজন ইউজার এই task করতে পারবে?\n(সংখ্যা দিন, বা <code>0</code> = unlimited):`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'task_quantity') {
        s.limit = parseInt(text) || 0;
        s.step = 'task_confirm';
        await setAdminState(fromId, s);
        const preview =
            `📋 <b>Task Preview</b>\n\n` +
            `Title: <b>${s.title}</b>\n` +
            `Category: <b>${s.category}</b>\n` +
            `Link: ${s.url || 'none'}\n` +
            (s.channelId ? `Channel: <code>${s.channelId}</code>\n` : '') +
            `Reward: <b>${s.reward} WTC</b>\n` +
            `Max: <b>${s.limit || 'Unlimited'}</b>\n\n` +
            (s.category === 'channel' ? `⚠️ নিশ্চিত করুন বট ওই channel/group-এ admin আছে!\n\n` : '') +
            `সেভ করতে <b>CONFIRM</b> টাইপ করুন:`;
        await tgSend(chatId, preview, { reply_markup: cancelKb });
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'task_confirm') {
        if (text.toUpperCase() !== 'CONFIRM') { await tgSend(chatId, '❌ সেভ করতে <b>CONFIRM</b> টাইপ করুন:'); return res.status(200).json({ ok: true }); }
        await clearAdminState(fromId);
        await tasks.insertOne({
            title: s.title, url: s.url, channelId: s.channelId, category: s.category,
            rewardWtc: s.reward, limit: s.limit, isApproved: true, completionCount: 0, createdAt: new Date(),
        });
        await tgSend(chatId, `✅ <b>Task তৈরি হয়েছে!</b>\n\n📋 ${s.title}\n💰 ${s.reward} WTC\n👥 Max: ${s.limit || 'Unlimited'}`, { reply_markup: adminKb });
        return res.status(200).json({ ok: true });
    }

    // ── ডিফল্ট ──
    await tgSend(chatId, '👑 <b>NEWTUBE Admin Panel</b>', { reply_markup: adminKb });
    res.status(200).json({ ok: true });
}
