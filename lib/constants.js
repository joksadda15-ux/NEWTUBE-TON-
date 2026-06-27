// lib/constants.js — SEASON 2 আপডেট
//
// বড় পরিবর্তন: Gold + Diamond দুই-স্তর কারেন্সি বাদ দিয়ে এখন একটাই
// কারেন্সি — WTC coin। সব reward/fee/withdraw সংখ্যা এখানে।

export const CURRENCY = 'WTC';

// ── WTC থেকে আসল টাকায় কনভার্শন রেট ──
export const WTC_PER_USD = 20000;   // 20,000 WTC = 1 USD
export const WTC_PER_TON = 40000;   // 20,000 WTC = 0.5 TON  →  1 TON = 40,000 WTC

// ── ভিডিও দেখে WTC জমা (floating "lootbox" বাটনে, video section-এ) ──
// নোট: এই rate টা আপনি স্পষ্ট করে বলেননি, তাই আমি একটা reasonable সংখ্যা
// বসিয়ে দিলাম (ads reward 10-25 WTC-র সাথে সামঞ্জস্য রেখে)।
// ঠিক না লাগলে শুধু এই একটা লাইন বদলে দিলেই পুরো সিস্টেমে effect পড়বে।
export const VIDEO_WTC_PER_MINUTE = 8;       // প্রতি মিনিট ভিডিও দেখায় ৮ WTC জমা হবে
export const VIDEO_WTC_PER_SECOND = VIDEO_WTC_PER_MINUTE / 60;
export const LOOTBOX_CLAIM_MIN = 200;        // ক্লেইম করার জন্য মিনিমাম জমা থাকতে হবে
export const LOOTBOX_CLAIM_MAX = 2000;       // এক claim-এ সর্বোচ্চ (anti-abuse cap)
export const DAILY_VIDEO_WTC_MAX = 4000;     // দৈনিক ভিডিও থেকে WTC সীমা

// ── Extract ট্যাবের ৪টা আলাদা ad-network বাটন — এখন প্রত্যেকটা সরাসরি WTC দেয় ──
// (lootbox-এ জমা হয় না, এটা শুধু ভিডিও-দেখার জন্য)
export const AD_NETWORK_REWARDS = {
    adsgramDaily:   { reward: 10, dailyLimit: 10 },
    adsgramSpecial: { reward: 25, dailyLimit: 5  },
    monetag:        { reward: 15, dailyLimit: 20 },
    giga:           { reward: 15, dailyLimit: 20 },
};

// ── Withdraw methods (bKash বাদ — নতুন নির্দেশে উল্লেখ ছিল না) ──
export const WITHDRAW_METHODS = {
    binance:   { label: 'Binance UID',       currency: 'USDT', minCurrency: 0.1,  wtcToCurrency: (wtc) => wtc / WTC_PER_USD },
    tonkeeper: { label: 'Tonkeeper Address', currency: 'TON',  minCurrency: 0.03, wtcToCurrency: (wtc) => wtc / WTC_PER_TON },
};

export const WITHDRAW_MIN_WTC = {
    binance:   WITHDRAW_METHODS.binance.minCurrency   * WTC_PER_USD, // = 2000 WTC
    tonkeeper: WITHDRAW_METHODS.tonkeeper.minCurrency * WTC_PER_TON, // = 1200 WTC
};

export const WITHDRAW_FEE_PERCENT = 5; // ৫% fee, withdraw-এর সময় কাটা হবে

export const FIRST_WITHDRAW_MIN_TASKS = 5; // এখনও অপরিবর্তিত

// প্রতি 0.01 (USDT অথবা TON) = ১টা ad, ভগ্নাংশ হলে উপরে রাউন্ড (ceiling)
// উদাহরণ মিলিয়ে যাচাই করা: 0.1 USDT→10, 0.021 TON→3, 0.03 TON→3, 0.031 TON→4 ✓
export function calcAdsRequired(currencyAmount) {
    return Math.max(1, Math.ceil(currencyAmount / 0.01));
}

// ── Referral — এখন ৩ ধাপে দেওয়া হবে (lifetime milestone, একবারই দেওয়া হবে) ──
export const REFERRAL_REWARDS = {
    step1_verified:      30,  // referred user channel+community join করে verify করলে
    step2_tenTasks:      60,  // referred user ১০টা task সম্পন্ন করলে
    step3_twentyAds:     130, // referred user ২০টা ads সম্পন্ন করলে
};
export const REFERRAL_STEP2_TASK_COUNT = 10;
export const REFERRAL_STEP3_AD_COUNT = 20;

// আজকের তারিখ Bangladesh টাইমজোনে
export function todayBD() {
    return new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });
}

export function dailyResetFields() {
    return {
        lastResetDate: todayBD(),
        adsWatchedToday: 0,
        dailyVideoWtcMined: 0,
        tasksCompletedToday: 0,
        adsgramDailyCountToday: 0,
        adsgramSpecialCountToday: 0,
        monetagCountToday: 0,
        gigaCountToday: 0,
    };
}
