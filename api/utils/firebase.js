// api/utils/firebase.js
const admin = require('firebase-admin');

let db;

function getDb() {
    if (!db) {
        if (!admin.apps.length) {
            try {
                let serviceAccount;
                const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

                if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is missing');

                // Try Base64 decode first, then plain JSON
                try {
                    serviceAccount = JSON.parse(
                        Buffer.from(raw, 'base64').toString('utf8')
                    );
                } catch (e) {
                    serviceAccount = JSON.parse(raw);
                }

                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount),
                });
            } catch (err) {
                console.error('Firebase init error:', err.message);
                throw err;
            }
        }
        db = admin.firestore();
    }
    return db;
}

module.exports = { getDb, admin };
