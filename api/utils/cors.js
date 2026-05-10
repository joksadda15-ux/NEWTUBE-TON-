// utils/cors.js
// CORS handler — সব API তে এটা use হয়

const ALLOWED_ORIGINS = [
  'https://newtube-ton.vercel.app',
  'https://t.me',
];

module.exports.handleCors = function handleCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o)) || process.env.NODE_ENV === 'development';

  res.setHeader('Access-Control-Allow-Origin', allowed ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true; // caller should return after this
  }
  return false;
};
