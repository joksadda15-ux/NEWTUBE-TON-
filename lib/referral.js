// lib/referral.js — Season 2 + FIX: referral earnings now tracked separately
// + ATOMIC FIX: each milestone's flag-check-and-set is now a single atomic
// operation, closing a race window where two near-simultaneous triggers
// (e.g. rapid double-tap task completion, or two devices) could both read
// the flag as false and both award the same milestone twice.
//
// লেখার রেফারেল রিওয়ার্ড ৩টা ধাপে দেওয়া হয় (আসল সংখ্যা lib/constants.js-এর
// REFERRAL_REWARDS-এ), প্রতিটা ধাপ যখন referred user (যাকে রেফার করা হয়েছে)
// প্রথমবার সেই মাইলস্টোনে পৌঁছায়:
//   ধাপ ১: channel + community verify করলে
//   ধাপ ২: ১০টা task সম্পন্ন করলে
//   ধাপ ৩: ২০টা ads সম্পন্ন করলে
//
// ⚠️ NEW — daily per-referrer cap (REFERRAL_DAILY_MILESTONE_CAP,
// tryConsumeDailyMilestoneQuota below). Every one of the 3 steps above is
// gated by REAL server-side proof (actual Telegram membership, signed
// task-claim tokens, real ad-watch counters) — there's no bypass bug here.
// But those checks only prove "a real Telegram account did this", not
// "these are N different humans" — a script can cheaply spin up many
// accounts with different (client-generated, trivially randomized) device
// fingerprints and drive them through the real steps. That's a volume-abuse
// problem, not a patchable authentication hole, so the containment is a
// hard daily ceiling per referrer instead: past the cap, further milestone
// rewards for that referrer are blocked (not queued, just not paid) for the
// rest of the day, and the admin gets a one-time alert to review the account.
//
// প্রতিটা ধাপ মাত্র একবারই দেওয়া হবে — তার জন্য referred user-এর ডকুমেন্টে
// referralStep1Done / Step2Done / Step3Done ফ্ল্যাগ রাখা হচ্ছে, এবং প্রতিটা
// ফ্ল্যাগের check+set এখন atomic (findOneAndUpdate দিয়ে) — তাই concurrent
// কল থেকে ডাবল-অ্যাওয়ার্ড হওয়ার সুযোগ নেই।
//
// reward সরাসরি wtcBalance-এ যোগ হয়, এবং আলাদা করে `referralWtcEarned`
// ফিল্ডেও যোগ হয় যাতে "Refer" ট্যাবে referral-থেকে-আসা টাকার real সংখ্যা
// দেখানো যায়।

import {
    REFERRAL_REWARDS,
    REFERRAL_STEP2_TASK_COUNT,
    REFERRAL_STEP3_AD_COUNT,
    REFERRAL_DAILY_MILESTONE_CAP,
    todayBD,
} from './constants.js';
import { tgSend } from './telegram.js';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

function abuseAlertMessage(referrerId) {
    return (
        `🚨 <b>Possible referral farming detected</b>\n\n` +
        `Referrer <code>${referrerId}</code> hit the daily referral-milestone cap ` +
        `(${REFERRAL_DAILY_MILESTONE_CAP} rewards today).\n\n` +
        `Further referral-milestone rewards for this account are on hold for the rest of today — ` +
        `real growth days can also trip this, so check their referral list before deciding.`
    );
}

// ⚠️ NEW — atomic daily counter check-and-increment for one referrer.
// Resets automatically on a new day (Bangladesh time), same pattern as
// lib/dailyReset.js. Returns true if this credit is ALLOWED (still under
// cap), false if it should be blocked.
async function tryConsumeDailyMilestoneQuota(users, referrerId) {
    const today = todayBD();
    // First: if it's a new day for this referrer, reset the counter to 0
    // before incrementing — same idempotent pattern as ensureDailyReset.
    await users.updateOne(
        { _id: referrerId, referralMilestonesResetDate: { $ne: today } },
        { $set: { referralMilestonesToday: 0, referralMilestonesResetDate: today } }
    );
    // Then atomically increment and read back the post-increment value —
    // only ONE concurrent call can be the one that pushes it past the cap.
    const updated = await users.findOneAndUpdate(
        { _id: referrerId },
        { $inc: { referralMilestonesToday: 1 } },
        { returnDocument: 'after' }
    );
    // ⚠️ driver-version-safe read — some MongoDB Node driver versions return
    // the document directly, older ones wrap it in `.value`.
    const doc = updated?.value !== undefined ? updated.value : updated;
    const countAfter = doc?.referralMilestonesToday ?? 1;
    if (countAfter > REFERRAL_DAILY_MILESTONE_CAP) return false;
    // Alert the admin exactly once, right as the cap is being hit.
    if (countAfter === REFERRAL_DAILY_MILESTONE_CAP && ADMIN_ID) {
        tgSend(ADMIN_ID, abuseAlertMessage(referrerId)).catch(() => {});
    }
    return true;
}

// ⚠️ NEW (Season 4) — sent to the REFERRER the moment one of their referrals
// finishes all 3 steps and becomes "valid" (see step3 handling below). This
// valid referral is what api/withdraw.js spends — 1 per withdrawal, after
// the user's first (free) one.
function validReferralNotification() {
    return (
        `🎉 <b>Congratulations!</b>\n\n` +
        `One of your referrals has been successfully verified ✅\n\n` +
        `You've unlocked <b>1 valid referral</b> — this lets you make your next withdrawal. ` +
        `Keep sharing your invite link to unlock more! 🚀`
    );
}

// stats = { channelVerified?, completedTasksCount?, lifetimeAdsWatched? }
// — যেকোনো একটা বা একাধিক পাস করতে পারেন, যেটা সদ্য changed হয়েছে
export async function maybeAwardReferralMilestones(db, referredUserId, stats = {}) {
    const users = db.collection('users');
    const referredUser = await users.findOne(
        { _id: referredUserId },
        { projection: { referredBy: 1, referralStep1Done: 1, referralStep2Done: 1, referralStep3Done: 1 } }
    );
    if (!referredUser || !referredUser.referredBy) return; // কেউ এই ইউজারকে রেফার করেনি
    if (referredUser.referredBy === referredUserId) return; // ⚠️ self-referral guard — defense in depth

    const referrerId = referredUser.referredBy;

    const steps = [
        { key: 'referralStep1Done', met: !!stats.channelVerified, reward: REFERRAL_REWARDS.step1_verified },
        { key: 'referralStep2Done', met: stats.completedTasksCount !== undefined && stats.completedTasksCount >= REFERRAL_STEP2_TASK_COUNT, reward: REFERRAL_REWARDS.step2_tenTasks },
        { key: 'referralStep3Done', met: stats.lifetimeAdsWatched !== undefined && stats.lifetimeAdsWatched >= REFERRAL_STEP3_AD_COUNT, reward: REFERRAL_REWARDS.step3_twentyAds },
    ];

    for (const step of steps) {
        if (!step.met || referredUser[step.key]) continue;

        // ⚠️ ATOMIC — flag-check আর flag-set একই operation-এ। দুটো concurrent
        // call এলে একটাই এই filter ($ne:true) পাস করবে, অন্যটা null ফেরত পাবে
        // এবং নিচের reward-credit স্কিপ করবে।
        const claimed = await users.findOneAndUpdate(
            { _id: referredUserId, [step.key]: { $ne: true } },
            { $set: { [step.key]: true } },
            { returnDocument: 'after' }
        );
        if (!claimed) continue; // অন্য concurrent call কিছু মিলিসেকেন্ড আগেই claim করে ফেলেছে

        // ⚠️ NEW — the daily circuit-breaker. If this referrer already hit
        // today's cap, the step flag above still gets set (so this exact
        // milestone won't be re-evaluated tomorrow), but NO reward is paid
        // — no WTC, no lucky ticket, no validReferralCount bump. This is
        // the actual fraud-containment: even a perfectly-executed fake
        // account farm can drain at most REFERRAL_DAILY_MILESTONE_CAP
        // worth of rewards from one referrer per day, not an unlimited
        // amount in a single burst.
        const withinDailyCap = await tryConsumeDailyMilestoneQuota(users, referrerId);
        if (!withinDailyCap) continue;

        const referrerUpdate = await users.findOneAndUpdate(
            // ⚠️ CHANGED — also skip a referrer whose account is locked
            // (lib/constants.js REFERRAL_VELOCITY_*, set in api/user.js).
            { _id: referrerId, isBanned: { $ne: true }, accountLocked: { $ne: true } },
            {
                $inc: {
                    wtcBalance: step.reward, lifetimeWtcEarned: step.reward, referralWtcEarned: step.reward,
                    // ⚠️ NEW — Season 3 "777" lottery ticket, awarded only at step1
                    // (channel+community verified) — the earliest point a referral
                    // is confirmed real, not just a link click. See constants.js
                    // LOTTERY_* — tickets can't be bought, only earned this way.
                    ...(step.key === 'referralStep1Done' ? { luckyTickets: 1 } : {}),
                    // ⚠️ NEW (Season 4) — step3 is the LAST of the 3 steps, so
                    // reaching it is exactly the moment this referral becomes
                    // "valid" for withdraw purposes (see api/withdraw.js /
                    // constants.js WITHDRAW_VALID_REFERRALS_PER_WITHDRAW).
                    ...(step.key === 'referralStep3Done' ? { validReferralCount: 1 } : {}),
                },
            },
            { returnDocument: 'after' }
        );

        // ⚠️ NEW (Season 4) — notify the referrer only once, exactly when their
        // referral just became valid (i.e. this step3 update actually applied
        // to a non-banned referrer doc).
        if (step.key === 'referralStep3Done' && referrerUpdate) {
            tgSend(referrerId, validReferralNotification()).catch(() => {});
        }
    }
                    }
