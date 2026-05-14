// api/taskComplete.js
// Channel tasks: MUST verify Telegram membership before crediting gold.
// If BOT_TOKEN or CHANNEL_ID is missing → hard fail (never silently pass).

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID   = process.env.GROUP_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

function getAdminApp() {
    if (getApps().length > 0) return getApps()[0];
    return initializeApp({
        credential: cert({
            projectId:   process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
    });
}

// Telegram supergroup/channel IDs must be negative (e.g. -1001234567890)
function normalizeChatId(id) {
    if (!id) return null;
    const str = String(id).trim();
    if (str.startsWith('@')) return str;
    const num = parseInt(str, 10);
    if (isNaN(num)) return str;
    if (num > 0) return `-100${num}`; // e.g. 1234567890 → -1001234567890
    return String(num);               // already negative
}

// STRICT: never returns true on config error — throws instead
async function isMember(userId, chatId) {
    if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set in Vercel environment variables');
    if (!chatId)    throw new Error('chatId is empty — check CHANNEL_ID / GROUP_ID env vars');

    const normalizedChatId = normalizeChatId(chatId);
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${normalizedChatId}&user_id=${userId}`;

    let d;
    try {
        const r = await fetch(url);
        d = await r.json();
    } catch (e) {
        throw new Error(`Telegram API network error: ${e.message}`);
    }

    if (!d.ok) {
        console.warn('[isMember] Telegram error:', d.description, '| chatId:', normalizedChatId, '| userId:', userId);
        return false; // bot not in chat, or user never messaged bot — treat as not member
    }

    const status = d.result?.status;
    console.log(`[isMember] userId=${userId} chatId=${normalizedChatId} status=${status}`);
    return ['member', 'administrator', 'creator'].includes(status);
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, taskId } = req.body || {};
    if (!userId || !taskId) return res.status(400).json({ ok: false, error: 'missing_fields' });

    try {
        const app = getAdminApp();
        const db  = getFirestore(app);

        // 1. Get task
        const taskSnap = await db.collection('tasks').doc(taskId).get();
        if (!taskSnap.exists) return res.status(404).json({ ok: false, error: 'task_not_found' });
        const task = taskSnap.data();
        if (!task.isApproved) return res.status(400).json({ ok: false, error: 'task_not_approved' });

        // 2. Task limit
        if ((task.limit || 0) > 0 && (task.completionCount || 0) >= task.limit) {
            return res.status(200).json({ ok: false, error: 'task_limit_reached' });
        }

        // 3. Get user
        const userRef  = db.collection('users').doc(String(userId));
        const userSnap = await userRef.get();
        if (!userSnap.exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        const user = userSnap.data();
        if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

        // 4. Already completed?
        if (user.completedTasks?.includes(taskId)) {
            return res.status(200).json({ ok: false, alreadyDone: true, error: 'already_completed' });
        }

        // 5. CHANNEL TASK → strict membership check (throws on config error)
        if (task.category === 'channel') {
            const taskChannelId = task.channelId || CHANNEL_ID;

            const inChannel = await isMember(userId, taskChannelId);
            const inGroup   = GROUP_ID ? await isMember(userId, GROUP_ID) : true;

            console.log(`[taskComplete] userId=${userId} taskId=${taskId} inChannel=${inChannel} inGroup=${inGroup}`);

            if (!inChannel || !inGroup) {
                return res.status(200).json({
                    ok: false,
                    error: 'not_member',
                    message: 'Channel/Group-এ join করুন, তারপর Verify করুন!'
                });
            }
        }

        // 6. Credit gold
        const reward = task.rewardGold || task.rewardPoints || 250;
        const batch  = db.batch();
        batch.update(userRef, {
            completedTasks:      FieldValue.arrayUnion(taskId),
            goldBalance:         FieldValue.increment(reward),
            lifetimeGoldEarned:  FieldValue.increment(reward),
            tasksCompletedToday: FieldValue.increment(1),
        });
        batch.update(db.collection('tasks').doc(taskId), {
            completionCount: FieldValue.increment(1),
        });
        await batch.commit();

        return res.status(200).json({ ok: true, rewardGold: reward });

    } catch (err) {
        console.error('[taskComplete]', err);
        return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
    }
}
