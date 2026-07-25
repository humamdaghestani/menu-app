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

function dateRange(query) {
  const now  = new Date();
  const from = query.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to   = query.to   || new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  return { from, to };
}

// ── Dashboard / P&L ───────────────────────────────────────────────
router.get('/', requireAuth, requireAccounting, async (req, res) => {
  const tid = req.user.tenantId;
  const { from, to } = dateRange(req.query);

  const [revenueRes, cogsRes, expensesRes, expByCatRes, revByDayRes,
         payableRes, receivableRes, cashInRes, cashOutRes, recentExpRes] = await Promise.all([

    db.query(`SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS cnt
              FROM pos_orders WHERE tenant_id=$1 AND status='closed' AND paid_at::date BETWEEN $2 AND $3`,
      [tid, from, to]),

    db.query(`SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS cnt
              FROM purchase_receipts WHERE tenant_id=$1 AND receipt_date BETWEEN $2 AND $3`,
      [tid, from, to]),

    db.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
              FROM expenses WHERE tenant_id=$1 AND expense_date BETWEEN $2 AND $3`,
      [tid, from, to]),

    db.query(`SELECT ec.name, ec.color, COALESCE(SUM(e.amount),0) AS total
              FROM expenses e LEFT JOIN expense_categories ec ON ec.id=e.category_id
              WHERE e.tenant_id=$1 AND e.expense_date BETWEEN $2 AND $3
              GROUP BY ec.name, ec.color ORDER BY total DESC`, [tid, from, to]),

    db.query(`SELECT paid_at::date AS day, COALESCE(SUM(total),0) AS total
              FROM pos_orders WHERE tenant_id=$1 AND status='closed' AND paid_at::date BETWEEN $2 AND $3
              GROUP BY paid_at::date ORDER BY day`, [tid, from, to]),

    // Total payable to suppliers (all time)
    db.query(`SELECT
                COALESCE((SELECT SUM(total) FROM purchase_receipts WHERE tenant_id=$1),0) AS purchased,
                COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE tenant_id=$1),0) AS paid`,
      [tid]),

    // Total receivable from customers (open credits)
    db.query(`SELECT COALESCE(SUM(amount - amount_paid),0) AS total
              FROM customer_credits WHERE tenant_id=$1 AND status != 'paid'`, [tid]),

    // Cash in this period (POS cash payments + credit payments received)
    db.query(`SELECT COALESCE(SUM(pp.amount_paid),0) AS total
              FROM pos_payments pp
              JOIN pos_orders po ON po.id=pp.order_id
              WHERE po.tenant_id=$1 AND pp.method='cash' AND pp.created_at::date BETWEEN $2 AND $3`,
      [tid, from, to]),

    // Cash out this period (expenses + supplier payments)
    db.query(`SELECT
                COALESCE((SELECT SUM(amount) FROM expenses WHERE tenant_id=$1 AND expense_date BETWEEN $2 AND $3),0) +
                COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE tenant_id=$1 AND payment_date BETWEEN $2 AND $3),0)
                AS total`, [tid, from, to]),

    // Recent expenses
    db.query(`SELECT e.*, ec.name AS cat_name, ec.color AS cat_color
              FROM expenses e LEFT JOIN expense_categories ec ON ec.id=e.category_id
              WHERE e.tenant_id=$1 AND e.expense_date BETWEEN $2 AND $3
              ORDER BY e.expense_date DESC, e.id DESC LIMIT 8`, [tid, from, to]),
  ]);

  const revenue  = parseFloat(revenueRes.rows[0].total)  || 0;
  const cogs     = parseFloat(cogsRes.rows[0].total)     || 0;
  const expenses = parseFloat(expensesRes.rows[0].total) || 0;
  const gross    = revenue - cogs;
  const net      = gross - expenses;
  const totalPurchased = parseFloat(payableRes.rows[0].purchased) || 0;
  const totalPaid      = parseFloat(payableRes.rows[0].paid)      || 0;
  const totalPayable   = totalPurchased - totalPaid;
  const totalReceivable = parseFloat(receivableRes.rows[0].total) || 0;
  const cashIn  = parseFloat(cashInRes.rows[0].total)  || 0;
  const cashOut = parseFloat(cashOutRes.rows[0].total) || 0;

  res.render('accounting/home', {
    tenant: req.tenant, currentUser: req.user,
    dateFrom: from, dateTo: to,
    revenue, cogs, expenses, gross, net,
    orderCount:   parseInt(revenueRes.rows[0].cnt) || 0,
    receiptCount: parseInt(cogsRes.rows[0].cnt)    || 0,
    expenseCount: parseInt(expensesRes.rows[0].cnt)|| 0,
    expByCat: expByCatRes.rows,
    revByDay: revByDayRes.rows,
    totalPayable, totalReceivable, cashIn, cashOut,
    recentExp: recentExpRes.rows,
  });
});

// ── Supplier Ledger ────────────────────────────────────────────────
router.get('/suppliers', requireAuth, requireAccounting, async (req, res) => {
  const tid = req.user.tenantId;

  const [ledgerRes, paymentsRes, customersRes] = await Promise.all([
    // Balance per supplier: purchased - paid
    db.query(`
      SELECT supplier_name,
        COALESCE(SUM(pr.total),0) AS total_purchased,
        COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp
                  WHERE sp.tenant_id=$1 AND sp.supplier_name=pr.supplier_name),0) AS total_paid
      FROM purchase_receipts pr
      WHERE pr.tenant_id=$1 AND pr.supplier_name IS NOT NULL
      GROUP BY supplier_name ORDER BY total_purchased DESC
    `, [tid]),

    // Recent supplier payments
    db.query(`SELECT * FROM supplier_payments WHERE tenant_id=$1 ORDER BY payment_date DESC, id DESC LIMIT 30`, [tid]),

    // Distinct supplier names for autocomplete
    db.query(`SELECT DISTINCT supplier_name FROM purchase_receipts WHERE tenant_id=$1 AND supplier_name IS NOT NULL ORDER BY supplier_name`, [tid]),
  ]);

  res.render('accounting/suppliers', {
    tenant: req.tenant, currentUser: req.user,
    ledger: ledgerRes.rows.map(r => ({
      ...r,
      total_purchased: parseFloat(r.total_purchased),
      total_paid: parseFloat(r.total_paid),
      balance: parseFloat(r.total_purchased) - parseFloat(r.total_paid),
    })),
    recentPayments: paymentsRes.rows,
    supplierNames: customersRes.rows.map(r => r.supplier_name),
  });
});

router.post('/suppliers/pay', requireAuth, requireAccounting, async (req, res) => {
  const { supplier_name, amount, payment_date, method, notes } = req.body;
  if (!supplier_name?.trim() || !amount) return res.redirect('/accounting/suppliers');
  await db.query(
    `INSERT INTO supplier_payments (tenant_id,supplier_name,amount,payment_date,method,notes,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.user.tenantId, supplier_name.trim(), parseFloat(amount),
     payment_date || new Date().toISOString().slice(0,10),
     method || 'cash', notes?.trim() || null, req.user.userId]
  );
  res.redirect('/accounting/suppliers');
});

router.post('/suppliers/pay/:id/delete', requireAuth, requireAccounting, async (req, res) => {
  await db.query(`DELETE FROM supplier_payments WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
  res.redirect('/accounting/suppliers');
});

// ── Customer Credits ───────────────────────────────────────────────
router.get('/customers', requireAuth, requireAccounting, async (req, res) => {
  const tid = req.user.tenantId;

  const [creditsRes, customersRes] = await Promise.all([
    db.query(`
      SELECT cc.*,
        COALESCE((SELECT SUM(p.amount) FROM customer_credit_payments p WHERE p.credit_id=cc.id),0) AS paid_total
      FROM customer_credits cc
      WHERE cc.tenant_id=$1
      ORDER BY cc.status ASC, cc.credit_date DESC
    `, [tid]),
    db.query(`SELECT id, name, phone FROM customers WHERE tenant_id=$1 ORDER BY name`, [tid]),
  ]);

  // Recalculate status & amount_paid from payments
  const credits = creditsRes.rows.map(r => ({
    ...r,
    amount: parseFloat(r.amount),
    amount_paid: parseFloat(r.paid_total),
    balance: parseFloat(r.amount) - parseFloat(r.paid_total),
  }));

  const totalReceivable = credits.filter(c => c.status !== 'paid').reduce((s, c) => s + c.balance, 0);

  res.render('accounting/customers', {
    tenant: req.tenant, currentUser: req.user,
    credits, customers: customersRes.rows, totalReceivable,
  });
});

router.post('/customers/credit', requireAuth, requireAccounting, async (req, res) => {
  const { customer_name, customer_id, amount, credit_date, due_date, notes } = req.body;
  if (!customer_name?.trim() || !amount) return res.redirect('/accounting/customers');
  await db.query(
    `INSERT INTO customer_credits (tenant_id,customer_id,customer_name,amount,credit_date,due_date,notes,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [req.user.tenantId, customer_id || null, customer_name.trim(), parseFloat(amount),
     credit_date || new Date().toISOString().slice(0,10),
     due_date || null, notes?.trim() || null, req.user.userId]
  );
  res.redirect('/accounting/customers');
});

router.post('/customers/credit/:id/pay', requireAuth, requireAccounting, async (req, res) => {
  const { amount, payment_date, notes } = req.body;
  const tid = req.user.tenantId;
  if (!amount) return res.redirect('/accounting/customers');

  const paid = parseFloat(amount);
  await db.query(
    `INSERT INTO customer_credit_payments (tenant_id,credit_id,amount,payment_date,notes,created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tid, req.params.id, paid, payment_date || new Date().toISOString().slice(0,10),
     notes?.trim() || null, req.user.userId]
  );

  // Update amount_paid and status on the credit
  await db.query(`
    UPDATE customer_credits SET
      amount_paid = (SELECT COALESCE(SUM(amount),0) FROM customer_credit_payments WHERE credit_id=$1),
      status = CASE
        WHEN (SELECT COALESCE(SUM(amount),0) FROM customer_credit_payments WHERE credit_id=$1) >= amount THEN 'paid'
        WHEN (SELECT COALESCE(SUM(amount),0) FROM customer_credit_payments WHERE credit_id=$1) > 0 THEN 'partial'
        ELSE 'open'
      END
    WHERE id=$1 AND tenant_id=$2
  `, [req.params.id, tid]);

  res.redirect('/accounting/customers');
});

router.post('/customers/credit/:id/delete', requireAuth, requireAccounting, async (req, res) => {
  await db.query(`DELETE FROM customer_credits WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
  res.redirect('/accounting/customers');
});

// ── Cash Flow ──────────────────────────────────────────────────────
router.get('/cashflow', requireAuth, requireAccounting, async (req, res) => {
  const tid = req.user.tenantId;
  const { from, to } = dateRange(req.query);

  const [posRes, suppPayRes, expRes, credPayRes] = await Promise.all([
    // Cash received from POS
    db.query(`
      SELECT pp.created_at::date AS txn_date, pp.amount_paid AS amount,
             'cash_in' AS direction, 'POS Sale' AS category,
             'Order #' || po.id AS description, pp.method
      FROM pos_payments pp
      JOIN pos_orders po ON po.id=pp.order_id
      WHERE po.tenant_id=$1 AND pp.created_at::date BETWEEN $2 AND $3
      ORDER BY pp.created_at DESC
    `, [tid, from, to]),

    // Supplier payments (cash out)
    db.query(`
      SELECT payment_date AS txn_date, amount, 'cash_out' AS direction,
             'Supplier Payment' AS category,
             'Paid to: ' || supplier_name AS description, method
      FROM supplier_payments
      WHERE tenant_id=$1 AND payment_date BETWEEN $2 AND $3
      ORDER BY payment_date DESC, id DESC
    `, [tid, from, to]),

    // Expenses (cash out)
    db.query(`
      SELECT expense_date AS txn_date, amount, 'cash_out' AS direction,
             COALESCE(ec.name,'Expense') AS category,
             e.description, 'cash' AS method
      FROM expenses e LEFT JOIN expense_categories ec ON ec.id=e.category_id
      WHERE e.tenant_id=$1 AND e.expense_date BETWEEN $2 AND $3
      ORDER BY e.expense_date DESC, e.id DESC
    `, [tid, from, to]),

    // Customer credit payments received (cash in)
    db.query(`
      SELECT p.payment_date AS txn_date, p.amount, 'cash_in' AS direction,
             'Credit Payment' AS category,
             'From: ' || cc.customer_name AS description, 'cash' AS method
      FROM customer_credit_payments p
      JOIN customer_credits cc ON cc.id=p.credit_id
      WHERE p.tenant_id=$1 AND p.payment_date BETWEEN $2 AND $3
      ORDER BY p.payment_date DESC, p.id DESC
    `, [tid, from, to]),
  ]);

  // Merge and sort all entries
  const all = [
    ...posRes.rows,
    ...suppPayRes.rows,
    ...expRes.rows,
    ...credPayRes.rows,
  ].sort((a, b) => new Date(b.txn_date) - new Date(a.txn_date));

  const totalIn  = all.filter(r => r.direction === 'cash_in').reduce((s,r) => s + parseFloat(r.amount), 0);
  const totalOut = all.filter(r => r.direction === 'cash_out').reduce((s,r) => s + parseFloat(r.amount), 0);

  res.render('accounting/cashflow', {
    tenant: req.tenant, currentUser: req.user,
    dateFrom: from, dateTo: to,
    entries: all, totalIn, totalOut, net: totalIn - totalOut,
  });
});

// ── Expenses ───────────────────────────────────────────────────────
router.get('/expenses', requireAuth, requireAccounting, async (req, res) => {
  const tid = req.user.tenantId;
  const { from, to } = dateRange(req.query);

  const [expRes, catsRes] = await Promise.all([
    db.query(`
      SELECT e.*, ec.name AS cat_name, ec.color AS cat_color
      FROM expenses e LEFT JOIN expense_categories ec ON ec.id=e.category_id
      WHERE e.tenant_id=$1 AND e.expense_date BETWEEN $2 AND $3
      ORDER BY e.expense_date DESC, e.id DESC
    `, [tid, from, to]),
    db.query(`SELECT * FROM expense_categories WHERE tenant_id=$1 ORDER BY sort_order,name`, [tid]),
  ]);

  res.render('accounting/expenses', {
    tenant: req.tenant, currentUser: req.user,
    expenses: expRes.rows, categories: catsRes.rows, dateFrom: from, dateTo: to,
    total: expRes.rows.reduce((s, e) => s + parseFloat(e.amount), 0),
  });
});

router.post('/expenses', requireAuth, requireAccounting, async (req, res) => {
  const { description, amount, expense_date, category_id, notes } = req.body;
  if (!description?.trim() || !amount) return res.redirect('/accounting/expenses');
  await db.query(
    `INSERT INTO expenses (tenant_id,description,amount,expense_date,category_id,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.user.tenantId, description.trim(), parseFloat(amount),
     expense_date || new Date().toISOString().slice(0,10), category_id || null,
     notes?.trim() || null, req.user.userId]
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

// ── Tax Rates ─────────────────────────────────────────────────────────────────
router.get('/tax', requireAuth, requireAccounting, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const taxRes = await db.query('SELECT * FROM tax_rates WHERE tenant_id=$1 ORDER BY name', [tid]);
    res.render('accounting/tax', { tenant: req.tenant, currentUser: req.user, taxRates: taxRes.rows });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

router.post('/tax', requireAuth, requireAccounting, async (req, res) => {
  const { name, rate, description } = req.body;
  try {
    await db.query(`INSERT INTO tax_rates (tenant_id,name,rate,description) VALUES ($1,$2,$3,$4)`,
      [req.user.tenantId, name, parseFloat(rate)||0, description||null]);
    res.redirect('/accounting/tax');
  } catch (err) { console.error(err); res.redirect('/accounting/tax?error=' + encodeURIComponent(err.message)); }
});

router.post('/tax/:id/edit', requireAuth, requireAccounting, async (req, res) => {
  const { name, rate, description, is_active } = req.body;
  try {
    await db.query(`UPDATE tax_rates SET name=$1,rate=$2,description=$3,is_active=$4 WHERE id=$5 AND tenant_id=$6`,
      [name, parseFloat(rate)||0, description||null, is_active === '1', req.params.id, req.user.tenantId]);
    res.redirect('/accounting/tax');
  } catch (err) { console.error(err); res.redirect('/accounting/tax?error=' + encodeURIComponent(err.message)); }
});

router.post('/tax/:id/delete', requireAuth, requireAccounting, async (req, res) => {
  await db.query('DELETE FROM tax_rates WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
  res.redirect('/accounting/tax');
});

// ── Budgets ───────────────────────────────────────────────────────────────────
router.get('/budgets', requireAuth, requireAccounting, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const budgetsRes = await db.query(`SELECT b.*,
        COALESCE((SELECT SUM(planned) FROM budget_lines WHERE budget_id=b.id),0) AS total_planned
      FROM budgets b WHERE b.tenant_id=$1 ORDER BY b.start_date DESC`, [tid]);
    res.render('accounting/budgets', { tenant: req.tenant, currentUser: req.user, budgets: budgetsRes.rows });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

router.post('/budgets', requireAuth, requireAccounting, async (req, res) => {
  const { name, period_type, start_date, end_date, notes } = req.body;
  try {
    await db.query(`INSERT INTO budgets (tenant_id,name,period_type,start_date,end_date,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.user.tenantId, name, period_type||'monthly', start_date, end_date, notes||null, req.user.userId]);
    res.redirect('/accounting/budgets');
  } catch (err) { console.error(err); res.redirect('/accounting/budgets?error=' + encodeURIComponent(err.message)); }
});

router.post('/budgets/:id/delete', requireAuth, requireAccounting, async (req, res) => {
  await db.query('DELETE FROM budgets WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
  res.redirect('/accounting/budgets');
});

router.get('/budgets/:id', requireAuth, requireAccounting, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [budgetRes, linesRes] = await Promise.all([
      db.query('SELECT * FROM budgets WHERE id=$1 AND tenant_id=$2', [req.params.id, tid]),
      db.query('SELECT * FROM budget_lines WHERE budget_id=$1 ORDER BY category', [req.params.id]),
    ]);
    if (!budgetRes.rows[0]) return res.redirect('/accounting/budgets');
    const budget = budgetRes.rows[0];

    // Get actuals for budget period
    const actualsRes = await db.query(`SELECT
        ec.name AS category,
        COALESCE(SUM(e.amount),0) AS actual
      FROM expenses e LEFT JOIN expense_categories ec ON ec.id=e.category_id
      WHERE e.tenant_id=$1 AND e.expense_date BETWEEN $2 AND $3
      GROUP BY ec.name`, [tid, budget.start_date, budget.end_date]);

    const actualsMap = {};
    actualsRes.rows.forEach(a => { actualsMap[a.category || 'Uncategorized'] = parseFloat(a.actual); });

    res.render('accounting/budget-detail', {
      tenant: req.tenant, currentUser: req.user,
      budget, lines: linesRes.rows, actualsMap,
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

router.post('/budgets/:id/lines', requireAuth, requireAccounting, async (req, res) => {
  const { category, planned, notes } = req.body;
  try {
    await db.query(`INSERT INTO budget_lines (budget_id,category,planned,notes) VALUES ($1,$2,$3,$4)`,
      [req.params.id, category, parseFloat(planned)||0, notes||null]);
    res.redirect('/accounting/budgets/' + req.params.id);
  } catch (err) { console.error(err); res.redirect('/accounting/budgets/' + req.params.id + '?error=' + encodeURIComponent(err.message)); }
});

router.post('/budgets/:id/lines/:lid/delete', requireAuth, requireAccounting, async (req, res) => {
  await db.query('DELETE FROM budget_lines WHERE id=$1', [req.params.lid]);
  res.redirect('/accounting/budgets/' + req.params.id);
});

module.exports = router;
