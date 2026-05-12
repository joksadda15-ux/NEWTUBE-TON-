// api/init.js
// POST /api/init
// Creates or fetches a user. Awards referral gold to referrer.

const { getDb, admin } = require('./utils/firebase');
const { handleCors } = require('./utils/cors');

const REFERRAL_REWARD_GOLD = 2000;
const BOT_TOKEN = process.env.BOT_TOKEN;

module.exports = async function handler(req, res) {
    if (handleCors(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const { userId, firstName, username, referrerCode } = req.body || {};

    if (!userId) {
        return res.status(400).json({ ok: false, error: 'userId required' });
    }

    const db = getDb();
    const userRef = db.collection('users').doc(String(userId));

    try {
        const snap = await userRef.get();
        const today = getTodayString();

        if (!snap.exists) {
            // ── NEW USER ──
            const data = {
                goldBalance:              0,
                diamondBalance:           0,
                lifetimeGoldEarned:       0,
                referralCount:            0,
                totalInvites:             0,
                completedTasks:           [],
                createdAt:                admin.firestore.FieldValue.serverTimestamp(),
                telegramUsername:         username  || 'N/A',
                firstName:                firstName || 'User',
                isBanned:                 false,
                withdrawalCount:          0,
                lifetimeAdsWatched:       0,
                adsWatchedAdsgramDaily:   0,
                adsWatchedAdsgramSpecial: 0,
                adsWatchedMonetag:        0,
                adsWatchedGiga:           0,
                dailyVideoMined:          0,
                lastResetDate:            today,
                tasksCompletedToday:      0,
                adsWatchedToday:          0,
                lastWithdrawDate:         '',
                welcomeBonusClaimed:      false,
            };

            // Attach referrer & award gold
            if (referrerCode && referrerCode !== String(userId)) {
                data.referredBy = String(referrerCode);
                try {
                    const refRef = db.collection('users').doc(String(referrerCode));
                    const refSnap = await refRef.get();
                    if (refSnap.exists) {
                        await refRef.update({
                            totalInvites:       admin.firestore.FieldValue.increment(1),
                            goldBalance:        admin.firestore.FieldValue.increment(REFERRAL_REWARD_GOLD),
                            lifetimeGoldEarned: admin.firestore.FieldValue.increment(REFERRAL_REWARD_GOLD),
                            referralCount:      admin.firestore.FieldValue.increment(1),
                        });
                        // Send Telegram notification to referrer — use firstName from request body
                        sendReferralNotification(referrerCode, firstName || 'A new user', REFERRAL_REWARD_GOLD);
                    }
                } catch (refErr) {
                    console.error('Referral update error:', refErr.message);
                }
            }

            await userRef.set(data);

            // Return serializable data (remove serverTimestamp sentinel)
            const returnData = { ...data, createdAt: new Date().toISOString() };
            return res.status(200).json({ ok: true, isNew: true, user: { id: String(userId), ...returnData } });

        } else {
            // ── EXISTING USER ──
            const user = snap.data();
            if (user.isBanned) {
                return res.status(403).json({ ok: false, error: 'banned' });
            }

            // Daily reset check
            const updates = await checkAndResetDaily(user, today, userRef);

            return res.status(200).json({
                ok: true,
                isNew: false,
                user: { id: String(userId), ...user, ...updates },
            });
        }
    } catch (err) {
        console.error('init error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
};

// ── Daily reset helper ──
async function checkAndResetDaily(user, today, userRef) {
    if (user.lastResetDate === today) return {};
    const updates = {
        adsWatchedAdsgramDaily:   0,
        adsWatchedAdsgramSpecial: 0,
        adsWatchedMonetag:        0,
        adsWatchedGiga:           0,
        dailyVideoMined:          0,
        tasksCompletedToday:      0,
        adsWatchedToday:          0,
        lastResetDate:            today,
    };
    await userRef.update(updates);
    return updates;
}

// ── Today's date (Dhaka timezone) ──
function getTodayString() {
    return new Date().toLocaleDateString('en-US', {
        timeZone: 'Asia/Dhaka',
        year:     'numeric',
        month:    '2-digit',
        day:      '2-digit',
    });
}

// ── Telegram notification to referrer ──
async function sendReferralNotification(referrerId, newUserName, goldAwarded) {
    if (!BOT_TOKEN || !referrerId) return;
    try {
        const message = `🎉 নতুন Referral!\n\n👤 ${newUserName} আপনার link দিয়ে join করেছে!\n🪙 +${goldAwarded.toLocaleString()} Gold আপনার account এ যোগ হয়েছে!`;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: String(referrerId),
                text: message,
                parse_mode: 'HTML',
            }),
        });
    } catch (e) {
        console.error('Referral notification error:', e.message);
    }
                    }
