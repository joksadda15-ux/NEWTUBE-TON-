// models/schema.js — SEASON 2 স্কিমা (single WTC currency)
//
// চালানোর কমান্ড: node models/schema.js
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: users
// ──────────────────────────────────────────────────────────────────
// {
//   _id: "123456789",                  // Telegram user id
//   firstName: "User",
//   telegramUsername: "N/A",
//
//   // ── একটাই কারেন্সি ──
//   wtcBalance: 0,
//   lifetimeWtcEarned: 0,
//   pendingVideoWTC: 0,                 // video দেখে জমা, claim করার আগে এখানে থাকে (min 200 দরকার claim-এ)
//
//   // ── রেফারেল (৩-ধাপ মাইলস্টোন সিস্টেম + weekly competition) ──
//   referralCount: 0,                   // lifetime, never reset
//   weeklyReferralCount: 0,             // ⚠️ NEW — resets every Friday by api/cron/weeklyReferral.js
//   totalInvites: 0,
//   referredBy: null,
//   referralStep1Done: false,           // verify করলে (30 WTC referrer পায়)
//   referralStep2Done: false,           // 10 task করলে (60 WTC)
//   referralStep3Done: false,           // 25 ads করলে (130 WTC)
//
//   completedTasks: [],
//   isBanned: false,
//   channelVerified: false,
//   withdrawalCount: 0,
//   lastWithdrawDate: "",
//
//   lifetimeAdsWatched: 0,
//   adsWatchedToday: 0,
//   adsgramDailyCountToday: 0,
//   adsgramSpecialCountToday: 0,
//   monetagCountToday: 0,
//   gigaCountToday: 0,
//
//   dailyVideoWtcMined: 0,
//   tasksCompletedToday: 0,
//   lastResetDate: "06/27/2026",
//   welcomeBonusClaimed: false,
//   createdAt: Date,
//
//   // ── multi-account flagging (admin-review, auto-ban না) ──
//   multiAccountFlag: false,
//   multiAccountSiblings: [],           // অন্য userId গুলো যারা একই fingerprint শেয়ার করে
//   multiAccountFingerprint: "..."      // (optional) যে হ্যাশ ম্যাচ করেছে
// }
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: fingerprints  (multi-account detection-এর জন্য)
// ──────────────────────────────────────────────────────────────────
// {
//   _id: "<sha256 hash>",               // client/fingerprint.js থেকে আসা হ্যাশ
//   userIds: ["111", "222"],            // এই ডিভাইস থেকে যত userId রেজিস্টার হয়েছে
//   firstSeenAt: Date,
//   lastSeenAt: Date
// }
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: videos
// ──────────────────────────────────────────────────────────────────
// { _id: ObjectId, videoId: "dQw4w9WgXcQ", title: "...", isActive: true, createdAt: Date }
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: tasks
// ──────────────────────────────────────────────────────────────────
// {
//   _id: ObjectId, title: "...", url: "...", channelId: "@...",
//   category: "channel" | "partner",
//   rewardWtc: 60,                       // নতুন ফিল্ড নাম (পুরোনো rewardGold এখনো fallback হিসেবে কোডে আছে)
//   isApproved: true, limit: 0, completionCount: 0, createdAt: Date
// }
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: withdrawals
// ──────────────────────────────────────────────────────────────────
// {
//   _id: ObjectId, userId: "123456789", method: "binance" | "tonkeeper",
//   details: "address/uid",
//   wtcAmount: 2000, feeWtc: 100, feePercent: 5, netWtc: 1900,
//   cashAmount: 0.095, currency: "USDT" | "TON",
//   adsRequired: 15, status: "pending" | "approved" | "rejected", createdAt: Date
// }
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: promos
// ──────────────────────────────────────────────────────────────────
// { _id: ObjectId, code: "482913", reward: 50, maxUses: 50, usedCount: 0, redeemedBy: [], expiresAt: Date, createdAt: Date }
//
// ⚠️ NEW — a TTL index on `expiresAt` (see setupIndexes below) makes MongoDB
// auto-delete a promo document once its `expiresAt` timestamp has passed —
// no separate cleanup job needed. MongoDB's TTL background sweep runs
// roughly every 60 seconds, so deletion happens within about a minute of
// expiry (well inside the "24hr" the admin asked for) rather than exactly
// at 24hr — the code was already dead/unusable the instant it expired
// anyway, so slightly-earlier deletion costs nothing. This matters
// specifically because the admin is on MongoDB Atlas's free (M0) tier,
// which caps total storage — expired promo docs piling up forever was
// wasted space for data with zero further use.
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: weeklyReferralReports  (⚠️ NEW — history of past weekly
// referral competition results, written by bot.js's a_weekly_reset_confirm
// or the optional api/cron/weeklyReferral.js, read back by a_weekly_history)
// ──────────────────────────────────────────────────────────────────
// {
//   _id: ObjectId,
//   weekEndedAt: Date,
//   totalParticipants: 14,               // how many users had any weeklyReferralCount > 0 that week
//   winners: [                            // only users who met WEEKLY_REFERRAL_MIN_COUNT, capped at WEEKLY_REFERRAL_MAX_WINNERS — can be fewer than the cap, or empty
//     { userId: "123456789", firstName: "User", telegramUsername: "user1", weeklyReferralCount: 14 },
//   ],
// }
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: config
// ──────────────────────────────────────────────────────────────────
// { _id: "appConfig", ... } — ভবিষ্যতে অ্যাডমিন প্যানেল থেকে রেট/লিমিট বদলানোর জন্য রিজার্ভ করা

import { connectToDatabase } from '../lib/mongodb.js';

async function setupIndexes() {
    const { db, client } = await connectToDatabase();
    console.log('Indexes বানানো শুরু হচ্ছে...');

    await db.collection('users').createIndex({ referredBy: 1 });
    await db.collection('users').createIndex({ isBanned: 1 });
    // ⚠️ NEW — speeds up the weekly cron's top-N sort (api/cron/weeklyReferral.js)
    await db.collection('users').createIndex({ weeklyReferralCount: -1 });
    await db.collection('videos').createIndex({ isActive: 1, createdAt: -1 });
    await db.collection('tasks').createIndex({ isApproved: 1, category: 1, createdAt: -1 });
    await db.collection('withdrawals').createIndex({ userId: 1, createdAt: -1 });
    await db.collection('withdrawals').createIndex({ details: 1 });
    await db.collection('promos').createIndex({ code: 1 }, { unique: true });
    // ⚠️ NEW — TTL index: MongoDB auto-deletes a promo doc once `expiresAt`
    // is in the past. expireAfterSeconds:0 means "delete exactly at the
    // stored expiresAt time" (not 0 seconds after creation — the field
    // itself already holds the future expiry timestamp, set in bot.js as
    // createdAt + 24h). This is what keeps expired-and-useless promo codes
    // from sitting in the free-tier database forever.
    await db.collection('promos').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection('fingerprints').createIndex({ lastSeenAt: 1 });
    // ⚠️ NEW — speeds up a_weekly_history's "most recent report" lookup
    await db.collection('weeklyReferralReports').createIndex({ weekEndedAt: -1 });

    // TTL index — adminState documents automatically expire after 1 hour.
    // This cleans up abandoned mid-flow states (e.g. admin started Add Task but cancelled)
    // without any manual cleanup needed.
    await db.collection('adminState').createIndex({ updatedAt: 1 }, { expireAfterSeconds: 3600 });

    console.log('সব index বানানো শেষ ✅');
    await client.close();
}

setupIndexes().catch((err) => {
    console.error('Index setup ব্যর্থ হয়েছে:', err);
    process.exit(1);
});
