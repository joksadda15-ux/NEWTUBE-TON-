// lib/fingerprintCheck.js
//
// একই fingerprint হ্যাশ আগে অন্য কোনো userId-এর সাথে দেখা গিয়েছিল কিনা চেক করে।
//
// ⚠️ CHANGED (per admin's explicit decision, after being warned of the
// trade-off): this used to ONLY set multiAccountFlag=true for later manual
// admin review — deliberately soft, to avoid banning genuine shared-device
// users (family, cyber cafe) on a false positive. Given active, confirmed
// organized abuse (script-based multi-account farming targeting this app),
// the admin chose to escalate: a detected duplicate-device signup is now
// AUTO-SUSPENDED immediately (isBanned:true + the permanent bannedTelegramIds
// registry, via lib/banRegistry.js — the same logic a manual admin ban uses).
//
// ⚠️ The false-positive risk is real and unchanged by this update — a
// second family member or cyber-cafe user on the same device WILL be
// auto-suspended on signup, same as an actual multi-account farmer. This is
// mitigated, not eliminated, by: (1) it's a soft/reversible suspension, not
// a permanent deletion — one tap to Unban in the admin panel undoes it
// completely; (2) only the NEW (2nd+) account on a device is touched, the
// original first account is never affected; (3) the app's ban screen should
// offer a "Request Review" path for a wrongly-suspended user to appeal.
//
// COLLECTION: fingerprints
// { _id: "<sha256 hash>", userIds: ["111", "222"], firstSeenAt: Date, lastSeenAt: Date }

import { banUser } from './banRegistry.js';

export async function checkAndRecordFingerprint(db, userId, fingerprint) {
    if (!fingerprint || typeof fingerprint !== 'string' || fingerprint.length < 16) {
        return { flagged: false }; // fingerprint না পাঠালে silently skip — ব্লক করার কারণ না
    }

    const fingerprints = db.collection('fingerprints');

    // ── ATOMIC upsert: এই হ্যাশ আগে দেখা গিয়েছিল কিনা জানার আগেই userId যুক্ত করে দিন ──
    let doc;
    try {
        doc = await fingerprints.findOneAndUpdate(
            { _id: fingerprint },
            {
                $addToSet: { userIds: userId },
                $set: { lastSeenAt: new Date() },
                $setOnInsert: { firstSeenAt: new Date() },
            },
            { upsert: true, returnDocument: 'before' } // 'before' = upsert-এর আগের অবস্থা, যদি ছিল
        );
    } catch (err) {
        if (err?.code === 11000) {
            // অন্য একটা concurrent রিকোয়েস্ট প্রথমে ডকুমেন্টটা তৈরি করে ফেলেছে — এখন সেটা update করুন
            doc = await fingerprints.findOneAndUpdate(
                { _id: fingerprint },
                { $addToSet: { userIds: userId }, $set: { lastSeenAt: new Date() } },
                { upsert: true, returnDocument: 'before' }
            );
        } else {
            throw err;
        }
    }

    const priorUserIds = doc?.userIds || [];
    const siblings = priorUserIds.filter((id) => id !== userId);

    if (siblings.length > 0) {
        // ⚠️ CHANGED — auto-suspend this (new) account immediately, using the
        // same registry logic as a manual admin ban (lib/banRegistry.js),
        // instead of only flagging for later review. multiAccountFlag is
        // still set too, so the admin panel's flagged-user views keep working.
        await banUser(db, userId, {
            multiAccountFlag: true,
            multiAccountSiblings: siblings,
            multiAccountFingerprint: fingerprint,
        });
        return { flagged: true, siblings };
    }

    return { flagged: false };
}
