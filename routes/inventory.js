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

    const [
      stockRes, lowStockRes, purchasesRes, recentTxRes,
      expiringRes, wasteRes, pendingPORes,
      todayRes, monthRes, chartRes, topItemsRes,
    ] = await Promise.all([
      db.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(stock_qty * avg_cost),0) AS total_value FROM inventory_items WHERE tenant_id=$1 AND is_active=true`, [tid]),
      db.query(`SELECT * FROM inventory_items WHERE tenant_id=$1 AND is_active=true AND reorder_level > 0 AND stock_qty <= reorder_level ORDER BY (stock_qty - reorder_level) ASC LIMIT 10`, [tid]),
      db.query(`SELECT pr.*, u.name AS created_by_name FROM purchase_receipts pr LEFT JOIN users u ON u.id=pr.created_by WHERE pr.tenant_id=$1 ORDER BY pr.created_at DESC LIMIT 5`, [tid]),
      db.query(`SELECT it.*, ii.name AS item_name, ii.unit FROM inventory_transactions it LEFT JOIN inventory_items ii ON ii.id=it.item_id WHERE it.tenant_id=$1 ORDER BY it.created_at DESC LIMIT 10`, [tid]),
      db.query(`SELECT COUNT(*) AS cnt FROM inventory_batches WHERE tenant_id=$1 AND expiry_date IS NOT NULL AND quantity > 0 AND expiry_date <= CURRENT_DATE + INTERVAL '30 days'`, [tid]),
      db.query(`SELECT COALESCE(SUM(cost_impact),0) AS total FROM inventory_waste WHERE tenant_id=$1 AND waste_date >= date_trunc('month', CURRENT_DATE)`, [tid]),
      db.query(`SELECT COUNT(*) AS cnt FROM purchase_orders WHERE tenant_id=$1 AND status IN ('draft','sent','partial')`, [tid]),

      // Today: purchases in, COGS out, transaction count
      db.query(`SELECT
          COALESCE(SUM(CASE WHEN it.qty_change > 0 THEN it.qty_change * ii.avg_cost ELSE 0 END),0) AS in_val,
          COALESCE(SUM(CASE WHEN it.type='sale' THEN ABS(it.qty_change) * ii.avg_cost ELSE 0 END),0) AS cogs_val,
          COUNT(*) AS tx_count
        FROM inventory_transactions it
        JOIN inventory_items ii ON ii.id=it.item_id AND ii.tenant_id=it.tenant_id
        WHERE it.tenant_id=$1 AND it.created_at::date=CURRENT_DATE`, [tid]),

      // This month: purchase receipts total & COGS
      db.query(`SELECT
          COALESCE((SELECT SUM(total) FROM purchase_receipts WHERE tenant_id=$1 AND receipt_date >= date_trunc('month',CURRENT_DATE)),0) AS purchased,
          COALESCE(SUM(CASE WHEN it.type='sale' THEN ABS(it.qty_change)*ii.avg_cost ELSE 0 END),0) AS cogs,
          COALESCE(SUM(CASE WHEN it.type='waste' THEN ABS(it.qty_change)*ii.avg_cost ELSE 0 END),0) AS waste_val
        FROM inventory_transactions it
        JOIN inventory_items ii ON ii.id=it.item_id AND ii.tenant_id=it.tenant_id
        WHERE it.tenant_id=$1 AND it.created_at >= date_trunc('month',CURRENT_DATE)`, [tid]),

      // Last 7 days: daily in vs out for mini chart
      db.query(`SELECT
          d.day::date AS day,
          COALESCE(SUM(CASE WHEN it.qty_change > 0 THEN it.qty_change * ii.avg_cost ELSE 0 END),0) AS in_val,
          COALESCE(SUM(CASE WHEN it.type='sale' THEN ABS(it.qty_change)*ii.avg_cost ELSE 0 END),0) AS out_val
        FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') AS d(day)
        LEFT JOIN inventory_transactions it ON it.created_at::date=d.day AND it.tenant_id=$1
        LEFT JOIN inventory_items ii ON ii.id=it.item_id AND ii.tenant_id=$1
        GROUP BY d.day ORDER BY d.day`, [tid]),

      // Top 5 items by COGS this month
      db.query(`SELECT ii.name, ii.unit,
          SUM(ABS(it.qty_change)) AS qty_consumed,
          SUM(ABS(it.qty_change)*ii.avg_cost) AS cost_consumed
        FROM inventory_transactions it
        JOIN inventory_items ii ON ii.id=it.item_id AND ii.tenant_id=it.tenant_id
        WHERE it.tenant_id=$1 AND it.type='sale'
          AND it.created_at >= date_trunc('month',CURRENT_DATE)
        GROUP BY ii.id, ii.name, ii.unit ORDER BY cost_consumed DESC LIMIT 5`, [tid]),
    ]);

    res.render('inventory/home', {
      tenant: req.tenant,
      currentUser: req.user,
      totalItems:     parseInt(stockRes.rows[0].cnt) || 0,
      totalValue:     parseFloat(stockRes.rows[0].total_value) || 0,
      lowStock:       lowStockRes.rows,
      recentPurchases: purchasesRes.rows,
      recentTx:       recentTxRes.rows,
      expiringCount:  parseInt(expiringRes.rows[0].cnt) || 0,
      wasteThisMonth: parseFloat(wasteRes.rows[0].total) || 0,
      pendingPOs:     parseInt(pendingPORes.rows[0].cnt) || 0,
      todayIn:        parseFloat(todayRes.rows[0].in_val) || 0,
      todayCOGS:      parseFloat(todayRes.rows[0].cogs_val) || 0,
      todayTxCount:   parseInt(todayRes.rows[0].tx_count) || 0,
      monthPurchased: parseFloat(monthRes.rows[0].purchased) || 0,
      monthCOGS:      parseFloat(monthRes.rows[0].cogs) || 0,
      monthWaste:     parseFloat(monthRes.rows[0].waste_val) || 0,
      chartData:      chartRes.rows,
      topItems:       topItemsRes.rows,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// ── Items catalog ──────────────────────────────────────────────────────────────
router.get('/items', requireAuth, requireInventory, async (req, res) => {
  try {
    const tid = req.user.tenantId;
    const [itemsRes, menuItemsRes, menuCatsRes, invCatsRes, locStockRes] = await Promise.all([
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
      db.query(`SELECT id, name, name_ar, name_ku, image_url, parent_id FROM categories WHERE tenant_id=$1 ORDER BY sort_order, name`, [tid]),
      db.query(`SELECT * FROM inventory_categories WHERE tenant_id=$1 ORDER BY sort_order, name`, [tid]),
      db.query(`
        SELECT s.item_id, s.quantity, l.name AS loc_name, l.color AS loc_color
        FROM inventory_stock s
        JOIN inventory_locations l ON l.id=s.location_id
        WHERE s.tenant_id=$1 AND s.quantity != 0
        ORDER BY l.sort_order, l.name
      `, [tid]),
    ]);

    // Group location stocks by item_id
    const locStockMap = {};
    locStockRes.rows.forEach(r => {
      if (!locStockMap[r.item_id]) locStockMap[r.item_id] = [];
      locStockMap[r.item_id].push({ name: r.loc_name, color: r.loc_color, qty: parseFloat(r.quantity) });
    });

    res.render('inventory/items', {
      tenant: req.tenant,
      currentUser: req.user,
      items: itemsRes.rows,
      menuItems: menuItemsRes.rows,
      categories: menuCatsRes.rows,
      invCategories: invCatsRes.rows,
      locStockMap,
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
          add_to_menu, menu_category_id, selling_price, menu_name, menu_name_ar, menu_name_ku,
          menu_image, new_category, new_cat_name, new_cat_name_ar, new_cat_name_ku, new_cat_image,
          inv_category_id, initial_stock_qty, initial_avg_cost } = req.body;
  try {
    let menuItemId = null;

    if (can_be_sold && add_to_menu === 'yes') {
      // Create new category on the fly if requested
      let finalCategoryId = menu_category_id || null;
      if (new_category === 'yes' && new_cat_name?.trim()) {
        const catRes = await db.query(
          `INSERT INTO categories (tenant_id, name, name_ar, name_ku, image_url)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [req.user.tenantId, new_cat_name.trim(), new_cat_name_ar?.trim() || null,
           new_cat_name_ku?.trim() || null, new_cat_image || null]
        );
        finalCategoryId = catRes.rows[0].id;
      }

      const miRes = await db.query(
        `INSERT INTO menu_items (tenant_id, category_id, name, name_ar, name_ku, price, image_url, is_available)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING id`,
        [req.user.tenantId, finalCategoryId,
         (menu_name || name).trim(),
         menu_name_ar?.trim() || null,
         menu_name_ku?.trim() || null,
         parseFloat(selling_price) || 0,
         menu_image || null]
      );
      menuItemId = miRes.rows[0].id;
    }

    const initQty  = parseFloat(initial_stock_qty) || 0;
    const initCost = parseFloat(initial_avg_cost)  || 0;

    const { barcode } = req.body;
    await db.query(
      `INSERT INTO inventory_items (tenant_id, name, sku, barcode, unit, reorder_level, stock_qty, avg_cost, menu_item_id, is_raw_material, is_semi_finished, can_be_sold, inv_category_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [req.user.tenantId, name.trim(), sku?.trim() || null, barcode?.trim() || null, unit || 'pcs',
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
  const { name, sku, barcode, unit, reorder_level, menu_item_id, is_raw_material, is_semi_finished, can_be_sold, inv_category_id } = req.body;
  try {
    await db.query(
      `UPDATE inventory_items SET name=$1, sku=$2, barcode=$3, unit=$4, reorder_level=$5, menu_item_id=$6,
        is_raw_material=$7, is_semi_finished=$8, can_be_sold=$9, inv_category_id=$10
       WHERE id=$11 AND tenant_id=$12`,
      [name.trim(), sku?.trim() || null, barcode?.trim() || null, unit || 'pcs', parseFloat(reorder_level) || 0,
       menu_item_id || null, !!is_raw_material, !!is_semi_finished, !!can_be_sold,
       inv_category_id || null, req.params.id, req.user.tenantId]
    );
    res.redirect('/inventory/items');
  } catch (err) { console.error(err); res.redirect('/inventory/items?error=' + encodeURIComponent(err.message)); }
});

// Barcode lookup API (used by purchase form scanner)
router.get('/api/barcode/:code', requireAuth, requireInventory, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, name, unit, barcode, avg_cost FROM inventory_items WHERE tenant_id=$1 AND barcode=$2 AND is_active=true LIMIT 1`,
      [req.user.tenantId, req.params.code.trim()]
    );
    if (!r.rows[0]) return res.json({ found: false });
    res.json({ found: true, item: r.rows[0] });
  } catch (err) { res.json({ found: false }); }
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
    const [itemRes, recipeRes, ingredientsRes, locsRes] = await Promise.all([
      db.query(`
        SELECT ii.*, mi.name AS menu_item_name, mi.production_location_id
        FROM inventory_items ii
        LEFT JOIN menu_items mi ON mi.id = ii.menu_item_id
        WHERE ii.id=$1 AND ii.tenant_id=$2
      `, [req.params.id, tid]),
      db.query(`
        SELECT ir.*, ii.name AS ingredient_name, ii.unit, ii.avg_cost,
               ROUND(ir.quantity * ii.avg_cost, 4) AS line_cost
        FROM inventory_recipes ir
        JOIN inventory_items ii ON ii.id = ir.ingredient_id
        WHERE ir.item_id=$1 ORDER BY ii.name
      `, [req.params.id]),
      db.query(`SELECT id, name, unit, avg_cost FROM inventory_items WHERE tenant_id=$1 AND is_active=true AND id != $2 ORDER BY name`, [tid, req.params.id]),
      db.query(`SELECT id, name, color FROM inventory_locations WHERE tenant_id=$1 AND active=true ORDER BY name`, [tid]),
    ]);
    if (!itemRes.rows[0]) return res.status(404).send('Item not found');
    const totalCost = recipeRes.rows.reduce((s, r) => s + parseFloat(r.line_cost), 0);
    res.render('inventory/recipe', {
      tenant: req.tenant,
      currentUser: req.user,
      item: itemRes.rows[0],
      recipe: recipeRes.rows,
      ingredients: ingredientsRes.rows,
      locations: locsRes.rows,
      totalCost,
      success: req.query.success || null,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// Set production location for a menu item via the recipe page
router.post('/items/:id/set-location', requireAuth, requireInventory, async (req, res) => {
  try {
    const tid = req.user.tenantId;
    const { production_location_id } = req.body;
    const itemRes = await db.query(`SELECT menu_item_id FROM inventory_items WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]);
    if (!itemRes.rows[0]?.menu_item_id) return res.redirect('/inventory/items/' + req.params.id + '/recipe?success=no_menu_item');
    const locId = parseInt(production_location_id) || null;
    await db.query(`UPDATE menu_items SET production_location_id=$1 WHERE id=$2`, [locId, itemRes.rows[0].menu_item_id]);
    res.redirect('/inventory/items/' + req.params.id + '/recipe?success=location_saved');
  } catch (err) { console.error(err); res.redirect('/inventory/items/' + req.params.id + '/recipe'); }
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
    const tid = req.user.tenantId;
    const [invItemsRes, suppliersRes, lastPricesRes, locsRes] = await Promise.all([
      db.query(`SELECT id, name, unit, barcode FROM inventory_items WHERE tenant_id=$1 AND is_active=true ORDER BY name`, [tid]),
      db.query(`SELECT id, name FROM suppliers WHERE tenant_id=$1 ORDER BY name`, [tid]),
      db.query(`
        SELECT DISTINCT ON (prl.item_id)
          prl.item_id,
          prl.unit_price   AS last_price,
          pr.receipt_date  AS last_date,
          pr.supplier_name AS last_supplier
        FROM purchase_receipt_lines prl
        JOIN purchase_receipts pr ON pr.id = prl.receipt_id
        WHERE pr.tenant_id=$1 AND pr.status='active' AND prl.item_id IS NOT NULL
        ORDER BY prl.item_id, pr.receipt_date DESC, pr.id DESC
      `, [tid]),
      db.query(`SELECT id, name, color FROM inventory_locations WHERE tenant_id=$1 AND active=true ORDER BY sort_order, name`, [tid]),
    ]);
    const lastPrices = {};
    lastPricesRes.rows.forEach(r => {
      lastPrices[r.item_id] = {
        price: parseFloat(r.last_price),
        date: r.last_date ? new Date(r.last_date).toLocaleDateString() : null,
        supplier: r.last_supplier || null,
      };
    });

    // Pre-fill from PO if ?po= query param provided
    let prefillPO = null;
    if (req.query.po) {
      const [poR, poLinesR] = await Promise.all([
        db.query(`SELECT * FROM purchase_orders WHERE id=$1 AND tenant_id=$2`, [req.query.po, tid]),
        db.query(`SELECT * FROM purchase_order_lines WHERE order_id=$1`, [req.query.po]),
      ]);
      if (poR.rows[0] && poR.rows[0].status !== 'cancelled') {
        prefillPO = { ...poR.rows[0], lines: poLinesR.rows };
      }
    }

    res.render('inventory/purchase-new', {
      tenant: req.tenant,
      currentUser: req.user,
      invItems: invItemsRes.rows,
      suppliers: suppliersRes.rows,
      lastPrices,
      locations: locsRes.rows,
      prefillPO,
      error: req.query.error || null,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.get('/purchases/:id', requireAuth, requireInventory, async (req, res) => {
  try {
    const [receiptRes, linesRes] = await Promise.all([
      db.query(`
        SELECT pr.*, u.name AS created_by_name,
               il.name AS location_name, il.color AS location_color
        FROM purchase_receipts pr
        LEFT JOIN users u ON u.id=pr.created_by
        LEFT JOIN inventory_locations il ON il.id=pr.location_id
        WHERE pr.id=$1 AND pr.tenant_id=$2
      `, [req.params.id, req.user.tenantId]),
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
  const { supplier_name, supplier_id, invoice_no, receipt_date, notes, bill_image, location_id, po_id,
          item_id, new_item_name, unit, quantity, unit_price, batch_no, expiry_date } = req.body;
  const tid = req.user.tenantId;
  const locId = parseInt(location_id) || null;
  const poId  = parseInt(po_id) || null;

  const toArr = v => Array.isArray(v) ? v : (v !== undefined ? [v] : []);
  const itemIds     = toArr(item_id);
  const newNames    = toArr(new_item_name);
  const units       = toArr(unit);
  const qtys        = toArr(quantity);
  const prices      = toArr(unit_price);
  const batchNos    = toArr(batch_no);
  const expiryDates = toArr(expiry_date);

  const lines = itemIds.map((iid, i) => ({
    item_id:       iid,
    new_item_name: newNames[i]?.trim() || '',
    unit:          units[i]?.trim() || 'pcs',
    quantity:      parseFloat(qtys[i]),
    unit_price:    parseFloat(prices[i]),
    batch_no:      batchNos[i]?.trim() || null,
    expiry_date:   expiryDates[i]?.trim() || null,
  })).filter(l => !isNaN(l.quantity) && l.quantity > 0 && !isNaN(l.unit_price) && l.unit_price >= 0
              && (l.item_id !== 'new' || l.new_item_name));

  if (!lines.length) return res.redirect('/inventory/purchases/new?error=no_lines');

  const total = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const rr = await client.query(
      `INSERT INTO purchase_receipts (tenant_id, supplier_name, supplier_id, invoice_no, receipt_date, total, notes, bill_image, location_id, po_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [tid, supplier_name?.trim() || null, parseInt(supplier_id)||null, invoice_no?.trim() || null,
       receipt_date || new Date().toISOString().slice(0, 10), total,
       notes?.trim() || null, bill_image || null, locId, poId, req.user.userId]
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
          // Update per-location stock if a location was selected
          if (locId) {
            await client.query(
              `INSERT INTO inventory_stock (tenant_id, item_id, location_id, quantity)
               VALUES ($1,$2,$3,$4)
               ON CONFLICT (tenant_id, item_id, location_id) DO UPDATE SET quantity = inventory_stock.quantity + $4`,
              [tid, resolvedItemId, locId, l.quantity]
            );
          }
        }
      }

      const lineTotal = l.quantity * l.unit_price;
      await client.query(
        `INSERT INTO purchase_receipt_lines (receipt_id, item_id, item_name, unit, quantity, unit_price, total, batch_no, expiry_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [receiptId, resolvedItemId || null, resolvedName || '', l.unit, l.quantity, l.unit_price, lineTotal,
         l.batch_no || null, l.expiry_date || null]
      );
      // Insert batch record if expiry date provided
      if (resolvedItemId && l.expiry_date) {
        await client.query(
          `INSERT INTO inventory_batches (tenant_id, item_id, location_id, receipt_id, batch_no, expiry_date, initial_qty, quantity)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
          [tid, resolvedItemId, locId, receiptId, l.batch_no||null, l.expiry_date, l.quantity]
        );
      }
      // Update PO line received_qty if linked to a PO
      if (poId && resolvedItemId) {
        await client.query(
          `UPDATE purchase_order_lines SET received_qty = received_qty + $1
           WHERE order_id=$2 AND item_id=$3`,
          [l.quantity, poId, resolvedItemId]
        );
      }
    }

    // Update PO status after all lines processed
    if (poId) {
      const poCheck = await client.query(
        `SELECT COUNT(*) FILTER (WHERE received_qty >= ordered_qty) AS done,
                COUNT(*) AS total
         FROM purchase_order_lines WHERE order_id=$1`, [poId]
      );
      const { done, total } = poCheck.rows[0];
      const newStatus = parseInt(done) >= parseInt(total) ? 'received' : 'partial';
      await client.query(`UPDATE purchase_orders SET status=$1 WHERE id=$2`, [newStatus, poId]);
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

// AJAX quick-create supplier (used from purchase form)
router.post('/suppliers/quick', requireAuth, requireInventory, async (req, res) => {
  const { name, phone, email, address, tax_no, opening_balance, notes } = req.body;
  try {
    if (!name || !name.trim()) return res.json({ ok: false, error: 'Name is required' });
    const r = await db.query(
      `INSERT INTO suppliers (tenant_id,name,phone,email,address,tax_no,opening_balance,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name`,
      [req.user.tenantId, name.trim(), phone||null, email||null, address||null, tax_no||null, parseFloat(opening_balance)||0, notes||null]
    );
    res.json({ ok: true, id: r.rows[0].id, name: r.rows[0].name });
  } catch (err) { console.error(err); res.json({ ok: false, error: err.message }); }
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
    const [suppRes, purchRes, payRes, ledgerRes, monthlyRes] = await Promise.all([
      db.query(`SELECT * FROM suppliers WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]),
      db.query(`SELECT * FROM purchase_receipts WHERE supplier_id=$1 AND tenant_id=$2 ORDER BY receipt_date DESC`, [req.params.id, tid]),
      db.query(`SELECT * FROM supplier_payments WHERE supplier_id=$1 AND tenant_id=$2 ORDER BY payment_date DESC, created_at DESC`, [req.params.id, tid]),
      // Full chronological ledger (purchases + payments combined)
      db.query(`
        SELECT * FROM (
          SELECT receipt_date AS txn_date, 'Purchase' AS type, invoice_no AS reference,
                 COALESCE(total,0) AS debit, 0 AS credit, id AS source_id, 'purchase' AS source_type,
                 notes, status
          FROM purchase_receipts
          WHERE tenant_id=$1 AND supplier_id=$2
          UNION ALL
          SELECT payment_date AS txn_date, 'Payment' AS type, method AS reference,
                 0 AS debit, COALESCE(amount,0) AS credit, id AS source_id, 'payment' AS source_type,
                 notes, 'active' AS status
          FROM supplier_payments
          WHERE tenant_id=$1 AND supplier_id=$2
        ) t ORDER BY txn_date ASC, source_type DESC
      `, [tid, req.params.id]),
      // Monthly purchase totals for mini-chart
      db.query(`
        SELECT TO_CHAR(receipt_date,'YYYY-MM') AS month, COALESCE(SUM(total),0) AS total
        FROM purchase_receipts WHERE tenant_id=$1 AND supplier_id=$2 AND status='active'
        GROUP BY month ORDER BY month DESC LIMIT 12
      `, [tid, req.params.id]),
    ]);
    if (!suppRes.rows[0]) return res.redirect('/inventory/suppliers');
    const supplier = suppRes.rows[0];
    const totalPurchased = purchRes.rows.filter(r => r.status !== 'voided').reduce((s, r) => s + parseFloat(r.total || 0), 0);
    const totalPaid = payRes.rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const balance = totalPurchased + parseFloat(supplier.opening_balance || 0) - totalPaid;

    // Running balance on ledger
    let running = parseFloat(supplier.opening_balance || 0);
    const ledger = ledgerRes.rows.map(r => {
      if (r.status === 'voided') return { ...r, running_balance: running, skipped: true };
      running += parseFloat(r.debit) - parseFloat(r.credit);
      return { ...r, running_balance: running };
    });

    // Aging buckets (from active purchases only)
    const today = new Date();
    const aging = { current: 0, d30: 0, d60: 0, d90: 0, older: 0 };
    purchRes.rows.filter(r => r.status !== 'voided').forEach(r => {
      const days = Math.floor((today - new Date(r.receipt_date)) / 86400000);
      if (days <= 30) aging.current += parseFloat(r.total || 0);
      else if (days <= 60) aging.d30 += parseFloat(r.total || 0);
      else if (days <= 90) aging.d60 += parseFloat(r.total || 0);
      else if (days <= 120) aging.d90 += parseFloat(r.total || 0);
      else aging.older += parseFloat(r.total || 0);
    });

    res.render('inventory/supplier-detail', {
      tenant: req.tenant, currentUser: req.user,
      supplier, purchases: purchRes.rows, payments: payRes.rows,
      totalPurchased, totalPaid, balance,
      ledger, aging,
      monthly: monthlyRes.rows.reverse(),
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

// ── Purchase Orders ────────────────────────────────────────────────────────────
router.get('/purchase-orders', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [ordRes, suppRes] = await Promise.all([
      db.query(`
        SELECT po.*, s.name AS supplier_name_obj, u.name AS created_by_name,
               (SELECT COUNT(*) FROM purchase_order_lines WHERE order_id=po.id)::int AS line_count,
               (SELECT COUNT(*) FROM purchase_receipts WHERE po_id=po.id)::int AS receipt_count
        FROM purchase_orders po
        LEFT JOIN suppliers s ON s.id=po.supplier_id
        LEFT JOIN users u ON u.id=po.created_by
        WHERE po.tenant_id=$1
        ORDER BY po.created_at DESC LIMIT 100
      `, [tid]),
      db.query(`SELECT id, name FROM suppliers WHERE tenant_id=$1 ORDER BY name`, [tid]),
    ]);
    res.render('inventory/purchase-orders', {
      tenant: req.tenant, currentUser: req.user,
      orders: ordRes.rows, suppliers: suppRes.rows,
      success: req.query.success || null, error: req.query.error || null,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.get('/purchase-orders/new', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [itemsRes, suppRes] = await Promise.all([
      db.query(`SELECT id, name, unit FROM inventory_items WHERE tenant_id=$1 AND is_active=true ORDER BY name`, [tid]),
      db.query(`SELECT id, name FROM suppliers WHERE tenant_id=$1 ORDER BY name`, [tid]),
    ]);
    res.render('inventory/purchase-order-new', {
      tenant: req.tenant, currentUser: req.user,
      invItems: itemsRes.rows, suppliers: suppRes.rows,
      error: req.query.error || null,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/purchase-orders', requireAuth, requireInventory, async (req, res) => {
  const { supplier_name, supplier_id, po_number, order_date, expected_date, notes, item_id, unit, quantity, unit_price } = req.body;
  const tid = req.user.tenantId;
  const toArr = v => Array.isArray(v) ? v : (v !== undefined ? [v] : []);
  const itemIds = toArr(item_id), units = toArr(unit), qtys = toArr(quantity), prices = toArr(unit_price);

  const lines = itemIds.map((id, i) => ({
    item_id: id, unit: units[i] || 'pcs',
    ordered_qty: parseFloat(qtys[i]) || 0,
    unit_price: parseFloat(prices[i]) || 0,
  })).filter(l => l.ordered_qty > 0);

  if (!lines.length) return res.redirect('/inventory/purchase-orders/new?error=Add+at+least+one+item');

  const total = lines.reduce((s, l) => s + l.ordered_qty * l.unit_price, 0);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const poRes = await client.query(
      `INSERT INTO purchase_orders (tenant_id, supplier_id, supplier_name, po_number, order_date, expected_date, notes, total, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [tid, parseInt(supplier_id)||null, supplier_name?.trim()||null,
       po_number?.trim()||null, order_date||new Date().toISOString().slice(0,10),
       expected_date||null, notes?.trim()||null, total, req.user.userId]
    );
    const poId = poRes.rows[0].id;
    for (const l of lines) {
      let name = null;
      if (l.item_id && l.item_id !== 'new') {
        const r = await client.query(`SELECT name FROM inventory_items WHERE id=$1 AND tenant_id=$2`, [l.item_id, tid]);
        name = r.rows[0]?.name || null;
      }
      await client.query(
        `INSERT INTO purchase_order_lines (order_id, item_id, item_name, unit, ordered_qty, unit_price, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [poId, parseInt(l.item_id)||null, name, l.unit, l.ordered_qty, l.unit_price, l.ordered_qty * l.unit_price]
      );
    }
    await client.query('COMMIT');
    res.redirect('/inventory/purchase-orders/' + poId + '?success=PO+created');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.redirect('/inventory/purchase-orders/new?error=' + encodeURIComponent(err.message));
  } finally { client.release(); }
});

router.get('/purchase-orders/:id', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [poRes, linesRes, receiptsRes] = await Promise.all([
      db.query(`
        SELECT po.*, u.name AS created_by_name, s.name AS supplier_obj_name
        FROM purchase_orders po
        LEFT JOIN users u ON u.id=po.created_by
        LEFT JOIN suppliers s ON s.id=po.supplier_id
        WHERE po.id=$1 AND po.tenant_id=$2
      `, [req.params.id, tid]),
      db.query(`SELECT * FROM purchase_order_lines WHERE order_id=$1 ORDER BY id`, [req.params.id]),
      db.query(`SELECT id, receipt_date, total, status FROM purchase_receipts WHERE po_id=$1 ORDER BY created_at DESC`, [req.params.id]),
    ]);
    if (!poRes.rows[0]) return res.redirect('/inventory/purchase-orders');
    res.render('inventory/purchase-order-view', {
      tenant: req.tenant, currentUser: req.user,
      po: poRes.rows[0], lines: linesRes.rows, receipts: receiptsRes.rows,
      success: req.query.success || null, error: req.query.error || null,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/purchase-orders/:id/send', requireAuth, requireInventory, async (req, res) => {
  try {
    await db.query(`UPDATE purchase_orders SET status='sent' WHERE id=$1 AND tenant_id=$2 AND status='draft'`, [req.params.id, req.user.tenantId]);
    res.redirect('/inventory/purchase-orders/' + req.params.id + '?success=PO+marked+as+sent');
  } catch (err) { res.redirect('/inventory/purchase-orders/' + req.params.id + '?error=' + encodeURIComponent(err.message)); }
});

router.post('/purchase-orders/:id/cancel', requireAuth, requireInventory, async (req, res) => {
  try {
    await db.query(`UPDATE purchase_orders SET status='cancelled' WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenantId]);
    res.redirect('/inventory/purchase-orders/' + req.params.id + '?success=PO+cancelled');
  } catch (err) { res.redirect('/inventory/purchase-orders/' + req.params.id + '?error=' + encodeURIComponent(err.message)); }
});

// ── Locations ─────────────────────────────────────────────────────────────────
router.get('/locations', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [locsRes, stockRes] = await Promise.all([
      db.query(`SELECT * FROM inventory_locations WHERE tenant_id=$1 ORDER BY sort_order, name`, [tid]),
      db.query(`
        SELECT location_id, COUNT(DISTINCT item_id)::int AS item_count,
               COALESCE(SUM(quantity),0) AS total_qty
        FROM inventory_stock WHERE tenant_id=$1 GROUP BY location_id
      `, [tid]),
    ]);
    const stockMap = {};
    stockRes.rows.forEach(r => { stockMap[r.location_id] = r; });
    const locations = locsRes.rows.map(l => ({ ...l, ...stockMap[l.id] }));
    res.render('inventory/locations', {
      tenant: req.tenant, currentUser: req.user,
      locations,
      success: req.query.success || null,
      error: req.query.error || null,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/locations', requireAuth, requireInventory, async (req, res) => {
  const { name, type, color, is_default } = req.body;
  const tid = req.user.tenantId;
  if (!name?.trim()) return res.redirect('/inventory/locations?error=Name+required');
  try {
    if (is_default) await db.query(`UPDATE inventory_locations SET is_default=false WHERE tenant_id=$1`, [tid]);
    await db.query(
      `INSERT INTO inventory_locations (tenant_id, name, type, color, is_default) VALUES ($1,$2,$3,$4,$5)`,
      [tid, name.trim(), type || 'storage', color || '#7c5cbf', !!is_default]
    );
    res.redirect('/inventory/locations?success=Location+added');
  } catch (err) { console.error(err); res.redirect('/inventory/locations?error=' + encodeURIComponent(err.message)); }
});

router.post('/locations/:id/edit', requireAuth, requireInventory, async (req, res) => {
  const { name, type, color, is_default, sort_order } = req.body;
  const tid = req.user.tenantId;
  try {
    if (is_default) await db.query(`UPDATE inventory_locations SET is_default=false WHERE tenant_id=$1`, [tid]);
    await db.query(
      `UPDATE inventory_locations SET name=$1, type=$2, color=$3, is_default=$4, sort_order=$5 WHERE id=$6 AND tenant_id=$7`,
      [name.trim(), type || 'storage', color || '#7c5cbf', !!is_default, parseInt(sort_order) || 0, req.params.id, tid]
    );
    res.redirect('/inventory/locations?success=Saved');
  } catch (err) { console.error(err); res.redirect('/inventory/locations?error=' + encodeURIComponent(err.message)); }
});

router.post('/locations/:id/delete', requireAuth, requireInventory, async (req, res) => {
  try {
    const tid = req.user.tenantId;
    const chk = await db.query(`SELECT COALESCE(SUM(quantity),0) AS qty FROM inventory_stock WHERE location_id=$1 AND tenant_id=$2`, [req.params.id, tid]);
    if (parseFloat(chk.rows[0].qty) > 0) return res.redirect('/inventory/locations?error=Cannot+delete+location+with+stock');
    await db.query(`DELETE FROM inventory_locations WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]);
    res.redirect('/inventory/locations?success=Deleted');
  } catch (err) { console.error(err); res.redirect('/inventory/locations?error=' + encodeURIComponent(err.message)); }
});

// ── Transfers ──────────────────────────────────────────────────────────────────
router.get('/transfers', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [txRes, locsRes] = await Promise.all([
      db.query(`
        SELECT t.*,
          fl.name AS from_name, fl.color AS from_color,
          tl.name AS to_name,   tl.color AS to_color,
          u.name AS created_by_name,
          (SELECT COUNT(*) FROM inventory_transfer_lines WHERE transfer_id=t.id)::int AS line_count
        FROM inventory_transfers t
        LEFT JOIN inventory_locations fl ON fl.id=t.from_location_id
        LEFT JOIN inventory_locations tl ON tl.id=t.to_location_id
        LEFT JOIN users u ON u.id=t.created_by
        WHERE t.tenant_id=$1
        ORDER BY t.created_at DESC LIMIT 100
      `, [tid]),
      db.query(`SELECT * FROM inventory_locations WHERE tenant_id=$1 AND active=true ORDER BY name`, [tid]),
    ]);
    res.render('inventory/transfers', {
      tenant: req.tenant, currentUser: req.user,
      transfers: txRes.rows, locations: locsRes.rows,
      success: req.query.success || null, error: req.query.error || null,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.get('/transfers/new', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [locsRes, itemsRes] = await Promise.all([
      db.query(`SELECT * FROM inventory_locations WHERE tenant_id=$1 AND active=true ORDER BY sort_order, name`, [tid]),
      db.query(`SELECT id, name, unit, stock_qty FROM inventory_items WHERE tenant_id=$1 AND is_active=true ORDER BY name`, [tid]),
    ]);
    res.render('inventory/transfer-new', {
      tenant: req.tenant, currentUser: req.user,
      locations: locsRes.rows, items: itemsRes.rows,
      error: req.query.error || null,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.get('/transfers/:id', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [txRes, linesRes] = await Promise.all([
      db.query(`
        SELECT t.*,
          fl.name AS from_name, fl.color AS from_color,
          tl.name AS to_name,   tl.color AS to_color,
          u.name AS created_by_name
        FROM inventory_transfers t
        LEFT JOIN inventory_locations fl ON fl.id=t.from_location_id
        LEFT JOIN inventory_locations tl ON tl.id=t.to_location_id
        LEFT JOIN users u ON u.id=t.created_by
        WHERE t.id=$1 AND t.tenant_id=$2
      `, [req.params.id, tid]),
      db.query(`
        SELECT itl.*, ii.unit AS item_unit
        FROM inventory_transfer_lines itl
        LEFT JOIN inventory_items ii ON ii.id=itl.item_id
        WHERE itl.transfer_id=$1 ORDER BY itl.id
      `, [req.params.id]),
    ]);
    if (!txRes.rows[0]) return res.redirect('/inventory/transfers');
    res.render('inventory/transfer-view', {
      tenant: req.tenant, currentUser: req.user,
      transfer: txRes.rows[0], lines: linesRes.rows,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/transfers', requireAuth, requireInventory, async (req, res) => {
  const { from_location_id, to_location_id, transfer_date, notes, item_id, quantity } = req.body;
  const tid = req.user.tenantId;

  if (!from_location_id || !to_location_id) return res.redirect('/inventory/transfers/new?error=Select+both+locations');
  if (from_location_id === to_location_id) return res.redirect('/inventory/transfers/new?error=From+and+To+must+be+different');

  const toArr = v => Array.isArray(v) ? v : (v !== undefined ? [v] : []);
  const itemIds = toArr(item_id);
  const qtys    = toArr(quantity);

  const lines = itemIds.map((id, i) => ({
    item_id: parseInt(id),
    quantity: parseFloat(qtys[i]),
  })).filter(l => l.item_id && !isNaN(l.quantity) && l.quantity > 0);

  if (!lines.length) return res.redirect('/inventory/transfers/new?error=Add+at+least+one+item');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verify locations belong to tenant
    const locCheck = await client.query(
      `SELECT id FROM inventory_locations WHERE id IN ($1,$2) AND tenant_id=$3`,
      [from_location_id, to_location_id, tid]
    );
    if (locCheck.rows.length < 2) { await client.query('ROLLBACK'); return res.redirect('/inventory/transfers/new?error=Invalid+locations'); }

    const txRes = await client.query(
      `INSERT INTO inventory_transfers (tenant_id, from_location_id, to_location_id, transfer_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [tid, from_location_id, to_location_id, transfer_date || new Date().toISOString().slice(0,10), notes || null, req.user.userId]
    );
    const txId = txRes.rows[0].id;

    for (const l of lines) {
      const itemRes = await client.query(`SELECT name, unit, stock_qty FROM inventory_items WHERE id=$1 AND tenant_id=$2`, [l.item_id, tid]);
      if (!itemRes.rows[0]) continue;
      const { name, unit } = itemRes.rows[0];

      // Deduct from source location stock (allow negative for flexibility)
      await client.query(
        `INSERT INTO inventory_stock (tenant_id, item_id, location_id, quantity)
         VALUES ($1,$2,$3,-$4)
         ON CONFLICT (tenant_id, item_id, location_id) DO UPDATE SET quantity = inventory_stock.quantity - $4`,
        [tid, l.item_id, from_location_id, l.quantity]
      );
      // Add to destination location stock
      await client.query(
        `INSERT INTO inventory_stock (tenant_id, item_id, location_id, quantity)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, item_id, location_id) DO UPDATE SET quantity = inventory_stock.quantity + $4`,
        [tid, l.item_id, to_location_id, l.quantity]
      );

      await client.query(
        `INSERT INTO inventory_transfer_lines (transfer_id, item_id, item_name, quantity, unit)
         VALUES ($1,$2,$3,$4,$5)`,
        [txId, l.item_id, name, l.quantity, unit]
      );
    }

    await client.query('COMMIT');
    res.redirect('/inventory/transfers/' + txId + '?success=Transfer+completed');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.redirect('/inventory/transfers/new?error=' + encodeURIComponent(err.message));
  } finally { client.release(); }
});

// ── Waste / Spoilage ──────────────────────────────────────────────────────────
router.get('/waste', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [wasteRes, itemsRes, locsRes] = await Promise.all([
      db.query(`
        SELECT w.*, l.name AS loc_name, l.color AS loc_color, u.name AS created_by_name
        FROM inventory_waste w
        LEFT JOIN inventory_locations l ON l.id=w.location_id
        LEFT JOIN users u ON u.id=w.created_by
        WHERE w.tenant_id=$1
        ORDER BY w.waste_date DESC, w.created_at DESC
        LIMIT 100
      `, [tid]),
      db.query(`SELECT id, name, unit, avg_cost FROM inventory_items WHERE tenant_id=$1 AND is_active=true ORDER BY name`, [tid]),
      db.query(`SELECT id, name, color FROM inventory_locations WHERE tenant_id=$1 AND active=true ORDER BY name`, [tid]),
    ]);
    // This month summary
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const monthWaste = await db.query(
      `SELECT COALESCE(SUM(cost_impact),0) AS total_cost, COALESCE(SUM(qty),0) AS total_qty, COUNT(*)::int AS entries
       FROM inventory_waste WHERE tenant_id=$1 AND waste_date >= $2`,
      [tid, monthStart.toISOString().slice(0,10)]
    );
    res.render('inventory/waste', {
      tenant: req.tenant, currentUser: req.user,
      wasteLog: wasteRes.rows, items: itemsRes.rows, locations: locsRes.rows,
      monthSummary: monthWaste.rows[0],
      success: req.query.success || null, error: req.query.error || null,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

router.post('/waste', requireAuth, requireInventory, async (req, res) => {
  const { item_id, qty, reason, waste_date, location_id, notes } = req.body;
  const tid = req.user.tenantId;
  const quantity = parseFloat(qty);
  if (!item_id || isNaN(quantity) || quantity <= 0) return res.redirect('/inventory/waste?error=Invalid+entry');
  try {
    const itemRes = await db.query(`SELECT name, unit, avg_cost FROM inventory_items WHERE id=$1 AND tenant_id=$2`, [item_id, tid]);
    if (!itemRes.rows[0]) return res.redirect('/inventory/waste?error=Item+not+found');
    const { name, unit, avg_cost } = itemRes.rows[0];
    const costImpact = quantity * parseFloat(avg_cost || 0);
    await db.query(
      `INSERT INTO inventory_waste (tenant_id, item_id, item_name, location_id, qty, unit, reason, waste_date, cost_impact, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [tid, item_id, name, parseInt(location_id)||null, quantity, unit,
       reason || 'other', waste_date || new Date().toISOString().slice(0,10),
       costImpact, notes?.trim()||null, req.user.userId]
    );
    await db.query(`UPDATE inventory_items SET stock_qty = stock_qty - $1 WHERE id=$2 AND tenant_id=$3`, [quantity, item_id, tid]);
    await db.query(
      `INSERT INTO inventory_transactions (tenant_id, item_id, type, qty_change, notes, created_by) VALUES ($1,$2,'waste',$3,$4,$5)`,
      [tid, item_id, -quantity, (reason || 'waste') + (notes ? ': ' + notes : ''), req.user.userId]
    );
    if (parseInt(location_id)) {
      await db.query(
        `INSERT INTO inventory_stock (tenant_id, item_id, location_id, quantity) VALUES ($1,$2,$3,-$4)
         ON CONFLICT (tenant_id, item_id, location_id) DO UPDATE SET quantity = inventory_stock.quantity - $4`,
        [tid, item_id, location_id, quantity]
      );
    }
    res.redirect('/inventory/waste?success=Waste+recorded');
  } catch (err) { console.error(err); res.redirect('/inventory/waste?error=' + encodeURIComponent(err.message)); }
});

// ── Expiring batches ───────────────────────────────────────────────────────────
router.get('/expiring', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  const days = parseInt(req.query.days) || 30;
  try {
    const [batchRes, locsRes] = await Promise.all([
      db.query(`
        SELECT b.*, ii.name AS item_name, ii.unit, l.name AS loc_name, l.color AS loc_color
        FROM inventory_batches b
        JOIN inventory_items ii ON ii.id=b.item_id
        LEFT JOIN inventory_locations l ON l.id=b.location_id
        WHERE b.tenant_id=$1 AND b.expiry_date IS NOT NULL AND b.quantity > 0
          AND b.expiry_date <= CURRENT_DATE + ($2 || ' days')::INTERVAL
        ORDER BY b.expiry_date ASC
      `, [tid, days]),
      db.query(`SELECT id, name FROM inventory_locations WHERE tenant_id=$1 ORDER BY name`, [tid]),
    ]);
    res.render('inventory/expiring', {
      tenant: req.tenant, currentUser: req.user,
      batches: batchRes.rows, locations: locsRes.rows, days,
    });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
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
      // Find inventory product + production location linked to this menu item
      const invRes = await db.query(
        `SELECT ii.id, mi.production_location_id
         FROM inventory_items ii
         JOIN menu_items mi ON mi.id = ii.menu_item_id
         WHERE ii.tenant_id=$1 AND ii.menu_item_id=$2 AND ii.is_active=true LIMIT 1`,
        [tenantId, oi.menu_item_id]
      );
      if (!invRes.rows[0]) continue;
      const invItemId = invRes.rows[0].id;
      const locationId = invRes.rows[0].production_location_id || null;

      // Get recipe
      const recipe = await db.query(`SELECT * FROM inventory_recipes WHERE item_id=$1`, [invItemId]);
      if (recipe.rows.length === 0) {
        const deduct = parseInt(oi.quantity);
        await db.query(
          `UPDATE inventory_items SET stock_qty = stock_qty - $1 WHERE id=$2 AND tenant_id=$3`,
          [deduct, invItemId, tenantId]
        );
        if (locationId) {
          await db.query(
            `INSERT INTO inventory_stock (tenant_id, item_id, location_id, quantity) VALUES ($1,$2,$3,-$4)
             ON CONFLICT (tenant_id, item_id, location_id) DO UPDATE SET quantity = inventory_stock.quantity - $4`,
            [tenantId, invItemId, locationId, deduct]
          );
        }
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
          if (locationId) {
            await db.query(
              `INSERT INTO inventory_stock (tenant_id, item_id, location_id, quantity) VALUES ($1,$2,$3,-$4)
               ON CONFLICT (tenant_id, item_id, location_id) DO UPDATE SET quantity = inventory_stock.quantity - $4`,
              [tenantId, r.ingredient_id, locationId, deduct]
            );
          }
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

// ── Goods Returns / Debit Notes ───────────────────────────────────
router.get('/returns', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [returnsRes, suppRes] = await Promise.all([
      db.query(`SELECT pr.*, u.name AS created_by_name
                FROM purchase_returns pr LEFT JOIN users u ON u.id=pr.created_by
                WHERE pr.tenant_id=$1 ORDER BY pr.created_at DESC LIMIT 50`, [tid]),
      db.query(`SELECT id, name FROM suppliers WHERE tenant_id=$1 ORDER BY name`, [tid]),
    ]);
    res.render('inventory/returns', {
      tenant: req.tenant, currentUser: req.user,
      returns: returnsRes.rows, suppliers: suppRes.rows,
      success: req.query.success ? decodeURIComponent(req.query.success) : null,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

router.get('/returns/new', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [itemsRes, suppRes] = await Promise.all([
      db.query(`SELECT id, name, unit, avg_cost FROM inventory_items WHERE tenant_id=$1 AND is_active=true ORDER BY name`, [tid]),
      db.query(`SELECT id, name FROM suppliers WHERE tenant_id=$1 ORDER BY name`, [tid]),
    ]);
    res.render('inventory/return-new', {
      tenant: req.tenant, currentUser: req.user,
      items: itemsRes.rows, suppliers: suppRes.rows,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

router.post('/returns', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  const { supplier_id, supplier_name, return_date, reference_no, reason, notes,
          'item_id[]': rawItemIds, 'qty[]': rawQtys, 'unit_price[]': rawPrices } = req.body;
  const itemIds   = [].concat(rawItemIds  || []);
  const qtys      = [].concat(rawQtys     || []);
  const unitPrices= [].concat(rawPrices   || []);
  try {
    const retRes = await db.query(
      `INSERT INTO purchase_returns (tenant_id,supplier_id,supplier_name,return_date,reference_no,reason,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [tid, supplier_id||null, supplier_name||null, return_date||new Date().toISOString().slice(0,10),
       reference_no||null, reason||null, notes||null, req.user.userId]
    );
    const retId = retRes.rows[0].id;
    let total = 0;
    for (let i = 0; i < itemIds.length; i++) {
      if (!itemIds[i]) continue;
      const qty   = parseFloat(qtys[i])       || 0;
      const price = parseFloat(unitPrices[i]) || 0;
      const lineTotal = qty * price;
      total += lineTotal;
      const item = (await db.query('SELECT name, unit FROM inventory_items WHERE id=$1 AND tenant_id=$2', [itemIds[i], tid])).rows[0];
      if (!item) continue;
      await db.query(
        `INSERT INTO purchase_return_lines (return_id,item_id,item_name,unit,qty,unit_price,total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [retId, itemIds[i], item.name, item.unit, qty, price, lineTotal]
      );
      // Deduct from stock
      await db.query('UPDATE inventory_items SET stock_qty=stock_qty-$1 WHERE id=$2 AND tenant_id=$3', [qty, itemIds[i], tid]);
      await db.query(
        `INSERT INTO inventory_transactions (tenant_id,item_id,type,qty_change,reference_id,reference_type,notes,created_by)
         VALUES ($1,$2,'return',$3,$4,'purchase_return','Goods return',$5)`,
        [tid, itemIds[i], -qty, retId, req.user.userId]
      );
    }
    await db.query('UPDATE purchase_returns SET total=$1 WHERE id=$2', [total, retId]);
    res.redirect('/inventory/returns/' + retId + '?success=Return+recorded');
  } catch(err){ console.error(err); res.redirect('/inventory/returns/new?error=' + encodeURIComponent(err.message)); }
});

router.get('/returns/:id', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [retRes, linesRes] = await Promise.all([
      db.query(`SELECT pr.*, u.name AS created_by_name
                FROM purchase_returns pr LEFT JOIN users u ON u.id=pr.created_by
                WHERE pr.id=$1 AND pr.tenant_id=$2`, [req.params.id, tid]),
      db.query('SELECT * FROM purchase_return_lines WHERE return_id=$1 ORDER BY id', [req.params.id]),
    ]);
    if (!retRes.rows[0]) return res.redirect('/inventory/returns');
    res.render('inventory/return-view', {
      tenant: req.tenant, currentUser: req.user,
      ret: retRes.rows[0], lines: linesRes.rows,
      success: req.query.success ? decodeURIComponent(req.query.success) : null,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

// ── Ingredient Price History ───────────────────────────────────────
router.get('/price-history', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const pricesRes = await db.query(`
      WITH ranked AS (
        SELECT
          prl.item_id, prl.unit_price,
          pr.receipt_date, pr.supplier_name,
          ROW_NUMBER() OVER (PARTITION BY prl.item_id ORDER BY pr.receipt_date DESC, prl.id DESC) AS rn
        FROM purchase_receipt_lines prl
        JOIN purchase_receipts pr ON pr.id = prl.receipt_id
        WHERE pr.tenant_id=$1 AND prl.item_id IS NOT NULL
      )
      SELECT
        ii.id, ii.name, ii.unit, ii.avg_cost::float,
        p1.unit_price::float AS latest_price,
        p1.receipt_date      AS latest_date,
        p1.supplier_name,
        p2.unit_price::float AS prev_price,
        CASE WHEN p2.unit_price > 0
             THEN ROUND((p1.unit_price - p2.unit_price) / p2.unit_price * 100, 1)
             ELSE NULL END::float AS change_pct
      FROM inventory_items ii
      JOIN ranked p1 ON p1.item_id = ii.id AND p1.rn = 1
      LEFT JOIN ranked p2 ON p2.item_id = ii.id AND p2.rn = 2
      WHERE ii.tenant_id=$1 AND ii.is_active=true
      ORDER BY ABS(COALESCE((p1.unit_price - p2.unit_price) / NULLIF(p2.unit_price, 0), 0)) DESC
    `, [tid]);

    // Per-item history (last 10 purchases) for selected item
    const selItemId = req.query.item ? parseInt(req.query.item) : null;
    let itemHistory = [];
    if (selItemId) {
      const histRes = await db.query(`
        SELECT prl.unit_price::float, prl.qty::float, pr.receipt_date, pr.supplier_name
        FROM purchase_receipt_lines prl
        JOIN purchase_receipts pr ON pr.id=prl.receipt_id
        WHERE pr.tenant_id=$1 AND prl.item_id=$2
        ORDER BY pr.receipt_date DESC, prl.id DESC LIMIT 20
      `, [tid, selItemId]);
      itemHistory = histRes.rows;
    }

    res.render('inventory/price-history', {
      tenant: req.tenant, currentUser: req.user,
      items: pricesRes.rows,
      selItemId,
      itemHistory,
      selItemName: selItemId ? (pricesRes.rows.find(i=>i.id===selItemId)||{}).name : null,
    });
  } catch(err){ console.error(err); res.status(500).send('Error: '+err.message); }
});

// ── Auto-Reorder Report ────────────────────────────────────────────
router.get('/reorder', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  const showAll = req.query.all === '1';

  try {
    const whereClause = showAll
      ? ''
      : `AND (ii.stock_qty <= ii.reorder_level OR (u.daily_usage > 0 AND ii.stock_qty / u.daily_usage < 14))`;

    const itemsRes = await db.query(`
      SELECT
        ii.id, ii.name, ii.unit,
        ii.stock_qty::float           AS stock_qty,
        ii.reorder_level::float       AS reorder_level,
        ii.avg_cost::float            AS avg_cost,
        COALESCE(u.daily_usage, 0)    AS avg_daily_usage,
        CASE WHEN COALESCE(u.daily_usage, 0) > 0
             THEN FLOOR(ii.stock_qty / u.daily_usage)::int
             ELSE NULL END            AS days_remaining,
        CASE WHEN COALESCE(u.daily_usage, 0) > 0
             THEN GREATEST(0, CEIL(30.0 * u.daily_usage - ii.stock_qty))
             ELSE GREATEST(0, ii.reorder_level * 2 - ii.stock_qty) END AS suggested_qty
      FROM inventory_items ii
      LEFT JOIN (
        SELECT item_id, SUM(ABS(qty_change)) / 30.0 AS daily_usage
        FROM inventory_transactions
        WHERE tenant_id=$1 AND type='sale'
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY item_id
      ) u ON u.item_id = ii.id
      WHERE ii.tenant_id=$1 AND ii.is_active = true ${whereClause}
      ORDER BY
        CASE WHEN ii.stock_qty <= ii.reorder_level THEN 0 ELSE 1 END,
        CASE WHEN u.daily_usage > 0 THEN ii.stock_qty / u.daily_usage ELSE 9999 END
    `, [tid]);

    const totalCount = (await db.query(
      'SELECT COUNT(*) AS cnt FROM inventory_items WHERE tenant_id=$1 AND is_active=true', [tid]
    )).rows[0].cnt;

    res.render('inventory/reorder', {
      tenant: req.tenant, currentUser: req.user,
      items: itemsRes.rows,
      showAll,
      totalItems: parseInt(totalCount) || 0,
      error: req.query.error || null,
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

router.post('/reorder/create-po', requireAuth, requireInventory, async (req, res) => {
  const tid     = req.user.tenantId;
  const itemIds = [].concat(req.body.item_ids || []);
  const qtys    = [].concat(req.body.qtys     || []);

  if (!itemIds.length) return res.redirect('/inventory/reorder?error=No+items+selected');

  try {
    const poRes = await db.query(
      `INSERT INTO purchase_orders (tenant_id, status, notes, created_by)
       VALUES ($1, 'draft', 'Auto-generated from Reorder Report', $2) RETURNING id`,
      [tid, req.user.userId]
    );
    const poId = poRes.rows[0].id;

    for (let i = 0; i < itemIds.length; i++) {
      if (!itemIds[i]) continue;
      const item = (await db.query(
        'SELECT name, unit, avg_cost FROM inventory_items WHERE id=$1 AND tenant_id=$2', [itemIds[i], tid]
      )).rows[0];
      if (!item) continue;
      const qty = Math.max(parseFloat(qtys[i]) || 1, 0.001);
      await db.query(
        `INSERT INTO purchase_order_lines (order_id, item_id, item_name, unit, ordered_qty, unit_price, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [poId, itemIds[i], item.name, item.unit, qty, item.avg_cost || 0,
         qty * (parseFloat(item.avg_cost) || 0)]
      );
    }

    // Update PO total
    await db.query(
      'UPDATE purchase_orders SET total=(SELECT COALESCE(SUM(total),0) FROM purchase_order_lines WHERE order_id=$1) WHERE id=$1',
      [poId]
    );

    res.redirect('/inventory/purchase-orders/' + poId);
  } catch (err) { console.error(err); res.redirect('/inventory/reorder?error=' + encodeURIComponent(err.message)); }
});

// ── Location Consumption Report ────────────────────────────────────
router.get('/location-report', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const to   = req.query.to   || new Date().toISOString().slice(0, 10);
  const selLoc = req.query.location || '';

  try {
    const [locsRes, summaryRes, ingredientsRes, soldItemsRes] = await Promise.all([
      // All locations
      db.query(`SELECT id, name, color FROM inventory_locations WHERE tenant_id=$1 AND active=true ORDER BY name`, [tid]),

      // Per-location summary: items sold, revenue
      db.query(`
        SELECT
          COALESCE(il.name, 'Unassigned') AS location_name,
          il.id AS location_id,
          COALESCE(il.color, '#888') AS location_color,
          COUNT(DISTINCT poi.menu_item_id) AS distinct_items,
          SUM(poi.quantity)::float AS total_qty,
          COALESCE(SUM(poi.price * poi.quantity), 0)::float AS revenue
        FROM pos_orders po
        JOIN pos_order_items poi ON poi.order_id = po.id AND poi.menu_item_id IS NOT NULL
        JOIN menu_items mi ON mi.id = poi.menu_item_id
        LEFT JOIN inventory_locations il ON il.id = mi.production_location_id
        WHERE po.tenant_id=$1 AND po.status='paid'
          AND po.paid_at::date BETWEEN $2 AND $3
          ${selLoc ? 'AND (mi.production_location_id=$4 OR ($4::int IS NULL AND mi.production_location_id IS NULL))' : ''}
        GROUP BY il.id, il.name, il.color
        ORDER BY revenue DESC
      `, selLoc ? [tid, from, to, parseInt(selLoc) || null] : [tid, from, to]),

      // Ingredient consumption per location
      db.query(`
        SELECT
          COALESCE(il.name, 'Unassigned') AS location_name,
          il.id AS location_id,
          COALESCE(il.color, '#888') AS location_color,
          ii_ing.id AS ingredient_id,
          ii_ing.name AS ingredient_name,
          ii_ing.unit,
          ii_ing.avg_cost::float,
          SUM(poi.quantity * ir.quantity)::float AS qty_consumed,
          SUM(poi.quantity * ir.quantity * ii_ing.avg_cost)::float AS cost_consumed
        FROM pos_orders po
        JOIN pos_order_items poi ON poi.order_id = po.id AND poi.menu_item_id IS NOT NULL
        JOIN menu_items mi ON mi.id = poi.menu_item_id
        JOIN inventory_items ii_prod ON ii_prod.menu_item_id = mi.id AND ii_prod.tenant_id = $1 AND ii_prod.is_active = true
        JOIN inventory_recipes ir ON ir.item_id = ii_prod.id
        JOIN inventory_items ii_ing ON ii_ing.id = ir.ingredient_id AND ii_ing.tenant_id = $1
        LEFT JOIN inventory_locations il ON il.id = mi.production_location_id
        WHERE po.tenant_id=$1 AND po.status='paid'
          AND po.paid_at::date BETWEEN $2 AND $3
          ${selLoc ? 'AND (mi.production_location_id=$4 OR ($4::int IS NULL AND mi.production_location_id IS NULL))' : ''}
        GROUP BY il.id, il.name, il.color, ii_ing.id, ii_ing.name, ii_ing.unit, ii_ing.avg_cost
        ORDER BY il.name NULLS LAST, cost_consumed DESC
      `, selLoc ? [tid, from, to, parseInt(selLoc) || null] : [tid, from, to]),

      // Items sold per location (for sold items breakdown)
      db.query(`
        SELECT
          COALESCE(il.name, 'Unassigned') AS location_name,
          il.id AS location_id,
          mi.name AS item_name,
          SUM(poi.quantity)::float AS qty_sold,
          COALESCE(SUM(poi.price * poi.quantity), 0)::float AS revenue
        FROM pos_orders po
        JOIN pos_order_items poi ON poi.order_id = po.id AND poi.menu_item_id IS NOT NULL
        JOIN menu_items mi ON mi.id = poi.menu_item_id
        LEFT JOIN inventory_locations il ON il.id = mi.production_location_id
        WHERE po.tenant_id=$1 AND po.status='paid'
          AND po.paid_at::date BETWEEN $2 AND $3
          ${selLoc ? 'AND (mi.production_location_id=$4 OR ($4::int IS NULL AND mi.production_location_id IS NULL))' : ''}
        GROUP BY il.id, il.name, mi.id, mi.name
        ORDER BY il.name NULLS LAST, qty_sold DESC
      `, selLoc ? [tid, from, to, parseInt(selLoc) || null] : [tid, from, to]),
    ]);

    // Group ingredients by location
    const byLocation = {};
    for (const row of ingredientsRes.rows) {
      const key = row.location_id || 'unassigned';
      if (!byLocation[key]) byLocation[key] = { location_name: row.location_name, location_color: row.location_color, ingredients: [] };
      byLocation[key].ingredients.push(row);
    }

    // Group sold items by location
    const soldByLocation = {};
    for (const row of soldItemsRes.rows) {
      const key = row.location_id || 'unassigned';
      if (!soldByLocation[key]) soldByLocation[key] = [];
      soldByLocation[key].push(row);
    }

    const totalCost = ingredientsRes.rows.reduce((s, r) => s + (r.cost_consumed || 0), 0);

    res.render('inventory/location-report', {
      tenant: req.tenant, currentUser: req.user,
      from, to, selLoc,
      locations: locsRes.rows,
      summary: summaryRes.rows,
      byLocation,
      soldByLocation,
      totalCost,
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

// ── Unit Conversions ──────────────────────────────────────────────
router.get('/items/:id/conversions', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [itemRes, convRes] = await Promise.all([
      db.query(`SELECT * FROM inventory_items WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]),
      db.query(`SELECT * FROM unit_conversions WHERE item_id=$1 AND tenant_id=$2 ORDER BY from_unit`, [req.params.id, tid]),
    ]);
    if (!itemRes.rows[0]) return res.status(404).send('Item not found');
    res.render('inventory/unit-conversions', {
      tenant: req.tenant, currentUser: req.user,
      item: itemRes.rows[0], conversions: convRes.rows,
      success: req.query.success || null,
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

router.post('/items/:id/conversions', requireAuth, requireInventory, async (req, res) => {
  const { from_unit, to_unit, factor } = req.body;
  const tid = req.user.tenantId;
  try {
    await db.query(
      `INSERT INTO unit_conversions (tenant_id, item_id, from_unit, to_unit, factor)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, item_id, from_unit, to_unit) DO UPDATE SET factor=$5`,
      [tid, req.params.id, from_unit.trim(), to_unit.trim(), parseFloat(factor)]
    );
    res.redirect(`/inventory/items/${req.params.id}/conversions?success=saved`);
  } catch (err) { console.error(err); res.redirect(`/inventory/items/${req.params.id}/conversions?error=${encodeURIComponent(err.message)}`); }
});

router.post('/items/:id/conversions/:cid/delete', requireAuth, requireInventory, async (req, res) => {
  try {
    await db.query(`DELETE FROM unit_conversions WHERE id=$1 AND tenant_id=$2`, [req.params.cid, req.user.tenantId]);
    res.redirect(`/inventory/items/${req.params.id}/conversions?success=deleted`);
  } catch (err) { console.error(err); res.redirect(`/inventory/items/${req.params.id}/conversions`); }
});

// ── Daily Prep Sheet ──────────────────────────────────────────────
router.get('/prep-sheet', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const multiplier = parseFloat(req.query.multiplier) || 1;
  const selLoc = req.query.location || '';

  try {
    // Day-of-week for the target date (0=Sun…6=Sat)
    const dow = new Date(date).getDay();

    const [locsRes, prepRes] = await Promise.all([
      db.query(`SELECT id, name, color FROM inventory_locations WHERE tenant_id=$1 AND active=true ORDER BY name`, [tid]),
      // Avg daily consumption for same weekday over past 4 weeks, from sales × BOM
      db.query(`
        WITH sales_days AS (
          SELECT DISTINCT po.paid_at::date AS day
          FROM pos_orders po
          WHERE po.tenant_id=$1 AND po.status='paid'
            AND EXTRACT(DOW FROM po.paid_at) = $2
            AND po.paid_at >= CURRENT_DATE - INTERVAL '28 days'
        ),
        consumption AS (
          SELECT
            ir.ingredient_id,
            mi.production_location_id AS location_id,
            SUM(poi.quantity * ir.quantity) AS total_qty
          FROM pos_orders po
          JOIN pos_order_items poi ON poi.order_id = po.id AND poi.menu_item_id IS NOT NULL
          JOIN menu_items mi ON mi.id = poi.menu_item_id
          JOIN inventory_items ii_prod ON ii_prod.menu_item_id = mi.id AND ii_prod.tenant_id = $1
          JOIN inventory_recipes ir ON ir.item_id = ii_prod.id
          WHERE po.tenant_id=$1 AND po.status='paid'
            AND EXTRACT(DOW FROM po.paid_at) = $2
            AND po.paid_at >= CURRENT_DATE - INTERVAL '28 days'
            ${selLoc ? 'AND (mi.production_location_id=$3 OR ($3::int IS NULL AND mi.production_location_id IS NULL))' : ''}
          GROUP BY ir.ingredient_id, mi.production_location_id
        ),
        day_count AS (SELECT GREATEST(COUNT(*),1) AS n FROM sales_days)
        SELECT
          ii.id, ii.name, ii.unit, ii.stock_qty::float, ii.avg_cost::float,
          il.name AS location_name, COALESCE(il.color,'#888') AS location_color,
          ROUND(c.total_qty / dc.n, 3)::float AS avg_daily_qty,
          ROUND(c.total_qty / dc.n * ${ selLoc ? 4 : 3 }, 3)::float AS prep_qty
        FROM consumption c
        CROSS JOIN day_count dc
        JOIN inventory_items ii ON ii.id = c.ingredient_id AND ii.tenant_id = $1
        LEFT JOIN inventory_locations il ON il.id = c.location_id
        ORDER BY il.name NULLS LAST, avg_daily_qty DESC
      `, selLoc ? [tid, dow, parseInt(selLoc) || null] : [tid, dow]),
    ]);

    res.render('inventory/prep-sheet', {
      tenant: req.tenant, currentUser: req.user,
      date, dow, multiplier, selLoc,
      locations: locsRes.rows,
      items: prepRes.rows.map(r => ({ ...r, prep_qty: r.avg_daily_qty * multiplier })),
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

// ── Supplier Price Catalog ────────────────────────────────────────
router.get('/suppliers/:id/catalog', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  try {
    const [suppRes, catalogRes, itemsRes] = await Promise.all([
      db.query(`SELECT * FROM suppliers WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid]),
      db.query(`
        SELECT sc.*, ii.name AS item_name, ii.unit AS item_unit
        FROM supplier_catalog sc
        JOIN inventory_items ii ON ii.id = sc.item_id
        WHERE sc.supplier_id=$1 AND sc.tenant_id=$2
        ORDER BY ii.name
      `, [req.params.id, tid]),
      db.query(`SELECT id, name, unit, avg_cost FROM inventory_items WHERE tenant_id=$1 AND is_active=true ORDER BY name`, [tid]),
    ]);
    if (!suppRes.rows[0]) return res.redirect('/inventory/suppliers');
    res.render('inventory/supplier-catalog', {
      tenant: req.tenant, currentUser: req.user,
      supplier: suppRes.rows[0],
      catalog: catalogRes.rows,
      items: itemsRes.rows,
      success: req.query.success || null,
    });
  } catch (err) { console.error(err); res.status(500).send('Error: ' + err.message); }
});

router.post('/suppliers/:id/catalog', requireAuth, requireInventory, async (req, res) => {
  const tid = req.user.tenantId;
  const { item_id, unit_price, unit, notes } = req.body;
  try {
    await db.query(
      `INSERT INTO supplier_catalog (tenant_id, supplier_id, item_id, unit_price, unit, notes, last_updated)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE)
       ON CONFLICT (tenant_id, supplier_id, item_id) DO UPDATE SET unit_price=$4, unit=$5, notes=$6, last_updated=CURRENT_DATE`,
      [tid, req.params.id, item_id, parseFloat(unit_price) || 0, unit?.trim() || null, notes?.trim() || null]
    );
    res.redirect(`/inventory/suppliers/${req.params.id}/catalog?success=saved`);
  } catch (err) { console.error(err); res.redirect(`/inventory/suppliers/${req.params.id}/catalog?error=${encodeURIComponent(err.message)}`); }
});

router.post('/suppliers/:id/catalog/:cid/delete', requireAuth, requireInventory, async (req, res) => {
  try {
    await db.query(`DELETE FROM supplier_catalog WHERE id=$1 AND tenant_id=$2`, [req.params.cid, req.user.tenantId]);
    res.redirect(`/inventory/suppliers/${req.params.id}/catalog`);
  } catch (err) { console.error(err); res.redirect(`/inventory/suppliers/${req.params.id}/catalog`); }
});

// API: get catalog prices for a supplier (used when creating PO)
router.get('/suppliers/:id/catalog.json', requireAuth, requireInventory, async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT sc.item_id, sc.unit_price::float, sc.unit FROM supplier_catalog sc
       WHERE sc.supplier_id=$1 AND sc.tenant_id=$2`,
      [req.params.id, req.user.tenantId]
    );
    res.json(rows.rows);
  } catch (err) { res.json([]); }
});

module.exports = router;
module.exports.deductStockForOrder = deductStockForOrder;
