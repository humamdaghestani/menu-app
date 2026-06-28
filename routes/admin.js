const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');
const requireAuth = require('../middleware/auth');

// ── Login ──────────────────────────────────────────
router.get('/login', (req, res) => {
  res.render('admin/login', { error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await db.query(
      `SELECT u.*, t.subdomain, t.name as tenant_name
       FROM users u JOIN tenants t ON u.tenant_id = t.id
       WHERE u.email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.render('admin/login', { error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.render('admin/login', { error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user.id, tenantId: user.tenant_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error(err);
    res.render('admin/login', { error: 'Server error, try again' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/admin/login');
});

// ── Dashboard ──────────────────────────────────────
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const categories = await db.query(
      'SELECT * FROM categories WHERE tenant_id = $1 ORDER BY sort_order',
      [req.user.tenantId]
    );
    const items = await db.query(
      `SELECT i.*, c.name as category_name
       FROM menu_items i LEFT JOIN categories c ON i.category_id = c.id
       WHERE i.tenant_id = $1 ORDER BY i.sort_order`,
      [req.user.tenantId]
    );
    const tenant = await db.query('SELECT * FROM tenants WHERE id = $1', [req.user.tenantId]);

    res.render('admin/dashboard', {
      tenant: tenant.rows[0],
      categories: categories.rows,
      items: items.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ── Items CRUD ─────────────────────────────────────
router.post('/items', requireAuth, async (req, res) => {
  const { name, name_ar, name_ku, price, description, description_ar, description_ku, image_url, category_id, badge } = req.body;
  try {
    await db.query(
      `INSERT INTO menu_items (tenant_id, category_id, name, name_ar, name_ku, price, description, description_ar, description_ku, image_url, badge)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [req.user.tenantId, category_id || null, name, name_ar || null, name_ku || null, price, description, description_ar || null, description_ku || null, image_url, badge || null]
    );
    res.redirect('/admin/dashboard?success=Item+added');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.post('/items/:id/edit', requireAuth, async (req, res) => {
  const { name, name_ar, name_ku, price, description, description_ar, description_ku, image_url, category_id, badge } = req.body;
  try {
    await db.query(
      `UPDATE menu_items SET name=$1, name_ar=$2, name_ku=$3, price=$4, description=$5, description_ar=$6, description_ku=$7, image_url=$8, category_id=$9, badge=$10
       WHERE id=$11 AND tenant_id=$12`,
      [name, name_ar || null, name_ku || null, price, description, description_ar || null, description_ku || null, image_url, category_id || null, badge || null, req.params.id, req.user.tenantId]
    );
    res.redirect('/admin/dashboard?success=Item+updated');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.post('/items/:id/delete', requireAuth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM menu_items WHERE id=$1 AND tenant_id=$2',
      [req.params.id, req.user.tenantId]
    );
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ── Categories CRUD ────────────────────────────────
router.post('/categories', requireAuth, async (req, res) => {
  const { name, name_ar, name_ku, image_url } = req.body;
  try {
    await db.query(
      'INSERT INTO categories (tenant_id, name, name_ar, name_ku, image_url) VALUES ($1, $2, $3, $4, $5)',
      [req.user.tenantId, name, name_ar || null, name_ku || null, image_url || null]
    );
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.post('/categories/:id/edit', requireAuth, async (req, res) => {
  const { name, name_ar, name_ku, image_url } = req.body;
  try {
    await db.query(
      'UPDATE categories SET name=$1, name_ar=$2, name_ku=$3, image_url=$4 WHERE id=$5 AND tenant_id=$6',
      [name, name_ar || null, name_ku || null, image_url || null, req.params.id, req.user.tenantId]
    );
    res.redirect('/admin/dashboard?success=Category+updated');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.post('/categories/:id/delete', requireAuth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM categories WHERE id=$1 AND tenant_id=$2',
      [req.params.id, req.user.tenantId]
    );
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ── Toggle item availability ───────────────────────
router.post('/items/:id/toggle', requireAuth, async (req, res) => {
  try {
    await db.query(
      `UPDATE menu_items SET is_available = NOT is_available WHERE id=$1 AND tenant_id=$2`,
      [req.params.id, req.user.tenantId]
    );
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ── Feature / unfeature item ──────────────────────
router.post('/items/:id/feature', requireAuth, async (req, res) => {
  try {
    await db.query(
      'UPDATE menu_items SET is_featured = NOT COALESCE(is_featured, false) WHERE id=$1 AND tenant_id=$2',
      [req.params.id, req.user.tenantId]
    );
    res.redirect('/admin/dashboard');
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Duplicate item ─────────────────────────────────
router.post('/items/:id/duplicate', requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM menu_items WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    if (r.rows.length === 0) return res.redirect('/admin/dashboard');
    const i = r.rows[0];
    await db.query(
      `INSERT INTO menu_items (tenant_id,category_id,name,name_ar,name_ku,price,description,description_ar,description_ku,image_url,badge,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [req.user.tenantId, i.category_id, i.name+' (Copy)', i.name_ar, i.name_ku, i.price, i.description, i.description_ar, i.description_ku, i.image_url, i.badge, i.sort_order]
    );
    res.redirect('/admin/dashboard?success=Item+duplicated');
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Reorder items ──────────────────────────────────
router.post('/items/reorder', requireAuth, async (req, res) => {
  try {
    const { order } = req.body;
    for (let idx = 0; idx < order.length; idx++) {
      await db.query('UPDATE menu_items SET sort_order=$1 WHERE id=$2 AND tenant_id=$3', [idx, order[idx], req.user.tenantId]);
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ ok: false }); }
});

// ── Reorder categories ─────────────────────────────
router.post('/categories/reorder', requireAuth, async (req, res) => {
  try {
    const { order } = req.body;
    for (let idx = 0; idx < order.length; idx++) {
      await db.query('UPDATE categories SET sort_order=$1 WHERE id=$2 AND tenant_id=$3', [idx, order[idx], req.user.tenantId]);
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ ok: false }); }
});

// ── Orders ────────────────────────────────────────
router.get('/orders', requireAuth, async (req, res) => {
  try {
    const tenant = await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId]);
    const orders = await db.query(
      'SELECT * FROM orders WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200',
      [req.user.tenantId]
    );
    res.render('admin/orders', { tenant: tenant.rows[0], orders: orders.rows });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── QR Code ────────────────────────────────────────
router.get('/qrcode', requireAuth, async (req, res) => {
  try {
    const tenant = await db.query('SELECT * FROM tenants WHERE id = $1', [req.user.tenantId]);
    const t = tenant.rows[0];
    const host    = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const menuUrl = `${protocol}://${host}/?tenant=${t.subdomain}`;
    res.render('admin/qrcode', { tenant: t, menuUrl });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ── Settings ───────────────────────────────────────
router.get('/settings', requireAuth, async (req, res) => {
  try {
    const tenant = await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId]);
    res.render('admin/settings', { tenant: tenant.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.post('/settings', requireAuth, async (req, res) => {
  const { name, description, logo_url, cover_image, theme_color, bg_video, whatsapp, cart_enabled, currency, is_always_open, open_time, close_time } = req.body;
  try {
    await db.query(
      `UPDATE tenants SET name=$1, description=$2, logo_url=$3, cover_image=$4, theme_color=$5, bg_video=$6, whatsapp=$7, cart_enabled=$8, currency=$9, is_always_open=$10, open_time=$11, close_time=$12 WHERE id=$13`,
      [name, description, logo_url, cover_image, theme_color, bg_video || null, whatsapp || null, cart_enabled === '1', currency || '$', is_always_open === '1', open_time || null, close_time || null, req.user.tenantId]
    );
    res.redirect('/admin/settings?success=Settings+saved+successfully');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/settings?error=Failed+to+save+settings');
  }
});

module.exports = router;
