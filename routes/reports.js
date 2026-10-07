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

// ── Menu Engineering ──────────────────────────────────────────────
router.get('/menu-engineering', requireAuth, requireReports, async (req, res) => {
  const tid = req.user.tenantId;
  const now = new Date();
  const from = req.query.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
  const to   = req.query.to   || now.toISOString().slice(0,10);
  try {
    const itemsRes = await db.query(`
      SELECT
        mi.id, mi.name, mi.price::float,
        COALESCE(rc.recipe_cost, 0)::float                                         AS cost,
        (mi.price - COALESCE(rc.recipe_cost, 0))::float                            AS contribution_margin,
        CASE WHEN mi.price > 0
             THEN ROUND((mi.price - COALESCE(rc.recipe_cost, 0)) / mi.price * 100, 1)
             ELSE 0 END::float                                                      AS margin_pct,
        COALESCE(s.qty_sold, 0)::int                                               AS qty_sold,
        COALESCE(s.revenue, 0)::float                                              AS revenue,
        c.name AS category
      FROM menu_items mi
      LEFT JOIN categories c ON c.id = mi.category_id
      LEFT JOIN (
        SELECT oi.menu_item_id,
          SUM(oi.quantity) AS qty_sold,
          SUM(oi.price * oi.quantity) AS revenue
        FROM pos_order_items oi
        JOIN pos_orders po ON po.id = oi.order_id
        WHERE po.tenant_id=$1 AND po.status='paid'
          AND po.paid_at::date BETWEEN $2 AND $3
        GROUP BY oi.menu_item_id
      ) s ON s.menu_item_id = mi.id
      LEFT JOIN (
        SELECT ii.menu_item_id, SUM(ir.quantity * ing.avg_cost) AS recipe_cost
        FROM inventory_items ii
        JOIN inventory_recipes ir ON ir.item_id = ii.id
        JOIN inventory_items ing ON ing.id = ir.ingredient_id AND ing.tenant_id = $1
        WHERE ii.tenant_id = $1 AND ii.menu_item_id IS NOT NULL
        GROUP BY ii.menu_item_id
      ) rc ON rc.menu_item_id = mi.id
      WHERE mi.tenant_id=$1 AND mi.is_available=true
      ORDER BY COALESCE(s.revenue, 0) DESC
    `, [tid, from, to]);

    const items = itemsRes.rows;
    const soldItems = items.filter(i => i.qty_sold > 0);
    const avgQty    = soldItems.length ? soldItems.reduce((s,i)=>s+i.qty_sold,0) / soldItems.length : 0;
    const avgMargin = items.length ? items.reduce((s,i)=>s+i.contribution_margin,0) / items.length : 0;

    items.forEach(i => {
      const hiPop = i.qty_sold >= avgQty;
      const hiMar = i.contribution_margin >= avgMargin;
      if (hiPop && hiMar)       i.quadrant = 'star';
      else if (hiPop && !hiMar) i.quadrant = 'plow_horse';
      else if (!hiPop && hiMar) i.quadrant = 'puzzle';
      else                      i.quadrant = 'dog';
    });

    res.render('reports/menu-engineering', {
      tenant: req.tenant, currentUser: req.user,
      items, from, to, avgQty, avgMargin,
      stars:      items.filter(i=>i.quadrant==='star'),
      plowHorses: items.filter(i=>i.quadrant==='plow_horse'),
      puzzles:    items.filter(i=>i.quadrant==='puzzle'),
      dogs:       items.filter(i=>i.quadrant==='dog'),
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

// ── EOD / Daily Summary Report ────────────────────────────────────
router.get('/eod', requireAuth, requireReports, async (req, res) => {
  const tid  = req.user.tenantId;
  const date = req.query.date || new Date().toISOString().slice(0,10);
  try {
    const [summaryRes, hourlyRes, topItemsRes, catRes, payMethodRes, voidsRes, staffRes, discountRes] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*)::int AS orders,
                  AVG(total) AS avg_check,
                  COUNT(*) FILTER (WHERE discount_type != 'none')::int AS discounted_orders,
                  COALESCE(SUM(CASE WHEN discount_type='fixed' THEN discount_value
                       WHEN discount_type='percent' THEN total * discount_value / 100 ELSE 0 END),0) AS total_discounts
                FROM pos_orders WHERE tenant_id=$1 AND status='paid' AND paid_at::date=$2`, [tid, date]),

      db.query(`SELECT EXTRACT(HOUR FROM paid_at)::int AS hour,
                  SUM(total) AS revenue, COUNT(*)::int AS orders
                FROM pos_orders WHERE tenant_id=$1 AND status='paid' AND paid_at::date=$2
                GROUP BY hour ORDER BY hour`, [tid, date]),

      db.query(`SELECT oi.name, SUM(oi.quantity)::int AS qty, SUM(oi.price*oi.quantity) AS revenue
                FROM pos_order_items oi JOIN pos_orders po ON po.id=oi.order_id
                WHERE po.tenant_id=$1 AND po.status='paid' AND po.paid_at::date=$2
                GROUP BY oi.name ORDER BY revenue DESC LIMIT 10`, [tid, date]),

      db.query(`SELECT COALESCE(c.name,'Uncategorised') AS cat, SUM(oi.price*oi.quantity) AS revenue
                FROM pos_order_items oi JOIN pos_orders po ON po.id=oi.order_id
                LEFT JOIN menu_items mi ON mi.id=oi.menu_item_id
                LEFT JOIN categories c ON c.id=mi.category_id
                WHERE po.tenant_id=$1 AND po.status='paid' AND po.paid_at::date=$2
                GROUP BY c.name ORDER BY revenue DESC`, [tid, date]),

      db.query(`SELECT pp.method, SUM(pp.amount_paid) AS total, COUNT(*)::int AS cnt
                FROM pos_payments pp JOIN pos_orders po ON po.id=pp.order_id
                WHERE po.tenant_id=$1 AND po.status='paid' AND po.paid_at::date=$2
                GROUP BY pp.method ORDER BY total DESC`, [tid, date]),

      db.query(`SELECT COUNT(*)::int AS cnt FROM pos_orders
                WHERE tenant_id=$1 AND status='void' AND created_at::date=$2`, [tid, date]),

      db.query(`SELECT u.name, COUNT(po.id)::int AS orders, COALESCE(SUM(po.total),0) AS revenue
                FROM pos_orders po JOIN users u ON u.id=po.created_by
                WHERE po.tenant_id=$1 AND po.status='paid' AND po.paid_at::date=$2
                GROUP BY u.name ORDER BY revenue DESC`, [tid, date]),

      db.query(`SELECT COUNT(*)::int AS cnt,
                  COALESCE(SUM(CASE WHEN discount_type='fixed' THEN discount_value
                       WHEN discount_type='percent' THEN total * discount_value / 100 ELSE 0 END),0) AS total
                FROM pos_orders WHERE tenant_id=$1 AND status='paid'
                  AND discount_type != 'none' AND paid_at::date=$2`, [tid, date]),
    ]);

    const summary = summaryRes.rows[0];
    res.render('reports/eod', {
      tenant: req.tenant, currentUser: req.user, date,
      revenue:    parseFloat(summary.revenue)    || 0,
      orders:     summary.orders                 || 0,
      avgCheck:   parseFloat(summary.avg_check)  || 0,
      totalDisc:  parseFloat(summary.total_discounts) || 0,
      discOrders: summary.discounted_orders      || 0,
      voids:      voidsRes.rows[0].cnt           || 0,
      hourly: hourlyRes.rows,
      topItems: topItemsRes.rows,
      categories: catRes.rows,
      payMethods: payMethodRes.rows,
      staff: staffRes.rows,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

// ── Table Analytics ───────────────────────────────────────────────
router.get('/tables', requireAuth, requireReports, async (req, res) => {
  const tid = req.user.tenantId;
  const now = new Date();
  const from = req.query.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
  const to   = req.query.to   || now.toISOString().slice(0,10);
  try {
    const [tablesRes, dailyRes] = await Promise.all([
      db.query(`SELECT
          COALESCE(table_name,'Takeaway/Delivery') AS table_name,
          COUNT(*)::int        AS visits,
          COALESCE(SUM(total),0) AS revenue,
          AVG(total)           AS avg_check,
          AVG(EXTRACT(EPOCH FROM (paid_at - created_at))/60)::int AS avg_minutes
        FROM pos_orders
        WHERE tenant_id=$1 AND status='paid' AND paid_at::date BETWEEN $2 AND $3
        GROUP BY table_name ORDER BY revenue DESC`, [tid, from, to]),

      db.query(`SELECT paid_at::date AS day, COUNT(*)::int AS orders, COALESCE(SUM(total),0) AS revenue
                FROM pos_orders WHERE tenant_id=$1 AND status='paid' AND paid_at::date BETWEEN $2 AND $3
                GROUP BY day ORDER BY day`, [tid, from, to]),
    ]);

    const totalRevenue = tablesRes.rows.reduce((s,t)=>s+parseFloat(t.revenue),0);
    res.render('reports/tables', {
      tenant: req.tenant, currentUser: req.user, from, to,
      tables: tablesRes.rows, daily: dailyRes.rows, totalRevenue,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

// ── Void & Discount Analysis ──────────────────────────────────────
router.get('/voids', requireAuth, requireReports, async (req, res) => {
  const tid = req.user.tenantId;
  const now = new Date();
  const from = req.query.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
  const to   = req.query.to   || now.toISOString().slice(0,10);
  try {
    const [voidsRes, discRes, discByUserRes, voidTrendRes] = await Promise.all([
      db.query(`SELECT po.id, po.table_name, po.total, po.created_at,
                  u.name AS by_user, po.notes
                FROM pos_orders po LEFT JOIN users u ON u.id=po.created_by
                WHERE po.tenant_id=$1 AND po.status='void'
                  AND po.created_at::date BETWEEN $2 AND $3
                ORDER BY po.created_at DESC`, [tid, from, to]),

      db.query(`SELECT COUNT(*)::int AS cnt,
                  COALESCE(SUM(CASE WHEN discount_type='fixed' THEN discount_value
                       WHEN discount_type='percent' THEN total * discount_value / 100 ELSE 0 END),0) AS total_disc,
                  COALESCE(SUM(total),0) AS gross_revenue
                FROM pos_orders WHERE tenant_id=$1 AND status='paid'
                  AND discount_type != 'none' AND paid_at::date BETWEEN $2 AND $3`, [tid, from, to]),

      db.query(`SELECT u.name,
                  COUNT(po.id)::int AS disc_orders,
                  COALESCE(SUM(CASE WHEN po.discount_type='fixed' THEN po.discount_value
                       WHEN po.discount_type='percent' THEN po.total * po.discount_value / 100 ELSE 0 END),0) AS disc_total,
                  STRING_AGG(DISTINCT po.discount_type, ', ') AS types
                FROM pos_orders po LEFT JOIN users u ON u.id=po.created_by
                WHERE po.tenant_id=$1 AND po.status='paid'
                  AND po.discount_type != 'none' AND po.paid_at::date BETWEEN $2 AND $3
                GROUP BY u.name ORDER BY disc_total DESC`, [tid, from, to]),

      db.query(`SELECT created_at::date AS day, COUNT(*)::int AS voids
                FROM pos_orders WHERE tenant_id=$1 AND status='void'
                  AND created_at::date BETWEEN $2 AND $3
                GROUP BY day ORDER BY day`, [tid, from, to]),
    ]);

    const disc = discRes.rows[0];
    res.render('reports/voids', {
      tenant: req.tenant, currentUser: req.user, from, to,
      voids: voidsRes.rows, voidTrend: voidTrendRes.rows,
      discCount: disc.cnt || 0,
      discTotal: parseFloat(disc.total_disc) || 0,
      discByUser: discByUserRes.rows,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

module.exports = router;
