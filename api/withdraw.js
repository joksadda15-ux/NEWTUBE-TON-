// api/withdraw.js — single-step withdraw.
//
// The user types a WTC amount (min MIN_WITHDRAW_WTC), picks a method
// (Binance UID / Tonkeeper) and submits.
//
// Fees (lib/constants.js): WITHDRAW_FEE_PERCENT, then WITHDRAW_SECOND_FEE_PERCENT
// on the remainder (currently 15% and 0%, so the user nets 85% of face value).
// See calcNetUsd().
//
// Requirements, all from lib/constants.js:
//   • WITHDRAW_TASKS_REQUIRED lifetime tasks (one-time)
//   • WITHDRAW_ADS_REQUIRED ads in the LAST WITHDRAW_ADS_WINDOW_HOURS hours (rolling, exact time of each ad)
//   • (17 Oct 2026: the spin requirement was REMOVED together with the Spin Wheel)
//   • account age gate on the first withdrawal (WITHDRAW_MIN_ACCOUNT_AGE_HOURS, 0 = off)
//
// Referral gate: the first FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE withdrawals need
// no valid referral but are capped at FREE_WITHDRAW_MAX_USD each. After that,
// 2 valid referrals are required for EACH withdrawal (WITHDRAW_REFERRALS_PER_WITHDRAW), max WITHDRAW_MAX_WTC_WITH_REFERRAL (100,000 WTC) each.
// See lib/referral.js for how a referral becomes valid.
//
// Wallet lock: the method + address of the first withdrawal become the user's
// permanent wallet. Later requests ignore whatever the client sends and use the
// locked wallet. The only way to change it is the one-time wrong-address flow
// in api/bot.js.
//
//   GET  /api/withdraw?action=status&initData=...   → balance + full eligibility snapshot
//   GET  /api/withdraw?action=history&initData=...
//   POST /api/withdraw   body: { initData, method, details, wtcAmount }

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend, escHtml } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { buildCycleReport, renderCycleShort } from '../lib/cycleStats.js'; // 18 Oct 2026 — "since last withdraw" numbers in the admin request
import {
    WITHDRAW_METHODS, WITHDRAW_FEE_PERCENT, WITHDRAW_SECOND_FEE_PERCENT, MIN_WITHDRAW_WTC, WALLET_CHANGE_MAX_REQUESTS,
    FREE_WITHDRAW_MAX_WTC, FREE_WITHDRAW_MAX_USD, FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE, WITHDRAW_ADS_WINDOW_HOURS,
    WITHDRAW_TASKS_REQUIRED, WITHDRAW_ADS_REQUIRED, WITHDRAW_REFERRALS_PER_WITHDRAW, WITHDRAW_MAX_WTC_WITH_REFERRAL, WITHDRAW_USD_PER_VALID_REFERRAL,
    WITHDRAW_MIN_ACCOUNT_AGE_HOURS,
    WITHDRAW_PROCESS_MIN_HOURS, WITHDRAW_PROCESS_MAX_HOURS,
    todayBD, fmtBDDateTime, WTC_PER_USD, WITHDRAWALS_OPEN, BOT_SUSPECT_HOLD_COUNT,
} from '../lib/constants.js';

const MIN_ACCOUNT_AGE_MS = WITHDRAW_MIN_ACCOUNT_AGE_HOURS * 60 * 60 * 1000;

// Hours remaining until user.createdAt + WITHDRAW_MIN_ACCOUNT_AGE_HOURS. 0 once eligible.
function accountAgeHoursRemaining(user) {
    const createdAt = user.createdAt ? new Date(user.createdAt).getTime() : 0;
    const eligibleAt = createdAt + MIN_ACCOUNT_AGE_MS;
    return Math.max(0, Math.ceil((eligibleAt - Date.now()) / (60 * 60 * 1000)));
}

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

// Binance UIDs are digits, Tonkeeper/TON addresses are base64url or raw "0:hex".
// No whitespace and no HTML characters; the length bounds only stop junk — the
// admin's "Wrong Address" button handles addresses that are well-formed but wrong.
const WALLET_DETAILS_RE = /^[A-Za-z0-9_\-:.+\/=]{5,100}$/;

// wtcAmount → net USDT the user actually receives, after both fees are applied
// one after the other (second fee is taken on what is left after the first).
// 15 Oct 2026: the fee now depends on the method (Binance 20%, Tonkeeper 10% — WITHDRAW_METHODS[m].feePercent).
function calcNetUsd(wtcAmount, method) {
    const grossUsd = wtcAmount / WTC_PER_USD;
    const feePercent = WITHDRAW_METHODS[method]?.feePercent ?? WITHDRAW_FEE_PERCENT;
    const afterFirstFee = grossUsd * (1 - feePercent / 100);
    const netUsd = afterFirstFee * (1 - WITHDRAW_SECOND_FEE_PERCENT / 100);
    return { grossUsd, netUsd };
}

// ── GET ?action=status — everything the withdraw screen needs in one call ──
// 17 Oct 2026 — ROLLING 24-HOUR ad count. Every counted ad (GigaPub / Adsgram Special) stores its exact time in users.adTimes24h
// (api/earn.js). The withdraw rule is "WITHDRAW_ADS_REQUIRED ads inside the last WITHDRAW_ADS_WINDOW_HOURS hours" — counted from each
// ad's own timestamp, not from the Bangladesh calendar day. The same rule is re-checked atomically in the gate update below.
const adsWindowMs = () => WITHDRAW_ADS_WINDOW_HOURS * 3600 * 1000;
const countRecentAds = (user) => (user.adTimes24h || []).filter(t => Number(t) >= Date.now() - adsWindowMs()).length;

async function handleStatus(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const users = db.collection('users');
    const today = await ensureDailyReset(users, id);
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const adsToday = countRecentAds(user); // 17 Oct 2026: rolling last-24h count (was today's calendar count)
    const tasksLifetime = (user.completedTasks || []).length;
    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    // the first N withdrawals are referral-free (capped); the gate activates after that.
    const withdrawalsDone = user.withdrawalCount || 0;
    const isFreePhase = withdrawalsDone < FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE;
    const validAvailable = Math.max(0, (user.validReferralCount || 0) - (user.usedValidReferrals || 0));
    // account-age gate only applies to the first withdrawal ever (see
    // WITHDRAW_MIN_ACCOUNT_AGE_HOURS in lib/constants.js for why).
    const hoursRemaining = isFirstWithdraw ? accountAgeHoursRemaining(user) : 0;

    return res.status(200).json({
        ok: true,
        wtcBalance: user.wtcBalance || 0,
        minWithdrawWtc: MIN_WITHDRAW_WTC,
        feePercent: WITHDRAW_FEE_PERCENT,
        // 15 Oct 2026: promised payout window per method (Tonkeeper 1–5h, Binance 3–48h)
        processingHoursByMethod: Object.fromEntries(Object.entries(WITHDRAW_METHODS).map(([k, v]) => [k, v.processHours || { min: WITHDRAW_PROCESS_MIN_HOURS, max: WITHDRAW_PROCESS_MAX_HOURS }])),
        feePercents: Object.fromEntries(Object.entries(WITHDRAW_METHODS).map(([k, v]) => [k, v.feePercent ?? WITHDRAW_FEE_PERCENT])),
        secondFeePercent: WITHDRAW_SECOND_FEE_PERCENT,
        // Change-wallet request state (see handleWalletChange below). status: null | 'pending' | 'approved'
        walletChange: {
            status: user.walletChangeStatus || null,
            requestsUsed: user.walletChangeRequests || 0,
            requestsLeft: Math.max(0, WALLET_CHANGE_MAX_REQUESTS - (user.walletChangeRequests || 0)),
        },
        withdrawalsOpen: WITHDRAWALS_OPEN,
        // Promised payout window (display only).
        processingHours: { min: WITHDRAW_PROCESS_MIN_HOURS, max: WITHDRAW_PROCESS_MAX_HOURS },
        // Wallet lock (see WALLET_CHANGE_PENALTY_PERCENT, lib/constants.js).
        // null = no withdrawal yet; the form is shown and the wallet locks on first submit.
        withdrawPending: !!user.withdrawPending,
        lockedWallet: (user.lockedWalletMethod && user.lockedWalletAddress)
            ? { method: user.lockedWalletMethod, address: user.lockedWalletAddress }
            : null,
        withdrawRequirements: {
            adsRequired: WITHDRAW_ADS_REQUIRED, adsWatchedToday: adsToday, adsWindowHours: WITHDRAW_ADS_WINDOW_HOURS, adsMet: adsToday >= WITHDRAW_ADS_REQUIRED, // adsWatchedToday keeps its old key name (older app versions) but now means 'ads in the last 24h'
            tasksRequired: WITHDRAW_TASKS_REQUIRED, tasksHave: tasksLifetime, tasksMet: tasksLifetime >= WITHDRAW_TASKS_REQUIRED,
            accountAgeRequiredHours: isFirstWithdraw ? WITHDRAW_MIN_ACCOUNT_AGE_HOURS : 0,
            accountAgeHoursRemaining: hoursRemaining,
            accountAgeMet: hoursRemaining === 0,
        },
        referralRequirement: {
            isFirstWithdrawFree: isFirstWithdraw, // kept for older clients
            isFreePhase,
            freeWithdrawalsTotal: FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE,
            freeWithdrawalsLeft: Math.max(0, FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE - withdrawalsDone),
            freeWithdrawMaxUsd: FREE_WITHDRAW_MAX_USD,
            freeWithdrawMaxWtc: FREE_WITHDRAW_MAX_WTC,
            // frontend can show this cap upfront instead of letting
            // the user submit and only then find out their free first
            // withdrawal is capped.
            firstWithdrawMaxWtc: isFreePhase ? FREE_WITHDRAW_MAX_WTC : null,
            // replaces the old flat `perWithdraw: 1`. Referrals
            // needed now scale with the withdrawal amount (see
            // requiredReferralsForUsd, lib/constants.js) — not known until
            // the user types an amount, so the RATE is reported instead;
            // frontend computes Math.ceil(enteredUsd / usdPerReferral) live.
            usdPerReferral: WITHDRAW_USD_PER_VALID_REFERRAL, // legacy key for old app versions (no longer used for the calculation)
            // 20 Oct 2026: flat rule — after the free withdrawals every withdrawal needs this many valid referrals and is capped at maxWtcWithReferral.
            referralsPerWithdraw: WITHDRAW_REFERRALS_PER_WITHDRAW,
            maxWtcWithReferral: isFreePhase ? null : WITHDRAW_MAX_WTC_WITH_REFERRAL,
            maxWtcWithReferralTotal: WITHDRAW_MAX_WTC_WITH_REFERRAL,
            validReferralsAvailable: validAvailable,
            needsReferral: !isFreePhase,
            // Baseline-only — "do they have at least 1", not the final
            // check for whatever amount they end up entering. handleCreate
            // re-verifies the real, amount-based requirement at submit time.
            met: isFreePhase || validAvailable >= WITHDRAW_REFERRALS_PER_WITHDRAW,
        },
    });
}

// ── GET ?action=history ──
async function handleHistory(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const withdrawals = db.collection('withdrawals');
    const list = await withdrawals
        .find({ userId: id, status: { $in: ['pending', 'approved'] } })
        .sort({ createdAt: -1 })
        .limit(30)
        .project({ userId: 0, username: 0 })
        .toArray();

    return res.status(200).json({ ok: true, history: list });
}

// ── POST — single-step withdraw create ──
async function handleCreate(req, res, db) {
    if (!WITHDRAWALS_OPEN) {
        return res.status(403).json({ ok: false, error: 'withdrawals_closed', message: 'Withdrawals are currently closed. Any previously submitted request will still be processed.' });
    }

    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    let { method, details } = req.body || {};
    const wtcAmount = Math.floor(Number(req.body?.wtcAmount));

    if (!Number.isFinite(wtcAmount) || wtcAmount <= 0) return res.status(400).json({ ok: false, error: 'invalid_amount' });
    if (wtcAmount < MIN_WITHDRAW_WTC) {
        return res.status(400).json({
            ok: false, error: 'below_minimum',
            message: `Minimum ${MIN_WITHDRAW_WTC.toLocaleString()} WTC required to withdraw.`,
        });
    }

    const users = db.collection('users');
    const today = await ensureDailyReset(users, id);
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    // ── wallet lock (see WALLET_CHANGE_PENALTY_PERCENT, lib/constants.js) ──
    const hasLockedWallet = !!(user.lockedWalletMethod && user.lockedWalletAddress);
    if (hasLockedWallet) {
        // Ignore whatever the client sent — always use the locked wallet, so a
        // tampered/stale client can't redirect a payout to another address.
        method = user.lockedWalletMethod;
        details = user.lockedWalletAddress;
    } else {
        // First-ever withdrawal: method + address come from the client this one
        // time and get locked in below once the request succeeds.
        if (!method || !details) return res.status(400).json({ ok: false, error: 'missing_fields' });
        details = typeof details === 'string' ? details.trim() : '';
        if (!WALLET_DETAILS_RE.test(details)) {
            return res.status(400).json({ ok: false, error: 'invalid_address', message: 'That address/UID does not look valid. Check it and try again.' });
        }
    }

    // hasOwn: plain WITHDRAW_METHODS[method] would also accept "__proto__" / "constructor".
    if (typeof method !== 'string' || !Object.hasOwn(WITHDRAW_METHODS, method)) {
        return res.status(400).json({ ok: false, error: 'invalid_method' });
    }
    const methodConfig = WITHDRAW_METHODS[method];
    // Referral-velocity auto-lock (lib/constants.js REFERRAL_VELOCITY_*, set in
    // api/user.js): softer than a ban — balance stays, withdrawals are held
    // until an admin reviews and either unlocks or bans.
    if (user.accountLocked) {
        return res.status(403).json({
            ok: false, error: 'account_locked',
            message: 'Your account is temporarily locked for review. Please contact support.',
        });
    }

    // ── 17 Oct 2026 — SECURITY GATE 1: script-suspicion HOLD ──
    // lib/botGuard.js adds +1 to users.botSuspectCount every time an account trips a script rule (alert OR lock).
    // At BOT_SUSPECT_HOLD_COUNT flags the account can't create a withdrawal; the admin gets ONE alert per 24h with
    // Lock / Profile / Ban buttons and decides. "Unlock" in the admin panel resets the counter. Nobody is auto-banned.
    if ((user.botSuspectCount || 0) >= BOT_SUSPECT_HOLD_COUNT) {
        if (ADMIN_ID) {
            const holdMark = await users.updateOne(
                { _id: id, $or: [{ withdrawHoldAlertAt: { $exists: false } }, { withdrawHoldAlertAt: { $lt: new Date(Date.now() - 24 * 3600 * 1000) } }] },
                { $set: { withdrawHoldAlertAt: new Date() } }
            );
            if (holdMark.modifiedCount > 0) {
                tgSend(ADMIN_ID,
                    `🛑 <b>Withdrawal HELD — script flags</b>\n\nUser <code>${id}</code>${verified.user.username ? ' (@' + escHtml(verified.user.username) + ')' : ''} tried to withdraw <b>${wtcAmount.toLocaleString()} WTC</b>, but this account has <b>${user.botSuspectCount}</b> script-pattern flags. No request was created and nothing was taken from the balance.`,
                    { reply_markup: { inline_keyboard: [
                        [{ text: '🔒 Lock', callback_data: `lock_${id}` }, { text: '👤 User Profile', callback_data: `lookup_${id}` }],
                        [{ text: '🚫 Ban User', callback_data: `ban_${id}` }, { text: '🔓 Clear flags', callback_data: `unlock_${id}` }],
                    ] } }
                ).catch(() => {});
            }
        }
        return res.status(403).json({
            ok: false, error: 'account_under_review',
            message: 'Your account is under a security review. Please contact support.',
        });
    }

    // ── 17 Oct 2026 — SECURITY GATE 2: one wallet = one account ──
    // The same payout address/UID on a different account is the classic multi-account farm signature.
    // Checked against BOTH the other users' locked wallets AND every earlier withdrawal request (even rejected/banned ones).
    // The request is refused (nothing deducted) and the admin gets ONE alert per 24h per user.
    {
        const dupUser = await users.findOne({ _id: { $ne: id }, lockedWalletAddress: details }, { projection: { _id: 1 } });
        const dupWd = dupUser ? null : await db.collection('withdrawals').findOne({ userId: { $ne: id }, details }, { projection: { userId: 1 } });
        const dupId = dupUser?._id || dupWd?.userId;
        if (dupId) {
            if (ADMIN_ID) {
                const dupMark = await users.updateOne(
                    { _id: id, $or: [{ dupWalletAlertAt: { $exists: false } }, { dupWalletAlertAt: { $lt: new Date(Date.now() - 24 * 3600 * 1000) } }] },
                    { $set: { dupWalletAlertAt: new Date() } }
                );
                if (dupMark.modifiedCount > 0) {
                    tgSend(ADMIN_ID,
                        `🧬 <b>Same wallet on 2 accounts</b>\n\nUser <code>${id}</code> tried to withdraw to a wallet already used by user <code>${dupId}</code>.\n📍 <code>${escHtml(details)}</code>\n\nNo request was created.`,
                        { reply_markup: { inline_keyboard: [
                            [{ text: '👤 This user', callback_data: `lookup_${id}` }, { text: '👤 Other user', callback_data: `lookup_${dupId}` }],
                            [{ text: '🚫 Ban this user', callback_data: `ban_${id}` }],
                        ] } }
                    ).catch(() => {});
                }
            }
            return res.status(403).json({
                ok: false, error: 'wallet_in_use',
                message: 'This wallet is already linked to another account. Each wallet can be used by one account only.',
            });
        }
    }

    // ── lifetime tasks requirement (one-time, not daily) ──
    const tasksLifetime = (user.completedTasks || []).length;
    if (tasksLifetime < WITHDRAW_TASKS_REQUIRED) {
        return res.status(400).json({
            ok: false, error: 'need_tasks',
            tasksRequired: WITHDRAW_TASKS_REQUIRED, tasksHave: tasksLifetime,
            message: `Complete at least ${WITHDRAW_TASKS_REQUIRED} tasks (lifetime, one-time) before you can withdraw (you have ${tasksLifetime} done).`,
        });
    }

    // ── account-age requirement (first withdrawal only; 0 hours = disabled) ──
    // Blocks "join → script farms tasks/ads in minutes → instant withdraw".
    // See WITHDRAW_MIN_ACCOUNT_AGE_HOURS in lib/constants.js.
    const isFirstWithdrawForAgeCheck = (user.withdrawalCount || 0) === 0;
    if (isFirstWithdrawForAgeCheck) {
        const hoursRemaining = accountAgeHoursRemaining(user);
        if (hoursRemaining > 0) {
            return res.status(400).json({
                ok: false, error: 'account_too_new',
                accountAgeRequiredHours: WITHDRAW_MIN_ACCOUNT_AGE_HOURS, accountAgeHoursRemaining: hoursRemaining,
                message: `Your account must be at least ${WITHDRAW_MIN_ACCOUNT_AGE_HOURS} hours old before your first withdrawal. Please wait ${hoursRemaining} more hour${hoursRemaining === 1 ? '' : 's'}.`,
            });
        }
    }

    // ── ads requirement: WITHDRAW_ADS_REQUIRED (6) ads in the LAST 24 HOURS (rolling, exact time of each ad) ──
    const adsToday = countRecentAds(user);
    if (adsToday < WITHDRAW_ADS_REQUIRED) {
        return res.status(400).json({
            ok: false, error: 'insufficient_ads',
            adsRequired: WITHDRAW_ADS_REQUIRED, adsToday, adsWindowHours: WITHDRAW_ADS_WINDOW_HOURS,
            message: `Watch ${WITHDRAW_ADS_REQUIRED} GigaPub / Adsgram ads within the last ${WITHDRAW_ADS_WINDOW_HOURS} hours before withdrawing (you have ${adsToday}). Ads from other networks do not count.`,
        });
    }

    // ── balance ──
    if ((user.wtcBalance || 0) < wtcAmount) {
        return res.status(400).json({ ok: false, error: 'insufficient_balance', message: `You need ${wtcAmount.toLocaleString()} WTC to withdraw this amount.` });
    }

    // ── referral gate ──
    // The first FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE withdrawals need no valid
    // referral but are capped at FREE_WITHDRAW_MAX_WTC (gross, before fees).
    // After that, valid referrals are required in proportion to the amount.
    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    const isFreePhase = (user.withdrawalCount || 0) < FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE;
    const willConsumeReferral = !isFreePhase;
    if (isFreePhase && wtcAmount > FREE_WITHDRAW_MAX_WTC) {
        return res.status(400).json({
            ok: false, error: 'first_withdraw_cap',
            firstWithdrawMaxWtc: FREE_WITHDRAW_MAX_WTC, firstWithdrawMaxUsd: FREE_WITHDRAW_MAX_USD,
            message: `Maximum withdrawal is ${FREE_WITHDRAW_MAX_WTC.toLocaleString()} WTC ($${FREE_WITHDRAW_MAX_USD}) per withdrawal for your first ${FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE} withdrawals. Lower the amount.`,
        });
    }
    // 20 Oct 2026 (admin): in the referral phase one withdrawal is at most 100,000 WTC.
    if (!isFreePhase && wtcAmount > WITHDRAW_MAX_WTC_WITH_REFERRAL) {
        return res.status(400).json({
            ok: false, error: 'withdraw_max_cap',
            maxWtc: WITHDRAW_MAX_WTC_WITH_REFERRAL,
            message: `Maximum ${WITHDRAW_MAX_WTC_WITH_REFERRAL.toLocaleString()} WTC per withdrawal. Lower the amount.`,
        });
    }
    const { grossUsd, netUsd } = calcNetUsd(wtcAmount, method);
    const referralsNeeded = willConsumeReferral ? WITHDRAW_REFERRALS_PER_WITHDRAW : 0;
    const validAvailable = Math.max(0, (user.validReferralCount || 0) - (user.usedValidReferrals || 0));
    if (willConsumeReferral && validAvailable < referralsNeeded) {
        return res.status(400).json({
            ok: false, error: 'referral_required',
            validReferralsAvailable: validAvailable, validReferralsNeeded: referralsNeeded,
            message: `After ${FREE_WITHDRAWALS_BEFORE_REFERRAL_GATE} free withdrawals, every withdrawal needs ${WITHDRAW_REFERRALS_PER_WITHDRAW} valid referrals. You need ${referralsNeeded}, you have ${validAvailable}. Invite friends and wait for them to complete all referral steps.`,
        });
    }

    // Used to undo the gate update below if saving the request fails afterwards.
    const undoOps = {
        $inc: { wtcBalance: wtcAmount, withdrawalCount: -1 },
        $set: { withdrawPending: false },
    };
    if (willConsumeReferral) undoOps.$inc.usedValidReferrals = -referralsNeeded;
    if (!hasLockedWallet) undoOps.$unset = { lockedWalletMethod: '', lockedWalletAddress: '' };

    const updateOps = {
        $inc: { wtcBalance: -wtcAmount, withdrawalCount: 1 },
        $set: { withdrawPending: true },
    };
    if (willConsumeReferral) updateOps.$inc.usedValidReferrals = referralsNeeded;
    // Lock the wallet in on the first successful withdrawal.
    if (!hasLockedWallet) {
        updateOps.$set.lockedWalletMethod = method;
        updateOps.$set.lockedWalletAddress = details;
    }

    // ── ATOMIC GATE ──
    // Balance, today's-reset boundary, ads (rolling 24h), tasks, pending flag and
    // referral availability are all re-verified in this single update, so a
    // double-tap or a Bangladesh-midnight reset between the reads above and
    // this write cannot slip a withdrawal through.
    const gate = await users.findOneAndUpdate(
        {
            _id: id,
            isBanned: { $ne: true },
            wtcBalance: { $gte: wtcAmount },
            lastResetDate: today,
            withdrawPending: { $ne: true },
            $expr: {
                $and: [
                    { $gte: [{ $size: { $ifNull: ['$completedTasks', []] } }, WITHDRAW_TASKS_REQUIRED] },
                    // 17 Oct 2026: ads rule re-verified atomically — at least WITHDRAW_ADS_REQUIRED stored ad timestamps newer than (now - 24h)
                    { $gte: [{ $size: { $filter: { input: { $ifNull: ['$adTimes24h', []] }, as: 't', cond: { $gte: ['$$t', Date.now() - adsWindowMs()] } } } }, WITHDRAW_ADS_REQUIRED] },
                    ...(willConsumeReferral ? [{
                        $gte: [
                            { $subtract: [{ $ifNull: ['$validReferralCount', 0] }, { $ifNull: ['$usedValidReferrals', 0] }] },
                            referralsNeeded,
                        ],
                    }] : []),
                    // account-age gate: first withdrawal only (re-verified atomically)
                    ...(isFirstWithdraw ? [{ $lte: [{ $toLong: '$createdAt' }, Date.now() - MIN_ACCOUNT_AGE_MS] }] : []),
                ],
            },
        },
        updateOps,
        { returnDocument: 'after' }
    );

    if (!gate) {
        const stillPending = await users.findOne({ _id: id }, { projection: { withdrawPending: 1 } });
        if (stillPending?.withdrawPending) {
            return res.status(409).json({
                ok: false, error: 'withdraw_already_pending',
                message: 'You already have a withdrawal request being processed. Please wait for it to be approved or rejected before submitting another.',
            });
        }
        return res.status(409).json({
            ok: false, error: 'gate_failed',
            message: 'Could not process the withdrawal — your balance, ad/task progress, or referral status may have changed. Please refresh and try again.',
        });
    }

    const withdrawals = db.collection('withdrawals');
    const withdrawDoc = {
        userId: id,
        username: verified.user.username || null,
        method,
        details,
        wtcAmount,
        grossUsd,
        cashAmount: netUsd,          // api/bot.js reads this name in the admin/approve/reject messages
        currency: methodConfig.currency,
        // How many valid referrals this withdrawal used (0 = none). Refunded on reject.
        referralConsumed: willConsumeReferral ? referralsNeeded : 0,
        status: 'pending',
        createdAt: new Date(),
        // Recorded now for the audit trail; the commission itself is only paid
        // on approval (see finalizeWithdrawal in api/bot.js).
        referrerId: user.referredBy || null,
        referrerCommissionPaid: 0,
    };
    // Previous withdrawal (looked up BEFORE inserting this one) for the admin message.
    const prevList = await withdrawals.find({ userId: id }).sort({ createdAt: -1 }).limit(4).toArray(); // 17 Oct 2026: last 4 (was 1) so the admin sees WHEN each earlier withdraw happened
    const prevWithdraw = prevList[0] || null;
    const prevApproved = await withdrawals.countDocuments({ userId: id, status: 'approved' });
    const prevRejected = await withdrawals.countDocuments({ userId: id, status: 'rejected' });
    const cycRep = await buildCycleReport(db, user).catch(() => null); // ads/mining/lootbox/tasks … since the last withdraw (lib/cycleStats.js)
    let inserted;
    try {
        inserted = await withdrawals.insertOne(withdrawDoc);
    } catch (e) {
        // The balance was already deducted by the gate above — put everything back
        // so the user is not charged for a request that was never saved.
        console.error('withdraw insert failed, rolling back:', e.message);
        await users.updateOne({ _id: id }, undoOps).catch(err => console.error('withdraw rollback failed:', err.message));
        return res.status(500).json({ ok: false, error: 'withdraw_save_failed', message: 'Could not save your withdrawal request. Your balance was not charged — please try again.' });
    }

    if (ADMIN_ID) {
        const adminText =
            `💸 <b>New Withdraw Request</b>\n\n` +
            `👤 User: <code>${id}</code>${verified.user.username ? ' (@' + escHtml(verified.user.username) + ')' : ''}\n` +
            `🪙 WTC: <b>${wtcAmount.toLocaleString()}</b>\n` +
            `💰 Amount: <b>$${netUsd.toFixed(4)} ${methodConfig.currency}</b>\n` +
            `📤 Method: <b>${methodConfig.label}</b>\n` +
            `📍 Address: <code>${escHtml(details)}</code>\n` +
            `📊 Earlier withdrawals: <b>${prevList.length ? `✅ ${prevApproved} approved · ❌ ${prevRejected} rejected` : 'none — this is the FIRST withdrawal'}</b>\n` +
            (prevList.length ? prevList.map((p, i) => `   ${i + 1}) ${fmtBDDateTime(p.createdAt)} — ${(p.wtcAmount || 0).toLocaleString()} WTC (${p.status})`).join('\n') + '\n' : '') +
            (cycRep ? `\n${renderCycleShort(cycRep)}\n\n` : '') +
            `👥 Total referrals: <b>${user.referralCount || 0}</b>\n` +
            ((user.botSuspectCount || 0) > 0 ? `🚨 Script flags: <b>${user.botSuspectCount}</b> (hold at ${BOT_SUSPECT_HOLD_COUNT}) — check the profile before approving\n` : '') +
            (user.multiAccountFlag ? `🚩 Multi-account flag: <b>YES</b>\n` : '') +
            `📅 ${fmtBDDateTime(withdrawDoc.createdAt)}\n` +
            `🆔 Request: <code>${inserted.insertedId}</code>`;
        // The message_id is stored on the withdrawal so the wrong-address flow can edit
        // this admin message later, from the user's chat.
        try {
            const sent = await tgSend(ADMIN_ID, adminText, { reply_markup: { inline_keyboard: [
                [{ text: '✅ Approve', callback_data: `wd_approve_${inserted.insertedId}` },
                 { text: '❌ Reject', callback_data: `wd_reject_${inserted.insertedId}` }],
                [{ text: '⚠️ Wrong Address', callback_data: `wd_wrongaddr_${inserted.insertedId}` }],
                [{ text: '📊 Cycle Report', callback_data: `trust_${id}` }, { text: '📦 Lootbox 30d', callback_data: `lootlog_${id}` }],
                // For scripted withdraw spam: bans the user and wipes their whole
                // balance (wd_banscam_ handler in api/bot.js).
                [{ text: '🚫 Ban & Wipe (Scam)', callback_data: `wd_banscam_${inserted.insertedId}` }],
            ] } });
            if (sent?.ok && sent.result?.message_id) {
                await withdrawals.updateOne(
                    { _id: inserted.insertedId },
                    { $set: { adminMsgChatId: ADMIN_ID, adminMsgId: sent.result.message_id } }
                );
            }
        } catch { /* non-blocking — the request is still saved even if this notification fails */ }
    }

    return res.status(200).json({
        ok: true,
        withdrawId: inserted.insertedId,
        wtcAmount, netUsd,
        newWtcBalance: gate.wtcBalance,
        status: 'pending',
    });
}

// ── POST {action:'walletChangeRequest'} / {action:'walletChangeApply'} ── (15 Oct 2026, admin request)
// 1) The user taps "Change Wallet" → request counted (max WALLET_CHANGE_MAX_REQUESTS per lifetime) and the admin is notified.
// 2) Admin taps Accept / Deny in the bot (wc_ok_ / wc_no_ in api/bot.js). Accept → user.walletChangeStatus = 'approved'.
// 3) The user enters the new method + address → applied here, once, then the approval is used up.
async function handleWalletChange(req, res, db, action) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);
    const users = db.collection('users');
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if (!user.lockedWalletMethod || !user.lockedWalletAddress) {
        return res.status(400).json({ ok: false, error: 'no_wallet', message: 'You have no saved wallet yet — it is set when you make your first withdrawal.' });
    }

    if (action === 'walletChangeRequest') {
        if (user.withdrawPending) return res.status(409).json({ ok: false, error: 'withdraw_already_pending', message: 'Please wait until your pending withdrawal is finished, then request the wallet change.' });
        const gate = await users.findOneAndUpdate(
            {
                _id: id, isBanned: { $ne: true }, withdrawPending: { $ne: true },
                walletChangeStatus: { $nin: ['pending', 'approved'] },
                $or: [{ walletChangeRequests: { $exists: false } }, { walletChangeRequests: { $lt: WALLET_CHANGE_MAX_REQUESTS } }],
            },
            { $inc: { walletChangeRequests: 1 }, $set: { walletChangeStatus: 'pending', walletChangeRequestedAt: new Date() } },
            { returnDocument: 'after' }
        );
        if (!gate) {
            if (user.walletChangeStatus === 'pending') return res.status(409).json({ ok: false, error: 'wallet_change_pending', message: 'Your request is already waiting for the admin.' });
            if (user.walletChangeStatus === 'approved') return res.status(409).json({ ok: false, error: 'wallet_change_approved', message: 'Your request is already approved — enter your new wallet.' });
            return res.status(400).json({ ok: false, error: 'wallet_change_limit', message: `You can request a wallet change only ${WALLET_CHANGE_MAX_REQUESTS} times in total — no requests left.` });
        }
        if (ADMIN_ID) {
            try {
                await tgSend(ADMIN_ID,
                    `🔄 <b>Wallet Change Request</b>\n\n` +
                    `👤 User: <code>${id}</code>${verified.user.username ? ' (@' + escHtml(verified.user.username) + ')' : ''}\n` +
                    `📤 Current: <b>${WITHDRAW_METHODS[user.lockedWalletMethod]?.label || escHtml(user.lockedWalletMethod)}</b>\n` +
                    `📍 <code>${escHtml(user.lockedWalletAddress)}</code>\n` +
                    `🔢 Request <b>${gate.walletChangeRequests}/${WALLET_CHANGE_MAX_REQUESTS}</b> (lifetime)\n` +
                    `💰 Balance: <b>${(gate.wtcBalance || 0).toLocaleString()} WTC</b> · Withdrawals: <b>${gate.withdrawalCount || 0}</b>`,
                    { reply_markup: { inline_keyboard: [[
                        { text: '✅ Accept', callback_data: `wc_ok_${id}` },
                        { text: '❌ Deny', callback_data: `wc_no_${id}` },
                    ]] } });
            } catch { /* the request is saved even if this notification fails */ }
        }
        return res.status(200).json({ ok: true, status: 'pending', requestsLeft: Math.max(0, WALLET_CHANGE_MAX_REQUESTS - (gate.walletChangeRequests || 0)) });
    }

    // action === 'walletChangeApply'
    if (user.walletChangeStatus !== 'approved') return res.status(403).json({ ok: false, error: 'wallet_change_not_approved', message: 'The admin has not approved a wallet change for you.' });
    if (user.withdrawPending) return res.status(409).json({ ok: false, error: 'withdraw_already_pending', message: 'Please wait until your pending withdrawal is finished.' });
    const method = req.body?.method;
    let details = typeof req.body?.details === 'string' ? req.body.details.trim() : '';
    if (typeof method !== 'string' || !Object.hasOwn(WITHDRAW_METHODS, method)) return res.status(400).json({ ok: false, error: 'invalid_method' });
    if (!WALLET_DETAILS_RE.test(details)) return res.status(400).json({ ok: false, error: 'invalid_address', message: 'That address/UID does not look valid. Check it and try again.' });
    const done = await users.findOneAndUpdate(
        { _id: id, walletChangeStatus: 'approved', withdrawPending: { $ne: true } },
        { $set: { lockedWalletMethod: method, lockedWalletAddress: details, walletChangedAt: new Date() }, $unset: { walletChangeStatus: '' } },
        { returnDocument: 'after' }
    );
    if (!done) return res.status(409).json({ ok: false, error: 'gate_failed', message: 'Could not change the wallet — please refresh and try again.' });
    if (ADMIN_ID) {
        tgSend(ADMIN_ID, `✅ <b>Wallet changed</b>\n\n👤 <code>${id}</code>\n📤 ${WITHDRAW_METHODS[method].label}\n📍 <code>${escHtml(details)}</code>`).catch(() => {});
    }
    return res.status(200).json({ ok: true, method, address: details });
}

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'status') return handleStatus(req, res, db);
        if (action === 'history') return handleHistory(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    if (req.method === 'POST') {
        const act = req.body?.action;
        if (act === 'walletChangeRequest' || act === 'walletChangeApply') return handleWalletChange(req, res, db, act);
        return handleCreate(req, res, db);
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
        }
