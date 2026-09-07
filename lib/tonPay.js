// lib/tonPay.js — ⚠️ NEW — shared helpers for TON-deposit-gated features.
// Factored out once a SECOND feature (user-created tasks, api/taskcreate.js)
// needed the exact same on-chain-polling logic as
// api/cron/checkPunchKeyDeposits.js — rather than copy-pasting it. See that
// file's header for the full design rationale (why memo-matching, why
// atomic status:'pending'→'paid', why an EXTERNAL cron instead of Vercel's
// own). Any future "pay X TON, unlock Y automatically" feature should
// reuse this too instead of writing a third copy.

export const TON_RECEIVE_ADDRESS = process.env.TON_RECEIVE_ADDRESS;
// ⚠️ OPTIONAL but recommended — TonCenter's public endpoint allows 1
// request/second WITHOUT a key, already enough for a once-a-minute cron. A
// free key (message @tonapibot on Telegram) just makes this more reliable
// since the keyless endpoint is shared with every other app hitting it.
export const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY;

// `prefix` keeps different features' memos visually distinguishable in
// admin/debug views (e.g. "PK" for Punch Key, "TC" for Task Create) even
// though each feature also lives in its own DB collection, so there's no
// actual matching collision risk between them either way.
export function randomTonMemo(prefix) {
    return prefix + Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function buildTonDeepLink(amountNanoTon, memo) {
    return `ton://transfer/${TON_RECEIVE_ADDRESS}?amount=${amountNanoTon}&text=${encodeURIComponent(memo)}`;
}

// Returns TonCenter's `result` array (newest-first) of recent transactions
// to TON_RECEIVE_ADDRESS. Each entry's `in_msg.message` is the decoded
// plain-text comment (when present) and `in_msg.value` the amount in
// nanoTON (string) — see TonCenter v2 getTransactions docs.
export async function fetchRecentTonTransactions(limit = 50) {
    const url = new URL('https://toncenter.com/api/v2/getTransactions');
    url.searchParams.set('address', TON_RECEIVE_ADDRESS);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('archival', 'false');
    const headers = TONCENTER_API_KEY ? { 'X-API-Key': TONCENTER_API_KEY } : {};
    const r = await fetch(url.toString(), { headers });
    if (!r.ok) throw new Error(`TonCenter HTTP ${r.status}`);
    const data = await r.json();
    if (!data.ok) throw new Error(`TonCenter error: ${JSON.stringify(data)}`);
    return data.result || [];
}
