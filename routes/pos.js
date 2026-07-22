const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAuth = require('../middleware/auth');

// Gate all POS routes behind feat_pos
async function requirePOS(req, res, next) {
  try {
    const r = await db.query('SELECT feat_pos FROM tenants WHERE id=$1', [req.user.tenantId]);
    if (r.rows[0]?.feat_pos) return next();
    res.status(403).send('<h2 style="font-family:sans-serif;padding:40px">POS module is not enabled for your account.</h2>');
  } catch { next(); }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function getTenant(tenantId) {
  const r = await db.query('SELECT * FROM tenants WHERE id=$1', [tenantId]);
  return r.rows[0];
}

function calcTotal(items) {
  return items.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0);
}

// ── Table Map ────────────────────────────────────────────────────────────────
router.get('/', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const tables = await db.query(
      `SELECT t.*,
        o.id AS order_id, o.status AS order_status,
        COALESCE(SUM(oi.price * oi.quantity),0) AS order_total,
        COUNT(oi.id) AS item_count
       FROM restaurant_tables t
       LEFT JOIN pos_orders o ON o.table_id = t.id AND o.status = 'open'
       LEFT JOIN pos_order_items oi ON oi.order_id = o.id
       WHERE t.tenant_id = $1
       GROUP BY t.id, o.id, o.status
       ORDER BY t.sort_order, t.name`,
      [req.user.tenantId]
    );
    res.render('pos/tables', { tenant, tables: tables.rows, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Open order for a table ───────────────────────────────────────────────────
router.post('/tables/:tableId/open', requireAuth, requirePOS, async (req, res) => {
  try {
    const table = await db.query('SELECT * FROM restaurant_tables WHERE id=$1 AND tenant_id=$2', [req.params.tableId, req.user.tenantId]);
    if (!table.rows[0]) return res.redirect('/pos');
    const existing = await db.query('SELECT id FROM pos_orders WHERE table_id=$1 AND status=$2', [req.params.tableId, 'open']);
    if (existing.rows[0]) return res.redirect('/pos/order/' + existing.rows[0].id);
    const order = await db.query(
      'INSERT INTO pos_orders (tenant_id, table_id, table_name, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.user.tenantId, req.params.tableId, table.rows[0].name, req.user.userId]
    );
    res.redirect('/pos/order/' + order.rows[0].id);
  } catch (err) { console.error(err); res.redirect('/pos'); }
});

// ── Order screen ─────────────────────────────────────────────────────────────
router.get('/order/:orderId', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const order = await db.query(
      'SELECT * FROM pos_orders WHERE id=$1 AND tenant_id=$2',
      [req.params.orderId, req.user.tenantId]
    );
    if (!order.rows[0]) return res.redirect('/pos');
    const items = await db.query(
      'SELECT * FROM pos_order_items WHERE order_id=$1 ORDER BY id',
      [req.params.orderId]
    );
    const categories = await db.query(
      'SELECT * FROM categories WHERE tenant_id=$1 ORDER BY sort_order',
      [req.user.tenantId]
    );
    const menuItems = await db.query(
      'SELECT * FROM menu_items WHERE tenant_id=$1 AND is_available=true ORDER BY sort_order',
      [req.user.tenantId]
    );
    const total = calcTotal(items.rows);
    res.render('pos/order', {
      tenant, order: order.rows[0],
      orderItems: items.rows,
      categories: categories.rows,
      menuItems: menuItems.rows,
      total,
      currentUser: req.user
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Add item to order ────────────────────────────────────────────────────────
router.post('/order/:orderId/add-item', requireAuth, requirePOS, async (req, res) => {
  const { menu_item_id, notes } = req.body;
  try {
    const item = await db.query('SELECT * FROM menu_items WHERE id=$1 AND tenant_id=$2', [menu_item_id, req.user.tenantId]);
    if (!item.rows[0]) return res.redirect('/pos/order/' + req.params.orderId);
    const price = parseFloat(item.rows[0].price.replace(/[^0-9.]/g, '')) || 0;
    const existing = await db.query(
      'SELECT * FROM pos_order_items WHERE order_id=$1 AND menu_item_id=$2 AND notes IS NOT DISTINCT FROM $3',
      [req.params.orderId, menu_item_id, notes || null]
    );
    if (existing.rows[0]) {
      await db.query('UPDATE pos_order_items SET quantity=quantity+1 WHERE id=$1', [existing.rows[0].id]);
    } else {
      await db.query(
        'INSERT INTO pos_order_items (order_id, menu_item_id, name, price, quantity, notes) VALUES ($1,$2,$3,$4,1,$5)',
        [req.params.orderId, menu_item_id, item.rows[0].name, price, notes || null]
      );
    }
    res.redirect('/pos/order/' + req.params.orderId);
  } catch (err) { console.error(err); res.redirect('/pos/order/' + req.params.orderId); }
});

// ── Update item quantity ──────────────────────────────────────────────────────
router.post('/order/:orderId/item/:itemId/qty', requireAuth, requirePOS, async (req, res) => {
  const { delta } = req.body;
  try {
    const item = await db.query(
      'SELECT poi.* FROM pos_order_items poi JOIN pos_orders po ON po.id=poi.order_id WHERE poi.id=$1 AND po.tenant_id=$2',
      [req.params.itemId, req.user.tenantId]
    );
    if (!item.rows[0]) return res.redirect('/pos/order/' + req.params.orderId);
    const newQty = item.rows[0].quantity + parseInt(delta);
    if (newQty <= 0) {
      await db.query('DELETE FROM pos_order_items WHERE id=$1', [req.params.itemId]);
    } else {
      await db.query('UPDATE pos_order_items SET quantity=$1 WHERE id=$2', [newQty, req.params.itemId]);
    }
    res.redirect('/pos/order/' + req.params.orderId);
  } catch (err) { console.error(err); res.redirect('/pos/order/' + req.params.orderId); }
});

// ── Remove item ───────────────────────────────────────────────────────────────
router.post('/order/:orderId/item/:itemId/remove', requireAuth, requirePOS, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM pos_order_items WHERE id=$1 AND order_id IN (SELECT id FROM pos_orders WHERE tenant_id=$2)',
      [req.params.itemId, req.user.tenantId]
    );
    res.redirect('/pos/order/' + req.params.orderId);
  } catch (err) { res.redirect('/pos/order/' + req.params.orderId); }
});

// ── Update order note ─────────────────────────────────────────────────────────
router.post('/order/:orderId/note', requireAuth, requirePOS, async (req, res) => {
  try {
    await db.query('UPDATE pos_orders SET note=$1 WHERE id=$2 AND tenant_id=$3', [req.body.note || null, req.params.orderId, req.user.tenantId]);
    res.redirect('/pos/order/' + req.params.orderId);
  } catch (err) { res.redirect('/pos/order/' + req.params.orderId); }
});

// ── Payment screen ────────────────────────────────────────────────────────────
router.get('/order/:orderId/pay', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const order = await db.query('SELECT * FROM pos_orders WHERE id=$1 AND tenant_id=$2', [req.params.orderId, req.user.tenantId]);
    if (!order.rows[0] || order.rows[0].status !== 'open') return res.redirect('/pos');
    const items = await db.query('SELECT * FROM pos_order_items WHERE order_id=$1', [req.params.orderId]);
    const total = calcTotal(items.rows);
    res.render('pos/payment', { tenant, order: order.rows[0], orderItems: items.rows, total, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Process payment ───────────────────────────────────────────────────────────
router.post('/order/:orderId/pay', requireAuth, requirePOS, async (req, res) => {
  const { method, amount_paid } = req.body;
  try {
    const items = await db.query('SELECT * FROM pos_order_items WHERE order_id=$1', [req.params.orderId]);
    const total = calcTotal(items.rows);
    const paid = parseFloat(amount_paid) || 0;
    const change = Math.max(0, paid - total);
    await db.query(
      'INSERT INTO pos_payments (order_id, method, amount_paid, change_given) VALUES ($1,$2,$3,$4)',
      [req.params.orderId, method || 'cash', paid, change]
    );
    await db.query(
      'UPDATE pos_orders SET status=$1, total=$2, paid_at=NOW() WHERE id=$3 AND tenant_id=$4',
      ['paid', total, req.params.orderId, req.user.tenantId]
    );
    res.redirect('/pos/receipt/' + req.params.orderId);
  } catch (err) { console.error(err); res.redirect('/pos/order/' + req.params.orderId); }
});

// ── Void order ────────────────────────────────────────────────────────────────
router.post('/order/:orderId/void', requireAuth, requirePOS, async (req, res) => {
  try {
    await db.query('UPDATE pos_orders SET status=$1 WHERE id=$2 AND tenant_id=$3', ['void', req.params.orderId, req.user.tenantId]);
    res.redirect('/pos');
  } catch (err) { res.redirect('/pos'); }
});

// ── Receipt ───────────────────────────────────────────────────────────────────
router.get('/receipt/:orderId', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const order = await db.query('SELECT po.*, pp.method, pp.amount_paid, pp.change_given FROM pos_orders po LEFT JOIN pos_payments pp ON pp.order_id=po.id WHERE po.id=$1 AND po.tenant_id=$2', [req.params.orderId, req.user.tenantId]);
    if (!order.rows[0]) return res.redirect('/pos');
    const items = await db.query('SELECT * FROM pos_order_items WHERE order_id=$1', [req.params.orderId]);
    res.render('pos/receipt', { tenant, order: order.rows[0], orderItems: items.rows, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Kitchen display ───────────────────────────────────────────────────────────
router.get('/kitchen', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const orders = await db.query(
      `SELECT po.*, json_agg(poi.* ORDER BY poi.id) AS items
       FROM pos_orders po
       JOIN pos_order_items poi ON poi.order_id = po.id
       WHERE po.tenant_id=$1 AND po.status='open'
       GROUP BY po.id ORDER BY po.created_at`,
      [req.user.tenantId]
    );
    res.render('pos/kitchen', { tenant, orders: orders.rows, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Kitchen API: poll orders ──────────────────────────────────────────────────
router.get('/api/kitchen', requireAuth, requirePOS, async (req, res) => {
  try {
    const orders = await db.query(
      `SELECT po.*, json_agg(poi.* ORDER BY poi.id) AS items
       FROM pos_orders po
       JOIN pos_order_items poi ON poi.order_id = po.id
       WHERE po.tenant_id=$1 AND po.status='open'
       GROUP BY po.id ORDER BY po.created_at`,
      [req.user.tenantId]
    );
    res.json({ orders: orders.rows });
  } catch (err) { res.json({ orders: [] }); }
});

// ── Table settings ────────────────────────────────────────────────────────────
router.get('/settings', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const tables = await db.query('SELECT * FROM restaurant_tables WHERE tenant_id=$1 ORDER BY sort_order, name', [req.user.tenantId]);
    res.render('pos/settings', { tenant, tables: tables.rows, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/settings/tables', requireAuth, requirePOS, async (req, res) => {
  const { name, capacity } = req.body;
  try {
    await db.query('INSERT INTO restaurant_tables (tenant_id, name, capacity) VALUES ($1,$2,$3)', [req.user.tenantId, name, parseInt(capacity) || 4]);
    res.redirect('/pos/settings');
  } catch (err) { res.redirect('/pos/settings'); }
});

router.post('/settings/tables/:id/edit', requireAuth, requirePOS, async (req, res) => {
  const { name, capacity } = req.body;
  try {
    await db.query('UPDATE restaurant_tables SET name=$1, capacity=$2 WHERE id=$3 AND tenant_id=$4', [name, parseInt(capacity) || 4, req.params.id, req.user.tenantId]);
    res.redirect('/pos/settings');
  } catch (err) { res.redirect('/pos/settings'); }
});

router.post('/settings/tables/:id/delete', requireAuth, requirePOS, async (req, res) => {
  try {
    await db.query('DELETE FROM restaurant_tables WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    res.redirect('/pos/settings');
  } catch (err) { res.redirect('/pos/settings'); }
});

module.exports = router;
