// api/withdraw.js — SEASON 3: DOGS-ONLY, FREE-AMOUNT WITHDRAW (tiers removed)
//
// ⚠️ MAJOR REBUILD (this pass):
//   - Withdrawals still spend from a converted balance (`dogsBalance`,
//     renamed from `usdtBalance`) built up via action:'convert' (25% fee
//     taken there, same as before) — but the fixed $-tier system is GONE.
//     Users submit any `dogsAmount` >= MIN_WITHDRAW_DOGS that's a multiple
//     of WITHDRAW_AMOUNT_STEP (must end in "00").
//   - Only Tonkeeper (TON wallet address) is accepted — Binance is locked
//     and rejected server-side regardless of what the client sends.
//   - Requirements are FLAT per request: FIRST_WITHDRAW_MIN_TASKS tasks
//     (lifetime), WITHDRAW_ADS_REQUIRED ads (today), WITHDRAW_REFERRALS_REQUIRED
//     referrals (lifetime).
//   - Address lock is now 7 days (WITHDRAW_ADDRESS_LOCK_DAYS). Users who were
//     previously locked to Binance (from the old system) are auto-unlocked
//     here — see getAddressLockStatus — since Binance can't be withdrawn to
//     anymore; they can immediately submit a fresh Tonkeeper withdrawal,
//     which will then lock them to that TON address for 7 days.
//   - Still ONE withdrawal per Bangladesh calendar day (`lastWithdrawDate`),
//     unchanged from before.
//
//   GET  /api/withdraw?action=requirements&initData=...        → dogsBalance + requirements + addressLock status
//   GET  /api/withdraw?action=history&initData=...
//   POST /api/withdraw   body: { initData, action:'convert', wtcAmount }
//   POST /api/withdraw   body: { initData, details, dogsAmount }              (action defaults to 'create')

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    WITHDRAW_METHODS, WITHDRAW_FEE_PERCENT, MIN_CONVERT_WTC, MIN_WITHDRAW_DOGS, WITHDRAW_AMOUNT_STEP,
    FIRST_WITHDRAW_MIN_TASKS, WITHDRAW_ADS_REQUIRED, WITHDRAW_REFERRALS_REQUIRED, WITHDRAW_ADDRESS_LOCK_DAYS,
    todayBD, WTC_PER_DOGS,
} from '../lib/constants.js';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
const LOCK_MS = WITHDRAW_ADDRESS_LOCK_DAYS * 24 * 60 * 60 * 1000;
const ACTIVE_METHOD = 'tonkeeper'; // the only method currently accepted — Binance is locked (see lib/constants.js)

// Address-lock status for a user — null if not currently locked.
// ⚠️ NEW: a user whose existing lock is on the (now-locked) 'binance'
// method is treated as UNLOCKED — Binance can't be paid out to anymore, so
// there's nothing to protect by holding that lock. This auto-migrates
// every previously-Binance-locked user the first time they open the
// withdraw sheet, with no separate DB migration needed.
function getAddressLockStatus(user) {
    if (!user.addressLockedAt) return null;
    if (user.lockedWithdrawMethod && user.lockedWithdrawMethod !== ACTIVE_METHOD) return null; // ⚠️ NEW — e.g. old binance locks
    const elapsed = Date.now() - new Date(user.addressLockedAt).getTime();
    if (elapsed >= LOCK_MS) return null; // expired
    return {
        address: user.lockedWithdrawAddress,
        daysLeft: Math.max(1, Math.ceil((LOCK_MS - elapsed) / (24 * 60 * 60 * 1000))),
    };
}

// ── GET ?action=requirements ──
async function handleRequirements(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const users = db.collection('users');
    const today = await ensureDailyReset(users, id);
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const addressLock = getAddressLockStatus(user);
    const adsToday = user.lastResetDate === today ? (user.adsWatchedToday || 0) : 0;
    const tasksHave = (user.completedTasks || []).length;
    const referralsHave = user.referralCount || 0;

    const withdrawRequirements = {
        tasksRequired: FIRST_WITHDRAW_MIN_TASKS, tasksHave, tasksMet: tasksHave >= FIRST_WITHDRAW_MIN_TASKS,
        adsRequired: WITHDRAW_ADS_REQUIRED, adsWatchedToday: adsToday, adsMet: adsToday >= WITHDRAW_ADS_REQUIRED,
        referralsRequired: WITHDRAW_REFERRALS_REQUIRED, referralsHave, referralsMet: referralsHave >= WITHDRAW_REFERRALS_REQUIRED,
    };

    return res.status(200).json({
        ok: true,
        dogsBalance: user.dogsBalance || 0,
        wtcBalance: user.wtcBalance || 0,
        addressLock,
        withdrawRequirements,
        minWithdrawDogs: MIN_WITHDRAW_DOGS,
        withdrawAmountStep: WITHDRAW_AMOUNT_STEP,
        minConvertWtc: MIN_CONVERT_WTC,
        convertFeePercent: WITHDRAW_FEE_PERCENT,
        wtcPerDogs: WTC_PER_DOGS,
        alreadyWithdrewToday: user.lastWithdrawDate === today,
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

// ── POST action:'convert' — WTC → dogsBalance, fee taken HERE ──
async function handleConvert(req, res, db) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const wtcAmount = Math.floor(Number(req.body?.wtcAmount));
    if (!wtcAmount || isNaN(wtcAmount) || wtcAmount <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_amount' });
    }
    if (wtcAmount < MIN_CONVERT_WTC) {
        return res.status(400).json({ ok: false, error: 'below_minimum', message: `Minimum ${MIN_CONVERT_WTC.toLocaleString()} WTC required to convert.` });
    }

    const users = db.collection('users');
    const user = await users.findOne({ _id: id }, { projection: { isBanned: 1, wtcBalance: 1 } });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const grossDogs = wtcAmount / WTC_PER_DOGS;
    const feeDogs = grossDogs * (WITHDRAW_FEE_PERCENT / 100);
    const netDogs = grossDogs - feeDogs;

    // ── ATOMIC — balance check + deduct WTC + credit dogsBalance, one operation ──
    const gate = await users.findOneAndUpdate(
        { _id: id, isBanned: { $ne: true }, wtcBalance: { $gte: wtcAmount } },
        { $inc: { wtcBalance: -wtcAmount, dogsBalance: netDogs } },
        { returnDocument: 'after' }
    );
    if (!gate) return res.status(409).json({ ok: false, error: 'insufficient_balance' });

    return res.status(200).json({
        ok: true, wtcConverted: wtcAmount, feeDogs, netDogs,
        newWtcBalance: gate.wtcBalance, newDogsBalance: gate.dogsBalance,
    });
}

// ── POST (default action 'create') — spend dogsBalance, free amount ──
async function handleCreate(req, res, db) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const { details, method } = req.body;
    const dogsAmount = Math.floor(Number(req.body?.dogsAmount));

    // ⚠️ Only Tonkeeper/TON is accepted right now. If a client explicitly
    // sends a different (e.g. legacy 'binance') method, reject it —
    // defensive check even though the current frontend never sends one.
    if (method && method !== ACTIVE_METHOD) {
        const cfg = WITHDRAW_METHODS[method];
        return res.status(400).json({
            ok: false, error: 'method_locked',
            message: `${cfg?.label || method} withdrawals are temporarily paused. Please use your TON wallet address to receive DOGS instead.`,
        });
    }

    if (!details) return res.status(400).json({ ok: false, error: 'missing_fields' });
    if (!dogsAmount || isNaN(dogsAmount) || dogsAmount <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_amount' });
    }
    if (dogsAmount < MIN_WITHDRAW_DOGS) {
        return res.status(400).json({ ok: false, error: 'below_min_withdraw', message: `Minimum withdraw is ${MIN_WITHDRAW_DOGS.toLocaleString()} DOGS.` });
    }
    if (dogsAmount % WITHDRAW_AMOUNT_STEP !== 0) {
        return res.status(400).json({ ok: false, error: 'bad_amount_step', message: 'Amount must end in "00" (e.g. 1000, 1200, 1500).' });
    }

    const users = db.collection('users');
    const today = await ensureDailyReset(users, id);

    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    // ── lifetime task gate ──
    const tasksHave = (user.completedTasks || []).length;
    if (tasksHave < FIRST_WITHDRAW_MIN_TASKS) {
        return res.status(400).json({
            ok: false, error: 'need_5_tasks', // error code name kept as-is for frontend errorText() compatibility
            tasksRequired: FIRST_WITHDRAW_MIN_TASKS, tasksHave,
            message: `Complete at least ${FIRST_WITHDRAW_MIN_TASKS} tasks before withdrawing (you have ${tasksHave}).`,
        });
    }

    // ── lifetime referral gate ──
    const referralsHave = user.referralCount || 0;
    if (referralsHave < WITHDRAW_REFERRALS_REQUIRED) {
        return res.status(400).json({
            ok: false, error: 'referral_required',
            referralsNeeded: WITHDRAW_REFERRALS_REQUIRED, referralsHave,
            message: `You need at least ${WITHDRAW_REFERRALS_REQUIRED} referral to withdraw (you have ${referralsHave}).`,
        });
    }

    // ── 7-day address lock (Binance-locked users are auto-unlocked — see getAddressLockStatus) ──
    const lockStatus = getAddressLockStatus(user);
    if (lockStatus && lockStatus.address !== details) {
        return res.status(400).json({
            ok: false, error: 'address_locked',
            lockedAddress: lockStatus.address, daysLeft: lockStatus.daysLeft,
            message: `Your withdraw address is locked to ${lockStatus.address} for ${lockStatus.daysLeft} more day(s).`,
        });
    }

    if ((user.dogsBalance || 0) < dogsAmount) {
        return res.status(400).json({ ok: false, error: 'insufficient_balance', message: `You need ${dogsAmount.toLocaleString()} DOGS in your converted balance. Convert more WTC first.` });
    }

    // ── daily ads gate ──
    const adsToday = user.lastResetDate === today ? (user.adsWatchedToday || 0) : 0;
    if (adsToday < WITHDRAW_ADS_REQUIRED) {
        return res.status(400).json({ ok: false, error: 'insufficient_ads', adsRequired: WITHDRAW_ADS_REQUIRED, adsToday });
    }

    const withdrawals = db.collection('withdrawals');
    const addressUsedByOther = await withdrawals.findOne({
        details, userId: { $ne: id }, status: { $ne: 'rejected' },
    });
    if (addressUsedByOther) {
        return res.status(400).json({ ok: false, error: 'address_used_by_other' });
    }

    // ══════════════════════════════════════════════════════════
    // ATOMIC GATE — dogsBalance, once-per-day, ads-today, and the address
    // lock condition are all re-verified + applied here in one update.
    // ══════════════════════════════════════════════════════════
    const lockFilter = (lockStatus)
        ? { lockedWithdrawMethod: ACTIVE_METHOD, lockedWithdrawAddress: details }
        : { $or: [
              { addressLockedAt: { $exists: false } },
              { addressLockedAt: { $lt: new Date(Date.now() - LOCK_MS) } },
              { lockedWithdrawMethod: { $ne: ACTIVE_METHOD } }, // ⚠️ NEW — old binance lock, ignored
          ] };

    const gate = await users.findOneAndUpdate(
        {
            _id: id,
            isBanned: { $ne: true },
            dogsBalance: { $gte: dogsAmount },
            lastWithdrawDate: { $ne: today },
            lastResetDate: today,
            adsWatchedToday: { $gte: WITHDRAW_ADS_REQUIRED },
            ...lockFilter,
        },
        {
            $inc: { dogsBalance: -dogsAmount, withdrawalCount: 1 },
            $set: {
                lastWithdrawDate: today,
                lockedWithdrawMethod: ACTIVE_METHOD,
                lockedWithdrawAddress: details,
                addressLockedAt: (lockStatus && lockStatus.address === details) ? user.addressLockedAt : new Date(),
            },
        },
        { returnDocument: 'after' }
    );

    if (!gate) {
        return res.status(409).json({ ok: false, error: 'conflict_retry' });
    }

    const result = await withdrawals.insertOne({
        userId: id,
        username: user.telegramUsername || 'N/A',
        method: ACTIVE_METHOD, details,
        dogsAmount, currency: 'DOGS',
        adsRequired: WITHDRAW_ADS_REQUIRED,
        status: 'pending', createdAt: new Date(),
    });

    if (ADMIN_ID) {
        tgSend(ADMIN_ID,
            `💸 <b>Withdrawal Request</b>\n\n` +
            `👤 <code>${id}</code> (@${user.telegramUsername || '?'})\n` +
            `💰 <b>${dogsAmount.toLocaleString()} DOGS</b>\n` +
            `📤 Method: <b>TON Wallet (Tonkeeper)</b>\n` +
            `📍 Address: <code>${details}</code>${(lockStatus && lockStatus.address === details) ? '' : ' 🔒 (newly locked for ' + WITHDRAW_ADDRESS_LOCK_DAYS + ' days)'}\n` +
            `📊 Total withdrawals so far: <b>${gate.withdrawalCount || 1}</b>\n` +
            `👥 Total referrals: <b>${user.referralCount || 0}</b>\n` +
            `📅 ${new Date().toLocaleString()}`,
            { reply_markup: { inline_keyboard: [[
                { text: '✅ Approve', callback_data: `wd_approve_${result.insertedId}` },
                { text: '❌ Reject',  callback_data: `wd_reject_${result.insertedId}` },
            ]]}}
        ).catch((e) => console.error('admin notify failed:', e));
    }

    return res.status(200).json({ ok: true, withdrawalId: result.insertedId, dogsAmount });
}

export default async function handler(req, res) {
    try {
        const { db } = await connectToDatabase();

        if (req.method === 'GET') {
            const { action } = req.query;
            if (action === 'history') return handleHistory(req, res, db);
            if (action === 'requirements') return handleRequirements(req, res, db);
            return res.status(400).json({ ok: false, error: 'unknown_action' });
        }

        if (req.method === 'POST') {
            const action = req.body?.action || 'create';
            if (action === 'convert') return handleConvert(req, res, db);
            if (action === 'create') return handleCreate(req, res, db);
            return res.status(400).json({ ok: false, error: 'unknown_action' });
        }

        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    } catch (err) {
        console.error('withdraw error:', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
    }
