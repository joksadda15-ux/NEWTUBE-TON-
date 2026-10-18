// lib/trustReport.js
//
// 17 Oct 2026 — "FAKE vs REAL" REPORT for the admin panel.
//
// Kaj: ekta user-er current earning-cycle (last withdraw-er por theke, ba 30 din) ghete dekhe ekta SCORE ar karon-er list dey,
// jate admin ek nojore bujhte pare user ta real manush na script. Eta PROOF na — eta indicator. Tai kokhono auto-ban kore na,
// shudhu admin-ke dekhay (lookup panel, withdraw request, "🔍 Fake/Real Report" button).
//
// Data kothay thake:
//   • lootboxLogs  — prottek lootbox claim-er (shomoy, amount, network, tap→claim sec). 30 din por MongoDB nijei muche dey (TTL).
//   • users.recentAdClaims — shesh kichu ad claim-er sample (shomoy + tap→claim sec).
//   • users.botSuspectCount / multiAccountFlag / lifetime counters.
//   • withdrawals  — same wallet onno account-e use hoyeche kina.
//
// Score = point-er jog. 6+ = 🔴 Likely script, 3-5 = 🟡 Suspicious, 0-2 = 🟢 No strong script signs.
// Data khub kom hole (event < 10) ⚪ "Not enough data" dekhay — tokhon guess kore kichu bola hoy na.

import { fmtBDDateTime, DAILY_VIDEO_WTC_MAX } from './constants.js';

const BD_OFFSET_MS = 6 * 3600 * 1000;                  // Bangladesh = UTC+6
const bdHour = (t) => new Date(t + BD_OFFSET_MS).getUTCHours();
const bdDay = (t) => new Date(t + BD_OFFSET_MS).toISOString().slice(0, 10);

function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function stdev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}
const fmtDur = (sec) => {
    if (!isFinite(sec)) return '-';
    if (sec < 90) return `${Math.round(sec)}s`;
    if (sec < 5400) return `${Math.round(sec / 60)}m`;
    return `${(sec / 3600).toFixed(1)}h`;
};

// ── main: collect data + score ──
export async function buildTrustReport(db, user) {
    const userId = String(user._id);
    const now = Date.now();
    const since = new Date(now - 30 * 86400000);

    const [lootRows, dupWallet] = await Promise.all([
        db.collection('lootboxLogs').find({ userId, createdAt: { $gte: since } }).sort({ createdAt: 1 }).limit(600).toArray().catch(() => []),
        findDuplicateWallet(db, userId),
    ]);

    const lootTimes = lootRows.map(r => new Date(r.createdAt).getTime());
    const adTimes = (user.recentAdClaims || []).map(s => Number(s.c)).filter(Boolean);

    // ── lootbox numbers ──
    const lootGaps = [];
    for (let i = 1; i < lootTimes.length; i++) lootGaps.push((lootTimes[i] - lootTimes[i - 1]) / 1000);
    const lootGapMedian = median(lootGaps);
    const lootGapCV = lootGaps.length >= 6 && mean(lootGaps) > 0 ? stdev(lootGaps) / mean(lootGaps) : null; // 0 = machine-regular, 1+ = human-irregular
    const waits = lootRows.map(r => Number(r.waitSec)).filter(n => isFinite(n) && n > 0);
    const waitSpread = waits.length >= 4 ? Math.max(...waits) - Math.min(...waits) : null;

    // per-BD-day lootbox WTC (max 300/day because of the daily video cap)
    const perDay = {};
    for (const r of lootRows) { const d = bdDay(new Date(r.createdAt).getTime()); perDay[d] = (perDay[d] || 0) + (r.amount || 0); }
    const dayVals = Object.values(perDay);
    const maxedDays = dayVals.filter(v => v >= DAILY_VIDEO_WTC_MAX * 0.9).length;

    // ── "kokhon jege thake": last 7 din-e koyta alada ghonta-e kono activity ──
    const weekAgo = now - 7 * 86400000;
    const allEvents = [...lootTimes, ...adTimes].filter(t => t >= weekAgo);
    const hoursSet = new Set(allEvents.map(bdHour));
    const activeHours = hoursSet.size;

    // ── account facts ──
    const ageDays = Math.max(1, (now - new Date(user.createdAt).getTime()) / 86400000);
    const lifetimeEarned = user.lifetimeWtcEarned || 0;
    const lifetimeAds = user.lifetimeAdsWatched || 0;
    const eventCount = lootRows.length + adTimes.length;

    // ── scoring ──
    let score = 0;
    const bad = [];   // red-flag reasons
    const good = [];  // reassuring signs

    // 1) identical tap→claim time (a script sleeps a fixed time; a human + real ad never repeats to 0.5s)
    if (waitSpread !== null && waitSpread <= 0.6) { score += 3; bad.push(`Lootbox tap→claim time ${waits.length}bar prai ekdom ek (${Math.min(...waits)}–${Math.max(...waits)}s) — manush-er pokkhe prai impossible`); }
    // 2) machine-regular gaps
    if (lootGapCV !== null && lootGapCV < 0.2) { score += 3; bad.push(`Lootbox claim-er gap ekdom regular (median ${fmtDur(lootGapMedian)}, variation ${(lootGapCV * 100).toFixed(0)}%) — schedule-e cholche mone hoy`); }
    else if (lootGapCV !== null && lootGapCV > 0.7) good.push(`Lootbox gap ekdom alada alada (variation ${(lootGapCV * 100).toFixed(0)}%) — manush-er moto`);
    // 3) never sleeps
    if (allEvents.length >= 24 && activeHours >= 21) { score += 3; bad.push(`Last 7 din-e ${activeHours}/24 ghonta-i active — ghumay na`); }
    else if (allEvents.length >= 24 && activeHours <= 17) good.push(`Last 7 din-e ${activeHours}/24 ghonta active — ghumanor gap ache`);
    // 4) video cap full every day
    if (maxedDays >= 7) { score += 2; bad.push(`${maxedDays} din dhore video cap (300 WTC) puro tule nichhe`); }
    // 5) botGuard hits
    if ((user.botSuspectCount || 0) > 0) { const p = Math.min(4, user.botSuspectCount * 2); score += p; bad.push(`botGuard ${user.botSuspectCount}bar script-pattern dhorechhe`); }
    // 6) multi-account / shared wallet
    if (user.multiAccountFlag) { score += 2; bad.push(`Multi-account flag (${(user.multiAccountSiblings || []).length} onno account ek device-e)`); }
    if (dupWallet) { score += 3; bad.push(`Ei wallet onno account (${dupWallet}) o use korechhe`); }
    // 7) brand-new account, huge balance
    if (ageDays <= 3 && lifetimeEarned >= 3000) { score += 2; bad.push(`${Math.floor(ageDays)} din-er account-e ${lifetimeEarned.toLocaleString()} WTC earn`); }
    // 8) every ad cap maxed daily
    if (ageDays >= 5 && lifetimeAds / ageDays >= 22) { score += 1; bad.push(`Din-e gor-e ${(lifetimeAds / ageDays).toFixed(0)} ad (cap 25-er kache)`); }
    // reassuring
    if ((user.validReferralCount || 0) >= 2) good.push(`${user.validReferralCount} ta valid referral`);
    if ((user.completedTasks || []).length >= 10) good.push(`${(user.completedTasks || []).length} ta task complete`);
    if (ageDays >= 14 && score <= 2) good.push(`${Math.floor(ageDays)} din-er purano account`);

    let verdict, emoji;
    if (eventCount < 10 && score < 3) { verdict = 'Not enough data yet'; emoji = '⚪'; }
    else if (score >= 6) { verdict = 'Likely script'; emoji = '🔴'; }
    else if (score >= 3) { verdict = 'Suspicious — check manually'; emoji = '🟡'; }
    else { verdict = 'No strong script signs'; emoji = '🟢'; }

    return {
        score, verdict, emoji, bad, good, eventCount,
        stats: {
            lootboxClaims: lootRows.length,
            lootboxWtc: lootRows.reduce((a, r) => a + (r.amount || 0), 0),
            lootboxDays: dayVals.length,
            lootGapMedianSec: lootGapMedian,
            lootGapCV,
            waitSpread,
            activeHours,
            maxedDays,
            ageDays: Math.floor(ageDays),
        },
    };
}

async function findDuplicateWallet(db, userId) {
    try {
        const w = await db.collection('withdrawals').find({ userId }).sort({ createdAt: -1 }).limit(1).toArray();
        const details = w[0]?.details;
        if (!details) return null;
        const other = await db.collection('withdrawals').findOne({ userId: { $ne: userId }, details }, { projection: { userId: 1 } });
        return other?.userId || null;
    } catch { return null; }
}

// ── 1-line version (lookup panel + withdraw request message) ──
export function renderTrustShort(r) {
    return `${r.emoji} <b>${r.verdict}</b> (score ${r.score})`;
}

// ── full report (button "🔍 Fake/Real Report") ──
export function renderTrustFull(user, r) {
    const s = r.stats;
    let t = `🔍 <b>Fake / Real Report</b>\nUser: <code>${user._id}</code>\n\n` +
        `${r.emoji} <b>${r.verdict}</b> — score <b>${r.score}</b>  <i>(6+ = likely script, 3–5 = check, 0–2 = ok)</i>\n\n`;
    t += r.bad.length ? `<b>🚩 Red flags</b>\n${r.bad.map(x => `• ${x}`).join('\n')}\n\n` : `<b>🚩 Red flags:</b> none found\n\n`;
    t += r.good.length ? `<b>✅ Real-user signs</b>\n${r.good.map(x => `• ${x}`).join('\n')}\n\n` : '';
    t += `<b>📊 Numbers (last 30d / this cycle)</b>\n` +
        `• Account age: ${s.ageDays} din\n` +
        `• Lootbox: <b>${s.lootboxClaims}</b> claim · ${s.lootboxWtc.toLocaleString()} WTC · ${s.lootboxDays} alada din\n` +
        `• Lootbox gap median: ${s.lootGapMedianSec ? fmtDur(s.lootGapMedianSec) : '-'}${s.lootGapCV !== null ? ` · variation ${(s.lootGapCV * 100).toFixed(0)}%` : ''}\n` +
        `• Active hours (7d): ${s.activeHours}/24\n` +
        `• Full-cap video days: ${s.maxedDays}\n\n` +
        `<i>⚠️ Eta indicator, proof na. Ekhane 🔴 dekhleo kono ban auto hoy na — tumi decide koro. Withdraw-er por ei cycle-er raw data muche jay (summary withdraw history-te thake).</i>`;
    return t;
}

// ── compact snapshot saved inside the withdrawal doc when it is approved (before the raw logs are cleaned) ──
export function makeCycleSnapshot(user, report) {
    return {
        at: new Date(),
        lifetimeWtcEarned: user.lifetimeWtcEarned || 0,
        lifetimeAdsWatched: user.lifetimeAdsWatched || 0,
        tasks: (user.completedTasks || []).length,
        referrals: user.referralCount || 0,
        lootboxClaims: report.stats.lootboxClaims,
        lootboxWtc: report.stats.lootboxWtc,
        activeHours: report.stats.activeHours,
        botSuspectCount: user.botSuspectCount || 0,
        trustScore: report.score,
        trustVerdict: report.verdict,
        trustFlags: report.bad.slice(0, 3),
    };
}

export { fmtBDDateTime };
