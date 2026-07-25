const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAuth = require('../middleware/auth');

async function requireLoyalty(req, res, next) {
  try {
    const r = await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId]);
    const tenant = r.rows[0];
    if (!tenant) return res.status(404).send('Tenant not found');
    if (!tenant.feat_loyalty) return res.status(403).send('Loyalty module not enabled.');
    req.tenant = tenant;
    next();
  } catch (err) { res.status(500).send('Server error'); }
}

router.get('/', requireAuth, requireLoyalty, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [progRes, topRes, txRes] = await Promise.all([
      db.query('SELECT * FROM loyalty_programs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1', [tid]),
      db.query(`SELECT c.id, c.name, c.phone, c.loyalty_points
                FROM customers c WHERE c.tenant_id=$1 AND c.loyalty_points > 0
                ORDER BY c.loyalty_points DESC LIMIT 20`, [tid]),
      db.query(`SELECT lt.*, c.name AS customer_name FROM loyalty_transactions lt
                JOIN customers c ON c.id=lt.customer_id
                WHERE lt.tenant_id=$1 ORDER BY lt.created_at DESC LIMIT 30`, [tid]),
    ]);
    res.render('loyalty/home', {
      tenant: req.tenant, currentUser: req.user,
      program: progRes.rows[0] || null,
      topCustomers: topRes.rows,
      transactions: txRes.rows,
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

// Save / update program settings
router.post('/program', requireAuth, requireLoyalty, async (req, res) => {
  const { name, points_per_unit, unit_amount, redeem_rate, min_redeem_pts } = req.body;
  const tid = req.user.tenantId;
  try {
    const existing = await db.query('SELECT id FROM loyalty_programs WHERE tenant_id=$1 LIMIT 1', [tid]);
    if (existing.rows[0]) {
      await db.query(
        `UPDATE loyalty_programs SET name=$1,points_per_unit=$2,unit_amount=$3,redeem_rate=$4,min_redeem_pts=$5 WHERE id=$6`,
        [name, parseFloat(points_per_unit)||1, parseFloat(unit_amount)||1,
         parseFloat(redeem_rate)||0.01, parseInt(min_redeem_pts)||100, existing.rows[0].id]
      );
    } else {
      await db.query(
        `INSERT INTO loyalty_programs (tenant_id,name,points_per_unit,unit_amount,redeem_rate,min_redeem_pts)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [tid, name, parseFloat(points_per_unit)||1, parseFloat(unit_amount)||1,
         parseFloat(redeem_rate)||0.01, parseInt(min_redeem_pts)||100]
      );
    }
    res.redirect('/loyalty');
  } catch (err) { console.error(err); res.redirect('/loyalty?error=' + encodeURIComponent(err.message)); }
});

// Add points manually
router.post('/points/add', requireAuth, requireLoyalty, async (req, res) => {
  const { customer_id, points, notes } = req.body;
  const pts = parseInt(points) || 0;
  try {
    await Promise.all([
      db.query(`UPDATE customers SET loyalty_points = loyalty_points + $1 WHERE id=$2 AND tenant_id=$3`,
        [pts, customer_id, req.user.tenantId]),
      db.query(`INSERT INTO loyalty_transactions (tenant_id,customer_id,type,points,notes)
                VALUES ($1,$2,'manual',$3,$4)`,
        [req.user.tenantId, customer_id, pts, notes||null]),
    ]);
    res.redirect('/loyalty');
  } catch (err) { console.error(err); res.redirect('/loyalty?error=' + encodeURIComponent(err.message)); }
});

// Redeem points
router.post('/points/redeem', requireAuth, requireLoyalty, async (req, res) => {
  const { customer_id, points, notes } = req.body;
  const pts = parseInt(points) || 0;
  try {
    const cust = await db.query('SELECT loyalty_points FROM customers WHERE id=$1 AND tenant_id=$2', [customer_id, req.user.tenantId]);
    if (!cust.rows[0] || cust.rows[0].loyalty_points < pts) {
      return res.redirect('/loyalty?error=Insufficient+points');
    }
    await Promise.all([
      db.query(`UPDATE customers SET loyalty_points = loyalty_points - $1 WHERE id=$2 AND tenant_id=$3`,
        [pts, customer_id, req.user.tenantId]),
      db.query(`INSERT INTO loyalty_transactions (tenant_id,customer_id,type,points,notes)
                VALUES ($1,$2,'redeem',$3,$4)`,
        [req.user.tenantId, customer_id, -pts, notes||null]),
    ]);
    res.redirect('/loyalty');
  } catch (err) { console.error(err); res.redirect('/loyalty?error=' + encodeURIComponent(err.message)); }
});

module.exports = router;
