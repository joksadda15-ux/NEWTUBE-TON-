// lib/botGuard.js — ⚠️ NEW (update) — anti-script / Termux detection for ad claims.
//
// A real person watching ads is irregular: the ad takes a variable time to
// load, they look at it, tap the close button, then tap the next "Watch" a few
// seconds later. A script (Termux, curl loop, hacked client) calls
// adStart → waits the minimum → claimReward → immediately adStart again, with
// near-identical timing every cycle. We keep the last few claims per user
// (user.recentAdClaims: [{ s: adStartMs, c: claimMs, w: watchSeconds }]) and
// flag the account when the pattern looks mechanical:
//
//   Rule A  "no gap, super fast": N claims in a row where each ad was watched
//           for <= AD_BOT_MAX_WATCH_SECONDS AND the next ad was started
//           <= AD_BOT_MAX_IDLE_SECONDS after the previous claim.
//   Rule B  "metronome": the time between consecutive claims is almost the
//           same every time (spread <= AD_BOT_CYCLE_SPREAD_SECONDS) over N claims.
//   Rule C  "identical watch time": watch durations of N claims differ by
//           <= AD_BOT_WATCH_SPREAD_SECONDS (a real ad SDK never loads that evenly).
//
// On a hit: the account is locked (accountLocked + reason 'bot_pattern' — no
// withdraw, no more ad rewards), the claim that triggered it is rejected, and
// the admin gets an alert with the evidence. Admin can unlock / ban from the
// user panel in the bot. All thresholds are tunable below.

export const AD_BOT_SAMPLE_SIZE = 5;            // consecutive claims examined for A and C
export const AD_BOT_MAX_WATCH_SECONDS = 7;      // Rule A — "watched" this briefly or less
export const AD_BOT_MAX_IDLE_SECONDS = 1;       // Rule A — next ad started within this after the last claim
export const AD_BOT_METRONOME_SAMPLES = 8;      // Rule B window
export const AD_BOT_CYCLE_SPREAD_SECONDS = 1;   // Rule B — max (longest − shortest) cycle
export const AD_BOT_CYCLE_MAX_SECONDS = 40;     // Rule B — only meaningful for back-to-back ads
export const AD_BOT_WATCH_SPREAD_SECONDS = 0.3;   // Rule C — max (longest − shortest) watch time

export const AD_CLAIM_HISTORY_KEEP = 8;

// samples: oldest → newest, INCLUDING the claim being evaluated.
export function detectBotPattern(samples) {
    const n = samples.length;
    // Rule A
    if (n >= AD_BOT_SAMPLE_SIZE) {
        const last = samples.slice(-AD_BOT_SAMPLE_SIZE);
        const fastNoGap = last.every((x, i) =>
            x.w <= AD_BOT_MAX_WATCH_SECONDS &&
            (i === 0 || (x.s - last[i - 1].c) / 1000 <= AD_BOT_MAX_IDLE_SECONDS));
        if (fastNoGap) return { rule: 'A', detail: `${AD_BOT_SAMPLE_SIZE} ads in a row watched ≤${AD_BOT_MAX_WATCH_SECONDS}s each with ≤${AD_BOT_MAX_IDLE_SECONDS}s gap between them` };
        // Rule C
        const ws = last.map(x => x.w);
        if (Math.max(...ws) - Math.min(...ws) <= AD_BOT_WATCH_SPREAD_SECONDS) {
            return { rule: 'C', detail: `${AD_BOT_SAMPLE_SIZE} ads with near-identical watch time (${Math.min(...ws).toFixed(1)}–${Math.max(...ws).toFixed(1)}s)` };
        }
    }
    // Rule B
    if (n >= AD_BOT_METRONOME_SAMPLES) {
        const last = samples.slice(-AD_BOT_METRONOME_SAMPLES);
        const cycles = last.slice(1).map((x, i) => (x.c - last[i].c) / 1000);
        if (Math.max(...cycles) <= AD_BOT_CYCLE_MAX_SECONDS && Math.max(...cycles) - Math.min(...cycles) <= AD_BOT_CYCLE_SPREAD_SECONDS) {
            return { rule: 'B', detail: `${AD_BOT_METRONOME_SAMPLES} ads with a metronome-like cycle (${Math.min(...cycles).toFixed(1)}–${Math.max(...cycles).toFixed(1)}s apart)` };
        }
    }
    return null;
}

// Locks the account and alerts the admin. Idempotent (only the first call per
// account alerts). `tgSend` is passed in to avoid a circular import.
// ⚠️ CHANGED — the alert now carries evidence (account age, earnings, withdrawals,
// flags, recent ad timings, a script-likelihood hint) plus inline buttons:
// 🔓 Unlock · 👤 User Profile (lookup_<id>) · 🚫 Ban — so the admin can decide in one tap.
export async function lockForBotPattern(db, userId, hit, tgSend, extra = '') {
    const res = await db.collection('users').findOneAndUpdate(
        { _id: userId, accountLocked: { $ne: true } },
        { $set: { accountLocked: true, accountLockedAt: new Date(), accountLockedReason: 'bot_pattern', botFlaggedAt: new Date() } }
    );
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (res && adminId) {
        let evidence = '';
        try {
            const u = res; // document as it was just before locking
            const ageDays = u.createdAt ? Math.floor((Date.now() - new Date(u.createdAt).getTime()) / 86400000) : 0;
            const wCount = u.withdrawalCount || 0;
            const claims = (u.recentAdClaims || []).slice(-6);
            const watch = claims.map(x => `${x.w}s`).join(', ') || '—';
            const gaps = claims.slice(1).map((x, i) => `${Math.max(0, (x.s - claims[i].c) / 1000).toFixed(1)}s`).join(', ') || '—';
            // simple hint — NOT a verdict, just helps the admin triage quickly
            let scriptSignals = 0, realSignals = 0;
            if (hit.rule === 'A') scriptSignals += 2;                     // ≤1s between ads is very hard for a human
            if (u.multiAccountFlag) scriptSignals += 1;
            if (ageDays < 1) scriptSignals += 1;
            if (wCount === 0 && (u.lifetimeAdsWatched || 0) > 80 && ageDays < 3) scriptSignals += 1;
            if (ageDays >= 7) realSignals += 1;
            if (wCount > 0) realSignals += 1;
            if ((u.validReferralCount || 0) > 0) realSignals += 1;
            if (hit.rule === 'B' || hit.rule === 'C') realSignals += 1;  // timing-only rules have the most false positives
            const hint = scriptSignals >= 3 && scriptSignals > realSignals ? '🔴 Likely script'
                       : realSignals >= 3 && realSignals > scriptSignals ? '🟢 Likely real user'
                       : '🟡 Unclear — check profile';
            evidence =
                `\n<b>Evidence</b>\n` +
                `Name: ${u.firstName || '—'} (@${u.telegramUsername || 'none'})\n` +
                `Account age: ${ageDays}d · Balance: ${u.wtcBalance || 0} WTC · Lifetime: ${u.lifetimeWtcEarned || 0} WTC\n` +
                `Withdrawals: ${wCount} · Valid referrals: ${u.validReferralCount || 0} · Ads lifetime: ${u.lifetimeAdsWatched || 0} (today ${u.adsWatchedToday || 0})\n` +
                `Multi-account flag: ${u.multiAccountFlag ? 'YES 🚩' : 'No'}\n` +
                `Last watch times: ${watch}\n` +
                `Gaps between ads: ${gaps}\n` +
                `Hint: <b>${hint}</b> (script ${scriptSignals} / real ${realSignals})\n`;
        } catch { /* evidence is best-effort — never block the alert */ }
        tgSend(adminId,
            `🤖 <b>Bot / script pattern detected (ads)</b>\n\n` +
            `User: <code>${userId}</code>\nRule ${hit.rule}: ${hit.detail}\n${extra}\n` +
            evidence +
            `\nThe account is now 🔒 locked (no withdraw, no ad rewards).`,
            { reply_markup: { inline_keyboard: [
                [{ text: '🔓 Unlock', callback_data: `unlock_${userId}` }, { text: '👤 User Profile', callback_data: `lookup_${userId}` }],
                [{ text: '🚫 Ban User', callback_data: `ban_${userId}` }],
            ] } }
        ).catch(() => {});
    }
    return !!res;
}

// ════════════════════════════════════════════════════════════════════
// VIDEO SECTION rules (api/earn.js handleVideoClaim / handleClaimLootbox)
// ════════════════════════════════════════════════════════════════════
// Video WTC is earned by real watch time: 1 session token = [startTime, claimTime].
// A real client opens ONE session at a time (a fresh token right after each claim),
// so session windows never overlap. A script that mints many tokens and claims
// them together earns more than real time allows → overlapping windows.
//
//   Rule V1  "overlapping sessions": in the last VIDEO_BOT_SAMPLE_SIZE claims, at
//            least VIDEO_BOT_OVERLAP_HITS sessions started BEFORE the previous
//            one was claimed (by more than VIDEO_BOT_OVERLAP_TOLERANCE_SECONDS).
//   Rule V2  "claimed more than real time": total credited seconds in the last
//            VIDEO_BOT_SAMPLE_SIZE claims exceed the wall-clock span they cover.
//   Lootbox claims (the ad-gated "Claim me!" button) reuse the ad rules A/B/C
//   above, since each one is a real ad watch.
export const VIDEO_BOT_SAMPLE_SIZE = 5;
export const VIDEO_BOT_OVERLAP_HITS = 3;
export const VIDEO_BOT_OVERLAP_TOLERANCE_SECONDS = 5;
export const VIDEO_CLAIM_HISTORY_KEEP = 8;

// samples: oldest → newest { s: sessionStartMs, c: claimMs, a: secondsCredited }
export function detectVideoBotPattern(samples) {
    if (samples.length < VIDEO_BOT_SAMPLE_SIZE) return null;
    const last = samples.slice(-VIDEO_BOT_SAMPLE_SIZE);
    let overlaps = 0;
    for (let i = 1; i < last.length; i++) {
        if ((last[i - 1].c - last[i].s) / 1000 > VIDEO_BOT_OVERLAP_TOLERANCE_SECONDS) overlaps++;
    }
    if (overlaps >= VIDEO_BOT_OVERLAP_HITS) {
        return { rule: 'V1', detail: `${overlaps} of the last ${VIDEO_BOT_SAMPLE_SIZE - 1} video sessions overlapped in time (several sessions claimed for the same minutes)` };
    }
    const span = (last[last.length - 1].c - last[0].s) / 1000;
    const credited = last.reduce((t, x) => t + x.a, 0);
    if (credited > span + 10) {
        return { rule: 'V2', detail: `${Math.round(credited)}s of video credited in only ${Math.round(span)}s of real time (last ${VIDEO_BOT_SAMPLE_SIZE} claims)` };
    }
    return null;
                }
