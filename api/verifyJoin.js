// api/verifyJoin.js
// ══════════════════════════════════════════════════════════
// Channel/Group Membership Verify API
// Telegram Bot API দিয়ে user সত্যিই join করেছে কিনা check করে
// Reward শুধু verified হলেই দেওয়া হবে — fake completion সম্ভব না
// ══════════════════════════════════════════════════════════

import { db } from './init.js';
import {
  doc, getDoc, updateDoc, increment,
  collection, query, where, getDocs,
  serverTimestamp, setDoc
} from 'firebase/firestore';

const BOT_TOKEN = process.env.BOT_TOKEN;

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { userId, taskId } = req.body;

  // ── Input validation ──
  if (!userId || !taskId) {
    return res.status(400).json({ ok: false, error: 'userId and taskId required' });
  }

  try {
    // ── 1. Task data load করা ──
    const taskSnap = await getDoc(doc(db, 'tasks', taskId));
    if (!taskSnap.exists()) {
      return res.status(404).json({ ok: false, error: 'Task not found' });
    }
    const task = taskSnap.data();

    // Partner task হলে API verify লাগবে না — directly complete
    if (task.category === 'partner') {
      return await completeTask(res, userId, taskId, task);
    }

    // ── 2. Channel task: channelId আছে কিনা check ──
    const channelId = task.channelId;
    if (!channelId) {
      // channelId না থাকলে verify ছাড়াই complete
      return await completeTask(res, userId, taskId, task);
    }

    // ── 3. Already completed check ──
    const completionId = `${userId}_${taskId}`;
    const completionSnap = await getDoc(doc(db, 'task_completions', completionId));
    if (completionSnap.exists()) {
      return res.status(200).json({ ok: false, error: 'Already completed', alreadyDone: true });
    }

    // ── 4. Telegram Bot API দিয়ে membership verify ──
    if (!BOT_TOKEN) {
      return res.status(500).json({ ok: false, error: 'Bot token not configured' });
    }

    const tgRes = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: channelId,  // e.g. "@channelname"
          user_id: parseInt(userId)
        })
      }
    );
    const tgData = await tgRes.json();

    if (!tgData.ok) {
      // Bot channel-এ admin না হলে বা channel না পেলে
      console.error('Telegram API error:', tgData);
      return res.status(200).json({
        ok: false,
        error: 'Could not verify membership. Make sure bot is admin in the channel.',
        tgError: tgData.description
      });
    }

    const status = tgData.result?.status;
    const validStatuses = ['member', 'administrator', 'creator'];

    if (!validStatuses.includes(status)) {
      // User join করেনি
      return res.status(200).json({
        ok: false,
        error: 'not_member',
        message: 'User has not joined the channel yet'
      });
    }

    // ── 5. Verified! Task complete করা ──
    return await completeTask(res, userId, taskId, task);

  } catch (err) {
    console.error('verifyJoin error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ══════════════════════════════════════════════════════════
// completeTask: task complete করে reward দেওয়া
// ══════════════════════════════════════════════════════════
async function completeTask(res, userId, taskId, task) {
  try {
    const completionId = `${userId}_${taskId}`;

    // Already completed double-check
    const completionSnap = await getDoc(doc(db, 'task_completions', completionId));
    if (completionSnap.exists()) {
      return res.status(200).json({ ok: false, error: 'Already completed', alreadyDone: true });
    }

    const rewardGold = task.rewardGold || task.rewardPoints || 250;

    // Task limit check
    if (task.limit && task.limit > 0 && (task.completionCount || 0) >= task.limit) {
      return res.status(200).json({ ok: false, error: 'Task limit reached' });
    }

    // ── Batch write: completion record + user gold + task count ──
    const completionRef = doc(db, 'task_completions', completionId);
    const userRef = doc(db, 'users', userId);
    const taskRef = doc(db, 'tasks', taskId);

    // completion record তৈরি
    await setDoc(completionRef, {
      userId,
      taskId,
      rewardGold,
      category: task.category,
      completedAt: serverTimestamp()
    });

    // user-এর gold বাড়ানো
    await updateDoc(userRef, {
      goldBalance: increment(rewardGold),
      lifetimeGoldEarned: increment(rewardGold),
      tasksCompletedToday: increment(1)
    });

    // task completion count বাড়ানো
    await updateDoc(taskRef, {
      completionCount: increment(1)
    });

    return res.status(200).json({
      ok: true,
      message: 'Task completed!',
      rewardGold
    });

  } catch (err) {
    console.error('completeTask error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
