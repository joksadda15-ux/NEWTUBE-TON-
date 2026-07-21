// scripts/migrateUsdtToDogs.js — ONE-TIME migration for Season 3
//
// চালানোর কমান্ড: node scripts/migrateUsdtToDogs.js
//
// কী করে:
//   যেসব user আগের সিস্টেমে WTC কনভার্ট করে usdtBalance জমিয়েছিল (কিন্তু
//   এখনো withdraw করেনি), তাদের সেই ব্যালান্স হারিয়ে যাবে না — এটা
//   dogsBalance-এ রূপান্তর করে দেয়, তারপর পুরোনো usdtBalance ফিল্ডটা মুছে
//   ফেলে (যাতে কোথাও ভুলবশত আবার ব্যবহার না হয়)।
//
//   রূপান্তরের হার: শেষ যে রেট লাইভ ছিল (1 USD = 30,000 DOGS, আগের
//   DOGS_PER_USD constant থেকে) — অর্থাৎ dogsBalance += usdtBalance * 30000।
//   এটা শুধু এই এক-বারের মাইগ্রেশনের জন্যই ব্যবহার হচ্ছে; নতুন সিস্টেমে আর
//   কোথাও USD ধারণা নেই, সরাসরি WTC → DOGS (3:1) হিসেব হয়।
//
//   এছাড়া old addressLockedAt/lockedWithdrawMethod:'binance' রেকর্ড থাকা
//   user-দের জন্য আলাদা কিছু করার দরকার নেই — api/withdraw.js এখন runtime-এ
//   নিজে থেকেই সেই lock উপেক্ষা করে (getAddressLockStatus দেখুন), তাই এই
//   স্ক্রিপ্টে সেটার জন্য কোনো migration স্টেপ নেই।
//
// ⚠️ এটা চালানোর আগে অবশ্যই DB backup/snapshot নিয়ে রাখুন (MongoDB Atlas ->
// Backup, অথবা mongodump)। এই স্ক্রিপ্ট idempotent — usdtBalance ফিল্ড না
// থাকা user-দের কিছুই বদলাবে না, তাই দ্বিতীয়বার চালালেও সমস্যা নেই।

import { connectToDatabase } from '../lib/mongodb.js';

// এই রেটটা আগের lib/constants.js-এর DOGS_PER_USD ছিল — শুধু এই মাইগ্রেশনের
// জন্য এখানে হার্ডকোড করা, নতুন কোডে আর কোথাও এই constant নেই।
const LEGACY_USD_TO_DOGS_RATE = 30000;

async function migrate() {
    const { db, client } = await connectToDatabase();
    const users = db.collection('users');

    const cursor = users.find({ usdtBalance: { $exists: true, $gt: 0 } });
    let migrated = 0;
    let totalDogsAdded = 0;

    while (await cursor.hasNext()) {
        const user = await cursor.next();
        const dogsToAdd = Math.round((user.usdtBalance || 0) * LEGACY_USD_TO_DOGS_RATE);

        await users.updateOne(
            { _id: user._id },
            {
                $inc: { dogsBalance: dogsToAdd },
                $unset: { usdtBalance: '' },
            }
        );

        migrated++;
        totalDogsAdded += dogsToAdd;
        console.log(`  user ${user._id}: ${user.usdtBalance} USDT-equivalent → +${dogsToAdd.toLocaleString()} DOGS`);
    }

    console.log(`\n✅ Migration done — ${migrated} user(s) migrated, ${totalDogsAdded.toLocaleString()} total DOGS credited.`);
    await client.close();
}

migrate().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
