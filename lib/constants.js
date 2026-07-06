// lib/constants.js — SEASON 2 আপডেট + LIVE TON PRICE
//
// বড় পরিবর্তন: Gold + Diamond দুই-স্তর কারেন্সি বাদ দিয়ে এখন একটাই
// কারেন্সি — WTC coin। সব reward/fee/withdraw সংখ্যা এখানে।
//
// ⚠️ TON RATE ফিক্স: আগে WTC→TON একটা স্ট্যাটিক রেট দিয়ে হিসাব হতো
// (ধরে নেওয়া হতো TON = $2), কিন্তু TON-এর দাম রোজ ওঠানামা করে ($1.5–$1.9+)।
// এখন থেকে আসল "backing value" শুধু USD-তে ফিক্সড (20,000 WTC = $1),
// আর withdraw করার মুহূর্তে CoinGecko থেকে TON-এর লাইভ প্রাইস এনে সেই
// USD ভ্যালুকে TON-এ কনভার্ট করা হয়। ফলে বাজারের দাম যাই হোক, আপনার
// real cost (USD-তে) সবসময় স্থির থাকবে।

export const CURRENCY = 'WTC';

// ── WTC থেকে আসল টাকায় কনভার্শন রেট (এটাই একমাত্র ও আসল peg) ──
export const WTC_PER_USD = 20000;   // 20,000 WTC = 1 USD  ← মূল ভ্যালু, এটাই ধরে সব হিসাব হয়

// ── Live TON/USD price (CoinGecko, ফ্রি, key লাগে না) ──
// ৫ মিনিট cache রাখা হয় (একই serverless instance-এ) যাতে বার বার API কল না লাগে।
// Fetch fail করলে (network issue/rate-limit) নিচের fallback প্রাইস ব্যবহার হবে,
// যাতে withdraw কখনো আটকে না যায়। ⚠️ এই fallback সংখ্যাটা মাঝে মাঝে ম্যানুয়ালি
// আপডেট করে রাখবেন (বাজারের কাছাকাছি একটা সংখ্যায়), যাতে fetch fail হলেও
// খুব বেশি ভুল রেট না বসে।
export const FALLBACK_TON_USD_PRICE = 1.75;
const TON_PRICE_CACHE_MS = 5 * 60 * 1000; // ৫ মিনিট
let _tonPriceCache = { price: null, fetchedAt: 0 };

export async function getLiveTonPriceUsd() {
    const now = Date.now();
    if (_tonPriceCache.price && (now - _tonPriceCache.fetchedAt) < TON_PRICE_CACHE_MS) {
        return _tonPriceCache.price;
    }
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(
            'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
            { signal: controller.signal }
        );
        clearTimeout(timeoutId);
        const json = await resp.json();
        const price = json?.['the-open-network']?.usd;
        if (typeof price === 'number' && price > 0) {
            _tonPriceCache = { price, fetchedAt: now };
            return price;
        }
    } catch (err) {
        console.error('getLiveTonPriceUsd: fetch failed, using fallback →', err.message);
    }
    return FALLBACK_TON_USD_PRICE;
}

// ── ভিডিও দেখে WTC জমা (floating "lootbox" বাটনে, video section-এ) ──
export const VIDEO_WTC_PER_MINUTE = 1;       // 60 WTC/ঘণ্টা = ১ WTC/মিনিট
export const VIDEO_WTC_PER_SECOND = VIDEO_WTC_PER_MINUTE / 60;
export const LOOTBOX_CLAIM_MIN = 25;         // ক্লেইম করার জন্য মিনিমাম জমা থাকতে হবে
export const LOOTBOX_CLAIM_MAX = 500;        // এক নেটওয়ার্ক-কলে সর্বোচ্চ credit (সময়-জালিয়াতি ঠেকানোর জন্য, daily cap নয়)

// দৈনিক ভিডিও-দেখার সময়সীমা: ৫ ঘণ্টা/দিন। এর বেশি দেখলে রিয়েল মোবাইল ইউজার না হয়ে
// PC-তে auto-clicker/bot চলার সম্ভাবনা থাকে।
export const DAILY_VIDEO_WATCH_HOURS_MAX = 5;
export const DAILY_VIDEO_WTC_MAX = DAILY_VIDEO_WATCH_HOURS_MAX * 60; // = 300 WTC/day

// ── Extract ট্যাবের ৪টা আলাদা ad-network বাটন — এখন প্রত্যেকটা সরাসরি WTC দেয় ──
export const AD_NETWORK_REWARDS = {
    adsgramDaily:   { reward: 10, dailyLimit: 10 },
    adsgramSpecial: { reward: 25, dailyLimit: 5  },
    monetag:        { reward: 15, dailyLimit: 20 },
    giga:           { reward: 15, dailyLimit: 20 },
};

// ── Withdraw methods (bKash নেই) ──
// wtcToCurrency(wtc, tonPriceUsd?) — tonkeeper-এর জন্য লাইভ TON প্রাইস পাঠাতে হবে,
// binance/USDT-এর জন্য দরকার নেই (USDT নিজেই ~$1 পেগড, স্থিতিশীল)।
export const WITHDRAW_METHODS = {
    binance:   {
        label: 'Binance UID', currency: 'USDT', minCurrency: 0.1,
        wtcToCurrency: (wtc) => wtc / WTC_PER_USD,
    },
    tonkeeper: {
        label: 'Tonkeeper Address', currency: 'TON', minCurrency: 0.03,
        wtcToCurrency: (wtc, tonPriceUsd) => (wtc / WTC_PER_USD) / tonPriceUsd,
    },
};

// ⚠️ মিনিমাম WTC এখন সরাসরি ফিক্সড রাখা হয়েছে (USD peg থেকে) — TON-এর দৈনিক
// দামের ওঠানামার সাথে মিনিমাম এলিজিবিলিটি বদলাবে না, শুধু আসল পাঠানো TON-এর
// পরিমাণ বদলাবে।
export const WITHDRAW_MIN_WTC = {
    binance:   2000, // 0.1 USDT × 20,000 WTC/USD
    tonkeeper: 1200, // আগের মতোই রাখা হয়েছে (আনুমানিক $0.06 সমমূল্য)
};

export const WITHDRAW_FEE_PERCENT = 5; // ৫% fee, withdraw-এর সময় কাটা হবে

export const FIRST_WITHDRAW_MIN_TASKS = 5; // এখনও অপরিবর্তিত

// প্রতি 0.01 (USDT অথবা TON) = ১টা ad, ভগ্নাংশ হলে উপরে রাউন্ড (ceiling)
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
        tasksCompletedToday: 0,
        dailyVideoWtcMined: 0,
        adsgramDailyCountToday: 0,
        adsgramSpecialCountToday: 0,
        monetagCountToday: 0,
        gigaCountToday: 0,
    };
}
