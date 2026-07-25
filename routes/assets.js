const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAuth = require('../middleware/auth');

async function requireAssets(req, res, next) {
  try {
    const r = await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId]);
    const tenant = r.rows[0];
    if (!tenant) return res.status(404).send('Tenant not found');
    if (!tenant.feat_assets) return res.status(403).send('Asset Management not enabled.');
    req.tenant = tenant;
    next();
  } catch (err) { res.status(500).send('Server error'); }
}

router.get('/', requireAuth, requireAssets, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [assetsRes, statsRes] = await Promise.all([
      db.query(`SELECT a.*,
          (SELECT COUNT(*)::int FROM asset_maintenance WHERE asset_id=a.id) AS maintenance_count,
          (SELECT MAX(next_service_date) FROM asset_maintenance WHERE asset_id=a.id) AS next_service
        FROM assets a WHERE a.tenant_id=$1 ORDER BY a.name`, [tid]),
      db.query(`SELECT
          COUNT(*)::int AS total,
          COALESCE(SUM(purchase_price),0) AS total_cost,
          COALESCE(SUM(current_value),0) AS total_value,
          COUNT(*) FILTER (WHERE status='active')::int AS active_count
        FROM assets WHERE tenant_id=$1`, [tid]),
    ]);
    res.render('assets/home', {
      tenant: req.tenant, currentUser: req.user,
      assets: assetsRes.rows,
      stats: statsRes.rows[0],
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

router.post('/', requireAuth, requireAssets, async (req, res) => {
  const { name, category, purchase_date, purchase_price, current_value, depreciation_pct, serial_no, location, status, notes } = req.body;
  try {
    await db.query(
      `INSERT INTO assets (tenant_id,name,category,purchase_date,purchase_price,current_value,depreciation_pct,serial_no,location,status,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [req.user.tenantId, name, category||null, purchase_date||null,
       parseFloat(purchase_price)||0, parseFloat(current_value)||0,
       parseFloat(depreciation_pct)||0, serial_no||null, location||null,
       status||'active', notes||null]
    );
    res.redirect('/assets');
  } catch (err) { console.error(err); res.redirect('/assets?error=' + encodeURIComponent(err.message)); }
});

router.post('/:id/edit', requireAuth, requireAssets, async (req, res) => {
  const { name, category, purchase_date, purchase_price, current_value, depreciation_pct, serial_no, location, status, notes } = req.body;
  try {
    await db.query(
      `UPDATE assets SET name=$1,category=$2,purchase_date=$3,purchase_price=$4,current_value=$5,
       depreciation_pct=$6,serial_no=$7,location=$8,status=$9,notes=$10 WHERE id=$11 AND tenant_id=$12`,
      [name, category||null, purchase_date||null, parseFloat(purchase_price)||0,
       parseFloat(current_value)||0, parseFloat(depreciation_pct)||0,
       serial_no||null, location||null, status||'active', notes||null,
       req.params.id, req.user.tenantId]
    );
    res.redirect('/assets');
  } catch (err) { console.error(err); res.redirect('/assets?error=' + encodeURIComponent(err.message)); }
});

router.post('/:id/delete', requireAuth, requireAssets, async (req, res) => {
  await db.query('DELETE FROM assets WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
  res.redirect('/assets');
});

// Maintenance log
router.get('/:id/maintenance', requireAuth, requireAssets, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [assetRes, logRes] = await Promise.all([
      db.query('SELECT * FROM assets WHERE id=$1 AND tenant_id=$2', [req.params.id, tid]),
      db.query(`SELECT m.* FROM asset_maintenance m WHERE m.asset_id=$1 ORDER BY m.service_date DESC`, [req.params.id]),
    ]);
    if (!assetRes.rows[0]) return res.redirect('/assets');
    res.render('assets/maintenance', {
      tenant: req.tenant, currentUser: req.user,
      asset: assetRes.rows[0], log: logRes.rows,
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

router.post('/:id/maintenance', requireAuth, requireAssets, async (req, res) => {
  const { service_date, description, cost, next_service_date } = req.body;
  try {
    await db.query(
      `INSERT INTO asset_maintenance (asset_id,service_date,description,cost,next_service_date,created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, service_date, description||null, parseFloat(cost)||0, next_service_date||null, req.user.userId]
    );
    res.redirect('/assets/' + req.params.id + '/maintenance');
  } catch (err) { console.error(err); res.redirect('/assets/' + req.params.id + '/maintenance?error=' + encodeURIComponent(err.message)); }
});

router.post('/:id/maintenance/:mid/delete', requireAuth, requireAssets, async (req, res) => {
  await db.query('DELETE FROM asset_maintenance WHERE id=$1', [req.params.mid]);
  res.redirect('/assets/' + req.params.id + '/maintenance');
});

module.exports = router;
