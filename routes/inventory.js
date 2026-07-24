const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAuth = require('../middleware/auth');

async function requireInventory(req, res, next) {
  try {
    const r = await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId]);
    const tenant = r.rows[0];
    if (!tenant) return res.status(404).send('Tenant not found');
    if (!tenant.feat_inventory) return res.status(403).send('Inventory module not enabled for this account.');
    const isAdmin = req.user.role === 'admin';
    const perms = Array.isArray(req.user.permissions)
      ? req.user.permissions
      : JSON.parse(req.user.permissions || '[]');
    if (!isAdmin && !perms.includes('access_inventory')) return res.status(403).send('Access denied');
    req.tenant = tenant;
    next();
  } catch (err) { console.error('[inventory]', err.message); res.status(500).send('Server error: ' + err.message); }
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
router.get('/', requireAuth, requireInventory, async (req, res) => {
  try {
    const tid = req.user.tenantId;

    const [stockRes, lowStockRes, purchasesRes, recentTxRes] = await Promise.all([
      db.query(`SELECT COUNT(*) AS cnt, SUM(stock_qty * avg_cost) AS total_value FROM inventory_items WHERE tenant_id=$1 AND is_active=true`, [tid]),
      db.query(`SELECT * FROM inventory_items WHERE tenant_id=$1 AND is_active=true AND reorder_level > 0 AND stock_qty <= reorder_level ORDER BY (stock_qty - reorder_level) ASC LIMIT 10`, [tid]),
      db.query(`SELECT pr.*, u.name AS created_by_name FROM purchase_receipts pr LEFT JOIN users u ON u.id=pr.created_by WHERE pr.tenant_id=$1 ORDER BY pr.created_at DESC LIMIT 5`, [tid]),
      db.query(`SELECT it.*, ii.name AS item_name, ii.unit FROM inventory_transactions it LEFT JOIN inventory_items ii ON ii.id=it.item_id WHERE it.tenant_id=$1 ORDER BY it.created_at DESC LIMIT 15`, [tid]),
    ]);

    res.render('inventory/home', {
      tenant: req.tenant,
      currentUser: req.user,
      totalItems: parseInt(stockRes.rows[0].cnt) || 0,
      totalValue: parseFloat(stockRes.rows[0].total_value) || 0,
      lowStock: lowStockRes.rows,
      recentPurchases: purchasesRes.rows,
      recentTx: recentTxRes.rows,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Items catalog ──────────────────────────────────────────────────────────────
router.get('/items', requireAuth, requireInventory, async (req, res) => {
  try {
    const tid = req.user.tenantId;
    const type = req.query.type || 'all';
    const whereType = type !== 'all' ? `AND ii.type=$2` : '';
    const params = type !== 'all' ? [tid, type] : [tid];

    const [itemsRes, menuItemsRes] = await Promise.all([
      db.query(`
        SELECT ii.*, mi.name AS menu_item_name,
          ROUND((SELECT COALESCE(SUM(ir.quantity * ing.avg_cost),0) FROM inventory_recipes ir
                 JOIN inventory_items ing ON ing.id=ir.ingredient_id
                 WHERE ir.item_id=ii.id),4) AS recipe_cost,
          (SELECT COUNT(*) FROM inventory_recipes WHERE item_id=ii.id) AS recipe_lines
        FROM inventory_items ii
        LEFT JOIN menu_items mi ON mi.id=ii.menu_item_id
        WHERE ii.tenant_id=$1 ${whereType} AND ii.is_active=true
        ORDER BY ii.type, ii.name
      `, params),
      db.query(`SELECT id, name FROM menu_items WHERE tenant_id=$1 AND is_available=true ORDER BY name`, [tid]),
    ]);

    res.render('inventory/items', {
      tenant: req.tenant,
      currentUser: req.user,
      items: itemsRes.rows,
      menuItems: menuItemsRes.rows,
      activeType: type,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// Create item
router.post('/items', requireAuth, requireInventory, async (req, res) => {
  const { name, sku, type, unit, reorder_level, menu_item_id } = req.body;
  try {
    await db.query(
      `INSERT INTO inventory_items (tenant_id, name, sku, type, unit, reorder_level, menu_item_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.user.tenantId, name.trim(), sku?.trim() || null, type || 'raw_material', unit || 'pcs',
       parseFloat(reorder_level) || 0, menu_item_id || null]
    );
    res.redirect('/inventory/items?type=' + (type || 'raw_material'));
  } catch (err) { console.error(err); res.redirect('/inventory/items?error=' + encodeURIComponent(err.message)); }
});

// Edit item
router.post('/items/:id/edit', requireAuth, requireInventory, async (req, res) => {
  const { name, sku, unit, reorder_level, menu_item_id } = req.body;
  try {
    await db.query(
      `UPDATE inventory_items SET name=$1, sku=$2, unit=$3, reorder_level=$4, menu_item_id=$5
       WHERE id=$6 AND tenant_id=$7`,
      [name.trim(), sku?.trim() || null, unit || 'pcs', parseFloat(reorder_level) || 0,
       menu_item_id || null, req.params.id, req.user.tenantId]
    );
    res.redirect('/inventory/items');
  } catch (err) { console.error(err); res.redirect('/inventory/items?error=' + encodeURIComponent(err.message)); }
});

// Delete item
router.post('/items/:id/delete', requireAuth, requireInventory, async (req, res) => {
  try {
    await db.query(`UPDATE inventory_items SET is_active=false WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
    res.redirect('/inventory/items');
  } catch (err) { console.error(err); res.redirect('/inventory/items'); }
});

// Stock adjustment
router.post('/items/:id/adjust', requireAuth, requireInventory, async (req, res) => {
  const { qty_change, notes } = req.body;
  const delta = parseFloat(qty_change);
  if (isNaN(delta) || delta === 0) return res.redirect('/inventory/items');
  try {
    await db.query(`UPDATE inventory_items SET stock_qty = stock_qty + $1 WHERE id=$2 AND tenant_id=$3`, [delta, req.params.id, req.user.tenantId]);
    await db.query(
      `INSERT INTO inventory_transactions (tenant_id, item_id, type, qty_change, notes, created_by)
       VALUES ($1,$2,'adjustment',$3,$4,$5)`,
      [req.user.tenantId, req.params.id, delta, notes?.trim() || null, req.user.userId]
    );
    res.redirect('/inventory/items');
  } catch (err) { console.error(err); res.redirect('/inventory/items'); }
});

// ── Recipe builder ─────────────────────────────────────────────────────────────
router.get('/items/:id/recipe', requireAuth, requireInventory, async (req, res) => {
  try {
    const tid = req.user.tenantId;
    const [itemRes, recipeRes, ingredientsRes] = await Promise.all([
      db.query(`SELECT * FROM inventory_items WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]),
      db.query(`
        SELECT ir.*, ii.name AS ingredient_name, ii.unit, ii.avg_cost,
               ROUND(ir.quantity * ii.avg_cost, 4) AS line_cost
        FROM inventory_recipes ir
        JOIN inventory_items ii ON ii.id = ir.ingredient_id
        WHERE ir.item_id=$1 ORDER BY ii.name
      `, [req.params.id]),
      db.query(`SELECT id, name, unit, avg_cost FROM inventory_items WHERE tenant_id=$1 AND is_active=true AND id != $2 ORDER BY name`, [tid, req.params.id]),
    ]);
    if (!itemRes.rows[0]) return res.status(404).send('Item not found');
    const totalCost = recipeRes.rows.reduce((s, r) => s + parseFloat(r.line_cost), 0);
    res.render('inventory/recipe', {
      tenant: req.tenant,
      currentUser: req.user,
      item: itemRes.rows[0],
      recipe: recipeRes.rows,
      ingredients: ingredientsRes.rows,
      totalCost,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// Add recipe line
router.post('/items/:id/recipe', requireAuth, requireInventory, async (req, res) => {
  const { ingredient_id, quantity } = req.body;
  try {
    await db.query(
      `INSERT INTO inventory_recipes (item_id, ingredient_id, quantity) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [req.params.id, ingredient_id, parseFloat(quantity)]
    );
    res.redirect('/inventory/items/' + req.params.id + '/recipe');
  } catch (err) { console.error(err); res.redirect('/inventory/items/' + req.params.id + '/recipe'); }
});

// Update recipe line quantity
router.post('/items/:id/recipe/:lineId/edit', requireAuth, requireInventory, async (req, res) => {
  const { quantity } = req.body;
  try {
    await db.query(`UPDATE inventory_recipes SET quantity=$1 WHERE id=$2`, [parseFloat(quantity), req.params.lineId]);
    res.redirect('/inventory/items/' + req.params.id + '/recipe');
  } catch (err) { console.error(err); res.redirect('/inventory/items/' + req.params.id + '/recipe'); }
});

// Delete recipe line
router.post('/items/:id/recipe/:lineId/delete', requireAuth, requireInventory, async (req, res) => {
  try {
    await db.query(`DELETE FROM inventory_recipes WHERE id=$1`, [req.params.lineId]);
    res.redirect('/inventory/items/' + req.params.id + '/recipe');
  } catch (err) { console.error(err); res.redirect('/inventory/items/' + req.params.id + '/recipe'); }
});

// ── Purchase receipts ──────────────────────────────────────────────────────────
router.get('/purchases', requireAuth, requireInventory, async (req, res) => {
  try {
    const receipts = await db.query(
      `SELECT pr.*, u.name AS created_by_name,
              COUNT(prl.id) AS line_count
       FROM purchase_receipts pr
       LEFT JOIN users u ON u.id=pr.created_by
       LEFT JOIN purchase_receipt_lines prl ON prl.receipt_id=pr.id
       WHERE pr.tenant_id=$1
       GROUP BY pr.id, u.name
       ORDER BY pr.created_at DESC`,
      [req.user.tenantId]
    );
    res.render('inventory/purchases', {
      tenant: req.tenant,
      currentUser: req.user,
      receipts: receipts.rows,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.get('/purchases/new', requireAuth, requireInventory, async (req, res) => {
  try {
    const rawItems = await db.query(
      `SELECT id, name, unit, avg_cost FROM inventory_items WHERE tenant_id=$1 AND is_active=true ORDER BY name`,
      [req.user.tenantId]
    );
    res.render('inventory/purchase-new', {
      tenant: req.tenant,
      currentUser: req.user,
      rawItems: rawItems.rows,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.get('/purchases/:id', requireAuth, requireInventory, async (req, res) => {
  try {
    const [receiptRes, linesRes] = await Promise.all([
      db.query(`SELECT pr.*, u.name AS created_by_name FROM purchase_receipts pr LEFT JOIN users u ON u.id=pr.created_by WHERE pr.id=$1 AND pr.tenant_id=$2`, [req.params.id, req.user.tenantId]),
      db.query(`SELECT prl.*, ii.name AS item_name, ii.unit FROM purchase_receipt_lines prl JOIN inventory_items ii ON ii.id=prl.item_id WHERE prl.receipt_id=$1 ORDER BY ii.name`, [req.params.id]),
    ]);
    if (!receiptRes.rows[0]) return res.status(404).send('Receipt not found');
    res.render('inventory/purchase-view', {
      tenant: req.tenant,
      currentUser: req.user,
      receipt: receiptRes.rows[0],
      lines: linesRes.rows,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// Save new purchase receipt
router.post('/purchases', requireAuth, requireInventory, express.urlencoded({ extended: true }), async (req, res) => {
  const { supplier_name, invoice_no, receipt_date, notes, item_id, quantity, unit_price } = req.body;
  const tid = req.user.tenantId;

  // item_id / quantity / unit_price come as arrays
  const ids     = Array.isArray(item_id)     ? item_id     : [item_id];
  const qtys    = Array.isArray(quantity)    ? quantity    : [quantity];
  const prices  = Array.isArray(unit_price)  ? unit_price  : [unit_price];

  // Filter out empty rows
  const lines = ids.map((id, i) => ({
    item_id: parseInt(id),
    quantity: parseFloat(qtys[i]),
    unit_price: parseFloat(prices[i]),
  })).filter(l => l.item_id && !isNaN(l.quantity) && l.quantity > 0 && !isNaN(l.unit_price) && l.unit_price >= 0);

  if (!lines.length) return res.redirect('/inventory/purchases/new?error=no_lines');

  const total = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const rr = await client.query(
      `INSERT INTO purchase_receipts (tenant_id, supplier_name, invoice_no, receipt_date, total, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [tid, supplier_name?.trim() || null, invoice_no?.trim() || null,
       receipt_date || new Date().toISOString().slice(0, 10), total,
       notes?.trim() || null, req.user.userId]
    );
    const receiptId = rr.rows[0].id;

    for (const l of lines) {
      const lineTotal = l.quantity * l.unit_price;
      await client.query(
        `INSERT INTO purchase_receipt_lines (receipt_id, item_id, quantity, unit_price, total) VALUES ($1,$2,$3,$4,$5)`,
        [receiptId, l.item_id, l.quantity, l.unit_price, lineTotal]
      );

      // Weighted average cost update
      const cur = await client.query(`SELECT stock_qty, avg_cost FROM inventory_items WHERE id=$1`, [l.item_id]);
      const { stock_qty, avg_cost } = cur.rows[0];
      const oldQty = parseFloat(stock_qty) || 0;
      const oldCost = parseFloat(avg_cost) || 0;
      const newQty = oldQty + l.quantity;
      const newCost = newQty > 0 ? (oldQty * oldCost + l.quantity * l.unit_price) / newQty : l.unit_price;

      await client.query(
        `UPDATE inventory_items SET stock_qty=$1, avg_cost=$2 WHERE id=$3`,
        [newQty, newCost, l.item_id]
      );
      await client.query(
        `INSERT INTO inventory_transactions (tenant_id, item_id, type, qty_change, unit_cost, reference_id, reference_type, created_by)
         VALUES ($1,$2,'purchase',$3,$4,$5,'purchase_receipt',$6)`,
        [tid, l.item_id, l.quantity, l.unit_price, receiptId, req.user.userId]
      );
    }

    await client.query('COMMIT');
    res.redirect('/inventory/purchases/' + receiptId);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.redirect('/inventory/purchases/new?error=' + encodeURIComponent(err.message));
  } finally {
    client.release();
  }
});

// ── Stock deduction helper (called from POS pay route) ─────────────────────────
async function deductStockForOrder(tenantId, orderId, userId) {
  try {
    const items = await db.query(`SELECT * FROM pos_order_items WHERE order_id=$1`, [orderId]);
    for (const oi of items.rows) {
      if (!oi.menu_item_id) continue;
      // Find inventory product linked to this menu item
      const invRes = await db.query(
        `SELECT id FROM inventory_items WHERE tenant_id=$1 AND menu_item_id=$2 AND is_active=true LIMIT 1`,
        [tenantId, oi.menu_item_id]
      );
      if (!invRes.rows[0]) continue;
      const invItemId = invRes.rows[0].id;

      // Get recipe
      const recipe = await db.query(`SELECT * FROM inventory_recipes WHERE item_id=$1`, [invItemId]);
      for (const r of recipe.rows) {
        const deduct = parseFloat(r.quantity) * parseInt(oi.quantity);
        await db.query(
          `UPDATE inventory_items SET stock_qty = stock_qty - $1 WHERE id=$2 AND tenant_id=$3`,
          [deduct, r.ingredient_id, tenantId]
        );
        await db.query(
          `INSERT INTO inventory_transactions (tenant_id, item_id, type, qty_change, reference_id, reference_type, created_by)
           VALUES ($1,$2,'sale',$3,$4,'pos_order',$5)`,
          [tenantId, r.ingredient_id, -deduct, orderId, userId]
        );
      }
    }
  } catch (err) {
    console.error('[inventory] deductStockForOrder error:', err.message);
  }
}

module.exports = router;
module.exports.deductStockForOrder = deductStockForOrder;
