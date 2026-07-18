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
//   bannedAt: Date,                     // ⚠️ NEW — set the moment isBanned becomes true (see api/bot.js). Powers the
//                                        //   60-day cleanup TTL below; cleared ($unset) if the user is unbanned.
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
// ⚠️ NEW — a partial TTL index on `bannedAt` (see setupIndexes below) makes
// MongoDB auto-delete a user's ENTIRE document 60 days after they were
// banned (isBanned:true only — a merely multiAccountFlag'd-but-not-yet-banned
// user is NEVER touched by this, since they may still be reinstated after
// review). This frees free-tier storage from long-dead banned accounts.
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: bannedTelegramIds  (⚠️ NEW — permanent ban registry, see api/bot.js)
// ──────────────────────────────────────────────────────────────────
// { _id: "123456789", bannedAt: Date }
//
// Tiny, NO-TTL, forever-persisting record of every currently-banned
// Telegram ID. Exists ONLY so that once the full `users` document above
// gets auto-deleted after 60 days, that Telegram ID can't simply reopen the
// app and get a fresh, un-banned account (api/user.js's handleInit checks
// this registry before creating any new user). Kept in perfect sync with
// `users.isBanned` by api/bot.js's markBanned()/markUnbanned() helpers —
// an admin unban always removes the ID here too.
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
// ⚠️ NEW — a TTL index on `lastSeenAt` (see setupIndexes below) auto-deletes
// a fingerprint doc 180 days after its last signup activity — old/inactive
// device fingerprints have no further multi-account-detection value and were
// accumulating forever on the free-tier database.
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
// COLLECTION: gifts  (admin-sent surprise gifts — see api/gift.js)
// ──────────────────────────────────────────────────────────────────
// { _id: ObjectId, userId: "123456789", amount: 50, reason: "...",
//   status: "pending" | "claimed", createdAt: Date, claimedAt: Date }
//
// ⚠️ NEW — a partial TTL index on `claimedAt` (see setupIndexes below) makes
// MongoDB auto-delete a gift doc 30 days after it's claimed. Pending gifts
// (no claimedAt) are never touched by this index — only claimed-and-done
// gifts get cleaned up, freeing free-tier storage with zero functional risk.
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
    // ⚠️ NEW — partial TTL index: ONLY documents with isBanned:true expire
    // (60 days after bannedAt). A merely multiAccountFlag'd user (not yet
    // banned) is NEVER touched — this only deletes confirmed, admin-banned
    // accounts' full documents. See api/bot.js + api/user.js for the
    // companion `bannedTelegramIds` registry that keeps the ban itself
    // permanent even after this document is gone.
    await db.collection('users').createIndex(
        { bannedAt: 1 },
        { expireAfterSeconds: 5184000, partialFilterExpression: { isBanned: true } }
    );
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
    // ⚠️ NEW — TTL index: a fingerprint doc auto-deletes 180 days after its
    // last signup activity. Old/inactive-device fingerprints have no further
    // multi-account-detection value and were accumulating forever on the
    // free-tier database.
    await db.collection('fingerprints').createIndex({ lastSeenAt: 1 }, { expireAfterSeconds: 15552000 });

    // ⚠️ NEW — partial TTL index: ONLY documents with status:'claimed' expire
    // (30 days after claimedAt). Pending gifts (no claimedAt yet, or status
    // still 'pending') are completely unaffected by this index — they never
    // auto-expire. This cleans up claimed-and-done gift records, which have
    // zero further use once claimed, without ever risking a pending gift.
    await db.collection('gifts').createIndex(
        { claimedAt: 1 },
        { expireAfterSeconds: 2592000, partialFilterExpression: { status: 'claimed' } }
    );
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
