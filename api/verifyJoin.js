const { db } = require('./utils/firebase');

export default async function handler(req, res) {
    const { userId } = req.query;
    const BOT_TOKEN = process.env.BOT_TOKEN;

    const checkMember = async (chatId) => {
        try {
            const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${chatId}&user_id=${userId}`);
            const data = await response.json();
            return data.ok && ['member', 'administrator', 'creator'].includes(data.result.status);
        } catch(e) { return false; }
    };

    try {
        const inChannel = await checkMember("@NEEWTON_OFFICIAL");
        const inGroup = await checkMember("@newTon_Gc");

        if (inChannel && inGroup) {
            await db.collection('users').doc(String(userId)).update({ isVerified: true });
            return res.status(200).json({ success: true });
        } else {
            return res.status(200).json({ success: false, inChannel, inGroup });
        }
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
