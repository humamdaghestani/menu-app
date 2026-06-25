require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

const menuRouter = require('./routes/menu');
const adminRouter = require('./routes/admin');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Subdomain detection middleware
app.use((req, res, next) => {
  const host = req.hostname; // e.g. "burger99.menuapp.com" or "localhost"
  const parts = host.split('.');

  // On localhost, use query param ?tenant=slug for testing
  if (host === 'localhost' || host === '127.0.0.1') {
    req.tenant = req.query.tenant || null;
  } else {
    // subdomain is the first part if there are more than 2 parts
    req.tenant = parts.length > 2 ? parts[0] : null;
  }

  next();
});

app.use('/admin', adminRouter);
app.use('/', menuRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
