const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAuth = require('../middleware/auth');
const audit = require('../lib/audit');

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
    const [itemsRes, menuItemsRes, menuCatsRes, invCatsRes] = await Promise.all([
      db.query(`
        SELECT ii.*, mi.name AS menu_item_name,
          ic.name AS inv_category_name, ic.color AS inv_category_color,
          ROUND((SELECT COALESCE(SUM(ir.quantity * ing.avg_cost),0) FROM inventory_recipes ir
                 JOIN inventory_items ing ON ing.id=ir.ingredient_id
                 WHERE ir.item_id=ii.id),4) AS recipe_cost,
          (SELECT COUNT(*) FROM inventory_recipes WHERE item_id=ii.id) AS recipe_lines
        FROM inventory_items ii
        LEFT JOIN menu_items mi ON mi.id=ii.menu_item_id
        LEFT JOIN inventory_categories ic ON ic.id=ii.inv_category_id
        WHERE ii.tenant_id=$1 AND ii.is_active=true
        ORDER BY ii.name
      `, [tid]),
      db.query(`SELECT id, name FROM menu_items WHERE tenant_id=$1 AND is_available=true ORDER BY name`, [tid]),
      db.query(`SELECT id, name, parent_id FROM categories WHERE tenant_id=$1 ORDER BY sort_order, name`, [tid]),
      db.query(`SELECT * FROM inventory_categories WHERE tenant_id=$1 ORDER BY sort_order, name`, [tid]),
    ]);

    res.render('inventory/items', {
      tenant: req.tenant,
      currentUser: req.user,
      items: itemsRes.rows,
      menuItems: menuItemsRes.rows,
      categories: menuCatsRes.rows,
      invCategories: invCatsRes.rows,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Inventory Categories ───────────────────────────────────────────────────────
router.post('/categories', requireAuth, requireInventory, async (req, res) => {
  const { name, color } = req.body;
  if (!name?.trim()) return res.redirect('/inventory/items');
  try {
    await db.query(`INSERT INTO inventory_categories (tenant_id, name, color) VALUES ($1,$2,$3)`,
      [req.user.tenantId, name.trim(), color || '#7c5cbf']);
    res.redirect('/inventory/items');
  } catch (err) { console.error(err); res.redirect('/inventory/items'); }
});

router.post('/categories/:id/delete', requireAuth, requireInventory, async (req, res) => {
  try {
    await db.query(`UPDATE inventory_items SET inv_category_id=NULL WHERE inv_category_id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
    await db.query(`DELETE FROM inventory_categories WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
    res.redirect('/inventory/items');
  } catch (err) { console.error(err); res.redirect('/inventory/items'); }
});

// Create item
router.post('/items', requireAuth, requireInventory, async (req, res) => {
  const { name, sku, unit, reorder_level, is_raw_material, is_semi_finished, can_be_sold,
          add_to_menu, menu_category_id, selling_price, menu_name, inv_category_id,
          initial_stock_qty, initial_avg_cost } = req.body;
  try {
    let menuItemId = null;

    if (can_be_sold && add_to_menu === 'yes') {
      const miRes = await db.query(
        `INSERT INTO menu_items (tenant_id, category_id, name, price, is_available)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [req.user.tenantId, menu_category_id || null,
         (menu_name || name).trim(), parseFloat(selling_price) || 0]
      );
      menuItemId = miRes.rows[0].id;
    }

    const initQty  = parseFloat(initial_stock_qty) || 0;
    const initCost = parseFloat(initial_avg_cost)  || 0;

    await db.query(
      `INSERT INTO inventory_items (tenant_id, name, sku, unit, reorder_level, stock_qty, avg_cost, menu_item_id, is_raw_material, is_semi_finished, can_be_sold, inv_category_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [req.user.tenantId, name.trim(), sku?.trim() || null, unit || 'pcs',
       parseFloat(reorder_level) || 0, initQty, initCost, menuItemId,
       !!is_raw_material, !!is_semi_finished, !!can_be_sold,
       inv_category_id || null]
    );

    if (initQty !== 0) {
      const newItemRes = await db.query(`SELECT id FROM inventory_items WHERE tenant_id=$1 AND name=$2 ORDER BY id DESC LIMIT 1`, [req.user.tenantId, name.trim()]);
      if (newItemRes.rows[0]) {
        await db.query(
          `INSERT INTO inventory_transactions (tenant_id, item_id, type, qty_change, unit_cost, notes, created_by) VALUES ($1,$2,'adjustment',$3,$4,'Opening stock',$5)`,
          [req.user.tenantId, newItemRes.rows[0].id, initQty, initCost, req.user.userId]
        );
      }
    }
    res.redirect('/inventory/items');
  } catch (err) { console.error(err); res.redirect('/inventory/items?error=' + encodeURIComponent(err.message)); }
});

// Edit item
router.post('/items/:id/edit', requireAuth, requireInventory, async (req, res) => {
  const { name, sku, unit, reorder_level, menu_item_id, is_raw_material, is_semi_finished, can_be_sold, inv_category_id } = req.body;
  try {
    await db.query(
      `UPDATE inventory_items SET name=$1, sku=$2, unit=$3, reorder_level=$4, menu_item_id=$5,
        is_raw_material=$6, is_semi_finished=$7, can_be_sold=$8, inv_category_id=$9
       WHERE id=$10 AND tenant_id=$11`,
      [name.trim(), sku?.trim() || null, unit || 'pcs', parseFloat(reorder_level) || 0,
       menu_item_id || null, !!is_raw_material, !!is_semi_finished, !!can_be_sold,
       inv_category_id || null, req.params.id, req.user.tenantId]
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
  const tid = req.user.tenantId;
  try {
    const itemRes = await db.query('SELECT name, avg_cost FROM inventory_items WHERE id=$1 AND tenant_id=$2', [req.params.id, tid]);
    if (!itemRes.rows[0]) return res.redirect('/inventory/items');
    const { name, avg_cost } = itemRes.rows[0];
    const adjType = delta > 0 ? 'correction-in' : 'correction-out';
    await db.query(`UPDATE inventory_items SET stock_qty = stock_qty + $1 WHERE id=$2 AND tenant_id=$3`, [delta, req.params.id, tid]);
    await db.query(
      `INSERT INTO inventory_transactions (tenant_id, item_id, type, qty_change, notes, created_by) VALUES ($1,$2,'adjustment',$3,$4,$5)`,
      [tid, req.params.id, delta, notes?.trim() || null, req.user.userId]
    );
    await db.query(
      `INSERT INTO inventory_adjustments (tenant_id,item_id,item_name,type,qty_change,reason,cost_impact,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tid, req.params.id, name, adjType, delta, notes?.trim() || null, Math.abs(delta) * parseFloat(avg_cost), req.user.userId]
    );
    res.redirect('/inventory/items');
  } catch (err) { console.error(err); res.redirect('/inventory/items'); }
});

// ── Recipe builder ─────────────────────────────────────────────────────────────
router.get('/items/:id/recipe', requireAuth, requireInventory, async (req, res) => {
  try {
    const tid = req.user.tenantId;
    const [itemRes, recipeRes, ingredientsRes] = await Promise.all([
      db.query(`SELECT ii.*, mi.name AS menu_item_name FROM inventory_items ii LEFT JOIN menu_items mi ON mi.id=ii.menu_item_id WHERE ii.id=$1 AND ii.tenant_id=$2`, [req.params.id, tid]),
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
    const [invItemsRes, suppliersRes] = await Promise.all([
      db.query(`SELECT id, name, unit FROM inventory_items WHERE tenant_id=$1 AND is_active=true ORDER BY name`, [req.user.tenantId]),
      db.query(`SELECT id, name FROM suppliers WHERE tenant_id=$1 ORDER BY name`, [req.user.tenantId]),
    ]);
    res.render('inventory/purchase-new', {
      tenant: req.tenant,
      currentUser: req.user,
      invItems: invItemsRes.rows,
      suppliers: suppliersRes.rows,
      error: req.query.error || null,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.get('/purchases/:id', requireAuth, requireInventory, async (req, res) => {
  try {
    const [receiptRes, linesRes] = await Promise.all([
      db.query(`SELECT pr.*, u.name AS created_by_name FROM purchase_receipts pr LEFT JOIN users u ON u.id=pr.created_by WHERE pr.id=$1 AND pr.tenant_id=$2`, [req.params.id, req.user.tenantId]),
      db.query(`SELECT * FROM purchase_receipt_lines WHERE receipt_id=$1 ORDER BY id`, [req.params.id]),
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
router.post('/purchases', requireAuth, requireInventory, async (req, res) => {
  const { supplier_name, supplier_id, invoice_no, receipt_date, notes, bill_image, item_id, new_item_name, unit, quantity, unit_price } = req.body;
  const tid = req.user.tenantId;

  const toArr = v => Array.isArray(v) ? v : (v !== undefined ? [v] : []);
  const itemIds     = toArr(item_id);
  const newNames    = toArr(new_item_name);
  const units       = toArr(unit);
  const qtys        = toArr(quantity);
  const prices      = toArr(unit_price);

  const lines = itemIds.map((iid, i) => ({
    item_id:       iid,
    new_item_name: newNames[i]?.trim() || '',
    unit:          units[i]?.trim() || 'pcs',
    quantity:      parseFloat(qtys[i]),
    unit_price:    parseFloat(prices[i]),
  })).filter(l => !isNaN(l.quantity) && l.quantity > 0 && !isNaN(l.unit_price) && l.unit_price >= 0
              && (l.item_id !== 'new' || l.new_item_name));

  if (!lines.length) return res.redirect('/inventory/purchases/new?error=no_lines');

  const total = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const rr = await client.query(
      `INSERT INTO purchase_receipts (tenant_id, supplier_name, supplier_id, invoice_no, receipt_date, total, notes, bill_image, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [tid, supplier_name?.trim() || null, parseInt(supplier_id)||null, invoice_no?.trim() || null,
       receipt_date || new Date().toISOString().slice(0, 10), total,
       notes?.trim() || null, bill_image || null, req.user.userId]
    );
    const receiptId = rr.rows[0].id;

    for (const l of lines) {
      let resolvedItemId = null;
      let resolvedName   = l.new_item_name;

      if (l.item_id === 'new') {
        // Create inventory item on the fly
        const nr = await client.query(
          `INSERT INTO inventory_items (tenant_id, name, unit, is_raw_material, stock_qty, avg_cost)
           VALUES ($1,$2,$3,true,0,0) RETURNING id, name`,
          [tid, l.new_item_name, l.unit]
        );
        resolvedItemId = nr.rows[0].id;
        resolvedName   = nr.rows[0].name;
      } else if (l.item_id) {
        resolvedItemId = parseInt(l.item_id);
        // Fetch existing item name for the line record
        const er = await client.query(`SELECT name FROM inventory_items WHERE id=$1 AND tenant_id=$2`, [resolvedItemId, tid]);
        if (er.rows[0]) resolvedName = er.rows[0].name;
      }

      // Update inventory stock & weighted average cost
      if (resolvedItemId) {
        const cur = await client.query(`SELECT stock_qty, avg_cost FROM inventory_items WHERE id=$1`, [resolvedItemId]);
        if (cur.rows[0]) {
          const oldQty  = parseFloat(cur.rows[0].stock_qty)  || 0;
          const oldCost = parseFloat(cur.rows[0].avg_cost)   || 0;
          const newQty  = oldQty + l.quantity;
          const newCost = newQty > 0 ? (oldQty * oldCost + l.quantity * l.unit_price) / newQty : l.unit_price;
          await client.query(
            `UPDATE inventory_items SET stock_qty=$1, avg_cost=$2 WHERE id=$3`,
            [newQty, newCost, resolvedItemId]
          );
          await client.query(
            `INSERT INTO inventory_transactions (tenant_id, item_id, type, qty_change, unit_cost, reference_id, reference_type, notes, created_by)
             VALUES ($1,$2,'purchase',$3,$4,$5,'purchase_receipt',$6,$7)`,
            [tid, resolvedItemId, l.quantity, l.unit_price, receiptId, 'Purchase receipt #' + receiptId, req.user.userId]
          );
        }
      }

      const lineTotal = l.quantity * l.unit_price;
      await client.query(
        `INSERT INTO purchase_receipt_lines (receipt_id, item_id, item_name, unit, quantity, unit_price, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [receiptId, resolvedItemId || null, resolvedName || '', l.unit, l.quantity, l.unit_price, lineTotal]
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

// ── Adjustments ───────────────────────────────────────────────────────────────
router.get('/adjustments', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [adjRes, itemsRes] = await Promise.all([
      db.query(`SELECT a.*, i.name AS item_name FROM inventory_adjustments a
                LEFT JOIN inventory_items i ON i.id=a.item_id
                WHERE a.tenant_id=$1 ORDER BY a.created_at DESC LIMIT 50`, [tid]),
      db.query(`SELECT id, name, stock_qty, unit FROM inventory_items WHERE tenant_id=$1 AND is_active=true ORDER BY name`, [tid]),
    ]);
    res.render('inventory/adjustments', {
      tenant: req.tenant, currentUser: req.user,
      adjustments: adjRes.rows, items: itemsRes.rows,
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

router.post('/adjustments', requireAuth, requireInventory, async (req, res) => {
  const { item_id, type, qty_change, reason } = req.body;
  const tid = req.user.tenantId;
  const qty = parseFloat(qty_change) || 0;
  try {
    const itemRes = await db.query('SELECT name, avg_cost FROM inventory_items WHERE id=$1 AND tenant_id=$2', [item_id, tid]);
    if (!itemRes.rows[0]) return res.redirect('/inventory/adjustments?error=Item+not+found');
    const item = itemRes.rows[0];
    const costImpact = Math.abs(qty) * parseFloat(item.avg_cost);
    const actualQty = (type === 'write-off' || type === 'spoilage' || type === 'correction-out') ? -Math.abs(qty) : Math.abs(qty);

    await db.query(`INSERT INTO inventory_adjustments (tenant_id,item_id,item_name,type,qty_change,reason,cost_impact,created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tid, item_id, item.name, type, actualQty, reason||null, costImpact, req.user.userId]);
    await db.query(`UPDATE inventory_items SET stock_qty = stock_qty + $1 WHERE id=$2 AND tenant_id=$3`,
      [actualQty, item_id, tid]);
    await db.query(`INSERT INTO inventory_transactions (tenant_id,item_id,type,qty_change,notes,created_by)
                    VALUES ($1,$2,'adjustment',$3,$4,$5)`,
      [tid, item_id, actualQty, reason||null, req.user.userId]);

    res.redirect('/inventory/adjustments');
  } catch (err) { console.error(err); res.redirect('/inventory/adjustments?error=' + encodeURIComponent(err.message)); }
});

// ── Suppliers ─────────────────────────────────────────────────────────────────
router.get('/suppliers', requireAuth, requireInventory, async (req, res) => {
  try {
    const tid = req.user.tenantId;
    const [suppRes, paidRes, purchaseRes] = await Promise.all([
      db.query(`SELECT * FROM suppliers WHERE tenant_id=$1 ORDER BY name`, [tid]),
      db.query(`SELECT supplier_id, COALESCE(SUM(amount),0) AS paid FROM supplier_payments WHERE tenant_id=$1 AND supplier_id IS NOT NULL GROUP BY supplier_id`, [tid]),
      db.query(`SELECT supplier_id, COUNT(*) AS receipt_count, COALESCE(SUM(total),0) AS total_purchased FROM purchase_receipts WHERE tenant_id=$1 AND supplier_id IS NOT NULL GROUP BY supplier_id`, [tid]),
    ]);
    const paidMap = {}, purchMap = {};
    paidRes.rows.forEach(r => { paidMap[r.supplier_id] = parseFloat(r.paid); });
    purchaseRes.rows.forEach(r => { purchMap[r.supplier_id] = { count: parseInt(r.receipt_count), total: parseFloat(r.total_purchased) }; });
    const suppliers = suppRes.rows.map(s => ({
      ...s,
      paid: paidMap[s.id] || 0,
      receipt_count: purchMap[s.id]?.count || 0,
      total_purchased: purchMap[s.id]?.total || 0,
    }));
    res.render('inventory/suppliers', { tenant: req.tenant, currentUser: req.user, suppliers });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/suppliers', requireAuth, requireInventory, async (req, res) => {
  const { name, phone, email, address, tax_no, opening_balance, notes } = req.body;
  try {
    await db.query(
      `INSERT INTO suppliers (tenant_id,name,phone,email,address,tax_no,opening_balance,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.user.tenantId, name.trim(), phone||null, email||null, address||null, tax_no||null, parseFloat(opening_balance)||0, notes||null]
    );
    res.redirect('/inventory/suppliers?success=Supplier+added');
  } catch (err) { console.error(err); res.redirect('/inventory/suppliers?error=' + encodeURIComponent(err.message)); }
});

router.post('/suppliers/:id/edit', requireAuth, requireInventory, async (req, res) => {
  const { name, phone, email, address, tax_no, opening_balance, notes } = req.body;
  try {
    await db.query(
      `UPDATE suppliers SET name=$1,phone=$2,email=$3,address=$4,tax_no=$5,opening_balance=$6,notes=$7 WHERE id=$8 AND tenant_id=$9`,
      [name.trim(), phone||null, email||null, address||null, tax_no||null, parseFloat(opening_balance)||0, notes||null, req.params.id, req.user.tenantId]
    );
    res.redirect('/inventory/suppliers?success=Saved');
  } catch (err) { console.error(err); res.redirect('/inventory/suppliers?error=' + encodeURIComponent(err.message)); }
});

router.post('/suppliers/:id/delete', requireAuth, requireInventory, async (req, res) => {
  try {
    await db.query(`UPDATE purchase_receipts SET supplier_id=NULL WHERE supplier_id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
    await db.query(`DELETE FROM suppliers WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
    res.redirect('/inventory/suppliers');
  } catch (err) { console.error(err); res.redirect('/inventory/suppliers?error=' + encodeURIComponent(err.message)); }
});

// ── Supplier detail page ───────────────────────────────────────────────────────
router.get('/suppliers/:id', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [suppRes, purchRes, payRes] = await Promise.all([
      db.query(`SELECT * FROM suppliers WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]),
      db.query(`SELECT * FROM purchase_receipts WHERE supplier_id=$1 AND tenant_id=$2 ORDER BY receipt_date DESC`, [req.params.id, tid]),
      db.query(`SELECT * FROM supplier_payments WHERE supplier_id=$1 AND tenant_id=$2 ORDER BY payment_date DESC, created_at DESC`, [req.params.id, tid]),
    ]);
    if (!suppRes.rows[0]) return res.redirect('/inventory/suppliers');
    const supplier = suppRes.rows[0];
    const totalPurchased = purchRes.rows.reduce((s, r) => s + parseFloat(r.total || 0), 0);
    const totalPaid = payRes.rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const balance = totalPurchased + parseFloat(supplier.opening_balance || 0) - totalPaid;
    res.render('inventory/supplier-detail', {
      tenant: req.tenant, currentUser: req.user,
      supplier, purchases: purchRes.rows, payments: payRes.rows,
      totalPurchased, totalPaid, balance,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Record supplier payment ────────────────────────────────────────────────────
router.post('/suppliers/:id/pay', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  const { amount, payment_date, method, notes } = req.body;
  try {
    const suppRes = await db.query(`SELECT name FROM suppliers WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]);
    if (!suppRes.rows[0]) return res.redirect('/inventory/suppliers');
    await db.query(
      `INSERT INTO supplier_payments (tenant_id, supplier_id, supplier_name, amount, payment_date, method, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tid, req.params.id, suppRes.rows[0].name, parseFloat(amount), payment_date || new Date().toISOString().slice(0,10), method || 'cash', notes || null, req.user.userId]
    );
    res.redirect('/inventory/suppliers/' + req.params.id + '?success=Payment+recorded');
  } catch (err) { console.error(err); res.redirect('/inventory/suppliers/' + req.params.id + '?error=' + encodeURIComponent(err.message)); }
});

// ── Delete supplier payment ────────────────────────────────────────────────────
router.post('/suppliers/:id/payments/:pid/delete', requireAuth, requireInventory, async (req, res) => {
  try {
    await db.query(`DELETE FROM supplier_payments WHERE id=$1 AND tenant_id=$2`, [req.params.pid, req.user.tenantId]);
    res.redirect('/inventory/suppliers/' + req.params.id + '?success=Payment+deleted');
  } catch (err) { console.error(err); res.redirect('/inventory/suppliers/' + req.params.id); }
});

// ── Purchase receipt void ──────────────────────────────────────────────────────
router.post('/purchases/:id/void', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const receiptRes = await client.query(`SELECT * FROM purchase_receipts WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]);
    if (!receiptRes.rows[0]) { await client.query('ROLLBACK'); return res.redirect('/inventory/purchases'); }
    if (receiptRes.rows[0].status === 'voided') { await client.query('ROLLBACK'); return res.redirect(`/inventory/purchases/${req.params.id}?error=Already+voided`); }
    const linesRes = await client.query(`SELECT * FROM purchase_receipt_lines WHERE receipt_id=$1`, [req.params.id]);
    for (const l of linesRes.rows) {
      if (!l.item_id) continue;
      const cur = await client.query(`SELECT stock_qty, avg_cost FROM inventory_items WHERE id=$1`, [l.item_id]);
      if (!cur.rows[0]) continue;
      const oldQty  = parseFloat(cur.rows[0].stock_qty);
      const oldCost = parseFloat(cur.rows[0].avg_cost);
      const lineQty = parseFloat(l.quantity);
      const newQty  = Math.max(0, oldQty - lineQty);
      const newCost = newQty > 0 ? Math.max(0, (oldQty * oldCost - lineQty * parseFloat(l.unit_price)) / newQty) : oldCost;
      await client.query(`UPDATE inventory_items SET stock_qty=$1, avg_cost=$2 WHERE id=$3`, [newQty, newCost, l.item_id]);
      await client.query(
        `INSERT INTO inventory_transactions (tenant_id,item_id,type,qty_change,unit_cost,reference_id,reference_type,notes,created_by) VALUES ($1,$2,'adjustment',$3,$4,$5,'purchase_receipt',$6,$7)`,
        [tid, l.item_id, -lineQty, parseFloat(l.unit_price), req.params.id, 'Void receipt #'+req.params.id, req.user.userId]
      );
    }
    await client.query(`UPDATE purchase_receipts SET status='voided' WHERE id=$1`, [req.params.id]);
    await client.query('COMMIT');
    audit.log({ tenantId: tid, userId: req.user.userId, userEmail: req.user.email, action: 'purchase.void', entity: 'purchase_receipt', entityId: req.params.id, detail: { total: receiptRes.rows[0].total, supplier: receiptRes.rows[0].supplier_name }, ip: req.ip });
    res.redirect(`/inventory/purchases/${req.params.id}?success=Receipt+voided`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.redirect(`/inventory/purchases/${req.params.id}?error=` + encodeURIComponent(err.message));
  } finally { client.release(); }
});

// ── Attach / replace bill image on existing receipt ───────────────────────────
router.post('/purchases/:id/image', requireAuth, requireInventory, async (req, res) => {
  const { bill_image } = req.body;
  try {
    if (!bill_image || !bill_image.startsWith('data:image/')) {
      return res.redirect(`/inventory/purchases/${req.params.id}?error=Invalid+image`);
    }
    await db.query(
      `UPDATE purchase_receipts SET bill_image=$1 WHERE id=$2 AND tenant_id=$3`,
      [bill_image, req.params.id, req.user.tenantId]
    );
    res.redirect(`/inventory/purchases/${req.params.id}?success=Image+saved`);
  } catch (err) { console.error(err); res.redirect(`/inventory/purchases/${req.params.id}?error=` + encodeURIComponent(err.message)); }
});

router.post('/purchases/:id/image/delete', requireAuth, requireInventory, async (req, res) => {
  try {
    await db.query(`UPDATE purchase_receipts SET bill_image=NULL WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
    res.redirect(`/inventory/purchases/${req.params.id}?success=Image+removed`);
  } catch (err) { console.error(err); res.redirect(`/inventory/purchases/${req.params.id}?error=` + encodeURIComponent(err.message)); }
});

// ── Inventory Reports ──────────────────────────────────────────────────────────
router.get('/reports', requireAuth, requireInventory, async (req, res) => {
  try {
    const tid = req.user.tenantId;
    const { from, to } = req.query;
    const fromDate = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const toDate   = to   || new Date().toISOString().slice(0, 10);
    const [stockByCatRes, movementRes, writeOffRes, cogsRes, topMoversRes, lowStockRes, dailyPurchaseRes] = await Promise.all([
      db.query(`
        SELECT COALESCE(ic.name,'Uncategorised') AS category, COALESCE(ic.color,'#555') AS color,
          COUNT(ii.id)::int AS item_count,
          COALESCE(SUM(ii.stock_qty * ii.avg_cost),0) AS total_value
        FROM inventory_items ii
        LEFT JOIN inventory_categories ic ON ic.id=ii.inv_category_id
        WHERE ii.tenant_id=$1 AND ii.is_active=true
        GROUP BY ic.name, ic.color ORDER BY total_value DESC
      `, [tid]),
      db.query(`
        SELECT type, COUNT(*)::int AS tx_count,
          COALESCE(SUM(CASE WHEN qty_change>0 THEN qty_change ELSE 0 END),0) AS total_in,
          COALESCE(SUM(CASE WHEN qty_change<0 THEN -qty_change ELSE 0 END),0) AS total_out
        FROM inventory_transactions
        WHERE tenant_id=$1 AND created_at>=$2::date AND created_at<($3::date+INTERVAL '1 day')
        GROUP BY type ORDER BY type
      `, [tid, fromDate, toDate]),
      db.query(`
        SELECT type, COUNT(*)::int AS cnt,
          COALESCE(SUM(-qty_change),0) AS total_qty,
          COALESCE(SUM(cost_impact),0) AS total_cost
        FROM inventory_adjustments
        WHERE tenant_id=$1 AND created_at>=$2::date AND created_at<($3::date+INTERVAL '1 day')
          AND type IN ('write-off','spoilage','correction-out')
        GROUP BY type ORDER BY total_cost DESC
      `, [tid, fromDate, toDate]),
      db.query(`
        SELECT COALESCE(SUM(-it.qty_change * COALESCE(it.unit_cost, ii.avg_cost)),0) AS cogs
        FROM inventory_transactions it
        JOIN inventory_items ii ON ii.id=it.item_id
        WHERE it.tenant_id=$1 AND it.type='sale'
          AND it.created_at>=$2::date AND it.created_at<($3::date+INTERVAL '1 day')
      `, [tid, fromDate, toDate]),
      db.query(`
        SELECT ii.name, ii.unit, COALESCE(SUM(-it.qty_change),0) AS total_sold,
          ii.stock_qty, ii.avg_cost,
          COALESCE(SUM(-it.qty_change * COALESCE(it.unit_cost,ii.avg_cost)),0) AS cogs
        FROM inventory_transactions it
        JOIN inventory_items ii ON ii.id=it.item_id
        WHERE it.tenant_id=$1 AND it.type='sale'
          AND it.created_at>=$2::date AND it.created_at<($3::date+INTERVAL '1 day')
        GROUP BY ii.id ORDER BY total_sold DESC LIMIT 10
      `, [tid, fromDate, toDate]),
      db.query(`
        SELECT name, unit, stock_qty, reorder_level, avg_cost,
          (stock_qty * avg_cost) AS value
        FROM inventory_items
        WHERE tenant_id=$1 AND is_active=true AND reorder_level>0 AND stock_qty<=reorder_level
        ORDER BY (stock_qty - reorder_level) ASC
      `, [tid]),
      db.query(`
        SELECT DATE(created_at) AS day, COALESCE(SUM(total),0) AS total
        FROM purchase_receipts
        WHERE tenant_id=$1 AND status='active'
          AND created_at>=$2::date AND created_at<($3::date+INTERVAL '1 day')
        GROUP BY day ORDER BY day
      `, [tid, fromDate, toDate]),
    ]);
    const totalStockValue = stockByCatRes.rows.reduce((s, r) => s + parseFloat(r.total_value), 0);
    res.render('inventory/reports', {
      tenant: req.tenant, currentUser: req.user,
      fromDate, toDate, totalStockValue,
      stockByCategory: stockByCatRes.rows,
      movement: movementRes.rows,
      writeOffs: writeOffRes.rows,
      cogs: parseFloat(cogsRes.rows[0]?.cogs) || 0,
      topMovers: topMoversRes.rows,
      lowStock: lowStockRes.rows,
      dailyPurchases: dailyPurchaseRes.rows,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Stock Take ─────────────────────────────────────────────────────────────────
router.get('/stocktake', requireAuth, requireInventory, async (req, res) => {
  try {
    const itemsRes = await db.query(`
      SELECT ii.*, COALESCE(ic.name,'Uncategorised') AS inv_category_name, COALESCE(ic.color,'#555') AS inv_category_color
      FROM inventory_items ii
      LEFT JOIN inventory_categories ic ON ic.id=ii.inv_category_id
      WHERE ii.tenant_id=$1 AND ii.is_active=true
      ORDER BY ic.sort_order NULLS LAST, ii.name
    `, [req.user.tenantId]);
    res.render('inventory/stocktake', { tenant: req.tenant, currentUser: req.user, items: itemsRes.rows });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/stocktake', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  const ids  = [].concat(req.body.item_id   || []);
  const qtys = [].concat(req.body.actual_qty || []);
  try {
    let changed = 0;
    for (let i = 0; i < ids.length; i++) {
      const actual = parseFloat(qtys[i]);
      if (isNaN(actual)) continue;
      const itemRes = await db.query(`SELECT name, stock_qty, avg_cost FROM inventory_items WHERE id=$1 AND tenant_id=$2`, [ids[i], tid]);
      if (!itemRes.rows[0]) continue;
      const { name, stock_qty, avg_cost } = itemRes.rows[0];
      const variance = actual - parseFloat(stock_qty);
      if (Math.abs(variance) < 0.0001) continue;
      const adjType = variance > 0 ? 'correction-in' : 'correction-out';
      await db.query(`UPDATE inventory_items SET stock_qty=$1 WHERE id=$2 AND tenant_id=$3`, [actual, ids[i], tid]);
      await db.query(`INSERT INTO inventory_adjustments (tenant_id,item_id,item_name,type,qty_change,reason,cost_impact,created_by) VALUES ($1,$2,$3,$4,$5,'Stock take',$6,$7)`,
        [tid, ids[i], name, adjType, variance, Math.abs(variance)*parseFloat(avg_cost), req.user.userId]);
      await db.query(`INSERT INTO inventory_transactions (tenant_id,item_id,type,qty_change,notes,created_by) VALUES ($1,$2,'adjustment',$3,'Stock take',$4)`,
        [tid, ids[i], variance, req.user.userId]);
      changed++;
    }
    res.redirect('/inventory/stocktake?success=' + changed);
  } catch (err) { console.error(err); res.redirect('/inventory/stocktake?error=' + encodeURIComponent(err.message)); }
});

// ── Excel export ───────────────────────────────────────────────────────────────
router.get('/export', requireAuth, requireInventory, async (req, res) => {
  try {
    const itemsRes = await db.query(`
      SELECT ii.name, ii.sku, COALESCE(ic.name,'') AS category, ii.unit,
        ii.stock_qty, ii.reorder_level, ii.avg_cost,
        ROUND(ii.stock_qty * ii.avg_cost,2) AS total_value,
        COALESCE(mi.name,'') AS menu_item,
        CASE WHEN ii.is_raw_material THEN 'Yes' ELSE 'No' END AS raw_material,
        CASE WHEN ii.is_semi_finished THEN 'Yes' ELSE 'No' END AS semi_finished,
        CASE WHEN ii.can_be_sold THEN 'Yes' ELSE 'No' END AS can_be_sold
      FROM inventory_items ii
      LEFT JOIN inventory_categories ic ON ic.id=ii.inv_category_id
      LEFT JOIN menu_items mi ON mi.id=ii.menu_item_id
      WHERE ii.tenant_id=$1 AND ii.is_active=true ORDER BY ii.name
    `, [req.user.tenantId]);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Inventory');
    ws.columns = [
      { header: 'Name', key: 'name', width: 28 },
      { header: 'SKU', key: 'sku', width: 14 },
      { header: 'Category', key: 'category', width: 18 },
      { header: 'Unit', key: 'unit', width: 8 },
      { header: 'Stock Qty', key: 'stock_qty', width: 11 },
      { header: 'Reorder Level', key: 'reorder_level', width: 14 },
      { header: 'Avg Cost', key: 'avg_cost', width: 11 },
      { header: 'Total Value', key: 'total_value', width: 13 },
      { header: 'Menu Item', key: 'menu_item', width: 22 },
      { header: 'Raw Material', key: 'raw_material', width: 13 },
      { header: 'Semi-Finished', key: 'semi_finished', width: 14 },
      { header: 'Can Be Sold', key: 'can_be_sold', width: 12 },
    ];
    const hdr = ws.getRow(1);
    hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7c5cbf' } };
    itemsRes.rows.forEach(r => ws.addRow(r));
    // Highlight low stock rows
    ws.eachRow((row, idx) => {
      if (idx < 2) return;
      const stock = row.getCell(5).value;
      const reorder = row.getCell(6).value;
      if (parseFloat(stock) <= parseFloat(reorder) && parseFloat(reorder) > 0) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFffe0e0' } };
      }
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="inventory-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(await wb.xlsx.writeBuffer());
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.get('/transactions/export', requireAuth, requireInventory, async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
    const toDate   = to   || new Date().toISOString().slice(0,10);
    const txRes = await db.query(`
      SELECT it.created_at, it.type, ii.name AS item, ii.unit,
        it.qty_change, it.unit_cost, it.notes,
        COALESCE(u.name, u.email,'') AS user_name,
        it.reference_type, it.reference_id
      FROM inventory_transactions it
      JOIN inventory_items ii ON ii.id=it.item_id
      LEFT JOIN users u ON u.id=it.created_by
      WHERE it.tenant_id=$1 AND it.created_at>=$2::date AND it.created_at<($3::date+INTERVAL '1 day')
      ORDER BY it.created_at DESC
    `, [req.user.tenantId, fromDate, toDate]);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Transactions');
    ws.columns = [
      { header: 'Date', key: 'created_at', width: 20 },
      { header: 'Type', key: 'type', width: 12 },
      { header: 'Item', key: 'item', width: 26 },
      { header: 'Unit', key: 'unit', width: 8 },
      { header: 'Qty Change', key: 'qty_change', width: 12 },
      { header: 'Unit Cost', key: 'unit_cost', width: 11 },
      { header: 'Notes', key: 'notes', width: 30 },
      { header: 'User', key: 'user_name', width: 18 },
      { header: 'Reference', key: 'reference_type', width: 16 },
    ];
    const hdr = ws.getRow(1);
    hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2d4a7a' } };
    txRes.rows.forEach(r => ws.addRow({ ...r, created_at: new Date(r.created_at).toISOString().replace('T',' ').slice(0,16) }));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${fromDate}-${toDate}.xlsx"`);
    res.send(await wb.xlsx.writeBuffer());
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Per-item transaction history ──────────────────────────────────────────────
router.get('/items/:id/history', requireAuth, requireInventory, async (req, res) => {
  try {
    const tid = req.user.tenantId;
    const { from, to } = req.query;
    const fromDate = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const toDate   = to   || new Date().toISOString().slice(0, 10);

    const [itemRes, txRes, openingRes] = await Promise.all([
      db.query(`
        SELECT ii.*, mi.name AS menu_item_name,
          ic.name AS inv_category_name, ic.color AS inv_category_color
        FROM inventory_items ii
        LEFT JOIN menu_items mi ON mi.id = ii.menu_item_id
        LEFT JOIN inventory_categories ic ON ic.id = ii.inv_category_id
        WHERE ii.id=$1 AND ii.tenant_id=$2
      `, [req.params.id, tid]),
      db.query(`
        SELECT it.*, u.name AS user_name,
          pr.supplier_name, pr.invoice_no
        FROM inventory_transactions it
        LEFT JOIN users u ON u.id = it.created_by
        LEFT JOIN purchase_receipts pr ON pr.id = it.reference_id AND it.reference_type='purchase_receipt'
        WHERE it.item_id=$1 AND it.tenant_id=$2
          AND it.created_at >= $3::date AND it.created_at < ($4::date + INTERVAL '1 day')
        ORDER BY it.created_at ASC
      `, [req.params.id, tid, fromDate, toDate]),
      db.query(`
        SELECT COALESCE(SUM(qty_change),0) AS total
        FROM inventory_transactions
        WHERE item_id=$1 AND tenant_id=$2 AND created_at < $3::date
      `, [req.params.id, tid, fromDate]),
    ]);

    if (!itemRes.rows[0]) return res.redirect('/inventory/items');

    let runningBalance = parseFloat(openingRes.rows[0].total);
    const transactions = txRes.rows.map(t => {
      runningBalance += parseFloat(t.qty_change);
      return { ...t, balance_after: runningBalance };
    });
    transactions.reverse(); // show newest first

    res.render('inventory/item-history', {
      tenant: req.tenant,
      currentUser: req.user,
      item: itemRes.rows[0],
      transactions,
      openingBalance: parseFloat(openingRes.rows[0].total),
      fromDate,
      toDate,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
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
      if (recipe.rows.length === 0) {
        // No recipe — deduct the sellable item directly (quantity ordered)
        const deduct = parseInt(oi.quantity);
        await db.query(
          `UPDATE inventory_items SET stock_qty = stock_qty - $1 WHERE id=$2 AND tenant_id=$3`,
          [deduct, invItemId, tenantId]
        );
        await db.query(
          `INSERT INTO inventory_transactions (tenant_id, item_id, type, qty_change, reference_id, reference_type, created_by)
           VALUES ($1,$2,'sale',$3,$4,'pos_order',$5)`,
          [tenantId, invItemId, -deduct, orderId, userId]
        );
      } else {
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
    }
  } catch (err) {
    console.error('[inventory] deductStockForOrder error:', err.message);
  }
}

module.exports = router;
module.exports.deductStockForOrder = deductStockForOrder;
