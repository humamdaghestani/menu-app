const store = new Map();
const WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX    = 10;              // attempts before lockout

function loginRateLimiter(req, res, next) {
  const key = String(req.ip || 'x').replace(/[^0-9a-fA-F.:]/g, '').slice(0, 45);
  const now  = Date.now();
  const e    = store.get(key);

  if (e && now < e.resetAt) {
    if (e.count >= MAX) {
      const mins = Math.ceil((e.resetAt - now) / 60000);
      return res.render('admin/login', {
        error: `Too many failed attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`
      });
    }
    e.count++;
  } else {
    store.set(key, { count: 1, resetAt: now + WINDOW });
  }
  next();
}

function clearAttempts(ip) {
  const key = String(ip || 'x').replace(/[^0-9a-fA-F.:]/g, '').slice(0, 45);
  store.delete(key);
}

// Purge expired entries every 30 min so the Map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (now >= v.resetAt) store.delete(k);
}, 30 * 60 * 1000);

module.exports = { loginRateLimiter, clearAttempts };
