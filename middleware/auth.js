const jwt = require('jsonwebtoken');
const db = require('../db');

async function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.redirect('/admin/login');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Always pull fresh permissions from DB so admin changes take effect immediately
    if (decoded.role !== 'admin') {
      const r = await db.query('SELECT permissions FROM users WHERE id=$1 AND tenant_id=$2', [decoded.userId, decoded.tenantId]);
      if (r.rows[0]) decoded.permissions = JSON.parse(r.rows[0].permissions || '[]');
    }
    req.user = decoded;
    res.locals.currentUser = req.user;
    next();
  } catch {
    res.redirect('/admin/login');
  }
}

module.exports = requireAuth;
