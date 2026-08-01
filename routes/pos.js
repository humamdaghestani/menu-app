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
  code = code.trim();
  // Check permanent code first
  const field = actionType === 'void' ? 'pos_perm_void_code' : 'pos_perm_discount_code';
  const tRes = await db.query(`SELECT ${field} AS perm FROM tenants WHERE id=$1`, [tenantId]);
  if (tRes.rows[0]?.perm && tRes.rows[0].perm === code) {
    return { id: null, permanent: true };
  }
  // Fall back to one-time passkey
  const r = await db.query(
    "SELECT * FROM pos_passkeys WHERE tenant_id=$1 AND code=$2 AND action_type=$3 AND used=false AND expires_at > NOW()",
    [tenantId, code, actionType]
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
      'INSERT INTO pos_sessions (tenant_id, opened_by, opening_cash, exchange_rate) VALUES ($1,$2,$3,$4)',
      [req.user.tenantId, req.user.userId, parseFloat(req.body.opening_cash) || 0, parseFloat(req.body.exchange_rate) || 1]
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
    // Sum IQD cash received this session (from payments table)
    const cashIQDRes = await db.query(
      `SELECT COALESCE(SUM(pp.amount_paid_iqd),0) AS cash_iqd
       FROM pos_payments pp
       JOIN pos_orders po ON po.id = pp.order_id
       WHERE po.session_id=$1 AND pp.method='cash'`,
      [session.id]
    );
    summary.cashIQD = parseFloat(cashIQDRes.rows[0].cash_iqd) || 0;
    const openRes = await db.query(
      `SELECT id, table_name, status, total, created_at
       FROM pos_orders
       WHERE session_id=$1 AND status NOT IN ('paid','void')
       ORDER BY created_at`,
      [session.id]
    );
    // Z-Report data
    const [topItemsRes, zStatsRes, voidRes] = await Promise.all([
      db.query(`
        SELECT poi.name, SUM(poi.quantity) AS qty, SUM(poi.price * poi.quantity) AS revenue
        FROM pos_order_items poi
        JOIN pos_orders po ON po.id = poi.order_id
        WHERE po.session_id=$1 AND po.status='paid'
        GROUP BY poi.name ORDER BY revenue DESC LIMIT 8`, [session.id]),
      db.query(`
        SELECT
          COALESCE(SUM(tip_amount),0)    AS total_tips,
          COALESCE(SUM(cover_count),0)   AS total_covers,
          COALESCE(SUM(service_fee),0)   AS total_service_fees,
          COUNT(*) FILTER (WHERE discount_type != 'none') AS discount_orders,
          COALESCE(SUM(CASE WHEN discount_type='fixed' THEN discount_value
                            WHEN discount_type='percent' THEN total * discount_value / (100 - discount_value)
                            ELSE 0 END), 0) AS total_discounts
        FROM pos_orders WHERE session_id=$1 AND status='paid'`, [session.id]),
      db.query(`SELECT COUNT(*) AS cnt FROM pos_orders WHERE session_id=$1 AND status='void'`, [session.id]),
    ]);
    const zStats = zStatsRes.rows[0] || {};
    // Per-cashier breakdown
    const cashierRes = await db.query(`
      SELECT u.name AS cashier_name, po.created_by,
        COUNT(po.id)::int AS order_count,
        COALESCE(SUM(po.total),0) AS total_sales,
        COALESCE(SUM(po.tip_amount),0) AS tip_total,
        COUNT(*) FILTER (WHERE po.discount_type != 'none')::int AS discounts_given,
        COALESCE(SUM(CASE WHEN po.discount_type='fixed' THEN po.discount_value
                         WHEN po.discount_type='percent' THEN po.total * po.discount_value / (100 - po.discount_value)
                         ELSE 0 END), 0) AS total_discounts
      FROM pos_orders po
      LEFT JOIN users u ON u.id = po.created_by
      WHERE po.session_id=$1 AND po.status='paid'
      GROUP BY po.created_by, u.name
      ORDER BY total_sales DESC`, [session.id]);
    // Comp/void item audit
    const compRes = await db.query(`
      SELECT u.name AS cashier_name, COUNT(*)::int AS comp_count,
        pal.details->>'name' AS item_name, pal.details->>'reason' AS reason
      FROM pos_activity_log pal
      LEFT JOIN users u ON u.id = pal.user_id
      WHERE pal.session_id=$1 AND pal.action='item_comp'
      ORDER BY pal.created_at DESC LIMIT 20`, [session.id]);
    res.render('pos/session-close', {
      tenant, session,
      orders: orders.rows,
      openOrders: openRes.rows,
      summary: { ...summary, tips: parseFloat(zStats.total_tips)||0, covers: parseInt(zStats.total_covers)||0 },
      topItems: topItemsRes.rows,
      zStats: { ...zStats, voids: parseInt(voidRes.rows[0]?.cnt)||0 },
      cashierStats: cashierRes.rows,
      compLog: compRes.rows,
      currentUser: req.user,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/session/close', requireAuth, requirePOS, async (req, res) => {
  try {
    const session = await getOpenSession(req.user.tenantId);
    if (!session) return res.redirect('/pos');

    const openCheck = await db.query(
      `SELECT id FROM pos_orders WHERE session_id=$1 AND status NOT IN ('paid','void') LIMIT 1`,
      [session.id]
    );
    if (openCheck.rows.length > 0) return res.redirect('/pos/session/close');

    await db.query(
      "UPDATE pos_sessions SET status='closed', closing_cash=$1, notes=$2, closed_at=NOW() WHERE id=$3",
      [parseFloat(req.body.closing_cash) || 0, req.body.notes || null, session.id]
    );
    res.redirect('/pos/session/open');
  } catch (err) { console.error(err); res.redirect('/pos/session/close'); }
});

// ── Update exchange rate for open session ─────────────────────────────────────
router.post('/session/exchange-rate', requireAuth, requirePOS, async (req, res) => {
  try {
    const session = await getOpenSession(req.user.tenantId);
    if (!session) return res.json({ ok: false, error: 'No open session' });
    const rate = parseFloat(req.body.exchange_rate) || 1;
    await db.query('UPDATE pos_sessions SET exchange_rate=$1 WHERE id=$2', [rate, session.id]);
    res.json({ ok: true, rate });
  } catch (err) { console.error(err); res.json({ ok: false, error: err.message }); }
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
router.get('/home', requireAuth, requirePOS, async (req, res) => res.redirect('/pos'));

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
        o.cover_count, o.is_held,
        COALESCE(SUM(oi.price * oi.quantity),0) AS order_total,
        COUNT(oi.id) AS item_count
       FROM restaurant_tables t
       LEFT JOIN pos_orders o ON o.table_id = t.id AND o.status = 'open'
       LEFT JOIN pos_order_items oi ON oi.order_id = o.id
       WHERE t.tenant_id = $1
       GROUP BY t.id, o.id, o.status, o.bill_requested, o.cover_count, o.is_held
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
    const [orderRes, itemsRes, categoriesRes, menuRes, tablesRes, printersRes] = await Promise.all([
      db.query('SELECT * FROM pos_orders WHERE id=$1 AND tenant_id=$2', [req.params.orderId, req.user.tenantId]),
      db.query('SELECT * FROM pos_order_items WHERE order_id=$1 ORDER BY id', [req.params.orderId]),
      db.query('SELECT * FROM categories WHERE tenant_id=$1 ORDER BY sort_order', [req.user.tenantId]),
      db.query('SELECT * FROM menu_items WHERE tenant_id=$1 AND is_available=true ORDER BY sort_order', [req.user.tenantId]),
      db.query(
        `SELECT t.*, o.id AS current_order_id
         FROM restaurant_tables t
         LEFT JOIN pos_orders o ON o.table_id=t.id AND o.status='open' AND o.id!=$1
         WHERE t.tenant_id=$2 ORDER BY t.sort_order, t.name`,
        [req.params.orderId, req.user.tenantId]
      ),
      db.query("SELECT * FROM pos_printers WHERE tenant_id=$1 AND is_active=true AND connection_type='network' AND ip_address IS NOT NULL ORDER BY id", [req.user.tenantId]),
    ]);
    if (!orderRes.rows[0]) return res.redirect('/pos');
    const o = orderRes.rows[0];
    const subtotal = calcSubtotal(itemsRes.rows);
    const total    = calcTotal(itemsRes.rows, o);
    const discount = subtotal - total;
    let exchangeRate = 1;
    if (o.session_id) {
      const sesRes = await db.query('SELECT exchange_rate FROM pos_sessions WHERE id=$1', [o.session_id]);
      exchangeRate = parseFloat(sesRes.rows[0]?.exchange_rate) || 1;
    }
    const serviceFeePct = parseFloat(tenant.pos_service_fee_pct) || 0;
    let customLabels = {};
    try { customLabels = JSON.parse(tenant.bill_custom_labels || '{}'); } catch (_) {}
    res.render('pos/order', {
      tenant, order: o,
      orderItems: itemsRes.rows,
      categories: categoriesRes.rows,
      menuItems: menuRes.rows,
      tables: tablesRes.rows,
      printers: printersRes.rows,
      subtotal, total, discount,
      exchangeRate, serviceFeePct,
      customLabels,
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
      if (!pk.permanent) await db.query('UPDATE pos_passkeys SET used=true, used_by=$1, order_id=$2, used_at=NOW() WHERE id=$3',
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
    const [orderRes, itemsRes, customersRes, loyaltyProgRes] = await Promise.all([
      db.query('SELECT * FROM pos_orders WHERE id=$1 AND tenant_id=$2', [req.params.orderId, req.user.tenantId]),
      db.query('SELECT * FROM pos_order_items WHERE order_id=$1', [req.params.orderId]),
      db.query('SELECT id, name, phone, loyalty_points FROM customers WHERE tenant_id=$1 ORDER BY name', [req.user.tenantId]),
      db.query("SELECT * FROM loyalty_programs WHERE tenant_id=$1 AND is_active=true LIMIT 1", [req.user.tenantId]),
    ]);
    if (!orderRes.rows[0] || orderRes.rows[0].status !== 'open') return res.redirect('/pos');
    const o = orderRes.rows[0];
    const subtotal = calcSubtotal(itemsRes.rows);
    const total    = calcTotal(itemsRes.rows, o);
    const discount = subtotal - total;
    const sessionRes = await db.query('SELECT exchange_rate FROM pos_sessions WHERE id=$1', [o.session_id]);
    const exchangeRate = parseFloat(sessionRes.rows[0]?.exchange_rate) || 1;
    const loyaltyProgram = loyaltyProgRes.rows[0] || null;
    const tenantFeePct  = parseFloat(tenant.pos_service_fee_pct) || 0;
    const serviceFeePct = (o.apply_service_fee && tenantFeePct > 0) ? tenantFeePct : 0;
    const serviceFee    = serviceFeePct > 0 ? parseFloat((total * serviceFeePct / 100).toFixed(2)) : 0;
    const grandTotal    = total + serviceFee;
    res.render('pos/payment', { tenant, order: o, orderItems: itemsRes.rows, subtotal, total, discount, customers: customersRes.rows, exchangeRate, loyaltyProgram, serviceFeePct, serviceFee, grandTotal, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Process payment ───────────────────────────────────────────────────────────
router.post('/order/:orderId/pay', requireAuth, requirePOS, async (req, res) => {
  const { method, amount_paid, customer_id, received_currency, exchange_rate, tip_amount, redeem_points } = req.body;
  try {
    const orderRes = await db.query('SELECT * FROM pos_orders WHERE id=$1 AND tenant_id=$2', [req.params.orderId, req.user.tenantId]);
    const items = await db.query('SELECT * FROM pos_order_items WHERE order_id=$1', [req.params.orderId]);
    const baseTotal = calcTotal(items.rows, orderRes.rows[0]);
    // Service fee
    const feePct  = parseFloat(req.body.service_fee_pct) || 0;
    const serviceFee = feePct > 0 ? parseFloat((baseTotal * feePct / 100).toFixed(2)) : 0;
    const total   = baseTotal + serviceFee;
    const tip     = parseFloat(tip_amount) || 0;
    const paid    = parseFloat(amount_paid) || 0;
    const recvCur = received_currency || 'USD';
    const exRate  = parseFloat(exchange_rate) || 1;
    const paidUSD = recvCur === 'IQD' ? paid / exRate : paid;
    const paidIQD = recvCur === 'IQD' ? paid : paid * exRate;
    const change  = Math.max(0, paidUSD - total - tip);
    await db.query(
      'INSERT INTO pos_payments (order_id, method, amount_paid, change_given, received_currency, amount_paid_iqd, exchange_rate) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.params.orderId, method || 'cash', paidUSD, change, recvCur, paidIQD, exRate]
    );
    // Generate sequential receipt number
    const seqRes = await db.query(
      'UPDATE tenants SET receipt_seq = COALESCE(receipt_seq, 0) + 1 WHERE id=$1 RETURNING receipt_seq, COALESCE(receipt_prefix,\'\') AS receipt_prefix',
      [req.user.tenantId]
    );
    const receiptNo = (seqRes.rows[0]?.receipt_prefix || '') + String(seqRes.rows[0]?.receipt_seq || 1).padStart(4, '0');
    const cid = parseInt(customer_id) || null;
    await db.query(
      'UPDATE pos_orders SET status=$1, total=$2, tip_amount=$3, receipt_no=$4, paid_at=NOW(), customer_id=$5, service_fee=$6 WHERE id=$7 AND tenant_id=$8',
      ['paid', total, tip, receiptNo, cid, serviceFee, req.params.orderId, req.user.tenantId]
    );
    if (cid) {
      await db.query(
        'UPDATE customers SET total_spent=total_spent+$1, visit_count=visit_count+1 WHERE id=$2 AND tenant_id=$3',
        [total + tip, cid, req.user.tenantId]
      );
      // Loyalty: redeem points if requested
      const pointsToRedeem = parseInt(redeem_points) || 0;
      if (pointsToRedeem > 0) {
        const progRes = await db.query("SELECT * FROM loyalty_programs WHERE tenant_id=$1 AND is_active=true LIMIT 1", [req.user.tenantId]);
        if (progRes.rows[0]) {
          await db.query('UPDATE customers SET loyalty_points = GREATEST(0, loyalty_points - $1) WHERE id=$2', [pointsToRedeem, cid]);
          await db.query(
            'INSERT INTO loyalty_transactions (tenant_id, customer_id, order_id, type, points, notes) VALUES ($1,$2,$3,$4,$5,$6)',
            [req.user.tenantId, cid, req.params.orderId, 'redeem', -pointsToRedeem, `Redeemed at POS order #${req.params.orderId}`]
          );
        }
      }
      // Loyalty: earn points on this order
      const progRes2 = await db.query("SELECT * FROM loyalty_programs WHERE tenant_id=$1 AND is_active=true LIMIT 1", [req.user.tenantId]);
      if (progRes2.rows[0]) {
        const prog = progRes2.rows[0];
        const earnedPts = Math.floor(total / parseFloat(prog.unit_amount) * parseFloat(prog.points_per_unit));
        if (earnedPts > 0) {
          await db.query('UPDATE customers SET loyalty_points = loyalty_points + $1 WHERE id=$2', [earnedPts, cid]);
          await db.query(
            'INSERT INTO loyalty_transactions (tenant_id, customer_id, order_id, type, points, notes) VALUES ($1,$2,$3,$4,$5,$6)',
            [req.user.tenantId, cid, req.params.orderId, 'earn', earnedPts, `Earned on POS order #${req.params.orderId}`]
          );
        }
      }
    }
    await logAction(req.user.tenantId, orderRes.rows[0]?.session_id, req.params.orderId, req.user.userId, 'order_paid', { method: method || 'cash', amount_paid: paid, total, tip, change, customer_id: cid, receipt_no: receiptNo, redeem_points: parseInt(redeem_points) || 0 });
    try {
      const { deductStockForOrder } = require('./inventory');
      const tenantRow = await db.query('SELECT feat_inventory FROM tenants WHERE id=$1', [req.user.tenantId]);
      if (tenantRow.rows[0]?.feat_inventory) {
        await deductStockForOrder(req.user.tenantId, req.params.orderId, req.user.userId);
      }
    } catch(e) { console.error('[inventory deduct]', e.message); }
    res.redirect('/pos/receipt/' + req.params.orderId);
  } catch (err) { console.error(err); res.redirect('/pos/order/' + req.params.orderId); }
});

// ── Void order (requires passkey) ─────────────────────────────────────────────
router.post('/order/:orderId/void', requireAuth, requirePOS, async (req, res) => {
  try {
    const pk = await validatePasskey(req.user.tenantId, req.body.passkey, 'void');
    if (!pk) return res.redirect('/pos/order/' + req.params.orderId + '?error=passkey');
    const vr = await db.query('UPDATE pos_orders SET status=$1 WHERE id=$2 AND tenant_id=$3 RETURNING session_id, table_name', ['void', req.params.orderId, req.user.tenantId]);
    if (!pk.permanent) await db.query('UPDATE pos_passkeys SET used=true, used_by=$1, order_id=$2, used_at=NOW() WHERE id=$3',
      [req.user.userId, req.params.orderId, pk.id]);
    await logAction(req.user.tenantId, vr.rows[0]?.session_id, req.params.orderId, req.user.userId, 'order_void', { table_name: vr.rows[0]?.table_name });
    res.redirect('/pos/tables');
  } catch (err) { console.error(err); res.redirect('/pos/tables'); }
});

// ── Print Bill (during order) ─────────────────────────────────────────────────
router.get('/order/:orderId/bill', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const [orderRes, itemsRes] = await Promise.all([
      db.query('SELECT * FROM pos_orders WHERE id=$1 AND tenant_id=$2', [req.params.orderId, req.user.tenantId]),
      db.query('SELECT * FROM pos_order_items WHERE order_id=$1 ORDER BY id', [req.params.orderId]),
    ]);
    if (!orderRes.rows[0]) return res.status(404).send('Order not found');
    const o = orderRes.rows[0];
    let exchangeRate = 1;
    if (o.session_id) {
      const sesRes = await db.query('SELECT exchange_rate FROM pos_sessions WHERE id=$1', [o.session_id]);
      exchangeRate = parseFloat(sesRes.rows[0]?.exchange_rate) || 1;
    }
    const serviceFeePct = parseFloat(tenant.pos_service_fee_pct) || 0;
    const subtotal = itemsRes.rows.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0);
    let total = subtotal;
    const dv = parseFloat(o.discount_value || 0);
    if (o.discount_type === 'percent' && dv) total = Math.max(0, subtotal - subtotal * dv / 100);
    else if (o.discount_type === 'fixed'   && dv) total = Math.max(0, subtotal - dv);
    const discount   = subtotal - total;
    const svcFee     = (serviceFeePct > 0 && o.apply_service_fee) ? parseFloat((total * serviceFeePct / 100).toFixed(2)) : 0;
    const grandTotal = total + svcFee;
    let customLabels = {};
    try { customLabels = JSON.parse(tenant.bill_custom_labels || '{}'); } catch (_) {}
    res.render('pos/bill', {
      tenant, order: o, orderItems: itemsRes.rows,
      subtotal, discount, svcFee, grandTotal,
      exchangeRate, serviceFeePct, customLabels,
      currentUser: req.user,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
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
    const station = req.query.station || null;
    // If kitchen routing enabled + station filter, join items with categories
    let ordersRes;
    if (tenant.feat_kitchen_routing && station) {
      ordersRes = await db.query(
        `SELECT DISTINCT po.*, json_agg(poi.* ORDER BY poi.id) OVER (PARTITION BY po.id) AS items
         FROM pos_orders po
         JOIN pos_order_items poi ON poi.order_id = po.id
         JOIN menu_items mi ON mi.id = poi.menu_item_id
         JOIN categories cat ON cat.id = mi.category_id
         WHERE po.tenant_id=$1 AND po.status='open' AND COALESCE(cat.kitchen_station,'main')=$2
         ORDER BY po.created_at`,
        [req.user.tenantId, station]
      );
    } else {
      ordersRes = await db.query(
        `SELECT po.*, json_agg(poi.* ORDER BY poi.id) AS items
         FROM pos_orders po
         JOIN pos_order_items poi ON poi.order_id = po.id
         WHERE po.tenant_id=$1 AND po.status='open'
         GROUP BY po.id ORDER BY po.created_at`,
        [req.user.tenantId]
      );
    }
    // Fetch distinct stations if routing enabled
    let stations = [];
    if (tenant.feat_kitchen_routing) {
      const sRes = await db.query(
        'SELECT DISTINCT COALESCE(kitchen_station,\'main\') AS station FROM categories WHERE tenant_id=$1 ORDER BY station',
        [req.user.tenantId]
      );
      stations = sRes.rows.map(r => r.station);
    }
    res.render('pos/kitchen', { tenant, orders: ordersRes.rows, currentUser: req.user, station, stations });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Kitchen API: poll orders ──────────────────────────────────────────────────
router.get('/api/kitchen', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const station = req.query.station || null;
    let ordersRes;
    if (tenant.feat_kitchen_routing && station) {
      ordersRes = await db.query(
        `SELECT DISTINCT ON (po.id) po.*, json_agg(poi.* ORDER BY poi.id) OVER (PARTITION BY po.id) AS items
         FROM pos_orders po
         JOIN pos_order_items poi ON poi.order_id = po.id
         JOIN menu_items mi ON mi.id = poi.menu_item_id
         JOIN categories cat ON cat.id = mi.category_id
         WHERE po.tenant_id=$1 AND po.status='open' AND COALESCE(cat.kitchen_station,'main')=$2
         ORDER BY po.id, po.created_at`,
        [req.user.tenantId, station]
      );
    } else {
      ordersRes = await db.query(
        `SELECT po.*, json_agg(poi.* ORDER BY poi.id) AS items
         FROM pos_orders po
         JOIN pos_order_items poi ON poi.order_id = po.id
         WHERE po.tenant_id=$1 AND po.status='open'
         GROUP BY po.id ORDER BY po.created_at`,
        [req.user.tenantId]
      );
    }
    res.json({ orders: ordersRes.rows });
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

// ── Print Agent installer (PowerShell — embeds ESC/POS agent as base64, registers startup task) ──
router.get('/print-agent-installer', requireAuth, requirePOS, async (req, res) => {
  let agentToken = req.tenant?.pos_agent_token;
  if (!agentToken) {
    agentToken = require('crypto').randomBytes(32).toString('hex');
    await db.query('UPDATE tenants SET pos_agent_token=$1 WHERE id=$2', [agentToken, req.user.tenantId]);
  }
  const relayBase = req.protocol + '://' + req.get('host');
  // ESC/POS TCP agent — pure Node.js built-ins, no npm packages needed
  const agentLines = [
    "var http  = require('http');",
    "var https = require('https');",
    "var url   = require('url');",
    "var net   = require('net');",
    "var PORT  = 9191;",
    "var RELAY_URL   = '" + relayBase + "';",
    "var AGENT_TOKEN = '" + agentToken + "';",
    "function printTCP(ip, port, buf) {",
    "  return new Promise(function(resolve, reject) {",
    "    var sock = new net.Socket();",
    "    sock.setTimeout(5000);",
    "    sock.connect(port, ip, function() {",
    "      sock.write(buf, function() {",
    "        setTimeout(function() { sock.destroy(); resolve(); }, 400);",
    "      });",
    "    });",
    "    sock.on('error', function(e) { sock.destroy(); reject(e); });",
    "    sock.on('timeout', function() { sock.destroy(); reject(new Error('Printer timeout')); });",
    "  });",
    "}",
    "function buildEscPos(data) {",
    "  var buf = [];",
    "  function txt(s) { var b=Buffer.from(String(s||''),'utf8'); for(var i=0;i<b.length;i++) buf.push(b[i]); }",
    "  function cmd() { for (var i=0;i<arguments.length;i++) buf.push(arguments[i]); }",
    "  function txtnl(s) { txt(s); cmd(0x0A); }",
    "  var pw = (data.paper_width_mm || 80) >= 80 ? 48 : 32;",
    "  function sep(c) { var s=''; for(var j=0;j<pw;j++) s+=c; return s; }",
    "  function rpad(s,n) { s=String(s||''); while(s.length<n) s+=' '; return s.slice(0,n); }",
    "  function lpad(s,n) { s=String(s||''); while(s.length<n) s=' '+s; return s.slice(-n); }",
    "  function ln2(a,b) { return rpad(String(a), pw-String(b).length)+String(b); }",
    "  cmd(0x1B,0x40);",
    "  cmd(0x1C,0x26);",
    "  if (data.type === 'bill') {",
    "    var CUR = data.currency || '$';",
    "    function fmtAmt(n) { n=parseFloat(n)||0; return CUR+(n===Math.round(n)?Math.round(n).toString():n.toFixed(2)); }",
    "    var NW=pw>=48?22:14, QW=pw>=48?4:3, PRW=pw>=48?10:7, TW=pw>=48?12:8;",
    "    function row4(a,b,c,d) { return rpad(a,NW)+lpad(b,QW)+lpad(c,PRW)+lpad(d,TW); }",
    "    var lbls = data.labels || {};",
    "    cmd(0x1B,0x61,0x01); cmd(0x1B,0x21,0x10);",
    "    txtnl(data.shop||'');",
    "    cmd(0x1B,0x21,0x00);",
    "    if (data.header) txtnl(data.header);",
    "    cmd(0x1B,0x61,0x00);",
    "    txtnl(sep('-'));",
    "    txtnl((data.order_type||'Dine-in')+'  Bill #'+(data.bill_id||''));",
    "    txtnl(rpad(data.table||'', pw-22)+(data.date||''));",
    "    if (data.note) { txtnl(sep('-')); txtnl('Note: '+data.note); }",
    "    txtnl(sep('='));",
    "    cmd(0x1B,0x45,0x01);",
    "    txtnl(row4(lbls.item||'Item', lbls.qty||'Qty', lbls.price||'Price', lbls.total_col||'Total'));",
    "    cmd(0x1B,0x45,0x00);",
    "    txtnl(sep('-'));",
    "    var items = data.items || [];",
    "    for (var ii=0; ii<items.length; ii++) {",
    "      var it=items[ii];",
    "      var upr=fmtAmt(parseFloat(it.price)||0);",
    "      var tot=fmtAmt((parseFloat(it.price)||0)*(parseInt(it.qty)||1));",
    "      var nm=String(it.name||'');",
    "      if (nm.length>NW) {",
    "        txtnl(row4(nm.slice(0,NW),'x'+it.qty,upr,tot));",
    "        var r=nm.slice(NW); while(r.length){txtnl(rpad(' '+r.slice(0,NW-1),NW));r=r.slice(NW-1);}",
    "      } else { txtnl(row4(nm,'x'+it.qty,upr,tot)); }",
    "      if (it.note) txtnl(' >> '+it.note);",
    "    }",
    "    txtnl(sep('='));",
    "    if (data.subtotal) txtnl(ln2(lbls.subtotal||'Sub Total', fmtAmt(data.subtotal)));",
    "    if (data.svcfee)   txtnl(ln2((lbls.svcfee||'Service')+' +', fmtAmt(data.svcfee)));",
    "    if (data.discount) txtnl(ln2((lbls.discount||'Discount')+' -', fmtAmt(data.discount)));",
    "    cmd(0x1B,0x45,0x01);",
    "    txtnl(ln2(lbls.total||'Net Total', fmtAmt(data.total)));",
    "    cmd(0x1B,0x45,0x00);",
    "    if (data.iqd_total) txtnl(ln2('IQD', String(data.iqd_total)));",
    "    txtnl(sep('-'));",
    "    cmd(0x1B,0x61,0x01);",
    "    if (lbls.cashier) txtnl((lbls.served_by||'Served by')+': '+lbls.cashier);",
    "    txtnl(data.footer||lbls.thanks||'Thank you!');",
    "  } else if (data.type === 'order') {",
    "    cmd(0x1B,0x61,0x01); cmd(0x1B,0x21,0x30);",
    "    txtnl(data.table||'Takeaway');",
    "    cmd(0x1B,0x21,0x00); cmd(0x1B,0x61,0x00);",
    "    var t=new Date(); var hh=t.getHours()%12||12; var mm=String(t.getMinutes()).padStart(2,'0'); var ap=t.getHours()>=12?'PM':'AM';",
    "    txtnl('Order #'+(data.order_id||'')+'   '+hh+':'+mm+' '+ap);",
    "    if (data.order_type) txtnl(data.order_type);",
    "    if (data.note) txtnl('Note: '+data.note);",
    "    txtnl(sep('-'));",
    "    var items=data.items||[];",
    "    for (var ii=0;ii<items.length;ii++) {",
    "      var it=items[ii];",
    "      cmd(0x1B,0x45,0x01);",
    "      txtnl('x'+it.qty+'  '+it.name);",
    "      cmd(0x1B,0x45,0x00);",
    "      if (it.note) txtnl('   >> '+it.note);",
    "    }",
    "    txtnl(sep('='));",
    "  }",
    "  cmd(0x1B,0x64,0x06);",
    "  cmd(0x1D,0x56,0x01);",
    "  return Buffer.from(buf);",
    "}",
    "http.createServer(function(req, res) {",
    "  res.setHeader('Access-Control-Allow-Origin','*');",
    "  res.setHeader('Access-Control-Allow-Methods','POST,GET,OPTIONS');",
    "  res.setHeader('Access-Control-Allow-Headers','Content-Type');",
    "  if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return; }",
    "  if (req.method==='GET' && req.url==='/ping') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,version:'2.1'})); return; }",
    "  if (req.method==='POST' && req.url==='/print') {",
    "    var body='';",
    "    req.on('data',function(d){ body+=d.toString(); });",
    "    req.on('end',function() {",
    "      var data; try { data=JSON.parse(body); } catch(e) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Invalid JSON'})); return; }",
    "      var ip=data.printer_ip; var port=parseInt(data.printer_port)||9100;",
    "      if (!ip) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'printer_ip required'})); return; }",
    "      var buf; try { buf=buildEscPos(data); } catch(e) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Build error: '+e.message})); return; }",
    "      printTCP(ip,port,buf).then(function(){ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); }).catch(function(e){ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); });",
    "    });",
    "    return;",
    "  }",
    "  res.writeHead(404); res.end();",
    "}).listen(PORT,'0.0.0.0',function(){",
    "  var os=require('os'); var ips=[];",
    "  Object.values(os.networkInterfaces()).forEach(function(a){a.forEach(function(i){if(i.family==='IPv4'&&!i.internal)ips.push(i.address);});});",
    "  console.log('POS Print Agent v2.1');",
    "  console.log('  Local:   http://127.0.0.1:'+PORT);",
    "  ips.forEach(function(ip){ console.log('  Network: http://'+ip+':'+PORT); });",
    "  if (RELAY_URL) console.log('  Relay:   '+RELAY_URL+' (iPad/cloud printing active)');",
    "});",
    "function relayPoll() {",
    "  if (!RELAY_URL || !AGENT_TOKEN) return;",
    "  var parsed = url.parse(RELAY_URL+'/pos/agent/poll?token='+AGENT_TOKEN);",
    "  var mod = parsed.protocol==='https:'?https:http;",
    "  mod.get({host:parsed.hostname,port:parsed.port,path:parsed.path,headers:{'User-Agent':'POSAgent/2.1'}},function(res){",
    "    var body=''; res.on('data',function(d){body+=d;}); res.on('end',function(){",
    "      try {",
    "        var r=JSON.parse(body);",
    "        (r.jobs||[]).forEach(function(job){",
    "          var p=typeof job.payload==='string'?JSON.parse(job.payload):job.payload;",
    "          if(!p.printer_ip) return;",
    "          var buf; try{buf=buildEscPos(p);}catch(e){return;}",
    "          printTCP(p.printer_ip,parseInt(p.printer_port)||9100,buf).then(function(){",
    "            var ap=url.parse(RELAY_URL+'/pos/agent/ack/'+job.id+'?token='+AGENT_TOKEN);",
    "            var m2=ap.protocol==='https:'?https:http;",
    "            var aq=m2.request({host:ap.hostname,port:ap.port,path:ap.path,method:'POST',headers:{'Content-Length':0}},function(){});",
    "            aq.on('error',function(){}); aq.end();",
    "          }).catch(function(){});",
    "        });",
    "      } catch(e){}",
    "    });",
    "  }).on('error',function(){});",
    "}",
    "setInterval(relayPoll, 2000);",
  ];

  const agentCode = agentLines.join('\n');
  const agentB64  = Buffer.from(agentCode, 'utf8').toString('base64');

  const ps1 = `# POS Print Agent Installer v2
# Right-click this file -> Run with PowerShell
# Installs a silent ESC/POS print agent — no npm packages needed.

$ErrorActionPreference = 'Stop'
$AgentDir = "$env:APPDATA\\POSPrintAgent"

Write-Host ""
Write-Host "POS Print Agent v2 Setup" -ForegroundColor Cyan
Write-Host "========================" -ForegroundColor Cyan

Write-Host "[1/3] Checking Node.js..." -NoNewline
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host " not found. Installing via winget..." -ForegroundColor Yellow
  winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Null
  $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js install failed. Install from https://nodejs.org then re-run." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
  }
  Write-Host " installed." -ForegroundColor Green
} else { Write-Host " OK" -ForegroundColor Green }

Write-Host "[2/3] Writing agent..." -NoNewline
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
$b64   = "${agentB64}"
$bytes = [System.Convert]::FromBase64String($b64)
$txt   = [System.Text.Encoding]::UTF8.GetString($bytes)
[System.IO.File]::WriteAllText("$AgentDir\\pos-print-agent.js", $txt, [System.Text.Encoding]::UTF8)
Write-Host " done" -ForegroundColor Green

Write-Host "[3/3] Registering startup task..." -NoNewline
$nodePath = (Get-Command node).Source
$q        = [char]34
$agentJs  = "$AgentDir\\pos-print-agent.js"
$agentArg = $q + $agentJs + $q
$action   = New-ScheduledTaskAction -Execute $nodePath -Argument $agentArg -WorkingDirectory $AgentDir
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal= New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest
Unregister-ScheduledTask -TaskName "POSPrintAgent" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "POSPrintAgent" -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Write-Host " done" -ForegroundColor Green

Write-Host "[+] Starting agent now..." -NoNewline
# Kill any old agent process on port 9191 first
$old = Get-NetTCPConnection -LocalPort 9191 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($old) { Stop-Process -Id $old -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }
# Launch agent directly (not via scheduled task, so it works immediately)
Start-Process -FilePath $nodePath -ArgumentList $agentArg -WorkingDirectory $AgentDir -WindowStyle Hidden
Start-Sleep -Seconds 2
# Verify it's listening
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:9191/ping" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
  Write-Host " OK — agent is running!" -ForegroundColor Green
} catch {
  Write-Host " could not verify. Check that Node.js works:" -ForegroundColor Yellow
  Write-Host ("  node " + $q + $agentJs + $q) -ForegroundColor Cyan
}

Write-Host ""
Write-Host "Done! Agent auto-starts with Windows. Go back to POS Settings and click Test Connection." -ForegroundColor Green
Write-Host ""
Write-Host "If Test Connection still fails, open Command Prompt and run:" -ForegroundColor Gray
Write-Host ("  node " + $q + $agentJs + $q) -ForegroundColor Cyan
Write-Host "Keep that window open while using POS." -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to close"
`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="install-pos-print-agent.ps1"');
  res.send(ps1);
});

// ── Print Relay — browser sends job; agent polls and prints ──────────────────
router.post('/print-relay', requireAuth, async (req, res) => {
  try {
    await db.query('INSERT INTO pos_print_jobs (tenant_id, payload) VALUES ($1, $2)',
      [req.user.tenantId, JSON.stringify(req.body)]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.json({ ok: false }); }
});

router.get('/agent/poll', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.json({ jobs: [] });
    const tRes = await db.query('SELECT id FROM tenants WHERE pos_agent_token=$1', [token]);
    if (!tRes.rows[0]) return res.json({ jobs: [] });
    const tid = tRes.rows[0].id;
    await db.query("UPDATE pos_print_jobs SET status='expired' WHERE tenant_id=$1 AND status='pending' AND created_at < NOW()-INTERVAL '10 minutes'", [tid]);
    const jobs = await db.query("SELECT * FROM pos_print_jobs WHERE tenant_id=$1 AND status='pending' ORDER BY id LIMIT 10", [tid]);
    if (jobs.rows.length) {
      await db.query("UPDATE pos_print_jobs SET status='processing' WHERE id = ANY($1)", [jobs.rows.map(j => j.id)]);
    }
    res.json({ jobs: jobs.rows });
  } catch(e) { res.json({ jobs: [] }); }
});

router.post('/agent/ack/:id', async (req, res) => {
  try {
    const { token } = req.query;
    const tRes = await db.query('SELECT id FROM tenants WHERE pos_agent_token=$1', [token]);
    if (!tRes.rows[0]) return res.json({ ok: false });
    await db.query("UPDATE pos_print_jobs SET status='done' WHERE id=$1 AND tenant_id=$2", [req.params.id, tRes.rows[0].id]);
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

// ── Print Agent JS direct download (bypasses PowerShell execution policy) ─────
router.get('/print-agent-js', requireAuth, requirePOS, async (req, res) => {
  // Generate agent token if not yet set
  let agentToken = req.tenant?.pos_agent_token;
  if (!agentToken) {
    agentToken = require('crypto').randomBytes(32).toString('hex');
    await db.query('UPDATE tenants SET pos_agent_token=$1 WHERE id=$2', [agentToken, req.user.tenantId]);
  }
  const relayBase = req.protocol + '://' + req.get('host');
  const agentLines = [
    "var http  = require('http');",
    "var https = require('https');",
    "var url   = require('url');",
    "var net   = require('net');",
    "var PORT  = 9191;",
    "var RELAY_URL   = '" + relayBase + "';",
    "var AGENT_TOKEN = '" + agentToken + "';",
    "function printTCP(ip, port, buf) {",
    "  return new Promise(function(resolve, reject) {",
    "    var sock = new net.Socket();",
    "    sock.setTimeout(5000);",
    "    sock.connect(port, ip, function() {",
    "      sock.write(buf, function() {",
    "        setTimeout(function() { sock.destroy(); resolve(); }, 400);",
    "      });",
    "    });",
    "    sock.on('error', function(e) { sock.destroy(); reject(e); });",
    "    sock.on('timeout', function() { sock.destroy(); reject(new Error('Printer timeout')); });",
    "  });",
    "}",
    "function buildEscPos(data) {",
    "  var buf = [];",
    "  function txt(s) { var b=Buffer.from(String(s||''),'utf8'); for(var i=0;i<b.length;i++) buf.push(b[i]); }",
    "  function cmd() { for (var i=0;i<arguments.length;i++) buf.push(arguments[i]); }",
    "  function txtnl(s) { txt(s); cmd(0x0A); }",
    "  var pw = (data.paper_width_mm || 80) >= 80 ? 48 : 32;",
    "  function sep(c) { var s=''; for(var j=0;j<pw;j++) s+=c; return s; }",
    "  function rpad(s,n) { s=String(s||''); while(s.length<n) s+=' '; return s.slice(0,n); }",
    "  function lpad(s,n) { s=String(s||''); while(s.length<n) s=' '+s; return s.slice(-n); }",
    "  function ln2(a,b) { return rpad(String(a), pw-String(b).length)+String(b); }",
    "  cmd(0x1B,0x40);",
    "  cmd(0x1C,0x26);",
    "  if (data.type === 'bill') {",
    "    var CUR = data.currency || '$';",
    "    function fmtAmt(n) { n=parseFloat(n)||0; return CUR+(n===Math.round(n)?Math.round(n).toString():n.toFixed(2)); }",
    "    var NW=pw>=48?22:14, QW=pw>=48?4:3, PRW=pw>=48?10:7, TW=pw>=48?12:8;",
    "    function row4(a,b,c,d) { return rpad(a,NW)+lpad(b,QW)+lpad(c,PRW)+lpad(d,TW); }",
    "    var lbls = data.labels || {};",
    "    cmd(0x1B,0x61,0x01); cmd(0x1B,0x21,0x10);",
    "    txtnl(data.shop||'');",
    "    cmd(0x1B,0x21,0x00);",
    "    if (data.header) txtnl(data.header);",
    "    cmd(0x1B,0x61,0x00);",
    "    txtnl(sep('-'));",
    "    txtnl((data.order_type||'Dine-in')+'  Bill #'+(data.bill_id||''));",
    "    txtnl(rpad(data.table||'', pw-22)+(data.date||''));",
    "    if (data.note) { txtnl(sep('-')); txtnl('Note: '+data.note); }",
    "    txtnl(sep('='));",
    "    cmd(0x1B,0x45,0x01);",
    "    txtnl(row4(lbls.item||'Item', lbls.qty||'Qty', lbls.price||'Price', lbls.total_col||'Total'));",
    "    cmd(0x1B,0x45,0x00);",
    "    txtnl(sep('-'));",
    "    var items = data.items || [];",
    "    for (var ii=0; ii<items.length; ii++) {",
    "      var it=items[ii];",
    "      var upr=fmtAmt(parseFloat(it.price)||0);",
    "      var tot=fmtAmt((parseFloat(it.price)||0)*(parseInt(it.qty)||1));",
    "      var nm=String(it.name||'');",
    "      if (nm.length>NW) {",
    "        txtnl(row4(nm.slice(0,NW),'x'+it.qty,upr,tot));",
    "        var r=nm.slice(NW); while(r.length){txtnl(rpad(' '+r.slice(0,NW-1),NW));r=r.slice(NW-1);}",
    "      } else { txtnl(row4(nm,'x'+it.qty,upr,tot)); }",
    "      if (it.note) txtnl(' >> '+it.note);",
    "    }",
    "    txtnl(sep('='));",
    "    if (data.subtotal) txtnl(ln2(lbls.subtotal||'Sub Total', fmtAmt(data.subtotal)));",
    "    if (data.svcfee)   txtnl(ln2((lbls.svcfee||'Service')+' +', fmtAmt(data.svcfee)));",
    "    if (data.discount) txtnl(ln2((lbls.discount||'Discount')+' -', fmtAmt(data.discount)));",
    "    cmd(0x1B,0x45,0x01);",
    "    txtnl(ln2(lbls.total||'Net Total', fmtAmt(data.total)));",
    "    cmd(0x1B,0x45,0x00);",
    "    if (data.iqd_total) txtnl(ln2('IQD', String(data.iqd_total)));",
    "    txtnl(sep('-'));",
    "    cmd(0x1B,0x61,0x01);",
    "    if (lbls.cashier) txtnl((lbls.served_by||'Served by')+': '+lbls.cashier);",
    "    txtnl(data.footer||lbls.thanks||'Thank you!');",
    "  } else if (data.type === 'order') {",
    "    cmd(0x1B,0x61,0x01); cmd(0x1B,0x21,0x30);",
    "    txtnl(data.table||'Takeaway');",
    "    cmd(0x1B,0x21,0x00); cmd(0x1B,0x61,0x00);",
    "    var t=new Date(); var hh=t.getHours()%12||12; var mm=String(t.getMinutes()).padStart(2,'0'); var ap=t.getHours()>=12?'PM':'AM';",
    "    txtnl('Order #'+(data.order_id||'')+'   '+hh+':'+mm+' '+ap);",
    "    if (data.order_type) txtnl(data.order_type);",
    "    if (data.note) txtnl('Note: '+data.note);",
    "    txtnl(sep('-'));",
    "    var items=data.items||[];",
    "    for (var ii=0;ii<items.length;ii++) {",
    "      var it=items[ii];",
    "      cmd(0x1B,0x45,0x01);",
    "      txtnl('x'+it.qty+'  '+it.name);",
    "      cmd(0x1B,0x45,0x00);",
    "      if (it.note) txtnl('   >> '+it.note);",
    "    }",
    "    txtnl(sep('='));",
    "  }",
    "  cmd(0x1B,0x64,0x06);",
    "  cmd(0x1D,0x56,0x01);",
    "  return Buffer.from(buf);",
    "}",
    "http.createServer(function(req, res) {",
    "  res.setHeader('Access-Control-Allow-Origin','*');",
    "  res.setHeader('Access-Control-Allow-Methods','POST,GET,OPTIONS');",
    "  res.setHeader('Access-Control-Allow-Headers','Content-Type');",
    "  if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return; }",
    "  if (req.method==='GET' && req.url==='/ping') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,version:'2.1'})); return; }",
    "  if (req.method==='POST' && req.url==='/print') {",
    "    var body='';",
    "    req.on('data',function(d){ body+=d.toString(); });",
    "    req.on('end',function() {",
    "      var data; try { data=JSON.parse(body); } catch(e) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Invalid JSON'})); return; }",
    "      var ip=data.printer_ip; var port=parseInt(data.printer_port)||9100;",
    "      if (!ip) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'printer_ip required'})); return; }",
    "      var buf; try { buf=buildEscPos(data); } catch(e) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Build error: '+e.message})); return; }",
    "      printTCP(ip,port,buf).then(function(){ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); }).catch(function(e){ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); });",
    "    });",
    "    return;",
    "  }",
    "  res.writeHead(404); res.end();",
    "}).listen(PORT,'0.0.0.0',function(){",
    "  var os=require('os'); var ips=[];",
    "  Object.values(os.networkInterfaces()).forEach(function(a){a.forEach(function(i){if(i.family==='IPv4'&&!i.internal)ips.push(i.address);});});",
    "  console.log('POS Print Agent v2.1');",
    "  console.log('  Local:   http://127.0.0.1:'+PORT);",
    "  ips.forEach(function(ip){ console.log('  Network: http://'+ip+':'+PORT); });",
    "  if (RELAY_URL) console.log('  Relay:   '+RELAY_URL+' (iPad/cloud printing active)');",
    "});",
    "function relayPoll() {",
    "  if (!RELAY_URL || !AGENT_TOKEN) return;",
    "  var parsed = url.parse(RELAY_URL+'/pos/agent/poll?token='+AGENT_TOKEN);",
    "  var mod = parsed.protocol==='https:'?https:http;",
    "  mod.get({host:parsed.hostname,port:parsed.port,path:parsed.path,headers:{'User-Agent':'POSAgent/2.1'}},function(res){",
    "    var body=''; res.on('data',function(d){body+=d;}); res.on('end',function(){",
    "      try {",
    "        var r=JSON.parse(body);",
    "        (r.jobs||[]).forEach(function(job){",
    "          var p=typeof job.payload==='string'?JSON.parse(job.payload):job.payload;",
    "          if(!p.printer_ip) return;",
    "          var buf; try{buf=buildEscPos(p);}catch(e){return;}",
    "          printTCP(p.printer_ip,parseInt(p.printer_port)||9100,buf).then(function(){",
    "            var ap=url.parse(RELAY_URL+'/pos/agent/ack/'+job.id+'?token='+AGENT_TOKEN);",
    "            var m2=ap.protocol==='https:'?https:http;",
    "            var aq=m2.request({host:ap.hostname,port:ap.port,path:ap.path,method:'POST',headers:{'Content-Length':0}},function(){});",
    "            aq.on('error',function(){}); aq.end();",
    "          }).catch(function(){});",
    "        });",
    "      } catch(e){}",
    "    });",
    "  }).on('error',function(){});",
    "}",
    "setInterval(relayPoll, 2000);",
  ];
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pos-print-agent.js"');
  res.send(agentLines.join('\n'));
});

// ── Print Agent setup BAT download ────────────────────────────────────────────
router.get('/print-agent-bat', requireAuth, requirePOS, (req, res) => {
  const bat = [
    '@echo off',
    'title POS Print Agent Setup',
    'echo.',
    'echo  POS Print Agent Setup',
    'echo  =====================',
    'echo.',
    'echo [1/3] Checking Node.js...',
    'where node >nul 2>&1',
    'if %errorlevel% neq 0 (',
    '  echo  Node.js not found. Opening download page...',
    '  start https://nodejs.org/en/download/',
    '  echo  Install Node.js then run this file again.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo  OK',
    'echo [2/3] Installing agent...',
    'set AGENT_DIR=%APPDATA%\\POSPrintAgent',
    'if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%"',
    'copy /y "%~dp0pos-print-agent.js" "%AGENT_DIR%\\pos-print-agent.js" >nul',
    'if %errorlevel% neq 0 (',
    '  echo  ERROR: pos-print-agent.js must be in the same folder as this file.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo  Done',
    'echo [3/3] Setting up auto-start with Windows...',
    'set STARTUP=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
    '(',
    '  echo @echo off',
    '  echo start "" /b node "%AGENT_DIR%\\pos-print-agent.js"',
    ') > "%STARTUP%\\POSPrintAgent.bat"',
    'for /f "tokens=5" %%a in (\'netstat -aon ^| find ":9191 "\') do taskkill /f /pid %%a >nul 2>&1',
    'timeout /t 1 /nobreak >nul',
    'start "" /b node "%AGENT_DIR%\\pos-print-agent.js"',
    'timeout /t 2 /nobreak >nul',
    'echo  Done - agent is running!',
    'echo.',
    'echo  Setup complete! Agent will auto-start every time Windows starts.',
    'echo  Go to POS Settings and click Test Connection to verify.',
    'echo.',
    'pause',
  ].join('\r\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="setup-agent.bat"');
  res.send(bat);
});

// ── Print Agent EXE download ──────────────────────────────────────────────────
router.get('/print-agent-exe', (req, res) => {
  const exePath = require('path').join(__dirname, '..', 'public', 'downloads', 'pos-print-agent.exe');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="pos-print-agent.exe"');
  res.sendFile(exePath);
});

// ── Print Agent install BAT (embeds relay URL + token, runs the exe) ──────────
router.get('/print-agent-install-bat', requireAuth, requirePOS, async (req, res) => {
  let agentToken = req.tenant?.pos_agent_token;
  if (!agentToken) {
    agentToken = require('crypto').randomBytes(32).toString('hex');
    await db.query('UPDATE tenants SET pos_agent_token=$1 WHERE id=$2', [agentToken, req.user.tenantId]);
  }
  const relayUrl = req.protocol + '://' + req.get('host');
  const bat = [
    '@echo off',
    'title POS Print Agent Setup',
    'echo.',
    'echo  Installing POS Print Agent...',
    'echo.',
    'set EXE=%~dp0pos-print-agent.exe',
    'if not exist "%EXE%" (',
    '  echo  ERROR: pos-print-agent.exe must be in the same folder as this file.',
    '  pause & exit /b 1',
    ')',
    '"%EXE%" --install --url=' + relayUrl + ' --token=' + agentToken,
    'if %errorlevel% neq 0 (',
    '  echo.',
    '  echo  If you see a permissions error, right-click this file and Run as Administrator.',
    '  pause & exit /b 1',
    ')',
    'echo.',
    'echo  Done! You can delete these two files now.',
    'echo  The agent runs silently in the background and starts automatically with Windows.',
    'echo.',
    'pause',
  ].join('\r\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="install-agent.bat"');
  res.send(bat);
});

// ── Print Agent ping ───────────────────────────────────────────────────────────
router.get('/print-agent-ping', requireAuth, requirePOS, async (req, res) => {
  const port = (req.query.port || '9191').replace(/\D/g, '');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    res.json(j);
  } catch(e) {
    res.json({ ok: false, error: 'not_running' });
  }
});

// ── Floor Plan Editor ─────────────────────────────────────────────────────────
router.get('/floor-plan', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const tables = await db.query(
      'SELECT * FROM restaurant_tables WHERE tenant_id=$1 ORDER BY sort_order, name',
      [req.user.tenantId]
    );
    res.render('pos/floor-plan', { tenant, tables: tables.rows, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/floor-plan/save', requireAuth, requirePOS, async (req, res) => {
  try {
    const tables = req.body.tables;
    if (!Array.isArray(tables)) return res.json({ ok: false });
    await Promise.all(tables.map(t =>
      db.query(
        'UPDATE restaurant_tables SET floor_x=$1, floor_y=$2, floor_shape=$3, floor_w=$4, floor_h=$5 WHERE id=$6 AND tenant_id=$7',
        [parseInt(t.x), parseInt(t.y), t.shape || 'square', parseInt(t.w) || 80, parseInt(t.h) || 80, parseInt(t.id), req.user.tenantId]
      )
    ));
    res.json({ ok: true });
  } catch (err) { console.error(err); res.json({ ok: false }); }
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

router.post('/settings/service-fee', requireAuth, requirePOS, async (req, res) => {
  try {
    const enabled = req.body.pos_service_fee_enabled === '1';
    const pct     = Math.max(0, Math.min(100, parseFloat(req.body.pos_service_fee_pct) || 0));
    await db.query(
      'UPDATE tenants SET pos_service_fee_enabled=$1, pos_service_fee_pct=$2 WHERE id=$3',
      [enabled, pct, req.user.tenantId]
    );
    res.redirect('/pos/settings?tab=fees');
  } catch (err) { console.error(err); res.redirect('/pos/settings?tab=fees'); }
});

router.post('/settings/perm-passcode', requireAuth, requirePOS, async (req, res) => {
  try {
    const voidCode     = (req.body.perm_void_code     || '').trim().slice(0, 20) || null;
    const discountCode = (req.body.perm_discount_code || '').trim().slice(0, 20) || null;
    await db.query(
      'UPDATE tenants SET pos_perm_void_code=$1, pos_perm_discount_code=$2 WHERE id=$3',
      [voidCode, discountCode, req.user.tenantId]
    );
    res.redirect('/pos/settings?tab=permissions');
  } catch (err) { console.error(err); res.redirect('/pos/settings?tab=permissions'); }
});

router.post('/settings/bill', requireAuth, requirePOS, async (req, res) => {
  try {
    const { bill_language, bill_show_iqd, bill_font_size, bill_paper_width, bill_custom_header, bill_custom_footer,
            pos_print_agent_port, pos_print_agent_printer, pos_print_agent_lan_ip } = req.body;
    // Collect individual label overrides
    const LABEL_KEYS = ['item','qty','price','total_col','subtotal','svcfee','discount','total','served_by','dine_in','takeaway','thanks','table','bill'];
    const labels = {};
    LABEL_KEYS.forEach(k => { const v = (req.body['lbl_' + k] || '').trim(); if (v) labels[k] = v; });
    const labelsJson = Object.keys(labels).length ? JSON.stringify(labels) : null;
    const agentPort   = (pos_print_agent_port   || '').trim().replace(/\D/g,'') || null;
    const agentPrinter = (pos_print_agent_printer || '').trim() || null;
    const agentLanIp  = (pos_print_agent_lan_ip  || '').trim() || null;
    await db.query(
      `UPDATE tenants SET bill_language=$1, bill_show_iqd=$2, bill_font_size=$3, bill_paper_width=$4, bill_custom_header=$5, bill_custom_footer=$6, bill_custom_labels=$7,
       pos_print_agent_port=$8, pos_print_agent_printer=$9, pos_print_agent_lan_ip=$10 WHERE id=$11`,
      [bill_language || 'en', bill_show_iqd === '1', bill_font_size || 'normal', bill_paper_width || '80mm',
       bill_custom_header || null, bill_custom_footer || null, labelsJson, agentPort, agentPrinter, agentLanIp, req.user.tenantId]
    );
    res.redirect('/pos/settings?tab=bill');
  } catch (err) { console.error(err); res.redirect('/pos/settings?tab=bill'); }
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

router.post('/settings/kitchen-stations', requireAuth, requirePOS, async (req, res) => {
  try {
    const assignments = req.body.station || {};
    for (const [catId, station] of Object.entries(assignments)) {
      await db.query(
        'UPDATE categories SET kitchen_station=$1 WHERE id=$2 AND tenant_id=$3',
        [station?.trim() || 'main', parseInt(catId), req.user.tenantId]
      );
    }
    res.redirect('/pos/settings?tab=printers&success=stations');
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

// POST /pos/api/order/:id/service-fee  — toggle service fee on/off for this order
router.post('/api/order/:id/service-fee', requireAuth, requirePOS, async (req, res) => {
  try {
    await db.query(
      'UPDATE pos_orders SET apply_service_fee = NOT apply_service_fee WHERE id=$1 AND tenant_id=$2',
      [req.params.id, req.user.tenantId]
    );
    const state = await orderStateJSON(req.params.id, req.user.tenantId);
    if (!state) return res.json({ ok: false });
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
      // Increment quantity and unfire so the updated total can be re-fired to kitchen
      await db.query('UPDATE pos_order_items SET quantity=quantity+1, sent_to_kitchen=false WHERE id=$1', [existing.rows[0].id]);
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
    const fired  = item.rows[0].sent_to_kitchen;
    // Block decreasing a fired item's quantity (partial reduction not allowed)
    if (delta < 0 && fired && newQty > 0) {
      return res.json({ ok: false, error: 'cannot_decrease_fired' });
    }
    if (newQty <= 0) {
      // All item removals require a manager passkey
      const pk = await validatePasskey(req.user.tenantId, req.body.passkey, 'void');
      if (!pk) return res.json({ ok: false, error: 'invalid_passkey', requires_comp: true });
      if (!pk.permanent) await db.query('UPDATE pos_passkeys SET used=true, used_by=$1, order_id=$2, used_at=NOW() WHERE id=$3',
        [req.user.userId, req.params.id, pk.id]);
      await db.query('DELETE FROM pos_order_items WHERE id=$1', [req.params.itemId]);
      const logAction_ = fired ? 'item_comp' : 'item_remove';
      await logAction(req.user.tenantId, item.rows[0].session_id, req.params.id, req.user.userId, logAction_,
        { name: item.rows[0].name, reason: req.body.comp_reason || 'No reason given', price: item.rows[0].price });
    } else {
      // Increasing qty on a fired item unsets the fired flag so it can be re-fired
      if (delta > 0 && fired) {
        await db.query('UPDATE pos_order_items SET quantity=$1, sent_to_kitchen=false WHERE id=$2', [newQty, req.params.itemId]);
      } else {
        await db.query('UPDATE pos_order_items SET quantity=$1 WHERE id=$2', [newQty, req.params.itemId]);
      }
      await logAction(req.user.tenantId, item.rows[0].session_id, req.params.id, req.user.userId, 'item_qty', { name: item.rows[0].name, from: oldQty, to: newQty });
    }
    const state = await orderStateJSON(req.params.id, req.user.tenantId);
    res.json({ ok: true, ...state });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

// POST /pos/api/order/:id/item/:itemId/price
router.post('/api/order/:id/item/:itemId/price', requireAuth, requirePOS, async (req, res) => {
  const price = parseFloat(req.body.price);
  try {
    if (isNaN(price) || price < 0) return res.json({ ok: false, error: 'invalid_price' });
    // Price override always requires a manager passkey
    const pk = await validatePasskey(req.user.tenantId, req.body.passkey, 'discount');
    if (!pk) return res.json({ ok: false, error: 'invalid_passkey' });
    if (!pk.permanent) await db.query('UPDATE pos_passkeys SET used=true, used_by=$1, order_id=$2, used_at=NOW() WHERE id=$3',
      [req.user.userId, req.params.id, pk.id]);
    const check = await db.query(
      'SELECT poi.id, poi.name, poi.price AS old_price, po.session_id FROM pos_order_items poi JOIN pos_orders po ON po.id=poi.order_id WHERE poi.id=$1 AND po.id=$2 AND po.tenant_id=$3',
      [req.params.itemId, req.params.id, req.user.tenantId]
    );
    if (!check.rows[0]) return res.json({ ok: false, error: 'Not found' });
    await db.query('UPDATE pos_order_items SET price=$1 WHERE id=$2', [price, req.params.itemId]);
    await logAction(req.user.tenantId, check.rows[0].session_id, req.params.id, req.user.userId, 'price_override',
      { name: check.rows[0].name, from: parseFloat(check.rows[0].old_price), to: price });
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
      if (!pk.permanent) await db.query('UPDATE pos_passkeys SET used=true, used_by=$1, order_id=$2, used_at=NOW() WHERE id=$3',
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
    if (!pk.permanent) await db.query('UPDATE pos_passkeys SET used=true, used_by=$1, order_id=$2, used_at=NOW() WHERE id=$3',
      [req.user.userId, req.params.id, pk.id]);
    await logAction(req.user.tenantId, vr.rows[0]?.session_id, req.params.id, req.user.userId, 'order_void', { table_name: vr.rows[0]?.table_name });
    res.json({ ok: true, redirect: '/pos/tables' });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

// ── POS Pro: cover count ─────────────────────────────────────────────────────
router.post('/api/order/:id/cover', requireAuth, requirePOS, async (req, res) => {
  const covers = Math.max(1, parseInt(req.body.cover_count) || 1);
  try {
    await db.query('UPDATE pos_orders SET cover_count=$1 WHERE id=$2 AND tenant_id=$3', [covers, req.params.id, req.user.tenantId]);
    const state = await orderStateJSON(req.params.id, req.user.tenantId);
    res.json({ ok: true, ...state });
  } catch (err) { res.json({ ok: false }); }
});

// ── POS Pro: fire items to kitchen ────────────────────────────────────────────
router.post('/api/order/:id/fire', requireAuth, requirePOS, async (req, res) => {
  try {
    const unfiredRes = await db.query(
      'SELECT COUNT(*) AS cnt FROM pos_order_items WHERE order_id=$1 AND sent_to_kitchen=false', [req.params.id]
    );
    if (parseInt(unfiredRes.rows[0].cnt) === 0) return res.json({ ok: false, error: 'nothing_to_fire' });
    await db.query('UPDATE pos_order_items SET sent_to_kitchen=true WHERE order_id=$1 AND sent_to_kitchen=false', [req.params.id]);
    await db.query('UPDATE pos_orders SET kitchen_sent_at=NOW() WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    const sRow = await db.query('SELECT session_id FROM pos_orders WHERE id=$1', [req.params.id]);
    await logAction(req.user.tenantId, sRow.rows[0]?.session_id, req.params.id, req.user.userId, 'fire_kitchen', {});
    const state = await orderStateJSON(req.params.id, req.user.tenantId);
    res.json({ ok: true, ...state });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

// ── POS Pro: hold / unhold order ──────────────────────────────────────────────
router.post('/api/order/:id/hold', requireAuth, requirePOS, async (req, res) => {
  try {
    const r = await db.query(
      'UPDATE pos_orders SET is_held = NOT COALESCE(is_held,false) WHERE id=$1 AND tenant_id=$2 RETURNING is_held',
      [req.params.id, req.user.tenantId]
    );
    const state = await orderStateJSON(req.params.id, req.user.tenantId);
    res.json({ ok: true, is_held: r.rows[0]?.is_held, ...state });
  } catch (err) { res.json({ ok: false }); }
});

// ── POS Pro: transfer table ────────────────────────────────────────────────────
router.post('/order/:id/transfer', requireAuth, requirePOS, async (req, res) => {
  const { target_table_id } = req.body;
  const back = '/pos/order/' + req.params.id;
  try {
    const tableRes = await db.query('SELECT * FROM restaurant_tables WHERE id=$1 AND tenant_id=$2', [target_table_id, req.user.tenantId]);
    if (!tableRes.rows[0]) return res.redirect(back + '?error=no_table');
    const existing = await db.query(
      "SELECT id FROM pos_orders WHERE table_id=$1 AND status='open' AND id!=$2",
      [target_table_id, req.params.id]
    );
    if (existing.rows[0]) return res.redirect(back + '?error=table_occupied');
    await db.query(
      'UPDATE pos_orders SET table_id=$1, table_name=$2 WHERE id=$3 AND tenant_id=$4',
      [target_table_id, tableRes.rows[0].name, req.params.id, req.user.tenantId]
    );
    const sRow = await db.query('SELECT session_id FROM pos_orders WHERE id=$1', [req.params.id]);
    await logAction(req.user.tenantId, sRow.rows[0]?.session_id, req.params.id, req.user.userId, 'table_transfer', { to_table: tableRes.rows[0].name });
    res.redirect(back);
  } catch (err) { console.error(err); res.redirect(back); }
});

// ── POS Pro: merge order into another ─────────────────────────────────────────
router.post('/order/:id/merge', requireAuth, requirePOS, async (req, res) => {
  const { target_order_id } = req.body;
  const back = '/pos/order/' + req.params.id;
  try {
    const targetRes = await db.query(
      "SELECT * FROM pos_orders WHERE id=$1 AND tenant_id=$2 AND status='open'",
      [target_order_id, req.user.tenantId]
    );
    if (!targetRes.rows[0]) return res.redirect(back + '?error=no_target');
    await db.query('UPDATE pos_order_items SET order_id=$1 WHERE order_id=$2', [target_order_id, req.params.id]);
    await db.query("UPDATE pos_orders SET status='void' WHERE id=$1 AND tenant_id=$2", [req.params.id, req.user.tenantId]);
    const sRow = await db.query('SELECT session_id FROM pos_orders WHERE id=$1', [target_order_id]);
    await logAction(req.user.tenantId, sRow.rows[0]?.session_id, target_order_id, req.user.userId, 'order_merge', { from_order: parseInt(req.params.id) });
    res.redirect('/pos/order/' + target_order_id);
  } catch (err) { console.error(err); res.redirect(back); }
});

// ── POS Pro: toggle menu item out-of-stock ────────────────────────────────────
router.post('/api/menu/:id/toggle-stock', requireAuth, requirePOS, async (req, res) => {
  try {
    const r = await db.query(
      'UPDATE menu_items SET is_out_of_stock = NOT COALESCE(is_out_of_stock,false) WHERE id=$1 AND tenant_id=$2 RETURNING is_out_of_stock',
      [req.params.id, req.user.tenantId]
    );
    res.json({ ok: true, is_out_of_stock: r.rows[0]?.is_out_of_stock });
  } catch (err) { res.json({ ok: false }); }
});

// ── POS Pro: update item course ───────────────────────────────────────────────
router.post('/api/order/:id/item/:itemId/course', requireAuth, requirePOS, async (req, res) => {
  try {
    const valid = ['starter', 'main', 'dessert', 'drink'];
    const course = valid.includes(req.body.course) ? req.body.course : 'main';
    await db.query(
      'UPDATE pos_order_items SET course=$1 WHERE id=$2 AND order_id=$3',
      [course, req.params.itemId, req.params.id]
    );
    const state = await orderStateJSON(req.params.id, req.user.tenantId);
    res.json({ ok: true, ...state });
  } catch (err) { res.json({ ok: false }); }
});

// ── POS Pro: no-sale log (open cash drawer) ───────────────────────────────────
router.post('/api/no-sale', requireAuth, requirePOS, requireSession, async (req, res) => {
  try {
    const reason = (req.body.reason || '').trim() || 'No reason given';
    await db.query(
      'INSERT INTO pos_no_sale_log (tenant_id, session_id, user_id, reason) VALUES ($1,$2,$3,$4)',
      [req.user.tenantId, req.posSession.id, req.user.userId, reason]
    );
    await logAction(req.user.tenantId, req.posSession.id, null, req.user.userId, 'no_sale', { reason });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

// ── POS Pro: mark kitchen done (prep time) ────────────────────────────────────
router.post('/api/order/:id/kitchen-done', requireAuth, requirePOS, async (req, res) => {
  try {
    await db.query(
      'UPDATE pos_orders SET kitchen_done_at=NOW() WHERE id=$1 AND tenant_id=$2',
      [req.params.id, req.user.tenantId]
    );
    const sRow = await db.query('SELECT session_id FROM pos_orders WHERE id=$1', [req.params.id]);
    await logAction(req.user.tenantId, sRow.rows[0]?.session_id, req.params.id, req.user.userId, 'kitchen_done', {});
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

// ── POS: loyalty lookup at payment ────────────────────────────────────────────
router.get('/api/loyalty/customer/:customerId', requireAuth, requirePOS, async (req, res) => {
  try {
    const [custRes, progRes] = await Promise.all([
      db.query('SELECT id, name, loyalty_points FROM customers WHERE id=$1 AND tenant_id=$2', [req.params.customerId, req.user.tenantId]),
      db.query("SELECT * FROM loyalty_programs WHERE tenant_id=$1 AND is_active=true LIMIT 1", [req.user.tenantId]),
    ]);
    if (!custRes.rows[0]) return res.json({ ok: false });
    res.json({ ok: true, customer: custRes.rows[0], program: progRes.rows[0] || null });
  } catch (err) { res.json({ ok: false }); }
});

// ── POS: process payment with loyalty points ──────────────────────────────────
// (extended version – loyalty redeem handled inline in existing pay route via redeem_points field)

// ── Customers ─────────────────────────────────────────────────────────────────
router.get('/customers', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    const customers = await db.query(
      `SELECT c.*, COUNT(po.id) AS order_count
       FROM customers c
       LEFT JOIN pos_orders po ON po.customer_id=c.id AND po.status='paid'
       WHERE c.tenant_id=$1
       GROUP BY c.id ORDER BY c.name`,
      [req.user.tenantId]
    );
    res.render('pos/customers', { tenant, customers: customers.rows, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/customers', requireAuth, requirePOS, async (req, res) => {
  const { name, phone, email, notes } = req.body;
  try {
    await db.query(
      'INSERT INTO customers (tenant_id, name, phone, email, notes) VALUES ($1,$2,$3,$4,$5)',
      [req.user.tenantId, name.trim(), phone?.trim() || null, email?.trim() || null, notes?.trim() || null]
    );
    res.redirect('/pos/customers?success=1');
  } catch (err) { console.error(err); res.redirect('/pos/customers?error=' + encodeURIComponent(err.message)); }
});

router.post('/customers/:id/edit', requireAuth, requirePOS, async (req, res) => {
  const { name, phone, email, notes } = req.body;
  try {
    await db.query(
      'UPDATE customers SET name=$1, phone=$2, email=$3, notes=$4 WHERE id=$5 AND tenant_id=$6',
      [name.trim(), phone?.trim() || null, email?.trim() || null, notes?.trim() || null, req.params.id, req.user.tenantId]
    );
    res.redirect('/pos/customers?success=1');
  } catch (err) { console.error(err); res.redirect('/pos/customers?error=' + encodeURIComponent(err.message)); }
});

router.post('/customers/:id/delete', requireAuth, requirePOS, async (req, res) => {
  try {
    await db.query('DELETE FROM customers WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    res.redirect('/pos/customers');
  } catch (err) { console.error(err); res.redirect('/pos/customers'); }
});

module.exports = router;
