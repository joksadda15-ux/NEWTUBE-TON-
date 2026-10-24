// lib/referral.js — 23 Oct 2026 (admin): SIMPLE referral reward.
//
//   • The referrer gets REFERRAL_MINING_REWARD (300 WTC) ONE time per friend, when that friend completes their FIRST
//     successful Mining claim (handleMineClaim in api/earn.js — which already needs a server-verified ad).
//   • There are NO other reward steps (no channel / tasks / ads / lootbox rewards any more).
//   • The only other referral income is the 15% withdrawal commission (api/bot.js, paid when the admin approves a withdraw).
//
// Security (so fake accounts can not farm 300 WTC):
//   - the payout flag (referralMineRewardDone) is set with ONE atomic findOneAndUpdate, so double calls can never pay twice;
//   - the FRIEND must be channelVerified, not banned, not accountLocked and not multiAccountFlag at that moment (if not,
//     nothing is paid now; a later mining claim re-checks, so a real user who verifies later still triggers it);
//   - the REFERRER must not be banned / locked (otherwise the flag is rolled back and nothing is credited);
//   - self-referral is blocked.
//
// "Valid referral" (spent by api/withdraw.js, 1 per withdrawal) is a SEPARATE thing and unchanged: the friend needs
// REFERRAL_VALID_ADSGRAM_ADS Adsgram ads AND REFERRAL_STEP2_TASK_COUNT tasks. It pays no WTC.

import {
    REFERRAL_MINING_REWARD,
    REFERRAL_STEP2_TASK_COUNT,
    REFERRAL_VALID_ADSGRAM_ADS,
} from './constants.js';
import { tgSend } from './telegram.js';
import { cyInc, cyMin } from './cycleStats.js';

function validReferralNotification() {
    return (
        `🎉 <b>Congratulations!</b>\n\n` +
        `One of your referrals has been successfully verified ✅\n\n` +
        `You've unlocked <b>1 valid referral</b> — this lets you make your next withdrawal. ` +
        `Keep sharing your invite link to unlock more! 🚀`
    );
}

function miningRewardNotification() {
    return (
        `⛏️ <b>Referral reward!</b>\n\n` +
        `One of your friends just completed their first mining claim.\n` +
        `You earned <b>+${REFERRAL_MINING_REWARD} WTC</b> 🎉`
    );
}

// stats = { lifetimeMined?, ... } — callers pass whatever just changed; only lifetimeMined matters for the WTC reward.
export async function maybeAwardReferralMilestones(db, referredUserId, stats = {}) {
    const users = db.collection('users');
    const referredUser = await users.findOne(
        { _id: referredUserId },
        {
            projection: {
                referredBy: 1, referralMineRewardDone: 1, referralValidDone: 1,
                channelVerified: 1, isBanned: 1, accountLocked: 1, multiAccountFlag: 1,
                completedTasks: 1, lifetimeAdsgramAds: 1, lifetimeMined: 1,
            },
        }
    );
    if (!referredUser || !referredUser.referredBy) return;           // nobody referred this user
    if (referredUser.referredBy === referredUserId) return;          // self-referral guard
    const referrerId = referredUser.referredBy;

    // ── 300 WTC — first successful mining claim of the friend ──
    const mined = (stats.lifetimeMined !== undefined ? stats.lifetimeMined : referredUser.lifetimeMined) || 0;
    const friendClean = referredUser.channelVerified === true && referredUser.isBanned !== true
        && referredUser.accountLocked !== true && referredUser.multiAccountFlag !== true;
    if (mined >= 1 && friendClean && !referredUser.referralMineRewardDone) {
        // atomic: only ONE concurrent call can flip the flag
        const claimed = await users.findOneAndUpdate(
            { _id: referredUserId, referralMineRewardDone: { $ne: true } },
            { $set: { referralMineRewardDone: true, referralMineRewardAt: new Date() } },
            { returnDocument: 'after' }
        );
        if (claimed) {
            const paid = await users.findOneAndUpdate(
                { _id: referrerId, isBanned: { $ne: true }, accountLocked: { $ne: true } },
                {
                    $min: cyMin(),
                    $inc: {
                        ...cyInc('refMilestone', REFERRAL_MINING_REWARD),
                        wtcBalance: REFERRAL_MINING_REWARD, lifetimeWtcEarned: REFERRAL_MINING_REWARD, referralWtcEarned: REFERRAL_MINING_REWARD,
                    },
                },
                { returnDocument: 'after' }
            );
            if (paid) tgSend(referrerId, miningRewardNotification()).catch(() => {});
            else await users.updateOne({ _id: referredUserId }, { $unset: { referralMineRewardDone: '' } }); // referrer banned/locked → nothing paid, un-flag
        }
    }

    // ── "Valid referral" (withdraw gate) — unchanged rules, pays nothing ──
    const tasksOk = (referredUser.completedTasks || []).length >= REFERRAL_STEP2_TASK_COUNT;
    const adsOk = (referredUser.lifetimeAdsgramAds || 0) >= REFERRAL_VALID_ADSGRAM_ADS;
    if (tasksOk && adsOk && !referredUser.referralValidDone) {
        const claimedValid = await users.findOneAndUpdate(
            { _id: referredUserId, referralValidDone: { $ne: true } },
            { $set: { referralValidDone: true } },
            { returnDocument: 'after' }
        );
        if (claimedValid) {
            const referrerUpdate = await users.findOneAndUpdate(
                { _id: referrerId, isBanned: { $ne: true }, accountLocked: { $ne: true } },
                { $inc: { validReferralCount: 1 } },
                { returnDocument: 'after' }
            );
            if (referrerUpdate) tgSend(referrerId, validReferralNotification()).catch(() => {});
        }
    }
}
