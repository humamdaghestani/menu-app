require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const compression = require('compression');

const menuRouter = require('./routes/menu');
const adminRouter = require('./routes/admin');
const superAdminRouter = require('./routes/superadmin');
const db = require('./db');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(compression());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Subdomain detection middleware
app.use((req, res, next) => {
  const host = req.hostname; // e.g. "burger99.menuapp.com" or "localhost"
  const parts = host.split('.');

  // On localhost or railway.app, use query param ?tenant=slug for testing
  if (host === 'localhost' || host === '127.0.0.1' || host.includes('railway.app')) {
    req.tenant = req.query.tenant || null;
  } else if (host === 'm-menus.com' || host === 'www.m-menus.com') {
    // Root domain — no tenant (landing page)
    req.tenant = null;
  } else if (host.endsWith('.m-menus.com')) {
    // Subdomain — e.g. dunecafe.m-menus.com → tenant = dunecafe
    req.tenant = parts[0];
  } else {
    req.tenant = parts.length > 2 ? parts[0] : null;
  }

  next();
});

// Dynamic manifest per tenant
app.get('/manifest.json', async (req, res) => {
  const slug = req.query.tenant || req.tenant;
  let name = 'Menu', icon = null, color = '#e94560';
  if (slug) {
    try {
      const r = await db.query('SELECT name, logo_url, theme_color FROM tenants WHERE subdomain=$1', [slug]);
      if (r.rows[0]) { name = r.rows[0].name; icon = r.rows[0].logo_url; color = r.rows[0].theme_color || color; }
    } catch {}
  }
  const manifest = {
    name, short_name: name,
    start_url: '/',
    display: 'standalone',
    background_color: '#0f0f1a',
    theme_color: color,
    icons: icon ? [
      { src: icon, sizes: '192x192', type: 'image/png' },
      { src: icon, sizes: '512x512', type: 'image/png' },
    ] : [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
  };
  res.set('Content-Type', 'application/manifest+json');
  res.json(manifest);
});

app.use('/superadmin', superAdminRouter);
app.use('/admin', adminRouter);
app.use('/', menuRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
