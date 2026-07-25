const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAuth = require('../middleware/auth');

async function requireReports(req, res, next) {
  try {
    const r = await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId]);
    const tenant = r.rows[0];
    if (!tenant) return res.status(404).send('Tenant not found');
    if (!tenant.feat_reports) return res.status(403).send('Reports module not enabled.');
    req.tenant = tenant;
    next();
  } catch (err) { res.status(500).send('Server error'); }
}

router.get('/', requireAuth, requireReports, async (req, res) => {
  const tid = req.user.tenantId;
  const { from, to } = req.query;
  const start = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
  const end   = to   || new Date().toISOString().slice(0,10);

  try {
    const [revRes, topItemsRes, topCatRes, hourlyRes, cogRes, expRes, dailyRes] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS orders
                FROM pos_orders WHERE tenant_id=$1 AND status='paid'
                AND DATE(paid_at) BETWEEN $2 AND $3`, [tid, start, end]),
      db.query(`SELECT poi.name, SUM(poi.quantity) AS qty, SUM(poi.price*poi.quantity) AS revenue
                FROM pos_order_items poi
                JOIN pos_orders po ON po.id=poi.order_id
                WHERE po.tenant_id=$1 AND po.status='paid' AND DATE(po.paid_at) BETWEEN $2 AND $3
                GROUP BY poi.name ORDER BY revenue DESC LIMIT 10`, [tid, start, end]),
      db.query(`SELECT c.name AS category, SUM(poi.price*poi.quantity) AS revenue
                FROM pos_order_items poi
                JOIN pos_orders po ON po.id=poi.order_id
                JOIN menu_items mi ON mi.id=poi.menu_item_id
                JOIN categories c ON c.id=mi.category_id
                WHERE po.tenant_id=$1 AND po.status='paid' AND DATE(po.paid_at) BETWEEN $2 AND $3
                GROUP BY c.name ORDER BY revenue DESC LIMIT 10`, [tid, start, end]),
      db.query(`SELECT EXTRACT(HOUR FROM paid_at)::int AS hour, SUM(total) AS revenue, COUNT(*) AS orders
                FROM pos_orders WHERE tenant_id=$1 AND status='paid'
                AND DATE(paid_at) BETWEEN $2 AND $3
                GROUP BY hour ORDER BY hour`, [tid, start, end]),
      db.query(`SELECT COALESCE(SUM(total),0) AS cogs FROM purchase_receipts
                WHERE tenant_id=$1 AND receipt_date BETWEEN $2 AND $3`, [tid, start, end]),
      db.query(`SELECT COALESCE(SUM(amount),0) AS expenses FROM expenses
                WHERE tenant_id=$1 AND expense_date BETWEEN $2 AND $3`, [tid, start, end]),
      db.query(`SELECT DATE(paid_at) AS day, SUM(total) AS revenue, COUNT(*) AS orders
                FROM pos_orders WHERE tenant_id=$1 AND status='paid'
                AND DATE(paid_at) BETWEEN $2 AND $3
                GROUP BY day ORDER BY day`, [tid, start, end]),
    ]);

    const revenue  = parseFloat(revRes.rows[0].revenue) || 0;
    const orders   = parseInt(revRes.rows[0].orders) || 0;
    const cogs     = parseFloat(cogRes.rows[0].cogs) || 0;
    const expenses = parseFloat(expRes.rows[0].expenses) || 0;
    const profit   = revenue - cogs - expenses;
    const foodCostPct = revenue > 0 ? ((cogs / revenue) * 100).toFixed(1) : '0.0';

    res.render('reports/home', {
      tenant: req.tenant, currentUser: req.user,
      start, end,
      revenue, orders, cogs, expenses, profit, foodCostPct,
      avgOrder: orders > 0 ? (revenue / orders).toFixed(2) : '0.00',
      topItems:   topItemsRes.rows,
      topCats:    topCatRes.rows,
      hourly:     hourlyRes.rows,
      daily:      dailyRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error: ' + err.message);
  }
});

module.exports = router;
