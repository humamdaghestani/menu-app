const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { cacheBustByTenantId } = require('./menu');

function requireSuperAdmin(req, res, next) {
  const token = req.cookies?.sa_token;
  if (!token) return res.redirect('/superadmin/login');
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload.superAdmin) return res.redirect('/superadmin/login');
    req.superAdmin = payload;
    next();
  } catch {
    res.redirect('/superadmin/login');
  }
}

router.get('/login', (req, res) => {
  res.render('superadmin/login', { error: null });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (email !== process.env.SUPER_ADMIN_EMAIL || password !== process.env.SUPER_ADMIN_PASSWORD) {
    return res.render('superadmin/login', { error: 'Invalid credentials' });
  }
  const token = jwt.sign({ superAdmin: true, email }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.cookie('sa_token', token, { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 });
  res.redirect('/superadmin');
});

router.post('/logout', (req, res) => {
  res.clearCookie('sa_token');
  res.redirect('/superadmin/login');
});

router.get('/', requireSuperAdmin, async (req, res) => {
  try {
    const tenants = await db.query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM menu_items WHERE tenant_id = t.id)::int  AS item_count,
        (SELECT COUNT(*) FROM orders    WHERE tenant_id = t.id)::int  AS order_count,
        (SELECT COUNT(*) FROM feedback  WHERE tenant_id = t.id)::int  AS feedback_count,
        (SELECT email    FROM users     WHERE tenant_id = t.id AND role='admin' LIMIT 1) AS admin_email
      FROM tenants t
      ORDER BY t.created_at DESC
    `);
    const rows = tenants.rows;
    const stats = {
      total:       rows.length,
      active:      rows.filter(t => t.active).length,
      totalViews:  rows.reduce((s, t) => s + (parseInt(t.view_count) || 0), 0),
      totalOrders: rows.reduce((s, t) => s + (t.order_count || 0), 0),
    };
    const params = new URLSearchParams();
    res.render('superadmin/dashboard', { tenants: rows, stats, qs: Object.fromEntries(new URLSearchParams(req.query)) });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.post('/tenants', requireSuperAdmin, async (req, res) => {
  const { subdomain, name, description, admin_email, admin_password } = req.body;
  try {
    if (!subdomain || !name || !admin_email || !admin_password)
      return res.redirect('/superadmin?error=All+fields+are+required');
    const tenantRes = await db.query(
      'INSERT INTO tenants (subdomain, name, description) VALUES ($1,$2,$3) RETURNING id',
      [subdomain.toLowerCase().trim(), name, description || null]
    );
    const hash = await bcrypt.hash(admin_password, 10);
    await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1,$2,$3,$4)',
      [tenantRes.rows[0].id, admin_email, hash, 'admin']
    );
    res.redirect('/superadmin?success=Restaurant+created+successfully');
  } catch (err) {
    console.error(err);
    res.redirect('/superadmin?error=Failed+(subdomain+or+email+may+already+exist)');
  }
});

router.post('/tenants/:id/edit', requireSuperAdmin, async (req, res) => {
  const { name, subdomain, admin_email } = req.body;
  try {
    await db.query(
      'UPDATE tenants SET name=$1, subdomain=$2 WHERE id=$3',
      [name, subdomain.toLowerCase().trim(), req.params.id]
    );
    if (admin_email) {
      await db.query('UPDATE users SET email=$1 WHERE tenant_id=$2 AND role=$3', [admin_email, req.params.id, 'admin']);
    }
    res.redirect('/superadmin?success=Restaurant+updated');
  } catch (err) { console.error(err); res.redirect('/superadmin?error=' + encodeURIComponent(err.message)); }
});

router.post('/tenants/:id/toggle', requireSuperAdmin, async (req, res) => {
  try {
    await db.query('UPDATE tenants SET active = NOT active WHERE id=$1', [req.params.id]);
    res.redirect('/superadmin');
  } catch (err) { console.error(err); res.redirect('/superadmin?error=Failed'); }
});

router.post('/tenants/:id/delete', requireSuperAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM tenants WHERE id=$1', [req.params.id]);
    res.redirect('/superadmin?success=Restaurant+deleted');
  } catch (err) { console.error(err); res.redirect('/superadmin?error=Failed+to+delete'); }
});

// Update feature flags
router.post('/tenants/:id/features', requireSuperAdmin, async (req, res) => {
  try {
    const features = ['feat_feedback','feat_orders','feat_import','feat_custom_css','feat_multilang','feat_valet','feat_splash_custom'];
    const values = features.map(f => req.body[f] === '1');
    console.log(`[features] tenant=${req.params.id} body=${JSON.stringify(req.body)} values=${JSON.stringify(values)}`);
    const result = await db.query(
      `UPDATE tenants SET
        feat_feedback=$1, feat_orders=$2, feat_import=$3,
        feat_custom_css=$4, feat_multilang=$5, feat_valet=$6, feat_splash_custom=$7
       WHERE id=$8`,
      [...values, req.params.id]
    );
    console.log(`[features] rowCount=${result.rowCount}`);
    cacheBustByTenantId(parseInt(req.params.id));
    res.redirect('/superadmin?success=Features+updated');
  } catch (err) {
    console.error('[features] error:', err.message);
    res.redirect('/superadmin?error=' + encodeURIComponent(err.message));
  }
});

// Log in as a tenant's admin (impersonate)
router.get('/tenants/:id/login', requireSuperAdmin, async (req, res) => {
  try {
    const userRes = await db.query(
      'SELECT * FROM users WHERE tenant_id=$1 AND role=$2 LIMIT 1',
      [req.params.id, 'admin']
    );
    if (userRes.rows.length === 0) return res.redirect('/superadmin?error=No+admin+user+found');
    const user = userRes.rows[0];
    const token = jwt.sign(
      { userId: user.id, tenantId: user.tenant_id, role: user.role, permissions: [] },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );
    res.cookie('token', token, { httpOnly: true, maxAge: 2 * 60 * 60 * 1000 });
    res.redirect('/admin/dashboard');
  } catch (err) { console.error(err); res.redirect('/superadmin?error=Failed+to+access'); }
});

module.exports = router;
