const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAuth = require('../middleware/auth');

async function requireFeat(req, res, next) {
  try {
    const r = await db.query('SELECT feat_happy_hour FROM tenants WHERE id=$1', [req.user.tenantId]);
    if (!r.rows[0]?.feat_happy_hour) return res.status(403).send('<h2 style="font-family:sans-serif;padding:40px">Happy Hour feature is not enabled.</h2>');
    next();
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
}

router.get('/', requireAuth, requireFeat, async (req, res) => {
  try {
    const tenant = (await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId])).rows[0];
    const hours = await db.query('SELECT * FROM happy_hours WHERE tenant_id=$1 ORDER BY start_time', [req.user.tenantId]);
    res.render('pos/happy-hours', { tenant, hours: hours.rows, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/', requireAuth, requireFeat, async (req, res) => {
  const { name, discount_type, discount_value, start_time, end_time, days_of_week } = req.body;
  try {
    const days = Array.isArray(days_of_week) ? days_of_week.map(Number) : days_of_week ? [parseInt(days_of_week)] : [1,2,3,4,5,6,7];
    await db.query(
      'INSERT INTO happy_hours (tenant_id, name, discount_type, discount_value, start_time, end_time, days_of_week) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.user.tenantId, name.trim(), discount_type || 'percent', parseFloat(discount_value) || 10, start_time, end_time, days]
    );
    res.redirect('/pos/happy-hours?success=Created');
  } catch (err) { console.error(err); res.redirect('/pos/happy-hours?error=' + encodeURIComponent(err.message)); }
});

router.post('/:id/edit', requireAuth, requireFeat, async (req, res) => {
  const { name, discount_type, discount_value, start_time, end_time, days_of_week, is_active } = req.body;
  try {
    const days = Array.isArray(days_of_week) ? days_of_week.map(Number) : days_of_week ? [parseInt(days_of_week)] : [1,2,3,4,5,6,7];
    await db.query(
      'UPDATE happy_hours SET name=$1, discount_type=$2, discount_value=$3, start_time=$4, end_time=$5, days_of_week=$6, is_active=$7 WHERE id=$8 AND tenant_id=$9',
      [name.trim(), discount_type || 'percent', parseFloat(discount_value) || 10, start_time, end_time, days, is_active === '1', req.params.id, req.user.tenantId]
    );
    res.redirect('/pos/happy-hours?success=Updated');
  } catch (err) { res.redirect('/pos/happy-hours?error=' + encodeURIComponent(err.message)); }
});

router.post('/:id/toggle', requireAuth, requireFeat, async (req, res) => {
  try {
    await db.query('UPDATE happy_hours SET is_active = NOT COALESCE(is_active,true) WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    res.redirect('/pos/happy-hours');
  } catch (err) { res.redirect('/pos/happy-hours'); }
});

router.post('/:id/delete', requireAuth, requireFeat, async (req, res) => {
  try {
    await db.query('DELETE FROM happy_hours WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    res.redirect('/pos/happy-hours');
  } catch (err) { res.redirect('/pos/happy-hours'); }
});

// API: check active happy hour right now (used by POS)
router.get('/api/active', requireAuth, requireFeat, async (req, res) => {
  try {
    const now = new Date();
    const dow = now.getDay() === 0 ? 7 : now.getDay(); // 1=Mon ... 7=Sun
    const timeStr = now.toTimeString().slice(0, 5); // HH:MM
    const r = await db.query(
      `SELECT * FROM happy_hours
       WHERE tenant_id=$1 AND is_active=true
         AND $2 = ANY(days_of_week)
         AND start_time <= $3::time AND end_time >= $3::time
       LIMIT 1`,
      [req.user.tenantId, dow, timeStr]
    );
    if (r.rows[0]) {
      res.json({ ok: true, active: true, happyHour: r.rows[0] });
    } else {
      res.json({ ok: true, active: false });
    }
  } catch (err) { res.json({ ok: false, active: false }); }
});

module.exports = router;
