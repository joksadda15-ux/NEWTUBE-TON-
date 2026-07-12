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

export const WITHDRAW_FEE_PERCENT = 25; // 25% fee, deducted at withdraw time

export const FIRST_WITHDRAW_MIN_TASKS = 5; // unchanged

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
