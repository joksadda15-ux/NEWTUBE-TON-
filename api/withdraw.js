// api/withdraw.js — SEASON 4 — SINGLE-STEP WITHDRAW (rebuilt, simplified)
//
// The old convert-first + tiered-box + hidden-level-ladder system is gone.
// Now withdraw is ONE step: user types a WTC amount (min MIN_WITHDRAW_WTC),
// picks a method (Binance UID / Tonkeeper), and submits.
//
// TWO fees apply back-to-back on that single submit:
//   1) WITHDRAW_FEE_PERCENT (25%) — same rate the old "convert" step used
//      to take, just applied here now instead of a separate step.
//   2) WITHDRAW_SECOND_FEE_PERCENT (5%) — NEW, taken on what's left after
//      the 25% above.
// Net received ≈ 71.25% of face value (0.75 × 0.95). See calcNetUsd().
//
// Referral gate: the user's FIRST withdrawal ever is free. Every withdrawal
// after that consumes exactly one "valid referral" — see lib/referral.js,
// where a referral becomes valid once the referred user completes all 3
// referral milestones (that's also where the Telegram "your referral is
// now valid ✅" notification is sent).
//
// No address lock anymore — user can withdraw to a different address/method
// every time if they want.
//
//   GET  /api/withdraw?action=status&initData=...   → balance + full eligibility snapshot
//   GET  /api/withdraw?action=history&initData=...
//   POST /api/withdraw   body: { initData, method, details, wtcAmount }

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    WITHDRAW_METHODS, WITHDRAW_FEE_PERCENT, WITHDRAW_SECOND_FEE_PERCENT, MIN_WITHDRAW_WTC,
    FIRST_WITHDRAW_MAX_WTC, FIRST_WITHDRAW_MAX_USD,
    WITHDRAW_TASKS_REQUIRED, WITHDRAW_ADS_REQUIRED, requiredReferralsForUsd, WITHDRAW_USD_PER_VALID_REFERRAL,
    WITHDRAW_REFERRAL_COMMISSION_PERCENT, WITHDRAW_MIN_ACCOUNT_AGE_HOURS,
    todayBD, WTC_PER_USD, WITHDRAWALS_OPEN,
} from '../lib/constants.js';

const MIN_ACCOUNT_AGE_MS = WITHDRAW_MIN_ACCOUNT_AGE_HOURS * 60 * 60 * 1000;

// Hours remaining until user.createdAt + WITHDRAW_MIN_ACCOUNT_AGE_HOURS. 0 once eligible.
function accountAgeHoursRemaining(user) {
    const createdAt = user.createdAt ? new Date(user.createdAt).getTime() : 0;
    const eligibleAt = createdAt + MIN_ACCOUNT_AGE_MS;
    return Math.max(0, Math.ceil((eligibleAt - Date.now()) / (60 * 60 * 1000)));
}

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

// wtcAmount → net USDT the user actually receives, after BOTH fees applied
// sequentially (25% then 5% on the remainder).
function calcNetUsd(wtcAmount) {
    const grossUsd = wtcAmount / WTC_PER_USD;
    const afterFirstFee = grossUsd * (1 - WITHDRAW_FEE_PERCENT / 100);
    const netUsd = afterFirstFee * (1 - WITHDRAW_SECOND_FEE_PERCENT / 100);
    return { grossUsd, netUsd };
}

// ── GET ?action=status — everything the withdraw screen needs in one call ──
async function handleStatus(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const users = db.collection('users');
    const today = await ensureDailyReset(users, id);
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const adsToday = user.lastResetDate === today ? (user.adsWatchedToday || 0) : 0;
    // ⚠️ CHANGED — tasks requirement is now LIFETIME, one-time (not daily).
    // Once completedTasks.length ever reaches WITHDRAW_TASKS_REQUIRED, this
    // stays satisfied forever — no daily reset involved.
    const tasksLifetime = (user.completedTasks || []).length;
    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    const validAvailable = Math.max(0, (user.validReferralCount || 0) - (user.usedValidReferrals || 0));
    // ⚠️ NEW — account-age gate only applies to the first withdrawal ever (see
    // WITHDRAW_MIN_ACCOUNT_AGE_HOURS in lib/constants.js for why).
    const hoursRemaining = isFirstWithdraw ? accountAgeHoursRemaining(user) : 0;

    return res.status(200).json({
        ok: true,
        wtcBalance: user.wtcBalance || 0,
        minWithdrawWtc: MIN_WITHDRAW_WTC,
        feePercent: WITHDRAW_FEE_PERCENT,
        secondFeePercent: WITHDRAW_SECOND_FEE_PERCENT,
        withdrawalsOpen: WITHDRAWALS_OPEN,
        withdrawRequirements: {
            adsRequired: WITHDRAW_ADS_REQUIRED, adsWatchedToday: adsToday, adsMet: adsToday >= WITHDRAW_ADS_REQUIRED,
            tasksRequired: WITHDRAW_TASKS_REQUIRED, tasksHave: tasksLifetime, tasksMet: tasksLifetime >= WITHDRAW_TASKS_REQUIRED,
            accountAgeRequiredHours: isFirstWithdraw ? WITHDRAW_MIN_ACCOUNT_AGE_HOURS : 0,
            accountAgeHoursRemaining: hoursRemaining,
            accountAgeMet: hoursRemaining === 0,
        },
        referralRequirement: {
            isFirstWithdrawFree: isFirstWithdraw,
            // ⚠️ NEW — frontend can show this cap upfront instead of letting
            // the user submit and only then find out their free first
            // withdrawal is capped.
            firstWithdrawMaxWtc: isFirstWithdraw ? FIRST_WITHDRAW_MAX_WTC : null,
            // ⚠️ CHANGED — replaces the old flat `perWithdraw: 1`. Referrals
            // needed now scale with the withdrawal amount (see
            // requiredReferralsForUsd, lib/constants.js) — not known until
            // the user types an amount, so the RATE is reported instead;
            // frontend computes Math.ceil(enteredUsd / usdPerReferral) live.
            usdPerReferral: WITHDRAW_USD_PER_VALID_REFERRAL,
            validReferralsAvailable: validAvailable,
            needsReferral: !isFirstWithdraw,
            // Baseline-only — "do they have at least 1", not the final
            // check for whatever amount they end up entering. handleCreate
            // re-verifies the real, amount-based requirement at submit time.
            met: isFirstWithdraw || validAvailable >= 1,
        },
    });
}

// ── GET ?action=history — unchanged shape ──
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

    const { method, details } = req.body || {};
    const wtcAmount = Math.floor(Number(req.body?.wtcAmount));

    if (!method || !details) return res.status(400).json({ ok: false, error: 'missing_fields' });
    if (!wtcAmount || isNaN(wtcAmount) || wtcAmount <= 0) return res.status(400).json({ ok: false, error: 'invalid_amount' });
    if (wtcAmount < MIN_WITHDRAW_WTC) {
        return res.status(400).json({
            ok: false, error: 'below_minimum',
            message: `Minimum ${MIN_WITHDRAW_WTC.toLocaleString()} WTC required to withdraw.`,
        });
    }

    const methodConfig = WITHDRAW_METHODS[method];
    if (!methodConfig) return res.status(400).json({ ok: false, error: 'invalid_method' });

    const users = db.collection('users');
    const today = await ensureDailyReset(users, id);
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    // ⚠️ NEW — referral-velocity auto-lock (lib/constants.js REFERRAL_VELOCITY_*,
    // set in api/user.js). Softer than a ban — the account and its balance
    // stay intact, but withdrawals are held until an admin reviews and
    // either unlocks or bans. Prevents cashing out during the review window.
    if (user.accountLocked) {
        return res.status(403).json({
            ok: false, error: 'account_locked',
            message: 'Your account is temporarily locked for review. Please contact support.',
        });
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

    // ── account-age requirement (first withdrawal only) ──
    // ⚠️ NEW — blocks the "join → script farms tasks/ads in minutes → instant
    // withdraw" pattern regardless of how fast the ads/tasks/referral gates
    // below are satisfied. See WITHDRAW_MIN_ACCOUNT_AGE_HOURS in lib/constants.js.
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

    // ── daily ads requirement ──
    const adsToday = user.lastResetDate === today ? (user.adsWatchedToday || 0) : 0;
    if (adsToday < WITHDRAW_ADS_REQUIRED) {
        return res.status(400).json({
            ok: false, error: 'insufficient_ads',
            adsRequired: WITHDRAW_ADS_REQUIRED, adsToday,
            message: `Watch ${WITHDRAW_ADS_REQUIRED} ads today before withdrawing (you have ${adsToday} today).`,
        });
    }

    // ── balance ──
    if ((user.wtcBalance || 0) < wtcAmount) {
        return res.status(400).json({ ok: false, error: 'insufficient_balance', message: `You need ${wtcAmount.toLocaleString()} WTC to withdraw this amount.` });
    }

    // ── referral gate: free on the very first withdrawal, otherwise a
    // number of valid referrals proportional to the withdrawal amount ──
    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    const willConsumeReferral = !isFirstWithdraw;
    // ⚠️ NEW — the free first withdrawal is now capped at FIRST_WITHDRAW_MAX_WTC
    // ($0.15 USD equivalent). Without this, a fresh account (farmed or not)
    // could take an unlimited first withdrawal for zero referral cost.
    if (isFirstWithdraw && wtcAmount > FIRST_WITHDRAW_MAX_WTC) {
        return res.status(400).json({
            ok: false, error: 'first_withdraw_cap',
            firstWithdrawMaxWtc: FIRST_WITHDRAW_MAX_WTC, firstWithdrawMaxUsd: FIRST_WITHDRAW_MAX_USD,
            message: `Your free first withdrawal is capped at ${FIRST_WITHDRAW_MAX_WTC.toLocaleString()} WTC (~$${FIRST_WITHDRAW_MAX_USD}). Lower the amount, or refer a friend and wait for them to complete all 3 referral steps to unlock larger withdrawals.`,
        });
    }
    // ⚠️ CHANGED — needs the USD value of THIS withdrawal to know how many
    // referrals it costs (requiredReferralsForUsd), so calcNetUsd is now
    // computed here instead of further down.
    const { grossUsd, netUsd } = calcNetUsd(wtcAmount);
    const referralsNeeded = willConsumeReferral ? requiredReferralsForUsd(grossUsd) : 0;
    const validAvailable = Math.max(0, (user.validReferralCount || 0) - (user.usedValidReferrals || 0));
    if (willConsumeReferral && validAvailable < referralsNeeded) {
        return res.status(400).json({
            ok: false, error: 'referral_required',
            validReferralsAvailable: validAvailable, validReferralsNeeded: referralsNeeded,
            message: `Your first withdrawal was free. Every withdrawal after that needs 1 valid referral per every $${WITHDRAW_USD_PER_VALID_REFERRAL} withdrawn — this withdrawal needs ${referralsNeeded}, you have ${validAvailable}. Refer a friend and wait for them to complete all 3 referral steps.`,
        });
    }

    const updateOps = {
        $inc: { wtcBalance: -wtcAmount, withdrawalCount: 1 },
        $set: { withdrawPending: true },
    };
    if (willConsumeReferral) updateOps.$inc.usedValidReferrals = referralsNeeded;

    // ══════════════════════════════════════════════════════════
    // ATOMIC GATE — balance, today's-reset boundary, ads, tasks, pending-flag,
    // and (if applicable) valid-referral availability are ALL re-verified
    // here in one atomic operation, closing the same race-condition class
    // the old system guarded against (e.g. Bangladesh-midnight boundary
    // resetting ads/tasks between the read above and this write, or a
    // double-tap firing two withdraws at once).
    // ══════════════════════════════════════════════════════════
    const gate = await users.findOneAndUpdate(
        {
            _id: id,
            isBanned: { $ne: true },
            wtcBalance: { $gte: wtcAmount },
            lastResetDate: today,
            adsWatchedToday: { $gte: WITHDRAW_ADS_REQUIRED },
            withdrawPending: { $ne: true },
            $expr: {
                $and: [
                    // ⚠️ CHANGED — tasks requirement re-verified here against the
                    // LIFETIME completedTasks array size, not a daily counter.
                    { $gte: [{ $size: { $ifNull: ['$completedTasks', []] } }, WITHDRAW_TASKS_REQUIRED] },
                    ...(willConsumeReferral ? [{
                        $gte: [
                            { $subtract: [{ $ifNull: ['$validReferralCount', 0] }, { $ifNull: ['$usedValidReferrals', 0] }] },
                            referralsNeeded,
                        ],
                    }] : [
                        // ⚠️ NEW — re-verified atomically for the first withdrawal only,
                        // closing the race window between the pre-check above and this
                        // write (e.g. two rapid double-taps landing near the boundary).
                        { $lte: [{ $toLong: '$createdAt' }, Date.now() - MIN_ACCOUNT_AGE_MS] },
                    ]),
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
        cashAmount: netUsd,          // kept name — api/bot.js reads this for admin/approve/reject messages
        currency: methodConfig.currency,
        // ⚠️ CHANGED — was a plain boolean (referralConsumed). Now stores the
        // ACTUAL count consumed, since a withdrawal can cost more than 1
        // referral (see requiredReferralsForUsd, lib/constants.js). Kept
        // named `referralConsumed` (not renamed) so a truthy/boolean check
        // elsewhere (`if (w.referralConsumed)`) still works correctly — 0 is
        // falsy same as before, any positive count is truthy same as before.
        referralConsumed: willConsumeReferral ? referralsNeeded : 0,
        status: 'pending',
        createdAt: new Date(),
        // ⚠️ CHANGED (this update) — referrerId is still recorded here at
        // request time (for the admin audit trail), but the actual
        // commission credit no longer happens here. See api/bot.js
        // finalizeWithdrawal for why and where it moved.
        referrerId: user.referredBy || null,
        referrerCommissionPaid: 0,
        addressFixUsed: false, // ⚠️ NEW — see wd_fixaddr_ in api/bot.js: one free address correction per withdrawal request
    };
    const inserted = await withdrawals.insertOne(withdrawDoc);

    // ⚠️ BUG FIX (this update) — referral withdrawal commission used to be
    // credited RIGHT HERE, the instant a withdrawal was REQUESTED — before
    // any admin approval. That meant a referrer got paid their 10% cut even
    // if the withdrawal was later rejected (e.g. for being fraudulent),
    // with no claw-back anywhere in the reject flow. Concretely: a farmed
    // account requests a huge withdrawal, gets banned and the request
    // rejected, but the referrer who invited them had ALREADY pocketed the
    // commission and keeps it regardless. Commission crediting now happens
    // in api/bot.js's finalizeWithdrawal, ONLY on actual approval — see
    // there for the credit logic. Nothing to do here anymore.

    if (ADMIN_ID) {
        const adminText =
            `💸 <b>New Withdraw Request</b>\n\n` +
            `👤 User: <code>${id}</code>${verified.user.username ? ' (@' + verified.user.username + ')' : ''}\n` +
            `🪙 WTC: <b>${wtcAmount.toLocaleString()}</b>\n` +
            `💰 Amount: <b>$${netUsd.toFixed(4)} ${methodConfig.currency}</b>\n` +
            `📤 Method: <b>${methodConfig.label}</b>\n` +
            `📍 Address: <code>${details}</code>\n` +
            `📊 Total withdrawals so far: <b>${user.withdrawalCount || 0}</b>\n` +
            `👥 Total referrals: <b>${user.referralCount || 0}</b>\n` +
            `📅 ${withdrawDoc.createdAt.toLocaleString()}\n` +
            `🆔 Request: <code>${inserted.insertedId}</code>`;
        // ⚠️ CHANGED — added a 3rd "Wrong Address" button (see api/bot.js
        // wd_wrongaddr_/wd_addrconfirm_ handlers), and now AWAITS the send
        // so the message_id can be stored on the withdrawal doc — needed
        // so the wrong-address flow can edit THIS message later from a
        // completely different chat (the user's), once they confirm.
        try {
            const sent = await tgSend(ADMIN_ID, adminText, { reply_markup: { inline_keyboard: [
                [{ text: '✅ Approve', callback_data: `wd_approve_${inserted.insertedId}` },
                 { text: '❌ Reject', callback_data: `wd_reject_${inserted.insertedId}` }],
                [{ text: '⚠️ Wrong Address', callback_data: `wd_wrongaddr_${inserted.insertedId}` }],
                // ⚠️ NEW — for scripted/bot withdraw spam (e.g. many requests seconds
                // apart following an identical pattern): bans the user AND wipes their
                // entire wtcBalance to 0, not just this withdrawal's amount. See
                // wd_banscam_ handler in api/bot.js.
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

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'status') return handleStatus(req, res, db);
        if (action === 'history') return handleHistory(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    if (req.method === 'POST') {
        return handleCreate(req, res, db);
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
        }
