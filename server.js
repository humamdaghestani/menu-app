require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const compression = require('compression');

const menuRouter = require('./routes/menu');
const adminRouter = require('./routes/admin');
const superAdminRouter = require('./routes/superadmin');

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

app.use('/superadmin', superAdminRouter);
app.use('/admin', adminRouter);
app.use('/', menuRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
