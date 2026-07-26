const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAuth = require('../middleware/auth');

async function requirePOS(req, res, next) {
  const r = await db.query('SELECT feat_pos FROM tenants WHERE id=$1', [req.user.tenantId]);
  if (!r.rows[0]?.feat_pos) return res.status(403).send('<h2 style="font-family:sans-serif;padding:40px">POS not enabled.</h2>');
  if (req.user.role === 'admin') return next();
  if ((req.user.permissions || []).includes('access_pos')) return next();
  res.status(403).send('<h2 style="font-family:sans-serif;padding:40px">Access denied.</h2>');
}

// ── Historical Z-Reports ──────────────────────────────────────────────────────
router.get('/', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = (await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId])).rows[0];
    const sessionsRes = await db.query(
      `SELECT ps.*, u.name AS opened_by_name,
        COUNT(DISTINCT po.id) FILTER (WHERE po.status='paid') AS paid_orders,
        COUNT(DISTINCT po.id) FILTER (WHERE po.status='void')  AS void_orders,
        COALESCE(SUM(po.total) FILTER (WHERE po.status='paid'), 0)   AS total_sales,
        COALESCE(SUM(pp.amount_paid_iqd) FILTER (WHERE pp.method='cash'), 0) AS cash_iqd
       FROM pos_sessions ps
       LEFT JOIN users u ON u.id = ps.opened_by
       LEFT JOIN pos_orders po ON po.session_id = ps.id
       LEFT JOIN pos_payments pp ON pp.order_id = po.id
       WHERE ps.tenant_id=$1
       GROUP BY ps.id, u.name ORDER BY ps.opened_at DESC`,
      [req.user.tenantId]
    );
    res.render('pos/reports', { tenant, sessions: sessionsRes.rows, currentUser: req.user, view: 'list' });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Z-Report for a specific session ──────────────────────────────────────────
router.get('/session/:id', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = (await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId])).rows[0];
    const sessionRes = await db.query(
      `SELECT ps.*, u.name AS opened_by_name FROM pos_sessions ps
       LEFT JOIN users u ON u.id = ps.opened_by
       WHERE ps.id=$1 AND ps.tenant_id=$2`,
      [req.params.id, req.user.tenantId]
    );
    if (!sessionRes.rows[0]) return res.redirect('/pos/reports');
    const session = sessionRes.rows[0];

    const [paidOrdersRes, topItemsRes, zStatsRes, voidRes, cashierRes, compRes, hourlyRes, noSaleRes] = await Promise.all([
      db.query(
        `SELECT po.*, COALESCE(pp.method,'—') AS pay_method
         FROM pos_orders po LEFT JOIN pos_payments pp ON pp.order_id=po.id
         WHERE po.session_id=$1 AND po.status='paid' ORDER BY po.paid_at`,
        [session.id]
      ),
      db.query(
        `SELECT poi.name, SUM(poi.quantity) AS qty, SUM(poi.price*poi.quantity) AS revenue
         FROM pos_order_items poi JOIN pos_orders po ON po.id=poi.order_id
         WHERE po.session_id=$1 AND po.status='paid'
         GROUP BY poi.name ORDER BY revenue DESC LIMIT 10`,
        [session.id]
      ),
      db.query(
        `SELECT
           COALESCE(SUM(tip_amount),0)    AS total_tips,
           COALESCE(SUM(cover_count),0)   AS total_covers,
           COALESCE(SUM(service_fee),0)   AS total_service_fees,
           COUNT(*) FILTER (WHERE discount_type!='none') AS discount_orders,
           COALESCE(SUM(CASE WHEN discount_type='fixed' THEN discount_value
                             WHEN discount_type='percent' THEN total*discount_value/(100-discount_value)
                             ELSE 0 END),0) AS total_discounts
         FROM pos_orders WHERE session_id=$1 AND status='paid'`,
        [session.id]
      ),
      db.query('SELECT COUNT(*) AS cnt FROM pos_orders WHERE session_id=$1 AND status=$2', [session.id, 'void']),
      db.query(
        `SELECT u.name AS cashier_name, po.created_by,
           COUNT(po.id)::int AS order_count,
           COALESCE(SUM(po.total),0) AS total_sales,
           COALESCE(SUM(po.tip_amount),0) AS tip_total,
           COUNT(*) FILTER (WHERE po.discount_type!='none')::int AS discounts_given,
           COALESCE(SUM(CASE WHEN po.discount_type='fixed' THEN po.discount_value
                             WHEN po.discount_type='percent' THEN po.total*po.discount_value/(100-po.discount_value)
                             ELSE 0 END),0) AS total_discounts
         FROM pos_orders po LEFT JOIN users u ON u.id=po.created_by
         WHERE po.session_id=$1 AND po.status='paid'
         GROUP BY po.created_by, u.name ORDER BY total_sales DESC`,
        [session.id]
      ),
      db.query(
        `SELECT u.name AS cashier_name, pal.details->>'name' AS item_name, pal.details->>'reason' AS reason, pal.created_at
         FROM pos_activity_log pal LEFT JOIN users u ON u.id=pal.user_id
         WHERE pal.session_id=$1 AND pal.action='item_comp' ORDER BY pal.created_at DESC LIMIT 30`,
        [session.id]
      ),
      db.query(
        `SELECT EXTRACT(HOUR FROM po.paid_at) AS hour, COUNT(*) AS cnt, COALESCE(SUM(po.total),0) AS revenue
         FROM pos_orders po WHERE po.session_id=$1 AND po.status='paid'
         GROUP BY hour ORDER BY hour`,
        [session.id]
      ),
      db.query(
        `SELECT nsl.*, u.name AS user_name FROM pos_no_sale_log nsl
         LEFT JOIN users u ON u.id=nsl.user_id
         WHERE nsl.session_id=$1 ORDER BY nsl.created_at`,
        [session.id]
      ),
    ]);

    const orders = paidOrdersRes.rows;
    const summary = orders.reduce((s, o) => {
      const tot = parseFloat(o.total) || 0;
      s.total += tot; s.count++;
      if (o.pay_method === 'cash') s.cash += tot; else s.card += tot;
      return s;
    }, { total: 0, cash: 0, card: 0, count: 0 });
    const cashIQDRes = await db.query(
      `SELECT COALESCE(SUM(pp.amount_paid_iqd),0) AS cash_iqd
       FROM pos_payments pp JOIN pos_orders po ON po.id=pp.order_id
       WHERE po.session_id=$1 AND pp.method='cash'`,
      [session.id]
    );
    summary.cashIQD = parseFloat(cashIQDRes.rows[0].cash_iqd) || 0;
    const zStats = zStatsRes.rows[0] || {};

    res.render('pos/reports', {
      tenant, session, currentUser: req.user, view: 'detail',
      summary: { ...summary, tips: parseFloat(zStats.total_tips)||0, covers: parseInt(zStats.total_covers)||0 },
      topItems: topItemsRes.rows,
      zStats: { ...zStats, voids: parseInt(voidRes.rows[0]?.cnt)||0 },
      cashierStats: cashierRes.rows,
      compLog: compRes.rows,
      hourly: hourlyRes.rows,
      noSaleLog: noSaleRes.rows,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Void & Discount Audit ──────────────────────────────────────────────────────
router.get('/audit', requireAuth, requirePOS, async (req, res) => {
  try {
    const tenant = (await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId])).rows[0];
    const { from, to, user_id } = req.query;
    const fromDate = from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const toDate   = to   || new Date().toISOString().slice(0, 10);
    const usersRes = await db.query('SELECT id, name, email FROM users WHERE tenant_id=$1 ORDER BY name', [req.user.tenantId]);
    let q = `
      SELECT pal.*, u.name AS user_name, po.table_name
      FROM pos_activity_log pal
      LEFT JOIN users u ON u.id = pal.user_id
      LEFT JOIN pos_orders po ON po.id = pal.order_id
      WHERE pal.tenant_id=$1
        AND pal.action IN ('item_comp','price_override','discount_apply','order_void','no_sale')
        AND DATE(pal.created_at) BETWEEN $2 AND $3`;
    const params = [req.user.tenantId, fromDate, toDate];
    if (user_id) { q += ` AND pal.user_id=$${params.length + 1}`; params.push(user_id); }
    q += ' ORDER BY pal.created_at DESC LIMIT 200';
    const logsRes = await db.query(q, params);
    res.render('pos/audit', { tenant, logs: logsRes.rows, users: usersRes.rows, fromDate, toDate, filterUser: user_id || '', currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

module.exports = router;
