const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAuth = require('../middleware/auth');

async function requireReservations(req, res, next) {
  try {
    const r = await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId]);
    const tenant = r.rows[0];
    if (!tenant) return res.status(404).send('Tenant not found');
    if (!tenant.feat_reservations) return res.status(403).send('Reservations module not enabled.');
    req.tenant = tenant;
    next();
  } catch (err) { res.status(500).send('Server error'); }
}

router.get('/', requireAuth, requireReservations, async (req, res) => {
  const tid = req.user.tenantId;
  const viewDate = req.query.date || new Date().toISOString().slice(0,10);
  try {
    const [resRes, tablesRes, upcomingRes] = await Promise.all([
      db.query(`SELECT r.*, t.name AS table_name FROM reservations r
                LEFT JOIN restaurant_tables t ON t.id=r.table_id
                WHERE r.tenant_id=$1 AND r.reservation_date=$2
                ORDER BY r.reservation_time`, [tid, viewDate]),
      db.query(`SELECT id, name FROM restaurant_tables WHERE tenant_id=$1 ORDER BY sort_order, name`, [tid]),
      db.query(`SELECT r.*, t.name AS table_name FROM reservations r
                LEFT JOIN restaurant_tables t ON t.id=r.table_id
                WHERE r.tenant_id=$1 AND r.reservation_date > $2
                AND r.status NOT IN ('cancelled','completed')
                ORDER BY r.reservation_date, r.reservation_time LIMIT 20`, [tid, viewDate]),
    ]);
    res.render('reservations/home', {
      tenant: req.tenant, currentUser: req.user,
      reservations: resRes.rows, tables: tablesRes.rows,
      upcoming: upcomingRes.rows, viewDate,
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

router.post('/', requireAuth, requireReservations, async (req, res) => {
  const { customer_name, phone, party_size, table_id, reservation_date, reservation_time, duration_mins, notes } = req.body;
  try {
    await db.query(
      `INSERT INTO reservations (tenant_id,customer_name,phone,party_size,table_id,reservation_date,reservation_time,duration_mins,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [req.user.tenantId, customer_name, phone||null, parseInt(party_size)||1,
       table_id||null, reservation_date, reservation_time,
       parseInt(duration_mins)||90, notes||null, req.user.userId]
    );
    res.redirect('/reservations?date=' + reservation_date);
  } catch (err) { console.error(err); res.redirect('/reservations?error=' + encodeURIComponent(err.message)); }
});

router.post('/:id/status', requireAuth, requireReservations, async (req, res) => {
  const { status, date } = req.body;
  const back = '/reservations?date=' + (date || new Date().toISOString().slice(0,10));
  try {
    await db.query(`UPDATE reservations SET status=$1 WHERE id=$2 AND tenant_id=$3`,
      [status, req.params.id, req.user.tenantId]);
    res.redirect(back);
  } catch (err) { console.error(err); res.redirect(back + '&error=' + encodeURIComponent(err.message)); }
});

router.post('/:id/delete', requireAuth, requireReservations, async (req, res) => {
  const { date } = req.body;
  const back = '/reservations?date=' + (date || new Date().toISOString().slice(0,10));
  try {
    await db.query('DELETE FROM reservations WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    res.redirect(back);
  } catch (err) { console.error(err); res.redirect(back + '&error=' + encodeURIComponent(err.message)); }
});

module.exports = router;
