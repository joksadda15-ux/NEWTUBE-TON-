// api/taskComplete.js
// Handles channel & partner task completion.
// Channel tasks: checks Telegram membership before crediting gold.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID   = process.env.GROUP_ID;      // e.g. -1001234567890
const CHANNEL_ID = process.env.CHANNEL_ID;   // e.g. -1009876543210

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

// Normalize chat_id — Telegram requires negative ID for groups/channels
function normalizeChatId(id) {
    if (!id) return null;
    const str = String(id).trim();
    // If it's already a username (@handle), return as-is
    if (str.startsWith('@')) return str;
    const num = parseInt(str, 10);
    if (isNaN(num)) return str;
    // Supergroups/channels must be negative; if positive add -100 prefix
    if (num > 0) return -(num + 100000000000);  // rarely needed but safe
    return num;
}

async function isMember(userId, chatId) {
    if (!chatId || !BOT_TOKEN) return true; // skip check if not configured
    try {
        const normalizedChatId = normalizeChatId(chatId);
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${normalizedChatId}&user_id=${userId}`;
        const r   = await fetch(url);
        const d   = await r.json();
        if (!d.ok) {
            console.warn('[isMember] Telegram API error:', d.description, 'chatId:', normalizedChatId);
            // If Telegram returns "user not found" or chat not found, they're not a member
            return false;
        }
        const status = d.result?.status;
        return ['member', 'administrator', 'creator'].includes(status);
    } catch (e) {
        console.error('[isMember] fetch error:', e.message);
        return false; // on network error, fail safely
    }
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

        // 1. Get task details
        const taskSnap = await db.collection('tasks').doc(taskId).get();
        if (!taskSnap.exists) return res.status(404).json({ ok: false, error: 'task_not_found' });

        const task = taskSnap.data();
        if (!task.isApproved) return res.status(400).json({ ok: false, error: 'task_not_approved' });

        // 2. Check task completion limit
        if ((task.limit || 0) > 0 && (task.completionCount || 0) >= task.limit) {
            return res.status(200).json({ ok: false, error: 'task_limit_reached' });
        }

        // 3. Get user doc
        const userRef  = db.collection('users').doc(String(userId));
        const userSnap = await userRef.get();
        if (!userSnap.exists) return res.status(404).json({ ok: false, error: 'user_not_found' });

        const user = userSnap.data();
        if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

        // 4. Check already completed
        if (user.completedTasks?.includes(taskId)) {
            return res.status(200).json({ ok: false, alreadyDone: true, error: 'already_completed' });
        }

        // 5. ── CHANNEL TASK: Telegram membership check ──
        if (task.category === 'channel') {
            // Use task-specific channelId if set, else fall back to env CHANNEL_ID
            const taskChannelId = task.channelId || CHANNEL_ID;

            const [inChannel, inGroup] = await Promise.all([
                isMember(userId, taskChannelId),
                GROUP_ID ? isMember(userId, GROUP_ID) : Promise.resolve(true),
            ]);

            console.log(`[taskComplete] userId=${userId} taskId=${taskId} inChannel=${inChannel} inGroup=${inGroup} channelId=${taskChannelId} groupId=${GROUP_ID}`);

            if (!inChannel || !inGroup) {
                return res.status(200).json({
                    ok: false,
                    error: 'not_member',
                    debug: { inChannel, inGroup } // visible in Vercel logs
                });
            }
        }

        // 6. Credit gold atomically
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
