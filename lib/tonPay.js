// lib/tonPay.js — ⚠️ NEW — shared helpers for TON-deposit-gated features.
// Factored out once a SECOND feature (user-created tasks, api/payments.js (resource:'taskcreate'))
// needed the exact same on-chain-polling logic as
// api/payments.js (cron=checkDeposits) — rather than copy-pasting it. See that
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
// admin/debug views (e.g. "TC" for Task Create) even
// though each feature also lives in its own DB collection, so there's no
// actual matching collision risk between them either way.
export function randomTonMemo(prefix) {
    return prefix + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// was `ton://transfer/...` (raw custom URL scheme). That works
// fine in a normal mobile browser, but Telegram's in-app WebView (which is
// what actually renders this Mini App) refuses to navigate a plain
// `<a href="ton://...">` tag to an unknown scheme and throws
// net::ERR_UNKNOWN_URL_SCHEME instead of handing it off to the OS.
// Tonkeeper's own universal link (https://) is the documented workaround:
// Telegram's WebView treats it as a normal https link, the OS/Telegram
// then recognizes app.tonkeeper.com and opens the Tonkeeper app if
// installed, or falls back to the Tonkeeper web wallet in-browser if not.
export function buildTonDeepLink(amountNanoTon, memo) {
    return `https://app.tonkeeper.com/transfer/${TON_RECEIVE_ADDRESS}?amount=${amountNanoTon}&text=${encodeURIComponent(memo)}`;
}

// Returns TonCenter's `result` array (newest-first) of recent transactions
// to TON_RECEIVE_ADDRESS. Each entry's `in_msg.message` is the decoded
// plain-text comment (when present) and `in_msg.value` the amount in
// nanoTON (string) — see TonCenter v2 getTransactions docs.
export async function fetchRecentTonTransactions(limit = 100) { // 15 Oct 2026: 50 -> 100 (TonCenter max) — outgoing payouts share this window, so a deposit could be pushed out before the cron saw it
    // 16 Oct 2026: TonCenter's public API sometimes answers HTTP 500/429 for a
    // moment. Retry up to 3 times (short pause between tries; the last try
    // drops the optional `archival` flag) before giving up, so one hiccup no
    // longer fails the whole deposit check.
    const headers = TONCENTER_API_KEY ? { 'X-API-Key': TONCENTER_API_KEY } : {};
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const url = new URL('https://toncenter.com/api/v2/getTransactions');
            url.searchParams.set('address', TON_RECEIVE_ADDRESS);
            url.searchParams.set('limit', String(limit));
            if (attempt < 2) url.searchParams.set('archival', 'false');
            const r = await fetch(url.toString(), { headers });
            if (r.ok) {
                const data = await r.json();
                if (data.ok) return data.result || [];
                lastErr = new Error(`TonCenter error: ${JSON.stringify(data).slice(0, 200)}`);
            } else {
                lastErr = new Error(`TonCenter HTTP ${r.status}`);
                // 4xx (except 429) = our request/key is wrong, retrying won't help.
                if (r.status >= 400 && r.status < 500 && r.status !== 429) throw lastErr;
            }
        } catch (e) {
            lastErr = e;
            if (/TonCenter HTTP 4\d\d/.test(String(e?.message)) && !/429/.test(String(e?.message))) throw e;
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
    }
    throw lastErr || new Error('TonCenter unreachable');
}
