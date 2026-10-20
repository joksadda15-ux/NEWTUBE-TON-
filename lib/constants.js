// lib/constants.js — SEASON 2 UPDATE (FIXED RATES — live pricing removed)
//
// ⚠️ Per admin's instruction, the live TON price system was removed — it
// would sometimes overpay users in TON when the market price dipped. Now
// it's back to simple, predetermined (fixed) rates — predictable payouts,
// no dependency on an external API.
//
// Dropped the two-tier Gold + Diamond currency — now there's a single
// currency: the WTC coin. All reward/fee/withdraw numbers live here.

// ── WTC → real-money conversion rate (FIXED) ──
export const WTC_PER_USD = 50000; // 50,000 WTC = 1 USD

// ── WTC earned by watching videos (via the floating "lootbox" button in the video section) ──
const VIDEO_WTC_PER_MINUTE = 100 / 60;   // 20 Oct 2026 (admin): 60 -> 100 WTC/hour
export const VIDEO_WTC_PER_SECOND = VIDEO_WTC_PER_MINUTE / 60;
export const LOOTBOX_CLAIM_MIN = 25;         // minimum accrued amount required to claim (20 Oct 2026 admin: lootbox can be claimed as soon as it holds 25 WTC)
export const LOOTBOX_CLAIM_MAX = 500;        // max credit per network call (to prevent time-spoofing, not a daily cap)

// Daily video-watch time limit.
const DAILY_VIDEO_WATCH_HOURS_MAX = 5;
export const DAILY_VIDEO_WTC_MAX = Math.round(DAILY_VIDEO_WATCH_HOURS_MAX * 60 * VIDEO_WTC_PER_MINUTE); // = 500 WTC/day (auto-follows VIDEO_WTC_PER_MINUTE above)

// ── The Extract tab's ad-network buttons — each pays WTC directly ──
// adsgramSpecial re-added (was removed entirely per an earlier
// admin request; now back per a newer request). Different block ID this
// time (27566, daily limit 10) than the old one that was removed. USL Ads was removed entirely (admin request, 12 Oct 2026).
// See api/earn.js's handleAdStart/handleClaimAdReward, which check
// `enabled !== false` before allowing adStart/claimAdReward — kept in
// place so any network can be paused instantly by flipping its `enabled`
// flag here, without a code deploy.
// monetag reward 15 → 10 WTC (per admin request — Monetag's
// CPM runs low compared to the other networks, so the payout no longer
// matched what it was actually worth).
//
// AD_MIN_WATCH_SECONDS below used to be one shared floor for every network.
// Split into per-network `minWatchSeconds` here instead, since real ad unit
// durations differ network to network — a single shared number was always
// either too strict for the shortest network or too loose for the longest.
// AD_MIN_WATCH_SECONDS still exists as the fallback for any network that
// doesn't set its own minWatchSeconds (see handleClaimAdReward, api/earn.js).
//
// `requiresClick: true` (giga only now) — IMPORTANT — this flag is NOT yet
// enforced anywhere in api/earn.js. Implementing a real click requirement
// needs to be checked against what GigaPub's own SDK actually exposes
// (their simple rewarded-ad call doesn't appear to distinguish click vs.
// impression — only their separate, bigger "OfferWall" product does, which
// is a different integration entirely — see chat history). Flagging it here
// as a marker of INTENT so it isn't forgotten, not as something active.
//
// ⚠️ REMOVED (this update) — Monetag's server-to-server postback system
// (was handleMonetagPostback in api/earn.js, plus the ymid plumbing in
// index.html). Admin decision: reverted back to the same signed-token +
// timer heuristic every other network uses here, at a 6-second floor.
// `monetag` and `monetagPopup` are now ordinary networks again — no
// `requiresClick`, no postback, no ymid, no MONETAG_POSTBACK_SECRET needed.
export const AD_NETWORK_REWARDS = {
    // minWatchSeconds is now the REAL minimum
    // time the ad must stay open before a reward is paid (the client measures it,
    // the server also checks it — see handleClaimAdReward in api/earn.js).
    // Closing earlier than this = no reward. Per admin:
    //   Adsgram Daily 5s · Adsgram Special 10s · GigaPub 4s · Monetag = NO timer, NO token (see noSecurity below)
    // 14 Oct 2026 (admin): Adsgram Daily's anti-hack barriers REMOVED (no adStart token / timer / viewMs / cooldown / bot-pattern checks) —
    // same `noSecurity` path as Monetag. Daily limit + ban/eligibility still apply. NOT counted toward the withdraw "ads today" requirement
    // (no proof an ad was watched). To count it again, add `countsAsAd: true` here AND see handleClaimAdReward's noSecurity block.
    // 14 Oct 2026 (admin): reward 10 -> 15 WTC, 10/day. No token/timer (S2S not possible for init ads) BUT a 60s gap between two ads (minGapSeconds).
    // 15 Oct 2026 (admin): `adsgramDaily` network REMOVED (its int- block is now a passive no-reward interstitial in the app). The server now answers invalid_network for it.
    // 🔒 S2S: confirmed by Adsgram's own server (Reward URL -> api/earn.js?s2s=adsgram). `s2s: true` = the client can NO LONGER claim this network.
    // 14 Oct 2026 (admin): reward 25 -> 30 WTC. S2S only, NO barrier (the 5s duplicate-gap was removed). Daily limit 10 stays.
    // 20 Oct 2026 (admin): reward 30 -> 40 WTC. Daily limit 10 stays.
    adsgramSpecial: { reward: 40, dailyLimit: 10, s2s: true, countsAsAd: true },
    // 17 Oct 2026 (admin): Monetag has NO way to prove an ad was really shown (no S2S for this format), so a script can claim it
    // without watching anything. Damage is therefore capped hard on the server: reward 10 -> 2 WTC, daily limit 10 (so max 20 WTC/day
    // per account, worth almost nothing) + a 20s gap between two claims (minGapSeconds). Still no token / timer, so real users feel nothing.
    // 20 Oct 2026 (admin): reward 2 -> 15 WTC. Daily limit (10) and the 20s gap stay the same.
    monetag:        { reward: 15, dailyLimit: 10, noSecurity: true, minGapSeconds: 20 },
    // 14 Oct 2026 (admin): GigaPub is verified by its server-to-server postback (api/gift.js?network=gigapub -> `gigaPostbacks`).
    // When Vercel env GIGA_S2S_ENFORCE=1 a claim is paid ONLY if an unused postback from GigaPub exists for that user (no timer/token needed).
    // While that env var is NOT '1', the old token + minWatchSeconds barriers below stay active as the safe fallback.
    // 14 Oct 2026 (admin): reward 15 -> 20 WTC, 15/day, and a 10s gap between two GigaPub ads (minGapSeconds).
    giga:           { reward: 20, dailyLimit: 15, minWatchSeconds: 4, requiresClick: true, postbackS2S: true, minGapSeconds: 10 },
    // 17 Oct 2026 (admin): Adsgram Task = 50 WTC, MAX 10 per day (was unlimited). Still S2S-confirmed (Adsgram's own server calls the Reward URL),
    // and now the SERVER also stops paying after 10 a day — even if Adsgram sends more callbacks, nothing more is credited.
    adsgramTask:    { reward: 50, dailyLimit: 10, s2s: true, s2sMinGapSeconds: 5 }, // task block task-53569. Not counted toward the withdraw-ads requirement.
    // ⚠️ Monetag's separate "Rewarded Popup" format (show_9442539('pop') —
    // different call shape from the plain show_9442539() used by `monetag`
    // above). Back to the standard adStart/claimAdReward token flow, same
    // 6-second floor as `monetag` (both are "the Monetag family").
};

// this export was MISSING, which is exactly why every /api/earn
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
// time).
// this is now only the FALLBACK for a network with no
// `minWatchSeconds` of its own in AD_NETWORK_REWARDS above (currently no
// network uses it, plus any future network added without an explicit
// value). Kept at 15s for that fallback case.
export const AD_MIN_WATCH_SECONDS = 15;

// the client reports how long the ad was actually on
// screen (viewMs). It can never be longer than the whole adStart→claim round
// trip; this is the slack allowed for clock/rounding differences.
export const AD_VIEW_TOLERANCE_SECONDS = 1.5;



// this was defined but never actually imported/used anywhere, so
// the "20-second gap between ads" it describes was NOT being enforced at
// all — pure dead code, a script could adStart→claimAdReward back-to-back
// with zero pacing. Now wired into handleClaimAdReward (see api/earn.js).
// lowered from 20s to 10s. NOTE: this was
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

// minimum real time a user must hold a task open before claiming
// it (daily/exclusive/partner/earning categories — 'channel' tasks skip this
// entirely since Telegram membership is independently verified). Kept
// slightly under the frontend's claim-button countdown so a genuine user
// is never blocked by their own honest usage; a script that skips straight
// from taskStart to taskComplete with no real wait gets rejected. See
// handleTaskStart/handleTaskComplete in api/earn.js.
// was 8 (paired with a 10s frontend countdown). Frontend
// countdown is now 5s (per admin request), so this had to come down too —
// left as-is it would have been LONGER than the countdown itself, meaning
// every honest user who claimed right at 5s would get rejected server-side.
export const TASK_MIN_WAIT_SECONDS = 4;

// cooldown between ANY two non-channel task completions by the same
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
// was 15s (admin feedback: real users doing several tasks in a
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
    // 15 Oct 2026 (admin): fee depends on the method — Binance UID 20%, Tonkeeper address 10%.
    // Tonkeeper is paid AUTOMATICALLY when the admin approves (lib/tonPayout.js); Binance is paid by hand.
    binance:   { label: 'Binance UID',       currency: 'USDT', feePercent: 20, processHours: { min: 3, max: 48 }, minCurrency: 0.1, wtcToCurrency: (wtc) => wtc / WTC_PER_USD },
    tonkeeper: { label: 'Tonkeeper Address', currency: 'USDT', feePercent: 10, processHours: { min: 1, max: 5 }, minCurrency: 0.1, wtcToCurrency: (wtc) => wtc / WTC_PER_USD },
};

// Wallet lock. A user's FIRST withdrawal method + address become their permanent
// wallet (user.lockedWalletMethod / user.lockedWalletAddress); every later
// withdrawal reuses it and the client's method/details are ignored (so a tampered
// client can't redirect a payout).
//
// If the address was wrong, the "Wrong Address" flow (wd_fixaddr_ / wd_new_address
// in api/bot.js) lets the user set a NEW permanent wallet — only ONCE ever
// (user.walletChangeUsed). It closes the current pending withdrawal as a refund
// minus this penalty percentage. After that, a wrong-address report can only be
// closed with the 50% penalty confirm (wd_addrconfirm_), which does not change the wallet.
export const WALLET_CHANGE_PENALTY_PERCENT = 5;

// 15 Oct 2026 (admin): the user can ask for a wallet change from the Withdraw screen ("Change Wallet").
// The admin gets a Telegram notification (Accept / Deny); only after Accept can the user enter a new wallet.
// Each user may send this request at most WALLET_CHANGE_MAX_REQUESTS times in their whole life (denied ones count too);
// after that the button disappears. (Independent from the older admin-side "Wrong Address" one-time flow above.)
export const WALLET_CHANGE_MAX_REQUESTS = 2;

// ── Withdraw ──
// One step: the user types a WTC amount (minimum MIN_WITHDRAW_WTC) and submits.
//
// Two fees are applied back to back (see calcNetUsd in api/withdraw.js and
// calcNetUsdDisplay in index.html): fee 1, then fee 2 on what is left.
// Currently 15% + 0%, so the user nets 85% of face value.
export const MIN_WITHDRAW_WTC = 2500; // 15 Oct 2026 (admin): 1500 -> 2500

// The first FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE withdrawals need no valid referral,
// but each one is capped at this amount (gross, before fees).
export const FREE_WITHDRAW_MAX_USD = 0.25;
export const FREE_WITHDRAW_MAX_WTC = Math.floor(FREE_WITHDRAW_MAX_USD * WTC_PER_USD);

export const WITHDRAW_FEE_PERCENT = 15;
export const WITHDRAW_SECOND_FEE_PERCENT = 0;  // 0 = only one fee

// Lifetime, one-time gate: checked against completedTasks.length (never reset), so once
// a user has completed this many tasks it stays satisfied. See api/withdraw.js.
export const WITHDRAW_TASKS_REQUIRED = 10;

// 17 Oct 2026 (admin): ROLLING 24-HOUR gate (was "10 ads today", reset at Bangladesh midnight).
// The user must have watched WITHDRAW_ADS_REQUIRED verified ads (GigaPub / Adsgram Special — the same ads that already count
// as "ads") inside the LAST WITHDRAW_ADS_WINDOW_HOURS hours, counted from the exact second of each ad. Checked against
// users.adTimes24h (api/earn.js pushes one timestamp per counted ad); each withdrawal CONSUMES them (api/withdraw.js),
// so the next withdrawal needs 6 fresh ads again.
export const WITHDRAW_ADS_REQUIRED = 6;
export const WITHDRAW_ADS_WINDOW_HOURS = 24;


// Anti-farming account-age gate: hours a user must have existed (user.createdAt) before
// their FIRST withdrawal. Later withdrawals are not re-gated. 0 = gate disabled
// everywhere (modal, status endpoint and create endpoint all read this one number).
export const WITHDRAW_MIN_ACCOUNT_AGE_HOURS = 0;

// Promised payout window shown to users. DISPLAY ONLY — nothing auto-approves or
// auto-rejects; approval is the admin's manual flow in api/bot.js.
// Keep index.html's WITHDRAW_PROCESS_*_DISPLAY in sync with these two.
export const WITHDRAW_PROCESS_MIN_HOURS = 3;
export const WITHDRAW_PROCESS_MAX_HOURS = 48;

// Referral rules for withdrawals:
//   • The first FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE withdrawals need NO valid referral,
//     but each is capped at FREE_WITHDRAW_MAX_USD (gross, before fees).
//   • After that, WITHDRAW_REFERRALS_PER_WITHDRAW (2) valid referrals are needed for EACH withdrawal,
//     and a single withdrawal is capped at WITHDRAW_MAX_WTC_WITH_REFERRAL (100,000 WTC).
// A referral becomes "valid" once the referred user completes all referral milestones
// (lib/referral.js). Enforced in api/withdraw.js against user.validReferralCount - user.usedValidReferrals.
export const FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE = 5;
// 20 Oct 2026 (admin): after the 5 free withdrawals, EVERY withdrawal needs exactly 2 valid referrals (flat — it no longer
// depends on the amount), and one withdrawal can be at most 100,000 WTC.
export const WITHDRAW_REFERRALS_PER_WITHDRAW = 2;
export const WITHDRAW_MAX_WTC_WITH_REFERRAL = 100000;
// kept so any old import keeps working — the amount no longer matters, the answer is always WITHDRAW_REFERRALS_PER_WITHDRAW.
export const WITHDRAW_USD_PER_VALID_REFERRAL = 0.25; // legacy / unused
export function requiredReferralsForUsd(_usd) {
    return WITHDRAW_REFERRALS_PER_WITHDRAW;
}


// withdraw address is never locked. Left the constant name out of the file
// entirely rather than a disabled flag, since nothing should reference it
// ── Referral — given in 4 stages (lifetime milestone, awarded once) ──
// Referral milestone rewards — each is paid once, to the REFERRER (lifetime milestone).
// 20 Oct 2026 (admin): new reward table. Total per friend: 50 + 130 + 150 + 100 + 150 = 580 WTC.
//   step 1  friend joins channel + community and verifies          50
//   step 2  friend completes 5 tasks                                130 (unchanged)
//   step 3  friend watches 20 ads                                   150 (was 234)
//   step 4  friend claims their first Video lootbox                 100 (was 117)
//   step 5  friend collects Mining 2 times (NEW)                    150
// Step 4 is awarded the first time the referred user claims a lootbox in the Video section (handleClaimLootbox in api/earn.js,
// maybeAwardReferralMilestones in lib/referral.js). Step 5 is awarded when the referred user's 2nd Mining collect succeeds (handleMineClaim).
export const REFERRAL_REWARDS = {
    step1_verified:      50,  // when the referred user joins channel+community and verifies
    step2_tenTasks:      130, // when the referred user completes 5 tasks (key name kept as-is)
    step3_twentyAds:     150, // when the referred user completes 20 ads (key name kept as-is)
    step4_firstLootbox:  100, // when the referred user claims their first Video-section lootbox
    step5_twoMinings:    150, // when the referred user has collected Mining 2 times
};
export const REFERRAL_STEP5_MINING_COUNT = 2;
export const REFERRAL_STEP2_TASK_COUNT = 5;
export const REFERRAL_STEP3_AD_COUNT = 20;

// referral SIGNUP velocity lock. This is a much earlier tripwire
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

// raw-IP signup velocity lock. This is the direct fix for the
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
export const IP_SIGNUP_VELOCITY_THRESHOLD = 15;             // 15+ new accounts from one IP inside that window (was 6 -- raised 12 Oct 2026: BD users must use VPN to open Vercel, so many REAL users share one VPN exit IP and were being auto-locked)

// withdrawal referral commission. Every time a user withdraws, if
// they were referred by someone, the referrer is credited this % of the
// WITHDRAWN WTC AMOUNT (gross, before withdraw fees) directly to their own
// wtcBalance — e.g. a 1,000 WTC withdrawal pays the referrer 150 WTC. This
// is NOT a one-time reward — it fires on every withdrawal, indefinitely, for
// as long as the referral relationship exists. See api/withdraw.js.
export const WITHDRAW_REFERRAL_COMMISSION_PERCENT = 15; // 15 Oct 2026: raised from 10 (admin request)

// ⚠️ REMOVED (update) — "Punch Key" (buy a valid referral with TON) is gone.

// ══════════════════════════════════════════════════════════
// USER-CREATED TASKS ("Create Task" button, Task tab). A user pays
// TON to publish their OWN task — either a channel/group join (API-
// verified via the bot's own membership check, same mechanism as any other
// verifyType:'api' task) or a link to anything else (another bot, a
// website — verifyType:'link', manual claim-after-wait like every other
// non-API task). It's inserted into the SAME `tasks` collection admin-
// created tasks live in, category:'exclusive', so the existing Task tab
// rendering + claim flow (api/earn.js handleTaskStart/handleTaskComplete)
// needs ZERO changes to serve these — `limit`/`completionCount` already
// gate a capped task atomically. See api/payments.js (resource:'taskcreate') +
// api/payments.js (cron=checkDeposits). On-chain TON-deposit pattern (memo-matched, atomically credited, external cron).
export const TASK_CREATE_REWARD_PER_TASK_WTC = 10; // every completion of a user-created task pays this many WTC, fixed
export const TASK_CREATE_PACKAGES = {
    100:  { taskCount: 100,  priceNanoTon: 150_000_000 },  // 0.15 TON
    200:  { taskCount: 200,  priceNanoTon: 300_000_000 },  // 0.30 TON
    500:  { taskCount: 500,  priceNanoTon: 750_000_000 },  // 0.75 TON
    1000: { taskCount: 1000, priceNanoTon: 1_500_000_000 }, // 1.5 TON
    1500: { taskCount: 1500, priceNanoTon: 2_250_000_000 }, // 2.25 TON
    2000: { taskCount: 2000, priceNanoTon: 3_000_000_000 }, // 3.00 TON
};
export const TASK_CREATE_ORDER_EXPIRY_MINUTES = 15; 
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

// a real UTC Date instant matching the most recent Asia/Dhaka
// midnight (fixed UTC+6, Bangladesh has had no DST since 2009, so a plain
// offset is safe/exact — no tz-database lookup needed). Use this instead of
// `new Date(); .setHours(0,0,0,0)` for any "since today" query (dashboard
// stats, etc) — that naive version resets at the SERVER's local midnight
// (UTC on Vercel), 6 hours off from when todayBD()/ensureDailyReset()
// actually roll the day over, so "today" in a report silently meant a
// different window than "today" for daily limits/resets.
const BD_OFFSET_MS = 6 * 60 * 60 * 1000;
export function todayStartBD() {
    const bdShiftedMs = Date.now() + BD_OFFSET_MS;
    const bdMidnightShiftedMs = Math.floor(bdShiftedMs / 86400000) * 86400000;
    return new Date(bdMidnightShiftedMs - BD_OFFSET_MS);
}

// full date+time in the Bangladesh timezone, for admin-facing
// timestamps (withdraw request notifications, approve/reject stamps,
// velocity-flag times, etc. — api/bot.js). BUG FIX: those messages were all
// using bare `new Date(...).toLocaleString()` with no timeZone option,
// which formats in whatever timezone the SERVER process runs in — Vercel's
// Node runtime defaults to UTC, so every timestamp shown to the admin was
// exactly 6 hours BEHIND real Bangladesh time (e.g. a request made at 4:48
// PM BDT showed as "10:48 AM"). `date` accepts anything `new Date()` does
// (a Date object, ISO string, or omitted for "now").
export function fmtBDDateTime(date) {
    return new Date(date ?? Date.now()).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' });
}

// date-only counterpart to fmtBDDateTime, same timezone-correctness
// reasoning (see that function's comment). Used for "Joined: ..." /
// "cleared on ..." style lines where only the day matters, not the time.
export function fmtBDDate(date) {
    return new Date(date ?? Date.now()).toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });
}

export function dailyResetFields() {
    return {
        lastResetDate: todayBD(),
        adsWatchedToday: 0,
        tasksCompletedToday: 0,
        dailyVideoWtcMined: 0,
        adsgramDailyCountToday: 0,
        adsgramSpecialCountToday: 0,
        adsgramTaskCountToday: 0,
        monetagCountToday: 0,
        gigaCountToday: 0,
        // ⚠️ REMOVED — tadsCountToday (network deleted, see AD_NETWORK_REWARDS above)
        // these two were never reset before (only usedVideoStarts
        // was). Since single-use ad/lootbox tokens already expire after 5
        // minutes (see AD/lootbox handlers), there's zero reason to keep
        // spent tokens from days ago — they were just growing every user's
        // document forever, unbounded, which is exactly the kind of
        // MongoDB free-tier bloat risk to avoid.
        usedAdStarts: [],
        usedLootboxStarts: [],
        // single-use task-claim tokens (see api/earn.js
        // handleTaskStart/handleTaskComplete). Same reasoning: 5-minute
        // expiry, no reason to keep them past the day they were issued.
        usedTaskStarts: [],
        usedVideoStarts: [], // ⚠️ replay-protection: list of video sessions (startTime) claimed today, emptied at the end of the day
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

// 17 Oct 2026 (admin): the SPIN WHEEL is fully REMOVED — no spin constants, no spin requirement for withdrawals, no spin referral milestone.

// ══════════════════════════════════════════════════════════════
// MINING (14 Oct 2026, admin) — ONE collect every MINING_COOLDOWN_HOURS for MINING_REWARD WTC.
// To collect, the user must watch ONE ad. The server picks it at random from MINING_AD_NETWORKS
// (GigaPub or Adsgram Special — both confirmed server-to-server, see api/earn.js handleMineStart/handleMineClaim).
// ══════════════════════════════════════════════════════════════
export const MINING_REWARD = 50;
export const MINING_COOLDOWN_HOURS = 2;
export const MINING_AD_NETWORKS = ['giga', 'adsgramSpecial'];

// 17 Oct 2026 (admin) — MINING BOOST. AJKER DIN-e (Bangladesh time, raat 12:00 theke) user-er link diye je friend-ra join korechhe tader
// shonkha onujayi EVERY mining collect beshi WTC dey. Highest matching tier wins; lowest tier-er niche = MINING_REWARD.
//   2+ friends  → 60 WTC per collect   |   5+ friends → 80   |   10+ friends → 120   (normal = 50)
// Boost-er meyad shesh hoy AJKE RAAT 12:00-e (BD time); tarpor friend-count abar 0 theke shuru. Tai friend 2:00 PM-e join korle boost ~10 ghonta,
// 7:00 PM-e join korle ~5 ghonta cholbe (api/earn.js getMiningBoost).
// Ekta friend gonay ONLY jodi: ajke join korechhe, channel+community verify korechhe, ban/lock na, multi-account flag na — jate fake/duplicate
// account diye number fulano na jay. Hishab SERVER-e hoy; app (index.html) shudhu mineInfo theke dekhay, tai kono number app-e bodle laabh nai.
// Number bodlate hole shudhu NICHER MINING_BOOST_TIERS bodlao.
export const MINING_BOOST_TIERS = [ // keep sorted HIGHEST first
    { minRefs: 10, reward: 120 },
    { minRefs: 5,  reward: 80 },
    { minRefs: 2,  reward: 60 },
];

// 17 Oct 2026 — Video LOOTBOX claim now needs a REAL, server-confirmed ad (same proof system as Spin + Mining).
// Before, the lootbox ad was never verified: a script could call lootboxAdStart -> wait 15s -> claimLootbox and cash in the
// video WTC (up to 300/day) without any ad. Now the SERVER picks one of these networks and the reward is paid only after that
// network's own server confirmed the view (Adsgram Reward URL / GigaPub postback). Monetag is NOT here — it cannot be verified.
export const LOOTBOX_AD_NETWORKS = ['giga', 'adsgramSpecial'];

// 17 Oct 2026 — script-suspicion counter. Every time lib/botGuard.js flags an account (alert OR lock) `botSuspectCount` goes +1.
// At this many flags the account can NOT create a withdrawal any more (it is held for manual review in the admin panel;
// "Unlock" in the admin panel clears the counter). Nobody is banned automatically — the admin decides.
export const BOT_SUSPECT_HOLD_COUNT = 2;

// 17 Oct 2026 — wrong promo-code guessing limit (stops a script from brute-forcing codes): after this many failed attempts
// inside the window the user is blocked from promo tries for the rest of the window.
export const PROMO_FAIL_LIMIT = 6;
export const PROMO_FAIL_WINDOW_MS = 15 * 60 * 1000;


