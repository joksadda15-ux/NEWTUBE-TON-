// lib/cycleStats.js
//
// 18 Oct 2026 — 📊 CYCLE REPORT ("since last withdraw" counters).
//
// Kaj: prottek earning-er shomoy (ad network, video, lootbox, mining, task, promo, gift, referral …) users.cy-te ekta chhoto counter barano hoy.
// Admin panel / withdraw request-e oi counter dekhiye bola jay "last withdraw-er por ei user ki ki theke koto WTC peyeche".
//
// users.cy shape (shob field optional):
//   cy: { since: Date, <key>N: <koybar>, <key>W: <koto WTC>, ... }     e.g. giga N/W, adsgramSpecialN/W, miningN/W, videoN/W, lootboxN/W, taskN/W …
//
// Writers:
//   • $inc: { ...cyInc('giga', 20) }  +  $min: cyMin()          (normal updateOne)
//   • api/earn.js video/lootbox use an update-pipeline and write 'cy.videoN', 'cy.videoW', 'cy.lootboxN', 'cy.lootboxW', 'cy.since' directly.
// Reset: lib/cycleCleanup.js $unset-s `cy` after a withdraw is approved (a snapshot is copied into the withdrawal doc first).

import { fmtBDDateTime } from './constants.js';

// key -> label shown to the admin. Unknown keys fall back to the raw key name, so a new network never breaks anything.
const LABELS = {
    giga: '🎬 GigaPub', adsgramSpecial: '📺 Adsgram Special', adsgramTask: '📋 Adsgram Task', monetag: '📢 Monetag', monetagPopup: '📢 Monetag Popup',
    video: '▶️ Video', lootbox: '📦 Lootbox', mining: '⛏ Mining', task: '✅ Tasks', promo: '🎟 Promo', gift: '🎁 Gift',
    adminGift: '💰 Admin gift', refJoin: '👥 Referral joins', refCommission: '💸 Ref commission', refMilestone: '🏆 Ref milestone',
};
const ORDER = Object.keys(LABELS);
const label = (k) => LABELS[k] || k;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const fmt = (n) => Math.round(num(n) * 100) / 100;
const isCountKey = (k) => /N$/.test(k) && k.length > 1;

// ── $inc helper: cyInc('giga', 20) -> { 'cy.gigaN': 1, 'cy.gigaW': 20 } ──
export function cyInc(key, amount = 0) {
    return { [`cy.${key}N`]: 1, [`cy.${key}W`]: num(amount) };
}

// ── $min helper: sets cy.since only if it is not set yet (a missing field is always "smaller" for $min) ──
export function cyMin() {
    return { 'cy.since': new Date() };
}

// cy object -> sorted rows [{ key, label, n, w }]
function rowsFrom(cy = {}) {
    const rows = [];
    for (const k of Object.keys(cy)) {
        if (!isCountKey(k)) continue;
        const key = k.slice(0, -1);
        const n = num(cy[k]);
        const w = num(cy[`${key}W`]);
        if (n <= 0 && w <= 0) continue;
        rows.push({ key, label: label(key), n, w });
    }
    rows.sort((a, b) => {
        const ia = ORDER.indexOf(a.key), ib = ORDER.indexOf(b.key);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || b.w - a.w;
    });
    return rows;
}

// ── report for one user (never throws — a report problem must not break a withdraw / admin screen) ──
export async function buildCycleReport(db, user) {
    const cy = (user && user.cy) || {};
    const rows = rowsFrom(cy);
    let lastWithdrawAt = null;
    try {
        if (db && user?._id !== undefined) {
            const last = await db.collection('withdrawals')
                .find({ userId: user._id }, { projection: { createdAt: 1 } })
                .sort({ createdAt: -1 }).limit(1).toArray();
            lastWithdrawAt = last[0]?.createdAt || null;
        }
    } catch { /* ignore */ }
    return {
        since: cy.since || null,
        lastWithdrawAt,
        rows,
        totalN: rows.reduce((a, r) => a + r.n, 0),
        totalW: rows.reduce((a, r) => a + r.w, 0),
        cy: rows.length > 0,
    };
}

const sinceText = (rep) => rep.since
    ? fmtBDDateTime(rep.since)
    : (rep.lastWithdrawAt ? `${fmtBDDateTime(rep.lastWithdrawAt)} (last withdraw)` : 'start');

// ── short block (withdraw request + user lookup) ──
export function renderCycleShort(rep) {
    if (!rep || !rep.rows.length) return `📊 <b>Since last withdraw:</b> no counted earnings yet`;
    const top = rep.rows.slice(0, 8).map(r => `   ${r.label}: <b>${r.n}</b> · ${fmt(r.w)} WTC`).join('\n');
    return `📊 <b>Since last withdraw</b> (from ${sinceText(rep)})\n${top}\n   Σ <b>${rep.totalN}</b> actions · <b>${fmt(rep.totalW)}</b> WTC`;
}

// ── full screen (📊 Cycle Report button) ──
export function renderCycleFull(user, rep, hint = '') {
    const head = `📊 <b>Cycle Report</b>\nUser: <code>${user?._id}</code> · ${user?.firstName || ''}\n` +
        `Cycle start: <b>${rep ? sinceText(rep) : 'start'}</b>\n` +
        `Balance now: <b>${fmt(user?.wtcBalance)} WTC</b> · Lifetime: <b>${fmt(user?.lifetimeWtcEarned)} WTC</b>\n\n`;
    if (!rep || !rep.rows.length) return head + `Kono counted earning nai (cycle notun, ba counter chalu hoar age-er data).` + (hint ? `\n\n${hint}` : '');
    const lines = rep.rows.map(r => `${r.label}: <b>${r.n}</b> bar · <b>${fmt(r.w)}</b> WTC`).join('\n');
    return head + lines + `\n\nΣ Total: <b>${rep.totalN}</b> actions · <b>${fmt(rep.totalW)}</b> WTC` + (hint ? `\n\n${hint}` : '');
}

// ── compact snapshot copied into the withdrawal doc (right before `cy` is reset) ──
export function makeCycleSnapshot(user, rep) {
    const rows = (rep && rep.rows) || [];
    return {
        cy: rows.reduce((o, r) => { o[r.key] = { n: r.n, w: fmt(r.w) }; return o; }, {}),
        cySince: (rep && rep.since) || null,
        cyTotalN: (rep && rep.totalN) || 0,
        cyTotalW: fmt(rep && rep.totalW),
    };
}

// ── one line for 💸 Withdraw History ──
export function renderCycleSnapshotLine(cycle) {
    const cy = cycle?.cy || {};
    const parts = Object.keys(cy)
        .sort((a, b) => (ORDER.indexOf(a) < 0 ? 999 : ORDER.indexOf(a)) - (ORDER.indexOf(b) < 0 ? 999 : ORDER.indexOf(b)))
        .map(k => `${label(k)} ${cy[k].n}×(${cy[k].w})`);
    return parts.length ? `📋 oi shomoy: ${parts.join(' · ')} → Σ ${cycle.cyTotalW || 0} WTC` : `📋 oi shomoy: counted earning nai`;
}
