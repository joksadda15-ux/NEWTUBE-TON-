// api/tasks.js
// Handles task completion:
//   - category === 'channel'  → verifies Telegram membership via Bot API, then awards Gold
//   - category === 'partner'  → no membership check, awards Gold directly
// POST /api/tasks  body: { userId, taskId }

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue }      from 'firebase-admin/firestore';

// ── Firebase Admin (init once) ──
if (!getApps().length) {
    initializeApp({
        credential: cert({
            projectId:   process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
    });
}
const db = getFirestore();

const BOT_TOKEN = process.env.BOT_TOKEN;

async function isMember(chatId, userId) {
    try {
        const url  = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`;
        const res  = await fetch(url);
        const data = await res.json();
        if (!data.ok) return false;
        const status = data.result?.status;
        return ['member', 'administrator', 'creator'].includes(status);
    } catch (e) {
        return false;
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    const { userId, taskId } = req.body || {};
    if (!userId || !taskId) {
        return res.status(400).json({ ok: false, error: 'missing_params' });
    }

    try {
        // ── 1. Load task ──
        const taskSnap = await db.collection('tasks').doc(String(taskId)).get();
        if (!taskSnap.exists) {
            return res.status(404).json({ ok: false, error: 'task_not_found' });
        }
        const task = taskSnap.data();

        // ── 2. Load user ──
        const userRef  = db.collection('users').doc(String(userId));
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
            return res.status(404).json({ ok: false, error: 'user_not_found' });
        }
        const user = userSnap.data();

        // ── 3. Already completed? ──
        if ((user.completedTasks || []).includes(taskId)) {
            return res.status(200).json({ ok: false, alreadyDone: true });
        }

        // ── 4. Task limit check ──
        const taskLimit = task.limit || 0;
        if (taskLimit > 0 && (task.completionCount || 0) >= taskLimit) {
            return res.status(200).json({ ok: false, error: 'task_limit_reached' });
        }

        // ── 5. Channel membership check (only for channel tasks) ──
        if (task.category === 'channel' && task.channelId) {
            const member = await isMember(task.channelId, userId);
            if (!member) {
                return res.status(200).json({ ok: false, error: 'not_member' });
            }
        }
        // Partner tasks → skip membership check, award directly

        // ── 6. Award Gold via batch write ──
        const reward = task.rewardGold || task.rewardPoints || 250;
        const batch  = db.batch();

        batch.update(userRef, {
            goldBalance:         FieldValue.increment(reward),
            lifetimeGoldEarned:  FieldValue.increment(reward),
            completedTasks:      FieldValue.arrayUnion(taskId),
            tasksCompletedToday: FieldValue.increment(1),
        });
        batch.update(db.collection('tasks').doc(String(taskId)), {
            completionCount: FieldValue.increment(1),
        });

        await batch.commit();

        return res.status(200).json({ ok: true, rewardGold: reward });

    } catch (err) {
        console.error('[tasks] error:', err.message);
        return res.status(500).json({ ok: false, error: 'server_error', details: err.message });
    }
}
