// lib/constants.js — SEASON 2 UPDATE (FIXED RATES — live pricing removed)
//
// ⚠️ Per admin's instruction, the live TON price system was removed — it
// would sometimes overpay users in TON when the market price dipped. Now
// it's back to simple, predetermined (fixed) rates — predictable payouts,
// no dependency on an external API.
//
// Dropped the two-tier Gold + Diamond currency — now there's a single
// currency: the WTC coin. All reward/fee/withdraw numbers live here.

export const CURRENCY = 'WTC';

// ── WTC → real-money conversion rate (FIXED) ──
export const WTC_PER_USD = 20000;              // 20,000 WTC = 1 USD
export const WTC_PER_TON = 20000 / 0.6;        // 20,000 WTC = 0.6 TON  →  1 TON ≈ 33,333.33 WTC

// ── WTC earned by watching videos (via the floating "lootbox" button in the video section) ──
export const VIDEO_WTC_PER_MINUTE = 40 / 60;    // 40 WTC/hour
export const VIDEO_WTC_PER_SECOND = VIDEO_WTC_PER_MINUTE / 60;
export const LOOTBOX_CLAIM_MIN = 25;         // minimum accrued amount required to claim
export const LOOTBOX_CLAIM_MAX = 500;        // max credit per network call (to prevent time-spoofing, not a daily cap)

// Daily video-watch time limit: 6 hours/day.
export const DAILY_VIDEO_WATCH_HOURS_MAX = 6;
export const DAILY_VIDEO_WTC_MAX = DAILY_VIDEO_WATCH_HOURS_MAX * 60 * VIDEO_WTC_PER_MINUTE; // = 240 WTC/day

// ── The Extract tab's 4 separate ad-network buttons — each now pays WTC directly ──
export const AD_NETWORK_REWARDS = {
    adsgramDaily:   { reward: 10, dailyLimit: 10 },
    adsgramSpecial: { reward: 20, dailyLimit: 5  },
    monetag:        { reward: 15, dailyLimit: 20 },
    giga:           { reward: 15, dailyLimit: 20 },
};

// ── Withdraw methods ──
// ⚠️ TON withdrawal removed — Tonkeeper is now used only as a wallet ADDRESS
// (users still paste their TON wallet/Tonkeeper address), but the actual
// payout sent to that address is USDT (USDT-on-TON), not native TON coin.
// Both methods now pay out in USDT.
export const WITHDRAW_METHODS = {
    binance:   { label: 'Binance UID',       currency: 'USDT', minCurrency: 0.1, wtcToCurrency: (wtc) => wtc / WTC_PER_USD },
    tonkeeper: { label: 'Tonkeeper Address', currency: 'USDT', minCurrency: 0.1, wtcToCurrency: (wtc) => wtc / WTC_PER_USD },
};

export const WITHDRAW_MIN_WTC = {
    binance:   2500,
    tonkeeper: 2000,
};

// ⚠️ MAJOR CHANGE: the 25% fee is no longer taken at withdraw time. Users
// now must first CONVERT WTC into a USDT balance (api/withdraw.js, POST
// action:'convert') — that conversion step is where this fee is deducted.
// Withdrawals then spend from the already-fee-deducted USDT balance with NO
// additional fee. (If a withdraw-time fee is ever needed again in the
// future, that's a separate decision to revisit later — not now.)
export const WITHDRAW_FEE_PERCENT = 25; // 25% fee, deducted at CONVERT time (WTC → USDT)

// ⚠️ CHANGED (was 5): now a LIFETIME gate checked on EVERY withdraw request,
// not just the first one. In practice this still only "blocks" once — since
// completedTasks never shrinks, once a user crosses 10 lifetime tasks this
// check passes forever after. Kept the name as-is even though "FIRST_" is no
// longer accurate, to avoid a wider rename across withdraw.js — rename later
// if you want the naming cleaned up.
export const FIRST_WITHDRAW_MIN_TASKS = 10;

// ⚠️ NEW — fixed ad-watch requirement per withdraw REQUEST (not per tier,
// not scaled by amount). Must be watched within the current Bangladesh
// calendar day (same day-boundary as every other daily counter in this
// app — see todayBD()/dailyResetFields() below). Replaces the old
// calcAdsRequired(tier.usd) scaling, which made large tiers (e.g. t10 =
// 1000 ads) practically unreachable.
export const WITHDRAW_ADS_REQUIRED = 15;

// ⚠️ NEW — minimum amount of WTC a user can convert to USDT in one go.
export const MIN_CONVERT_WTC = 500;

// ⚠️ NEW — address lock: once a user submits a withdrawal with a given
// method+address, that becomes their fixed payout destination for this many
// days. They cannot submit a withdrawal with a DIFFERENT address (or switch
// method) until the lock expires.
export const WITHDRAW_ADDRESS_LOCK_DAYS = 30;

// ⚠️ LEGACY — no longer used by withdraw.js (see WITHDRAW_ADS_REQUIRED
// above). Left in place in case another file still imports it — deleting it
// blind, without visibility into the whole codebase, risks breaking an
// import elsewhere. Safe to remove once confirmed unused everywhere.
export function calcAdsRequired(currencyAmount) {
    return Math.max(1, Math.ceil(currencyAmount / 0.01));
}

// ── Referral — now given in 3 stages (lifetime milestone, awarded once) ──
export const REFERRAL_REWARDS = {
    step1_verified:      30,  // when the referred user joins channel+community and verifies
    step2_tenTasks:      60,  // when the referred user completes 10 tasks
    // ⚠️ key name kept as-is (still "twentyAds") even though the actual
    // requirement is now 25 — lib/referral.js almost certainly references
    // this exact property name (REFERRAL_REWARDS.step3_twentyAds) and we
    // don't have that file in this conversation to update safely. Renaming
    // the key here without also updating referral.js would silently break
    // this reward (undefined → NaN/0 awarded). Send referral.js if you'd
    // like the key properly renamed too.
    step3_twentyAds:     130, // when the referred user completes 25 ads
};
export const REFERRAL_STEP2_TASK_COUNT = 10;
export const REFERRAL_STEP3_AD_COUNT = 25; // was 20 — increased per admin request

// Today's date in the Bangladesh timezone
export function todayBD() {
    return new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });
}

// Current month key in the Bangladesh timezone (e.g. "07/2026") — kept for
// anything else that still resets monthly. The tiered-withdraw counters
// below no longer use this — see currentHalfYearBD().
export function currentMonthBD() {
    return new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit' });
}

// The tiered-withdraw monthlyLimit counters reset every 6 months (per
// earlier admin decision — CONFIRMED to stay as-is, not changed to 2
// months). Returns a key like "2026-H1" (Jan–Jun) or "2026-H2" (Jul–Dec),
// Bangladesh time.
export function currentHalfYearBD() {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }));
    const year = now.getFullYear();
    const half = now.getMonth() < 6 ? 'H1' : 'H2'; // Jan–Jun vs Jul–Dec
    return `${year}-${half}`;
}

// ══════════════════════════════════════════════════════════
// TIERED WITHDRAW SYSTEM — fixed cash-out amounts instead of a free-text
// WTC field (same UX pattern as most big GPT/PTC sites: tap a $ tier
// instead of typing a number).
//
//   - `usd` is deducted directly from the user's already-converted
//     `usdtBalance` — NOT from wtcBalance, and with NO fee at this step
//     (the 25% fee already happened back at convert time). The user
//     receives exactly `usd` amount, no "net" reduction here.
//   - `monthlyLimit` — how many times THIS tier can be claimed, resets at
//     the start of each 6-month period (Bangladesh time) — see
//     currentHalfYearBD().
//   - `referralsRequired` — a LIFETIME total referral count needed to
//     unlock this tier. This is a threshold check only, not consumed —
//     once a user has enough referrals, the tier stays unlocked forever
//     (referralCount never decreases because of a withdrawal).
//   - Ad-watch (WITHDRAW_ADS_REQUIRED) and task-completion
//     (FIRST_WITHDRAW_MIN_TASKS) requirements are now FIXED and identical
//     across every tier — a $0.05 withdraw and a $10 withdraw both need the
//     same 15 ads (today) + 10 tasks (lifetime). Only referralsRequired and
//     monthlyLimit differ by tier.
// ══════════════════════════════════════════════════════════
export const WITHDRAW_TIERS = [
    { id: 't005', usd: 0.05, monthlyLimit: 5, referralsRequired: 0   },
    { id: 't010', usd: 0.10, monthlyLimit: 5, referralsRequired: 1   }, // monthlyLimit was 2 → 5
    { id: 't020', usd: 0.20, monthlyLimit: 5, referralsRequired: 2   }, // monthlyLimit was 3 → 5
    { id: 't050', usd: 0.50, monthlyLimit: 3, referralsRequired: 5   },
    { id: 't1',   usd: 1,    monthlyLimit: 3, referralsRequired: 10  },
    { id: 't2',   usd: 2,    monthlyLimit: 3, referralsRequired: 15  },
    { id: 't5',   usd: 5,    monthlyLimit: 3, referralsRequired: 20  },
    { id: 't10',  usd: 10,   monthlyLimit: 2, referralsRequired: 30  },
    { id: 't20',  usd: 20,   monthlyLimit: 1, referralsRequired: 50  },
    { id: 't50',  usd: 50,   monthlyLimit: 1, referralsRequired: 100 },
];

export function dailyResetFields() {
    return {
        lastResetDate: todayBD(),
        adsWatchedToday: 0,
        tasksCompletedToday: 0,
        dailyVideoWtcMined: 0,
        adsgramDailyCountToday: 0,
        adsgramSpecialCountToday: 0,
        monetagCountToday: 0,
        gigaCountToday: 0,
        usedVideoStarts: [], // ⚠️ replay-protection: প্রতিদিন claim করা video-session (startTime) গুলোর তালিকা, দিন শেষে খালি হয়
    };
}

// ══════════════════════════════════════════════════════════
// WEEKLY REFERRAL COMPETITION — every user's `weeklyReferralCount` climbs
// as they land referrals this week (see api/user.js handleInit). Reward
// eligibility is a THRESHOLD, not just rank: only users with AT LEAST
// WEEKLY_REFERRAL_MIN_COUNT referrals this week qualify, and of those, only
// the top WEEKLY_REFERRAL_MAX_WINNERS get rewarded. If fewer than
// WEEKLY_REFERRAL_MAX_WINNERS users cross the threshold, fewer people get
// rewarded that week (could be 0) — it's never "top 10 regardless of count".
// The admin resets manually via bot.js's a_weekly → "🔄 Reset week now",
// which snapshots the qualifying winners into a `weeklyReferralReports`
// collection (viewable later via "📜 Weekly Report") BEFORE zeroing
// everyone's weeklyReferralCount for the new week. Rewards themselves are
// sent manually by the admin — nothing here touches wtcBalance
// automatically. Lifetime `referralCount` is a separate field, untouched.
// ══════════════════════════════════════════════════════════
export const WEEKLY_REFERRAL_MIN_COUNT = 10;  // minimum refs THIS WEEK to qualify at all
export const WEEKLY_REFERRAL_MAX_WINNERS = 10; // cap on how many qualifying users get rewarded
