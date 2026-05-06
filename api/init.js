const { db } = require('./utils/firebase');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    const { userId, username, referrer } = req.body;
    const BOT_TOKEN = process.env.BOT_TOKEN;
    
    if (!userId) return res.status(400).json({ error: "Missing ID" });

    try {
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();

        if (!doc.exists) {
            const newUser = {
                goldBalance: 0,
                diamondBalance: 0,
                username: username || 'User',
                isVerified: false,
                referredBy: (referrer && referrer !== String(userId)) ? String(referrer) : null,
                createdAt: new Date().toISOString()
            };
            
            // যদি রেফারার থাকে, তাকে ১৫০০ গোল্ড দেওয়া এবং মেসেজ পাঠানো
            if (newUser.referredBy) {
                const refUserRef = db.collection('users').doc(newUser.referredBy);
                await refUserRef.update({ goldBalance: require('firebase-admin').firestore.FieldValue.increment(1500) }).catch(()=>console.log('Ref doc not exist'));
                
                // Telegram Bot API দিয়ে মেসেজ পাঠানো
                if(BOT_TOKEN) {
                    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: newUser.referredBy,
                            text: `🎉 *Congratulations!*\n\nYou have received *1,500 Gold* from a new referral: ${username}\nYou will also get 10% commission from their earnings!`,
                            parse_mode: 'Markdown'
                        })
                    }).catch(e => console.log('Message fail', e));
                }
            }

            await userRef.set(newUser);
            return res.status(200).json({ id: userId, ...newUser });
        }
        
        return res.status(200).json({ id: userId, ...doc.data() });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
