// lib/cycleCleanup.js
//
// 17 Oct 2026 — WITHDRAW-ER POR EARNING DATA CLEANUP (MongoDB free-tier-e jayga bachate)
//
// Kokhon cholbe: shudhu jokhon admin ekta withdrawal APPROVE kore (pay hoye jay). Request-er shomoy na, reject-er shomoy o na —
//   karon request/reject-e ei data diye-i admin decide kore user real kina, ar reject hole user-er shob data thaka dorkar.
//
// Ki hoy (ordor-e):
//   1) Age ekta SUMMARY (trust score + cycle numbers) withdrawal doc-e `cycle` field-e save hoy. Tai pore "ei payout-er shomoy user
//      kemon chilo" admin-er Withdraw History-te dekha jay — raw log na thakleo.
//   2) Tarpor ei user-er raw earning log muche jay:
//        - lootboxLogs (video lootbox claim history)
//        - gigaPostbacks (GigaPub ad_shown record, shudhu 10 min-er purano gulo — notun ad-er proof nosto hoy na)
//        - users.recentAdClaims / recentVideoClaims (ad, video-er timing sample) + adTimes24h (withdraw-er 6-ad record)
//        - script-flag counter (botSuspectCount, botSuspectAt, botReviewAt, withdrawHoldAlertAt, dupWalletAlertAt, promoFails)
//          — admin approve korechhe mane review hoye gese, notun cycle clean shuru.
//
// Ja KOKHONO muchbe NA (ar keno):
//   • completedTasks, referral data (referralCount, validReferralCount, usedValidReferrals, referredBy …) — tumi bolecho task ar refer thakbe.
//   • withdrawals collection — shob withdraw (koybar, kokhon, koto) permanent thakbe.
//   • lifetime counters (lifetimeWtcEarned, lifetimeAdsWatched, lootboxClaimCount) — referral milestone ar admin summary-r jonno lage.
//   • PROMO: `promos.redeemedBy` (je user je code use korechhe) MUCHBE NA. Muchle user abar ekoi code redeem kore bar bar WTC nite parto.
//     Promo-te user-er nijer doc-e kichu thake na, tai "promo data clean" mane ekhane kichu muchar nai — security-r jonno eta ei-ve thak.
//   • Daily token list (usedAdStarts …) ar daily counter — eigulo prottek din-e nijei reset hoy (lib/constants.js dailyResetFields).

import { makeCycleSnapshot, buildTrustReport } from './trustReport.js';
import { buildCycleReport, makeCycleSnapshot as makeCyCounterSnapshot } from './cycleStats.js'; // 18 Oct 2026 — the `cy` counters ("since last withdraw")

export async function cleanupAfterWithdraw(db, userId, withdrawalId) {
    const uid = String(userId);
    const users = db.collection('users');
    const user = await users.findOne({ _id: userId });
    if (!user) return { ok: false, reason: 'user_not_found' };

    // 0) withdraw-er "last 24h-e 6 ad" record (adTimes24h) approve hole SOB SOMOY khorcho hoye jay — snapshot fail korleo.
    //    Tai porer withdrawal-er jonno notun 6 ta ad lagbe (ek-i 6 ad diye duibar withdraw kora jabe na).
    await users.updateOne({ _id: userId }, { $unset: { adTimes24h: '' } }).catch(() => {});

    // 1) summary first (raw data muchar AGE)
    try {
        const report = await buildTrustReport(db, user);
        // 18 Oct 2026: `cy` counters (ads per network, mining, lootbox, tasks, promo, referral … since the last withdraw) are copied into the
        // withdrawal doc BEFORE they are reset below, so 💸 Withdraw History still shows what each payout was made of.
        const cyReport = await buildCycleReport(db, user);
        const snapshot = { ...makeCycleSnapshot(user, report), ...makeCyCounterSnapshot(user, cyReport) };
        if (withdrawalId) await db.collection('withdrawals').updateOne({ _id: withdrawalId }, { $set: { cycle: snapshot } });
    } catch (e) {
        // summary na hole raw data muche felbo na — admin evidence haranor cheye jayga beshi thaka bhalo
        return { ok: false, reason: 'snapshot_failed' };
    }

    // 2) raw logs delete
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const results = await Promise.allSettled([
        db.collection('lootboxLogs').deleteMany({ userId: uid }),
        db.collection('gigaPostbacks').deleteMany({ uid, receivedAt: { $lt: tenMinAgo } }),
        users.updateOne({ _id: userId }, { $unset: {
            recentAdClaims: '', recentVideoClaims: '', recentSpinTimes: '', adTimes24h: '',
            botSuspectCount: '', botSuspectAt: '', botReviewAt: '',
            withdrawHoldAlertAt: '', dupWalletAlertAt: '', promoFails: '',
            cy: '', // 18 Oct 2026: the "since last withdraw" counters restart from 0 (the old numbers live on in the withdrawal's `cycle`)
        } }),
    ]);
    return { ok: true, failed: results.filter(r => r.status === 'rejected').length };
}
