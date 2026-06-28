const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];

  if (!token) return res.redirect('/admin/login');

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    res.locals.currentUser = req.user;
    next();
  } catch {
    res.redirect('/admin/login');
  }
}

module.exports = requireAuth;
