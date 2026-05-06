const { db } = require('./utils/firebase');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    const { userId, method, amount, address } = req.body;

    if (method === 'tonkeeper' && amount < 50) return res.status(400).json({ error: "Min 50 Diamonds for Tonkeeper" });
    if (method === 'binance' && amount < 100) return res.status(400).json({ error: "Min 100 Diamonds for Binance" });

    try {
        const userRef = db.collection('users').doc(String(userId));
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            const user = doc.data();
            
            if (user.diamondBalance < amount) throw new Error("Insufficient Diamonds");

            t.update(userRef, { diamondBalance: user.diamondBalance - amount });
            
            const withdrawRef = db.collection('withdrawals').doc();
            t.set(withdrawRef, {
                userId, method, amount, address,
                status: 'Pending', createdAt: new Date().toISOString()
            });
        });
        return res.status(200).json({ success: true });
    } catch (error) { return res.status(500).json({ error: error.message }); }
}
