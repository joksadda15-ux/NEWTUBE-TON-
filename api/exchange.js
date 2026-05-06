const { db } = require('./utils/firebase'); // utils থেকে কানেকশন

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: "Only POST allowed" });
    
    const { userId, goldAmount } = req.body;

    if (goldAmount < 1000 || goldAmount % 1000 !== 0) {
        return res.status(400).json({ error: "Exchange amount must be in multiples of 1000 Gold." });
    }

    const diamondsToGive = Math.floor(goldAmount / 1000);

    try {
        const userRef = db.collection('users').doc(userId);
        
        // Transaction ব্যবহার করছি যাতে হ্যাকাররা ডাবল ক্লিক করে বাগ তৈরি করতে না পারে
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            const user = doc.data();

            if (user.goldBalance < goldAmount) {
                throw new Error("Not enough Gold!");
            }

            t.update(userRef, {
                goldBalance: user.goldBalance - goldAmount,
                diamondBalance: user.diamondBalance + diamondsToGive
            });
        });

        return res.status(200).json({ success: true, message: "Exchange successful!" });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
