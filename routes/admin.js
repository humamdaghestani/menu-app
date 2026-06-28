const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const requireAuth = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
  const { name, description, logo_url, cover_image, theme_color, bg_video, whatsapp, cart_enabled, currency, is_always_open, open_time, close_time, valet_enabled, valet_whatsapp, menu_style, menu_layout, menu_font, nav_bg_color, nav_bg_opacity,
    fb_q1_en, fb_q1_ar, fb_q1_ku, fb_q2_en, fb_q2_ar, fb_q2_ku, fb_q3_en, fb_q3_ar, fb_q3_ku, fb_q4_en, fb_q4_ar, fb_q4_ku, fb_q5_en, fb_q5_ar, fb_q5_ku } = req.body;
  try {
    await db.query(
      `UPDATE tenants SET name=$1, description=$2, logo_url=$3, cover_image=$4, theme_color=$5, bg_video=$6, whatsapp=$7, cart_enabled=$8, currency=$9, is_always_open=$10, open_time=$11, close_time=$12, valet_enabled=$13, valet_whatsapp=$14, menu_style=$15, menu_layout=$16, menu_font=$17, nav_bg_color=$18, nav_bg_opacity=$19,
       fb_q1_en=$20, fb_q1_ar=$21, fb_q1_ku=$22, fb_q2_en=$23, fb_q2_ar=$24, fb_q2_ku=$25, fb_q3_en=$26, fb_q3_ar=$27, fb_q3_ku=$28, fb_q4_en=$29, fb_q4_ar=$30, fb_q4_ku=$31, fb_q5_en=$32, fb_q5_ar=$33, fb_q5_ku=$34
       WHERE id=$35`,
      [name, description, logo_url, cover_image, theme_color, bg_video || null, whatsapp || null, cart_enabled === '1', currency || '$', is_always_open === '1', open_time || null, close_time || null, valet_enabled === '1', valet_whatsapp || null, menu_style || 'dark', menu_layout || 'grid', menu_font || 'default', nav_bg_color || null, nav_bg_opacity != null ? parseInt(nav_bg_opacity) : 90,
       fb_q1_en||null, fb_q1_ar||null, fb_q1_ku||null, fb_q2_en||null, fb_q2_ar||null, fb_q2_ku||null, fb_q3_en||null, fb_q3_ar||null, fb_q3_ku||null, fb_q4_en||null, fb_q4_ar||null, fb_q4_ku||null, fb_q5_en||null, fb_q5_ar||null, fb_q5_ku||null,
       req.user.tenantId]
    );
    res.redirect('/admin/settings?success=Settings+saved+successfully');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/settings?error=Failed+to+save+settings');
  }
});

// ── Import ─────────────────────────────────────────
router.get('/import', requireAuth, async (req, res) => {
  try {
    const tenant = await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId]);
    res.render('admin/import', { tenant: tenant.rows[0] });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// Download blank template
router.get('/import/template', requireAuth, (req, res) => {
  const wb = XLSX.utils.book_new();
  const headers = ['name','name_ar','name_ku','price','category','description','description_ar','description_ku','image_url','badge'];
  const example = ['Chicken Burger','برجر دجاج','برگەری مریشک','12.99','Burgers','Crispy fried chicken with lettuce','دجاج مقلي مع خس','مریشکی سووتاو','','popular'];
  const ws = XLSX.utils.aoa_to_sheet([headers, example]);
  // Column widths
  ws['!cols'] = [22,22,22,10,16,34,34,34,30,12].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Menu Items');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="menu-import-template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Handle upload
router.post('/import', requireAuth, upload.single('file'), async (req, res) => {
  const tenantRes = await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId]);
  const tenant = tenantRes.rows[0];

  if (!req.file) return res.render('admin/import', { tenant, result: { imported: 0, errors: ['No file uploaded'], rows: [] } });

  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });

    const categoryCache = {};
    let imported = 0;
    const errors = [];
    const rows = [];

    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      const rowNum = i + 2; // 1-indexed + header row
      const name  = String(r.name || '').trim();
      const price = String(r.price || '').trim();

      if (!name) {
        errors.push(`Row ${rowNum}: missing name`);
        rows.push({ row: rowNum, name, category: r.category, price, ok: false, error: 'Missing name' });
        continue;
      }
      if (!price) {
        errors.push(`Row ${rowNum}: missing price`);
        rows.push({ row: rowNum, name, category: r.category, price, ok: false, error: 'Missing price' });
        continue;
      }

      try {
        // Resolve category
        let categoryId = null;
        const catName = String(r.category || '').trim();
        if (catName) {
          if (categoryCache[catName] !== undefined) {
            categoryId = categoryCache[catName];
          } else {
            const existing = await db.query(
              'SELECT id FROM categories WHERE tenant_id=$1 AND LOWER(name)=LOWER($2)',
              [req.user.tenantId, catName]
            );
            if (existing.rows.length > 0) {
              categoryId = existing.rows[0].id;
            } else {
              const created = await db.query(
                'INSERT INTO categories (tenant_id, name) VALUES ($1,$2) RETURNING id',
                [req.user.tenantId, catName]
              );
              categoryId = created.rows[0].id;
            }
            categoryCache[catName] = categoryId;
          }
        }

        await db.query(
          `INSERT INTO menu_items (tenant_id, category_id, name, name_ar, name_ku, price, description, description_ar, description_ku, image_url, badge)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            req.user.tenantId, categoryId,
            name,
            String(r.name_ar || '').trim() || null,
            String(r.name_ku || '').trim() || null,
            price,
            String(r.description || '').trim() || null,
            String(r.description_ar || '').trim() || null,
            String(r.description_ku || '').trim() || null,
            String(r.image_url || '').trim() || null,
            String(r.badge || '').trim() || null,
          ]
        );
        imported++;
        rows.push({ row: rowNum, name, category: catName, price, ok: true });
      } catch (rowErr) {
        console.error(rowErr);
        errors.push(`Row ${rowNum}: ${rowErr.message}`);
        rows.push({ row: rowNum, name, category: r.category, price, ok: false, error: 'DB error' });
      }
    }

    res.render('admin/import', { tenant, result: { imported, errors, rows } });
  } catch (err) {
    console.error(err);
    res.render('admin/import', { tenant, result: { imported: 0, errors: ['Failed to parse file — make sure it is a valid .xlsx file'], rows: [] } });
  }
});

// ── Feedback ─────────────────────────────────────────
router.get('/feedback', requireAuth, async (req, res) => {
  try {
    const tenant = await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId]);
    const feedback = await db.query(
      'SELECT * FROM feedback WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200',
      [req.user.tenantId]
    );
    res.render('admin/feedback', { tenant: tenant.rows[0], feedback: feedback.rows });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

module.exports = router;
