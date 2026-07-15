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

export const FIRST_WITHDRAW_MIN_TASKS = 5; // unchanged

// ⚠️ NEW — minimum amount of WTC a user can convert to USDT in one go.
export const MIN_CONVERT_WTC = 500;

// ⚠️ NEW — address lock: once a user submits a withdrawal with a given
// method+address, that becomes their fixed payout destination for this many
// days. They cannot submit a withdrawal with a DIFFERENT address (or switch
// method) until the lock expires. This needs to be enforced in withdraw.js
// by comparing `Date.now() - user.addressLockedAt` against this value —
// I don't have the current withdraw.js to wire this into, so this constant
// is ready but not yet consumed anywhere. Send withdraw.js to finish this.
export const WITHDRAW_ADDRESS_LOCK_DAYS = 30;

// Every 0.01 (USDT or TON) = 1 ad; rounds up (ceiling) if fractional
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

// ⚠️ NEW — the tiered-withdraw monthlyLimit counters now reset every 6
// months instead of every 1 month (per admin request — "just increase the
// month count"). Returns a key like "2026-H1" (Jan–Jun) or "2026-H2"
// (Jul–Dec), Bangladesh time. Whatever field in withdraw.js currently
// compares against currentMonthBD() for the tier-claim reset should switch
// to comparing against this instead — same pattern, just a 6-month bucket
// instead of a 1-month one.
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
//   - Ad-watch and task-completion requirements are unchanged (same
//     calcAdsRequired() / FIRST_WITHDRAW_MIN_TASKS logic as before, applied
//     to the tier's `usd` value).
// ══════════════════════════════════════════════════════════
export const WITHDRAW_TIERS = [
    { id: 't005', usd: 0.05, monthlyLimit: 5, referralsRequired: 0   },
    { id: 't010', usd: 0.10, monthlyLimit: 2, referralsRequired: 1   },
    { id: 't020', usd: 0.20, monthlyLimit: 3, referralsRequired: 2   },
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
