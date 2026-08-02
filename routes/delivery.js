const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAuth = require('../middleware/auth');

async function requireDelivery(req, res, next) {
  try {
    const r = await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId]);
    const tenant = r.rows[0];
    if (!tenant) return res.status(404).send('Tenant not found');
    if (!tenant.feat_delivery) return res.status(403).send('Delivery module not enabled.');
    req.tenant = tenant;
    next();
  } catch (err) { res.status(500).send('Server error'); }
}

router.get('/', requireAuth, requireDelivery, async (req, res) => {
  const tid = req.user.tenantId;
  const { status } = req.query;
  try {
    const whereStatus = status ? `AND d.status=$2` : '';
    const params = status ? [tid, status] : [tid];
    const [delivRes, statsRes] = await Promise.all([
      db.query(`SELECT d.*, po.total AS order_total FROM delivery_orders d
                LEFT JOIN pos_orders po ON po.id=d.order_id
                WHERE d.tenant_id=$1 ${whereStatus}
                ORDER BY d.created_at DESC LIMIT 50`, params),
      db.query(`SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status='pending')::int AS pending,
          COUNT(*) FILTER (WHERE status='dispatched')::int AS dispatched,
          COUNT(*) FILTER (WHERE status='delivered')::int AS delivered,
          COALESCE(SUM(delivery_fee),0) AS total_fees
        FROM delivery_orders WHERE tenant_id=$1 AND DATE(created_at)=CURRENT_DATE`, [tid]),
    ]);
    res.render('delivery/home', {
      tenant: req.tenant, currentUser: req.user,
      deliveries: delivRes.rows, stats: statsRes.rows[0],
      activeStatus: status || 'all',
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

router.post('/', requireAuth, requireDelivery, async (req, res) => {
  const { customer_name, phone, address, zone, rider_name, delivery_fee, estimated_mins, notes } = req.body;
  try {
    await db.query(
      `INSERT INTO delivery_orders (tenant_id,customer_name,phone,address,zone,rider_name,delivery_fee,estimated_mins,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [req.user.tenantId, customer_name, phone||null, address||null, zone||null,
       rider_name||null, parseFloat(delivery_fee)||0, parseInt(estimated_mins)||45, notes||null]
    );
    res.redirect('/delivery');
  } catch (err) { console.error(err); res.redirect('/delivery?error=' + encodeURIComponent(err.message)); }
});

router.post('/:id/status', requireAuth, requireDelivery, async (req, res) => {
  const { status } = req.body;
  try {
    let sql = 'UPDATE delivery_orders SET status=$1';
    const vals = [status];
    if (status === 'dispatched') sql += `,dispatched_at=NOW()`;
    if (status === 'delivered')  sql += `,delivered_at=NOW()`;
    sql += ` WHERE id=$2 AND tenant_id=$3`;
    vals.push(req.params.id, req.user.tenantId);
    await db.query(sql, vals);
    res.redirect('/delivery');
  } catch (err) { console.error(err); res.redirect('/delivery?error=' + encodeURIComponent(err.message)); }
});

router.post('/:id/rider', requireAuth, requireDelivery, async (req, res) => {
  const { rider_name } = req.body;
  try {
    await db.query('UPDATE delivery_orders SET rider_name=$1 WHERE id=$2 AND tenant_id=$3',
      [rider_name, req.params.id, req.user.tenantId]);
    res.redirect('/delivery');
  } catch (err) { console.error(err); res.redirect('/delivery?error=' + encodeURIComponent(err.message)); }
});

router.post('/:id/delete', requireAuth, requireDelivery, async (req, res) => {
  try {
    await db.query('DELETE FROM delivery_orders WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    res.redirect('/delivery');
  } catch (err) { console.error(err); res.redirect('/delivery?error=' + encodeURIComponent(err.message)); }
});

module.exports = router;
