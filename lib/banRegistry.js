// lib/banRegistry.js — shared ban/unban helpers
//
// Extracted out of api/bot.js so the SAME logic can be called from two
// places: the admin manually banning someone via bot.js, and
// lib/fingerprintCheck.js auto-banning a newly-detected multi-account
// signup. Keeping this in one file means both paths always stay in sync —
// if the registry logic ever changes, there's only one place to update
// instead of two copies quietly drifting apart.
//
// A permanently-banned user's full `users` document auto-deletes 60 days
// after `bannedAt` (see models/schema.js's TTL index) to free up free-tier
// storage. But if we ONLY deleted the users doc, that Telegram ID could
// simply reopen the app after deletion and api/user.js's handleInit would
// see "no existing user" and happily create them a brand-new, un-banned
// account — silently undoing the ban.
//
// To prevent that, every ban/unban action ALSO writes to a tiny, separate
// `bannedTelegramIds` collection (just an _id, no other fields — near-zero
// storage cost, no TTL, persists forever). api/user.js's handleInit checks
// this registry before creating a new account and refuses if the ID is
// present. Unbanning removes the ID from this registry too, so a
// genuinely-reinstated user can rejoin normally.

export async function markBanned(db, ids) {
    const list = ids.filter(Boolean).map(String);
    if (!list.length) return;
    const now = new Date();
    await db.collection('bannedTelegramIds').bulkWrite(
        list.map(id => ({ updateOne: { filter: { _id: id }, update: { $set: { bannedAt: now } }, upsert: true } }))
    );
}

export async function markUnbanned(db, ids) {
    const list = ids.filter(Boolean).map(String);
    if (!list.length) return;
    await db.collection('bannedTelegramIds').deleteMany({ _id: { $in: list } });
}

// Convenience wrapper for the one-user auto-ban case (fingerprintCheck.js) —
// sets the user doc's ban fields AND the registry in one call, so callers
// don't have to remember to do both separately.
export async function banUser(db, userId, extraFields = {}) {
    await db.collection('users').updateOne(
        { _id: userId },
        { $set: { isBanned: true, bannedAt: new Date(), ...extraFields } }
    );
    await markBanned(db, [userId]);
}
