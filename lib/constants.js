// lib/constants.js — SEASON 3 UPDATE (DOGS-only currency, tier system removed)
//
// ⚠️ MAJOR REBUILD (this pass):
//   - The WTC→USD→USDT abstraction is GONE. Currency now converts directly
//     WTC → DOGS at a fixed 3:1 rate (3 WTC = 1 DOGS). No USD is shown or
//     stored anywhere anymore.
//   - The old fixed WITHDRAW_TIERS ($ tap-a-tier) system is REMOVED. Users
//     now type any DOGS amount, as long as it's >= MIN_WITHDRAW_DOGS and a
//     multiple of WITHDRAW_AMOUNT_STEP (must end in "00" — 1000, 1200, 1500
//     are valid; 1001, 1220, 5310 are not).
//   - Binance is LOCKED — kept fully configured below (not deleted) so
//     re-enabling it later is just flipping `locked: false` back. TON
//     wallet address (Tonkeeper) is currently the ONLY working method, and
//     it now pays DOGS.
//   - Withdraw requirements are FLAT, checked on every request (not scaled
//     by tier): FIRST_WITHDRAW_MIN_TASKS tasks (lifetime), WITHDRAW_ADS_REQUIRED
//     ads (today), WITHDRAW_REFERRALS_REQUIRED referral (lifetime).
//   - Withdraw address lock is now WITHDRAW_ADDRESS_LOCK_DAYS = 7 days
//     (was 30). Users previously locked to Binance are auto-unlocked in
//     api/withdraw.js (see getAddressLockStatus) since Binance can no
//     longer be withdrawn to — they can immediately submit a fresh
//     Tonkeeper withdrawal.
//   - Daily withdraw limit: still ONE withdrawal per (Bangladesh) calendar
//     day — unchanged from before, just no longer tier-scoped.

export const CURRENCY = 'DOGS';

// ── WTC → DOGS conversion rate (FIXED) ──
export const WTC_PER_DOGS = 3; // 3 WTC = 1 DOGS

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

// Minimum seconds that must elapse between an `adStart` token being issued
// and `claimAdReward` accepting it — the server-side floor that makes the
// Termux replay-script attack impossible to instant-farm.
export const AD_MIN_WATCH_SECONDS = 5;

// ── Withdraw methods ──
// ⚠️ Binance is LOCKED (closed) — kept fully configured, not deleted, so
// re-enabling it later is just flipping `locked: false` back here, nothing
// else needs to change. Tonkeeper (TON wallet address) is the only method
// currently available, and pays DOGS.
export const WITHDRAW_METHODS = {
    binance:   { label: 'Binance UID',        currency: 'USDT', locked: true,  minCurrency: 0.1 },
    tonkeeper: { label: 'TON Wallet Address',  currency: 'DOGS', locked: false, minCurrency: 1000 },
};

// ── Convert: WTC → DOGS balance, 25% fee taken HERE (not at withdraw time) ──
export const MIN_CONVERT_WTC = 1000;       // ⚠️ CHANGED (was 500)
export const WITHDRAW_FEE_PERCENT = 25;    // unchanged — 25% fee, deducted at CONVERT time (WTC → DOGS)

// ── Withdraw amount rules (replaces the old WITHDRAW_TIERS system) ──
export const MIN_WITHDRAW_DOGS = 1000;      // ⚠️ NEW
export const WITHDRAW_AMOUNT_STEP = 100;    // ⚠️ NEW — amount must be a multiple of 100 (must end in "00": 1000, 1200, 1500 ✓ — 1001, 1220, 5310 ✗)

// ── Flat withdraw requirements, checked on EVERY request (lifetime task +
// referral thresholds, daily ad requirement) — same pattern as before, just
// no longer tier-scaled. ──
export const FIRST_WITHDRAW_MIN_TASKS = 10;   // lifetime tasks completed
export const WITHDRAW_ADS_REQUIRED = 8;       // ads watched TODAY (Bangladesh calendar day)
export const WITHDRAW_REFERRALS_REQUIRED = 1; // ⚠️ NEW — lifetime referrals (threshold, not consumed per withdraw)

// ⚠️ Address lock: once a user submits a withdrawal with a given address,
// that becomes their fixed payout destination for this many days.
export const WITHDRAW_ADDRESS_LOCK_DAYS = 7; // ⚠️ CHANGED (was 30)

// Daily withdraw limit — unchanged: ONE withdrawal per Bangladesh calendar
// day, enforced via `lastWithdrawDate` in api/withdraw.js.

// ── Referral — 3-stage milestone system (unchanged, separate from the
// WITHDRAW_REFERRALS_REQUIRED gate above, which just checks lifetime
// referralCount >= 1) ──
export const REFERRAL_REWARDS = {
    step1_verified:      30,  // when the referred user joins channel+community and verifies
    step2_tenTasks:      60,  // when the referred user completes 10 tasks
    step3_twentyAds:     130, // when the referred user completes 25 ads (key name kept as-is — see lib/referral.js)
};
export const REFERRAL_STEP2_TASK_COUNT = 10;
export const REFERRAL_STEP3_AD_COUNT = 25;

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
        usedVideoStarts: [], // replay-protection: প্রতিদিন claim করা video-session তালিকা, দিন শেষে খালি হয়
        usedAdStarts: [],    // replay-protection: প্রতিদিন claim করা ad-token তালিকা, দিন শেষে খালি হয়
    };
}

// ══════════════════════════════════════════════════════════
// WEEKLY REFERRAL COMPETITION — unchanged from before.
// ══════════════════════════════════════════════════════════
export const WEEKLY_REFERRAL_MIN_COUNT = 10;
export const WEEKLY_REFERRAL_MAX_WINNERS = 10;
