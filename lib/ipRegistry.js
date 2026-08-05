// lib/ipRegistry.js — SEASON 3: pure IP-based multi-account gate
//
// Replaces the old "flag on device fingerprint, then auto-ban" approach for
// NEW behavior requested this season: one Telegram account may be active per
// IP at a time. A second account opening the app from the same IP is BLOCKED
// at the door (never gets to create/load their session) and shown who
// currently owns that IP — matching the reference "IP Already In Use" screen.
//
// This is deliberately NOT a ban. The blocked user has two ways forward:
//   1. Switch network/VPN and retry — the IP changes, so the block clears.
//   2. "Switch account" — claim this IP for THEIR account instead. This is
//      allowed, but costs their entire balance (wtcBalance/usdtBalance reset
//      to 0, lifetime stats zeroed) so it can't be used to cheaply cycle
//      through many accounts on one IP. See claimIpForUser().
//
// COLLECTION: ipRegistry
//   { _id: "<ip address>", userId: "<current owner telegram id>", claimedAt: Date }
// One document per IP. Whoever holds the mapping is the sole account allowed
// to use the app from that IP right now.

// Vercel/most proxies put the real client IP first in x-forwarded-for.
// Fall back through the other common headers, then the raw socket as a last resort.
export function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']).trim();
    return req.socket?.remoteAddress || 'unknown';
}

// Returns { blocked: false } if this IP is free or already owned by userId.
// Returns { blocked: true, ownerId } if a DIFFERENT userId currently owns it.
export async function checkIp(db, ip, userId) {
    if (!ip || ip === 'unknown') return { blocked: false }; // never lock users out over a detection failure
    const entry = await db.collection('ipRegistry').findOne({ _id: ip });
    if (!entry) return { blocked: false, unclaimed: true };
    if (entry.userId === userId) return { blocked: false };
    return { blocked: true, ownerId: entry.userId };
}

// First-time claim of a free IP — does not touch balances.
export async function claimIp(db, ip, userId) {
    if (!ip || ip === 'unknown') return;
    await db.collection('ipRegistry').updateOne(
        { _id: ip },
        { $set: { userId, claimedAt: new Date() } },
        { upsert: true }
    );
}

// "Switch account" — force-claim an IP already owned by someone else, at the
// cost of wiping the switching user's own balance. Reassigns the ipRegistry
// mapping to this user; the PREVIOUS owner's account is untouched (they just
// no longer own this particular IP — if they show up on it again later
// they'll hit the same block from the other side).
export async function claimIpForUser(db, ip, userId) {
    await db.collection('ipRegistry').updateOne(
        { _id: ip },
        { $set: { userId, claimedAt: new Date() } },
        { upsert: true }
    );
    await db.collection('users').updateOne(
        { _id: userId },
        {
            $set: {
                wtcBalance: 0,
                usdtBalance: 0,
                lifetimeWtcEarned: 0,
                pendingVideoWTC: 0,
                dailyVideoWtcMined: 0,
                lastAccountSwitchAt: new Date(),
            },
            $inc: { accountSwitchCount: 1 },
        }
    );
}

// Public-safe snippet of the current owner's identity for the block screen —
// never leak balances or internal flags to the blocked visitor.
export async function getOwnerPublicInfo(db, ownerId) {
    const owner = await db.collection('users').findOne(
        { _id: ownerId },
        { projection: { firstName: 1, telegramUsername: 1 } }
    );
    if (!owner) return { id: ownerId, firstName: 'Unknown', telegramUsername: null };
    return { id: ownerId, firstName: owner.firstName || 'User', telegramUsername: owner.telegramUsername !== 'N/A' ? owner.telegramUsername : null };
}
