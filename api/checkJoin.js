// api/checkJoin.js
// Checks if user has joined the required channel & group
// Called on app startup and on "Verify" button click

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;   // e.g. @NEEWTON_OFFICIAL  or  -100xxxxxxxxx
const GROUP_ID   = process.env.GROUP_ID;     // e.g. @newTon_Gc          or  -100xxxxxxxxx

async function isMember(chatId, userId) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.ok) return false;
  const status = data.result?.status;
  return ['member', 'administrator', 'creator'].includes(status);
}

export default async function handler(req, res) {
  // Allow GET (startup check) and POST (verify button)
  const userId =
    req.method === 'POST'
      ? (req.body?.userId || req.query?.userId)
      : req.query?.userId;

  if (!userId) {
    return res.status(400).json({ ok: false, error: 'missing_userId' });
  }

  try {
    const [inChannel, inGroup] = await Promise.all([
      isMember(CHANNEL_ID, userId),
      isMember(GROUP_ID,   userId),
    ]);

    const joined = inChannel && inGroup;

    return res.status(200).json({
      ok:       true,
      joined,
      channel:  inChannel,
      group:    inGroup,
    });
  } catch (err) {
    console.error('[checkJoin] error:', err.message);
    // On API error — don't block the user (fail-open)
    return res.status(200).json({ ok: true, joined: true, error: err.message });
  }
}
