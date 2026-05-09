// api/withdraw.js
// POST /api/withdraw
// Body: { userId, method, details, diamondAmount }
//
// Withdraw Methods:
//   binance   → min 100 Diamond
//   tonkeeper → min  50 Diamond
//   bkash     → min 100 Diamond
//
// Requirements per 24h window:
//   - Complete 5 tasks
//   - Watch 20 ads
//   - 1 withdrawal per day

const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

const METHODS = {
    binance:   { label: 'Binance UID',       minDiamond: 100, rate: '1000 Diamond = 1 USDT'   },
    tonkeeper: { label: 'Tonkeeper Address', minDiamond: 50,  rate: '1000 Diamond = 0.45 TON' },
    bkash:     { label: 'bKash Number',      minDiamond: 80,  rate: '1000 Diamond = 120 BDT'  },
};

const REQUIRED_TASKS_MIN = 5;   // total tasks completed
const REQUIRED_ADS_TODAY = 20;  // ads watched today

module.exports = async function handler(req, res) {
    if (handleCors(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'POST only' });
    }

    const { userId, method, details, diamondAmount } = req.body || {};

    // ── Basic validation ──
    if (!userId || !method || !details || typeof diamondAmount !== 'number') {
        return res.status(400).json({ ok: false, error: 'userId, method, details and diamondAmount required' });
    }

    if (!METHODS[method]) {
        return res.status(400).json({ ok: false, error: 'Invalid method. Use: binance, tonkeeper, bkash' });
    }

    const methodConfig = METHODS[method];
    if (diamondAmount < methodConfig.minDiamond) {
        return res.status(400).json({
            ok: false,
            error: `Minimum ${methodConfig.minDiamond} Diamond for ${methodConfig.label}`,
        });
    }

    const db      = getDb();
    const userRef = db.collection('users').doc(String(userId));
    const today   = getTodayString();

    try {
        // ── Check if wallet already used by another account ──
        const walletSnap = await db.collection('withdrawals')
            .where('details', '==', details)
            .limit(5)
            .get();

        let walletConflict = false;
        walletSnap.forEach(d => {
            if (d.data().userId !== String(userId)) walletConflict = true;
        });
        if (walletConflict) {
            return res.status(400).json({ ok: false, error: 'This address is already linked to another account' });
        }

        // ── Run in transaction ──
        await db.runTransaction(async (t) => {
            const snap = await t.get(userRef);
            if (!snap.exists) throw new Error('User not found');
            const user = snap.data();

            if (user.isBanned) throw new Error('Account banned');

            // 1 withdrawal per day
            if (user.lastWithdrawDate === today) {
                throw new Error('You can only withdraw once per day');
            }

            // Diamond balance check
            const currentDiamond = user.diamondBalance || 0;
            if (currentDiamond < diamondAmount) {
                throw new Error(`Insufficient Diamonds. You have ${currentDiamond}, need ${diamondAmount}`);
            }

            // Requirements: always 5 tasks total + 20 ads today
            const adsToday = user.adsWatchedToday || 0;
            if (adsToday < REQUIRED_ADS_TODAY) {
                throw new Error(`Watch ${REQUIRED_ADS_TODAY} ads today first. Done: ${adsToday}/${REQUIRED_ADS_TODAY}`);
            }
            const tasksTotal = (user.completedTasks || []).length;
            if (tasksTotal < REQUIRED_TASKS_MIN) {
                throw new Error(`Complete ${REQUIRED_TASKS_MIN} tasks first. Done: ${tasksTotal}/${REQUIRED_TASKS_MIN}`);
            }

            // Create withdrawal request
            const wRef = db.collection('withdrawals').doc();
            t.set(wRef, {
                userId:        String(userId),
                method,
                methodLabel:   methodConfig.label,
                details,
                diamondAmount,
                status:        'pending',
                createdAt:     admin.firestore.FieldValue.serverTimestamp(),
                currency:      'diamond',
            });

            // Deduct diamonds and mark withdraw date
            t.update(userRef, {
                diamondBalance:  admin.firestore.FieldValue.increment(-diamondAmount),
                withdrawalCount: admin.firestore.FieldValue.increment(1),
                lastWithdrawDate: today,
            });
        });

        return res.status(200).json({
            ok:      true,
            success: true,
            message: `Withdrawal of ${diamondAmount} Diamond submitted. Processing in 12–48 hours.`,
        });

    } catch (err) {
        console.error('withdraw error:', err);
        return res.status(400).json({ ok: false, error: err.message });
    }
};

function getTodayString() {
    return new Date().toLocaleDateString('en-US', {
        timeZone: 'Asia/Dhaka',
        year:  'numeric',
        month: '2-digit',
        day:   '2-digit',
    });
}
