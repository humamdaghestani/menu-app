const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAuth = require('../middleware/auth');

async function requireHR(req, res, next) {
  try {
    const r = await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId]);
    const tenant = r.rows[0];
    if (!tenant) return res.status(404).send('Tenant not found');
    if (!tenant.feat_hr) return res.status(403).send('HR module not enabled.');
    req.tenant = tenant;
    next();
  } catch (err) { res.status(500).send('Server error'); }
}

// Home — employee list
router.get('/', requireAuth, requireHR, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [empRes, payrollRes, shiftRes] = await Promise.all([
      db.query(`SELECT e.*,
          (SELECT COUNT(*) FROM hr_shifts WHERE employee_id=e.id AND shift_date >= CURRENT_DATE - 30)::int AS shifts_30d
        FROM hr_employees e WHERE e.tenant_id=$1 ORDER BY e.name`, [tid]),
      db.query(`SELECT COALESCE(SUM(net_pay),0) AS total FROM hr_payroll WHERE tenant_id=$1 AND status='paid'
                AND period_start >= DATE_TRUNC('month', CURRENT_DATE)`, [tid]),
      db.query(`SELECT COUNT(*)::int AS today FROM hr_shifts WHERE tenant_id=$1 AND shift_date=CURRENT_DATE`, [tid]),
    ]);
    res.render('hr/home', {
      tenant: req.tenant, currentUser: req.user,
      employees: empRes.rows,
      payrollThisMonth: parseFloat(payrollRes.rows[0].total) || 0,
      shiftsToday: shiftRes.rows[0].today,
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

// Add employee
router.post('/employees', requireAuth, requireHR, async (req, res) => {
  const { name, phone, email, role, department, salary, salary_type, hire_date, notes } = req.body;
  try {
    await db.query(
      `INSERT INTO hr_employees (tenant_id,name,phone,email,role,department,salary,salary_type,hire_date,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [req.user.tenantId, name, phone||null, email||null, role||null, department||null,
       parseFloat(salary)||0, salary_type||'monthly', hire_date||null, notes||null]
    );
    res.redirect('/hr');
  } catch (err) { console.error(err); res.redirect('/hr?error=' + encodeURIComponent(err.message)); }
});

// Edit employee
router.post('/employees/:id/edit', requireAuth, requireHR, async (req, res) => {
  const { name, phone, email, role, department, salary, salary_type, hire_date, status, notes } = req.body;
  try {
    await db.query(
      `UPDATE hr_employees SET name=$1,phone=$2,email=$3,role=$4,department=$5,salary=$6,salary_type=$7,hire_date=$8,status=$9,notes=$10
       WHERE id=$11 AND tenant_id=$12`,
      [name, phone||null, email||null, role||null, department||null, parseFloat(salary)||0,
       salary_type||'monthly', hire_date||null, status||'active', notes||null,
       req.params.id, req.user.tenantId]
    );
    res.redirect('/hr');
  } catch (err) { console.error(err); res.redirect('/hr?error=' + encodeURIComponent(err.message)); }
});

// Delete employee
router.post('/employees/:id/delete', requireAuth, requireHR, async (req, res) => {
  try {
    await db.query('DELETE FROM hr_employees WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    res.redirect('/hr');
  } catch (err) { console.error(err); res.redirect('/hr?error=' + encodeURIComponent(err.message)); }
});

// Shifts page
router.get('/shifts', requireAuth, requireHR, async (req, res) => {
  const tid = req.user.tenantId;
  const weekStart = req.query.week || new Date().toISOString().slice(0,10);
  try {
    const [empRes, shiftRes] = await Promise.all([
      db.query(`SELECT id, name FROM hr_employees WHERE tenant_id=$1 AND status='active' ORDER BY name`, [tid]),
      db.query(`SELECT s.*, e.name AS employee_name FROM hr_shifts s
                JOIN hr_employees e ON e.id=s.employee_id
                WHERE s.tenant_id=$1 AND s.shift_date BETWEEN $2::date AND $2::date + 6
                ORDER BY s.shift_date, s.start_time`, [tid, weekStart]),
    ]);
    res.render('hr/shifts', {
      tenant: req.tenant, currentUser: req.user,
      employees: empRes.rows, shifts: shiftRes.rows, weekStart,
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

// Add shift
router.post('/shifts', requireAuth, requireHR, async (req, res) => {
  const { employee_id, shift_date, start_time, end_time, hours_worked, notes } = req.body;
  try {
    await db.query(
      `INSERT INTO hr_shifts (tenant_id,employee_id,shift_date,start_time,end_time,hours_worked,status,notes)
       VALUES ($1,$2,$3,$4,$5,$6,'completed',$7)`,
      [req.user.tenantId, employee_id, shift_date, start_time||null, end_time||null,
       parseFloat(hours_worked)||null, notes||null]
    );
    res.redirect('/hr/shifts');
  } catch (err) { console.error(err); res.redirect('/hr/shifts?error=' + encodeURIComponent(err.message)); }
});

// Delete shift
router.post('/shifts/:id/delete', requireAuth, requireHR, async (req, res) => {
  try {
    await db.query('DELETE FROM hr_shifts WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    res.redirect('/hr/shifts');
  } catch (err) { console.error(err); res.redirect('/hr/shifts?error=' + encodeURIComponent(err.message)); }
});

// Payroll page
router.get('/payroll', requireAuth, requireHR, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [empRes, payrollRes] = await Promise.all([
      db.query(`SELECT id, name, salary, salary_type FROM hr_employees WHERE tenant_id=$1 AND status='active' ORDER BY name`, [tid]),
      db.query(`SELECT p.*, e.name AS employee_name FROM hr_payroll p
                JOIN hr_employees e ON e.id=p.employee_id
                WHERE p.tenant_id=$1 ORDER BY p.created_at DESC LIMIT 50`, [tid]),
    ]);
    res.render('hr/payroll', {
      tenant: req.tenant, currentUser: req.user,
      employees: empRes.rows, payrolls: payrollRes.rows,
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

// Create payroll entry
router.post('/payroll', requireAuth, requireHR, async (req, res) => {
  const { employee_id, period_start, period_end, base_salary, allowances, deductions, notes } = req.body;
  const base = parseFloat(base_salary) || 0;
  const allow = parseFloat(allowances) || 0;
  const deduct = parseFloat(deductions) || 0;
  const net = base + allow - deduct;
  try {
    await db.query(
      `INSERT INTO hr_payroll (tenant_id,employee_id,period_start,period_end,base_salary,allowances,deductions,net_pay,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [req.user.tenantId, employee_id, period_start, period_end, base, allow, deduct, net, notes||null, req.user.userId]
    );
    res.redirect('/hr/payroll');
  } catch (err) { console.error(err); res.redirect('/hr/payroll?error=' + encodeURIComponent(err.message)); }
});

// Mark payroll paid
router.post('/payroll/:id/pay', requireAuth, requireHR, async (req, res) => {
  try {
    await db.query(`UPDATE hr_payroll SET status='paid', paid_at=NOW() WHERE id=$1 AND tenant_id=$2`,
      [req.params.id, req.user.tenantId]);
    res.redirect('/hr/payroll');
  } catch (err) { console.error(err); res.redirect('/hr/payroll?error=' + encodeURIComponent(err.message)); }
});

// Delete payroll
router.post('/payroll/:id/delete', requireAuth, requireHR, async (req, res) => {
  try {
    await db.query('DELETE FROM hr_payroll WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    res.redirect('/hr/payroll');
  } catch (err) { console.error(err); res.redirect('/hr/payroll?error=' + encodeURIComponent(err.message)); }
});

module.exports = router;
