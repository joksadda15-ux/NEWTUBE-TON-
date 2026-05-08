// api/utils/firebase.js
// Shared Firebase Admin SDK initializer

const admin = require('firebase-admin');

let db;

function getDb() {
    if (!db) {
        if (!admin.apps.length) {
            const serviceAccount = JSON.parse(
                Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')
            );
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });
        }
        db = admin.firestore();
    }
    return db;
}

module.exports = { getDb, admin };
