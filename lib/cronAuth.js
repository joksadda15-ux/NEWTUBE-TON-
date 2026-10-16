// lib/cronAuth.js — shared check for cron / maintenance endpoints.
// Needs the Vercel env var CRON_SECRET (a long random string, NOT the bot token).
// FAIL-CLOSED: if CRON_SECRET is not set, every request is rejected.
// Accepted: header  Authorization: Bearer <CRON_SECRET>   (Vercel cron / cron-job.org header)
//      or   query   ?secret=<CRON_SECRET>                 (simple URL for cron-job.org)
import crypto from 'crypto';

function safeEq(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function isCronAuthorized(req) {
    const secret = process.env.CRON_SECRET;
    if (!secret) return false;
    const bearer = String(req.headers?.['authorization'] || '');
    const q = String(req.query?.secret || '');
    return safeEq(bearer, `Bearer ${secret}`) || safeEq(q, secret);
}
