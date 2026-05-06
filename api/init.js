const { db } = require('./utils/firebase'); // utils ফোল্ডার থেকে কানেকশন আনছি

export default async function handler(req, res) {
    const { userId, username } = req.query;
    
    if (!userId) {
        return res.status(400).json({ error: "User ID is required" });
    }

    try {
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();

        if (!doc.exists) {
            // নতুন ইউজার হলে ডাটাবেসে একাউন্ট তৈরি করে দিবে
            const newUser = {
                goldBalance: 0,
                diamondBalance: 0,
                totalInvites: 0,
                username: username || 'User',
                createdAt: new Date().toISOString()
            };
            await userRef.set(newUser);
            return res.status(200).json(newUser);
        }
        
        // পুরাতন ইউজার হলে তার ডাটা পাঠাবে
        return res.status(200).json(doc.data());
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
