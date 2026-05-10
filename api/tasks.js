// api/tasks.js
// POST /api/tasks
// Body: { userId, taskId }
//
// Channel task হলে → Telegram Bot API দিয়ে membership verify
// Partner task হলে → directly complete (YouTube/Facebook/Telegram bot)
// Duplicate prevention: userId_taskId document ID
// Reward শুধু verified হলেই দেওয়া হবে

const { getDb, admin } = require('./utils/firebase');
const { handleCors }   = require('./utils/cors');

const BOT_TOKEN = process.env.BOT_TOKEN;

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'POST only' });

  const { userId, taskId } = req.body || {};
  if (!userId || !taskId)
    return res.status(400).json({ ok: false, error: 'userId and taskId required' });

  const db = getDb();

  try {
    // ── 1. Task load ──
    const taskSnap = await db.collection('tasks').doc(taskId).get();
    if (!taskSnap.exists)
      return res.status(404).json({ ok: false, error: 'Task not found' });
    const task = taskSnap.data();

    // ── 2. User load ──
    const userSnap = await db.collection('users').doc(String(userId)).get();
    if (!userSnap.exists)
      return res.status(404).json({ ok: false, error: 'User not found' });
    const user = userSnap.data();
    if (user.isBanned)
      return res.status(403).json({ ok: false, error: 'Banned' });

    // ── 3. Duplicate check ──
    const completionId  = `${userId}_${taskId}`;
    const completionRef = db.collection('task_completions').doc(completionId);
    const cSnap         = await completionRef.get();
    if (cSnap.exists)
      return res.status(200).json({ ok: false, error: 'Already completed', alreadyDone: true });

    // ── 4. Task limit check ──
    if (task.limit && task.limit > 0 && (task.completionCount || 0) >= task.limit)
      return res.status(400).json({ ok: false, error: 'Task limit reached' });

    // ── 5. Channel task → Telegram membership verify ──
    if (task.category === 'channel' && task.channelId) {
      if (!BOT_TOKEN)
        return res.status(500).json({ ok: false, error: 'Bot token not configured' });

      const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          chat_id: task.channelId,   // e.g. "@channelname"
          user_id: parseInt(userId),
        }),
      });
      const tgData = await tgRes.json();

      if (!tgData.ok) {
        return res.status(200).json({
          ok:      false,
          error:   'Telegram verify failed. Make sure bot is admin in channel.',
          tgError: tgData.description,
        });
      }

      const validStatuses = ['member', 'administrator', 'creator'];
      if (!validStatuses.includes(tgData.result?.status)) {
        return res.status(200).json({
          ok:      false,
          error:   'not_member',
          message: 'User has not joined the channel/group yet',
        });
      }
    }

    // ── 6. Partner task (YouTube / Facebook / Telegram Bot) ──
    // API verify লাগে না, directly complete
    // (taskType: youtube | facebook | telegram_bot | telegram_channel | other)

    // ── 7. Complete — atomic batch ──
    const rewardGold = task.rewardGold || task.rewardPoints || 250;
    const batch      = db.batch();

    // completion record
    batch.set(completionRef, {
      userId,
      taskId,
      rewardGold,
      category:    task.category,
      taskType:    task.taskType || 'other',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // user gold বাড়ানো
    batch.update(db.collection('users').doc(String(userId)), {
      goldBalance:          admin.firestore.FieldValue.increment(rewardGold),
      lifetimeGoldEarned:   admin.firestore.FieldValue.increment(rewardGold),
      tasksCompletedTotal:  admin.firestore.FieldValue.increment(1),
    });

    // task completion count বাড়ানো
    batch.update(db.collection('tasks').doc(taskId), {
      completionCount: admin.firestore.FieldValue.increment(1),
    });

    await batch.commit();

    return res.status(200).json({
      ok:         true,
      message:    'Task completed!',
      rewardGold,
    });

  } catch (err) {
    console.error('tasks API error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
