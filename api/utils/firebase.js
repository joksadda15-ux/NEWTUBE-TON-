// utils/firebase.js
// Firebase Admin SDK — FIREBASE_SERVICE_ACCOUNT (full JSON) থেকে init

const admin = require('firebase-admin');

let db = null;

function getDb() {
  if (!db) {
    if (!admin.apps.length) {
      // Vercel এ FIREBASE_SERVICE_ACCOUNT = পুরো service account JSON string
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    db = admin.firestore();
  }
  return db;
}

module.exports = { getDb, admin };
