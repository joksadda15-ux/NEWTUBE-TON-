// utils/cors.js
// CORS handler — সব API তে এটা use হয়
// Telegram Mini App বিভিন্ন origin থেকে request করে, তাই সব allow করা হয়েছে

module.exports.handleCors = function handleCors(req, res) {
  const origin = req.headers.origin || '*';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
};
