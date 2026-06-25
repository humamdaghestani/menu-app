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
  const { name, price, description, image_url, category_id, badge } = req.body;
  try {
    await db.query(
      `INSERT INTO menu_items (tenant_id, category_id, name, price, description, image_url, badge)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.user.tenantId, category_id || null, name, price, description, image_url, badge || null]
    );
    res.redirect('/admin/dashboard?success=Item+added');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.post('/items/:id/edit', requireAuth, async (req, res) => {
  const { name, price, description, image_url, category_id, badge } = req.body;
  try {
    await db.query(
      `UPDATE menu_items SET name=$1, price=$2, description=$3, image_url=$4, category_id=$5, badge=$6
       WHERE id=$7 AND tenant_id=$8`,
      [name, price, description, image_url, category_id || null, badge || null, req.params.id, req.user.tenantId]
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
  const { name } = req.body;
  try {
    await db.query(
      'INSERT INTO categories (tenant_id, name) VALUES ($1, $2)',
      [req.user.tenantId, name]
    );
    res.redirect('/admin/dashboard');
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
  const { name, description, logo_url, cover_image, theme_color } = req.body;
  try {
    await db.query(
      `UPDATE tenants SET name=$1, description=$2, logo_url=$3, cover_image=$4, theme_color=$5 WHERE id=$6`,
      [name, description, logo_url, cover_image, theme_color, req.user.tenantId]
    );
    res.redirect('/admin/settings?success=Settings+saved+successfully');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/settings?error=Failed+to+save+settings');
  }
});

module.exports = router;
