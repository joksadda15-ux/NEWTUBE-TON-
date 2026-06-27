// lib/referral.js — নতুন (Season 2)
//
// রেফারেল রিওয়ার্ড এখন একবারে ৩৫০০ Gold না দিয়ে ৩টা ধাপে দেওয়া হয়, প্রতিটা
// ধাপ যখন referred user (যাকে রেফার করা হয়েছে) প্রথমবার সেই মাইলস্টোনে পৌঁছায়:
//   ধাপ ১: channel + community verify করলে    → referrer পাবে 30 WTC
//   ধাপ ২: ১০টা task সম্পন্ন করলে              → referrer পাবে 60 WTC
//   ধাপ ৩: ২০টা ads সম্পন্ন করলে               → referrer পাবে 130 WTC
//
// প্রতিটা ধাপ মাত্র একবারই দেওয়া হবে — তার জন্য referred user-এর ডকুমেন্টে
// referralStep1Done / Step2Done / Step3Done ফ্ল্যাগ রাখা হচ্ছে।

import {
    REFERRAL_REWARDS,
    REFERRAL_STEP2_TASK_COUNT,
    REFERRAL_STEP3_AD_COUNT,
} from './constants.js';

// stats = { channelVerified?, completedTasksCount?, lifetimeAdsWatched? }
// — যেকোনো একটা বা একাধিক পাস করতে পারেন, যেটা সদ্য changed হয়েছে
export async function maybeAwardReferralMilestones(db, referredUserId, stats = {}) {
    const users = db.collection('users');
    const referredUser = await users.findOne({ _id: referredUserId });
    if (!referredUser || !referredUser.referredBy) return; // কেউ এই ইউজারকে রেফার করেনি

    const referrerId = referredUser.referredBy;
    const setFlags = {};
    const referrerInc = {};

    // ── ধাপ ১: verification ──
    if (stats.channelVerified && !referredUser.referralStep1Done) {
        setFlags.referralStep1Done = true;
        referrerInc.wtcBalance = (referrerInc.wtcBalance || 0) + REFERRAL_REWARDS.step1_verified;
        referrerInc.lifetimeWtcEarned = (referrerInc.lifetimeWtcEarned || 0) + REFERRAL_REWARDS.step1_verified;
    }

    // ── ধাপ ২: ১০ task ──
    if (
        stats.completedTasksCount !== undefined &&
        stats.completedTasksCount >= REFERRAL_STEP2_TASK_COUNT &&
        !referredUser.referralStep2Done
    ) {
        setFlags.referralStep2Done = true;
        referrerInc.wtcBalance = (referrerInc.wtcBalance || 0) + REFERRAL_REWARDS.step2_tenTasks;
        referrerInc.lifetimeWtcEarned = (referrerInc.lifetimeWtcEarned || 0) + REFERRAL_REWARDS.step2_tenTasks;
    }

    // ── ধাপ ৩: ২০ ads ──
    if (
        stats.lifetimeAdsWatched !== undefined &&
        stats.lifetimeAdsWatched >= REFERRAL_STEP3_AD_COUNT &&
        !referredUser.referralStep3Done
    ) {
        setFlags.referralStep3Done = true;
        referrerInc.wtcBalance = (referrerInc.wtcBalance || 0) + REFERRAL_REWARDS.step3_twentyAds;
        referrerInc.lifetimeWtcEarned = (referrerInc.lifetimeWtcEarned || 0) + REFERRAL_REWARDS.step3_twentyAds;
    }

    if (Object.keys(setFlags).length === 0) return; // কোনো নতুন মাইলস্টোন ক্রস হয়নি

    await users.updateOne({ _id: referredUserId }, { $set: setFlags });
    if (Object.keys(referrerInc).length > 0) {
        await users.updateOne({ _id: referrerId }, { $inc: referrerInc });
    }
}
