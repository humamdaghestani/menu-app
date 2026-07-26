const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAuth = require('../middleware/auth');

async function requireFeat(req, res, next) {
  const r = await db.query('SELECT feat_modifiers FROM tenants WHERE id=$1', [req.user.tenantId]);
  if (!r.rows[0]?.feat_modifiers) return res.status(403).send('<h2 style="font-family:sans-serif;padding:40px">Modifier Groups feature is not enabled.</h2>');
  next();
}

// List all modifier groups
router.get('/', requireAuth, requireFeat, async (req, res) => {
  try {
    const tenant = (await db.query('SELECT * FROM tenants WHERE id=$1', [req.user.tenantId])).rows[0];
    const groups = await db.query(
      `SELECT mg.*, json_agg(mo.* ORDER BY mo.sort_order, mo.id) FILTER (WHERE mo.id IS NOT NULL) AS options
       FROM modifier_groups mg
       LEFT JOIN modifier_options mo ON mo.group_id = mg.id
       WHERE mg.tenant_id=$1
       GROUP BY mg.id ORDER BY mg.name`,
      [req.user.tenantId]
    );
    const menuItems = await db.query(
      'SELECT mi.id, mi.name FROM menu_items mi WHERE mi.tenant_id=$1 AND mi.is_available=true ORDER BY mi.name',
      [req.user.tenantId]
    );
    // Get assignments: which groups are linked to which items
    const assignments = await db.query(
      `SELECT mimg.menu_item_id, mimg.group_id
       FROM menu_item_modifier_groups mimg
       JOIN menu_items mi ON mi.id = mimg.menu_item_id
       WHERE mi.tenant_id=$1`,
      [req.user.tenantId]
    );
    res.render('pos/modifiers', { tenant, groups: groups.rows, menuItems: menuItems.rows, assignments: assignments.rows, currentUser: req.user });
  } catch (err) { console.error(err); res.status(500).send('Server error'); }
});

// Create modifier group
router.post('/', requireAuth, requireFeat, async (req, res) => {
  const { name, min_select, max_select, is_required } = req.body;
  try {
    await db.query(
      'INSERT INTO modifier_groups (tenant_id, name, min_select, max_select, is_required) VALUES ($1,$2,$3,$4,$5)',
      [req.user.tenantId, name.trim(), parseInt(min_select) || 0, parseInt(max_select) || 1, is_required === '1']
    );
    res.redirect('/pos/modifiers?success=Group+created');
  } catch (err) { console.error(err); res.redirect('/pos/modifiers?error=' + encodeURIComponent(err.message)); }
});

// Edit modifier group
router.post('/:id/edit', requireAuth, requireFeat, async (req, res) => {
  const { name, min_select, max_select, is_required } = req.body;
  try {
    await db.query(
      'UPDATE modifier_groups SET name=$1, min_select=$2, max_select=$3, is_required=$4 WHERE id=$5 AND tenant_id=$6',
      [name.trim(), parseInt(min_select) || 0, parseInt(max_select) || 1, is_required === '1', req.params.id, req.user.tenantId]
    );
    res.redirect('/pos/modifiers?success=Group+updated');
  } catch (err) { res.redirect('/pos/modifiers?error=' + encodeURIComponent(err.message)); }
});

// Delete modifier group
router.post('/:id/delete', requireAuth, requireFeat, async (req, res) => {
  try {
    await db.query('DELETE FROM modifier_groups WHERE id=$1 AND tenant_id=$2', [req.params.id, req.user.tenantId]);
    res.redirect('/pos/modifiers');
  } catch (err) { res.redirect('/pos/modifiers'); }
});

// Add option to group
router.post('/:id/options', requireAuth, requireFeat, async (req, res) => {
  const { name, price_adj } = req.body;
  try {
    await db.query(
      'INSERT INTO modifier_options (group_id, name, price_adj) VALUES ($1,$2,$3)',
      [req.params.id, name.trim(), parseFloat(price_adj) || 0]
    );
    res.redirect('/pos/modifiers?success=Option+added');
  } catch (err) { res.redirect('/pos/modifiers?error=' + encodeURIComponent(err.message)); }
});

// Delete option
router.post('/:groupId/options/:optId/delete', requireAuth, requireFeat, async (req, res) => {
  try {
    await db.query('DELETE FROM modifier_options WHERE id=$1 AND group_id=$2', [req.params.optId, req.params.groupId]);
    res.redirect('/pos/modifiers');
  } catch (err) { res.redirect('/pos/modifiers'); }
});

// Assign groups to a menu item
router.post('/assign', requireAuth, requireFeat, async (req, res) => {
  const { menu_item_id, group_ids } = req.body;
  try {
    await db.query('DELETE FROM menu_item_modifier_groups WHERE menu_item_id=$1', [menu_item_id]);
    const ids = Array.isArray(group_ids) ? group_ids : group_ids ? [group_ids] : [];
    for (let i = 0; i < ids.length; i++) {
      await db.query(
        'INSERT INTO menu_item_modifier_groups (menu_item_id, group_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [menu_item_id, ids[i], i]
      );
    }
    res.redirect('/pos/modifiers?success=Assignments+saved');
  } catch (err) { res.redirect('/pos/modifiers?error=' + encodeURIComponent(err.message)); }
});

// API: get modifier groups for a menu item (used by POS order screen)
router.get('/api/item/:menuItemId', requireAuth, requireFeat, async (req, res) => {
  try {
    const groups = await db.query(
      `SELECT mg.*, json_agg(mo.* ORDER BY mo.sort_order, mo.id) FILTER (WHERE mo.id IS NOT NULL) AS options
       FROM menu_item_modifier_groups mimg
       JOIN modifier_groups mg ON mg.id = mimg.group_id
       LEFT JOIN modifier_options mo ON mo.group_id = mg.id
       WHERE mimg.menu_item_id=$1 AND mg.tenant_id=$2
       GROUP BY mg.id, mimg.sort_order ORDER BY mimg.sort_order, mg.name`,
      [req.params.menuItemId, req.user.tenantId]
    );
    res.json({ ok: true, groups: groups.rows });
  } catch (err) { res.json({ ok: false, groups: [] }); }
});

module.exports = router;
