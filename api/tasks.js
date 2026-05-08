// api/tasks.js
// POST /api/tasks
// Body: { userId, taskId, category }
//
// Completes a task, awards Gold reward.
// Channel tasks require Telegram membership verification.
// Tracks daily task count for withdraw requirement (need 5/day).

const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

const BOT_TOKEN      = process.env.BOT_TOKEN;
const TASK_REWARD_GOLD = 500; // Gold per task

module.exports = async function handler(req, res) {
    if (handleCors(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'POST only' });
    }

    const { userId, taskId, category } = req.body || {};

    if (!userId || !taskId) {
        return res.status(400).json({ ok: false, error: 'userId and taskId required' });
    }

    const db      = getDb();
    const userRef = db.collection('users').doc(String(userId));
    const taskRef = db.collection('tasks').doc(String(taskId));

    try {
        // Fetch user and task in parallel
        const [userSnap, taskSnap] = await Promise.all([
            userRef.get(),
            taskRef.get(),
        ]);

        if (!userSnap.exists) return res.status(404).json({ ok: false, error: 'User not found' });
        if (!taskSnap.exists) return res.status(404).json({ ok: false, error: 'Task not found' });

        const user = userSnap.data();
        const task = taskSnap.data();

        if (user.isBanned) return res.status(403).json({ ok: false, error: 'Banned' });
        if (!task.isApproved) return res.status(400).json({ ok: false, error: 'Task not approved' });

        // Already completed?
        if ((user.completedTasks || []).includes(taskId)) {
            return res.status(400).json({ ok: false, error: 'Task already completed' });
        }

        // Task limit check
        if (task.limit > 0 && (task.completionCount || 0) >= task.limit) {
            return res.status(400).json({ ok: false, error: 'Task limit reached' });
        }

        // Channel membership check for channel tasks
        if (category === 'channel' && task.channelId) {
            const joined = await checkMember(userId, task.channelId);
            if (!joined) {
                return res.status(400).json({ ok: false, error: 'Join the channel first', notJoined: true });
            }
        }

        // Award Gold in a batch
        const batch = db.batch();

        batch.update(userRef, {
            goldBalance:         admin.firestore.FieldValue.increment(TASK_REWARD_GOLD),
            lifetimeGoldEarned:  admin.firestore.FieldValue.increment(TASK_REWARD_GOLD),
            completedTasks:      admin.firestore.FieldValue.arrayUnion(taskId),
            tasksCompletedToday: admin.firestore.FieldValue.increment(1),
        });

        batch.update(taskRef, {
            completionCount: admin.firestore.FieldValue.increment(1),
        });

        await batch.commit();

        return res.status(200).json({
            ok:          true,
            success:     true,
            goldAwarded: TASK_REWARD_GOLD,
            message:     `+${TASK_REWARD_GOLD} Gold earned!`,
        });

    } catch (err) {
        console.error('tasks error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
};

// ── Telegram membership check ──
async function checkMember(userId, chatId) {
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (!data.ok) return false;
        const status = data.result?.status;
        return ['member', 'administrator', 'creator'].includes(status);
    } catch (e) {
        return false;
    }
}
