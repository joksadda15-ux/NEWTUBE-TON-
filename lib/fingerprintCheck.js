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
    const doc = await fingerprints.findOneAndUpdate(
        { _id: fingerprint },
        {
            $addToSet: { userIds: userId },
            $set: { lastSeenAt: new Date() },
            $setOnInsert: { firstSeenAt: new Date() },
        },
        { upsert: true, returnDocument: 'before' } // 'before' = upsert-এর আগের অবস্থা, যদি ছিল
    );

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
