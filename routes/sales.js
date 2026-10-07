const express = require('express');
const router  = express.Router();
const db      = require('../db');
const requireAuth = require('../middleware/auth');

async function requireSales(req, res, next) {
  try {
    const r = await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId]);
    const tenant = r.rows[0];
    if (!tenant) return res.status(404).send('Not found');
    req.tenant = tenant;
    next();
  } catch (err) { res.status(500).send('Server error'); }
}

function dateRange(q) {
  const now  = new Date();
  const from = q.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to   = q.to   || new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  return { from, to };
}

// ── Dashboard ─────────────────────────────────────────────────────
router.get('/', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  const { from, to } = dateRange(req.query);
  try {
    const [quotRes, invRes, retRes, custRes, recentQRes, recentInvRes] = await Promise.all([
      db.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS total FROM quotations WHERE tenant_id=$1 AND quotation_date BETWEEN $2 AND $3`, [tid, from, to]),
      db.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS total, COALESCE(SUM(paid_amount),0) AS paid FROM sales_invoices WHERE tenant_id=$1 AND invoice_date BETWEEN $2 AND $3`, [tid, from, to]),
      db.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS total FROM sales_returns WHERE tenant_id=$1 AND return_date BETWEEN $2 AND $3`, [tid, from, to]),
      db.query(`SELECT COUNT(*) AS cnt FROM customers WHERE tenant_id=$1`, [tid]),
      db.query(`SELECT id, quotation_no, customer_name, total, status, quotation_date FROM quotations WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 5`, [tid]),
      db.query(`SELECT id, invoice_no, customer_name, total, paid_amount, status, invoice_date FROM sales_invoices WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 5`, [tid]),
    ]);
    const kpi = {
      quotations: { cnt: parseInt(quotRes.rows[0].cnt)||0, total: parseFloat(quotRes.rows[0].total)||0 },
      invoices:   { cnt: parseInt(invRes.rows[0].cnt)||0, total: parseFloat(invRes.rows[0].total)||0, paid: parseFloat(invRes.rows[0].paid)||0 },
      returns:    { cnt: parseInt(retRes.rows[0].cnt)||0, total: parseFloat(retRes.rows[0].total)||0 },
      customers:  parseInt(custRes.rows[0].cnt)||0,
    };
    res.render('sales/home', {
      tenant: req.tenant, currentUser: req.user,
      kpi, from, to,
      recentQuotations: recentQRes.rows,
      recentInvoices: recentInvRes.rows,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

// ── Quotations ────────────────────────────────────────────────────
router.get('/quotations', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  const { from, to } = dateRange(req.query);
  const status = req.query.status || '';
  try {
    let q = `SELECT qt.*, u.email AS created_by_name FROM quotations qt LEFT JOIN users u ON u.id=qt.created_by WHERE qt.tenant_id=$1 AND qt.quotation_date BETWEEN $2 AND $3`;
    const params = [tid, from, to];
    if (status) { q += ` AND qt.status=$${params.length+1}`; params.push(status); }
    q += ` ORDER BY qt.created_at DESC`;
    const [rows, menuRes] = await Promise.all([
      db.query(q, params),
      db.query(`SELECT id, name, price::numeric FROM menu_items WHERE tenant_id=$1 AND is_available=true ORDER BY name`, [tid]),
    ]);
    res.render('sales/quotations', {
      tenant: req.tenant, currentUser: req.user,
      quotations: rows.rows, menuItems: menuRes.rows,
      from, to, status,
      success: req.query.success, error: req.query.error,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

router.post('/quotations', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  const { customer_name, customer_phone, quotation_date, valid_until, discount_pct, tax_pct, notes } = req.body;
  try {
    const items = [];
    const names  = [].concat(req.body['item_name[]']  || []);
    const qtys   = [].concat(req.body['item_qty[]']   || []);
    const prices = [].concat(req.body['item_price[]'] || []);
    for (let i = 0; i < names.length; i++) {
      if (!names[i]) continue;
      items.push({ name: names[i], qty: parseFloat(qtys[i])||1, price: parseFloat(prices[i])||0 });
    }
    const subtotal = items.reduce((s,it) => s + it.qty*it.price, 0);
    const disc = parseFloat(discount_pct)||0;
    const tax  = parseFloat(tax_pct)||0;
    const total = subtotal * (1 - disc/100) * (1 + tax/100);
    const cntRes = await db.query(`SELECT COUNT(*)+1 AS n FROM quotations WHERE tenant_id=$1`, [tid]);
    const qNo = `QT-${String(cntRes.rows[0].n).padStart(4,'0')}`;
    await db.query(`INSERT INTO quotations (tenant_id,quotation_no,customer_name,customer_phone,quotation_date,valid_until,items,subtotal,discount_pct,tax_pct,total,notes,created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [tid, qNo, customer_name, customer_phone, quotation_date||new Date().toISOString().slice(0,10),
       valid_until||null, JSON.stringify(items), subtotal.toFixed(2), disc, tax, total.toFixed(2), notes, req.user.userId]);
    res.redirect('/sales/quotations?success=Quotation+created');
  } catch(err){ console.error(err); res.redirect('/sales/quotations?error='+encodeURIComponent(err.message)); }
});

router.get('/quotations/:id', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const r = await db.query(`SELECT qt.*, u.email AS created_by_name FROM quotations qt LEFT JOIN users u ON u.id=qt.created_by WHERE qt.id=$1 AND qt.tenant_id=$2`, [req.params.id, tid]);
    if (!r.rows.length) return res.redirect('/sales/quotations');
    res.render('sales/quotation-view', {
      tenant: req.tenant, currentUser: req.user,
      q: r.rows[0], success: req.query.success, error: req.query.error,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

router.post('/quotations/:id/status', requireAuth, requireSales, async (req, res) => {
  await db.query(`UPDATE quotations SET status=$1 WHERE id=$2 AND tenant_id=$3`, [req.body.status, req.params.id, req.user.tenantId]);
  res.redirect(`/sales/quotations/${req.params.id}?success=Status+updated`);
});

router.post('/quotations/:id/delete', requireAuth, requireSales, async (req, res) => {
  await db.query(`DELETE FROM quotations WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
  res.redirect('/sales/quotations?success=Deleted');
});

// ── Invoices ──────────────────────────────────────────────────────
router.get('/invoices', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  const { from, to } = dateRange(req.query);
  const status = req.query.status || '';
  try {
    let q = `SELECT si.*, u.email AS created_by_name FROM sales_invoices si LEFT JOIN users u ON u.id=si.created_by WHERE si.tenant_id=$1 AND si.invoice_date BETWEEN $2 AND $3`;
    const params = [tid, from, to];
    if (status) { q += ` AND si.status=$${params.length+1}`; params.push(status); }
    q += ` ORDER BY si.created_at DESC`;
    const [rows, menuRes] = await Promise.all([
      db.query(q, params),
      db.query(`SELECT id, name, price::numeric FROM menu_items WHERE tenant_id=$1 AND is_available=true ORDER BY name`, [tid]),
    ]);
    const kpi = {
      total: rows.rows.reduce((s,r)=>s+parseFloat(r.total||0),0),
      paid:  rows.rows.reduce((s,r)=>s+parseFloat(r.paid_amount||0),0),
      unpaid: rows.rows.filter(r=>r.status!=='paid').reduce((s,r)=>s+(parseFloat(r.total||0)-parseFloat(r.paid_amount||0)),0),
      overdue: rows.rows.filter(r=>r.status==='overdue'||( r.due_date && new Date(r.due_date)<new Date() && r.status!=='paid')).length,
    };
    res.render('sales/invoices', {
      tenant: req.tenant, currentUser: req.user,
      invoices: rows.rows, menuItems: menuRes.rows,
      from, to, status, kpi,
      success: req.query.success, error: req.query.error,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

router.post('/invoices', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  const { customer_name, customer_phone, invoice_date, due_date, discount_pct, tax_pct, notes } = req.body;
  try {
    const items = [];
    const names  = [].concat(req.body['item_name[]']  || []);
    const qtys   = [].concat(req.body['item_qty[]']   || []);
    const prices = [].concat(req.body['item_price[]'] || []);
    for (let i = 0; i < names.length; i++) {
      if (!names[i]) continue;
      items.push({ name: names[i], qty: parseFloat(qtys[i])||1, price: parseFloat(prices[i])||0 });
    }
    const subtotal = items.reduce((s,it) => s + it.qty*it.price, 0);
    const disc = parseFloat(discount_pct)||0;
    const tax  = parseFloat(tax_pct)||0;
    const total = subtotal * (1 - disc/100) * (1 + tax/100);
    const cntRes = await db.query(`SELECT COUNT(*)+1 AS n FROM sales_invoices WHERE tenant_id=$1`, [tid]);
    const iNo = `INV-${String(cntRes.rows[0].n).padStart(4,'0')}`;
    await db.query(`INSERT INTO sales_invoices (tenant_id,invoice_no,customer_name,customer_phone,invoice_date,due_date,items,subtotal,discount_pct,tax_pct,total,notes,created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [tid, iNo, customer_name, customer_phone, invoice_date||new Date().toISOString().slice(0,10),
       due_date||null, JSON.stringify(items), subtotal.toFixed(2), disc, tax, total.toFixed(2), notes, req.user.userId]);
    res.redirect('/sales/invoices?success=Invoice+created');
  } catch(err){ console.error(err); res.redirect('/sales/invoices?error='+encodeURIComponent(err.message)); }
});

router.get('/invoices/:id', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const r = await db.query(`SELECT si.*, u.email AS created_by_name FROM sales_invoices si LEFT JOIN users u ON u.id=si.created_by WHERE si.id=$1 AND si.tenant_id=$2`, [req.params.id, tid]);
    if (!r.rows.length) return res.redirect('/sales/invoices');
    res.render('sales/invoice-view', {
      tenant: req.tenant, currentUser: req.user,
      invoice: r.rows[0], success: req.query.success, error: req.query.error,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

router.post('/invoices/:id/status', requireAuth, requireSales, async (req, res) => {
  const { status, payment_amount } = req.body;
  const tid = req.user.tenantId;
  try {
    if (payment_amount !== undefined) {
      const cur = await db.query(`SELECT paid_amount, total FROM sales_invoices WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]);
      if (!cur.rows.length) return res.redirect('/sales/invoices');
      const newPaid = parseFloat(cur.rows[0].paid_amount||0) + (parseFloat(payment_amount)||0);
      const total   = parseFloat(cur.rows[0].total||0);
      const newStatus = newPaid >= total ? 'paid' : newPaid > 0 ? 'partial' : 'sent';
      await db.query(`UPDATE sales_invoices SET status=$1, paid_amount=$2 WHERE id=$3 AND tenant_id=$4`, [newStatus, newPaid.toFixed(2), req.params.id, tid]);
    } else {
      const paidFull = status === 'paid';
      if (paidFull) {
        const cur = await db.query(`SELECT total FROM sales_invoices WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]);
        await db.query(`UPDATE sales_invoices SET status=$1, paid_amount=$2 WHERE id=$3 AND tenant_id=$4`, ['paid', parseFloat(cur.rows[0]?.total||0).toFixed(2), req.params.id, tid]);
      } else {
        await db.query(`UPDATE sales_invoices SET status=$1 WHERE id=$2 AND tenant_id=$3`, [status, req.params.id, tid]);
      }
    }
    res.redirect(`/sales/invoices/${req.params.id}?success=Updated`);
  } catch(err){ console.error(err); res.redirect(`/sales/invoices/${req.params.id}?error=`+encodeURIComponent(err.message)); }
});

router.post('/invoices/:id/delete', requireAuth, requireSales, async (req, res) => {
  await db.query(`DELETE FROM sales_invoices WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
  res.redirect('/sales/invoices?success=Deleted');
});

// ── Sales Returns ─────────────────────────────────────────────────
router.get('/returns', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  const { from, to } = dateRange(req.query);
  try {
    const [retRes, ordersRes] = await Promise.all([
      db.query(`SELECT r.*, u.email AS created_by_name FROM sales_returns r LEFT JOIN users u ON u.id=r.created_by WHERE r.tenant_id=$1 AND r.return_date BETWEEN $2 AND $3 ORDER BY r.created_at DESC`, [tid, from, to]),
      db.query(`SELECT po.id, po.table_name, po.paid_at, po.total,
                       json_agg(json_build_object('name',mi.name,'qty',poi.quantity,'price',poi.price)) AS items
                FROM pos_orders po JOIN pos_order_items poi ON poi.order_id=po.id JOIN menu_items mi ON mi.id=poi.menu_item_id
                WHERE po.tenant_id=$1 AND po.status='paid' GROUP BY po.id ORDER BY po.paid_at DESC LIMIT 100`, [tid]),
    ]);
    const kpi = {
      total: retRes.rows.reduce((s,r)=>s+parseFloat(r.total||0),0),
      count: retRes.rows.length,
    };
    res.render('sales/returns', {
      tenant: req.tenant, currentUser: req.user,
      returns: retRes.rows, recentOrders: ordersRes.rows,
      from, to, kpi, success: req.query.success, error: req.query.error,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

router.post('/returns', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  const { customer_name, return_date, pos_order_id, reason, refund_method } = req.body;
  try {
    const items = [];
    const names  = [].concat(req.body['item_name[]']  || []);
    const qtys   = [].concat(req.body['item_qty[]']   || []);
    const prices = [].concat(req.body['item_price[]'] || []);
    for (let i = 0; i < names.length; i++) {
      if (!names[i]) continue;
      items.push({ name: names[i], qty: parseFloat(qtys[i])||1, price: parseFloat(prices[i])||0 });
    }
    const total = items.reduce((s,it) => s + it.qty*it.price, 0);
    const cntRes = await db.query(`SELECT COUNT(*)+1 AS n FROM sales_returns WHERE tenant_id=$1`, [tid]);
    const rNo = `SR-${String(cntRes.rows[0].n).padStart(4,'0')}`;
    await db.query(`INSERT INTO sales_returns (tenant_id,return_no,return_date,pos_order_id,customer_name,items,total,reason,refund_method,created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tid, rNo, return_date||new Date().toISOString().slice(0,10),
       pos_order_id||null, customer_name, JSON.stringify(items),
       total.toFixed(2), reason, refund_method||'cash', req.user.userId]);
    res.redirect('/sales/returns?success=Return+recorded');
  } catch(err){ console.error(err); res.redirect('/sales/returns?error='+encodeURIComponent(err.message)); }
});

router.post('/returns/:id/delete', requireAuth, requireSales, async (req, res) => {
  await db.query(`DELETE FROM sales_returns WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
  res.redirect('/sales/returns?success=Deleted');
});

// ── Customers ─────────────────────────────────────────────────────
router.get('/customers', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const custRes = await db.query(`
      SELECT c.id, c.name, c.phone, c.email, c.notes,
             COALESCE(inv.invoice_count,0) AS invoice_count,
             COALESCE(inv.total_billed,0) AS total_billed,
             COALESCE(inv.total_paid,0)   AS total_paid,
             COALESCE(cc.credit_balance,0) AS credit_balance
      FROM customers c
      LEFT JOIN (
        SELECT customer_name, COUNT(*) AS invoice_count,
               SUM(total) AS total_billed, SUM(paid_amount) AS total_paid
        FROM sales_invoices WHERE tenant_id=$1 GROUP BY customer_name
      ) inv ON inv.customer_name = c.name
      LEFT JOIN (
        SELECT customer_id, SUM(GREATEST(amount-amount_paid,0)) AS credit_balance
        FROM customer_credits WHERE tenant_id=$1 GROUP BY customer_id
      ) cc ON cc.customer_id = c.id
      WHERE c.tenant_id=$1 ORDER BY c.name`, [tid]);
    const rows = custRes.rows;
    const kpi = {
      totalOwed:   rows.reduce((s,r) => s + Math.max(0, parseFloat(r.total_billed||0)-parseFloat(r.total_paid||0)), 0),
      totalCredit: rows.reduce((s,r) => s + parseFloat(r.credit_balance||0), 0),
      withOpen:    rows.filter(r => parseFloat(r.total_billed||0) > parseFloat(r.total_paid||0)).length,
    };
    res.render('sales/customers', {
      tenant: req.tenant, currentUser: req.user,
      customers: rows, kpi,
      success: req.query.success, error: req.query.error,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

router.post('/customers', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  const { name, phone, email, notes } = req.body;
  if (!name) return res.redirect('/sales/customers?error=Name+required');
  try {
    await db.query(`INSERT INTO customers (tenant_id, name, phone, email, notes) VALUES ($1,$2,$3,$4,$5)`,
      [tid, name, phone||null, email||null, notes||null]);
    res.redirect('/sales/customers?success=Customer+added');
  } catch(err){ console.error(err); res.redirect('/sales/customers?error='+encodeURIComponent(err.message)); }
});

// Redirect old accounting URLs to sales
router.get('/quotations-redirect', (req, res) => res.redirect('/sales/quotations'));

module.exports = router;
