const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Auto-migrate: each statement must be run separately with pg
(async () => {
  const migrations = [
    `ALTER TABLE users   ADD COLUMN IF NOT EXISTS permissions   TEXT    DEFAULT '[]'`,
    `ALTER TABLE users   ADD COLUMN IF NOT EXISTS name          VARCHAR(120)`,
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
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS discount_type  VARCHAR(10) DEFAULT 'none'`,
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10,2) DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS pos_sessions (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      opened_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      opening_cash  NUMERIC(10,2) DEFAULT 0,
      closing_cash  NUMERIC(10,2),
      status        VARCHAR(20) DEFAULT 'open',
      notes         TEXT,
      opened_at     TIMESTAMP DEFAULT NOW(),
      closed_at     TIMESTAMP
    )`,
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES pos_sessions(id) ON DELETE SET NULL`,
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS order_type VARCHAR(20) DEFAULT 'dine-in'`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_allow_void      BOOLEAN DEFAULT true`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_allow_discount   BOOLEAN DEFAULT true`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_allow_takeaway   BOOLEAN DEFAULT true`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_allow_receipt    BOOLEAN DEFAULT true`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_show_kitchen     BOOLEAN DEFAULT true`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_show_images      BOOLEAN DEFAULT true`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_show_capacity    BOOLEAN DEFAULT true`,
    `CREATE TABLE IF NOT EXISTS pos_passkeys (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      code        VARCHAR(8) NOT NULL,
      action_type VARCHAR(20) NOT NULL,
      used        BOOLEAN DEFAULT false,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      used_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      order_id    INTEGER REFERENCES pos_orders(id) ON DELETE SET NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      used_at     TIMESTAMP,
      expires_at  TIMESTAMP NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS pos_printers (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name            VARCHAR(80) NOT NULL,
      role            VARCHAR(20) DEFAULT 'receipt',
      connection_type VARCHAR(20) DEFAULT 'network',
      ip_address      VARCHAR(80),
      port            INTEGER DEFAULT 9100,
      paper_width     VARCHAR(10) DEFAULT '80mm',
      is_active       BOOLEAN DEFAULT true,
      created_at      TIMESTAMP DEFAULT NOW()
    )`,
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS printer_id INTEGER REFERENCES pos_printers(id) ON DELETE SET NULL`,
    `CREATE TABLE IF NOT EXISTS pos_activity_log (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      session_id  INTEGER REFERENCES pos_sessions(id) ON DELETE CASCADE,
      order_id    INTEGER REFERENCES pos_orders(id) ON DELETE SET NULL,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action      VARCHAR(40) NOT NULL,
      details     JSONB DEFAULT '{}',
      created_at  TIMESTAMP DEFAULT NOW()
    )`,
    `ALTER TABLE tenants    ADD COLUMN IF NOT EXISTS feat_captain    BOOLEAN DEFAULT false`,
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS bill_requested  BOOLEAN DEFAULT false`,
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS kitchen_sent_at TIMESTAMP`,
    `CREATE TABLE IF NOT EXISTS pos_payments (
      id           SERIAL PRIMARY KEY,
      order_id     INTEGER REFERENCES pos_orders(id) ON DELETE CASCADE,
      method       VARCHAR(20) DEFAULT 'cash',
      amount_paid  NUMERIC(10,2) NOT NULL,
      change_given NUMERIC(10,2) DEFAULT 0,
      created_at   TIMESTAMP DEFAULT NOW()
    )`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_inventory BOOLEAN DEFAULT false`,
    `CREATE TABLE IF NOT EXISTS inventory_items (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name          VARCHAR(120) NOT NULL,
      sku           VARCHAR(60),
      type          VARCHAR(20) DEFAULT 'raw_material',
      unit          VARCHAR(20) DEFAULT 'pcs',
      stock_qty     NUMERIC(14,4) DEFAULT 0,
      reorder_level NUMERIC(14,4) DEFAULT 0,
      avg_cost      NUMERIC(12,4) DEFAULT 0,
      menu_item_id  INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
      is_active     BOOLEAN DEFAULT true,
      created_at    TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS inventory_recipes (
      id            SERIAL PRIMARY KEY,
      item_id       INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
      ingredient_id INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity      NUMERIC(14,4) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS purchase_receipts (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      supplier_name VARCHAR(120),
      invoice_no    VARCHAR(60),
      receipt_date  DATE DEFAULT CURRENT_DATE,
      total         NUMERIC(12,2) DEFAULT 0,
      notes         TEXT,
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS purchase_receipt_lines (
      id          SERIAL PRIMARY KEY,
      receipt_id  INTEGER REFERENCES purchase_receipts(id) ON DELETE CASCADE,
      item_id     INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      item_name   VARCHAR(120),
      quantity    NUMERIC(14,4) NOT NULL,
      unit         VARCHAR(20),
      unit_price  NUMERIC(12,4) NOT NULL,
      total       NUMERIC(12,2)
    )`,
    `ALTER TABLE purchase_receipt_lines ADD COLUMN IF NOT EXISTS item_name VARCHAR(120)`,
    `ALTER TABLE purchase_receipt_lines ADD COLUMN IF NOT EXISTS unit VARCHAR(20)`,
    `ALTER TABLE purchase_receipt_lines ALTER COLUMN item_id DROP NOT NULL`,
    `CREATE TABLE IF NOT EXISTS inventory_transactions (
      id             SERIAL PRIMARY KEY,
      tenant_id      INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      item_id        INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
      type           VARCHAR(20) NOT NULL,
      qty_change     NUMERIC(14,4) NOT NULL,
      unit_cost      NUMERIC(12,4) DEFAULT 0,
      reference_id   INTEGER,
      reference_type VARCHAR(30),
      notes          TEXT,
      created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at     TIMESTAMP DEFAULT NOW()
    )`,
  ];
  for (const sql of migrations) {
    await pool.query(sql);
  }
  console.log('Migrations done');
})().catch(err => console.error('Migration error:', err.message));

module.exports = pool;
