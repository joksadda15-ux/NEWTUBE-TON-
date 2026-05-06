const { db } = require('./utils/firebase');
const admin = require('firebase-admin');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    const { userId, action, amount } = req.body;
    
    if(amount > 1000) return res.status(400).json({ error: "Invalid amount" });

    try {
        const userRef = db.collection('users').doc(String(userId));
        
        const newBalance = await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw new Error("User not found");
            
            const user = doc.data();
            const newGold = user.goldBalance + amount;
            t.update(userRef, { goldBalance: newGold });

            // 10% Commission Logic
            if (user.referredBy) {
                const commission = Math.floor(amount * 0.10);
                if(commission > 0) {
                    const refUserRef = db.collection('users').doc(user.referredBy);
                    t.update(refUserRef, { goldBalance: admin.firestore.FieldValue.increment(commission) });
                }
            }

            return newGold;
        });

        return res.status(200).json({ success: true, newGoldBalance: newBalance });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
