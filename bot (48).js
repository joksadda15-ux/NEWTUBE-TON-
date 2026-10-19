// api/bot.js — NEWTUBE Admin Panel Bot (Season 3)
//
// Adapted from the bot__4_.js reference, with a few important
// changes/fixes:
//   1) ADMIN_ID → ADMIN_TELEGRAM_ID (to match the env var name on Vercel)
//   2) Dropped in-memory state{} — now persisted in MongoDB (lib/adminState.js),
//      since in-memory state can be lost on Vercel serverless cold starts
//   3) Uses _id instead of a telegramId field (matches our users schema)
//   4) egBalance → wtcBalance, single currency
//   5) New: 🎬 Add Video (NEWTUBE's core feature — earn by watching videos)
//   6) ⚠️ SEASON 3 — the 🚩 Multi-Account Flags admin panel (device-cluster
//      review, auto-suspend-the-rest-on-tap, "Make Main") is REMOVED.
//      Enforcement happens live at the door via lib/ipRegistry.js (Season 4:
//      keyed by device fingerprint, IP only as a fallback — see that file),
//      not via a manual admin queue — this panel was fully redundant with
//      that and is gone. Ban/unban of an individual user (ban_/unban_
//      callbacks) is untouched.
//   7) A rejected withdraw fully refunds wtcAmount (including fee — since real money was never sent)

import { ObjectId } from 'mongodb';
import { buildCycleReport, renderCycleShort, renderCycleFull, renderCycleSnapshotLine } from '../lib/cycleStats.js'; // 18 Oct 2026 — 📊 Cycle Report
import { cyInc, cyMin } from '../lib/cycleStats.js';
import { connectToDatabase } from '../lib/mongodb.js';
import { escHtml, tgApi, tgSend, tgEdit, tgEditCaption, tgSendPhoto, tgAnswerCallback, isMember, OFFICIAL_CHANNEL, COMMUNITY_GROUP, PAYMENT_CHANNEL, PAYMENT_PROOF_PHOTO } from '../lib/telegram.js';
import { getAdminState, setAdminState, clearAdminState } from '../lib/adminState.js';
import { maybeAwardReferralMilestones } from '../lib/referral.js';
import { createBroadcastJob } from '../lib/broadcastJob.js';
import { waitUntil } from '@vercel/functions';
import { WEEKLY_REFERRAL_MIN_COUNT, WEEKLY_REFERRAL_MAX_WINNERS, WTC_PER_USD, WITHDRAW_REFERRAL_COMMISSION_PERCENT, fmtBDDateTime, fmtBDDate, WALLET_CHANGE_PENALTY_PERCENT, WALLET_CHANGE_MAX_REQUESTS, todayStartBD } from '../lib/constants.js';
import { markBanned, markUnbanned } from '../lib/banRegistry.js';
import { buildTrustReport, renderTrustShort, renderTrustFull } from '../lib/trustReport.js'; // 17 Oct 2026 — fake/real report
import { handleSignupCallback } from '../lib/signupBursts.js';                                 // 18 Oct 2026 — 🆕 Signup Bursts (ported from Fruit Cut admin)
import { cleanupAfterWithdraw } from '../lib/cycleCleanup.js';                                  // 17 Oct 2026 — post-withdraw cleanup

// Small formatter shared by the Manage Tasks listings — shows the USDT
// figure alongside its converted WTC amount for any old rows still priced
// in USDT (that option is no longer offered in Add Task), plain WTC otherwise.
function taskRewardLine(t) {
    return t.rewardCurrency === 'usdt' ? `${t.rewardUsdt} USDT (≈${t.rewardWtc} WTC)` : `${t.rewardWtc} WTC`;
}

// "🗑 Manage Tasks" now opens a category picker first instead of
// dumping every task together. 'all' keeps the old mixed-list behavior.
// Note: 'daily' is intentionally absent here — the Daily task panel was
// removed from the Mini App's Task section, so daily-category tasks no
// longer display anywhere in the app; filtering by it here would just be
// dead weight. Any leftover daily-category rows in the DB are still
// reachable (and deletable) via the "All" filter.
const TASK_MANAGE_CATEGORIES = [
    { id: 'exclusive', label: '⭐ Exclusive' },
    { id: 'partner', label: '🤝 Partner' },
    { id: 'earning', label: '👥 Earning' },
    { id: 'channel', label: '✅ Verify' },
    { id: 'all', label: '📋 All' },
];

// Shared renderer for a filtered/paginated task list — used by both the
// category-select flow and the post-delete refresh, so they can't drift.
// fromId decides whether Remove buttons show at all: the task
// moderator only gets a Remove button on tasks they created themselves
// (t.createdBy === fromId). Admin-created tasks (createdBy === ADMIN_ID, or
// missing entirely on legacy tasks made before this field existed) show no
// button to the moderator — not even a disabled one, so there's nothing to
// tap and no hint that a removable-by-someone-else task exists.
async function renderTaskManageList(tasksCol, category, page, fromId) {
    const perPage = 8;
    const filter = category === 'all' ? {} : { category };
    const all = await tasksCol.find(filter).sort({ createdAt: -1 }).skip(page * perPage).limit(perPage).toArray();
    const totalCount = await tasksCol.countDocuments(filter);
    const catLabel = (TASK_MANAGE_CATEGORIES.find(c => c.id === category) || {}).label || category;
    if (!all.length) {
        return [page === 0 ? `📭 No ${catLabel} tasks yet.` : '📭 No more tasks.', { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'a_managetasks_menu' }]] }];
    }
    let text_ = `📋 <b>Manage Tasks — ${catLabel}</b> (${totalCount} total)\n\n`;
    all.forEach(t => {
        text_ += `<b>${t.title}</b> <i>[${t.category}]</i>\n✅ Completed: <b>${t.completionCount || 0}</b>${t.limit ? ` / ${t.limit}` : ' (unlimited)'} · 💰 ${taskRewardLine(t)}\n\n`;
    });
    const canDelete = t => isAdmin(fromId) || t.createdBy === fromId;
    const rows = all.filter(canDelete).map(t => ([{ text: `🗑 Remove: ${t.title.slice(0, 24)}`, callback_data: `deltask_${category}_${page}_${t._id}` }]));
    const navRow = [];
    if (page > 0) navRow.push({ text: '◀️ Prev', callback_data: `a_taskcat_${category}_${page - 1}` });
    if ((page + 1) * perPage < totalCount) navRow.push({ text: 'Next ▶️', callback_data: `a_taskcat_${category}_${page + 1}` });
    if (navRow.length) rows.push(navRow);
    rows.push([{ text: '◀️ Back', callback_data: 'a_managetasks_menu' }]);
    return [text_, { inline_keyboard: rows }];
}


// ⚠️ markBanned/markUnbanned moved to lib/banRegistry.js — now shared with
// lib/fingerprintCheck.js, which auto-bans a newly-detected multi-account
// signup using the exact same registry logic as a manual admin ban here.

// "🕐 Pending Review": user-created tasks (paid via TON, see
// api/payments.js (cron=checkDeposits)) land here FIRST — isApproved:false,
// reviewStatus:'pending_review' — completely invisible in the Mini App's
// Task tab until an admin/task-moderator approves them below. No
// pagination (kept simple — this queue should stay naturally small since
// getting into it requires an actual on-chain TON payment); shows the
// newest-paid-last (oldest first) so nothing sits forgotten at the bottom.
async function renderPendingReviewList(tasksCol) {
    const pending = await tasksCol.find({ isUserCreated: true, reviewStatus: 'pending_review' }).sort({ createdAt: 1 }).limit(20).toArray();
    if (!pending.length) {
        return ['✅ No tasks waiting for review.', backKb];
    }
    let text_ = `🕐 <b>Pending Review</b> (${pending.length})\n\n`;
    const rows = [];
    pending.forEach(t => {
        text_ += `📋 <b>${t.title}</b>\n🔗 ${t.url}\n🔎 Type: ${t.verifyType === 'api' ? 'Channel/Group Join (API)' : 'Link'} · 👥 ${t.limit} slots · 💰 ${t.rewardWtc} WTC/person\n🧾 Creator ID: <code>${t.createdBy}</code>\n\n`;
        rows.push([
            { text: `✅ Approve: ${t.title.slice(0, 16)}`, callback_data: `taskrev_approve_${t._id}` },
            { text: '❌ Reject', callback_data: `taskrev_reject_${t._id}` },
        ]);
    });
    rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
    return [text_, { inline_keyboard: rows }];
}

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

// task-only moderator (partner). Single second Telegram ID, env var
// TASK_MODERATOR_ID. Deliberately scoped to Add Task / Manage Tasks only —
// every other admin action (withdrawals, promo codes, send WTC, gift,
// broadcast, ban, user lookup) stays admin-only. Two gates enforce this:
// isStaff() decides who gets into the panel at all, isTaskAction()/step
// prefix 'task_' decide what a non-admin staff member is actually allowed
// to touch once inside — see the two router gates below (callback_query
// and text-message handlers) for where these are applied.
const TASK_MODERATOR_ID = process.env.TASK_MODERATOR_ID;
function isAdmin(id) { return String(id) === String(ADMIN_ID); }
function isTaskModerator(id) { return !!TASK_MODERATOR_ID && String(id) === String(TASK_MODERATOR_ID); }
function isStaff(id) { return isAdmin(id) || isTaskModerator(id); }
const TASK_CALLBACK_PREFIXES = ['a_addtask', 'task_cat_', 'task_verify_', 'a_managetasks_menu', 'a_taskcat_', 'deltask_', 'a_menu', 'a_pendingreview', 'taskrev_'];
function isTaskCallback(data) { return TASK_CALLBACK_PREFIXES.some(p => data === p || data.startsWith(p)); }

// Deployment URLs
const APP_URL = 'https://newtube-ton.vercel.app';                       // your Mini App's Vercel URL
const MINI_APP_URL = 'https://t.me/NewTube12_bot/WatchTo_Earn';
const COVER_PHOTO = 'https://i.postimg.cc/Gtp63QQV/file-000000007fa87207ae71dda1cde1426b.png'; // shown only in users' /start, not to the admin


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
        [{ text: '🏆 Top Referrers', callback_data: 'a_toprefer' }, { text: '📅 Weekly Refer', callback_data: 'a_weekly' }],
        [{ text: '📜 Weekly Report', callback_data: 'a_weekly_history' }, { text: '🆕 Signup Bursts', callback_data: 'a_signups' }],
        [{ text: '📋 Add Task', callback_data: 'a_addtask' }, { text: '🎬 Add Video', callback_data: 'a_addvideo' }],
        [{ text: '🗑 Manage Tasks', callback_data: 'a_managetasks_menu' }, { text: '🗑 Manage Videos', callback_data: 'a_managevideos_0' }],
        [{ text: '🕐 Pending Review', callback_data: 'a_pendingreview' }],
        [{ text: '🎟 Add Promo', callback_data: 'a_addpromo' }, { text: '📋 View Promos', callback_data: 'a_viewpromos_0' }],
        [{ text: '📢 Broadcast', callback_data: 'a_broadcast' }, { text: '📣 Channel Post', callback_data: 'a_chpost' }],
        [{ text: '💰 Send WTC', callback_data: 'a_sendwtc' }, { text: '🎁 Send Gift', callback_data: 'a_sendgift' }],
        [{ text: '💳 Payout Wallet', callback_data: 'a_payoutwallet' }],
    ],
};
const backKb = { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] };

// the limited menu shown to the task moderator (see TASK_MODERATOR_ID
// above). Only the task buttons — nothing that touches money or users.
const taskModeratorKb = {
    inline_keyboard: [
        [{ text: '📋 Add Task', callback_data: 'a_addtask' }],
        [{ text: '🗑 Manage Tasks', callback_data: 'a_managetasks_menu' }],
        [{ text: '🕐 Pending Review', callback_data: 'a_pendingreview' }],
    ],
};
function kbFor(fromId) { return isAdmin(fromId) ? adminKb : taskModeratorKb; }

// weaves an invisible zero-width character (U+2060 WORD JOINER)
// between every character of a promo code. Renders identically to a human
// reading it in the broadcast, but a copy-paste of it into the redeem box
// carries those invisible characters along — since the code stored in the
// database is clean, the pasted (polluted) string won't match, and
// redemption fails until the user types the code in manually. This is a
// friction/deterrent measure, not a hard guarantee — Telegram has no way
// to truly disable text selection/copying, and a technically inclined
// person could still strip the invisible characters before pasting. It
// stops casual copy-paste-forward sharing, which is the realistic threat.
function obscureCode(code) {
    return code.split('').join('\u2060');
}
const cancelKb = { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_menu' }]] };

// ══════════════════════════════════════════════════════════════
// 📣 OFFICIAL CHANNEL POSTS (15 Oct 2026, admin request)
//  • Promo codes are auto-posted to OFFICIAL_CHANNEL (@Newtube_offcial) right after they are generated.
//  • Admin can also write a free post from the bot menu (📣 Channel Post).
//  • The picture is saved PERMANENTLY (Telegram file_id in db `botSettings`, _id 'channelPost') — set it once.
//  • EVERY post carries an "Open NEWTUBE" button. (Channels only allow URL buttons, so it is the t.me mini-app link.)
// ══════════════════════════════════════════════════════════════
const CHANNEL_SETTINGS_ID = 'channelPost';
const channelOpenKb = { inline_keyboard: [[{ text: '🚀 Open NEWTUBE', url: MINI_APP_URL }]] };
async function getChannelSettings(db) {
    const d = await db.collection('botSettings').findOne({ _id: CHANNEL_SETTINGS_ID });
    return { autoPromo: d ? d.autoPromo !== false : true, photoFileId: d?.photoFileId || null };
}
async function saveChannelSettings(db, patch) {
    await db.collection('botSettings').updateOne({ _id: CHANNEL_SETTINGS_ID }, { $set: patch }, { upsert: true });
}
// Posts to the official channel. Returns { ok, messageId, isPhoto, error }.
async function postToChannel(text, photoFileId) {
    let r, isPhoto = false;
    if (photoFileId) {
        if (text.length > 1000) return { ok: false, error: 'With a picture the text can be at most ~1000 characters (Telegram caption limit).' };
        r = await tgSendPhoto(OFFICIAL_CHANNEL, photoFileId, text, { reply_markup: channelOpenKb });
        isPhoto = !!r.ok;
    }
    if (!r || !r.ok) r = await tgSend(OFFICIAL_CHANNEL, text, { reply_markup: channelOpenKb, disable_web_page_preview: true });
    if (!r.ok) return { ok: false, error: r.description || 'Telegram refused the post (is the bot an admin of the channel?)' };
    return { ok: true, messageId: r.result.message_id, isPhoto };
}
function buildPromoPostText(codes, reward, maxUses) {
    const lines = codes.map((c, i) => (codes.length > 1 ? `${i + 1}. ` : '') + `<code>${obscureCode(c)}</code>`).join('\n');
    return `🎁 <b>Free WTC Promo Code${codes.length > 1 ? 's' : ''}!</b>\n\n` +
        `Redeem and get <b>${reward} WTC</b> instantly — type it into the "Have a promo code?" box on Home.\n\n` +
        `🎟 ${codes.length > 1 ? 'Codes (pick any one):' : 'Code:'}\n${lines}\n\n` +
        (maxUses && maxUses < 9999 ? `👥 Only <b>${maxUses}</b> people per code — first come, first served!\n` : '') +
        `⏰ Expires in <b>24 hours</b> — be quick!`;
}
// Posts a batch of promo codes and remembers the channel message on each promo (so claimPromo can mark it "all claimed").
async function postPromoBatchToChannel(db, codes, reward, maxUses) {
    const cs = await getChannelSettings(db);
    const r = await postToChannel(buildPromoPostText(codes, reward, maxUses), cs.photoFileId);
    if (r.ok) await db.collection('promos').updateMany({ code: { $in: codes } }, { $set: { channelMsgId: r.messageId, channelPostIsPhoto: r.isPhoto } });
    return { ...r, hadPhoto: !!cs.photoFileId };
}
async function renderChannelMenu(db) {
    const cs = await getChannelSettings(db);
    const text = `📣 <b>Channel Post</b> — ${OFFICIAL_CHANNEL}\n\n` +
        `🖼 Saved picture: <b>${cs.photoFileId ? 'Yes (permanent)' : 'Not set'}</b>\n` +
        `🤖 Auto-post new promo codes: <b>${cs.autoPromo ? 'ON' : 'OFF'}</b>\n\n` +
        `Every post gets an <b>Open NEWTUBE</b> button.`;
    const kb = { inline_keyboard: [
        [{ text: '✍️ New Channel Post', callback_data: 'chp_new' }],
        [{ text: cs.photoFileId ? '🖼 Change Picture' : '🖼 Set Picture', callback_data: 'chp_setpic' }, ...(cs.photoFileId ? [{ text: '🗑 Remove Picture', callback_data: 'chp_delpic' }] : [])],
        [{ text: `🤖 Auto-post promo: ${cs.autoPromo ? 'ON ✅' : 'OFF ❌'} (tap to switch)`, callback_data: 'chp_auto' }],
        [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
    ] };
    return [text, kb];
}
// Preview of a manual post (shown exactly like the channel post, plus confirm buttons).
async function sendChannelPreview(chatId, st) {
    const rows = [[{ text: '🚀 Open NEWTUBE', url: MINI_APP_URL }], [{ text: '✅ Post to Channel', callback_data: 'chp_send' }], [{ text: '◀️ Cancel', callback_data: 'a_menu' }]];
    const extra = { reply_markup: { inline_keyboard: rows } };
    if (st.photoFileId) await tgSendPhoto(chatId, st.photoFileId, st.text, extra);
    else await tgSend(chatId, st.text, extra);
    await tgSend(chatId, '👆 <b>Preview.</b> This is how it will look in the channel. Tap <b>✅ Post to Channel</b> to publish.');
}

// ── Shared user-detail + moderation panel — used by both numeric-ID lookup
// and the "tap a name" flow from username search / top-referrer drill-down.
// Returns [text, options] so callers can just do tgSend(chatId, ...renderUserLookup(u, withdrawalsList)).
// 18 Oct 2026 — 3rd param `cycle` = result of buildCycleReport() (lib/cycleStats.js): ads / mining / lootbox / tasks … since the last withdraw. null = skipped.
function renderUserLookup(u, withdrawalsList = [], cycle = null) {
    // most recent withdrawal (any status) so the admin sees "when did this user last withdraw"
    const lastW = [...withdrawalsList].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    const wCount = withdrawalsList.length;
    const totalWithdrawnWtc = withdrawalsList.filter(w => w.status === 'approved').reduce((sum, w) => sum + (w.wtcAmount || 0), 0);
    const pendingWithdrawCount = withdrawalsList.filter(w => w.status === 'pending' || w.status === 'processing').length;
    // 17 Oct 2026 — clearer withdraw numbers (approved / pending / rejected alada) + the last APPROVED payout separately
    const approvedList = withdrawalsList.filter(w => w.status === 'approved');
    const rejectedCount = withdrawalsList.filter(w => w.status === 'rejected').length;
    const lastApproved = [...approvedList].sort((a, b) => new Date(b.processedAt || b.createdAt) - new Date(a.processedAt || a.createdAt))[0];
    const accountAgeDays = Math.floor((Date.now() - new Date(u.createdAt).getTime()) / 86400000);

    const text =
        `👤 <b>User Info</b>\n\n` +
        `ID: <code>${u._id}</code>\n` +
        `Name: <b>${u.firstName}</b> (@${u.telegramUsername || 'none'})\n` +
        `💰 Balance: <b>${u.wtcBalance || 0} WTC</b>\n` +
        `💎 Lifetime Earned: <b>${u.lifetimeWtcEarned || 0} WTC</b>\n` +
        `📦 Pending Video Lootbox: <b>${u.pendingVideoWTC || 0} WTC</b>\n` +
        `✅ Tasks Completed: <b>${(u.completedTasks || []).length}</b>\n` +
        `👥 Referrals: <b>${u.referralCount || 0}</b>\n` +
        `📤 Withdrawals: <b>${wCount}</b> total — ✅ <b>${approvedList.length}</b> approved (${totalWithdrawnWtc.toLocaleString()} WTC) · ⏳ <b>${pendingWithdrawCount}</b> pending · ❌ <b>${rejectedCount}</b> rejected\n` +
        `📺 Ads Watched (lifetime): <b>${u.lifetimeAdsWatched || 0}</b> · today: <b>${u.adsWatchedToday || 0}</b>\n` +
        `✅ Channel/Community Verified: <b>${u.channelVerified ? 'Yes' : 'No'}</b>\n` +
        `🚫 Banned: <b>${u.isBanned ? 'YES ⛔' : 'No ✅'}</b>\n` +
        `🔒 Locked: <b>${u.accountLocked ? `YES 🔒 (${u.accountLockedReason || 'unknown'})` : 'No ✅'}</b>\n` +
        // surfaces the device-fingerprint multi-account flag (see
        // lib/fingerprintCheck.js) that previously had NO admin-panel
        // visibility at all — an admin had no way to even see it, let alone
        // clear it, without touching the DB directly. Shows the sibling
        // count so the admin can judge "plausible shared device" vs "looks
        // like a farm" at a glance. If a REVIEW note was left (see the deny
        // path below), that's shown too.
        (u.multiAccountFlag
            ? `🚩 Multi-Account Flag: <b>YES</b> — ${(u.multiAccountSiblings || []).length} other account(s) on this device${u.multiAccountClearedAt ? ` (previously cleared ${fmtBDDate(u.multiAccountClearedAt)}, re-flagged since)` : ''}\n`
            : (u.multiAccountClearedAt ? `🚩 Multi-Account Flag: cleared by admin (${fmtBDDate(u.multiAccountClearedAt)})\n` : '')) +
        (u.velocityFlaggedAt ? `🚩 Velocity flagged: <b>YES</b> (${fmtBDDateTime(u.velocityFlaggedAt)})\n` : '') +
        `🕒 Last withdraw request: <b>${lastW ? `${fmtBDDateTime(lastW.createdAt)} — ${(lastW.wtcAmount || 0).toLocaleString()} WTC (${lastW.status})` : 'Never'}</b>\n` +
        `✅ Last approved payout: <b>${lastApproved ? `${fmtBDDateTime(lastApproved.processedAt || lastApproved.createdAt)} — ${(lastApproved.wtcAmount || 0).toLocaleString()} WTC` : 'Never'}</b>\n` +
        (cycle ? `\n${renderCycleShort(cycle)}\n\n` : '') +
        `📅 Joined: ${fmtBDDate(u.createdAt)} (${accountAgeDays} day${accountAgeDays === 1 ? '' : 's'} ago)`;

    const options = { reply_markup: { inline_keyboard: [
        [u.isBanned ? { text: '✅ Unban User', callback_data: `unban_${u._id}` } : { text: '🚫 Ban User', callback_data: `ban_${u._id}` }],
        // NEW — bans this user AND everyone they referred (with a confirm step first).
        [{ text: '☠️ Ban User + All Referrals', callback_data: `banall_${u._id}` }],
        // Lock/Unlock is now a manual admin action either way
        // (velocity alerts no longer auto-lock), so both directions are
        // always available here instead of only showing Unlock once locked.
        [u.accountLocked ? { text: '🔓 Unlock Account', callback_data: `unlock_${u._id}` } : { text: '🔒 Lock Account', callback_data: `lock_${u._id}` }],
        [{ text: '💸 Confiscate Balance', callback_data: `zerobal_${u._id}` }, { text: '🔄 Reset Referrals', callback_data: `resetrefs_${u._id}` }],
        [{ text: '👥 View Their Referrals', callback_data: `a_refslist_${u._id}_0` }, { text: '💰 Send WTC', callback_data: `quickwtc_${u._id}` }],
        [{ text: '📦 Lootbox History (30d)', callback_data: `lootlog_${u._id}` }],
        [{ text: '📊 Cycle Report', callback_data: `trust_${u._id}` }, { text: '💸 Withdraw History', callback_data: `wdhist_${u._id}` }],
        // only shown while actually flagged. Clearing lets this
        // account earn normally again regardless of sibling count (see
        // MULTI_ACCOUNT_SIBLING_HARD_LIMIT in api/earn.js) — for the
        // legitimate "yes this is really a shared family device" case that
        // the automatic sibling-count gate can't distinguish from farming on
        // its own.
        ...(u.multiAccountFlag ? [[{ text: '🧹 Clear Multi-Account Flag', callback_data: `clearmaf_${u._id}` }]] : []),
        [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
    ] } };
    return [text, options];
}

// Sends a broadcast preview — lets the admin do a final check of what will be sent
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

    // this webhook had ZERO verification that an
    // incoming request actually came from Telegram. It just trusted
    // `req.body` as a genuine Telegram update, including `message.from.id` /
    // `callback_query.from.id` — the exact value isStaff() checks against
    // for every admin-only action (approve/reject withdrawals, ban, confiscate
    // WTC, broadcast). Anyone who discovered this URL could POST a forged
    // JSON body with `from.id` set to the admin's own numeric Telegram ID
    // and get FULL ADMIN ACCESS without ever touching Telegram.
    //
    // Fix: Telegram supports a `secret_token` on setWebhook — once set, every
    // real webhook call carries it back in the X-Telegram-Bot-Api-Secret-Token
    // header, which only Telegram's own servers know (never sent to any
    // client, never appears in index.html or anywhere else public). We
    // verify that header here, first thing, before touching req.body at all.
    //
    // ── ONE-TIME SETUP REQUIRED (do this immediately alongside deploying
    //    this fix, or the bot stops responding until both steps are done) ──
    // 1. Add a new Vercel env var: TELEGRAM_WEBHOOK_SECRET — any long random
    //    string (Telegram requires 1-256 chars, only A-Z a-z 0-9 _ -).
    // 2. Re-register the webhook with that secret by visiting this URL once
    //    in a browser (replace both placeholders):
    //      https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://YOUR_DOMAIN/api/bot&secret_token=<YOUR_TELEGRAM_WEBHOOK_SECRET>
    //    A `{"ok":true,"result":true,...}` response confirms it worked.
    // Both steps must happen together — the code below REJECTS every request
    // if the secret doesn't match, which includes genuine Telegram traffic
    // until step 2 is done.
    const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!WEBHOOK_SECRET) {
        console.error('TELEGRAM_WEBHOOK_SECRET is not set — rejecting all webhook traffic until it is configured.');
        return res.status(401).json({ ok: false, error: 'server_misconfigured' });
    }
    if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const update = req.body;
    const { db } = await connectToDatabase();
    const users = db.collection('users');
    const withdrawals = db.collection('withdrawals');
    const tasks = db.collection('tasks');
    const promos = db.collection('promos');
    const videos = db.collection('videos');
    const gifts = db.collection('gifts');

    // ── 💸 AUTO PAYOUT (Tonkeeper) ── 15 Oct 2026
    // Order matters: (1) claim the payout so a double tap can never pay twice, (2) take a global lock so two payouts never
    // use the same wallet seqno, (3) send USDT, (4) ONLY if the network confirmed it → approve the withdrawal (user is notified).
    // If sending failed BEFORE anything left the wallet the admin can simply tap Approve again; if the outcome is unclear
    // nothing is retried automatically (double-payment risk) — the admin checks the wallet and uses ✋ Approve Manually.
    async function autoPayAndApprove({ w, chatId, msgId }) {
        const wid = String(w._id);
        // optional 24h dollar cap for this bot (Vercel: TON_PAYOUT_DAILY_MAX_USD). The per-payout cap (TON_PAYOUT_MAX_USD) lives in lib/tonPayout.js.
        const dayMax = Number(process.env.TON_PAYOUT_DAILY_MAX_USD);
        if (dayMax > 0) {
            const agg = await withdrawals.aggregate([
                { $match: { payoutStatus: { $in: ['sent', 'unknown'] }, payoutStartedAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } } },
                { $group: { _id: null, total: { $sum: '$cashAmount' } } },
            ]).toArray();
            const used = agg[0]?.total || 0;
            if (used + (w.cashAmount || 0) > dayMax) {
                await tgEdit(chatId, msgId, `🛡 <b>Daily payout limit reached.</b>\n\nLast 24h auto-paid: <b>$${used.toFixed(4)}</b> · this withdrawal: <b>$${(w.cashAmount || 0).toFixed(4)}</b> · limit: <b>$${dayMax}</b> (<code>TON_PAYOUT_DAILY_MAX_USD</code>).\n\nRaise the limit in Vercel, or approve manually.`, {
                    reply_markup: { inline_keyboard: [[{ text: '🔁 Retry Auto-Pay', callback_data: `wd_approve_${wid}` }], [{ text: '✋ Approve Manually', callback_data: `wd_manual_${wid}` }, { text: '❌ Reject', callback_data: `wd_reject_${wid}` }], [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] } });
                return;
            }
        }
        const claim = await withdrawals.findOneAndUpdate(
            { _id: w._id, status: 'pending', payoutStatus: { $nin: ['sending', 'sent', 'unknown'] } },
            { $set: { payoutStatus: 'sending', payoutStartedAt: new Date() } },
            { returnDocument: 'after' }
        );
        if (!claim) {
            await tgEdit(chatId, msgId, `⚠️ Withdrawal <code>${wid}</code> is already being paid or its payment status is unclear (check the payout wallet).`, {
                reply_markup: { inline_keyboard: [[{ text: '✋ Approve Manually', callback_data: `wd_manual_${wid}` }], [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] } });
            return;
        }
        const locks = db.collection('botSettings');
        await locks.updateOne({ _id: 'payoutLock' }, { $setOnInsert: { until: 0 } }, { upsert: true });
        const gotLock = await locks.findOneAndUpdate({ _id: 'payoutLock', until: { $lt: Date.now() } }, { $set: { until: Date.now() + 45000 } });
        if (!gotLock) {
            await withdrawals.updateOne({ _id: w._id }, { $set: { payoutStatus: 'failed', payoutError: 'another payout is in progress' } });
            await tgEdit(chatId, msgId, `⏳ Another payout is being sent right now. Wait ~30 seconds and tap Approve again.`, {
                reply_markup: { inline_keyboard: [[{ text: '✅ Approve (auto-pay)', callback_data: `wd_approve_${wid}` }], [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] } });
            return;
        }
        const retryKb = { inline_keyboard: [
            [{ text: '🔁 Retry Auto-Pay', callback_data: `wd_approve_${wid}` }],
            [{ text: '✋ Approve Manually', callback_data: `wd_manual_${wid}` }, { text: '❌ Reject', callback_data: `wd_reject_${wid}` }],
            [{ text: '⚠️ Wrong Address', callback_data: `wd_wrongaddr_${wid}` }],
        ] };
        try {
            await tgEdit(chatId, msgId, `💸 Sending <b>$${(w.cashAmount || 0).toFixed(4)} USDT</b> to <code>${escHtml(w.details)}</code> ...\n\nDo not tap anything, this takes ~15 seconds.`);
            let result;
            try {
                const { sendUsdtPayout } = await import('../lib/tonPayout.js');
                result = await sendUsdtPayout({ toAddress: w.details, amountUsd: w.cashAmount });
            } catch (e) {
                const msgText = escHtml(String(e.message || e).slice(0, 400));
                if (e.safeToRetry === false) {
                    await withdrawals.updateOne({ _id: w._id }, { $set: { payoutStatus: 'unknown', payoutError: String(e.message || e).slice(0, 400) } });
                    await tgEdit(chatId, msgId, `⚠️ <b>Payment status UNCLEAR</b> for <code>${wid}</code>\n\n${msgText}\n\n<b>Do NOT retry.</b> Open the payout wallet and look at the latest outgoing USDT transfer. If it went to the user → ✋ Approve Manually. If nothing was sent → ❌ Reject.`, {
                        reply_markup: { inline_keyboard: [[{ text: '✋ Approve Manually', callback_data: `wd_manual_${wid}` }, { text: '❌ Reject', callback_data: `wd_reject_${wid}` }]] } });
                } else {
                    await withdrawals.updateOne({ _id: w._id }, { $set: { payoutStatus: 'failed', payoutError: String(e.message || e).slice(0, 400) } });
                    await tgEdit(chatId, msgId, `❌ <b>Auto-pay failed — nothing was sent.</b>\n\n${msgText}\n\nFix it, then tap Retry.`, { reply_markup: retryKb });
                }
                return;
            }
            if (!result.confirmed) {
                await withdrawals.updateOne({ _id: w._id }, { $set: { payoutStatus: 'unknown', payoutError: 'sent, not confirmed within 14s' } });
                await tgEdit(chatId, msgId, `⚠️ <b>Sent, but not confirmed yet</b> for <code>${wid}</code>\n\nThe transfer was submitted but the wallet did not show it within 14 seconds. <b>Do NOT retry.</b> Check the payout wallet in a minute: if the USDT left → ✋ Approve Manually; if not → ❌ Reject.`, {
                    reply_markup: { inline_keyboard: [[{ text: '✋ Approve Manually', callback_data: `wd_manual_${wid}` }, { text: '❌ Reject', callback_data: `wd_reject_${wid}` }]] } });
                return;
            }
            await withdrawals.updateOne({ _id: w._id }, { $set: { payoutStatus: 'sent', payoutSeqno: result.seqno, payoutAt: new Date() } });
            const fresh = await withdrawals.findOne({ _id: w._id });
            // real transaction link when we found it on-chain; otherwise the user's address page
            const link = result.txHash
                ? `https://tonviewer.com/transaction/${result.txHash}`
                : `https://tonviewer.com/${encodeURIComponent(String(w.details).trim())}`;
            const done = await finalizeWithdrawal({ w: fresh, approve: true, txHash: link, chatId, msgId });
            if (!done) await tgSend(chatId, `⚠️ USDT was sent, but the withdrawal <code>${wid}</code> was already closed by someone else. Check it.`);
        } finally {
            await locks.updateOne({ _id: 'payoutLock' }, { $set: { until: 0 } }).catch(() => {});
        }
    }

    // Shared by the reject button, the "pasted a tx hash" reply and "Skip", so
    // approve/reject only has one place that touches the DB and sends the
    // notifications. `txHash` is a raw hash/link string, or null (skipped / reject).
    // Returns false if the withdrawal was already processed by someone else.
    async function finalizeWithdrawal({ w, approve, txHash, chatId, msgId }) {
        const wid = String(w._id);

        // Claim the withdrawal atomically. Without this, a double tap on
        // Approve/Reject runs the refund and the commission twice.
        const claimed = await withdrawals.findOneAndUpdate(
            { _id: new ObjectId(wid), status: 'pending' },
            { $set: { status: 'processing' } }
        );
        if (!claimed) return false;

        try {
            if (!approve) {
                // Withdrawals deduct straight from wtcBalance, so a reject refunds the
                // same wtcAmount. Consumed referrals are returned too, and
                // withdrawPending is released so the user can submit again.
                //
                // withdrawalCount is deliberately NOT decremented: it decides whether
                // a withdrawal is still in the referral-free phase, so it must only
                // ever go up. Decrementing it let a user get a request rejected and
                // then submit another "free" one, forever.
                const refundUpdate = { $inc: { wtcBalance: w.wtcAmount || 0 }, $set: { withdrawPending: false } };
                if (w.referralConsumed) refundUpdate.$inc.usedValidReferrals = -w.referralConsumed;
                await users.updateOne({ _id: w.userId }, refundUpdate);
            } else {
                // Approved: just release the one-at-a-time lock (no refund).
                await users.updateOne({ _id: w.userId }, { $set: { withdrawPending: false } });
            }
        } catch (e) {
            // Nothing was changed on the user, so make the request actionable again.
            await withdrawals.updateOne({ _id: new ObjectId(wid), status: 'processing' }, { $set: { status: 'pending' } }).catch(() => {});
            throw e;
        }

        // Referral commission is paid only on approval (never at request time), so a
        // rejected or fraudulent withdrawal never pays the referrer and nothing
        // needs to be clawed back.
        let referrerCommission = 0;
        if (approve && w.referrerId) {
            referrerCommission = Math.floor((w.wtcAmount || 0) * (WITHDRAW_REFERRAL_COMMISSION_PERCENT / 100));
            if (referrerCommission > 0) {
                try {
                    const referrerUpdate = await users.findOneAndUpdate(
                        { _id: w.referrerId, isBanned: { $ne: true }, accountLocked: { $ne: true } },
                        { $inc: { wtcBalance: referrerCommission, lifetimeWtcEarned: referrerCommission, referralCommissionEarned: referrerCommission, ...cyInc('refCommission', referrerCommission) }, $min: cyMin() },
                        { returnDocument: 'after' }
                    );
                    if (referrerUpdate) {
                        tgSend(
                            w.referrerId,
                            `💰 <b>Referral Commission!</b>\n\nOne of your referrals just withdrew ${(w.wtcAmount || 0).toLocaleString()} WTC.\nYou earned <b>${referrerCommission.toLocaleString()} WTC</b> (${WITHDRAW_REFERRAL_COMMISSION_PERCENT}% commission) 🎉`
                        ).catch(() => {});
                    }
                } catch (e) { /* non-blocking — commission failure never blocks the approval itself */ }
            }
        }

        await withdrawals.updateOne({ _id: new ObjectId(wid) }, { $set: { status: approve ? 'approved' : 'rejected', processedAt: new Date(), txHash: txHash || null, referrerCommissionPaid: referrerCommission } });

        // 17 Oct 2026 — APPROVE hole (payout hoye gese): ei cycle-er summary withdrawal doc-e rekhe user-er raw ad/video/lootbox
        // log muche fela hoy (lib/cycleCleanup.js). Task + referral + withdraw history thake. Reject hole kichu muchbe na.
        if (approve) {
            try { await cleanupAfterWithdraw(db, w.userId, new ObjectId(wid)); } catch (e) { console.error('cleanupAfterWithdraw failed:', e.message); }
        }

        // Explorer link for the "Transaction Hash" button: a pasted http(s) URL is used
        // as-is, a bare hash is assumed to be a TON transaction (tonviewer). Telegram
        // rejects the WHOLE message if a button URL is malformed, so anything that is
        // not a valid URL is dropped instead of breaking the user's notification.
        let explorerUrl = null;
        if (txHash) {
            const candidate = /^https?:\/\//i.test(txHash) ? txHash : `https://tonviewer.com/transaction/${encodeURIComponent(txHash)}`;
            try { explorerUrl = new URL(candidate).toString(); } catch { explorerUrl = null; }
        }

        const notif = approve
            ? `🎉 <b>Congratulations!</b>\n\n` +
              `You've received <b>${w.cashAmount.toFixed(4)} ${w.currency}</b>\n` +
              `📍 <code>${escHtml(w.details)}</code>\n\n` +
              `💪 Keep up the great work! Watch more ads, complete tasks, and refer your friends to earn even more WTC every day. 🚀`
            : `❌ <b>Withdrawal Rejected.</b>\n${(w.wtcAmount || 0).toLocaleString()} WTC has been refunded to your balance.`;
        // On approval: a "Transaction Hash" button (if the admin gave one) plus the
        // payment-proof channel button.
        const notifButtons = [];
        if (approve && explorerUrl) notifButtons.push([{ text: '🔗 Transaction Hash', url: explorerUrl }]);
        if (approve) notifButtons.push([{ text: '📢 View Payment Channel', url: `https://t.me/${PAYMENT_CHANNEL.replace('@', '')}` }]);
        const notifExtra = notifButtons.length ? { reply_markup: { inline_keyboard: notifButtons } } : {};
        await tgSend(w.userId, notif, notifExtra);

        // Post approved withdrawals to the public proof channel (address masked).
        if (approve) {
            // Proof-of-payment post (format like the Hoocooh pay-logs channel). The wallet address is shown in full;
            // set PROOF_MASK_ADDRESS=1 in Vercel to hide the middle of it.
            const maskAddr = (addr) => (process.env.PROOF_MASK_ADDRESS === '1' && addr && addr.length > 8) ? `${addr.slice(0, 4)}••••${addr.slice(-4)}` : addr;
            const botHandle = 'NewTube12_bot';
            const proofText =
                `🎉 <b>New payout paid</b> 🎉\n\n` +
                `👤 User: ${w.username ? '@' + escHtml(w.username) : 'Anonymous'}\n` +
                `🪙 Amount: <b>${(w.wtcAmount || 0).toLocaleString('en-US')} WTC</b> (${Number(w.cashAmount || 0).toFixed(4)} ${w.currency})\n` +
                `💳 Wallet address:\n<code>${escHtml(maskAddr(w.details))}</code>\n` +
                `🔗 Transaction id: ${explorerUrl ? `<a href="${escHtml(explorerUrl)}">View Transaction</a>` : '—'}\n\n` +
                `BOT ---> <a href="https://t.me/${botHandle}">@${botHandle}</a>`;
            const proofExtra = explorerUrl ? { reply_markup: { inline_keyboard: [[{ text: '🔗 Transaction Hash', url: explorerUrl }]] } } : {};
            await tgSendPhoto(PAYMENT_CHANNEL, PAYMENT_PROOF_PHOTO, proofText, proofExtra).catch((e) => {
                // Doesn't block the approval flow if the bot isn't an admin of
                // the channel yet, or the channel handle is wrong — but the
                // admin should know the post silently failed.
                tgSend(ADMIN_ID, `⚠️ Couldn't post approved withdrawal <code>${wid}</code> to ${PAYMENT_CHANNEL}. Make sure the bot is an admin there.\n\n${e?.message || e}`).catch(() => {});
            });
        }

        // Edit the original admin message: drop the buttons, show the final status
        // (and the tx hash if one was attached).
        const u = await users.findOne({ _id: w.userId }, { projection: { referralCount: 1, withdrawalCount: 1 } });
        const processedText =
            `💸 <b>Withdrawal Request</b>\n\n` +
            `👤 <code>${w.userId}</code> (@${escHtml(w.username || '?')})\n` +
            (w.wtcAmount ? `🪙 WTC: <b>${w.wtcAmount.toLocaleString()}</b>\n` : '') +
            `💰 Amount: <b>${w.cashAmount.toFixed(4)} ${w.currency}</b>\n` +
            `📤 Method: <b>${w.method}</b>\n` +
            `📍 Address: <code>${escHtml(w.details)}</code>\n` +
            `📊 Total withdrawals so far: <b>${u?.withdrawalCount ?? '?'}</b>\n` +
            `👥 Total referrals: <b>${u?.referralCount || 0}</b>\n` +
            `📅 ${fmtBDDateTime(w.createdAt)}\n\n` +
            (txHash ? `🔗 TX: <code>${escHtml(txHash)}</code>\n\n` : '') +
            (approve ? `✅ <b>APPROVED</b> — ${fmtBDDateTime()}` : `❌ <b>REJECTED (refunded)</b> — ${fmtBDDateTime()}`);
        // Omitting reply_markup would leave the old buttons in place, so send an empty keyboard.
        await tgEdit(chatId, msgId, processedText, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
        return true;
    }

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

        // ── Change Wallet Address ──
        // A ONE-TIME, per-user (lifetime) allowance (user.walletChangeUsed) to set a new
        // permanent wallet (see WALLET_CHANGE_PENALTY_PERCENT, lib/constants.js). It closes
        // THIS withdrawal as a refund minus the penalty, and the new address becomes the
        // locked wallet for every future withdrawal. Not admin-gated: the withdrawing user
        // presses it, so the withdrawal owner is checked against fromId instead.
        if (data.startsWith('wd_fixaddr_')) {
            const wid = data.replace('wd_fixaddr_', '');
            const w = await withdrawals.findOne({ _id: new ObjectId(wid) });
            if (!w || w.status !== 'pending') {
                await tgAnswerCallback(cb.id, 'Already processed', true);
                return res.status(200).json({ ok: true });
            }
            if (fromId !== String(w.userId)) {
                await tgAnswerCallback(cb.id, '⛔ Not your withdrawal', true);
                return res.status(200).json({ ok: true });
            }
            const u = await users.findOne({ _id: fromId }, { projection: { walletChangeUsed: 1 } });
            if (u?.walletChangeUsed) {
                // Shouldn't normally be reachable (button isn't shown once
                // used), but guard anyway in case of a stale/replayed button.
                await tgAnswerCallback(cb.id, "You've already used your one-time wallet change.", true);
                return res.status(200).json({ ok: true });
            }
            // lib/adminState.js is keyed by any Telegram ID (the name is historical, it is
            // not admin-only); it remembers "this user is about to paste a corrected address".
            await setAdminState(fromId, { step: 'wd_new_address', wid });
            await tgSend(chatId,
                `✏️ Please reply with your correct <b>${w.method === 'binance' ? 'Binance UID' : 'Tonkeeper Address'}</b> now.\n\n` +
                `This is your <b>one-time</b> wallet change — it becomes your permanent wallet for every future withdrawal. ` +
                `This current withdrawal will be closed with a <b>${WALLET_CHANGE_PENALTY_PERCENT}% penalty</b> and the rest refunded to your balance.`
            );
            await tgAnswerCallback(cb.id, 'Send your corrected address as your next message', false);
            return res.status(200).json({ ok: true });
        }

        // ── User confirms the "Wrong Address" penalty (50%) ──
        // Not admin-gated; the withdrawal's owner is verified against fromId.
        if (data.startsWith('wd_addrconfirm_')) {
            const wid = data.replace('wd_addrconfirm_', '');
            const w = await withdrawals.findOne({ _id: new ObjectId(wid) });
            if (!w || w.status !== 'pending') {
                await tgAnswerCallback(cb.id, 'Already processed', true);
                return res.status(200).json({ ok: true });
            }
            if (fromId !== String(w.userId)) {
                await tgAnswerCallback(cb.id, '⛔ Not your withdrawal', true);
                return res.status(200).json({ ok: true });
            }

            // Atomic claim. Two quick taps on this button used to refund twice.
            const claimedAddr = await withdrawals.findOneAndUpdate({ _id: w._id, status: 'pending' }, { $set: { status: 'processing' } });
            if (!claimedAddr) {
                await tgAnswerCallback(cb.id, 'Already processed', true);
                return res.status(200).json({ ok: true });
            }

            const wtcAmount = w.wtcAmount || 0;
            const penalty = Math.floor(wtcAmount / 2);
            const refund = wtcAmount - penalty;

            // Same as a normal reject (see finalizeWithdrawal), but only half the WTC
            // goes back. withdrawalCount is NOT decremented here either.
            const refundUpdate = { $inc: { wtcBalance: refund }, $set: { withdrawPending: false } };
            if (w.referralConsumed) refundUpdate.$inc.usedValidReferrals = -w.referralConsumed;
            await users.updateOne({ _id: w.userId }, refundUpdate);
            await withdrawals.updateOne(
                { _id: new ObjectId(wid) },
                { $set: { status: 'rejected', processedAt: new Date(), wrongAddressPenalty: penalty } }
            );

            await tgEdit(chatId, msgId,
                `✅ <b>Confirmed.</b>\n\n` +
                `🪙 Refunded to your balance: <b>${refund.toLocaleString()} WTC</b>\n` +
                `⚠️ Penalty kept: <b>${penalty.toLocaleString()} WTC</b>\n\n` +
                `Next time, please double-check that you're using a Tonkeeper Address or Binance UID before submitting.`,
                { reply_markup: { inline_keyboard: [] } }
            );

            if (w.adminMsgChatId && w.adminMsgId) {
                tgEdit(
                    w.adminMsgChatId, w.adminMsgId,
                    `⚠️ <b>Wrong Address — Penalty Applied</b>\n\n` +
                    `👤 <code>${w.userId}</code> confirmed.\n` +
                    `🪙 Refunded: <b>${refund.toLocaleString()} WTC</b> · Penalty: <b>${penalty.toLocaleString()} WTC</b>\n` +
                    `📅 ${fmtBDDateTime()}`,
                    { reply_markup: { inline_keyboard: [] } }
                ).catch(() => {});
            } else if (ADMIN_ID) {
                tgSend(ADMIN_ID, `⚠️ Wrong-address penalty applied for <code>${w.userId}</code> — refunded ${refund.toLocaleString()} WTC, kept ${penalty.toLocaleString()} WTC.`).catch(() => {});
            }

            return res.status(200).json({ ok: true });
        }

        // Everything below is staff-only (admin, or the task moderator for task actions)
        if (!isStaff(fromId)) return res.status(200).json({ ok: true });
        // task moderator only gets through for whitelisted task
        // callback_data (see isTaskCallback above). Silently ignored
        // otherwise — no error text, so a moderator poking around doesn't
        // get a roadmap of what exists via error messages.
        if (!isAdmin(fromId) && !isTaskCallback(data)) return res.status(200).json({ ok: true });

        // ── Withdrawal Approve / Reject ──
        if (data.startsWith('wd_approve_') || data.startsWith('wd_reject_')) {
            const approve = data.startsWith('wd_approve_');
            const wid = data.replace('wd_approve_', '').replace('wd_reject_', '');
            const w = await withdrawals.findOne({ _id: new ObjectId(wid) });
            if (!w || w.status !== 'pending') {
                await tgAnswerCallback(cb.id, 'Already processed', true);
                return res.status(200).json({ ok: true });
            }

            // 15 Oct 2026 — Tonkeeper withdrawals are paid AUTOMATICALLY (USDT-on-TON from the payout wallet whose
            // recovery phrase is in Vercel, see lib/tonPayout.js). Binance withdrawals stay manual (hash step below).
            if (approve && w.method === 'tonkeeper' && process.env.TON_PAYOUT_ENABLED === '1' && process.env.TON_PAYOUT_MNEMONIC) {
                await tgAnswerCallback(cb.id, '💸 Sending payment...', false);
                await autoPayAndApprove({ w, chatId, msgId });
                return res.status(200).json({ ok: true });
            }

            // Approve first asks the admin for an optional transaction hash/explorer
            // link, then finalizes on that reply or on "Skip". Reject is instant.
            if (approve) {
                await tgAnswerCallback(cb.id, 'Approving...', false);
                await setAdminState(fromId, { step: 'wd_txhash', wid, chatId, msgId });
                await tgEdit(chatId, msgId, `💸 Approving withdrawal for <code>${w.userId}</code>.\n\nPaste the <b>transaction hash</b> (or full explorer link) to attach it — or skip:`, {
                    reply_markup: { inline_keyboard: [[{ text: '⏭ Skip (no hash)', callback_data: `wd_skiphash_${wid}` }]] },
                });
                return res.status(200).json({ ok: true });
            }

            const done = await finalizeWithdrawal({ w, approve, txHash: null, chatId, msgId });
            await tgAnswerCallback(cb.id, done ? '❌ Rejected' : 'Already processed', true);
            return res.status(200).json({ ok: true });
        }

        // ── Ban & Wipe (Scam) ──
        // For scripted withdraw spam. Unlike Reject, the withdrawal amount is NOT
        // refunded, the remaining wtcBalance is wiped to 0, and the account is banned
        // (isBanned + the permanent registry via markBanned, see lib/banRegistry.js).
        if (data.startsWith('wd_banscam_')) {
            const wid = data.replace('wd_banscam_', '');
            const w = await withdrawals.findOne({ _id: new ObjectId(wid) });
            if (!w || w.status !== 'pending') {
                await tgAnswerCallback(cb.id, 'Already processed', true);
                return res.status(200).json({ ok: true });
            }
            // Atomic claim: a second tap must not run the ban/wipe twice.
            const claimedScam = await withdrawals.findOneAndUpdate({ _id: w._id, status: 'pending' }, { $set: { status: 'processing' } });
            if (!claimedScam) {
                await tgAnswerCallback(cb.id, 'Already processed', true);
                return res.status(200).json({ ok: true });
            }

            const wiped = (await users.findOne({ _id: w.userId }, { projection: { wtcBalance: 1 } }))?.wtcBalance || 0;

            // No refund of w.wtcAmount — it stays gone. Release the withdrawPending
            // lock and zero the balance in one update.
            await users.updateOne(
                { _id: w.userId },
                { $set: { isBanned: true, bannedAt: new Date(), wtcBalance: 0, withdrawPending: false, appealBlocked: true } } // 17 Oct 2026: scam ban = no appeals
            );
            await markBanned(db, [w.userId]);

            await withdrawals.updateOne(
                { _id: new ObjectId(wid) },
                { $set: { status: 'rejected', processedAt: new Date(), banReason: 'scam_pattern' } }
            );

            await tgEdit(chatId, msgId,
                `🚫 <b>Withdrawal Request</b>\n\n` +
                `👤 <code>${w.userId}</code> (@${escHtml(w.username || '?')})\n` +
                (w.wtcAmount ? `🪙 WTC: <b>${w.wtcAmount.toLocaleString()}</b>\n` : '') +
                `💰 Amount: <b>${w.cashAmount.toFixed(4)} ${w.currency}</b>\n\n` +
                `⛔ <b>BANNED — flagged as scam</b>\n` +
                `💸 Balance wiped: <b>${wiped.toLocaleString()} WTC → 0</b>\n` +
                `📅 ${fmtBDDateTime()}`,
                { reply_markup: { inline_keyboard: [] } }
            ).catch(() => {});
            await tgAnswerCallback(cb.id, '🚫 Banned & balance wiped', true);

            // Let the user know their account was suspended — no dollar figures,
            // nothing that tips off exactly which detection pattern triggered it.
            tgSend(w.userId, `⛔ <b>Account Suspended</b>\n\nYour account has been suspended for suspicious withdrawal activity, and your withdrawal request was denied.`).catch(() => {});

            return res.status(200).json({ ok: true });
        }

        // ── Wrong Address ──
        // Warns the USER (not an instant reject) that their address looks invalid.
        // Nothing changes until THEY act: either the one-time wallet change
        // (wd_fixaddr_, small penalty) or confirming (wd_addrconfirm_, 50% penalty,
        // the rest refunded). Both are user-side buttons, so they are not admin-gated.
        if (data.startsWith('wd_wrongaddr_')) {
            const wid = data.replace('wd_wrongaddr_', '');
            const w = await withdrawals.findOne({ _id: new ObjectId(wid) });
            if (!w || w.status !== 'pending') {
                await tgAnswerCallback(cb.id, 'Already processed', true);
                return res.status(200).json({ ok: true });
            }
            // "Change Wallet Address" is offered only while the user's lifetime one-time
            // change is unused (user.walletChangeUsed); after that only the 50% confirm remains.
            const wUser = await users.findOne({ _id: w.userId }, { projection: { walletChangeUsed: 1 } });
            const canChangeWallet = !wUser?.walletChangeUsed;
            const fixButtons = canChangeWallet
                ? [[{ text: '🔄 Change Wallet Address', callback_data: `wd_fixaddr_${wid}` }]]
                : [];
            await tgSend(
                w.userId,
                `⚠️ <b>Withdrawal Address Issue</b>\n\n` +
                `Your withdrawal address doesn't look right for the method you chose. NEWTUBE only accepts:\n` +
                `• <b>Tonkeeper Address</b>\n` +
                `• <b>Binance UID</b>\n\n` +
                `No other wallet address is supported — sending to any other address type can never be recovered.\n\n` +
                `📍 You entered: <code>${escHtml(w.details)}</code>\n` +
                `🪙 Amount: <b>${(w.wtcAmount || 0).toLocaleString()} WTC</b>\n\n` +
                (canChangeWallet
                    ? `You can set a new permanent wallet below (one-time, ${WALLET_CHANGE_PENALTY_PERCENT}% penalty on this withdrawal — the rest refunds to your balance), or confirm to close this request now with a 50% penalty instead.`
                    : `You've already used your one-time wallet change, so this can only be closed with a 50% penalty now — please double-check your address next time.`),
                { reply_markup: { inline_keyboard: [
                    ...fixButtons,
                    [{ text: '✅ I Understand — Confirm (50% penalty)', callback_data: `wd_addrconfirm_${wid}` }],
                ] } }
            ).catch(() => {});
            await tgEdit(chatId, msgId, `⚠️ Wrong-address warning sent to <code>${w.userId}</code> — awaiting their response. No balance changed yet.\n\nUntil they answer, this request stays pending; find it again under Pending Withdrawals.`, { reply_markup: { inline_keyboard: [] } });
            await tgAnswerCallback(cb.id, 'Warning sent to user', false);
            return res.status(200).json({ ok: true });
        }

        // Admin pressed "Skip" instead of pasting a transaction hash.
        if (data.startsWith('wd_skiphash_')) {
            const wid = data.replace('wd_skiphash_', '');
            const w = await withdrawals.findOne({ _id: new ObjectId(wid) });
            if (!w || w.status !== 'pending') {
                await tgAnswerCallback(cb.id, 'Already processed', true);
                return res.status(200).json({ ok: true });
            }
            await clearAdminState(fromId);
            const done = await finalizeWithdrawal({ w, approve: true, txHash: null, chatId, msgId });
            await tgAnswerCallback(cb.id, done ? '✅ Approved' : 'Already processed', true);
            return res.status(200).json({ ok: true });
        }

        // ── ☠️ Ban User + All Referrals — NEW ──
        // Step 1 (banall_): show what WILL happen, nothing is changed yet.
        // Step 2 (banallgo_): actually bans the referrer + every account with
        // referredBy = referrer, and writes all of them to the permanent
        // bannedTelegramIds registry (so they can't re-create accounts).
        // Only direct referrals (1 level) are banned.
        if (data.startsWith('banall_')) {
            const target = data.slice('banall_'.length);
            const total = await users.countDocuments({ referredBy: target });
            const alreadyBanned = await users.countDocuments({ referredBy: target, isBanned: true });
            const toBan = total - alreadyBanned;
            const withActivity = await users.countDocuments({ referredBy: target, isBanned: { $ne: true }, lifetimeAdsWatched: { $gt: 0 } });
            const tInfo = await users.findOne({ _id: target }, { projection: { telegramUsername: 1, firstName: 1, isBanned: 1 } });
            await tgEdit(chatId, msgId,
                `☠️ <b>Ban User + All Referrals</b>\n\n` +
                `Referrer: <code>${target}</code> (@${tInfo?.telegramUsername || 'n/a'})${tInfo?.isBanned ? ' — already banned' : ''}\n` +
                `👥 Total referrals: <b>${total}</b>\n` +
                `🔒 Already banned: <b>${alreadyBanned}</b>\n` +
                `⛔ Will be banned now: <b>${toBan}</b> (${withActivity} of them have watched ads)\n\n` +
                `⚠️ Referrer + all ${toBan} referral accounts will be banned permanently. Make sure you have proof — real users referred by this person will be banned too.`,
                { reply_markup: { inline_keyboard: [
                    [{ text: `✅ Yes, ban referrer + ${toBan} referrals`, callback_data: `banallgo_${target}` }],
                    [{ text: '◀️ Cancel', callback_data: `lookup_${target}` }],
                ] } });
            return res.status(200).json({ ok: true });
        }

        if (data.startsWith('banallgo_')) {
            const target = data.slice('banallgo_'.length);
            const now = new Date();
            const refDocs = await users.find({ referredBy: target, isBanned: { $ne: true } }).project({ _id: 1 }).toArray();
            const refIds = refDocs.map(d => d._id);

            if (refIds.length) {
                await users.updateMany(
                    { _id: { $in: refIds } },
                    { $set: { isBanned: true, bannedAt: now, bannedReason: 'referral_network_ban', bannedViaReferrer: target, appealBlocked: true } }
                );
            }
            await users.updateOne(
                { _id: target },
                { $set: { isBanned: true, bannedAt: now, bannedReason: 'referral_network_ban', appealBlocked: true } }
            );

            // Permanent registry — in chunks so a huge referral list doesn't hit bulkWrite limits.
            const allIds = [target, ...refIds];
            for (let i = 0; i < allIds.length; i += 1000) {
                await markBanned(db, allIds.slice(i, i + 1000));
            }

            // Pending withdrawals of banned accounts are NOT auto-rejected — just flag the count.
            const pendingWd = await withdrawals.countDocuments({ userId: { $in: allIds }, status: 'pending' });

            await tgEdit(chatId, msgId,
                `☠️ <b>Done</b>\n\n` +
                `Referrer <code>${target}</code> banned.\n` +
                `Referrals newly banned: <b>${refIds.length}</b>\n` +
                (pendingWd ? `\n⚠️ <b>${pendingWd}</b> pending withdrawal(s) from these accounts still need a manual Reject / Ban &amp; Wipe.` : ''),
                { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        // ── Ban / Unban ──
        // this used to do `data.replace('ban_','').replace('unban_','')` —
        // but the string "unban_123" has "ban_" hiding inside it (u-n-[ban_]-123),
        // so .replace('ban_','') incorrectly stripped it down to "un123" — meaning the
        // Unban button updated a wrong/non-existent ID and the real user never got
        // unbanned. Now only the exact prefix is stripped.
        if (data.startsWith('ban_') || data.startsWith('unban_')) {
            const isBan = data.startsWith('ban_');
            const target = isBan ? data.slice('ban_'.length) : data.slice('unban_'.length);
            if (isBan) {
                await users.updateOne({ _id: target }, { $set: { isBanned: true, bannedAt: new Date() } });
                await markBanned(db, [target]);
            } else {
                // also clears appealPending (see the appeal_ deep-link
                // handler above) so the user CAN appeal again if banned again later.
                await users.updateOne({ _id: target }, { $set: { isBanned: false }, $unset: { bannedAt: '', appealPending: '', appealSentAt: '', appealCount: '', appealBlocked: '' } }); // 17 Oct 2026: a real unban gives the user a fresh single appeal for any FUTURE ban
                await markUnbanned(db, [target]);
            }
            await tgEdit(chatId, msgId, `${isBan ? '🚫 Banned' : '✅ Unbanned'}: <code>${target}</code>`, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        // ── Lock (manual, from admin review — e.g. after a velocity alert) ── ⚠️ NEW
        if (data.startsWith('lock_')) {
            const target = data.slice('lock_'.length);
            await users.updateOne(
                { _id: target },
                { $set: { accountLocked: true, accountLockedAt: new Date(), accountLockedReason: 'admin_manual' } }
            );
            await tgEdit(chatId, msgId, `🔒 Locked: <code>${target}</code>\n\nWithdrawals and referral rewards are held until you Unlock.`, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        // ── Unlock (referral-velocity auto-lock) ── ⚠️ NEW
        if (data.startsWith('unlock_')) {
            const target = data.slice('unlock_'.length);
            await users.updateOne(
                { _id: target },
                { $set: { accountLocked: false }, $unset: { accountLockedAt: '', accountLockedReason: '', recentReferralSignups: '', recentAdClaims: '', recentVideoClaims: '', botFlaggedAt: '', botSuspectCount: '', botSuspectAt: '', botReviewAt: '', withdrawHoldAlertAt: '' } } // ⚠️ also clears claim history so an unlocked user isn't re-locked by the same old samples
            );
            await tgEdit(chatId, msgId, `🔓 Unlocked: <code>${target}</code>`, { reply_markup: { inline_keyboard: [[{ text: '👤 View User', callback_data: `lookup_${target}` }], [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] } });
            return res.status(200).json({ ok: true });
        }

        // ── Deny an appeal ("🚫 Keep Suspended") ──
        // this button previously used callback_data:'noop_dismiss',
        // which has NO handler anywhere in this file (it's a real, intentional
        // no-op elsewhere — e.g. a purely-informational row label in the video
        // list — but was mistakenly reused here for a button the admin
        // actually expects to DO something). With no matching handler, tapping
        // it just... did nothing: no confirmation, no message update, and
        // critically, the appealing user was never told their appeal was
        // denied — they'd be left waiting indefinitely. This is what looked
        // like "clicking Suspend doesn't suspend" — the account was already
        // suspended (that's WHY they were appealing), so there was nothing
        // left to "do" to their ban status; what was actually missing was the
        // decision being recorded and communicated. Now it does both.
        if (data.startsWith('denyappeal_')) {
            const target = data.replace('denyappeal_', '');
            // clears appealPending too. Without this, a denied
            // appeal would leave the flag stuck `true` forever, permanently
            // blocking that user from ever appealing again (even for a future,
            // unrelated ban) — the opposite of what the gate is for.
            // 17 Oct 2026 — FINAL DECISION: appealBlocked stops every further appeal from this user (ban → appeal → ban loop fix).
            await users.updateOne({ _id: target }, { $set: { appealBlocked: true }, $unset: { appealPending: '', appealSentAt: '' } });
            await tgSend(target, `📪 <b>Review Update</b>\n\nYour review request has been checked, and the suspension stands. If you have more information you'd like to share, you're welcome to contact the admin directly.`).catch(() => {});
            await tgEdit(chatId, msgId, `🚫 Appeal denied — <code>${target}</code> remains suspended.`, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        // ── 18 Oct 2026 — 🆕 Signup Bursts (many accounts created at the same time) — logic in lib/signupBursts.js ──
        if (data === 'a_signups' || data.startsWith('sb_')) {
            const handled = await handleSignupCallback(data, { db, chatId, msgId, send: tgSend, edit: tgEdit, backKb });
            if (handled) return res.status(200).json({ ok: true });
        }

        // ── 17 Oct 2026 — 📦 Lootbox history (last 30 days) for one user ──
        // Kaj: admin dekhte pay user 30 din-e koybar lootbox claim korechhe (10/20/0?), kon shomoy, koto WTC, kon network-er ad-e,
        // ar tap→claim koto second (script hole sob ek-i hoy). Data `lootboxLogs` collection-e (api/earn.js likhe), 30 din por nijei muche jay.
        // Withdraw approve hole ei user-er log muche jay (lib/cycleCleanup.js) — tokhon summary Withdraw History-te thake.
        if (data.startsWith('lootlog_')) {
            const target = data.replace('lootlog_', '');
            const since = new Date(Date.now() - 30 * 86400000);
            const rows = await db.collection('lootboxLogs').find({ userId: target, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(600).toArray();
            const perDay = {};
            for (const r of rows) {
                const d = new Date(new Date(r.createdAt).getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10); // BD day
                perDay[d] = perDay[d] || { n: 0, wtc: 0 };
                perDay[d].n++; perDay[d].wtc += r.amount || 0;
            }
            const dayLines = Object.entries(perDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14).map(([d, v]) => `• ${d}: <b>${v.n}</b> claim · ${v.wtc.toLocaleString()} WTC`);
            const totalWtc = rows.reduce((a, r) => a + (r.amount || 0), 0);
            let out = `📦 <b>Lootbox History — last 30 days</b>\nUser: <code>${target}</code>\n` +
                `Total claims: <b>${rows.length}</b> · ${totalWtc.toLocaleString()} WTC · ${Object.keys(perDay).length} din-e claim koreche\n\n`;
            out += rows.length
                ? `<b>Din-wise (latest 14)</b>\n${dayLines.join('\n')}\n\n<b>Latest claims</b> <i>(time · WTC · network · tap→claim)</i>\n` +
                  rows.slice(0, 20).map(r => `• ${fmtBDDateTime(r.createdAt)} — +${r.amount} · ${r.net || '?'} · ${r.waitSec ? r.waitSec + 's' : '-'}`).join('\n')
                : 'Ei 30 din-e kono lootbox claim nai (ba withdraw approve-er por log muche gese).';
            if (out.length > 3900) out = out.slice(0, 3900) + '…';
            await tgEdit(chatId, msgId, out, { reply_markup: { inline_keyboard: [[{ text: '📊 Cycle Report', callback_data: `trust_${target}` }], [{ text: '◀️ Back to User', callback_data: `lookup_${target}` }]] } });
            return res.status(200).json({ ok: true });
        }

        // ── 17 Oct 2026 — 🔍 Fake/Real report (full) ── lib/trustReport.js diye score + karon-er list.
        if (data.startsWith('trust_')) {
            const target = data.replace('trust_', '');
            const tu = await users.findOne({ _id: target });
            if (!tu) { await tgEdit(chatId, msgId, '❌ User not found.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
            // 18 Oct 2026: the main content is now the CYCLE REPORT (real numbers since the last withdraw); the old score is only a one-line hint.
            const cyc = await buildCycleReport(db, tu);
            const hint = await buildTrustReport(db, tu).then(renderTrustShort).catch(() => '');
            await tgEdit(chatId, msgId, renderCycleFull(tu, cyc, hint), { reply_markup: { inline_keyboard: [
                [{ text: '📦 Lootbox History', callback_data: `lootlog_${target}` }, { text: '💸 Withdraw History', callback_data: `wdhist_${target}` }],
                [{ text: '◀️ Back to User', callback_data: `lookup_${target}` }],
            ] } });
            return res.status(200).json({ ok: true });
        }

        // ── 17 Oct 2026 — 💸 Withdraw history: koybar, kokhon, koto, ki status — ar prottek payout-er shomoy user-er "cycle summary" ──
        // (raw ad/video data withdraw approve hole muche jay, kintu oi shomoyer summary withdrawal doc-e `cycle` hishebe theke jay)
        if (data.startsWith('wdhist_')) {
            const target = data.replace('wdhist_', '');
            const list = await withdrawals.find({ userId: target }).sort({ createdAt: -1 }).limit(15).toArray();
            const all = await withdrawals.find({ userId: target }, { projection: { status: 1, wtcAmount: 1 } }).toArray();
            const cnt = (s) => all.filter(x => x.status === s).length;
            const paidWtc = all.filter(x => x.status === 'approved').reduce((a, x) => a + (x.wtcAmount || 0), 0);
            let out = `💸 <b>Withdraw History</b>\nUser: <code>${target}</code>\n` +
                `Total: <b>${all.length}</b> · ✅ approved <b>${cnt('approved')}</b> (${paidWtc.toLocaleString()} WTC) · ⏳ pending <b>${cnt('pending') + cnt('processing')}</b> · ❌ rejected <b>${cnt('rejected')}</b>\n\n`;
            out += list.length ? list.map((x, i) => {
                const icon = x.status === 'approved' ? '✅' : x.status === 'rejected' ? '❌' : '⏳';
                let line = `${i + 1}) ${icon} <b>${fmtBDDateTime(x.createdAt)}</b> — ${(x.wtcAmount || 0).toLocaleString()} WTC ($${(x.cashAmount || 0).toFixed(4)}) · ${x.status}`;
                if (x.processedAt && x.status !== 'pending') line += `\n     paid/decided: ${fmtBDDateTime(x.processedAt)}`;
                if (x.cycle?.cy) line += `\n     ${renderCycleSnapshotLine(x.cycle)}`;
                else if (x.cycle) line += `\n     📋 oi shomoy: lootbox ${x.cycle.lootboxClaims} claim · task ${x.cycle.tasks} · ref ${x.cycle.referrals} · ${x.cycle.trustVerdict} (score ${x.cycle.trustScore})`;
                return line;
            }).join('\n') : 'Kono withdraw nai.';
            if (out.length > 3900) out = out.slice(0, 3900) + '…';
            await tgEdit(chatId, msgId, out, { reply_markup: { inline_keyboard: [[{ text: '◀️ Back to User', callback_data: `lookup_${target}` }]] } });
            return res.status(200).json({ ok: true });
        }

        // ── Full user detail + moderation panel (tap-through from search/top-referrer/refs-list) ──
        if (data.startsWith('lookup_')) {
            const target = data.replace('lookup_', '');
            const u = await users.findOne({ _id: target });
            if (!u) { await tgEdit(chatId, msgId, '❌ User not found.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
            const wList = await withdrawals.find({ userId: target }).toArray();
            const [uText, uOptions] = renderUserLookup(u, wList, await buildCycleReport(db, u).catch(() => null));
            await tgEdit(chatId, msgId, uText, uOptions);
            return res.status(200).json({ ok: true });
        }

        // ── Confiscate balance — zeroes out spendable WTC (the actual punishment for fraud:
        // it doesn't matter how many fake refs they racked up if there's nothing left to withdraw) ──
        if (data.startsWith('zerobal_')) {
            const target = data.replace('zerobal_', '');
            const u = await users.findOne({ _id: target });
            if (!u) { await tgEdit(chatId, msgId, '❌ User not found.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
            const seized = u.wtcBalance || 0;
            await users.updateOne({ _id: target }, { $set: { wtcBalance: 0 } });
            await tgEdit(chatId, msgId, `💸 Confiscated <b>${seized.toLocaleString()} WTC</b> from <code>${target}</code> — balance is now 0.`, { reply_markup: { inline_keyboard: [[{ text: '👤 View User', callback_data: `lookup_${target}` }], [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] } });
            return res.status(200).json({ ok: true });
        }

        // ── Reset referral stats — strips fraudulent referral counts (fake-account farms) ──
        if (data.startsWith('resetrefs_')) {
            const target = data.replace('resetrefs_', '');
            await users.updateOne({ _id: target }, { $set: { referralCount: 0, totalInvites: 0 } });
            await tgEdit(chatId, msgId, `🔄 Referral stats reset for <code>${target}</code> (count → 0).`, { reply_markup: { inline_keyboard: [[{ text: '👤 View User', callback_data: `lookup_${target}` }], [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] } });
            return res.status(200).json({ ok: true });
        }

        // ── Clear multi-account flag — ⚠️ NEW. Only actually needed once
        // MULTI_ACCOUNT_SIBLING_HARD_LIMIT (api/earn.js) blocks a flagged
        // account past the "few siblings, probably a shared device" leeway.
        // Doesn't touch multiAccountSiblings/multiAccountFingerprint (kept
        // for the audit trail — visible on the user panel) — only the flag
        // itself, so earning unblocks immediately regardless of sibling
        // count. If ANOTHER new account signs up on this same device later,
        // fingerprintCheck.js re-flags fresh from that signup — this clear
        // doesn't disable detection going forward, it's a one-time review
        // decision on this account only.
        if (data.startsWith('clearmaf_')) {
            const target = data.replace('clearmaf_', '');
            await users.updateOne(
                { _id: target },
                { $set: { multiAccountFlag: false, multiAccountClearedAt: new Date(), multiAccountClearedBy: fromId } }
            );
            await tgEdit(chatId, msgId, `🧹 Multi-account flag cleared for <code>${target}</code> — they can earn normally again.`, { reply_markup: { inline_keyboard: [[{ text: '👤 View User', callback_data: `lookup_${target}` }], [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] } });
            return res.status(200).json({ ok: true });
        }

        // ── Quick "Send WTC" shortcut from the user detail panel — target already known,
        // so it skips straight to asking for the amount. ──
        if (data.startsWith('quickwtc_')) {
            const target = data.replace('quickwtc_', '');
            await setAdminState(fromId, { step: 'sendwtc_amount', targetId: target });
            await tgEdit(chatId, msgId, `💰 How much <b>WTC</b> do you want to send to <code>${target}</code>? (negative number to deduct)`, { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        // ── Task category choice (part of the Add Task flow) ──
        // ⚠️ UPDATED — Daily Task category removed (no longer selectable from
        // Add Task — see task_title step below). Categories: Exclusive /
        // Partner / Earning / Channel-Group-Join.
        // Every category can ALSO be an API-verified (Telegram channel/group
        // join) task, not just the dedicated "Channel/Group Join" category.
        // See task_verify_api / task_verify_link below.
        if (data === 'task_cat_channel' || data === 'task_cat_exclusive' || data === 'task_cat_partner' || data === 'task_cat_earning') {
            const s = await getAdminState(fromId);
            if (!s || s.step !== 'task_category') return res.status(200).json({ ok: true });
            if (data === 'task_cat_channel') {
                // The dedicated Channel/Group Join category is ALWAYS API-verified — no extra prompt needed.
                s.category = 'channel';
                s.verifyType = 'api';
                s.step = 'task_channelid';
                await setAdminState(fromId, s);
                await tgEdit(chatId, msgId, `📋 Title: ✅ <b>${s.title}</b>\n\nNow send the <b>channel/group @username</b> (join will be verified against this):`, { reply_markup: cancelKb });
            } else {
                s.category = data.replace('task_cat_', '');
                s.step = 'task_verify_type';
                await setAdminState(fromId, s);
                await tgEdit(chatId, msgId,
                    `📋 Title: ✅ <b>${s.title}</b>\n\nHow should this <b>${s.category}</b> task be verified?\n\n` +
                    `✅ <b>API (Telegram Join)</b> — user must actually join a channel/group; checked for real via Telegram, can't be faked.\n` +
                    `🔗 <b>Non-API (Link)</b> — user opens a link and claims after a short wait; not independently verified.`,
                    { reply_markup: { inline_keyboard: [
                        [{ text: '✅ API — Channel/Group Join', callback_data: 'task_verify_api' }],
                        [{ text: '🔗 Non-API — Link', callback_data: 'task_verify_link' }],
                    ] } }
                );
            }
            return res.status(200).json({ ok: true });
        }

        // ── Verification type choice. Only shown for non-'channel' categories
        // (task_cat_channel skips straight to task_channelid since it's
        // always API-verified). Lets any category (Exclusive/Partner/Earning)
        // also be a Telegram-join-verified task instead of a plain link task.
        if (data === 'task_verify_api' || data === 'task_verify_link') {
            const s = await getAdminState(fromId);
            if (!s || s.step !== 'task_verify_type') return res.status(200).json({ ok: true });
            if (data === 'task_verify_api') {
                s.verifyType = 'api';
                s.step = 'task_channelid';
                await setAdminState(fromId, s);
                await tgEdit(chatId, msgId, `📋 Title: ✅ <b>${s.title}</b>\n\nNow send the <b>channel/group @username</b> (join will be verified against this):`, { reply_markup: cancelKb });
            } else {
                s.verifyType = 'link';
                s.step = 'task_url';
                await setAdminState(fromId, s);
                const prompts = {
                    exclusive: "Now send the exclusive task's <b>link</b>:",
                    partner: "Now send the partner task's <b>link</b>:",
                    earning: "Now send the <b>referral link</b> for this earning task:",
                };
                await tgEdit(chatId, msgId, `📋 Title: ✅ <b>${s.title}</b>\n\n${prompts[s.category]}`, { reply_markup: cancelKb });
            }
            return res.status(200).json({ ok: true });
        }

        // ── The task confirm preview has no Save/Cancel button — it's done by typing CONFIRM as text (see below) ──

        // ── Admin menu ──
        if (data === 'a_menu') {
            await clearAdminState(fromId);
            const title = isAdmin(fromId) ? '👑 <b>NEWTUBE Admin Panel</b>\n\nSelect an option:' : '📋 <b>Task Manager</b>\n\nSelect an option:';
            await tgEdit(chatId, msgId, title, { reply_markup: kbFor(fromId) });
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_stats') {
            const total = await users.countDocuments();
            const todayStart = todayStartBD(); // ⚠️ FIXED — was server-local (UTC) midnight, now matches the real BD-midnight daily reset
            const newToday = await users.countDocuments({ createdAt: { $gte: todayStart } });
            const pendingW = await withdrawals.countDocuments({ status: 'pending' });
            const taskCnt = await tasks.countDocuments({ isApproved: true });
            const videoCnt = await videos.countDocuments({ isActive: true });
            const wtcAgg = await users.aggregate([{ $group: { _id: null, t: { $sum: '$wtcBalance' } } }]).toArray();
            // 🔍 NEW — diagnostics for "9K+ users but almost nobody active" complaints.
            // uniqueDevices tells you how many DISTINCT physical phones ever opened
            // the app at all (db.ipRegistry = one row per claimed device/IP key, see
            // lib/ipRegistry.js). If this is far below Total Users, most accounts are
            // duplicate/alt accounts piled onto a handful of real phones — every one
            // of them beyond the first per device gets hard-blocked by the one-
            // account-per-device gate (silently, on every app open), so they never
            // see an ad or earn a single WTC. flaggedMulti / activeToday fill in the
            // rest of the picture: how many accounts are merely soft-flagged for
            // review (still usable) vs how many people actually opened the app today.
            const uniqueDevices = await db.collection('ipRegistry').countDocuments({});
            const flaggedMulti = await users.countDocuments({ multiAccountFlag: true });
            const activeToday = await users.countDocuments({ lastActiveAt: { $gte: todayStart } }).catch(() => null);
            // 12 Oct 2026 — (1) USDT withdrawn per day, (2) why accounts are banned / locked / under review.
            // cashAmount = net USDT after fees (what is actually paid out). "Paid" = approved, grouped by approval time.
            let extraText = '';
            try {
                const DAY_MS = 24 * 3600 * 1000;
                const yStart = new Date(todayStart.getTime() - DAY_MS);
                const wkStart = new Date(todayStart.getTime() - 6 * DAY_MS);
                const usdtSum = async (match) => {
                    const r = await withdrawals.aggregate([
                        { $match: { currency: 'USDT', ...match } },
                        { $group: { _id: null, usd: { $sum: '$cashAmount' }, n: { $sum: 1 } } },
                    ]).toArray();
                    return { usd: r[0]?.usd || 0, n: r[0]?.n || 0 };
                };
                const [paidToday, paidYest, paid7d, reqToday, pendNow] = await Promise.all([
                    usdtSum({ status: 'approved', processedAt: { $gte: todayStart } }),
                    usdtSum({ status: 'approved', processedAt: { $gte: yStart, $lt: todayStart } }),
                    usdtSum({ status: 'approved', processedAt: { $gte: wkStart } }),
                    usdtSum({ status: { $in: ['pending', 'approved', 'processing'] }, createdAt: { $gte: todayStart } }),
                    usdtSum({ status: 'pending' }),
                ]);
                const fu = (x) => `<b>$${x.usd.toFixed(2)}</b> (${x.n})`;
                extraText +=
                    `\n\n\ud83d\udcb8 <b>USDT withdrawals</b> (amount) (count)\n` +
                    `\u2022 Paid today: ${fu(paidToday)}\n` +
                    `\u2022 Paid yesterday: ${fu(paidYest)}\n` +
                    `\u2022 Paid last 7 days: ${fu(paid7d)}\n` +
                    `\u2022 Requested today: ${fu(reqToday)}\n` +
                    `\u2022 Pending now: ${fu(pendNow)}`;
            } catch (e) { extraText += `\n\n\ud83d\udcb8 USDT stats unavailable`; }
            try {
                const [bannedTotal, bannedBy, lockedBy, underReview] = await Promise.all([
                    users.countDocuments({ isBanned: true }),
                    users.aggregate([{ $match: { isBanned: true } }, { $group: { _id: { $ifNull: ['$bannedReason', 'admin/manual'] }, n: { $sum: 1 } } }]).toArray(),
                    users.aggregate([{ $match: { accountLocked: true } }, { $group: { _id: { $ifNull: ['$accountLockedReason', 'unknown'] }, n: { $sum: 1 } } }]).toArray(),
                    users.countDocuments({ multiAccountFlag: true, $or: [{ channelVerified: { $ne: true } }, { $expr: { $gt: [{ $size: { $ifNull: ['$multiAccountSiblings', []] } }, 2] } }] }),
                ]);
                const lines = (arr) => arr.length ? arr.map(r => `   - ${r._id}: ${r.n}`).join('\n') : '   - none';
                extraText +=
                    `\n\n\ud83d\udeab <b>Suspension breakdown</b>\n` +
                    `\u2022 Banned: <b>${bannedTotal}</b>\n${lines(bannedBy)}\n` +
                    `\u2022 Locked: <b>${lockedBy.reduce((s, r) => s + r.n, 0)}</b>\n${lines(lockedBy)}\n` +
                    `\u2022 Earning blocked (multi-account review): <b>${underReview}</b>\n` +
                    `(banned docs auto-delete 60 days after ban, so older bans are not counted here)`;
            } catch (e) { extraText += `\n\n\ud83d\udeab Suspension stats unavailable`; }
            await tgEdit(chatId, msgId,
                `📊 <b>Dashboard</b>\n\n` +
                `👥 Total Users: <b>${total}</b>\n` +
                `🆕 Today Joined: <b>${newToday}</b>\n` +
                `📋 Active Tasks: <b>${taskCnt}</b>\n` +
                `🎬 Active Videos: <b>${videoCnt}</b>\n` +
                `⏳ Pending Withdrawals: <b>${pendingW}</b>\n` +
                `💰 Total WTC (all users): <b>${(wtcAgg[0]?.t || 0).toLocaleString()}</b>\n\n` +
                `🔍 <b>Device diagnostics</b>\n` +
                `📱 Unique devices ever opened app: <b>${uniqueDevices}</b>\n` +
                `🚩 Accounts flagged multi-account: <b>${flaggedMulti}</b>` +
                (activeToday !== null ? `\n🟢 Opened app today: <b>${activeToday}</b>` : '') + extraText,
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
                    `👤 <code>${w.userId}</code> (@${escHtml(w.username || '?')})\n` +
                    (w.wtcAmount ? `🪙 WTC: <b>${w.wtcAmount.toLocaleString()}</b>\n` : '') +
                    `💰 Amount: <b>${w.cashAmount.toFixed(4)} ${w.currency}</b>\n` +
                    `📤 Method: <b>${w.method}</b>\n` +
                    `📍 Address: <code>${escHtml(w.details)}</code>\n` +
                    `📅 ${fmtBDDateTime(w.createdAt)}`,
                    { reply_markup: { inline_keyboard: [
                        [{ text: '✅ Approve', callback_data: `wd_approve_${w._id}` },
                         { text: '❌ Reject', callback_data: `wd_reject_${w._id}` }],
                        [{ text: '⚠️ Wrong Address', callback_data: `wd_wrongaddr_${w._id}` }],
                        [{ text: '📊 Cycle Report', callback_data: `trust_${w.userId}` }, { text: '💸 History', callback_data: `wdhist_${w.userId}` }],
                        [{ text: '🚫 Ban & Wipe (Scam)', callback_data: `wd_banscam_${w._id}` }],
                    ] } }
                );
            }
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_user') {
            await setAdminState(fromId, { step: 'user_lookup' });
            await tgEdit(chatId, msgId, "👤 Send the user's <b>Telegram numeric ID</b>, or search by <b>name/username</b>:", { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }


        // ── All Users — paginated list, 15 per page, with withdraw/refer counts ──
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
                await tgEdit(chatId, msgId, '📭 No users yet.', { reply_markup: backKb });
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
            let out = '🏆 <b>All-time Top 20 Referrers</b>\n\nTap a name below to see exactly who they referred (spot real vs fake refs):\n\n';
            top.forEach((u, i) => { out += `${i + 1}. @${u.telegramUsername || u.firstName} — <b>${u.referralCount || 0}</b> refs\n`; });
            const rows = top
                .filter(u => (u.referralCount || 0) > 0)
                .map(u => [{ text: `👥 @${u.telegramUsername || u.firstName} (${u.referralCount || 0})`, callback_data: `a_refslist_${u._id}_0` }]);
            rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
            await tgEdit(chatId, msgId, top.length ? out : 'No data yet.', { reply_markup: { inline_keyboard: top.length ? rows : backKb.inline_keyboard } });
            return res.status(200).json({ ok: true });
        }

        // ── 🔍 Referred-users list — who did this specific referrer actually bring in? ──
        // Helps spot fake/multi-account referrals: real users normally end up
        // channelVerified and have watched at least some ads; a batch of accounts
        // that are all unverified and zero-activity is
        // a strong signal of fake referrals worth a spam-alert/screenshot report.
        if (data.startsWith('a_refslist_')) {
            const rest = data.replace('a_refslist_', '');
            const lastUnderscore = rest.lastIndexOf('_');
            const targetId = rest.slice(0, lastUnderscore);
            const page = parseInt(rest.slice(lastUnderscore + 1)) || 0;
            const PER_PAGE = 20;

            const referrer = await users.findOne({ _id: targetId }, { projection: { telegramUsername: 1, firstName: 1, referralCount: 1 } });
            const total = await users.countDocuments({ referredBy: targetId });
            const list = await users.find({ referredBy: targetId })
                .sort({ createdAt: -1 })
                .skip(page * PER_PAGE)
                .limit(PER_PAGE)
                .project({ telegramUsername: 1, firstName: 1, channelVerified: 1, lifetimeAdsWatched: 1, isBanned: 1, createdAt: 1 })
                .toArray();

            if (!list.length) {
                await tgEdit(chatId, msgId, `👥 <b>@${referrer?.telegramUsername || targetId}'s Referrals</b>\n\nNo referred users found.`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'a_toprefer' }]] } });
                return res.status(200).json({ ok: true });
            }

            let out = `👥 <b>@${referrer?.telegramUsername || targetId}'s Referrals</b> (${total} total) — Page ${page + 1}/${Math.ceil(total / PER_PAGE)}\n\n`;
            list.forEach((u, i) => {
                const serial = page * PER_PAGE + i + 1;
                const verified = u.channelVerified ? '✅ joined' : '❌ not joined';
                const banned = u.isBanned ? ' 🔒 banned' : '';
                out += `<b>${serial}.</b> <code>${u._id}</code> (@${u.telegramUsername || 'n/a'})\n` +
                       `   ${verified} | Ads watched: ${u.lifetimeAdsWatched || 0}${banned}\n` +
                       `   📅 ${u.createdAt ? fmtBDDate(u.createdAt) : '?'}\n\n`;
            });

            const navRow = [];
            if (page > 0) navRow.push({ text: '◀️ Prev', callback_data: `a_refslist_${targetId}_${page - 1}` });
            if ((page + 1) * PER_PAGE < total) navRow.push({ text: 'Next ▶️', callback_data: `a_refslist_${targetId}_${page + 1}` });
            const rows = [];
            if (navRow.length) rows.push(navRow);
            rows.push([{ text: '☠️ Ban User + All Referrals', callback_data: `banall_${targetId}` }]);
            rows.push([{ text: '◀️ Back to List', callback_data: 'a_toprefer' }]);
            await tgEdit(chatId, msgId, out, { reply_markup: { inline_keyboard: rows } });
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_weekly') {
            // Live standings from the real-time weeklyReferralCount field.
            // ⚠️ Reward eligibility is a THRESHOLD (>= WEEKLY_REFERRAL_MIN_COUNT
            // referrals this week), not just "top 10 by rank". So the number
            // of 🏆-tagged users below can be anywhere from 0 to
            // WEEKLY_REFERRAL_MAX_WINNERS (10) depending on how many people
            // actually crossed the threshold this week — someone ranked #3
            // with only 6 refs is NOT eligible even though they're in the
            // visible top 20.
            const weekly = await users.find({ weeklyReferralCount: { $gt: 0 } })
                .sort({ weeklyReferralCount: -1 })
                .limit(20)
                .project({ firstName: 1, telegramUsername: 1, weeklyReferralCount: 1 })
                .toArray();
            const eligibleCount = weekly.filter(u => u.weeklyReferralCount >= WEEKLY_REFERRAL_MIN_COUNT).length;
            const winnerCount = Math.min(eligibleCount, WEEKLY_REFERRAL_MAX_WINNERS);
            let out = `📅 <b>Weekly Top 20 Referrers</b>\n<i>Reward-eligible (🏆) = ${WEEKLY_REFERRAL_MIN_COUNT}+ refs this week, top ${WEEKLY_REFERRAL_MAX_WINNERS} of those. Currently ${winnerCount} qualifying.</i>\n\n`;
            if (!weekly.length) {
                out += 'No referrals yet this week.';
            } else {
                weekly.forEach((u, i) => {
                    const eligible = i < WEEKLY_REFERRAL_MAX_WINNERS && u.weeklyReferralCount >= WEEKLY_REFERRAL_MIN_COUNT;
                    out += `${eligible ? '🏆' : '  '} ${i + 1}. @${u.telegramUsername || u.firstName || u._id} — <b>${u.weeklyReferralCount}</b> refs\n`;
                });
            }
            await tgEdit(chatId, msgId, out, { reply_markup: { inline_keyboard: [
                [{ text: '🔄 Reset week now', callback_data: 'a_weekly_reset' }],
                [{ text: '📜 Previous Reports', callback_data: 'a_weekly_history' }],
                [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }],
            ] } });
            return res.status(200).json({ ok: true });
        }

        // manual trigger for the weekly reset: snapshots this week's
        // winners into the `weeklyReferralReports` collection (so
        // a_weekly_history can show it later), THEN zeroes weeklyReferralCount
        // for every user. Use this AFTER you've manually sent this week's
        // rewards — resetting first would wipe the standings before you've
        // paid anyone, though the saved report means the record isn't lost
        // even if you reset early. A confirm step guards against an
        // accidental tap, since the counter-reset itself can't be undone.
        if (data === 'a_weekly_reset') {
            await tgEdit(chatId, msgId, '⚠️ <b>Reset this week\'s referral standings?</b>\n\nMake sure you\'ve already sent this week\'s rewards — a report will be saved, but the live counters cannot be un-reset.', { reply_markup: { inline_keyboard: [
                [{ text: '✅ Yes, reset now', callback_data: 'a_weekly_reset_confirm' }],
                [{ text: '❌ Cancel', callback_data: 'a_weekly' }],
            ] } });
            return res.status(200).json({ ok: true });
        }
        if (data === 'a_weekly_reset_confirm') {
            const weekly = await users.find({ weeklyReferralCount: { $gt: 0 } })
                .sort({ weeklyReferralCount: -1 })
                .limit(20)
                .project({ firstName: 1, telegramUsername: 1, weeklyReferralCount: 1 })
                .toArray();
            // ── only users meeting the minimum, capped at the max winner count ──
            const winners = weekly
                .filter(u => u.weeklyReferralCount >= WEEKLY_REFERRAL_MIN_COUNT)
                .slice(0, WEEKLY_REFERRAL_MAX_WINNERS)
                .map(u => ({ userId: u._id, firstName: u.firstName || null, telegramUsername: u.telegramUsername || null, weeklyReferralCount: u.weeklyReferralCount }));

            // ── save the snapshot BEFORE resetting, so this week's result is never lost ──
            await db.collection('weeklyReferralReports').insertOne({
                weekEndedAt: new Date(),
                winners,
                totalParticipants: weekly.length,
            });

            const result = await users.updateMany({ weeklyReferralCount: { $ne: 0 } }, { $set: { weeklyReferralCount: 0 } });
            await tgEdit(chatId, msgId,
                `✅ <b>Week reset & report saved.</b>\n\n` +
                `🏆 Winners this week: <b>${winners.length}</b>${winners.length < WEEKLY_REFERRAL_MAX_WINNERS ? ` (fewer than ${WEEKLY_REFERRAL_MAX_WINNERS} — not everyone hit ${WEEKLY_REFERRAL_MIN_COUNT}+ refs)` : ''}\n` +
                `🔄 ${result.modifiedCount} user(s)' counters zeroed — the new week starts fresh.\n\n` +
                `View the saved list anytime via 📜 Weekly Report.`,
                { reply_markup: backKb }
            );
            return res.status(200).json({ ok: true });
        }

        // shows the most recently saved weekly report (who actually
        // got rewarded last time, exactly as many names as qualified — could
        // be fewer than 10, or even zero if nobody hit the threshold that week).
        if (data === 'a_weekly_history') {
            const report = await db.collection('weeklyReferralReports').find().sort({ weekEndedAt: -1 }).limit(1).toArray();
            if (!report.length) {
                await tgEdit(chatId, msgId, '📜 <b>Previous Weekly Report</b>\n\nNo report saved yet — use "🔄 Reset week now" inside Weekly Refer once a week is done to create the first one.', { reply_markup: backKb });
                return res.status(200).json({ ok: true });
            }
            const r = report[0];
            const dateStr = new Date(r.weekEndedAt).toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka', month: 'short', day: 'numeric', year: 'numeric' });
            let out = `📜 <b>Weekly Report — ended ${dateStr}</b>\n\n`;
            if (!r.winners.length) {
                out += `No winners that week — nobody reached ${WEEKLY_REFERRAL_MIN_COUNT}+ referrals.`;
            } else {
                out += `🏆 <b>${r.winners.length} winner(s)</b> (needed ${WEEKLY_REFERRAL_MIN_COUNT}+ refs):\n\n`;
                r.winners.forEach((w, i) => {
                    out += `${i + 1}. @${w.telegramUsername || w.firstName || w.userId} (<code>${w.userId}</code>) — <b>${w.weeklyReferralCount}</b> refs\n`;
                });
            }
            await tgEdit(chatId, msgId, out, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_addtask') {
            await setAdminState(fromId, { step: 'task_title' });
            await tgEdit(chatId, msgId, `📋 <b>Add Task — Step 1/5</b>\n\nSend the task's <b>title</b>:`, { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        // ⚠️ Article/Faucet task types removed (this update) — the shortcut
        // handlers that used to live here (a_addarticle / a_addfaucet) are
        // gone. Use "📋 Add Task" → pick a category instead.

        if (data === 'a_addvideo') {
            await setAdminState(fromId, { step: 'video_id' });
            await tgEdit(chatId, msgId, `🎬 <b>Add Video — Step 1/2</b>\n\nSend the YouTube video's <b>link</b> or the raw <b>video ID</b>:`, { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        // ── 🗑 Manage Videos — view list + a Remove button next to each ──
        if (data.startsWith('a_managevideos_')) {
            const page = parseInt(data.replace('a_managevideos_', '')) || 0;
            const perPage = 8;
            const all = await videos.find({}).sort({ createdAt: -1 }).skip(page * perPage).limit(perPage).toArray();
            const totalCount = await videos.countDocuments({});
            if (!all.length) {
                await tgEdit(chatId, msgId, page === 0 ? '📭 No videos yet.' : '📭 No more videos.', { reply_markup: backKb });
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
            // Refresh the list — showing it back on the same page
            const perPage = 8;
            const all = await videos.find({}).sort({ createdAt: -1 }).limit(perPage).toArray();
            const totalCount = await videos.countDocuments({});
            const rows = all.map(v => ([{ text: `${v.isActive ? '🟢' : '⚪'} ${(v.title || v.videoId).slice(0, 28)}`, callback_data: `noop_dismiss` }, { text: '🗑 Remove', callback_data: `delvideo_${v._id}` }]));
            rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
            await tgEdit(chatId, msgId, `🎬 <b>Manage Videos</b> (${totalCount} total)\n\n🟢 = active, ⚪ = inactive`, { reply_markup: { inline_keyboard: rows } });
            return res.status(200).json({ ok: true });
        }

        // ⚠️ "Manage Articles"/"Manage Faucets" (a_managecat_) removed (this
        // update) — those categories are gone. Any old article/faucet tasks
        // still sitting in the DB from before this update can be cleaned up
        // via "🗑 Manage Tasks" → "📋 All".

        // ── 🗑 Manage Tasks — category picker (Exclusive/Partner/Earn/Verify/All) ──
        if (data === 'a_managetasks_menu') {
            const rows = TASK_MANAGE_CATEGORIES.map(c => ([{ text: c.label, callback_data: `a_taskcat_${c.id}_0` }]));
            rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
            await tgEdit(chatId, msgId, '📋 <b>Manage Tasks</b>\n\nPick a category to view/remove tasks:', { reply_markup: { inline_keyboard: rows } });
            return res.status(200).json({ ok: true });
        }

        // ── 🕐 Pending Review — user-created (paid) tasks awaiting approval ──
        if (data === 'a_pendingreview') {
            const [text_, kb] = await renderPendingReviewList(tasks);
            await tgEdit(chatId, msgId, text_, { reply_markup: kb });
            return res.status(200).json({ ok: true });
        }

        if (data.startsWith('taskrev_approve_') || data.startsWith('taskrev_reject_')) {
            const approving = data.startsWith('taskrev_approve_');
            const tid = data.replace(approving ? 'taskrev_approve_' : 'taskrev_reject_', '');
            let target = null;
            try {
                // ⚠️ ATOMIC — gated on reviewStatus:'pending_review' so a
                // double-tap (or admin + moderator both tapping the same
                // task) can never approve-then-reject or fire the buyer
                // notification twice.
                target = await tasks.findOneAndUpdate(
                    { _id: new ObjectId(tid), reviewStatus: 'pending_review' },
                    { $set: { isApproved: approving, reviewStatus: approving ? 'approved' : 'rejected', reviewedAt: new Date(), reviewedBy: fromId } },
                    { returnDocument: 'after' }
                );
            } catch (e) { /* bad ObjectId, etc. — target stays null, handled below */ }

            if (target) {
                await tgAnswerCallback(cb.id, approving ? '✅ Approved — now live' : '❌ Rejected', true);
                if (target.createdBy) {
                    const msg = approving
                        // task-marketplace notifications
                        // switched from Bangla to English.
                        ? `🎉 <b>Your Task Was Approved!</b>\n\n📋 ${target.title}\n\nIt's now live for everyone in the "⭐ Exclusive" tab. 🎉`
                        : `❌ <b>Your Task Was Rejected</b>\n\n📋 ${target.title}\n\nSorry, admin didn't approve this task (the bot may not be added as admin in your channel/group, or it didn't follow policy). ⚠️ Paid TON is not automatically refunded — contact support if you have questions.`;
                    tgSend(target.createdBy, msg).catch(() => {});
                }
            } else {
                await tgAnswerCallback(cb.id, '⚠️ Already reviewed by someone else', true);
            }
            const [text_, kb] = await renderPendingReviewList(tasks);
            await tgEdit(chatId, msgId, text_, { reply_markup: kb });
            return res.status(200).json({ ok: true });
        }

        // ── Filtered/paginated task list for a chosen category ──
        if (data.startsWith('a_taskcat_')) {
            const rest = data.replace('a_taskcat_', '');
            const lastUnderscore = rest.lastIndexOf('_');
            const category = rest.slice(0, lastUnderscore);
            const page = parseInt(rest.slice(lastUnderscore + 1)) || 0;
            const [text_, kb] = await renderTaskManageList(tasks, category, page, fromId);
            await tgEdit(chatId, msgId, text_, { reply_markup: kb });
            return res.status(200).json({ ok: true });
        }

        if (data.startsWith('deltask_')) {
            // Format: deltask_<category>_<page>_<taskId>
            const rest = data.replace('deltask_', '');
            const parts = rest.split('_');
            const tid = parts.pop();
            const page = parseInt(parts.pop()) || 0;
            const category = parts.join('_') || 'all';
            // server-side re-check, not just a hidden button. The
            // moderator's client could in theory replay/forge a deltask_
            // callback for a task ID it never saw a button for — this stops
            // that regardless of what the UI showed.
            if (!isAdmin(fromId)) {
                const target = await tasks.findOne({ _id: new ObjectId(tid) });
                if (!target || target.createdBy !== fromId) {
                    await tgAnswerCallback(cb.id, '❌ Not authorized to remove this task', true);
                    const [text_, kb] = await renderTaskManageList(tasks, category, page, fromId);
                    await tgEdit(chatId, msgId, text_, { reply_markup: kb });
                    return res.status(200).json({ ok: true });
                }
            }
            try {
                await tasks.deleteOne({ _id: new ObjectId(tid) });
                await tgAnswerCallback(cb.id, '🗑 Task removed', true);
            } catch (e) {
                await tgAnswerCallback(cb.id, '❌ Failed to remove', true);
            }
            const [text_, kb] = await renderTaskManageList(tasks, category, page, fromId);
            await tgEdit(chatId, msgId, text_, { reply_markup: kb });
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_addpromo') {
            await setAdminState(fromId, { step: 'promo_count' });
            await tgEdit(chatId, msgId, '🎟 <b>Create Promo Codes</b>\n\nHow many codes do you want to generate?', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        // ── 🎟 View Promos — which promo codes are active and how many claims each has ──
        if (data.startsWith('a_viewpromos_')) {
            const page = parseInt(data.replace('a_viewpromos_', '')) || 0;
            const perPage = 8;
            const totalCount = await promos.countDocuments({});
            const list = await promos.find({}).sort({ createdAt: -1 }).skip(page * perPage).limit(perPage).toArray();

            if (!list.length) {
                await tgEdit(chatId, msgId, page === 0 ? '📭 No promo codes created yet.' : '📭 No more promo codes.', { reply_markup: backKb });
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
                       `   ⏰ ${expired ? 'Expired' : 'Expires'}: ${p.expiresAt ? fmtBDDateTime(p.expiresAt) : 'never'}\n\n`;
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
            await tgEdit(chatId, msgId, '📢 <b>Broadcast — Step 1/4</b>\n\nType the message text:', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        // ── "📢 Broadcast This Code" shortcut, shown right after a promo
        // code (or batch) is generated (see promo_maxuses below). Pre-fills
        // the broadcast text with a ready-made description + the code, then
        // drops into the normal broadcast flow from Step 2/4 onward so the
        // admin still gets the usual button/photo/preview steps before
        // anything actually sends.
        // ── ✋ Manual approve (after an auto-payout failed / was unclear): same as the old Binance flow — optional hash, then approve ──
        if (data.startsWith('wd_manual_')) {
            const wid = data.replace('wd_manual_', '');
            const w = await withdrawals.findOne({ _id: new ObjectId(wid) });
            if (!w || w.status !== 'pending') { await tgSend(chatId, 'Already processed'); return res.status(200).json({ ok: true }); }
            await tgAnswerCallback(cb.id, 'Manual approve', false);
            await setAdminState(fromId, { step: 'wd_txhash', wid, chatId, msgId });
            await tgEdit(chatId, msgId, `✋ Manual approval for <code>${w.userId}</code>.\n\n⚠️ Only continue if you <b>checked the payout wallet and the user really received the money</b> (or you paid by hand). Paste the <b>transaction hash</b> / explorer link, or skip:`, {
                reply_markup: { inline_keyboard: [[{ text: '⏭ Skip (no hash)', callback_data: `wd_skiphash_${wid}` }]] },
            });
            return res.status(200).json({ ok: true });
        }

        // ── 🔄 Wallet change requests from users (api/withdraw.js handleWalletChange) ──
        if (data.startsWith('wc_ok_') || data.startsWith('wc_no_')) {
            const ok = data.startsWith('wc_ok_');
            const uid = data.replace('wc_ok_', '').replace('wc_no_', '');
            const upd = ok
                ? await users.findOneAndUpdate({ _id: uid, walletChangeStatus: 'pending' }, { $set: { walletChangeStatus: 'approved', walletChangeDecidedAt: new Date() } }, { returnDocument: 'after' })
                : await users.findOneAndUpdate({ _id: uid, walletChangeStatus: 'pending' }, { $unset: { walletChangeStatus: '' }, $set: { walletChangeDecidedAt: new Date() } }, { returnDocument: 'after' });
            if (!upd) { await tgSend(chatId, 'Already handled'); return res.status(200).json({ ok: true }); }
                        await tgEdit(chatId, msgId, `${ok ? '✅ <b>Wallet change ACCEPTED</b>' : '❌ <b>Wallet change DENIED</b>'} — user <code>${uid}</code>`, { reply_markup: { inline_keyboard: [] } });
            const left = Math.max(0, WALLET_CHANGE_MAX_REQUESTS - (upd.walletChangeRequests || 0));
            tgSend(uid, ok
                ? `✅ <b>Wallet change approved!</b>\n\nOpen the app → <b>Withdraw</b> → <b>Set new wallet</b> and enter your new address.`
                : `❌ <b>Wallet change request denied.</b>\n\nYou have <b>${left}</b> request${left === 1 ? '' : 's'} left.`).catch(() => {});
            return res.status(200).json({ ok: true });
        }

        // ── 💳 Payout wallet check (which address the recovery phrase controls + balances) ──
        if (data === 'a_payoutwallet') {
            await tgAnswerCallback(cb.id, 'Checking...', false);
            let t;
            if (!process.env.TON_PAYOUT_MNEMONIC) t = '💳 <b>Payout Wallet</b>\n\n❌ <code>TON_PAYOUT_MNEMONIC</code> is not set in Vercel.';
            else {
                try {
                    const { getPayoutWalletInfo, payoutMaxUsd } = await import('../lib/tonPayout.js');
                    const info = await getPayoutWalletInfo();
                    t = `💳 <b>Payout Wallet</b>\n\n` +
                        `⚙️ Auto-pay: <b>${process.env.TON_PAYOUT_ENABLED === '1' ? 'ON ✅' : 'OFF (TON_PAYOUT_ENABLED is not 1)'}</b>\n` +
                        `🧩 Wallet version: <b>${info.version}</b>\n` +
                        `📍 Address:\n<code>${info.address}</code>\n\n` +
                        `💎 TON (fees): <b>${info.ton.toFixed(3)}</b>\n` +
                        `💵 USDT: <b>${info.usdt.toFixed(4)}</b>\n` +
                        `🛡 Max per payout: <b>$${payoutMaxUsd()}</b>` +
                        `\n📆 Max per 24h: <b>${Number(process.env.TON_PAYOUT_DAILY_MAX_USD) > 0 ? '$' + Number(process.env.TON_PAYOUT_DAILY_MAX_USD) : 'no limit'}</b>\n\n` +
                        `⚠️ This address MUST be the Tonkeeper wallet that holds your USDT. If it is different, change <code>TON_PAYOUT_WALLET_VERSION</code> (v5r1 / v4r2).`;
                } catch (e) { t = `💳 <b>Payout Wallet</b>\n\n❌ Error: ${escHtml(String(e.message || e).slice(0, 300))}`; }
            }
            await tgSend(chatId, t, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }

        // ── 📣 Channel Post menu (admin only — not in TASK_CALLBACK_PREFIXES) ──
        if (data === 'a_chpost') {
            await clearAdminState(fromId);
            const [t, kb] = await renderChannelMenu(db);
            await tgEdit(chatId, msgId, t, { reply_markup: kb });
            return res.status(200).json({ ok: true });
        }
        if (data === 'chp_auto') {
            const cs = await getChannelSettings(db);
            await saveChannelSettings(db, { autoPromo: !cs.autoPromo });
            const [t, kb] = await renderChannelMenu(db);
            await tgEdit(chatId, msgId, t, { reply_markup: kb });
            return res.status(200).json({ ok: true });
        }
        if (data === 'chp_setpic') {
            await setAdminState(fromId, { step: 'chp_setpic' });
            await tgEdit(chatId, msgId, '🖼 <b>Set Channel Picture</b>\n\nSend the picture now. It is saved <b>permanently</b> and used on every promo post (and on manual posts when you choose it).', { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_chpost' }]] } });
            return res.status(200).json({ ok: true });
        }
        if (data === 'chp_delpic') {
            await saveChannelSettings(db, { photoFileId: null });
            const [t, kb] = await renderChannelMenu(db);
            await tgEdit(chatId, msgId, t, { reply_markup: kb });
            return res.status(200).json({ ok: true });
        }
        if (data === 'chp_new') {
            await setAdminState(fromId, { step: 'chp_text' });
            await tgEdit(chatId, msgId, '✍️ <b>New Channel Post — Step 1/2</b>\n\nSend the post text. You can use <code>&lt;b&gt;bold&lt;/b&gt;</code>, <code>&lt;i&gt;italic&lt;/i&gt;</code>, <code>&lt;code&gt;code&lt;/code&gt;</code>.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Cancel', callback_data: 'a_chpost' }]] } });
            return res.status(200).json({ ok: true });
        }
        if (data === 'chp_usesaved' || data === 'chp_nophoto') {
            const st = await getAdminState(fromId);
            if (!st || st.step !== 'chp_photo') return res.status(200).json({ ok: true });
            if (data === 'chp_usesaved') {
                const cs = await getChannelSettings(db);
                if (!cs.photoFileId) { await tgSend(chatId, '❌ No saved picture yet. Set one from the Channel Post menu.'); return res.status(200).json({ ok: true }); }
                st.photoFileId = cs.photoFileId;
            } else st.photoFileId = null;
            st.step = 'chp_confirm';
            await setAdminState(fromId, st);
            await sendChannelPreview(chatId, st);
            return res.status(200).json({ ok: true });
        }
        if (data === 'chp_send') {
            const st = await getAdminState(fromId);
            if (!st || st.step !== 'chp_confirm') { await tgSend(chatId, '⚠️ Nothing to post (already sent or cancelled).'); return res.status(200).json({ ok: true }); }
            const r = await postToChannel(st.text, st.photoFileId);
            if (!r.ok) { await tgSend(chatId, '❌ ' + r.error); return res.status(200).json({ ok: true }); }
            await clearAdminState(fromId);
            await tgSend(chatId, '✅ Posted to the channel!');
            await tgSend(chatId, `✅ Posted to ${OFFICIAL_CHANNEL}.`, { reply_markup: backKb });
            return res.status(200).json({ ok: true });
        }
        // manual "post these promo codes" button (shown under a generated batch when auto-post is OFF or failed)
        if (data.startsWith('chp_pb_')) {
            const batchId = data.replace('chp_pb_', '');
            const list = await promos.find({ batchId }).toArray();
            if (!list.length) { await tgSend(chatId, '❌ These promo codes no longer exist.'); return res.status(200).json({ ok: true }); }
            if (list[0].channelMsgId) { await tgSend(chatId, '⚠️ Already posted to the channel.'); return res.status(200).json({ ok: true }); }
            const r = await postPromoBatchToChannel(db, list.map(p => p.code), list[0].reward, list[0].maxUses);
            await tgSend(chatId, r.ok ? '✅ Posted to the channel!' : '❌ ' + r.error);
            return res.status(200).json({ ok: true });
        }

        if (data.startsWith('pbc_')) {
            const code = data.replace('pbc_', '');
            const promo = await promos.findOne({ code });
            if (!promo) {
                await tgAnswerCallback(cb.id, '❌ This promo code no longer exists.', true);
                return res.status(200).json({ ok: true });
            }
            const text =
                `🎁 <b>Free WTC Promo Code!</b>\n\n` +
                `Redeem this code now and get <b>${promo.reward} WTC</b> instantly — just paste it into the "Have a promo code?" box on Home.\n\n` +
                `🎟 Code: <code>${obscureCode(code)}</code>\n\n` +
                `⏰ Expires in 24 hours — don't miss out!`;
            await setAdminState(fromId, { step: 'bc_button_text', text });
            await tgEdit(chatId, msgId, '📢 <b>Broadcast — Step 2/4</b>\n\nAdd an inline button? Send the button text, or skip:', { reply_markup: { inline_keyboard: [[{ text: '⏭ Skip button', callback_data: 'bc_skip_button' }], [{ text: '◀️ Cancel', callback_data: 'a_menu' }]] } });
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

            // no longer loops over every user in this single
            // request (used to die mid-loop past ~100 users on Vercel
            // Hobby's 10s timeout, with no resume — see lib/broadcastJob.js).
            // Now creates a persisted job and hands off to
            // api/broadcastWorker.js, which processes it in small chunks,
            // self-triggering the next chunk each time, until every user
            // has been messaged.
            const totalUsers = await users.countDocuments({});
            const job = await createBroadcastJob({
                text: bs.text, buttonText: bs.buttonText, buttonUrl: bs.buttonUrl, photoFileId: bs.photoFileId,
                createdBy: fromId, totalUsers,
            });

            // the preview message this button lives
            // on is a PHOTO message whenever the admin attached a photo
            // (sent via tgSendPhoto), and Telegram rejects editMessageText
            // on a photo message ("there is no text in the message to
            // edit"). tgApi() doesn't throw on that — it just returns
            // {ok:false} — so this confirmation edit was failing completely
            // silently: the admin saw nothing happen after tapping "✅
            // Confirm & Send" (buttons stayed on screen, no confirmation
            // text), even though the job WAS created and WAS actually
            // sending in the background. Now uses editMessageCaption for
            // photo broadcasts, and explicitly clears the buttons in both
            // cases so a second tap can't queue a duplicate broadcast.
            const confirmText = `📢 Broadcast queued for <b>${totalUsers}</b> users.\n\nSending in the background — you'll get a "✅ Done!" message here when it's finished.\n\n<i>(If this is the first broadcast since setting up the cron ticker, the first users may take up to 1 minute to start going out.)</i>`;
            if (bs.photoFileId) {
                await tgEditCaption(chatId, msgId, confirmText, { reply_markup: { inline_keyboard: [] } });
            } else {
                await tgEdit(chatId, msgId, confirmText, { reply_markup: { inline_keyboard: [] } });
            }

            // this used to be responsible for
            // kicking off a self-chaining fetch loop, which never reliably
            // continued past the first hop (see lib/broadcastProcessor.js
            // for the full story of why). Now api/broadcastTick.js, called
            // every minute by an external cron service, is what actually
            // drives the broadcast to completion — this call is just a
            // nice-to-have that gets the FIRST chunk out immediately
            // instead of making the admin wait up to a minute for the next
            // cron tick. If it fails for any reason, the cron tick picks
            // the job up on its own within a minute regardless.
            const BOT_TOKEN_FOR_WORKER = process.env.CRON_SECRET;
            waitUntil((() => {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 3000);
                return fetch(`${APP_URL}/api/broadcastWorker?jobId=${job._id}&secret=${BOT_TOKEN_FOR_WORKER}`, { signal: controller.signal })
                    .catch(() => {}) // expected: AbortError once the 3s cutoff hits — harmless, the cron tick backstops this
                    .finally(() => clearTimeout(timeout));
            })());

            return res.status(200).json({ ok: true });
        }

        if (data === 'a_sendwtc') {
            await setAdminState(fromId, { step: 'sendwtc_id' });
            await tgEdit(chatId, msgId, '💰 Send the <b>Telegram ID</b> of who you want to send WTC to:', { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        // ── 🎁 Gift flow — reason → target → amount → confirm → (user claims in-app) ──
        if (data === 'a_sendgift') {
            await setAdminState(fromId, { step: 'gift_reason' });
            await tgEdit(chatId, msgId, "🎁 <b>Send Gift — Step 1/3</b>\n\nWhat's the reason for this gift? (the user will see this reason when they open the app)", { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }
        if (data === 'gift_confirm') {
            const gs = await getAdminState(fromId);
            if (!gs || gs.step !== 'gift_confirm') { return res.status(200).json({ ok: true }); }
            await clearAdminState(fromId);
            await gifts.insertOne({
                userId: gs.targetId, amount: gs.amount, reason: gs.reason,
                status: 'pending', createdBy: fromId, createdAt: new Date(),
            });
            await tgEdit(chatId, msgId, `✅ <b>Gift created!</b>\n\n👤 <code>${gs.targetId}</code>\n💰 ${gs.amount.toLocaleString()} WTC\n📝 ${gs.reason}\n\nThe user will see an animated gift-box as soon as they open the app, and their balance will be credited when they claim it.`, { reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] } });
            tgSend(gs.targetId, `🎁 A <b>surprise gift</b> is waiting for you! Open the NEWTUBE app to see it.`).catch(() => {});
            return res.status(200).json({ ok: true });
        }
        if (data === 'gift_cancel') {
            await clearAdminState(fromId);
            await tgEdit(chatId, msgId, '❌ Gift cancelled.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] } });
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

    // ── If a photo is sent — only relevant during the broadcast flow's bc_photo step ──
    if (msg.photo && fromId === String(ADMIN_ID)) {
        const bs = await getAdminState(fromId);
        // 📣 channel picture: permanent save, or a one-off picture for a manual post
        if (bs && bs.step === 'chp_setpic') {
            const fid = msg.photo[msg.photo.length - 1].file_id;
            await saveChannelSettings(db, { photoFileId: fid });
            await clearAdminState(fromId);
            const [t, kb] = await renderChannelMenu(db);
            await tgSend(chatId, '✅ Picture saved permanently.\n\n' + t, { reply_markup: kb });
            return res.status(200).json({ ok: true });
        }
        if (bs && bs.step === 'chp_photo') {
            bs.photoFileId = msg.photo[msg.photo.length - 1].file_id;
            bs.step = 'chp_confirm';
            await setAdminState(fromId, bs);
            await sendChannelPreview(chatId, bs);
            return res.status(200).json({ ok: true });
        }
        if (bs && bs.step === 'bc_photo') {
            const largest = msg.photo[msg.photo.length - 1]; // Telegram puts the largest resolution last
            bs.photoFileId = largest.file_id;
            bs.step = 'bc_confirm';
            await setAdminState(fromId, bs);
            await sendBroadcastPreview(chatId, bs);
            return res.status(200).json({ ok: true });
        }
        return res.status(200).json({ ok: true }); // ignore a photo sent during any other step
    }

    if (!msg.text) return res.status(200).json({ ok: true });
    const text = msg.text.trim();

    // A regular (non-staff) user replying with their new wallet address after tapping
    // "Change Wallet Address" (wd_fixaddr_). One-time, lifetime flow (see
    // WALLET_CHANGE_PENALTY_PERCENT, lib/constants.js): closes THIS withdrawal as a refund
    // minus the penalty and locks the new address for every future withdrawal.
    // Checked before /start handling and the staff-only gate because it must work for ANY user.
    {
        const addrState = await getAdminState(fromId);
        if (addrState && addrState.step === 'wd_new_address') {
            await clearAdminState(fromId);
            const w = await withdrawals.findOne({ _id: new ObjectId(addrState.wid) });
            const wUser = await users.findOne({ _id: fromId }, { projection: { walletChangeUsed: 1 } });
            if (!w || w.status !== 'pending' || String(w.userId) !== fromId || wUser?.walletChangeUsed) {
                await tgSend(chatId, "⚠️ This withdrawal can no longer be updated (it may have already been processed, or your one-time wallet change was already used).");
                return res.status(200).json({ ok: true });
            }
            // Same character rules as api/withdraw.js (no spaces, no HTML characters).
            if (!/^[A-Za-z0-9_\-:.+\/=]{5,100}$/.test(text)) {
                // Keep them in the same state so their next message is tried again.
                await setAdminState(fromId, addrState);
                await tgSend(chatId, "⚠️ That doesn't look like a valid address. Please reply with your correct address (no spaces).");
                return res.status(200).json({ ok: true });
            }
            // Atomic claim so the same withdrawal can never be refunded twice.
            const claimedChange = await withdrawals.findOneAndUpdate({ _id: w._id, status: 'pending' }, { $set: { status: 'processing' } });
            if (!claimedChange) {
                await tgSend(chatId, "⚠️ This withdrawal can no longer be updated (it may have already been processed).");
                return res.status(200).json({ ok: true });
            }

            const penalty = Math.floor((w.wtcAmount || 0) * WALLET_CHANGE_PENALTY_PERCENT / 100);
            const refund = (w.wtcAmount || 0) - penalty;

            // Like finalizeWithdrawal's refund: withdrawalCount is never decremented here,
            // and consumed referrals are returned.
            const userUpdate = { $inc: { wtcBalance: refund }, $set: {
                withdrawPending: false,
                lockedWalletMethod: w.method, lockedWalletAddress: text, walletChangeUsed: true,
            } };
            if (w.referralConsumed) userUpdate.$inc.usedValidReferrals = -w.referralConsumed;
            await users.updateOne({ _id: fromId }, userUpdate);
            await withdrawals.updateOne(
                { _id: w._id },
                { $set: {
                    status: 'wallet_changed', processedAt: new Date(),
                    walletChangePenalty: penalty, walletChangeRefund: refund, newAddress: text,
                } }
            );

            await tgSend(chatId,
                `✅ Wallet updated to:\n<code>${escHtml(text)}</code>\n\n` +
                `This withdrawal was closed: <b>${refund.toLocaleString()} WTC</b> refunded to your balance, <b>${penalty.toLocaleString()} WTC</b> kept as the one-time change penalty.\n\n` +
                `Your wallet is now locked to this address — future withdrawals will use it automatically.`
            );
            if (ADMIN_ID) {
                await tgSend(ADMIN_ID,
                    `🔄 <b>User Changed Their Wallet (one-time)</b>\n\n` +
                    `👤 User: <code>${fromId}</code>\n` +
                    `🪙 Withdrawal WTC: <b>${(w.wtcAmount || 0).toLocaleString()}</b> — refunded ${refund.toLocaleString()}, kept ${penalty.toLocaleString()} as penalty\n` +
                    `📍 New locked wallet: <code>${escHtml(text)}</code>\n` +
                    `🆔 Request: <code>${w._id}</code>\n\n` +
                    `Nothing further to do — this request is closed. Their next withdrawal will use the new wallet automatically.`
                ).catch(() => {});
            }
            return res.status(200).json({ ok: true });
        }
    }

    // ── /start ──
    if (text.startsWith('/start')) {
        // ── Appeal deep-link: reached when a banned/suspended user taps the
        // "Request Review" button (/start appeal_<id>) — sends the admin a one-tap Unban button directly.
        const payload = text.split(' ')[1] || '';
        if (payload.startsWith('appeal_')) {
            const targetId = payload.replace('appeal_', '');
            if (fromId === targetId) { // verify they're appealing for their own account — prevents spamming with someone else's ID
                const targetUser = await users.findOne({ _id: targetId });
                // 17 Oct 2026 — APPEAL RULES (ban → appeal → ban → appeal loop fix):
                //   • only a really banned account can appeal (an unbanned / unknown account is told so, admin is NOT pinged)
                //   • ONE appeal per ban: appealCount >= 1 (an earlier appeal was already answered) or appealBlocked
                //     (admin pressed "Keep Suspended", Ban & Wipe, or Ban + referrals) → final message, admin is NOT pinged
                //   • a real Unban resets appealCount/appealBlocked, so a future ban gets one fresh appeal
                if (!targetUser?.isBanned) {
                    await tgSend(chatId, `ℹ️ Your account is not suspended, so there is nothing to review.`);
                    return res.status(200).json({ ok: true });
                }
                if (targetUser.appealBlocked || (targetUser.appealCount || 0) >= 1) {
                    if (!targetUser.appealPending) await tgSend(chatId, `🚫 <b>Your review was already completed.</b>\n\nThe decision is final and no further review requests can be sent.`);
                    else await tgSend(chatId, `📨 <b>You already have a review request pending.</b>\n\nWe'll get back to you soon — no need to send another. Thanks for your patience!`);
                    return res.status(200).json({ ok: true });
                }
                // one pending appeal at a time. Previously this deep-link
                // sent a fresh "Appeal / Review Request" to the admin EVERY time
                // it was opened, with no gate at all — a banned user re-opening
                // the link (or the mini app re-triggering it) could flood the
                // admin with duplicate copies of the exact same request (this is
                // what was happening — same user, same message, 4x in a row).
                // Note this is a spam gate, not a "banned users can never appeal"
                // wall — that would defeat the point of having an appeal flow at
                // all. Once the admin resolves it (Unban or Keep Suspended, both
                // handled below), appealPending clears and they can appeal again
                // if banned again in the future.
                if (targetUser?.appealPending) {
                    await tgSend(chatId, `📨 <b>You already have a review request pending.</b>\n\nWe'll get back to you soon — no need to send another. Thanks for your patience!`);
                    return res.status(200).json({ ok: true });
                }
                await users.updateOne({ _id: targetId }, { $set: { appealPending: true, appealSentAt: new Date() }, $inc: { appealCount: 1 } });
                await tgSend(chatId, `📨 <b>Your review request has been sent to the admin.</b>\n\nWe'll get back to you soon. Thanks for your patience!`);
                if (ADMIN_ID) {
                    await tgSend(ADMIN_ID,
                        `🆘 <b>Appeal / Review Request</b>\n\n` +
                        `User <code>${targetId}</code> (@${targetUser?.telegramUsername || 'n/a'}, ${targetUser?.firstName || 'User'}) says their account was suspended/banned by mistake and wants it reviewed.\n\n` +
                        `💰 Balance: <b>${targetUser?.wtcBalance || 0} WTC</b>\n` +
                        `🚫 Currently banned: <b>${targetUser?.isBanned ? 'YES ⛔' : 'No ✅'}</b>`,
                        { reply_markup: { inline_keyboard: [[
                            { text: '✅ Unban this account', callback_data: `unban_${targetId}` },
                            { text: '🚫 Keep Suspended', callback_data: `denyappeal_${targetId}` },
                        ]] } }
                    ).catch(() => {});
                }
                return res.status(200).json({ ok: true });
            }
        }

        if (isStaff(fromId)) {
            // ⚠️ No photo shown to staff — just the text panel
            const label = isAdmin(fromId) ? 'Admin' : 'Task Manager';
            await tgSend(chatId, `👑 <b>NEWTUBE ${isAdmin(fromId) ? 'Admin Panel' : 'Task Manager'}</b>\n\nWelcome back, ${label}!`, { reply_markup: kbFor(fromId) });
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

    // ── Everything below is staff-only (admin, or the task moderator for task steps) ──
    if (!isStaff(fromId)) return res.status(200).json({ ok: true });

    const s = await getAdminState(fromId);
    if (!s) {
        await tgSend(chatId, isAdmin(fromId) ? '👑 <b>NEWTUBE Admin Panel</b>' : '📋 <b>Task Manager</b>', { reply_markup: kbFor(fromId) });
        return res.status(200).json({ ok: true });
    }
    // task moderator can only continue a step that belongs to the
    // Add Task flow (every task_* step name — see grep of s.step above).
    // Anything else (withdrawal txhash, promo, gift, broadcast, send-wtc,
    // user lookup, video) silently resets them back to their own menu
    // instead of letting a leftover/forced state slip them into another
    // flow.
    if (!isAdmin(fromId) && !s.step.startsWith('task_')) {
        await clearAdminState(fromId);
        await tgSend(chatId, '📋 <b>Task Manager</b>', { reply_markup: kbFor(fromId) });
        return res.status(200).json({ ok: true });
    }

    // ── Withdrawal approval — transaction hash reply ──
    if (s.step === 'wd_txhash') {
        await clearAdminState(fromId);
        const w = await withdrawals.findOne({ _id: new ObjectId(s.wid) });
        if (!w || w.status !== 'pending') {
            await tgSend(chatId, '⚠️ That withdrawal was already processed.', { reply_markup: adminKb });
            return res.status(200).json({ ok: true });
        }
        const done = await finalizeWithdrawal({ w, approve: true, txHash: text.trim(), chatId: s.chatId, msgId: s.msgId });
        await tgSend(chatId, done ? '✅ Approved with transaction hash attached.' : '⚠️ That withdrawal was already processed.');
        return res.status(200).json({ ok: true });
    }

    // ── User lookup ──
    if (s.step === 'user_lookup') {
        await clearAdminState(fromId);

        // If it's not a number, treat it as a name/username search — can have multiple matches
        if (!/^\d+$/.test(text)) {
            const regex = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            const matches = await users.find({ $or: [{ firstName: regex }, { telegramUsername: regex }] }).limit(15).toArray();
            if (!matches.length) { await tgSend(chatId, `❌ No user found matching "${text}".`, { reply_markup: adminKb }); return res.status(200).json({ ok: true }); }

            let out = `🔍 <b>Search results for "${text}"</b> (${matches.length})\n\nTap a user to see full details & moderation options:\n\n`;
            matches.forEach((u, i) => {
                out += `<b>${i + 1}.</b> ${u.firstName || 'User'} (@${u.telegramUsername || 'n/a'})\n   ID: <code>${u._id}</code> | 💰 ${u.wtcBalance || 0} WTC | 👥 ${u.referralCount || 0} refs | 📤 ${u.withdrawalCount || 0} withdraws${u.isBanned ? ' 🔒' : ''}\n\n`;
            });
            const rows = matches.map(u => [{ text: `👤 ${u.firstName || 'User'} (@${u.telegramUsername || 'n/a'})`, callback_data: `lookup_${u._id}` }]);
            rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
            await tgSend(chatId, out, { reply_markup: { inline_keyboard: rows } });
            return res.status(200).json({ ok: true });
        }

        const u = await users.findOne({ _id: text });
        if (!u) { await tgSend(chatId, '❌ User not found.', { reply_markup: adminKb }); return res.status(200).json({ ok: true }); }
        await tgSend(chatId, ...renderUserLookup(u, await withdrawals.find({ userId: text }).toArray(), await buildCycleReport(db, u).catch(() => null)));
        return res.status(200).json({ ok: true });
    }

    // ── Send WTC ──
    if (s.step === 'sendwtc_id') {
        s.targetId = text; s.step = 'sendwtc_amount';
        await setAdminState(fromId, s);
        await tgSend(chatId, `💰 How much <b>WTC</b> do you want to send to <code>${text}</code>?`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'sendwtc_amount') {
        const amt = parseInt(text);
        if (!amt || isNaN(amt)) { await tgSend(chatId, '❌ Enter a valid number'); return res.status(200).json({ ok: true }); }
        const u = await users.findOne({ _id: s.targetId });
        await clearAdminState(fromId);
        if (!u) { await tgSend(chatId, '❌ User not found.', { reply_markup: adminKb }); return res.status(200).json({ ok: true }); }
        await users.updateOne({ _id: s.targetId }, { $inc: { wtcBalance: amt, lifetimeWtcEarned: amt, ...cyInc('adminGift', amt) }, $min: cyMin() });
        await tgSend(chatId, `✅ <b>${amt} WTC</b> sent to <code>${s.targetId}</code>`, { reply_markup: adminKb });
        await tgSend(s.targetId, `🎁 You've received <b>${amt} WTC</b> from the admin!`);
        return res.status(200).json({ ok: true });
    }

    // ── 🎁 Gift flow — reason → target (username/ID) → amount → confirm ──
    if (s.step === 'gift_reason') {
        s.reason = text; s.step = 'gift_target';
        await setAdminState(fromId, s);
        await tgSend(chatId, `📝 Reason: <b>${text}</b>\n\n🎁 <b>Send Gift — Step 2/3</b>\n\nWho do you want to gift? Send their <b>Telegram ID</b> or <b>@username</b>:`, { reply_markup: cancelKb });
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'gift_target') {
        const query = text.trim().replace(/^@/, '');
        const target = /^\d+$/.test(query)
            ? await users.findOne({ _id: query })
            : await users.findOne({ telegramUsername: { $regex: `^${query}$`, $options: 'i' } });
        if (!target) { await tgSend(chatId, '❌ User not found. Send the ID/username again, or tap Cancel:', { reply_markup: cancelKb }); return res.status(200).json({ ok: true }); }
        s.targetId = target._id; s.targetUsername = target.telegramUsername || 'N/A'; s.step = 'gift_amount';
        await setAdminState(fromId, s);
        await tgSend(chatId, `👤 Found: <code>${target._id}</code> (@${s.targetUsername})\n\n🎁 <b>Send Gift — Step 3/3</b>\n\nHow much <b>WTC</b> do you want to gift?`, { reply_markup: cancelKb });
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'gift_amount') {
        const amt = parseInt(text);
        if (!amt || isNaN(amt) || amt <= 0) { await tgSend(chatId, '❌ Enter a valid number:'); return res.status(200).json({ ok: true }); }
        s.amount = amt; s.step = 'gift_confirm';
        await setAdminState(fromId, s);
        await tgSend(chatId,
            `🎁 <b>Gift Preview</b>\n\n👤 <code>${s.targetId}</code> (@${s.targetUsername})\n💰 <b>${amt.toLocaleString()} WTC</b>\n📝 ${s.reason}\n\nConfirming this will show an animated gift-box as soon as the user opens the app.`,
            { reply_markup: { inline_keyboard: [[{ text: '✅ Confirm & Send', callback_data: 'gift_confirm' }], [{ text: '❌ Cancel', callback_data: 'gift_cancel' }]] } }
        );
        return res.status(200).json({ ok: true });
    }

    // ── 📣 Channel post — text → picture → preview → post ──
    if (s.step === 'chp_text') {
        s.text = text; s.step = 'chp_photo';
        await setAdminState(fromId, s);
        await tgSend(chatId, '✍️ <b>New Channel Post — Step 2/2</b>\n\nSend a picture for this post, or choose:', { reply_markup: { inline_keyboard: [[{ text: '🖼 Use saved picture', callback_data: 'chp_usesaved' }], [{ text: '⏭ No picture', callback_data: 'chp_nophoto' }], [{ text: '◀️ Cancel', callback_data: 'a_chpost' }]] } });
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
        if (!count || isNaN(count) || count < 1 || count > 50) { await tgSend(chatId, '❌ Enter a number between 1 and 50:'); return res.status(200).json({ ok: true }); }
        s.count = count; s.step = 'promo_reward';
        await setAdminState(fromId, s);
        await tgSend(chatId, `🎟 <b>${count}</b> code(s) will be generated\n\nHow much <b>WTC reward</b> per code?`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'promo_reward') {
        s.reward = parseInt(text);
        if (!s.reward || isNaN(s.reward)) { await tgSend(chatId, '❌ Enter a valid number:'); return res.status(200).json({ ok: true }); }
        s.step = 'promo_maxuses';
        await setAdminState(fromId, s);
        await tgSend(chatId, `Reward: <b>${s.reward} WTC</b>\n\nMax uses per code? (0 = unlimited):`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'promo_maxuses') {
        const maxUses = parseInt(text) || 9999;
        await clearAdminState(fromId);
        const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const generated = [];
        const batchId = Date.now().toString(36);
        for (let i = 0; i < s.count; i++) {
            const code = String(Math.floor(100000 + Math.random() * 900000));
            await promos.insertOne({ code, reward: s.reward, maxUses, usedCount: 0, redeemedBy: [], expiresAt: expireAt, createdAt: new Date(), batchId });
            generated.push(code);
        }
        // see obscureCode() above. Two versions shown per code: the
        // plain one (for your own records/testing), and a "broadcast-safe"
        // one with invisible characters woven in — paste THAT one into your
        // broadcast message instead of the plain code. It reads identically
        // to users, but copy-pasting it into the redeem box won't match the
        // real stored code (which is clean), so it forces people to type it
        // in by hand instead of just forwarding/pasting it around.
        const codeList = generated.map((c, i) =>
            `${i + 1}. Plain: <code>${c}</code>\n   Broadcast-safe: <code>${obscureCode(c)}</code>`
        ).join('\n');
        // "Broadcast This Code" button now shown for every batch
        // (was: only when exactly 1 code was generated). Per admin feedback,
        // it's wanted as a standing optional button regardless of count. When
        // a batch has more than one code, the button broadcasts the FIRST
        // code in the list — there's no way to broadcast "all of them" in a
        // single message, so this is the one made available; the others are
        // still there in the message above to hand out manually.
        // 15 Oct 2026: auto-post to the official channel (picture + Open NEWTUBE button) when auto-post is ON.
        let chanLine = '';
        const chanRows = [];
        try {
            const cs = await getChannelSettings(db);
            if (cs.autoPromo) {
                const pr = await postPromoBatchToChannel(db, generated, s.reward, maxUses);
                chanLine = pr.ok
                    ? `\n\n📣 <b>Posted to ${OFFICIAL_CHANNEL}</b>${pr.hadPhoto ? '' : ' (no picture set yet — set one in 📣 Channel Post)'}`
                    : `\n\n⚠️ <b>Channel post failed:</b> ${escHtml(pr.error)}`;
                if (!pr.ok) chanRows.push([{ text: '📣 Retry: Post to Channel', callback_data: `chp_pb_${batchId}` }]);
            } else {
                chanLine = '\n\n📣 Auto-post is OFF.';
                chanRows.push([{ text: '📣 Post to Channel', callback_data: `chp_pb_${batchId}` }]);
            }
        } catch (e) { console.error('promo channel post failed:', e.message); chanLine = '\n\n⚠️ Channel post failed (see logs).'; chanRows.push([{ text: '📣 Retry: Post to Channel', callback_data: `chp_pb_${batchId}` }]); }
        const kb = { inline_keyboard: [...chanRows, [{ text: '📢 Broadcast This Code', callback_data: `pbc_${generated[0]}` }], [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] };
        await tgSend(chatId,
            `✅ <b>${s.count} Promo Code(s) created!</b>\n\n💰 Reward: <b>${s.reward} WTC</b> each\n👥 Max uses: <b>${maxUses}</b>\n⏰ Expires: <b>24 hours</b>\n\n📋 <b>Codes:</b>\n${codeList}\n\n⚠️ Use the <b>Broadcast-safe</b> version when pasting into a broadcast message — it looks identical to users but resists simple copy-paste sharing.${s.count > 1 ? '\n\n📢 The Broadcast button below sends <b>code #1</b> — copy the others manually if you need to send more than one.' : ''}${chanLine}`,
            { reply_markup: kb }
        );
        return res.status(200).json({ ok: true });
    }

    // ── Add Video — 2 steps ──
    if (s.step === 'video_id') {
        const videoId = extractYoutubeId(text);
        if (!videoId) { await tgSend(chatId, '❌ Send a valid YouTube link or ID (11 characters):'); return res.status(200).json({ ok: true }); }
        s.videoId = videoId; s.step = 'video_title';
        await setAdminState(fromId, s);
        await tgSend(chatId, `🎬 <b>Step 2/2</b>\n\nVideo ID: ✅ <code>${videoId}</code>\n\nSend the video's <b>title</b>:`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'video_title') {
        await clearAdminState(fromId);
        // YouTube's thumbnail URL pattern is predictable — no separate API call needed, can be built directly
        const thumbnail = `https://img.youtube.com/vi/${s.videoId}/hqdefault.jpg`;
        await videos.insertOne({ videoId: s.videoId, title: text, thumbnail, isActive: true, createdAt: new Date() });
        await tgSend(chatId, `✅ <b>Video added!</b>\n\n🎬 ${text}\n🔗 <code>${s.videoId}</code>\n🖼 Thumbnail auto-added`, { reply_markup: adminKb });
        return res.status(200).json({ ok: true });
    }

    // ── Add Task — 5 steps ──
    if (s.step === 'task_title') {
        s.title = text;
        s.step = 'task_category';
        await setAdminState(fromId, s);
        // ⚠️ UPDATED — "✅ Channel/Group Join" category button removed (per
        // request — only this button, not the underlying api-verify system:
        // Exclusive/Partner/Earning tasks below can still be individually
        // set to API-verified via task_verify_api/task_verify_link).
        await tgSend(chatId, `📋 <b>Step 2/5</b>\n\nTitle: ✅ <b>${s.title}</b>\n\nChoose the task type:`, { reply_markup: { inline_keyboard: [
            [{ text: '⭐ Exclusive Task', callback_data: 'task_cat_exclusive' }],
            [{ text: '🤝 Partner Task', callback_data: 'task_cat_partner' }],
            [{ text: '👥 Earning Task', callback_data: 'task_cat_earning' }],
        ] } });
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'task_channelid') {
        s.channelId = text.startsWith('@') ? text : `@${text}`;
        s.url = `https://t.me/${s.channelId.replace('@', '')}`;
        s.step = 'task_reward';
        await setAdminState(fromId, s);
        await tgSend(chatId, `📋 <b>Step 3/5</b>\n\nChannel: ✅ <code>${s.channelId}</code>\n\nHow much <b>WTC reward</b>?`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'task_url') {
        s.url = text; s.channelId = null;
        s.step = 'task_reward';
        await setAdminState(fromId, s);
        await tgSend(chatId, `📋 <b>Step 3/5</b>\n\nLink: ✅ ${s.url}\n\nHow much <b>WTC reward</b>?`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'task_reward') {
        const val = parseFloat(text);
        if (!val || isNaN(val) || val <= 0) { await tgSend(chatId, '❌ Enter a valid number:'); return res.status(200).json({ ok: true }); }
        if (s.rewardCurrency === 'usdt') {
            s.rewardUsdt = val;
            s.reward = Math.round(val * WTC_PER_USD); // converted once here — everything downstream (earn.js reward crediting) just sees plain WTC
        } else {
            s.reward = Math.round(val);
        }
        s.step = 'task_quantity';
        await setAdminState(fromId, s);
        await tgSend(chatId, `📋 <b>Step 4/5</b>\n\nHow many users can complete this task?\n(enter a number, or <code>0</code> = unlimited):`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'task_quantity') {
        s.limit = parseInt(text) || 0;
        s.step = 'task_confirm';
        await setAdminState(fromId, s);
        const rewardLine = s.rewardCurrency === 'usdt' ? `<b>${s.rewardUsdt} USDT</b> (≈ ${s.reward} WTC)` : `<b>${s.reward} WTC</b>`;
        const verifyLine = s.verifyType === 'api' ? '✅ API (Telegram Join — auto-verified)' : '🔗 Non-API (Link — manual claim)';
        const preview =
            `📋 <b>Task Preview</b>\n\n` +
            `Title: <b>${s.title}</b>\n` +
            `Category: <b>${s.category}</b>\n` +
            `Verification: <b>${verifyLine}</b>\n` +
            `Link: ${s.url || 'none'}\n` +
            (s.channelId ? `Channel: <code>${s.channelId}</code>\n` : '') +
            `Reward: ${rewardLine}\n` +
            `Max: <b>${s.limit || 'Unlimited'}</b>\n\n` +
            (s.verifyType === 'api' ? `⚠️ Make sure the bot is an admin in that channel/group!\n\n` : '') +
            `Type <b>CONFIRM</b> to save:`;
        await tgSend(chatId, preview, { reply_markup: cancelKb });
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'task_confirm') {
        if (text.toUpperCase() !== 'CONFIRM') { await tgSend(chatId, '❌ Type <b>CONFIRM</b> to save:'); return res.status(200).json({ ok: true }); }
        await clearAdminState(fromId);
        await tasks.insertOne({
            title: s.title, url: s.url, channelId: s.channelId, category: s.category,
            verifyType: s.verifyType || (s.category === 'channel' ? 'api' : 'link'),
            rewardWtc: s.reward, rewardCurrency: s.rewardCurrency || 'wtc', rewardUsdt: s.rewardUsdt || null,
            limit: s.limit, isApproved: true, completionCount: 0, createdAt: new Date(),
            createdBy: fromId, // ⚠️ NEW — Season 4 task-moderator scoping (see isTaskModerator above). Lets manage/delete restrict a moderator to only their own tasks.
        });
        const doneRewardLine = s.rewardCurrency === 'usdt' ? `${s.rewardUsdt} USDT (≈${s.reward} WTC)` : `${s.reward} WTC`;
        await tgSend(chatId, `✅ <b>Task created!</b>\n\n📋 ${s.title}\n💰 ${doneRewardLine}\n👥 Max: ${s.limit || 'Unlimited'}`, { reply_markup: kbFor(fromId) });
        // silent admin-only notification when the task moderator adds
        // a task. Sent ONLY to ADMIN_ID, never to the moderator — the
        // moderator's own confirmation above says nothing about this. Lets
        // the admin see every task the moderator (and whoever they're
        // collaborating with on the task content) is publishing, without the
        // moderator knowing they're being watched.
        if (!isAdmin(fromId) && ADMIN_ID) {
            const modName = msg.from.first_name || 'Task Moderator';
            const modUser = msg.from.username ? `@${msg.from.username}` : fromId;
            tgSend(ADMIN_ID,
                `👀 <b>Task Moderator added a task</b>\n\n` +
                `👤 ${modName} (${modUser})\n` +
                `📋 ${s.title}\n` +
                `🏷 Category: ${s.category}\n` +
                `💰 ${doneRewardLine}\n` +
                `👥 Max: ${s.limit || 'Unlimited'}\n` +
                (s.url ? `🔗 ${s.url}\n` : '') +
                (s.channelId ? `📢 ${s.channelId}\n` : '')
            ).catch(() => {});
        }
        return res.status(200).json({ ok: true });
    }

    // ── Default ──
    await tgSend(chatId, isAdmin(fromId) ? '👑 <b>NEWTUBE Admin Panel</b>' : '📋 <b>Task Manager</b>', { reply_markup: kbFor(fromId) });
    res.status(200).json({ ok: true });
}
