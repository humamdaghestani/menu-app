const express = require('express');
const router  = express.Router();
const db      = require('../db');
const requireAuth = require('../middleware/auth');

async function requireAccounting(req, res, next) {
  try {
    const r = await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId]);
    const tenant = r.rows[0];
    if (!tenant) return res.status(404).send('Tenant not found');
    if (!tenant.feat_accounting) return res.status(403).send('Accounting module not enabled.');
    req.tenant = tenant;
    next();
  } catch (err) { res.status(500).send('Server error'); }
}

// ── Dashboard / P&L ───────────────────────────────────────────────
router.get('/', requireAuth, requireAccounting, async (req, res) => {
  const tid = req.user.tenantId;
  const { from, to, period } = req.query;

  // Default to current month
  const now   = new Date();
  const dateFrom = from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const dateTo   = to   || new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

  const [revenueRes, cogsRes, expensesRes, expByCatRes, revByDayRes, recentExpRes] = await Promise.all([
    // Revenue: closed POS orders in range
    db.query(`
      SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS order_count
      FROM pos_orders
      WHERE tenant_id=$1 AND status='closed' AND paid_at::date BETWEEN $2 AND $3
    `, [tid, dateFrom, dateTo]),

    // COGS: purchase receipts in range
    db.query(`
      SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS receipt_count
      FROM purchase_receipts
      WHERE tenant_id=$1 AND receipt_date BETWEEN $2 AND $3
    `, [tid, dateFrom, dateTo]),

    // Total expenses in range
    db.query(`
      SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS expense_count
      FROM expenses
      WHERE tenant_id=$1 AND expense_date BETWEEN $2 AND $3
    `, [tid, dateFrom, dateTo]),

    // Expenses by category
    db.query(`
      SELECT ec.name, ec.color, COALESCE(SUM(e.amount),0) AS total
      FROM expenses e
      LEFT JOIN expense_categories ec ON ec.id=e.category_id
      WHERE e.tenant_id=$1 AND e.expense_date BETWEEN $2 AND $3
      GROUP BY ec.name, ec.color
      ORDER BY total DESC
    `, [tid, dateFrom, dateTo]),

    // Revenue by day (for mini chart)
    db.query(`
      SELECT paid_at::date AS day, COALESCE(SUM(total),0) AS total
      FROM pos_orders
      WHERE tenant_id=$1 AND status='closed' AND paid_at::date BETWEEN $2 AND $3
      GROUP BY paid_at::date ORDER BY day
    `, [tid, dateFrom, dateTo]),

    // Recent expenses
    db.query(`
      SELECT e.*, ec.name AS cat_name, ec.color AS cat_color
      FROM expenses e
      LEFT JOIN expense_categories ec ON ec.id=e.category_id
      WHERE e.tenant_id=$1 AND e.expense_date BETWEEN $2 AND $3
      ORDER BY e.expense_date DESC, e.id DESC LIMIT 20
    `, [tid, dateFrom, dateTo]),
  ]);

  const revenue  = parseFloat(revenueRes.rows[0].total)   || 0;
  const cogs     = parseFloat(cogsRes.rows[0].total)      || 0;
  const expenses = parseFloat(expensesRes.rows[0].total)  || 0;
  const gross    = revenue - cogs;
  const net      = gross - expenses;

  res.render('accounting/home', {
    tenant: req.tenant,
    currentUser: req.user,
    dateFrom, dateTo,
    revenue, cogs, expenses, gross, net,
    orderCount:   parseInt(revenueRes.rows[0].order_count)   || 0,
    receiptCount: parseInt(cogsRes.rows[0].receipt_count)    || 0,
    expenseCount: parseInt(expensesRes.rows[0].expense_count)|| 0,
    expByCat:   expByCatRes.rows,
    revByDay:   revByDayRes.rows,
    recentExp:  recentExpRes.rows,
  });
});

// ── Expense Categories ─────────────────────────────────────────────
router.post('/categories', requireAuth, requireAccounting, async (req, res) => {
  const { name, color } = req.body;
  if (!name?.trim()) return res.redirect('/accounting/expenses');
  await db.query(`INSERT INTO expense_categories (tenant_id,name,color) VALUES ($1,$2,$3)`,
    [req.user.tenantId, name.trim(), color || '#e74c3c']);
  res.redirect('/accounting/expenses');
});

router.post('/categories/:id/delete', requireAuth, requireAccounting, async (req, res) => {
  await db.query(`UPDATE expenses SET category_id=NULL WHERE category_id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
  await db.query(`DELETE FROM expense_categories WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
  res.redirect('/accounting/expenses');
});

// ── Expenses ───────────────────────────────────────────────────────
router.get('/expenses', requireAuth, requireAccounting, async (req, res) => {
  const tid = req.user.tenantId;
  const { from, to } = req.query;
  const now = new Date();
  const dateFrom = from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const dateTo   = to   || new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

  const [expRes, catsRes] = await Promise.all([
    db.query(`
      SELECT e.*, ec.name AS cat_name, ec.color AS cat_color
      FROM expenses e
      LEFT JOIN expense_categories ec ON ec.id=e.category_id
      WHERE e.tenant_id=$1 AND e.expense_date BETWEEN $2 AND $3
      ORDER BY e.expense_date DESC, e.id DESC
    `, [tid, dateFrom, dateTo]),
    db.query(`SELECT * FROM expense_categories WHERE tenant_id=$1 ORDER BY sort_order,name`, [tid]),
  ]);

  res.render('accounting/expenses', {
    tenant: req.tenant,
    currentUser: req.user,
    expenses: expRes.rows,
    categories: catsRes.rows,
    dateFrom, dateTo,
    total: expRes.rows.reduce((s, e) => s + parseFloat(e.amount), 0),
  });
});

router.post('/expenses', requireAuth, requireAccounting, async (req, res) => {
  const { description, amount, expense_date, category_id, notes } = req.body;
  if (!description?.trim() || !amount) return res.redirect('/accounting/expenses');
  await db.query(
    `INSERT INTO expenses (tenant_id,description,amount,expense_date,category_id,notes,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.user.tenantId, description.trim(), parseFloat(amount),
     expense_date || new Date().toISOString().slice(0,10),
     category_id || null, notes?.trim() || null, req.user.userId]
  );
  res.redirect('/accounting/expenses');
});

router.post('/expenses/:id/delete', requireAuth, requireAccounting, async (req, res) => {
  await db.query(`DELETE FROM expenses WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
  res.redirect('/accounting/expenses');
});

router.post('/expenses/:id/edit', requireAuth, requireAccounting, async (req, res) => {
  const { description, amount, expense_date, category_id, notes } = req.body;
  await db.query(
    `UPDATE expenses SET description=$1,amount=$2,expense_date=$3,category_id=$4,notes=$5 WHERE id=$6 AND tenant_id=$7`,
    [description.trim(), parseFloat(amount), expense_date, category_id || null,
     notes?.trim() || null, req.params.id, req.user.tenantId]
  );
  res.redirect('/accounting/expenses');
});

module.exports = router;
