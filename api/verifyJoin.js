// api/verifyJoin.js
// GET  /api/verifyJoin?userId=123
// POST /api/verifyJoin  { userId, claimBonus }
//
// Checks if user has joined the required Telegram channel & group.
// On first verified join, awards WELCOME_BONUS_GOLD.

const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

const BOT_TOKEN          = process.env.BOT_TOKEN;
const OFFICIAL_CHANNEL   = '@NEEWTON_OFFICIAL';   // change if needed
const OFFICIAL_GROUP     = '@newTon_Gc';           // change if needed
const WELCOME_BONUS_GOLD = 2000;

module.exports = async function handler(req, res) {
    if (handleCors(req, res)) return;

    const userId = req.method === 'POST'
        ? (req.body?.userId)
        : (req.query?.userId);

    if (!userId) {
        return res.status(400).json({ ok: false, error: 'userId required' });
    }

    try {
        // Check both channel and group
        const [chanOk, groupOk] = await Promise.all([
            checkMember(userId, OFFICIAL_CHANNEL),
            checkMember(userId, OFFICIAL_GROUP),
        ]);

        const joined = chanOk && groupOk;

        if (!joined) {
            return res.status(200).json({ ok: true, joined: false });
        }

        // Give welcome bonus if not yet claimed
        const db      = getDb();
        const userRef = db.collection('users').doc(String(userId));
        const snap    = await userRef.get();

        let bonusGiven = false;
        if (snap.exists && !snap.data().welcomeBonusClaimed) {
            await userRef.update({
                goldBalance:         admin.firestore.FieldValue.increment(WELCOME_BONUS_GOLD),
                lifetimeGoldEarned:  admin.firestore.FieldValue.increment(WELCOME_BONUS_GOLD),
                welcomeBonusClaimed: true,
            });
            bonusGiven = true;
        }

        return res.status(200).json({
            ok: true,
            joined: true,
            bonusGiven,
            bonusAmount: bonusGiven ? WELCOME_BONUS_GOLD : 0,
        });

    } catch (err) {
        console.error('verifyJoin error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
};

// ─────────────────────────────────────────────
// Telegram Bot API member check
async function checkMember(userId, chatId) {
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (!data.ok) return false;
        const status = data.result?.status;
        return ['member', 'administrator', 'creator'].includes(status);
    } catch (e) {
        console.error('checkMember error:', e.message);
        return false;
    }
}
