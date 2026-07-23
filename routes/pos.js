const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAuth = require('../middleware/auth');

// Gate all POS routes behind feat_pos + user-level access_pos permission
async function requirePOS(req, res, next) {
  try {
    const r = await db.query('SELECT feat_pos FROM tenants WHERE id=$1', [req.user.tenantId]);
    if (!r.rows[0]?.feat_pos) {
      return res.status(403).send('<h2 style="font-family:sans-serif;padding:40px">POS module is not enabled for your account.</h2>');
    }
    if (req.user.role === 'admin') return next();
    if ((req.user.permissions || []).includes('access_pos')) return next();
    res.status(403).send('<h2 style="font-family:sans-serif;padding:40px">You do not have access to the POS module. Ask your admin to grant access.</h2>');
  } catch { next(); }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function getTenant(tenantId) {
  const r = await db.query('SELECT * FROM tenants WHERE id=$1', [tenantId]);
  return r.rows[0];
}

async function getOpenSession(tenantId) {
  const r = await db.query("SELECT * FROM pos_sessions WHERE tenant_id=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1", [tenantId]);
  return r.rows[0] || null;
}

// Require an open session for operational routes
async function requireSession(req, res, next) {
  try {
    const session = await getOpenSession(req.user.tenantId);
    if (!session) return res.redirect('/pos/session/open');
    req.posSession = session;
    next();
  } catch { next(); }
}

async function validatePasskey(tenantId, code, actionType) {
  if (!code || !code.trim()) return null;
  const r = await db.query(
    "SELECT * FROM pos_passkeys WHERE tenant_id=$1 AND code=$2 AND action_type=$3 AND used=false AND expires_at > NOW()",
    [tenantId, code.trim(), actionType]
  );
  return r.rows[0] || null;
}

async function logAction(tenantId, sessionId, orderId, userId, action, details = {}) {
  if (!sessionId) return;
  try {
    await db.query(
      'INSERT INTO pos_activity_log (tenant_id, session_id, order_id, user_id, action, details) VALUES ($1,$2,$3,$4,$5,$6)',
      [tenantId, sessionId, orderId || null, userId, action, JSON.stringify(details)]
    );
  } catch (e) { console.error('Log error:', e.message); }
}

function calcSubtotal(items) {
  return items.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0);
}
function calcTotal(items, order) {
  const sub = calcSubtotal(items);
  if (!order || order.discount_type === 'none' || !order.discount_value) return sub;
  if (order.discount_type === 'percent') return Math.max(0, sub - sub * parseFloat(order.discount_value) / 100);
  if (order.discount_type === 'fixed')   return Math.max(0, sub - parseFloat(order.discount_value));
  return sub;
}

// ── Session routes ────────────────────────────────────────────────────────────
router.get('/session/open', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const existing = await getOpenSession(req.user.tenantId);
    if (existing) return res.redirect('/pos');
    res.render('pos/session-open', { tenant, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/session/open', requireAuth, requirePOS, async (req, res) => {
  try {
    const existing = await getOpenSession(req.user.tenantId);
    if (existing) return res.redirect('/pos');
    await db.query(
      'INSERT INTO pos_sessions (tenant_id, opened_by, opening_cash) VALUES ($1,$2,$3)',
      [req.user.tenantId, req.user.userId, parseFloat(req.body.opening_cash) || 0]
    );
    res.redirect('/pos');
  } catch (err) { console.error(err); res.redirect('/pos/session/open'); }
});

router.get('/session/close', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant  = await getTenant(req.user.tenantId);
    const session = await getOpenSession(req.user.tenantId);
    if (!session) return res.redirect('/pos');
    const orders = await db.query(
      `SELECT po.*, COALESCE(pp.method,'—') AS pay_method,
        COALESCE(SUM(poi.price * poi.quantity),0) AS subtotal,
        COUNT(poi.id) AS item_count
       FROM pos_orders po
       LEFT JOIN pos_order_items poi ON poi.order_id = po.id
       LEFT JOIN pos_payments pp ON pp.order_id = po.id
       WHERE po.session_id=$1 AND po.status='paid'
       GROUP BY po.id, pp.method ORDER BY po.paid_at`,
      [session.id]
    );
    const summary = orders.rows.reduce((s, o) => {
      const total = parseFloat(o.total) || 0;
      s.total += total;
      if (o.pay_method === 'cash') s.cash += total; else s.card += total;
      s.count++;
      return s;
    }, { total: 0, cash: 0, card: 0, count: 0 });
    res.render('pos/session-close', { tenant, session, orders: orders.rows, summary, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/session/close', requireAuth, requirePOS, async (req, res) => {
  try {
    const session = await getOpenSession(req.user.tenantId);
    if (!session) return res.redirect('/pos');
    await db.query(
      "UPDATE pos_sessions SET status='closed', closing_cash=$1, notes=$2, closed_at=NOW() WHERE id=$3",
      [parseFloat(req.body.closing_cash) || 0, req.body.notes || null, session.id]
    );
    res.redirect('/pos/session/open');
  } catch (err) { console.error(err); res.redirect('/pos/session/close'); }
});

// ── Order History ─────────────────────────────────────────────────────────────
router.get('/orders', requireAuth, requirePOS, requireSession, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const orders = await db.query(
      `SELECT po.*, COALESCE(pp.method,'—') AS pay_method,
        COALESCE(SUM(poi.price * poi.quantity),0) AS subtotal,
        COUNT(poi.id) AS item_count
       FROM pos_orders po
       LEFT JOIN pos_order_items poi ON poi.order_id = po.id
       LEFT JOIN pos_payments pp ON pp.order_id = po.id
       WHERE po.session_id=$1
       GROUP BY po.id, pp.method ORDER BY po.created_at DESC`,
      [req.posSession.id]
    );
    const summary = orders.rows.reduce((s, o) => {
      if (o.status === 'paid') { s.total += parseFloat(o.total)||0; s.count++; }
      return s;
    }, { total: 0, count: 0 });
    res.render('pos/orders', { tenant, orders: orders.rows, session: req.posSession, summary, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── POS Home ─────────────────────────────────────────────────────────────────
router.get('/', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant  = await getTenant(req.user.tenantId);
    const session = await getOpenSession(req.user.tenantId);
    let stats = { cnt: 0, sales: 0 };
    if (session) {
      const r = await db.query(
        "SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS sales FROM pos_orders WHERE session_id=$1 AND status='paid'",
        [session.id]
      );
      stats = r.rows[0];
    }
    res.render('pos/home', { tenant, session, stats, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Generate passkey (admin only, AJAX) ──────────────────────────────────────
router.post('/passkey/generate', requireAuth, requirePOS, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: 'Admin only' });
    const { action_type } = req.body;
    if (!['void', 'discount'].includes(action_type)) return res.json({ ok: false, error: 'Invalid type' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await db.query(
      'INSERT INTO pos_passkeys (tenant_id, code, action_type, created_by, expires_at) VALUES ($1,$2,$3,$4,$5)',
      [req.user.tenantId, code, action_type, req.user.userId, expiresAt]
    );
    res.json({ ok: true, code, action_type, expires_in: 15 * 60 });
  } catch (err) { console.error(err); res.json({ ok: false, error: 'Server error' }); }
});

// ── Sessions History ──────────────────────────────────────────────────────────
router.get('/sessions', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const sessionsRes = await db.query(
      `SELECT ps.*, u.name AS opened_by_name,
        COUNT(DISTINCT po.id) AS order_count,
        COALESCE(SUM(CASE WHEN po.status='paid' THEN po.total ELSE 0 END), 0) AS total_sales,
        COALESCE(SUM(CASE WHEN po.status='paid' AND pp.method='cash' THEN po.total ELSE 0 END), 0) AS cash_sales,
        COALESCE(SUM(CASE WHEN po.status='paid' AND pp.method='card' THEN po.total ELSE 0 END), 0) AS card_sales
       FROM pos_sessions ps
       LEFT JOIN users u ON u.id = ps.opened_by
       LEFT JOIN pos_orders po ON po.session_id = ps.id
       LEFT JOIN pos_payments pp ON pp.order_id = po.id
       WHERE ps.tenant_id=$1
       GROUP BY ps.id, u.name ORDER BY ps.opened_at DESC`,
      [req.user.tenantId]
    );
    // Fetch orders per session
    const sessions = await Promise.all(sessionsRes.rows.map(async s => {
      const ordersRes = await db.query(
        `SELECT po.*, COALESCE(pp.method,'—') AS pay_method, COUNT(poi.id) AS item_count
         FROM pos_orders po
         LEFT JOIN pos_payments pp ON pp.order_id = po.id
         LEFT JOIN pos_order_items poi ON poi.order_id = po.id
         WHERE po.session_id=$1
         GROUP BY po.id, pp.method ORDER BY po.created_at`,
        [s.id]
      );
      return { ...s, orders: ordersRes.rows };
    }));
    const totals = sessions.reduce((t, s) => {
      t.orders += parseInt(s.order_count) || 0;
      t.sales  += parseFloat(s.total_sales) || 0;
      t.cash   += parseFloat(s.cash_sales) || 0;
      t.card   += parseFloat(s.card_sales) || 0;
      return t;
    }, { orders: 0, sales: 0, cash: 0, card: 0 });
    res.render('pos/sessions', { tenant, sessions, totals, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Table Map ────────────────────────────────────────────────────────────────
router.get('/tables', requireAuth, requirePOS, requireSession, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const tables = await db.query(
      `SELECT t.*,
        o.id AS order_id, o.status AS order_status, o.bill_requested,
        COALESCE(SUM(oi.price * oi.quantity),0) AS order_total,
        COUNT(oi.id) AS item_count
       FROM restaurant_tables t
       LEFT JOIN pos_orders o ON o.table_id = t.id AND o.status = 'open'
       LEFT JOIN pos_order_items oi ON oi.order_id = o.id
       WHERE t.tenant_id = $1
       GROUP BY t.id, o.id, o.status, o.bill_requested
       ORDER BY t.sort_order, t.name`,
      [req.user.tenantId]
    );
    const sessionOrders = await db.query(
      "SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS sales FROM pos_orders WHERE session_id=$1 AND status='paid'",
      [req.posSession.id]
    );
    const sessionStats = sessionOrders.rows[0];
    const takeawayOrders = await db.query(
      `SELECT po.*, COALESCE(SUM(oi.price * oi.quantity),0) AS order_total, COUNT(oi.id) AS item_count
       FROM pos_orders po
       LEFT JOIN pos_order_items oi ON oi.order_id = po.id
       WHERE po.tenant_id=$1 AND po.order_type='takeaway' AND po.status='open'
       GROUP BY po.id ORDER BY po.created_at`,
      [req.user.tenantId]
    );
    res.render('pos/tables', { tenant, tables: tables.rows, session: req.posSession, sessionStats, takeawayOrders: takeawayOrders.rows, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Open order for a table ───────────────────────────────────────────────────
router.post('/tables/:tableId/open', requireAuth, requirePOS, requireSession, async (req, res) => {
  try {
    const table = await db.query('SELECT * FROM restaurant_tables WHERE id=$1 AND tenant_id=$2', [req.params.tableId, req.user.tenantId]);
    if (!table.rows[0]) return res.redirect('/pos');
    const existing = await db.query('SELECT id FROM pos_orders WHERE table_id=$1 AND status=$2', [req.params.tableId, 'open']);
    if (existing.rows[0]) return res.redirect('/pos/order/' + existing.rows[0].id);
    const sessionId = req.posSession ? req.posSession.id : null;
    const order = await db.query(
      'INSERT INTO pos_orders (tenant_id, table_id, table_name, created_by, session_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.user.tenantId, req.params.tableId, table.rows[0].name, req.user.userId, sessionId]
    );
    await logAction(req.user.tenantId, sessionId, order.rows[0].id, req.user.userId, 'order_open', { table_name: table.rows[0].name, order_type: 'dine-in' });
    res.redirect('/pos/order/' + order.rows[0].id);
  } catch (err) { console.error(err); res.redirect('/pos'); }
});

// ── Open takeaway order ──────────────────────────────────────────────────────
router.post('/takeaway/open', requireAuth, requirePOS, requireSession, async (req, res) => {
  try {
    const count = await db.query(
      "SELECT COUNT(*) AS cnt FROM pos_orders WHERE session_id=$1 AND order_type='takeaway'",
      [req.posSession.id]
    );
    const num = parseInt(count.rows[0].cnt) + 1;
    const order = await db.query(
      "INSERT INTO pos_orders (tenant_id, table_name, order_type, created_by, session_id) VALUES ($1,$2,'takeaway',$3,$4) RETURNING id",
      [req.user.tenantId, `Takeaway #${num}`, req.user.userId, req.posSession.id]
    );
    await logAction(req.user.tenantId, req.posSession.id, order.rows[0].id, req.user.userId, 'order_open', { table_name: `Takeaway #${num}`, order_type: 'takeaway' });
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
    const o = order.rows[0];
    const subtotal = calcSubtotal(items.rows);
    const total    = calcTotal(items.rows, o);
    const discount = subtotal - total;
    res.render('pos/order', {
      tenant, order: o,
      orderItems: items.rows,
      categories: categories.rows,
      menuItems: menuItems.rows,
      subtotal, total, discount,
      errorParam: req.query.error || null,
      modalParam: req.query.modal || null,
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
    const sessionRow = await db.query('SELECT session_id FROM pos_orders WHERE id=$1', [req.params.orderId]);
    await logAction(req.user.tenantId, sessionRow.rows[0]?.session_id, req.params.orderId, req.user.userId, 'item_add', { name: item.rows[0].name, price });
    res.redirect('/pos/order/' + req.params.orderId);
  } catch (err) { console.error(err); res.redirect('/pos/order/' + req.params.orderId); }
});

// ── Update item quantity ──────────────────────────────────────────────────────
router.post('/order/:orderId/item/:itemId/qty', requireAuth, requirePOS, async (req, res) => {
  const { delta } = req.body;
  try {
    const item = await db.query(
      'SELECT poi.*, po.session_id FROM pos_order_items poi JOIN pos_orders po ON po.id=poi.order_id WHERE poi.id=$1 AND po.tenant_id=$2',
      [req.params.itemId, req.user.tenantId]
    );
    if (!item.rows[0]) return res.redirect('/pos/order/' + req.params.orderId);
    const oldQty = item.rows[0].quantity;
    const newQty = oldQty + parseInt(delta);
    if (newQty <= 0) {
      await db.query('DELETE FROM pos_order_items WHERE id=$1', [req.params.itemId]);
      await logAction(req.user.tenantId, item.rows[0].session_id, req.params.orderId, req.user.userId, 'item_remove', { name: item.rows[0].name });
    } else {
      await db.query('UPDATE pos_order_items SET quantity=$1 WHERE id=$2', [newQty, req.params.itemId]);
      await logAction(req.user.tenantId, item.rows[0].session_id, req.params.orderId, req.user.userId, 'item_qty', { name: item.rows[0].name, from: oldQty, to: newQty });
    }
    res.redirect('/pos/order/' + req.params.orderId);
  } catch (err) { console.error(err); res.redirect('/pos/order/' + req.params.orderId); }
});

// ── Item note ─────────────────────────────────────────────────────────────────
router.post('/order/:orderId/item/:itemId/note', requireAuth, requirePOS, async (req, res) => {
  try {
    await db.query(
      'UPDATE pos_order_items SET notes=$1 WHERE id=$2 AND order_id IN (SELECT id FROM pos_orders WHERE tenant_id=$3)',
      [req.body.note || null, req.params.itemId, req.user.tenantId]
    );
    res.redirect('/pos/order/' + req.params.orderId);
  } catch (err) { res.redirect('/pos/order/' + req.params.orderId); }
});

// ── Remove item ───────────────────────────────────────────────────────────────
router.post('/order/:orderId/item/:itemId/remove', requireAuth, requirePOS, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT poi.name, po.session_id FROM pos_order_items poi JOIN pos_orders po ON po.id=poi.order_id WHERE poi.id=$1 AND po.tenant_id=$2',
      [req.params.itemId, req.user.tenantId]
    );
    await db.query('DELETE FROM pos_order_items WHERE id=$1', [req.params.itemId]);
    if (r.rows[0]) await logAction(req.user.tenantId, r.rows[0].session_id, req.params.orderId, req.user.userId, 'item_remove', { name: r.rows[0].name });
    res.redirect('/pos/order/' + req.params.orderId);
  } catch (err) { res.redirect('/pos/order/' + req.params.orderId); }
});

// ── Update order note ─────────────────────────────────────────────────────────
router.post('/order/:orderId/note', requireAuth, requirePOS, async (req, res) => {
  try {
    const r = await db.query('UPDATE pos_orders SET note=$1 WHERE id=$2 AND tenant_id=$3 RETURNING session_id', [req.body.note || null, req.params.orderId, req.user.tenantId]);
    await logAction(req.user.tenantId, r.rows[0]?.session_id, req.params.orderId, req.user.userId, 'order_note', { note: req.body.note || '' });
    res.redirect('/pos/order/' + req.params.orderId);
  } catch (err) { res.redirect('/pos/order/' + req.params.orderId); }
});

// ── Discount (requires passkey unless removing) ───────────────────────────────
router.post('/order/:orderId/discount', requireAuth, requirePOS, async (req, res) => {
  const { discount_type, discount_value, passkey } = req.body;
  const back = '/pos/order/' + req.params.orderId;
  try {
    if (discount_type !== 'none') {
      const pk = await validatePasskey(req.user.tenantId, passkey, 'discount');
      if (!pk) return res.redirect(back + '?error=passkey&modal=discount');
      await db.query('UPDATE pos_passkeys SET used=true, used_by=$1, order_id=$2, used_at=NOW() WHERE id=$3',
        [req.user.userId, req.params.orderId, pk.id]);
    }
    const dr = await db.query(
      'UPDATE pos_orders SET discount_type=$1, discount_value=$2 WHERE id=$3 AND tenant_id=$4 RETURNING session_id',
      [discount_type || 'none', parseFloat(discount_value) || 0, req.params.orderId, req.user.tenantId]
    );
    const action = discount_type === 'none' ? 'discount_remove' : 'discount_apply';
    await logAction(req.user.tenantId, dr.rows[0]?.session_id, req.params.orderId, req.user.userId, action, { type: discount_type, value: parseFloat(discount_value) || 0 });
    res.redirect(back);
  } catch (err) { console.error(err); res.redirect(back); }
});

// ── Payment screen ────────────────────────────────────────────────────────────
router.get('/order/:orderId/pay', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const order = await db.query('SELECT * FROM pos_orders WHERE id=$1 AND tenant_id=$2', [req.params.orderId, req.user.tenantId]);
    if (!order.rows[0] || order.rows[0].status !== 'open') return res.redirect('/pos');
    const items = await db.query('SELECT * FROM pos_order_items WHERE order_id=$1', [req.params.orderId]);
    const o = order.rows[0];
    const subtotal = calcSubtotal(items.rows);
    const total    = calcTotal(items.rows, o);
    const discount = subtotal - total;
    res.render('pos/payment', { tenant, order: o, orderItems: items.rows, subtotal, total, discount, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Process payment ───────────────────────────────────────────────────────────
router.post('/order/:orderId/pay', requireAuth, requirePOS, async (req, res) => {
  const { method, amount_paid } = req.body;
  try {
    const orderRes = await db.query('SELECT * FROM pos_orders WHERE id=$1 AND tenant_id=$2', [req.params.orderId, req.user.tenantId]);
    const items = await db.query('SELECT * FROM pos_order_items WHERE order_id=$1', [req.params.orderId]);
    const total = calcTotal(items.rows, orderRes.rows[0]);
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
    await logAction(req.user.tenantId, orderRes.rows[0]?.session_id, req.params.orderId, req.user.userId, 'order_paid', { method: method || 'cash', amount_paid: paid, total, change });
    res.redirect('/pos/receipt/' + req.params.orderId);
  } catch (err) { console.error(err); res.redirect('/pos/order/' + req.params.orderId); }
});

// ── Void order (requires passkey) ─────────────────────────────────────────────
router.post('/order/:orderId/void', requireAuth, requirePOS, async (req, res) => {
  try {
    const pk = await validatePasskey(req.user.tenantId, req.body.passkey, 'void');
    if (!pk) return res.redirect('/pos/order/' + req.params.orderId + '?error=passkey');
    const vr = await db.query('UPDATE pos_orders SET status=$1 WHERE id=$2 AND tenant_id=$3 RETURNING session_id, table_name', ['void', req.params.orderId, req.user.tenantId]);
    await db.query('UPDATE pos_passkeys SET used=true, used_by=$1, order_id=$2, used_at=NOW() WHERE id=$3',
      [req.user.userId, req.params.orderId, pk.id]);
    await logAction(req.user.tenantId, vr.rows[0]?.session_id, req.params.orderId, req.user.userId, 'order_void', { table_name: vr.rows[0]?.table_name });
    res.redirect('/pos/tables');
  } catch (err) { console.error(err); res.redirect('/pos/tables'); }
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

// ── Session Detail ────────────────────────────────────────────────────────────
router.get('/sessions/:id', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const sessionRes = await db.query(
      `SELECT ps.*, u.name AS opened_by_name, u.email AS opened_by_email
       FROM pos_sessions ps LEFT JOIN users u ON u.id = ps.opened_by
       WHERE ps.id=$1 AND ps.tenant_id=$2`,
      [req.params.id, req.user.tenantId]
    );
    if (!sessionRes.rows[0]) return res.redirect('/pos/sessions');
    const session = sessionRes.rows[0];
    const ordersRes = await db.query(
      `SELECT po.*, COALESCE(pp.method,'—') AS pay_method,
        COALESCE(SUM(poi.price * poi.quantity),0) AS subtotal,
        COUNT(poi.id) AS item_count
       FROM pos_orders po
       LEFT JOIN pos_payments pp ON pp.order_id = po.id
       LEFT JOIN pos_order_items poi ON poi.order_id = po.id
       WHERE po.session_id=$1
       GROUP BY po.id, pp.method ORDER BY po.created_at`,
      [session.id]
    );
    const logsRes = await db.query(
      `SELECT al.*, u.name AS user_name, u.email AS user_email
       FROM pos_activity_log al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE al.session_id=$1 ORDER BY al.created_at`,
      [session.id]
    );
    const orders = ordersRes.rows;
    const paid  = orders.filter(o => o.status === 'paid').length;
    const voided = orders.filter(o => o.status === 'void').length;
    const totalSales = orders.filter(o => o.status === 'paid').reduce((s, o) => s + parseFloat(o.total || 0), 0);
    res.render('pos/session-detail', { tenant, session, orders, logs: logsRes.rows, stats: { paid, voided, open: orders.length - paid - voided, totalSales }, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── POS Settings ─────────────────────────────────────────────────────────────
router.get('/settings', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const [tables, printers, categories] = await Promise.all([
      db.query('SELECT * FROM restaurant_tables WHERE tenant_id=$1 ORDER BY sort_order, name', [req.user.tenantId]),
      db.query('SELECT * FROM pos_printers WHERE tenant_id=$1 ORDER BY created_at', [req.user.tenantId]),
      db.query('SELECT * FROM categories WHERE tenant_id=$1 ORDER BY sort_order', [req.user.tenantId]),
    ]);
    res.render('pos/settings', { tenant, tables: tables.rows, printers: printers.rows, categories: categories.rows, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/settings/permissions', requireAuth, requirePOS, async (req, res) => {
  try {
    const b = req.body;
    await db.query(
      `UPDATE tenants SET
        pos_allow_void=$1, pos_allow_discount=$2, pos_allow_takeaway=$3, pos_allow_receipt=$4
       WHERE id=$5`,
      [b.pos_allow_void === '1', b.pos_allow_discount === '1', b.pos_allow_takeaway === '1', b.pos_allow_receipt === '1', req.user.tenantId]
    );
    res.redirect('/pos/settings?tab=permissions');
  } catch (err) { console.error(err); res.redirect('/pos/settings'); }
});

router.post('/settings/display', requireAuth, requirePOS, async (req, res) => {
  try {
    const b = req.body;
    await db.query(
      `UPDATE tenants SET pos_show_kitchen=$1, pos_show_images=$2, pos_show_capacity=$3 WHERE id=$4`,
      [b.pos_show_kitchen === '1', b.pos_show_images === '1', b.pos_show_capacity === '1', req.user.tenantId]
    );
    res.redirect('/pos/settings?tab=permissions');
  } catch (err) { console.error(err); res.redirect('/pos/settings'); }
});

// ── Printer CRUD ──────────────────────────────────────────────────────────────
router.post('/settings/printers', requireAuth, requirePOS, async (req, res) => {
  const { name, role, connection_type, ip_address, port, paper_width } = req.body;
  try {
    await db.query(
      'INSERT INTO pos_printers (tenant_id, name, role, connection_type, ip_address, port, paper_width) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.user.tenantId, name, role || 'receipt', connection_type || 'network', ip_address || null, parseInt(port) || 9100, paper_width || '80mm']
    );
    res.redirect('/pos/settings?tab=printers');
  } catch (err) { console.error(err); res.redirect('/pos/settings?tab=printers'); }
});

router.post('/settings/printers/:id/edit', requireAuth, requirePOS, async (req, res) => {
  const { name, role, connection_type, ip_address, port, paper_width, is_active } = req.body;
  try {
    await db.query(
      'UPDATE pos_printers SET name=$1, role=$2, connection_type=$3, ip_address=$4, port=$5, paper_width=$6, is_active=$7 WHERE id=$8 AND tenant_id=$9',
      [name, role || 'receipt', connection_type || 'network', ip_address || null, parseInt(port) || 9100, paper_width || '80mm', is_active === '1', req.params.id, req.user.tenantId]
    );
    res.redirect('/pos/settings?tab=printers');
  } catch (err) { console.error(err); res.redirect('/pos/settings?tab=printers'); }
});

router.post('/settings/printers/categories', requireAuth, requirePOS, async (req, res) => {
  try {
    const assignments = req.body.category || {};
    for (const [catId, printerId] of Object.entries(assignments)) {
      await db.query(
        'UPDATE categories SET printer_id=$1 WHERE id=$2 AND tenant_id=$3',
        [printerId ? parseInt(printerId) : null, parseInt(catId), req.user.tenantId]
      );
    }
    res.redirect('/pos/settings?tab=printers');
  } catch (err) { console.error(err); res.redirect('/pos/settings?tab=printers'); }
});

router.post('/settings/printers/:id/delete', requireAuth, requirePOS, async (req, res) => {
  try {
    await db.query('DELETE FROM pos_printers WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    res.redirect('/pos/settings?tab=printers');
  } catch (err) { res.redirect('/pos/settings?tab=printers'); }
});

router.post('/settings/printers/:id/test', requireAuth, requirePOS, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM pos_printers WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    if (!r.rows[0]) return res.json({ ok: false, error: 'Printer not found' });
    const p = r.rows[0];
    if (p.connection_type !== 'network' || !p.ip_address) return res.json({ ok: false, error: 'No IP address configured' });
    const net = require('net');
    await new Promise((resolve, reject) => {
      const sock = new net.Socket();
      sock.setTimeout(3000);
      sock.connect(p.port || 9100, p.ip_address, () => { sock.destroy(); resolve(); });
      sock.on('error', err => { sock.destroy(); reject(err); });
      sock.on('timeout', () => { sock.destroy(); reject(new Error('Connection timed out')); });
    });
    res.json({ ok: true, message: 'Printer is reachable' });
  } catch (err) { res.json({ ok: false, error: err.message || 'Cannot reach printer' }); }
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

// ── JSON API — offline-capable POS order actions ──────────────────────────────
// Accepts JSON bodies; returns JSON state so pos-offline.js can update the DOM
router.use('/api', express.json());

async function orderStateJSON(orderId, tenantId) {
  const [oRes, iRes] = await Promise.all([
    db.query('SELECT * FROM pos_orders WHERE id=$1 AND tenant_id=$2', [orderId, tenantId]),
    db.query('SELECT * FROM pos_order_items WHERE order_id=$1 ORDER BY id', [orderId]),
  ]);
  const o = oRes.rows[0];
  if (!o) return null;
  const sub = calcSubtotal(iRes.rows);
  const tot = calcTotal(iRes.rows, o);
  return { order: o, items: iRes.rows, subtotal: sub, total: tot, discount: sub - tot };
}

// GET /pos/api/order/:id
router.get('/api/order/:id', requireAuth, requirePOS, async (req, res) => {
  try {
    const state = await orderStateJSON(req.params.id, req.user.tenantId);
    if (!state) return res.json({ ok: false, error: 'Not found' });
    res.json({ ok: true, ...state });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

// POST /pos/api/order/:id/add-item
router.post('/api/order/:id/add-item', requireAuth, requirePOS, async (req, res) => {
  const { menu_item_id } = req.body;
  try {
    const item = await db.query('SELECT * FROM menu_items WHERE id=$1 AND tenant_id=$2', [menu_item_id, req.user.tenantId]);
    if (!item.rows[0]) return res.json({ ok: false, error: 'Item not found' });
    const price = parseFloat(String(item.rows[0].price).replace(/[^0-9.]/g, '')) || 0;
    const existing = await db.query(
      'SELECT * FROM pos_order_items WHERE order_id=$1 AND menu_item_id=$2 AND notes IS NULL',
      [req.params.id, menu_item_id]
    );
    if (existing.rows[0]) {
      await db.query('UPDATE pos_order_items SET quantity=quantity+1 WHERE id=$1', [existing.rows[0].id]);
    } else {
      await db.query(
        'INSERT INTO pos_order_items (order_id, menu_item_id, name, price, quantity, notes) VALUES ($1,$2,$3,$4,1,NULL)',
        [req.params.id, menu_item_id, item.rows[0].name, price]
      );
    }
    const sRow = await db.query('SELECT session_id FROM pos_orders WHERE id=$1', [req.params.id]);
    await logAction(req.user.tenantId, sRow.rows[0]?.session_id, req.params.id, req.user.userId, 'item_add', { name: item.rows[0].name, price });
    const state = await orderStateJSON(req.params.id, req.user.tenantId);
    res.json({ ok: true, ...state });
  } catch (err) { console.error(err); res.json({ ok: false, error: 'Server error' }); }
});

// POST /pos/api/order/:id/item/:itemId/qty
router.post('/api/order/:id/item/:itemId/qty', requireAuth, requirePOS, async (req, res) => {
  const delta = parseInt(req.body.delta);
  try {
    const item = await db.query(
      'SELECT poi.*, po.session_id FROM pos_order_items poi JOIN pos_orders po ON po.id=poi.order_id WHERE poi.id=$1 AND po.tenant_id=$2 AND po.id=$3',
      [req.params.itemId, req.user.tenantId, req.params.id]
    );
    if (!item.rows[0]) return res.json({ ok: false, error: 'Not found' });
    const oldQty = item.rows[0].quantity;
    const newQty = oldQty + delta;
    if (newQty <= 0) {
      await db.query('DELETE FROM pos_order_items WHERE id=$1', [req.params.itemId]);
      await logAction(req.user.tenantId, item.rows[0].session_id, req.params.id, req.user.userId, 'item_remove', { name: item.rows[0].name });
    } else {
      await db.query('UPDATE pos_order_items SET quantity=$1 WHERE id=$2', [newQty, req.params.itemId]);
      await logAction(req.user.tenantId, item.rows[0].session_id, req.params.id, req.user.userId, 'item_qty', { name: item.rows[0].name, from: oldQty, to: newQty });
    }
    const state = await orderStateJSON(req.params.id, req.user.tenantId);
    res.json({ ok: true, ...state });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

// POST /pos/api/order/:id/item/:itemId/note
router.post('/api/order/:id/item/:itemId/note', requireAuth, requirePOS, async (req, res) => {
  try {
    await db.query(
      'UPDATE pos_order_items SET notes=$1 WHERE id=$2 AND order_id=$3',
      [req.body.note || null, req.params.itemId, req.params.id]
    );
    const state = await orderStateJSON(req.params.id, req.user.tenantId);
    res.json({ ok: true, ...state });
  } catch (err) { res.json({ ok: false }); }
});

// POST /pos/api/order/:id/note
router.post('/api/order/:id/note', requireAuth, requirePOS, async (req, res) => {
  try {
    const r = await db.query(
      'UPDATE pos_orders SET note=$1 WHERE id=$2 AND tenant_id=$3 RETURNING session_id',
      [req.body.note || null, req.params.id, req.user.tenantId]
    );
    await logAction(req.user.tenantId, r.rows[0]?.session_id, req.params.id, req.user.userId, 'order_note', { note: req.body.note || '' });
    const state = await orderStateJSON(req.params.id, req.user.tenantId);
    res.json({ ok: true, ...state });
  } catch (err) { res.json({ ok: false }); }
});

// POST /pos/api/order/:id/discount
router.post('/api/order/:id/discount', requireAuth, requirePOS, async (req, res) => {
  const { discount_type, discount_value, passkey } = req.body;
  try {
    if (discount_type !== 'none') {
      const pk = await validatePasskey(req.user.tenantId, passkey, 'discount');
      if (!pk) return res.json({ ok: false, error: 'invalid_passkey' });
      await db.query('UPDATE pos_passkeys SET used=true, used_by=$1, order_id=$2, used_at=NOW() WHERE id=$3',
        [req.user.userId, req.params.id, pk.id]);
    }
    const dr = await db.query(
      'UPDATE pos_orders SET discount_type=$1, discount_value=$2 WHERE id=$3 AND tenant_id=$4 RETURNING session_id',
      [discount_type || 'none', parseFloat(discount_value) || 0, req.params.id, req.user.tenantId]
    );
    const action = discount_type === 'none' ? 'discount_remove' : 'discount_apply';
    await logAction(req.user.tenantId, dr.rows[0]?.session_id, req.params.id, req.user.userId, action, { type: discount_type, value: parseFloat(discount_value) || 0 });
    const state = await orderStateJSON(req.params.id, req.user.tenantId);
    res.json({ ok: true, ...state });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

// POST /pos/api/order/:id/void
router.post('/api/order/:id/void', requireAuth, requirePOS, async (req, res) => {
  try {
    const pk = await validatePasskey(req.user.tenantId, req.body.passkey, 'void');
    if (!pk) return res.json({ ok: false, error: 'invalid_passkey' });
    const vr = await db.query(
      'UPDATE pos_orders SET status=$1 WHERE id=$2 AND tenant_id=$3 RETURNING session_id, table_name',
      ['void', req.params.id, req.user.tenantId]
    );
    await db.query('UPDATE pos_passkeys SET used=true, used_by=$1, order_id=$2, used_at=NOW() WHERE id=$3',
      [req.user.userId, req.params.id, pk.id]);
    await logAction(req.user.tenantId, vr.rows[0]?.session_id, req.params.id, req.user.userId, 'order_void', { table_name: vr.rows[0]?.table_name });
    res.json({ ok: true, redirect: '/pos/tables' });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

module.exports = router;
