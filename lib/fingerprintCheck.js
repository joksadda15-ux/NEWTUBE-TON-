// lib/fingerprintCheck.js
//
// একই fingerprint হ্যাশ আগে অন্য কোনো userId-এর সাথে দেখা গিয়েছিল কিনা চেক করে।
// থাকলে নতুন ইউজারকে multiAccountFlag=true করে দেওয়া হয় — কিন্তু ban করা হয় না,
// শুধু admin panel-এ review করার জন্য চিহ্নিত হয়ে থাকে। এটা ইচ্ছাকৃতভাবে soft —
// shared device (পরিবার, সাইবার ক্যাফে) ব্যবহারকারী real user-কে ভুলভাবে ban
// করার ঝুঁকি এড়াতে।
//
// COLLECTION: fingerprints
// { _id: "<sha256 hash>", userIds: ["111", "222"], firstSeenAt: Date, lastSeenAt: Date }

export async function checkAndRecordFingerprint(db, userId, fingerprint) {
    if (!fingerprint || typeof fingerprint !== 'string' || fingerprint.length < 16) {
        return { flagged: false }; // fingerprint না পাঠালে silently skip — ব্লক করার কারণ না
    }

    const fingerprints = db.collection('fingerprints');

    // ── ATOMIC upsert: এই হ্যাশ আগে দেখা গিয়েছিল কিনা জানার আগেই userId যুক্ত করে দিন ──
    // ⚠️ দুইটা ব্র্যান্ড-নিউ ডিভাইস signup ঠিক একই মিলিসেকেন্ডে এলে upsert-insert
    // race-এ MongoDB কখনো কখনো E11000 duplicate-key ছুড়তে পারে (নথিভুক্ত caveat) —
    // সেটা ধরে একবার retry করা হচ্ছে, যাতে সেই বিরল মুহূর্তে রিকোয়েস্টটা fail না করে।
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
        await db.collection('users').updateOne(
            { _id: userId },
            { $set: { multiAccountFlag: true, multiAccountSiblings: siblings, multiAccountFingerprint: fingerprint } }
        );
        return { flagged: true, siblings };
    }

    return { flagged: false };
}
