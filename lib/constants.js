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
export const VIDEO_WTC_PER_MINUTE = 1;       // 60 WTC/hour = 1 WTC/minute
export const VIDEO_WTC_PER_SECOND = VIDEO_WTC_PER_MINUTE / 60;
export const LOOTBOX_CLAIM_MIN = 25;         // minimum accrued amount required to claim
export const LOOTBOX_CLAIM_MAX = 500;        // max credit per network call (to prevent time-spoofing, not a daily cap)

// Daily video-watch time limit: 5 hours/day. Beyond that, it's more likely
// an auto-clicker/bot running on a PC than a real mobile user.
export const DAILY_VIDEO_WATCH_HOURS_MAX = 5;
export const DAILY_VIDEO_WTC_MAX = DAILY_VIDEO_WATCH_HOURS_MAX * 60; // = 300 WTC/day

// ── The Extract tab's 4 separate ad-network buttons — each now pays WTC directly ──
export const AD_NETWORK_REWARDS = {
    adsgramDaily:   { reward: 10, dailyLimit: 10 },
    adsgramSpecial: { reward: 25, dailyLimit: 5  },
    monetag:        { reward: 15, dailyLimit: 20 },
    giga:           { reward: 15, dailyLimit: 20 },
};

// ── Withdraw methods (no bKash) — both are fixed-rate now, no live fetch ──
export const WITHDRAW_METHODS = {
    binance:   { label: 'Binance UID',       currency: 'USDT', minCurrency: 0.1,  wtcToCurrency: (wtc) => wtc / WTC_PER_USD },
    tonkeeper: { label: 'Tonkeeper Address', currency: 'TON',  minCurrency: 0.03, wtcToCurrency: (wtc) => wtc / WTC_PER_TON },
};

export const WITHDRAW_MIN_WTC = {
    binance:   2000, // 0.1 USDT × 20,000 WTC/USD
    tonkeeper: 1200, // kept the same as before
};

export const WITHDRAW_FEE_PERCENT = 10; // 10% fee, deducted at withdraw time

export const FIRST_WITHDRAW_MIN_TASKS = 5; // unchanged

// Every 0.01 (USDT or TON) = 1 ad; rounds up (ceiling) if fractional
export function calcAdsRequired(currencyAmount) {
    return Math.max(1, Math.ceil(currencyAmount / 0.01));
}

// ── Referral — now given in 3 stages (lifetime milestone, awarded once) ──
export const REFERRAL_REWARDS = {
    step1_verified:      30,  // when the referred user joins channel+community and verifies
    step2_tenTasks:      60,  // when the referred user completes 10 tasks
    step3_twentyAds:     130, // when the referred user completes 20 ads
};
export const REFERRAL_STEP2_TASK_COUNT = 10;
export const REFERRAL_STEP3_AD_COUNT = 20;

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
