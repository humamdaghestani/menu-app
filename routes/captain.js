const express = require('express');
const router  = express.Router();
const net     = require('net');
const db      = require('../db');
const requireAuth = require('../middleware/auth');

// ── Guards ────────────────────────────────────────────────────────────────────
async function requireCaptain(req, res, next) {
  try {
    const r = await db.query('SELECT feat_captain FROM tenants WHERE id=$1', [req.user.tenantId]);
    if (!r.rows[0]?.feat_captain)
      return res.status(403).send('<h2 style="font-family:sans-serif;padding:40px">Captain module is not enabled for your account.</h2>');
    if (req.user.role === 'admin') return next();
    if ((req.user.permissions || []).includes('access_captain')) return next();
    res.status(403).send('<h2 style="font-family:sans-serif;padding:40px">You do not have access to the Captain system.</h2>');
  } catch { next(); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getTenant(tid) {
  const r = await db.query('SELECT * FROM tenants WHERE id=$1', [tid]);
  return r.rows[0];
}

function calcSubtotal(items) {
  return items.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0);
}

function buildKitchenTicket(order, items) {
  const buf = [];
  const txt = s => buf.push(...Buffer.from(s, 'utf8'));
  buf.push(0x1B, 0x40);           // ESC @ init
  buf.push(0x1B, 0x61, 0x01);     // center
  buf.push(0x1B, 0x21, 0x30);     // double width+height
  txt(`${order.table_name}\n`);
  buf.push(0x1B, 0x21, 0x00);     // normal
  buf.push(0x1B, 0x61, 0x00);     // left
  txt(`Order #${order.id}   ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}\n`);
  txt('--------------------------------\n');
  for (const item of items) {
    buf.push(0x1B, 0x45, 0x01);   // bold on
    txt(`x${item.quantity}  ${item.name}\n`);
    buf.push(0x1B, 0x45, 0x00);   // bold off
    if (item.notes) txt(`   >> ${item.notes}\n`);
  }
  txt('================================\n');
  buf.push(0x0A, 0x0A, 0x0A);    // 3 feeds
  buf.push(0x1D, 0x56, 0x01);    // partial cut
  return Buffer.from(buf);
}

async function printToKitchen(printer, data) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setTimeout(5000);
    sock.connect(printer.port || 9100, printer.ip_address, () => {
      sock.write(data, () => { setTimeout(() => { sock.destroy(); resolve(); }, 400); });
    });
    sock.on('error', e => { sock.destroy(); reject(e); });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /captain — table map
router.get('/', requireAuth, requireCaptain, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const tables = await db.query(
      `SELECT t.*,
         o.id AS order_id, o.status AS order_status,
         o.bill_requested, o.kitchen_sent_at,
         COUNT(oi.id) AS item_count,
         COALESCE(SUM(oi.price * oi.quantity), 0) AS order_total
       FROM restaurant_tables t
       LEFT JOIN pos_orders o ON o.table_id = t.id AND o.status = 'open'
       LEFT JOIN pos_order_items oi ON oi.order_id = o.id
       WHERE t.tenant_id = $1
       GROUP BY t.id, o.id, o.status, o.bill_requested, o.kitchen_sent_at
       ORDER BY t.sort_order, t.name`,
      [req.user.tenantId]
    );
    res.render('captain/home', { tenant, tables: tables.rows, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Error'); }
});

// POST /captain/table/:id/open
router.post('/table/:tableId/open', requireAuth, requireCaptain, async (req, res) => {
  try {
    const table = await db.query('SELECT * FROM restaurant_tables WHERE id=$1 AND tenant_id=$2', [req.params.tableId, req.user.tenantId]);
    if (!table.rows[0]) return res.redirect('/captain');
    const existing = await db.query("SELECT id FROM pos_orders WHERE table_id=$1 AND status='open'", [req.params.tableId]);
    if (existing.rows[0]) return res.redirect('/captain/order/' + existing.rows[0].id);
    const session = await db.query("SELECT id FROM pos_sessions WHERE tenant_id=$1 AND status='open' LIMIT 1", [req.user.tenantId]);
    const order = await db.query(
      'INSERT INTO pos_orders (tenant_id, table_id, table_name, created_by, session_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.user.tenantId, req.params.tableId, table.rows[0].name, req.user.userId, session.rows[0]?.id || null]
    );
    res.redirect('/captain/order/' + order.rows[0].id);
  } catch (err) { console.error(err); res.redirect('/captain'); }
});

// GET /captain/order/:id
router.get('/order/:id', requireAuth, requireCaptain, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const oRes = await db.query('SELECT * FROM pos_orders WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    if (!oRes.rows[0]) return res.redirect('/captain');
    const [items, categories, menuItems] = await Promise.all([
      db.query('SELECT * FROM pos_order_items WHERE order_id=$1 ORDER BY id', [req.params.id]),
      db.query('SELECT * FROM categories WHERE tenant_id=$1 ORDER BY sort_order', [req.user.tenantId]),
      db.query('SELECT * FROM menu_items WHERE tenant_id=$1 AND is_available=true ORDER BY sort_order', [req.user.tenantId]),
    ]);
    const subtotal = calcSubtotal(items.rows);
    res.render('captain/order', {
      tenant, order: oRes.rows[0],
      orderItems: items.rows,
      categories: categories.rows,
      menuItems: menuItems.rows,
      subtotal,
      sent: req.query.sent === '1',
      currentUser: req.user,
    });
  } catch (err) { console.error(err); res.status(500).send('Error'); }
});

// POST /captain/order/:id/add-item
router.post('/order/:id/add-item', requireAuth, requireCaptain, async (req, res) => {
  const { menu_item_id } = req.body;
  try {
    const item = await db.query('SELECT * FROM menu_items WHERE id=$1 AND tenant_id=$2', [menu_item_id, req.user.tenantId]);
    if (!item.rows[0]) return res.redirect('/captain/order/' + req.params.id);
    const price = parseFloat(String(item.rows[0].price).replace(/[^0-9.]/g,'')) || 0;
    const ex = await db.query('SELECT * FROM pos_order_items WHERE order_id=$1 AND menu_item_id=$2 AND notes IS NULL', [req.params.id, menu_item_id]);
    if (ex.rows[0]) {
      await db.query('UPDATE pos_order_items SET quantity=quantity+1 WHERE id=$1', [ex.rows[0].id]);
    } else {
      await db.query('INSERT INTO pos_order_items (order_id, menu_item_id, name, price, quantity) VALUES ($1,$2,$3,$4,1)',
        [req.params.id, menu_item_id, item.rows[0].name, price]);
    }
    // Reset kitchen_sent_at so cashier knows new items were added
    await db.query('UPDATE pos_orders SET kitchen_sent_at=NULL WHERE id=$1', [req.params.id]);
    res.redirect('/captain/order/' + req.params.id);
  } catch (err) { res.redirect('/captain/order/' + req.params.id); }
});

// POST /captain/order/:id/item/:itemId/qty
router.post('/order/:id/item/:itemId/qty', requireAuth, requireCaptain, async (req, res) => {
  try {
    const item = await db.query('SELECT * FROM pos_order_items WHERE id=$1 AND order_id=$2', [req.params.itemId, req.params.id]);
    if (!item.rows[0]) return res.redirect('/captain/order/' + req.params.id);
    const newQty = item.rows[0].quantity + parseInt(req.body.delta);
    if (newQty <= 0) await db.query('DELETE FROM pos_order_items WHERE id=$1', [req.params.itemId]);
    else             await db.query('UPDATE pos_order_items SET quantity=$1 WHERE id=$2', [newQty, req.params.itemId]);
    res.redirect('/captain/order/' + req.params.id);
  } catch (err) { res.redirect('/captain/order/' + req.params.id); }
});

// POST /captain/order/:id/send-kitchen
router.post('/order/:id/send-kitchen', requireAuth, requireCaptain, async (req, res) => {
  try {
    const oRes   = await db.query('SELECT * FROM pos_orders WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    const iRes   = await db.query('SELECT * FROM pos_order_items WHERE order_id=$1 ORDER BY id', [req.params.id]);
    if (!oRes.rows[0] || !iRes.rows.length) return res.redirect('/captain/order/' + req.params.id);

    const printers = await db.query(
      "SELECT * FROM pos_printers WHERE tenant_id=$1 AND is_active=true AND role IN ('kitchen','both') AND connection_type='network' AND ip_address IS NOT NULL",
      [req.user.tenantId]
    );
    const ticket = buildKitchenTicket(oRes.rows[0], iRes.rows);
    for (const p of printers.rows) {
      try { await printToKitchen(p, ticket); } catch (e) { console.error('Print fail:', e.message); }
    }
    await db.query('UPDATE pos_orders SET kitchen_sent_at=NOW() WHERE id=$1', [req.params.id]);
    res.redirect('/captain/order/' + req.params.id + '?sent=1');
  } catch (err) { console.error(err); res.redirect('/captain/order/' + req.params.id); }
});

// POST /captain/order/:id/request-bill
router.post('/order/:id/request-bill', requireAuth, requireCaptain, async (req, res) => {
  try {
    await db.query('UPDATE pos_orders SET bill_requested=true WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    res.redirect('/captain');
  } catch (err) { res.redirect('/captain/order/' + req.params.id); }
});

module.exports = router;
