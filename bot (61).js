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
import { buildCycleReport, renderCycleShort, renderCycleFull } from '../lib/cycleStats.js'; // 18 Oct 2026 — 📊 Cycle Report
import { cyInc, cyMin } from '../lib/cycleStats.js';
import { connectToDatabase } from '../lib/mongodb.js';
import { escHtml, tgApi, tgSend, tgEdit, tgEditCaption, tgSendPhoto, tgAnswerCallback } from '../lib/telegram.js';
import { CATEGORIES, categoryKeyboard, matchCategory } from '../lib/categories.js';
import { getAdminState, setAdminState, clearAdminState } from '../lib/adminState.js';
import { createBroadcastJob } from '../lib/broadcastJob.js';
import { waitUntil } from '@vercel/functions';
import { WTC_PER_USD, fmtBDDateTime, fmtBDDate, todayStartBD } from '../lib/constants.js';
import { markBanned, markUnbanned } from '../lib/banRegistry.js';
import { buildTrustReport, renderTrustShort, renderTrustFull } from '../lib/trustReport.js'; // 17 Oct 2026 — fake/real report
import { handleSignupCallback } from '../lib/signupBursts.js';                                 // 18 Oct 2026 — 🆕 Signup Bursts (ported from Fruit Cut admin)

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

// 28 Oct 2026 — the task preview shown before CONFIRM (now also reached from the logo step, so it lives in one place).
async function sendTaskPreview(chatId, s) {
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
            `Max: <b>${s.limit || 'Unlimited'}</b>\n` +
            `Logo: <b>${s.logoFileId ? 'photo ✅' : (s.logoUrl ? 'link ✅' : 'none')}</b>\n\n` +
            (s.verifyType === 'api' ? `⚠️ Make sure the bot is an admin in that channel/group!\n\n` : '') +
            `Type <b>CONFIRM</b> to save:`;
        await tgSend(chatId, preview, { reply_markup: cancelKb });
}

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
    const rows = [];
    all.filter(canDelete).forEach(t => {
        rows.push([{ text: `🗑 Remove: ${t.title.slice(0, 24)}`, callback_data: `deltask_${category}_${page}_${t._id}` }]);
        rows.push([{ text: `${(t.logoFileId || t.logoUrl) ? '🖼 Change' : '🖼 Add'} logo: ${t.title.slice(0, 20)}`, callback_data: `settasklogo_${t._id}` }]); // 28 Oct 2026: task logo
    });
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


const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

// task-only moderator (partner). Single second Telegram ID, env var
// TASK_MODERATOR_ID. Deliberately scoped to Add Task / Manage Tasks only —
// every other admin action (promo codes, send WTC, gift,
// broadcast, ban, user lookup) stays admin-only. Two gates enforce this:
// isStaff() decides who gets into the panel at all, isTaskAction()/step
// prefix 'task_' decide what a non-admin staff member is actually allowed
// to touch once inside — see the two router gates below (callback_query
// and text-message handlers) for where these are applied.
const TASK_MODERATOR_ID = process.env.TASK_MODERATOR_ID;
function isAdmin(id) { return String(id) === String(ADMIN_ID); }
function isTaskModerator(id) { return !!TASK_MODERATOR_ID && String(id) === String(TASK_MODERATOR_ID); }
function isStaff(id) { return isAdmin(id) || isTaskModerator(id); }
const TASK_CALLBACK_PREFIXES = ['a_addtask', 'task_cat_', 'task_verify_', 'a_managetasks_menu', 'a_taskcat_', 'deltask_', 'a_menu', 'settasklogo_'];
function isTaskCallback(data) { return TASK_CALLBACK_PREFIXES.some(p => data === p || data.startsWith(p)); }

// Deployment URLs
const APP_URL = 'https://newtube-ton.vercel.app';                       // your Mini App's Vercel URL
const MINI_APP_URL = 'https://t.me/NewTube12_bot/WatchTo_Earn';
const COVER_PHOTO = 'https://i.postimg.cc/Gtp63QQV/file-000000007fa87207ae71dda1cde1426b.png'; // shown only in users' /start, not to the admin


// ── YouTube helpers: title/thumbnail of a playlist (no API key needed) + every video of a playlist (needs optional env YT_API_KEY) ──
async function fetchOembed(url) {
    try {
        const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
        return r.ok ? await r.json() : null;
    } catch { return null; }
}
async function fetchPlaylistVideos(listId, key) {
    const out = []; let pageToken = '';
    for (let i = 0; i < 6; i++) { // up to 300 videos
        const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(listId)}&key=${encodeURIComponent(key)}${pageToken ? `&pageToken=${pageToken}` : ''}`;
        let j; try { const r = await fetch(url); j = await r.json(); if (!r.ok) return { items: out, error: j?.error?.message || 'api_error' }; } catch { return { items: out, error: 'network' }; }
        for (const it of j.items || []) {
            const sn = it.snippet || {}, vid = sn.resourceId?.videoId, t = sn.title;
            if (!vid || !t || t === 'Private video' || t === 'Deleted video') continue;
            out.push({ videoId: vid, title: t, thumbnail: sn.thumbnails?.high?.url || sn.thumbnails?.medium?.url || `https://img.youtube.com/vi/${vid}/hqdefault.jpg` });
        }
        pageToken = j.nextPageToken; if (!pageToken) break;
    }
    return { items: out };
}
// Saves the YouTube video / playlist the admin just described, under the chosen category. Returns the confirmation text.
async function saveYoutube(videos, s, category) {
    const base = Date.now();
    if (!s.isPlaylist) {
        await videos.insertOne({ kind: 'youtube', videoId: s.videoId, title: s.title, thumbnail: `https://img.youtube.com/vi/${s.videoId}/hqdefault.jpg`, category, isActive: true, createdAt: new Date(base) });
        return `✅ <b>Video added!</b>\n\n🎬 ${escHtml(s.title)}\n🗂 ${escHtml(category)}`;
    }
    let note = '';
    const key = process.env.YT_API_KEY;
    if (key) {
        const r = await fetchPlaylistVideos(s.listId, key);
        if (r.items.length) {
            const have = new Set((await videos.find({ videoId: { $in: r.items.map(x => x.videoId) } }).project({ videoId: 1 }).toArray()).map(x => x.videoId));
            const docs = r.items.filter(x => !have.has(x.videoId)).map((x, i) => ({ kind: 'youtube', videoId: x.videoId, title: x.title, thumbnail: x.thumbnail, category, playlistId: s.listId, playlistTitle: s.title, isActive: true, createdAt: new Date(base - i * 1000) }));
            if (docs.length) await videos.insertMany(docs);
            return `✅ <b>Playlist added!</b>\n\n📃 ${escHtml(s.title)}\n🗂 ${escHtml(category)}\n🎬 ${docs.length} videos added${r.items.length - docs.length ? ` (${r.items.length - docs.length} already existed)` : ''}${r.error ? `\n⚠️ Stopped early: ${escHtml(r.error)}` : ''}`;
        }
        note = `\n\n⚠️ Couldn't read the playlist with YT_API_KEY (${escHtml(r.error || 'empty')}) — saved as ONE playlist item instead.`;
    } else {
        note = `\n\nℹ️ Saved as ONE playlist item (plays all its videos in order). To add every video separately, put a YouTube Data API key in Vercel as <code>YT_API_KEY</code>.`;
    }
    await videos.insertOne({ kind: 'youtube', listId: s.listId, title: s.title, thumbnail: s.thumbnail || '', category, isActive: true, createdAt: new Date(base) });
    return `✅ <b>Playlist added!</b>\n\n📃 ${escHtml(s.title)}\n🗂 ${escHtml(category)}${note}`;
}

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
        [{ text: '📊 Dashboard', callback_data: 'a_stats' }],
        [{ text: '👤 User Lookup', callback_data: 'a_user' }, { text: '👥 All Users', callback_data: 'a_allusers_0' }],
        [{ text: '🏆 Top Referrers (7d)', callback_data: 'a_toprefer' }, { text: '🆕 Signup Bursts', callback_data: 'a_signups' }],
        [{ text: '📋 Add Task', callback_data: 'a_addtask' }, { text: '🎬 Add YouTube Video', callback_data: 'a_addvideo' }],
        [{ text: '🎞 Add Movie / Anime', callback_data: 'a_addmovie' }],
        [{ text: '🗑 Manage Tasks', callback_data: 'a_managetasks_menu' }, { text: '🗑 Manage Videos', callback_data: 'a_managevideos_0' }],
        [{ text: '🎟 Add Promo', callback_data: 'a_addpromo' }, { text: '📋 View Promos', callback_data: 'a_viewpromos_0' }],
        [{ text: '📢 Broadcast', callback_data: 'a_broadcast' }],
        [{ text: '💰 Send WTC', callback_data: 'a_sendwtc' }, { text: '🎁 Send Gift', callback_data: 'a_sendgift' }],
    ],
};
const backKb = { inline_keyboard: [[{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] };

// the limited menu shown to the task moderator (see TASK_MODERATOR_ID
// above). Only the task buttons — nothing that touches money or users.
const taskModeratorKb = {
    inline_keyboard: [
        [{ text: '📋 Add Task', callback_data: 'a_addtask' }],
        [{ text: '🗑 Manage Tasks', callback_data: 'a_managetasks_menu' }],
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


// ── Shared user-detail + moderation panel — used by both numeric-ID lookup
// and the "tap a name" flow from username search / top-referrer drill-down.
// Returns [text, options] so callers can just do tgSend(chatId, ...renderUserLookup(u)).
// 18 Oct 2026 — 3rd param `cycle` = result of buildCycleReport() (lib/cycleStats.js): ads / mining / lootbox / tasks … since the last withdraw. null = skipped.
function renderUserLookup(u, cycle = null) {
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
        `📺 Ads Watched (lifetime): <b>${u.lifetimeAdsWatched || 0}</b> · today: <b>${u.adsWatchedToday || 0}</b>\n` +
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
        [{ text: '📊 Cycle Report', callback_data: `trust_${u._id}` }],
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
    const tasks = db.collection('tasks');
    const promos = db.collection('promos');
    const videos = db.collection('videos');
    const gifts = db.collection('gifts');



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



        // Everything below is staff-only (admin, or the task moderator for task actions)
        if (!isStaff(fromId)) return res.status(200).json({ ok: true });
        // task moderator only gets through for whitelisted task
        // callback_data (see isTaskCallback above). Silently ignored
        // otherwise — no error text, so a moderator poking around doesn't
        // get a roadmap of what exists via error messages.
        if (!isAdmin(fromId) && !isTaskCallback(data)) return res.status(200).json({ ok: true });





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

            await tgEdit(chatId, msgId,
                `☠️ <b>Done</b>\n\n` +
                `Referrer <code>${target}</code> banned.\n` +
                `Referrals newly banned: <b>${refIds.length}</b>`,
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
            await tgEdit(chatId, msgId, `🔒 Locked: <code>${target}</code>\n\nReferral rewards are held until you Unlock.`, { reply_markup: backKb });
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
                [{ text: '📦 Lootbox History', callback_data: `lootlog_${target}` }],
                [{ text: '◀️ Back to User', callback_data: `lookup_${target}` }],
            ] } });
            return res.status(200).json({ ok: true });
        }


        // ── Full user detail + moderation panel (tap-through from search/top-referrer/refs-list) ──
        if (data.startsWith('lookup_')) {
            const target = data.replace('lookup_', '');
            const u = await users.findOne({ _id: target });
            if (!u) { await tgEdit(chatId, msgId, '❌ User not found.', { reply_markup: backKb }); return res.status(200).json({ ok: true }); }
            const [uText, uOptions] = renderUserLookup(u, await buildCycleReport(db, u).catch(() => null));
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
            // v1.5 (saves Vercel/DB work): this dashboard runs ~15 queries incl. a full scan of every user's wtcBalance.
            // The finished text is now kept for 3 minutes in settings.adminDashCache, so repeated taps cost ONE read.
            try {
                const dc = await db.collection('settings').findOne({ _id: 'adminDashCache' });
                const ageMs = dc?.at ? Date.now() - new Date(dc.at).getTime() : Infinity;
                if (dc?.text && ageMs < 3 * 60 * 1000) {
                    await tgEdit(chatId, msgId, dc.text + `\n\n🕒 <i>Cached ${Math.round(ageMs / 1000)}s ago (refreshes every 3 min)</i>`, { reply_markup: backKb });
                    return res.status(200).json({ ok: true });
                }
            } catch (e) { /* cache problem -> just compute normally */ }
            const total = await users.estimatedDocumentCount(); // v1.5: O(1) metadata count instead of scanning the collection
            const todayStart = todayStartBD(); // ⚠️ FIXED — was server-local (UTC) midnight, now matches the real BD-midnight daily reset
            const newToday = await users.countDocuments({ createdAt: { $gte: todayStart } });
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
            let extraText = '';
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
            const dashText =
                `📊 <b>Dashboard</b>\n\n` +
                `👥 Total Users: <b>${total}</b>\n` +
                `🆕 Today Joined: <b>${newToday}</b>\n` +
                `📋 Active Tasks: <b>${taskCnt}</b>\n` +
                `🎬 Active Videos: <b>${videoCnt}</b>\n` +
                `💰 Total WTC (all users): <b>${(wtcAgg[0]?.t || 0).toLocaleString()}</b>\n\n` +
                `🔍 <b>Device diagnostics</b>\n` +
                `📱 Unique devices ever opened app: <b>${uniqueDevices}</b>\n` +
                `🚩 Accounts flagged multi-account: <b>${flaggedMulti}</b>` +
                (activeToday !== null ? `\n🟢 Opened app today: <b>${activeToday}</b>` : '') + extraText;
            db.collection('settings').updateOne({ _id: 'adminDashCache' }, { $set: { text: dashText, at: new Date() } }, { upsert: true }).catch(() => {});
            await tgEdit(chatId, msgId, dashText, { reply_markup: backKb });
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
            const total = await users.estimatedDocumentCount(); // v1.5
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
                       `   👥 Referrals: ${u.referralCount || 0}\n\n`;
            });

            const navRow = [];
            if (page > 0) navRow.push({ text: '◀️ Prev', callback_data: `a_allusers_${page - 1}` });
            if ((page + 1) * PER_PAGE < total) navRow.push({ text: 'Next ▶️', callback_data: `a_allusers_${page + 1}` });

            await tgEdit(chatId, msgId, out, { reply_markup: { inline_keyboard: [navRow, [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]].filter(r => r.length) } });
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_toprefer') {
            // 23 Oct 2026 (admin): ONLY the last 7 days (rolling), computed live from new users' createdAt + referredBy.
            // Nothing is stored or reset — there is no contest any more, this is just an admin-side view.
            const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
            const grouped = await users.aggregate([
                { $match: { referredBy: { $ne: null }, createdAt: { $gte: since } } },
                { $group: { _id: '$referredBy', refs: { $sum: 1 } } },
                { $sort: { refs: -1 } },
                { $limit: 20 },
            ]).toArray();
            if (!grouped.length) {
                await tgEdit(chatId, msgId, '🏆 <b>Top Referrers — last 7 days</b>\n\nNo referrals in the last 7 days.', { reply_markup: backKb });
                return res.status(200).json({ ok: true });
            }
            const infos = await users.find({ _id: { $in: grouped.map(g => g._id) } }).project({ telegramUsername: 1, firstName: 1 }).toArray();
            const infoById = new Map(infos.map(i => [i._id, i]));
            const top = grouped.map(g => {
                const i = infoById.get(g._id) || {};
                return { id: g._id, name: (i.telegramUsername && i.telegramUsername !== 'N/A') ? i.telegramUsername : (i.firstName || g._id), refs: g.refs };
            });
            let out = '🏆 <b>Top 20 Referrers — last 7 days</b>\n\nTap a name below to see exactly who they referred (spot real vs fake refs):\n\n';
            top.forEach((t, i) => { out += `${i + 1}. @${t.name} — <b>${t.refs}</b> refs\n`; });
            const rows = top.map(t => [{ text: `👥 @${t.name} (${t.refs})`, callback_data: `a_refslist_${t.id}_0` }]);
            rows.push([{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]);
            await tgEdit(chatId, msgId, out, { reply_markup: { inline_keyboard: rows } });
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

        if (data === 'a_addtask') {
            await setAdminState(fromId, { step: 'task_title' });
            await tgEdit(chatId, msgId, `📋 <b>Add Task — Step 1/5</b>\n\nSend the task's <b>title</b>:`, { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }

        // ⚠️ Article/Faucet task types removed (this update) — the shortcut
        // handlers that used to live here (a_addarticle / a_addfaucet) are
        // gone. Use "📋 Add Task" → pick a category instead.

        // ── 🎞 Add Movie / Anime (video platform) — 5 steps: file → title → category → poster → stream link ──
        if (data === 'a_addmovie') {
            await setAdminState(fromId, { step: 'movie_file' });
            await tgEdit(chatId, msgId, `🎞 <b>Add Movie / Anime — Step 1/5</b>\n\nSend (or forward) the <b>video file</b> here. People will get this exact file when they tap Download.`, { reply_markup: cancelKb });
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('a_mcat_')) {
            const ms = await getAdminState(fromId);
            const cat = CATEGORIES[parseInt(data.replace('a_mcat_', ''), 10)]?.[0];
            if (ms && ms.step === 'movie_cat' && cat) {
                ms.category = cat; ms.step = 'movie_poster';
                await setAdminState(fromId, ms);
                await tgSend(chatId, `🎞 <b>Step 4/5</b>\n\nCategory: ✅ <b>${escHtml(cat)}</b>\n\nSend the <b>poster photo</b> (or an image link). Send <code>-</code> to skip.`);
            }
            return res.status(200).json({ ok: true });
        }
        if (data.startsWith('a_ycat_')) {
            const ys = await getAdminState(fromId);
            const cat = CATEGORIES[parseInt(data.replace('a_ycat_', ''), 10)]?.[0];
            if (ys && ys.step === 'yt_cat' && cat) {
                await clearAdminState(fromId);
                await tgSend(chatId, '⏳ Saving…');
                await tgSend(chatId, await saveYoutube(videos, ys, cat), { reply_markup: adminKb });
            }
            return res.status(200).json({ ok: true });
        }

        if (data === 'a_addvideo') {
            await setAdminState(fromId, { step: 'video_id' });
            await tgEdit(chatId, msgId, `🎬 <b>Add YouTube Video — Step 1/3</b>\n\nSend a YouTube <b>video link</b> (or video ID), or a <b>playlist link</b> (youtube.com/playlist?list=…):`, { reply_markup: cancelKb });
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

        // 28 Oct 2026 — 🖼 add / change / remove the LOGO of an existing task (tap the button in Manage Tasks, then send a photo or an image link).
        if (data.startsWith('settasklogo_')) {
            const tid = data.replace('settasklogo_', '');
            let target = null;
            try { target = await tasks.findOne({ _id: new ObjectId(tid) }); } catch (e) { /* bad id */ }
            if (!target || (!isAdmin(fromId) && target.createdBy !== fromId)) { await tgAnswerCallback(cb.id, '❌ Not authorized / task not found', true); return res.status(200).json({ ok: true }); }
            await setAdminState(fromId, { step: 'task_setlogo', taskId: tid });
            await tgAnswerCallback(cb.id, '');
            await tgSend(chatId, `🖼 <b>Task logo</b>\n\n📋 ${escHtml(target.title)}\n\nSend the <b>logo as a photo</b> (square looks best), or an <b>image link</b> (https://…).\nType <code>REMOVE</code> to delete the current logo.`, { reply_markup: cancelKb });
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
            const totalUsers = await users.estimatedDocumentCount(); // v1.5
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
    // ── 📡 STORAGE CHANNEL → auto-add ──
    // Put the bot in your channel as an ADMIN, set env STORAGE_CHANNEL_ID, then just upload videos to the channel.
    // Caption = "Title #Category" (e.g. "Naruto Episode 1 #Anime"). Edit the caption later to change title/category.
    const cp = update.channel_post || update.edited_channel_post;
    if (cp) {
        try {
            const f = cp.video || (cp.document && /^video\//.test(cp.document.mime_type || '') ? cp.document : null);
            if (!f) return res.status(200).json({ ok: true });
            const chanId = String(cp.chat.id), wanted = process.env.STORAGE_CHANNEL_ID ? String(process.env.STORAGE_CHANNEL_ID) : '';
            if (!wanted) {
                if (ADMIN_ID) await tgSend(ADMIN_ID, `📡 A video was posted in <b>${escHtml(cp.chat.title || 'your channel')}</b>.\n\nChannel ID: <code>${chanId}</code>\n\nTo auto-add videos from this channel: Vercel → Settings → Environment Variables → add <code>STORAGE_CHANNEL_ID</code> = <code>${chanId}</code> → Redeploy.`);
                return res.status(200).json({ ok: true });
            }
            if (chanId !== wanted) return res.status(200).json({ ok: true });
            const { db } = await connectToDatabase();
            const col = db.collection('videos');
            const cap = String(cp.caption || '').trim();
            const tags = [...cap.matchAll(/#([\p{L}\p{N}_]+)/gu)].map(m => m[1]);
            let category = null;
            for (const t of tags) { category = matchCategory(t); if (category) break; }
            if (!category && tags.length) category = tags[0].replace(/_/g, ' ').slice(0, 24);
            if (!category) category = 'Other';
            const firstLine = cap.split('\n').map(x => x.replace(/#[\p{L}\p{N}_]+/gu, '').replace(/\s+/g, ' ').trim()).find(Boolean);
            const title = (firstLine || String(f.file_name || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ').trim() || 'Untitled').slice(0, 150);
            const srcKey = `${chanId}:${cp.message_id}`;
            const existing = await col.findOne({ srcKey }, { projection: { _id: 1 } });
            if (existing) {
                if (update.edited_channel_post) await col.updateOne({ _id: existing._id }, { $set: { title, category } });
                return res.status(200).json({ ok: true });
            }
            const thumb = f.thumbnail || f.thumb;
            const doc = { kind: 'movie', title, category, fileId: f.file_id, fileKind: cp.video ? 'video' : 'document', srcKey, chatId: chanId, messageId: cp.message_id, isActive: true, createdAt: new Date() };
            if (cp.chat.username) doc.chatUsername = cp.chat.username;
            if (thumb && thumb.file_id) doc.posterFileId = thumb.file_id;
            const ins = await col.insertOne(doc);
            if (ADMIN_ID) await tgSend(ADMIN_ID, `✅ <b>Added from channel</b>\n\n🎞 ${escHtml(title)}\n🗂 ${escHtml(category)}${tags.length ? '' : '\n\n💡 No #category in the caption → saved as "Other". Edit the caption (e.g. add #Anime) to move it.'}`, { reply_markup: { inline_keyboard: [[{ text: '🗑 Remove', callback_data: `delvideo_${ins.insertedId}` }]] } });
        } catch (err) { console.error('channel_post error:', err); }
        return res.status(200).json({ ok: true });
    }

    const msg = update.message;
    if (!msg) return res.status(200).json({ ok: true });

    const fromId = String(msg.from.id);
    const chatId = msg.chat.id;

    // ── 🎞 Add Movie — video/document file (step 1) and poster photo (step 4) ──
    if ((msg.video || msg.document || msg.photo) && isAdmin(fromId)) {
        const ms = await getAdminState(fromId);
        if (ms && ms.step === 'movie_file' && (msg.video || msg.document)) {
            const f = msg.video || msg.document;
            ms.fileId = f.file_id; ms.fileKind = msg.video ? 'video' : 'document';
            ms.step = 'movie_title';
            await setAdminState(fromId, ms);
            await tgSend(chatId, `🎞 <b>Step 2/5</b>\n\nFile: ✅ saved\n\nSend the <b>title</b> (e.g. <i>Naruto Shippuden — Episode 12</i>):`);
            return res.status(200).json({ ok: true });
        }
        if (ms && ms.step === 'movie_poster' && msg.photo) {
            ms.posterFileId = msg.photo[msg.photo.length - 1].file_id; ms.step = 'movie_stream';
            await setAdminState(fromId, ms);
            await tgSend(chatId, `🎞 <b>Step 5/5</b>\n\nPoster: ✅ saved\n\nSend a <b>direct streaming link</b> (.mp4 / .m3u8) so people can also <b>watch inside the app</b>. Send <code>-</code> for download-only.`);
            return res.status(200).json({ ok: true });
        }
    }

    // ── 28 Oct 2026: a photo sent during the task-logo steps (admin or task moderator) becomes the task's logo ──
    if (msg.photo && isStaff(fromId)) {
        const ls = await getAdminState(fromId);
        if (ls && (ls.step === 'task_logo' || ls.step === 'task_setlogo')) {
            const fid = msg.photo[msg.photo.length - 1].file_id;
            if (ls.step === 'task_logo') {
                ls.logoFileId = fid; ls.logoUrl = null; ls.step = 'task_confirm';
                await setAdminState(fromId, ls);
                await sendTaskPreview(chatId, ls);
            } else {
                await clearAdminState(fromId);
                await tasks.updateOne({ _id: new ObjectId(ls.taskId) }, { $set: { logoFileId: fid }, $unset: { logoUrl: '' } });
                await tgSend(chatId, '✅ <b>Task logo saved.</b> It shows in the Task tab within a few minutes.', { reply_markup: kbFor(fromId) });
            }
            return res.status(200).json({ ok: true });
        }
    }

    // ── If a photo is sent — only relevant during the broadcast flow's bc_photo step ──
    if (msg.photo && fromId === String(ADMIN_ID)) {
        const bs = await getAdminState(fromId);
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

        await tgSendPhoto(chatId, COVER_PHOTO,
            `🎬 <b>Welcome to NEWTUBE!</b>\n\n` +
            `Movies · Anime · Videos — watch and download, free!\n\n` +
            `👇 Tap the button below to get started!`,
            { reply_markup: { inline_keyboard: [
                [{ text: '🚀 Open NEWTUBE', web_app: { url: APP_URL } }],
                [{ text: '📤 Share', url: `https://t.me/share/url?url=${encodeURIComponent(MINI_APP_URL)}&text=${encodeURIComponent('🎬 NEWTUBE — Movies, Anime & Videos. Watch and download free!')}` }],
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
    // Anything else (promo, gift, broadcast, send-wtc,
    // user lookup, video) silently resets them back to their own menu
    // instead of letting a leftover/forced state slip them into another
    // flow.
    if (!isAdmin(fromId) && !s.step.startsWith('task_')) {
        await clearAdminState(fromId);
        await tgSend(chatId, '📋 <b>Task Manager</b>', { reply_markup: kbFor(fromId) });
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
        await tgSend(chatId, ...renderUserLookup(u, await buildCycleReport(db, u).catch(() => null)));
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
        const kb = { inline_keyboard: [[{ text: '📢 Broadcast This Code', callback_data: `pbc_${generated[0]}` }], [{ text: '◀️ Back to Menu', callback_data: 'a_menu' }]] };
        await tgSend(chatId,
            `✅ <b>${s.count} Promo Code(s) created!</b>\n\n💰 Reward: <b>${s.reward} WTC</b> each\n👥 Max uses: <b>${maxUses}</b>\n⏰ Expires: <b>24 hours</b>\n\n📋 <b>Codes:</b>\n${codeList}\n\n⚠️ Use the <b>Broadcast-safe</b> version when pasting into a broadcast message — it looks identical to users but resists simple copy-paste sharing.${s.count > 1 ? '\n\n📢 The Broadcast button below sends <b>code #1</b> — copy the others manually if you need to send more than one.' : ''}`,
            { reply_markup: kb }
        );
        return res.status(200).json({ ok: true });
    }

    // ── Add Movie / Anime — text steps ──
    if (s.step === 'movie_file') { await tgSend(chatId, '❌ Please send the <b>video file</b> itself (not text).'); return res.status(200).json({ ok: true }); }
    if (s.step === 'movie_title') {
        s.title = text.slice(0, 150); s.step = 'movie_cat';
        await setAdminState(fromId, s);
        await tgSend(chatId, `🎞 <b>Step 3/5</b>\n\nTitle: ✅ <b>${escHtml(s.title)}</b>\n\nPick a <b>category</b> (or type your own):`, { reply_markup: categoryKeyboard('a_mcat_') });
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'movie_cat') {
        s.category = text.slice(0, 24); s.step = 'movie_poster';
        await setAdminState(fromId, s);
        await tgSend(chatId, `🎞 <b>Step 4/5</b>\n\nCategory: ✅ <b>${escHtml(s.category)}</b>\n\nSend the <b>poster photo</b> (or an image link). Send <code>-</code> to skip.`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'movie_poster') {
        if (text !== '-') { if (!/^https:\/\//i.test(text)) { await tgSend(chatId, '❌ Send a photo, an https image link, or <code>-</code> to skip.'); return res.status(200).json({ ok: true }); } s.thumbnail = text; }
        s.step = 'movie_stream';
        await setAdminState(fromId, s);
        await tgSend(chatId, `🎞 <b>Step 5/5</b>\n\nSend a <b>direct streaming link</b> (.mp4 / .m3u8) so people can also <b>watch inside the app</b>. Send <code>-</code> for download-only.`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'movie_stream') {
        if (text !== '-' && !/^https:\/\//i.test(text)) { await tgSend(chatId, '❌ Send an https link or <code>-</code> for download-only.'); return res.status(200).json({ ok: true }); }
        await clearAdminState(fromId);
        const doc = { kind: 'movie', title: s.title, category: s.category, fileId: s.fileId, fileKind: s.fileKind, isActive: true, createdAt: new Date() };
        if (s.thumbnail) doc.thumbnail = s.thumbnail;
        if (s.posterFileId) doc.posterFileId = s.posterFileId;
        if (text !== '-') doc.streamUrl = text;
        await videos.insertOne(doc);
        await tgSend(chatId, `✅ <b>Added!</b>\n\n🎞 ${escHtml(s.title)}\n🗂 ${escHtml(s.category)}\n▶️ Watch: ${doc.streamUrl ? 'yes' : 'no (download only)'}\n⬇️ Download: yes\n\nIt shows in the app within a few minutes.`, { reply_markup: adminKb });
        return res.status(200).json({ ok: true });
    }

    // ── Add YouTube video / playlist — link → (title) → category ──
    if (s.step === 'video_id') {
        const listM = text.match(/[?&]list=([A-Za-z0-9_-]{10,})/);
        const videoId = extractYoutubeId(text);
        if (listM && (/youtube\.com\/playlist\?/i.test(text) || !videoId)) {
            s.isPlaylist = true; s.listId = listM[1]; s.step = 'yt_cat';
            const o = await fetchOembed(`https://www.youtube.com/playlist?list=${s.listId}`);
            s.title = (o && o.title) || 'Playlist'; s.thumbnail = (o && o.thumbnail_url) || '';
            await setAdminState(fromId, s);
            await tgSend(chatId, `🎬 <b>Step 2/2</b>\n\nPlaylist: ✅ <b>${escHtml(s.title)}</b>\n\nPick the <b>category</b> (or type your own):`, { reply_markup: categoryKeyboard('a_ycat_') });
            return res.status(200).json({ ok: true });
        }
        if (!videoId) { await tgSend(chatId, '❌ Send a valid YouTube video link, playlist link, or ID (11 characters):'); return res.status(200).json({ ok: true }); }
        s.videoId = videoId; s.step = 'video_title';
        await setAdminState(fromId, s);
        await tgSend(chatId, `🎬 <b>Step 2/3</b>\n\nVideo ID: ✅ <code>${videoId}</code>\n\nSend the video's <b>title</b>:`);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'video_title') {
        s.title = text.slice(0, 150); s.step = 'yt_cat';
        await setAdminState(fromId, s);
        await tgSend(chatId, `🎬 <b>Step 3/3</b>\n\nTitle: ✅ <b>${escHtml(s.title)}</b>\n\nPick the <b>category</b> (or type your own):`, { reply_markup: categoryKeyboard('a_ycat_') });
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'yt_cat') {
        await clearAdminState(fromId);
        await tgSend(chatId, await saveYoutube(videos, s, text.slice(0, 24)), { reply_markup: adminKb });
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
        s.step = 'task_logo';
        await setAdminState(fromId, s);
        await tgSend(chatId, `🖼 <b>Logo (optional)</b>\n\nSend the task's <b>logo as a photo</b> (square looks best), or an <b>image link</b> (https://…).\nType <code>SKIP</code> for no logo.`, { reply_markup: cancelKb });
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'task_logo') {
        const t_ = text.trim();
        if (t_.toUpperCase() === 'SKIP') { s.logoFileId = null; s.logoUrl = null; }
        else if (/^https:\/\/\S{4,500}$/i.test(t_)) { s.logoUrl = t_; s.logoFileId = null; }
        else { await tgSend(chatId, '❌ Send a photo, an https:// image link, or type SKIP:'); return res.status(200).json({ ok: true }); }
        s.step = 'task_confirm';
        await setAdminState(fromId, s);
        await sendTaskPreview(chatId, s);
        return res.status(200).json({ ok: true });
    }
    if (s.step === 'task_setlogo') {
        const t_ = text.trim();
        if (t_.toUpperCase() === 'REMOVE') {
            await clearAdminState(fromId);
            await tasks.updateOne({ _id: new ObjectId(s.taskId) }, { $unset: { logoFileId: '', logoUrl: '' } });
            await tgSend(chatId, '✅ Logo removed.', { reply_markup: kbFor(fromId) });
            return res.status(200).json({ ok: true });
        }
        if (!/^https:\/\/\S{4,500}$/i.test(t_)) { await tgSend(chatId, '❌ Send a photo, an https:// image link, or type REMOVE:'); return res.status(200).json({ ok: true }); }
        await clearAdminState(fromId);
        await tasks.updateOne({ _id: new ObjectId(s.taskId) }, { $set: { logoUrl: t_ }, $unset: { logoFileId: '' } });
        await tgSend(chatId, '✅ <b>Task logo saved.</b>', { reply_markup: kbFor(fromId) });
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
            ...(s.logoFileId ? { logoFileId: s.logoFileId } : {}), ...(s.logoUrl ? { logoUrl: s.logoUrl } : {}), // 28 Oct 2026: optional task logo
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
