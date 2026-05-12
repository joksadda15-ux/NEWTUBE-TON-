// utils/firebase.js
// Firebase Admin SDK — FIREBASE_SERVICE_ACCOUNT (full JSON) থেকে init

const admin = require('firebase-admin');

let db = null;

function getDb() {
  if (!db) {
    if (!admin.apps.length) {
      let serviceAccount;
      try {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (!raw) {
          throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is not set');
        }
        // Vercel কখনো কখনো JSON string এ extra escaping করে — দুইভাবে try করো
        try {
          serviceAccount = JSON.parse(raw);
        } catch (e1) {
          // Double-encoded হলে একবার আরো parse করো
          serviceAccount = JSON.parse(JSON.parse(raw));
        }
      } catch (err) {
        console.error('Firebase init error — could not parse FIREBASE_SERVICE_ACCOUNT:', err.message);
        throw new Error('Firebase configuration error: ' + err.message);
      }

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    db = admin.firestore();
  }
  return db;
}

module.exports = { getDb, admin };
