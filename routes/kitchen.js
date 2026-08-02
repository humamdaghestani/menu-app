const express = require('express');
const router  = express.Router();
const db      = require('../db');

// Authenticate using ?token=<kitchen_token> query param or session cookie
async function requireKitchenToken(req, res, next) {
  try {
    const token = req.query.token || req.cookies?.kitchen_token;
    if (!token) return res.redirect('/kitchen/login');
    const r = await db.query('SELECT id, name, currency FROM tenants WHERE kitchen_token=$1 AND is_active=true', [token]);
    if (!r.rows[0]) return res.clearCookie('kitchen_token').redirect('/kitchen/login?error=invalid');
    req.kitchenTenant = r.rows[0];
    if (req.query.token) res.cookie('kitchen_token', token, { httpOnly: true, maxAge: 86400 * 30 * 1000 });
    next();
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
}

// Login page — just shows a PIN/token input
router.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kitchen Display</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',sans-serif;background:#0f0f1a;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{background:#1a1a2e;border:1px solid #2a2a3e;border-radius:16px;padding:40px;width:360px;text-align:center}
h2{color:#fff;font-size:1.4rem;font-weight:800;margin-bottom:8px}p{color:#555;font-size:.85rem;margin-bottom:24px}
input{width:100%;padding:12px;background:#0f0f1a;border:1.5px solid #2a2a3e;border-radius:8px;color:#fff;font-size:1.1rem;font-family:inherit;text-align:center;outline:none;letter-spacing:4px;margin-bottom:16px}
input:focus{border-color:#7c5cbf}
button{width:100%;padding:12px;background:#7c5cbf;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer}
button:hover{opacity:.88}
.err{color:#e74c3c;font-size:.82rem;margin-bottom:14px}
</style></head><body><div class="box">
🍳<h2 style="margin-top:8px">Kitchen Display</h2>
<p>Enter your kitchen token to connect</p>
${req.query.error ? '<div class="err">Invalid token. Try again.</div>' : ''}
<form method="GET" action="/kitchen">
  <input type="text" name="token" placeholder="Token" autofocus />
  <button type="submit">Connect</button>
</form>
</div></body></html>`);
});

// Main KDS display
router.get('/', requireKitchenToken, async (req, res) => {
  const tenantId = req.kitchenTenant.id;
  try {
    // Fetch active (not completed/cancelled) orders with their items
    const ordersRes = await db.query(`
      SELECT o.id, o.table_name AS table_no, o.order_type, o.status, o.created_at,
        EXTRACT(EPOCH FROM (NOW()-o.created_at))/60 AS age_minutes
      FROM pos_orders o
      WHERE o.tenant_id=$1 AND o.status IN ('open','preparing','ready')
        AND o.created_at > NOW() - INTERVAL '6 hours'
      ORDER BY o.created_at ASC
    `, [tenantId]);

    const orders = ordersRes.rows;
    for (const ord of orders) {
      const itemsRes = await db.query(`
        SELECT oi.quantity, oi.name AS item_name,
          CASE WHEN jsonb_array_length(oi.options)>0 THEN (SELECT string_agg(opt->>'name',', ') FROM jsonb_array_elements(oi.options) opt) ELSE NULL END AS modifiers_text,
          oi.notes
        FROM pos_order_items oi
        WHERE oi.order_id=$1
        ORDER BY oi.id
      `, [ord.id]);
      ord.items = itemsRes.rows;
    }

    res.render('kitchen', {
      tenant: req.kitchenTenant,
      orders,
      token: req.query.token || req.cookies?.kitchen_token,
    });
  } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// Mark order status
router.post('/orders/:id/status', requireKitchenToken, async (req, res) => {
  const { status } = req.body;
  const allowed = ['preparing', 'ready', 'completed'];
  if (!allowed.includes(status)) return res.status(400).send('Invalid status');
  const dbStatus = status === 'completed' ? 'paid' : status;
  try {
    await db.query(`UPDATE pos_orders SET status=$1 WHERE id=$2 AND tenant_id=$3`, [dbStatus, req.params.id, req.kitchenTenant.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// JSON poll endpoint for auto-refresh
router.get('/poll', requireKitchenToken, async (req, res) => {
  const tenantId = req.kitchenTenant.id;
  try {
    const ordersRes = await db.query(`
      SELECT o.id, o.table_name AS table_no, o.order_type, o.status, o.created_at,
        EXTRACT(EPOCH FROM (NOW()-o.created_at))/60 AS age_minutes
      FROM pos_orders o
      WHERE o.tenant_id=$1 AND o.status IN ('open','preparing','ready')
        AND o.created_at > NOW() - INTERVAL '6 hours'
      ORDER BY o.created_at ASC
    `, [tenantId]);

    const orders = ordersRes.rows;
    for (const ord of orders) {
      const itemsRes = await db.query(`
        SELECT oi.quantity, oi.name AS item_name,
          CASE WHEN jsonb_array_length(oi.options)>0 THEN (SELECT string_agg(opt->>'name',', ') FROM jsonb_array_elements(oi.options) opt) ELSE NULL END AS modifiers_text,
          oi.notes
        FROM pos_order_items oi WHERE oi.order_id=$1 ORDER BY oi.id
      `, [ord.id]);
      ord.items = itemsRes.rows;
    }
    res.json(orders);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
