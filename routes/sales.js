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

async function maybeSaveCustomer(tid, body) {
  if (body.save_customer !== '1' || !body.customer_name) return;
  const exists = await db.query(`SELECT id FROM customers WHERE tenant_id=$1 AND name=$2 LIMIT 1`, [tid, body.customer_name]);
  if (!exists.rows.length) {
    await db.query(
      `INSERT INTO customers (tenant_id, name, phone, email, address, city) VALUES ($1,$2,$3,$4,$5,$6)`,
      [tid, body.customer_name, body.customer_phone||null, body.customer_email||null, body.customer_address||null, body.customer_city||null]
    );
  }
}

// ── Dashboard ─────────────────────────────────────────────────────
router.get('/', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  const { from, to } = dateRange(req.query);
  try {
    const [quotRes, ordRes, invRes, retRes, custRes, overdueRes, recentQRes, recentOrdRes, recentInvRes] = await Promise.all([
      db.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS total,
                  COUNT(*) FILTER (WHERE status='draft') AS draft,
                  COUNT(*) FILTER (WHERE status='sent') AS sent,
                  COUNT(*) FILTER (WHERE status='accepted') AS accepted
                FROM quotations WHERE tenant_id=$1 AND quotation_date BETWEEN $2 AND $3`, [tid, from, to]),
      db.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS total,
                  COUNT(*) FILTER (WHERE status='confirmed') AS confirmed,
                  COUNT(*) FILTER (WHERE status='processing') AS processing,
                  COUNT(*) FILTER (WHERE status='delivered') AS delivered
                FROM sales_orders WHERE tenant_id=$1 AND order_date BETWEEN $2 AND $3`, [tid, from, to]),
      db.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS total, COALESCE(SUM(paid_amount),0) AS paid
                FROM sales_invoices WHERE tenant_id=$1 AND invoice_date BETWEEN $2 AND $3`, [tid, from, to]),
      db.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS total FROM sales_returns WHERE tenant_id=$1 AND return_date BETWEEN $2 AND $3`, [tid, from, to]),
      db.query(`SELECT COUNT(*) AS cnt FROM customers WHERE tenant_id=$1`, [tid]),
      db.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(total-paid_amount),0) AS amount FROM sales_invoices WHERE tenant_id=$1 AND status != 'paid' AND due_date < CURRENT_DATE`, [tid]),
      db.query(`SELECT id, quotation_no, customer_name, total, status, quotation_date FROM quotations WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 5`, [tid]),
      db.query(`SELECT id, order_no, customer_name, total, status, order_date FROM sales_orders WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 5`, [tid]),
      db.query(`SELECT id, invoice_no, customer_name, total, paid_amount, status, invoice_date FROM sales_invoices WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 5`, [tid]),
    ]);
    const qr = quotRes.rows[0], or = ordRes.rows[0], ir = invRes.rows[0];
    const pipeline = [
      { stage: 'Quotation', label: 'عرض سعر', icon: '📄', cnt: parseInt(qr.cnt)||0, total: parseFloat(qr.total)||0, color: '#60a5fa',
        breakdown: [ {lbl:'Draft', val: parseInt(qr.draft)||0}, {lbl:'Sent', val: parseInt(qr.sent)||0}, {lbl:'Accepted', val: parseInt(qr.accepted)||0} ] },
      { stage: 'Sales Order', label: 'أمر بيع', icon: '📦', cnt: parseInt(or.cnt)||0, total: parseFloat(or.total)||0, color: '#a78bdf',
        breakdown: [ {lbl:'Confirmed', val: parseInt(or.confirmed)||0}, {lbl:'Processing', val: parseInt(or.processing)||0}, {lbl:'Delivered', val: parseInt(or.delivered)||0} ] },
      { stage: 'Invoice', label: 'فاتورة', icon: '🧾', cnt: parseInt(ir.cnt)||0, total: parseFloat(ir.total)||0, color: '#34d399',
        breakdown: [ {lbl:'Issued', val: parseInt(ir.cnt)||0}, {lbl:'Paid', val: 0} ] },
    ];
    const kpi = {
      quotations: { cnt: parseInt(qr.cnt)||0, total: parseFloat(qr.total)||0 },
      orders:     { cnt: parseInt(or.cnt)||0, total: parseFloat(or.total)||0 },
      invoices:   { cnt: parseInt(ir.cnt)||0, total: parseFloat(ir.total)||0, paid: parseFloat(ir.paid)||0 },
      returns:    { cnt: parseInt(retRes.rows[0].cnt)||0, total: parseFloat(retRes.rows[0].total)||0 },
      customers:  parseInt(custRes.rows[0].cnt)||0,
      overdue:    { cnt: parseInt(overdueRes.rows[0].cnt)||0, amount: parseFloat(overdueRes.rows[0].amount)||0 },
    };
    res.render('sales/home', {
      tenant: req.tenant, currentUser: req.user,
      kpi, pipeline, from, to,
      recentQuotations: recentQRes.rows,
      recentOrders: recentOrdRes.rows,
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
    const [rows, menuRes, custRes] = await Promise.all([
      db.query(q, params),
      db.query(`SELECT id, name, price::numeric FROM menu_items WHERE tenant_id=$1 AND is_available=true ORDER BY name`, [tid]),
      db.query(`SELECT id, name, phone, email, address, city, notes FROM customers WHERE tenant_id=$1 ORDER BY name`, [tid]),
    ]);
    res.render('sales/quotations', {
      tenant: req.tenant, currentUser: req.user,
      quotations: rows.rows, menuItems: menuRes.rows, customers: custRes.rows,
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
    await maybeSaveCustomer(tid, req.body);
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

router.post('/quotations/:id/convert', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const r = await db.query(`SELECT * FROM quotations WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]);
    if (!r.rows.length) return res.redirect('/sales/quotations');
    const q = r.rows[0];
    const cntRes = await db.query(`SELECT COUNT(*)+1 AS n FROM sales_orders WHERE tenant_id=$1`, [tid]);
    const oNo = `SO-${String(cntRes.rows[0].n).padStart(4,'0')}`;
    const result = await db.query(
      `INSERT INTO sales_orders (tenant_id,order_no,quotation_id,customer_name,customer_phone,order_date,items,subtotal,discount_pct,tax_pct,total,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [tid, oNo, q.id, q.customer_name, q.customer_phone, q.items, q.subtotal, q.discount_pct, q.tax_pct, q.total, q.notes, req.user.userId]
    );
    await db.query(`UPDATE quotations SET status='accepted' WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]);
    res.redirect(`/sales/orders/${result.rows[0].id}?success=Sales+order+created+from+quotation`);
  } catch(err){ console.error(err); res.redirect(`/sales/quotations/${req.params.id}?error=`+encodeURIComponent(err.message)); }
});

// ── Sales Orders ──────────────────────────────────────────────────
router.get('/orders', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  const { from, to } = dateRange(req.query);
  const status = req.query.status || '';
  try {
    let q = `SELECT so.*, u.email AS created_by_name FROM sales_orders so LEFT JOIN users u ON u.id=so.created_by WHERE so.tenant_id=$1 AND so.order_date BETWEEN $2 AND $3`;
    const params = [tid, from, to];
    if (status) { q += ` AND so.status=$${params.length+1}`; params.push(status); }
    q += ` ORDER BY so.created_at DESC`;
    const [rows, menuRes, custRes] = await Promise.all([
      db.query(q, params),
      db.query(`SELECT id, name, price::numeric FROM menu_items WHERE tenant_id=$1 AND is_available=true ORDER BY name`, [tid]),
      db.query(`SELECT id, name, phone, email, address, city, notes FROM customers WHERE tenant_id=$1 ORDER BY name`, [tid]),
    ]);
    const kpi = {
      total: rows.rows.reduce((s,r)=>s+parseFloat(r.total||0),0),
      confirmed: rows.rows.filter(r=>r.status==='confirmed').length,
      processing: rows.rows.filter(r=>r.status==='processing').length,
      delivered: rows.rows.filter(r=>r.status==='delivered').length,
    };
    res.render('sales/orders', {
      tenant: req.tenant, currentUser: req.user,
      orders: rows.rows, menuItems: menuRes.rows, customers: custRes.rows,
      from, to, status, kpi,
      success: req.query.success, error: req.query.error,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

router.post('/orders', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  const { customer_name, customer_phone, order_date, delivery_date, discount_pct, tax_pct, notes } = req.body;
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
    const disc = parseFloat(discount_pct)||0, tax = parseFloat(tax_pct)||0;
    const total = subtotal * (1 - disc/100) * (1 + tax/100);
    const cntRes = await db.query(`SELECT COUNT(*)+1 AS n FROM sales_orders WHERE tenant_id=$1`, [tid]);
    const oNo = `SO-${String(cntRes.rows[0].n).padStart(4,'0')}`;
    await db.query(
      `INSERT INTO sales_orders (tenant_id,order_no,customer_name,customer_phone,order_date,delivery_date,items,subtotal,discount_pct,tax_pct,total,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [tid, oNo, customer_name, customer_phone, order_date||new Date().toISOString().slice(0,10),
       delivery_date||null, JSON.stringify(items), subtotal.toFixed(2), disc, tax, total.toFixed(2), notes, req.user.userId]
    );
    await maybeSaveCustomer(tid, req.body);
    res.redirect('/sales/orders?success=Sales+order+created');
  } catch(err){ console.error(err); res.redirect('/sales/orders?error='+encodeURIComponent(err.message)); }
});

router.get('/orders/:id', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [r, invRes] = await Promise.all([
      db.query(`SELECT so.*, u.email AS created_by_name, q.quotation_no FROM sales_orders so LEFT JOIN users u ON u.id=so.created_by LEFT JOIN quotations q ON q.id=so.quotation_id WHERE so.id=$1 AND so.tenant_id=$2`, [req.params.id, tid]),
      db.query(`SELECT id, invoice_no, total, paid_amount, status FROM sales_invoices WHERE sales_order_id=$1`, [req.params.id]),
    ]);
    if (!r.rows.length) return res.redirect('/sales/orders');
    res.render('sales/order-view', {
      tenant: req.tenant, currentUser: req.user,
      order: r.rows[0], invoices: invRes.rows,
      success: req.query.success, error: req.query.error,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

router.post('/orders/:id/status', requireAuth, requireSales, async (req, res) => {
  await db.query(`UPDATE sales_orders SET status=$1 WHERE id=$2 AND tenant_id=$3`, [req.body.status, req.params.id, req.user.tenantId]);
  res.redirect(`/sales/orders/${req.params.id}?success=Status+updated`);
});

router.post('/orders/:id/invoice', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const r = await db.query(`SELECT * FROM sales_orders WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]);
    if (!r.rows.length) return res.redirect('/sales/orders');
    const o = r.rows[0];
    const cntRes = await db.query(`SELECT COUNT(*)+1 AS n FROM sales_invoices WHERE tenant_id=$1`, [tid]);
    const iNo = `INV-${String(cntRes.rows[0].n).padStart(4,'0')}`;
    const result = await db.query(
      `INSERT INTO sales_invoices (tenant_id,invoice_no,sales_order_id,customer_name,customer_phone,invoice_date,items,subtotal,discount_pct,tax_pct,total,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [tid, iNo, o.id, o.customer_name, o.customer_phone, o.items, o.subtotal, o.discount_pct, o.tax_pct, o.total, o.notes, req.user.userId]
    );
    await db.query(`UPDATE sales_orders SET status='invoiced' WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]);
    res.redirect(`/sales/invoices/${result.rows[0].id}?success=Invoice+created+from+order`);
  } catch(err){ console.error(err); res.redirect(`/sales/orders/${req.params.id}?error=`+encodeURIComponent(err.message)); }
});

router.post('/orders/:id/delete', requireAuth, requireSales, async (req, res) => {
  await db.query(`DELETE FROM sales_orders WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
  res.redirect('/sales/orders?success=Deleted');
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
    const [rows, menuRes, custRes] = await Promise.all([
      db.query(q, params),
      db.query(`SELECT id, name, price::numeric FROM menu_items WHERE tenant_id=$1 AND is_available=true ORDER BY name`, [tid]),
      db.query(`SELECT id, name, phone, email, address, city, notes FROM customers WHERE tenant_id=$1 ORDER BY name`, [tid]),
    ]);
    const kpi = {
      total: rows.rows.reduce((s,r)=>s+parseFloat(r.total||0),0),
      paid:  rows.rows.reduce((s,r)=>s+parseFloat(r.paid_amount||0),0),
      unpaid: rows.rows.filter(r=>r.status!=='paid').reduce((s,r)=>s+(parseFloat(r.total||0)-parseFloat(r.paid_amount||0)),0),
      overdue: rows.rows.filter(r=>r.status==='overdue'||( r.due_date && new Date(r.due_date)<new Date() && r.status!=='paid')).length,
    };
    res.render('sales/invoices', {
      tenant: req.tenant, currentUser: req.user,
      invoices: rows.rows, menuItems: menuRes.rows, customers: custRes.rows,
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
    await maybeSaveCustomer(tid, req.body);
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

router.get('/customers/:id', requireAuth, requireSales, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [custRes, invRes, quotRes] = await Promise.all([
      db.query(`SELECT * FROM customers WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]),
      db.query(`SELECT * FROM sales_invoices WHERE tenant_id=$1 AND customer_name=(SELECT name FROM customers WHERE id=$2 AND tenant_id=$1) ORDER BY created_at DESC`, [tid, req.params.id]),
      db.query(`SELECT * FROM quotations WHERE tenant_id=$1 AND customer_name=(SELECT name FROM customers WHERE id=$2 AND tenant_id=$1) ORDER BY created_at DESC`, [tid, req.params.id]),
    ]);
    if (!custRes.rows.length) return res.redirect('/sales/customers');
    res.render('sales/customer-view', {
      tenant: req.tenant, currentUser: req.user,
      customer: custRes.rows[0],
      invoices: invRes.rows,
      quotations: quotRes.rows,
      success: req.query.success,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

// Redirect old accounting URLs to sales
router.get('/quotations-redirect', (req, res) => res.redirect('/sales/quotations'));

module.exports = router;
