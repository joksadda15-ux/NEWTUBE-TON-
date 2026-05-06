const admin = require('firebase-admin');

if (!admin.apps.length) {
    try {
        // Vercel Environment Variables থেকে আপনার Firebase JSON ডাটা নিচ্ছে
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } catch (error) {
        console.error('Firebase Setup Error:', error);
    }
}

const db = admin.firestore();
module.exports = { db };
