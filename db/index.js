const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Auto-migrate: each statement must be run separately with pg
(async () => {
  const migrations = [
    `ALTER TABLE users   ADD COLUMN IF NOT EXISTS permissions   TEXT    DEFAULT '[]'`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_feedback   BOOLEAN DEFAULT true`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_orders     BOOLEAN DEFAULT true`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_import     BOOLEAN DEFAULT true`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_custom_css BOOLEAN DEFAULT true`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_multilang  BOOLEAN DEFAULT true`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_valet      BOOLEAN DEFAULT true`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS custom_css      TEXT`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS view_count      INTEGER DEFAULT 0`,
    `ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS options           JSONB   DEFAULT '[]'`,
    `ALTER TABLE tenants    ADD COLUMN IF NOT EXISTS splash_bg_type    TEXT    DEFAULT 'color'`,
    `ALTER TABLE tenants    ADD COLUMN IF NOT EXISTS splash_bg_value   TEXT    DEFAULT '#ffffff'`,
    `ALTER TABLE tenants    ADD COLUMN IF NOT EXISTS splash_overlay_opacity INTEGER DEFAULT 0`,
    `ALTER TABLE tenants    ADD COLUMN IF NOT EXISTS splash_text_color TEXT`,
    `ALTER TABLE tenants    ADD COLUMN IF NOT EXISTS feat_splash_custom BOOLEAN DEFAULT true`,
    `ALTER TABLE tenants    ADD COLUMN IF NOT EXISTS feat_cart          BOOLEAN DEFAULT true`,
    `CREATE TABLE IF NOT EXISTS valet_requests (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      ticket_no     VARCHAR(50) NOT NULL,
      customer_name VARCHAR(120),
      status        VARCHAR(20) DEFAULT 'pending',
      created_at    TIMESTAMP DEFAULT NOW()
    )`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_pos BOOLEAN DEFAULT false`,
    `CREATE TABLE IF NOT EXISTS restaurant_tables (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name       VARCHAR(60) NOT NULL,
      capacity   INTEGER DEFAULT 4,
      sort_order INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS pos_orders (
      id           SERIAL PRIMARY KEY,
      tenant_id    INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      table_id     INTEGER REFERENCES restaurant_tables(id) ON DELETE SET NULL,
      table_name   VARCHAR(60),
      status       VARCHAR(20) DEFAULT 'open',
      subtotal     NUMERIC(10,2) DEFAULT 0,
      total        NUMERIC(10,2) DEFAULT 0,
      note         TEXT,
      created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TIMESTAMP DEFAULT NOW(),
      paid_at      TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS pos_order_items (
      id           SERIAL PRIMARY KEY,
      order_id     INTEGER REFERENCES pos_orders(id) ON DELETE CASCADE,
      menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
      name         VARCHAR(120) NOT NULL,
      price        NUMERIC(10,2) NOT NULL,
      quantity     INTEGER DEFAULT 1,
      notes        TEXT,
      options      JSONB DEFAULT '[]'
    )`,
    `CREATE TABLE IF NOT EXISTS pos_payments (
      id           SERIAL PRIMARY KEY,
      order_id     INTEGER REFERENCES pos_orders(id) ON DELETE CASCADE,
      method       VARCHAR(20) DEFAULT 'cash',
      amount_paid  NUMERIC(10,2) NOT NULL,
      change_given NUMERIC(10,2) DEFAULT 0,
      created_at   TIMESTAMP DEFAULT NOW()
    )`,
  ];
  for (const sql of migrations) {
    await pool.query(sql);
  }
  console.log('Migrations done');
})().catch(err => console.error('Migration error:', err.message));

module.exports = pool;
