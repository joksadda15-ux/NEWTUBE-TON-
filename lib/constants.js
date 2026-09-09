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
export const WTC_PER_USD = 25000;              // ⚠️ CHANGED — was 20,000. 25,000 WTC = 1 USD now.
export const WTC_PER_TON = WTC_PER_USD / 0.6;  // ⚠️ was hardcoded to 20000/0.6 (stale after WTC_PER_USD changed) — not currently imported/used anywhere (native TON payout was removed earlier), fixed for consistency in case it's ever wired back in

// ── WTC earned by watching videos (via the floating "lootbox" button in the video section) ──
// ⚠️ CHANGED — was 60/60 (60 WTC/hour). Now 50 WTC/hour per admin request.
export const VIDEO_WTC_PER_MINUTE = 50 / 60;    // 50 WTC/hour
export const VIDEO_WTC_PER_SECOND = VIDEO_WTC_PER_MINUTE / 60;
export const LOOTBOX_CLAIM_MIN = 25;         // minimum accrued amount required to claim
export const LOOTBOX_CLAIM_MAX = 500;        // max credit per network call (to prevent time-spoofing, not a daily cap)

// Daily video-watch time limit. ⚠️ CHANGED — was 6 hours/day, now 5 hours/day per admin request.
export const DAILY_VIDEO_WATCH_HOURS_MAX = 5;
export const DAILY_VIDEO_WTC_MAX = DAILY_VIDEO_WATCH_HOURS_MAX * 60 * VIDEO_WTC_PER_MINUTE; // = 250 WTC/day (auto-follows VIDEO_WTC_PER_MINUTE above)

// ── The Extract tab's ad-network buttons — each pays WTC directly ──
// ⚠️ CHANGED — adsgramSpecial re-added (was removed entirely per an earlier
// admin request; now back per a newer request). Different block ID this
// time (27566, daily limit 10) than the old one that was removed. "usl"
// (USL Ads / TowerAds SDK) is live — credentials and the loadAndShow()
// integration live in index.html's showUslAd() / getTowerAdsInstance().
// See api/earn.js's handleAdStart/handleClaimAdReward, which check
// `enabled !== false` before allowing adStart/claimAdReward — kept in
// place so any network can be paused instantly by flipping its `enabled`
// flag here, without a code deploy.
// ⚠️ CHANGED — monetag reward 15 → 10 WTC (per admin request — Monetag's
// CPM runs low compared to the other networks, so the payout no longer
// matched what it was actually worth).
// ⚠️ CHANGED (admin decision) — reverted the previous anti-farming reward
// cut now that the REAL defense is the time-gate (signed token +
// AD_MIN_WATCH_SECONDS + AD_COOLDOWN_SECONDS below) rather than making the
// payout small. Since every claim already costs at least ~25s of real
// wall-clock time no matter the reward size, raising the reward back up
// (and slightly past the old values on most networks) doesn't help a
// farming script go any faster — it just makes the app more rewarding for
// genuine users. Per-network admin-specified values (each shown as
// "original value + increase" for traceability): adsgramDaily 10+5=15,
// adsgramSpecial 20+5=25, monetag 10+2=12, usl 15+5=20; giga and
// monetagPopup revert to their original values with no extra increase.
export const AD_NETWORK_REWARDS = {
    adsgramDaily:   { reward: 15, dailyLimit: 10 },
    adsgramSpecial: { reward: 25, dailyLimit: 10 },
    monetag:        { reward: 12, dailyLimit: 10 },
    giga:           { reward: 15, dailyLimit: 15 },
    usl:            { reward: 20, dailyLimit: 10 }, // ⚠️ CHANGED — now enabled (TowerAds SDK wired in)
    // ⚠️ NEW — Monetag's separate "Rewarded Popup" format (show_9442539('pop')
    // — different call shape from the plain show_9442539() used by
    // `monetag` above). Placed where the old TADS banner used to be
    // (Home + Video tabs) as a small optional "watch a bonus ad" button —
    // reuses the SAME adStart/claimAdReward token flow as every other
    // network here (see api/earn.js), unlike TADS which couldn't use it.
    monetagPopup:   { reward: 8, dailyLimit: 5 },
    // ⚠️ REMOVED — tads (tads.me) network deleted entirely per admin request
    // ("kono kajei ashe na" — not useful at all). Was widget #11933, TGB
    // format, added 2 updates ago. All of it removed: script tag, init
    // functions, containers in Home/Video tabs, claimTadsClick handler.
};

// ⚠️ FIX — this export was MISSING, which is exactly why every /api/earn
// action (all 4 ad networks + video + tasks + promo, not just ads) was
// throwing a 500 today: api/earn.js imports this by name, and a missing
// named export fails the entire module's load, not just the one feature
// that uses it.
//
// Minimum seconds that must elapse between an `adStart` token being issued
// and `claimAdReward` accepting it — the server-side floor that makes the
// Termux replay-script attack impossible to instant-farm (it can still
// technically call claimAdReward after waiting this long with no ad
// actually watched, since this alone isn't full S2S ad-network
// verification — but it removes the "drain the daily limit in under a
// second" exploit, and rate-limits any adapted script to real wall-clock
// time). Adjust this number to match how long your ad networks' units
// actually run for — it should be at or just under the ad's real duration,
// not arbitrary.
// ⚠️ CHANGED — was 4s, which was arbitrary (see the note directly above
// this constant, admitting as much) and far shorter than any real
// Adsgram/Monetag/Giga rewarded-video unit (those run 15-30s). At 4s a
// farming script only had to sleep(4) before claiming — no ad SDK ever had
// to load or render anything. Raised to 15s, a conservative floor just
// under the shortest real rewarded-ad duration across these networks — a
// genuine viewer is never blocked by this since the ad SDK itself already
// keeps them on the ad for at least that long. If any one network's actual
// configured unit runs shorter than 15s, lower ONLY that network's check
// (would need splitting this into a per-network map) rather than the
// shared floor, so the other networks don't get weakened by it.
export const AD_MIN_WATCH_SECONDS = 15;

// ⚠️ FIX — this was defined but never actually imported/used anywhere, so
// the "20-second gap between ads" it describes was NOT being enforced at
// all — pure dead code, a script could adStart→claimAdReward back-to-back
// with zero pacing. Now wired into handleClaimAdReward (see api/earn.js).
// ⚠️ CHANGED (admin decision) — lowered from 20s to 10s. NOTE: this was
// briefly paired with a temporary reward cut ("make each cycle worthless"
// instead of "make each cycle slow") — that reward cut has since been
// REVERTED per a later admin decision (rewards are back up, see
// AD_NETWORK_REWARDS above) once it was clear the real defense here is the
// time-gate itself (signed token + AD_MIN_WATCH_SECONDS + this cooldown),
// not the payout size. A script still can't complete an ad cycle faster
// than AD_MIN_WATCH_SECONDS + this cooldown regardless of what the reward
// is, so the two are no longer linked — reward size can move independently
// of this value going forward.
export const AD_COOLDOWN_SECONDS = 10;

// ⚠️ NEW — minimum real time a user must hold a task open before claiming
// it (daily/exclusive/partner/earning categories — 'channel' tasks skip this
// entirely since Telegram membership is independently verified). Kept
// slightly under the frontend's claim-button countdown so a genuine user
// is never blocked by their own honest usage; a script that skips straight
// from taskStart to taskComplete with no real wait gets rejected. See
// handleTaskStart/handleTaskComplete in api/earn.js.
// ⚠️ CHANGED — was 8 (paired with a 10s frontend countdown). Frontend
// countdown is now 5s (per admin request), so this had to come down too —
// left as-is it would have been LONGER than the countdown itself, meaning
// every honest user who claimed right at 5s would get rejected server-side.
export const TASK_MIN_WAIT_SECONDS = 4;

// ⚠️ NEW — cooldown between ANY two non-channel task completions by the same
// user, regardless of which task. TASK_MIN_WAIT_SECONDS above only limits how
// fast a SINGLE task can be claimed after it's started — it does nothing to
// stop a script from finishing task #1, then instantly taskStart→claim on
// task #2, #3, #4... in a chain, draining every open task in well under a
// minute. This mirrors AD_COOLDOWN_SECONDS (which already does exactly this
// for ad claims) but was missing here entirely. Deliberately NOT touching
// TASK_MIN_WAIT_SECONDS or the frontend's 5s countdown — those were a
// considered admin UX decision; this is a separate, additive gate that
// doesn't change how fast a real user's first task feels, only how fast
// they could chain many.
// ⚠️ CHANGED — was 15s (admin feedback: real users doing several tasks in a
// row would feel this as friction and drop off). Lowered to 8s — still long
// enough that a script can't drain a stack of tasks in the same handful of
// seconds it takes to be worth automating, but short enough that nobody
// genuinely browsing tasks back-to-back gets stopped waiting on it. This
// gate ONLY applies to non-channel tasks (see taskStartKey in
// handleTaskComplete, api/earn.js) — 'channel'/api-verified tasks (Telegram
// membership check) are never subject to this cooldown at all, exactly as
// requested: verification-based tasks stay instant, only the un-verifiable
// link/article/faucet-style tasks get this pacing.
export const TASK_COOLDOWN_SECONDS = 8;

// ── Withdraw methods ──
// ⚠️ TON withdrawal removed — Tonkeeper is now used only as a wallet ADDRESS
// (users still paste their TON wallet/Tonkeeper address), but the actual
// payout sent to that address is USDT (USDT-on-TON), not native TON coin.
// Both methods now pay out in USDT.
export const WITHDRAW_METHODS = {
    binance:   { label: 'Binance UID',       currency: 'USDT', minCurrency: 0.1, wtcToCurrency: (wtc) => wtc / WTC_PER_USD },
    tonkeeper: { label: 'Tonkeeper Address', currency: 'USDT', minCurrency: 0.1, wtcToCurrency: (wtc) => wtc / WTC_PER_USD },
};

// ══════════════════════════════════════════════════════════
// ⚠️ SEASON 4 — WITHDRAW SIMPLIFIED. The old convert-first + tiered-box +
// level-ladder system is gone. Now it's ONE step: a user types a WTC
// amount (minimum MIN_WITHDRAW_WTC) and submits directly — no separate
// "Convert" screen, no tier grid, no hidden level gate, no address lock.
//
// TWO fees apply, back-to-back, on that single submit:
//   1) WITHDRAW_FEE_PERCENT (25%) — this is the SAME rate the old
//      "convert" step used to take. Kept exactly as-is per admin's
//      instruction, just applied at the (now single) withdraw step
//      instead of a separate convert step.
//   2) WITHDRAW_SECOND_FEE_PERCENT (5%) — NEW, taken on what's left
//      after the 25% above.
// So a user nets wtc/WTC_PER_USD * 0.75 * 0.95 ≈ 71.25% of face value.
// See api/withdraw.js calcNetUsd().
// ══════════════════════════════════════════════════════════
export const MIN_WITHDRAW_WTC = 1500; // ⚠️ CHANGED — was 1000, raised to 1500 to reduce the volume of small withdraw requests admin has to review

// ⚠️ NEW — the very first withdrawal is free (no valid referral required —
// see isFirstWithdraw in api/withdraw.js), but that used to have NO ceiling
// on the amount, meaning a fresh/farmed account could take an unlimited
// first withdrawal with zero referral cost. Now capped at $0.15 USD
// equivalent (gross, before fees) — big enough to be a real first payout,
// small enough that it isn't worth farming fresh accounts just to abuse it.
export const FIRST_WITHDRAW_MAX_USD = 0.15;
export const FIRST_WITHDRAW_MAX_WTC = Math.floor(FIRST_WITHDRAW_MAX_USD * WTC_PER_USD); // = 3,750 WTC at the current 25,000 WTC/USD rate

export const WITHDRAW_FEE_PERCENT = 25;        // unchanged rate, moved from convert-step to withdraw-step
export const WITHDRAW_SECOND_FEE_PERCENT = 5;  // ⚠️ NEW — additional flat fee taken at withdraw time

// ⚠️ CHANGED — WITHDRAW_TASKS_REQUIRED is now a LIFETIME, one-time gate, not
// a daily one. It's checked against completedTasks.length (the lifetime
// array, never reset) instead of tasksCompletedToday (which resets daily).
// Once a user has completed 8 tasks EVER, this gate is permanently satisfied
// — they never have to redo it on later withdrawals. See api/withdraw.js.
export const WITHDRAW_TASKS_REQUIRED = 8;

// ⚠️ CHANGED — was 10, now 8. This one STAYS a daily gate — checked against
// adsWatchedToday, which resets at Bangladesh midnight (see
// todayBD()/dailyResetFields() below) — the "within 24 hours" window admin
// asked for.
export const WITHDRAW_ADS_REQUIRED = 8;

// ⚠️ NEW — anti-farming account-age gate. A user must have existed (user.createdAt)
// for at least this many hours before their FIRST withdrawal is allowed. Farmed
// accounts (fresh Telegram login → single script run → instant withdraw, often
// within minutes) are blocked by this regardless of how fast they satisfy the
// ads/tasks/referral gates above. Deliberately checked ONLY on the first
// withdrawal (see isFirstWithdraw in api/withdraw.js) — once an account has
// survived one real withdrawal cycle it's already past the highest-value point
// for a farmer to abandon it, so later withdrawals aren't re-gated by this.
export const WITHDRAW_MIN_ACCOUNT_AGE_HOURS = 72;

// ⚠️ NEW — referral gate: the very first withdrawal a user ever makes is
// free (no referral needed). Every withdrawal AFTER that consumes exactly
// one "valid" referral (see lib/referral.js — a referral becomes valid once
// the referred user completes all 3 referral milestones). Enforced in
// api/withdraw.js against user.validReferralCount - user.usedValidReferrals.
export const WITHDRAW_VALID_REFERRALS_PER_WITHDRAW = 1;

// ⚠️ REMOVED (Season 4) — address lock. Per admin's instruction, a
// withdraw address is never locked. Left the constant name out of the file
// entirely rather than a disabled flag, since nothing should reference it
// anymore — if address locking is ever wanted again later, it needs to be
// reintroduced deliberately, not silently reactivated by a stray import.

// ── Referral — given in 4 stages (lifetime milestone, awarded once) ──
// ⚠️ CHANGED per admin request — step2 60→100, step3 130→180. Note: the
// admin's message quoted a "300 WTC total" figure, but the three numbers
// given (30 + 100 + 180) actually sum to 310, not 300 — flagged separately,
// implemented here exactly as the per-step numbers specify.
// ⚠️ NEW (this update) — step4_firstLootbox: 90 WTC to the REFERRER the
// first time their referred user claims a lootbox from the Video section
// (see handleClaimLootbox in api/earn.js, and referralStep4Done /
// maybeAwardReferralMilestones in lib/referral.js). Brings the total per
// friend from 310 to 400. Also shown to users alongside its USDT
// equivalent in the Refer tab (index.html renderReferTab) so they can see
// what the bonus is actually worth.
export const REFERRAL_REWARDS = {
    step1_verified:      30,  // when the referred user joins channel+community and verifies
    step2_tenTasks:      100, // when the referred user completes 10 tasks
    step3_twentyAds:     180, // when the referred user completes 20 ads (key name kept as-is)
    step4_firstLootbox:  90,  // when the referred user claims their first Video-section lootbox
};
export const REFERRAL_STEP2_TASK_COUNT = 5; // ⚠️ CHANGED — was 10, lowered to make "valid referral" easier to reach
export const REFERRAL_STEP3_AD_COUNT = 20; // ⚠️ CHANGED — was 25, back to 20 per admin request

// ⚠️ REMOVED (this update) — a daily circuit-breaker on referral-milestone
// payouts (REFERRAL_DAILY_MILESTONE_CAP = 15/day/referrer) lived here
// briefly. Taken back out on request — it caught legitimate high-activity
// referral days too, not just abuse. The velocity lock below is the anti-
// abuse mechanism that's actually kept.

// ⚠️ NEW — referral SIGNUP velocity lock. This is a much earlier tripwire
// than the milestone cap above — it fires at the moment of SIGNUP
// attribution (before any milestone, any reward), based on a simple truth:
// no real promotion — not even a big channel post — delivers signups this
// fast. People have to see the message, tap the link, open Telegram, and
// go through onboarding; that takes minutes to hours to spread, even
// virally. REFERRAL_VELOCITY_THRESHOLD+ signups under one referrer within
// REFERRAL_VELOCITY_WINDOW_MS is not organic growth, full stop — auto-lock
// first, let the admin review and decide (unlock or ban) after the fact.
export const REFERRAL_VELOCITY_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
export const REFERRAL_VELOCITY_THRESHOLD = 20;             // 20+ signups inside that window

// ⚠️ NEW — raw-IP signup velocity lock. This is the direct fix for the
// "90 fresh accounts in 3 minutes, one-click script, instant withdraw"
// pattern: the device-fingerprint gate in lib/ipRegistry.js only stops a
// SECOND account on the same device, but a script isn't a real browser —
// it can send a different fake fingerprint string on every request and
// that gate never even sees a repeat. What it CANNOT easily fake is the
// actual TCP/HTTP client IP hitting our server. Even under Bangladeshi
// carrier CGNAT where many unrelated phones share one public IP, no
// organic mix of real people happens to register in a tight burst like
// this — that's a farm script looping, full stop.
// Deliberately keyed on raw IP (not the fingerprint-or-IP `registryKey`
// used for the one-account-per-device gate) — this is a SEPARATE signal:
// device gate = "not the same phone as an existing account", this =
// "too many brand-new accounts appearing from one network path too fast".
// Threshold set well above plausible shared-IP coincidence (a cyber-café
// or office NAT seeing 2-3 signups in a burst is normal; 6+ in under 3
// minutes is not) — tune IP_SIGNUP_VELOCITY_THRESHOLD up if a genuine
// shared-IP false positive shows up in admin review.
export const IP_SIGNUP_VELOCITY_WINDOW_MS = 3 * 60 * 1000; // 3 minutes
export const IP_SIGNUP_VELOCITY_THRESHOLD = 6;              // 6+ new accounts from one IP inside that window

// ⚠️ NEW — withdrawal referral commission. Every time a user withdraws, if
// they were referred by someone, the referrer is credited this % of the
// WITHDRAWN WTC AMOUNT (gross, before withdraw fees) directly to their own
// wtcBalance — e.g. a 1,000 WTC withdrawal pays the referrer 100 WTC. This
// is NOT a one-time reward — it fires on every withdrawal, indefinitely, for
// as long as the referral relationship exists. See api/withdraw.js.
export const WITHDRAW_REFERRAL_COMMISSION_PERCENT = 10;

// ══════════════════════════════════════════════════════════
// ⚠️ NEW — "PUNCH KEY": buy a valid-referral credit directly with TON,
// instead of waiting for an organic referral to finish all 3 milestones
// (see lib/referral.js). Fixed price in TON (not USD-pegged) — 0.02 TON is
// well under the $0.15 free first-withdraw already given away for free
// (FIRST_WITHDRAW_MAX_USD above), so this can never lose money even at a
// bad TON/USD exchange rate.
//
// Payment is verified fully on-chain by api/payments.js (cron=checkDeposits)
// (polls TonCenter — see that file's header for why an EXTERNAL cron is
// used instead of Vercel's own). See api/payments.js (resource:'punchkey') for order create/
// status/cancel, and models/schema.js for the `punchKeyOrders` collection.
export const PUNCH_KEY_PRICE_NANOTON = 20_000_000; // 0.02 TON = 20,000,000 nanoTON
export const PUNCH_KEY_PRICE_TON = PUNCH_KEY_PRICE_NANOTON / 1_000_000_000; // 0.02 — display convenience
export const PUNCH_KEY_ORDER_EXPIRY_MINUTES = 15; // unpaid orders auto-expire this many minutes after creation
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
// ⚠️ NEW — USER-CREATED TASKS ("Create Task" button, Task tab). A user pays
// TON to publish their OWN task — either a channel/group join (API-
// verified via the bot's own membership check, same mechanism as any other
// verifyType:'api' task) or a link to anything else (another bot, a
// website — verifyType:'link', manual claim-after-wait like every other
// non-API task). It's inserted into the SAME `tasks` collection admin-
// created tasks live in, category:'exclusive', so the existing Task tab
// rendering + claim flow (api/earn.js handleTaskStart/handleTaskComplete)
// needs ZERO changes to serve these — `limit`/`completionCount` already
// gate a capped task atomically. See api/payments.js (resource:'taskcreate') +
// api/payments.js (cron=checkDeposits). Same on-chain TON-deposit pattern
// as PUNCH_KEY above (memo-matched, atomically credited, external cron).
export const TASK_CREATE_REWARD_PER_TASK_WTC = 10; // every completion of a user-created task pays this many WTC, fixed
export const TASK_CREATE_PACKAGES = {
    100:  { taskCount: 100,  priceNanoTon: 150_000_000 },  // 0.15 TON
    200:  { taskCount: 200,  priceNanoTon: 300_000_000 },  // 0.30 TON
    500:  { taskCount: 500,  priceNanoTon: 750_000_000 },  // 0.75 TON
    1000: { taskCount: 1000, priceNanoTon: 1_500_000_000 }, // 1.5 TON
};
export const TASK_CREATE_ORDER_EXPIRY_MINUTES = 15; // same 15-min window as Punch Key
// A user-created task is kept visible (e.g. so its creator can see the
// final completion count) for this many days after it hits its
// completionCount/limit cap, then the whole task doc auto-deletes (TTL
// index in models/schema.js, and the completedAt marker set in
// api/earn.js handleTaskComplete).
export const USER_TASK_COMPLETED_TTL_DAYS = 5;
// ══════════════════════════════════════════════════════════

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

// ⚠️ REMOVED (Season 4) — WITHDRAW_TIERS and WITHDRAW_LEVELS. Both the
// fixed-$-tier grid and the hidden referral-based level ladder are gone;
// withdraw amount is now a free-text WTC field (min MIN_WITHDRAW_WTC) and
// the only referral gate is "1 valid referral per withdraw after the
// first" — see WITHDRAW_VALID_REFERRALS_PER_WITHDRAW above.

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
        uslCountToday: 0,
        // ⚠️ REMOVED — tadsCountToday (network deleted, see AD_NETWORK_REWARDS above)
        // ⚠️ REMOVED — dailySpinsUsed (daily-count spin limit). Replaced by
        // lastFreeSpinAt, a rolling timestamp checked against
        // SPIN_FREE_COOLDOWN_HOURS (see lib/constants.js) — deliberately NOT
        // reset here, since a cooldown must survive the day boundary (a spin
        // used at 11:58pm should still block a spin at 12:01am, 2 hours
        // apart or not).
        monetagPopupCountToday: 0,
        // ⚠️ FIX — these two were never reset before (only usedVideoStarts
        // was). Since single-use ad/lootbox tokens already expire after 5
        // minutes (see AD/lootbox handlers), there's zero reason to keep
        // spent tokens from days ago — they were just growing every user's
        // document forever, unbounded, which is exactly the kind of
        // MongoDB free-tier bloat risk to avoid.
        usedAdStarts: [],
        usedLootboxStarts: [],
        // ⚠️ NEW — single-use task-claim tokens (see api/earn.js
        // handleTaskStart/handleTaskComplete). Same reasoning: 5-minute
        // expiry, no reason to keep them past the day they were issued.
        usedTaskStarts: [],
        usedSpinStarts: [], // ⚠️ NEW — single-use spin-ad-gate tokens (see handleSpin, api/earn.js). Same 5-minute-expiry reasoning as the others.
        usedVideoStarts: [], // ⚠️ replay-protection: প্রতিদিন claim করা video-session (startTime) গুলোর তালিকা, দিন শেষে খালি হয়
    };
}

// ══════════════════════════════════════════════════════════
// ⚠️ SEASON END — withdrawals closed. Set by admin decision: no new
// withdraw requests are accepted from this point on. Already-submitted
// ('pending') withdrawals are UNAFFECTED — bot.js's normal Approve/Reject
// admin flow still works exactly as before for those, so anyone who
// requested a withdraw before this flag flipped still gets paid. This only
// blocks the "create a NEW withdrawal" path (api/withdraw.js handleCreate).
// Flip back to true if withdrawals ever reopen.
// ══════════════════════════════════════════════════════════
export const WITHDRAWALS_OPEN = true; // ⚠️ SEASON 3 — reopened for the new season (was closed at Season 2's end)

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

// ══════════════════════════════════════════════════════════
// SPIN WHEEL
// ⚠️ CHANGED (admin decision) — was "3 free ad-gated spins/day"
// (dailySpinsUsed, reset via dailyResetFields). Replaced with a rolling
// cooldown: ONE free ad-gated spin every SPIN_FREE_COOLDOWN_HOURS, tracked
// by lastFreeSpinAt (a timestamp, not a daily counter) — see handleSpin in
// api/earn.js. bonusSpinsAvailable (referral spins) is UNCHANGED — those
// still accumulate separately and aren't subject to this cooldown at all,
// exactly as before.
// ⚠️ SECURITY FIX (same update) — the free spin's "ad-gated" claim had
// ZERO server-side verification before this: the frontend just called the
// ad SDK directly and then hit the `spin` action with no signed token at
// all (unlike every other ad-gated reward in this app). A script could
// skip the ad entirely and call `spin` in a raw loop, limited only by the
// old daily counter. Now uses the exact same signed-token pattern as
// claimAdReward/claimLootbox (spinStart → wait AD_MIN_WATCH_SECONDS →
// spin), so watching the ad is no longer purely a client-side honor system.
export const SPIN_FREE_COOLDOWN_HOURS = 2;
export const SPIN_SEGMENTS = [
    { value: 100, weight: 0.33 },
    { value: 10,  weight: 47.50 },
    { value: 20,  weight: 47.50 },
    { value: 30,  weight: 1.34 },
    { value: 40,  weight: 1.33 },
    { value: 50,  weight: 1.33 },
    { value: 60,  weight: 0.34 },
    { value: 80,  weight: 0.33 },
]; // order matches the 8 wedges clockwise-from-top in the reference design image (100,10,20,30,40,50,60,80)
