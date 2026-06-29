const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Auto-migrate: add columns that may not exist yet (idempotent)
pool.query(`
  ALTER TABLE users    ADD COLUMN IF NOT EXISTS permissions   TEXT    DEFAULT '[]';
  ALTER TABLE tenants  ADD COLUMN IF NOT EXISTS feat_feedback   BOOLEAN DEFAULT true;
  ALTER TABLE tenants  ADD COLUMN IF NOT EXISTS feat_orders     BOOLEAN DEFAULT true;
  ALTER TABLE tenants  ADD COLUMN IF NOT EXISTS feat_import     BOOLEAN DEFAULT true;
  ALTER TABLE tenants  ADD COLUMN IF NOT EXISTS feat_custom_css BOOLEAN DEFAULT true;
  ALTER TABLE tenants  ADD COLUMN IF NOT EXISTS feat_multilang  BOOLEAN DEFAULT true;
  ALTER TABLE tenants  ADD COLUMN IF NOT EXISTS feat_valet      BOOLEAN DEFAULT true;
  ALTER TABLE tenants  ADD COLUMN IF NOT EXISTS custom_css      TEXT;
  ALTER TABLE tenants  ADD COLUMN IF NOT EXISTS view_count      INTEGER DEFAULT 0;
`).catch(err => console.error('Migration error:', err.message));

module.exports = pool;
