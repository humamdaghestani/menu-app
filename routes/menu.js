const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  const slug = req.tenant;

  if (!slug) {
    return res.render('landing');
  }

  try {
    const tenantResult = await db.query(
      'SELECT * FROM tenants WHERE subdomain = $1 AND active = true',
      [slug]
    );

    if (tenantResult.rows.length === 0) {
      return res.status(404).send('<h2>Menu not found.</h2>');
    }

    const tenant = tenantResult.rows[0];

    const categoriesResult = await db.query(
      'SELECT * FROM categories WHERE tenant_id = $1 ORDER BY sort_order',
      [tenant.id]
    );

    const itemsResult = await db.query(
      'SELECT * FROM menu_items WHERE tenant_id = $1 ORDER BY sort_order',
      [tenant.id]
    );

    res.render('menu', {
      tenant,
      categories: categoriesResult.rows,
      items: itemsResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

module.exports = router;
