const { db } = require('./utils/firebase');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    const { userId, goldAmount } = req.body;

    if (goldAmount < 1000 || goldAmount % 1000 !== 0) {
        return res.status(400).json({ error: "Exchange amount must be in multiples of 1000 Gold." });
    }

    const diamondsToGive = Math.floor(goldAmount / 1000);

    try {
        const userRef = db.collection('users').doc(String(userId));
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            const user = doc.data();
            if (user.goldBalance < goldAmount) throw new Error("Not enough Gold!");
            t.update(userRef, {
                goldBalance: user.goldBalance - goldAmount,
                diamondBalance: user.diamondBalance + diamondsToGive
            });
        });
        return res.status(200).json({ success: true });
    } catch (error) { return res.status(500).json({ error: error.message }); }
}
