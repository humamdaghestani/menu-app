const express = require('express');
const router = express.Router();
const db = require('../db');

// ── In-memory cache (30s TTL per tenant) ─────────────
const _cache = new Map();
const CACHE_TTL = 30 * 1000;

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { _cache.set(key, { data, ts: Date.now() }); }
function cacheBustByTenantId(tenantId) {
  for (const [key, entry] of _cache) {
    if (entry.data.tenant && entry.data.tenant.id === tenantId) _cache.delete(key);
  }
}
module.exports.cacheBustByTenantId = cacheBustByTenantId;

router.get('/', async (req, res) => {
  const slug = req.tenant;

  if (!slug) {
    return res.render('landing');
  }

  try {
    const cacheKey = 'menu:' + slug;
    let cached = cacheGet(cacheKey);

    if (!cached) {
      const tenantResult = await db.query(
        'SELECT * FROM tenants WHERE subdomain = $1 AND active = true',
        [slug]
      );
      if (tenantResult.rows.length === 0) return res.status(404).render('404', { slug });

      const [categoriesResult, itemsResult] = await Promise.all([
        db.query('SELECT * FROM categories WHERE tenant_id = $1 ORDER BY sort_order', [tenantResult.rows[0].id]),
        db.query('SELECT * FROM menu_items WHERE tenant_id = $1 ORDER BY sort_order', [tenantResult.rows[0].id]),
      ]);

      cached = { tenant: tenantResult.rows[0], categories: categoriesResult.rows, items: itemsResult.rows };
      cacheSet(cacheKey, cached);
    }

    // Fire-and-forget view count (never blocks render)
    db.query('UPDATE tenants SET view_count = COALESCE(view_count,0) + 1 WHERE id = $1', [cached.tenant.id]).catch(() => {});

    res.set('Cache-Control', 'public, max-age=20, stale-while-revalidate=10');
    res.render('menu', cached);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.get('/print', async (req, res) => {
  const slug = req.tenant || req.query.tenant;
  if (!slug) return res.redirect('/');

  try {
    const tenantResult = await db.query('SELECT * FROM tenants WHERE subdomain = $1 AND active = true', [slug]);
    if (tenantResult.rows.length === 0) return res.status(404).render('404', { slug });
    const tenant = tenantResult.rows[0];
    const categories = await db.query('SELECT * FROM categories WHERE tenant_id = $1 ORDER BY sort_order', [tenant.id]);
    const items      = await db.query('SELECT * FROM menu_items WHERE tenant_id = $1 ORDER BY sort_order', [tenant.id]);
    res.render('print', { tenant, categories: categories.rows, items: items.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ── Valet Desk page ───────────────────────────────
router.get('/valet-desk', async (req, res) => {
  const slug = req.tenant || req.query.tenant;
  if (!slug) return res.redirect('/');
  try {
    const r = await db.query('SELECT * FROM tenants WHERE subdomain=$1 AND active=true', [slug]);
    if (r.rows.length === 0) return res.status(404).render('404', { slug });
    const tenant = r.rows[0];
    if (!tenant.valet_enabled) return res.redirect(`/?tenant=${slug}`);
    res.render('valet-desk', { tenant });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Valet request API ─────────────────────────────
router.post('/api/valet-request', async (req, res) => {
  try {
    const { tenant_id, ticket_no, customer_name } = req.body;
    if (!tenant_id || !ticket_no) return res.json({ ok: false });
    await db.query(
      'INSERT INTO valet_requests (tenant_id, ticket_no, customer_name) VALUES ($1,$2,$3)',
      [tenant_id, ticket_no.trim(), customer_name || null]
    );
    res.json({ ok: true });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

router.post('/api/valet-request/:id/done', async (req, res) => {
  try {
    await db.query("UPDATE valet_requests SET status='done' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

router.get('/api/valet-requests', async (req, res) => {
  try {
    const slug = req.query.tenant;
    if (!slug) return res.json({ requests: [] });
    const t = await db.query('SELECT id FROM tenants WHERE subdomain=$1', [slug]);
    if (t.rows.length === 0) return res.json({ requests: [] });
    const result = await db.query(
      "SELECT * FROM valet_requests WHERE tenant_id=$1 AND status='pending' ORDER BY created_at ASC",
      [t.rows[0].id]
    );
    res.json({ requests: result.rows });
  } catch (err) { console.error(err); res.json({ requests: [] }); }
});

// ── Feedback ──────────────────────────────────────
router.post('/api/feedback', async (req, res) => {
  try {
    const { tenant_id, rating, q1, q2, q3, q4, q5, customer_name, mobile, table_no, comment } = req.body;
    if (!tenant_id) return res.json({ ok: false });
    await db.query(
      `INSERT INTO feedback (tenant_id, rating, q1, q2, q3, q4, q5, customer_name, mobile, table_no, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [tenant_id, rating ? parseInt(rating) : null, q1||null, q2||null, q3||null, q4||null, q5||null,
       customer_name||null, mobile||null, table_no||null, comment||null]
    );
    res.json({ ok: true });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

// Public order-log endpoint (called from menu page before WhatsApp)
router.post('/api/order', async (req, res) => {
  try {
    const { tenant_id, customer_name, table_no, items, item_count } = req.body;
    if (!tenant_id) return res.json({ ok: false });
    await db.query(
      'INSERT INTO orders (tenant_id, customer_name, table_no, items, item_count) VALUES ($1,$2,$3,$4,$5)',
      [tenant_id, customer_name || null, table_no || null, JSON.stringify(items || []), item_count || 0]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false });
  }
});

module.exports = router;
