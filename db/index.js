const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Auto-migrate: each statement must be run separately with pg
(async () => {
  const migrations = [
    // Base schema — safe to run on fresh DB (CREATE TABLE IF NOT EXISTS)
    `CREATE TABLE IF NOT EXISTS tenants (
      id           SERIAL PRIMARY KEY,
      subdomain    VARCHAR(60) UNIQUE NOT NULL,
      name         VARCHAR(120) NOT NULL,
      description  TEXT,
      logo_url     TEXT,
      cover_image  TEXT,
      theme_color  VARCHAR(20) DEFAULT '#e94560',
      bg_video     TEXT,
      whatsapp     VARCHAR(30),
      cart_enabled BOOLEAN DEFAULT true,
      active       BOOLEAN DEFAULT true,
      created_at   TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS categories (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name       VARCHAR(80) NOT NULL,
      name_ar    VARCHAR(80),
      name_ku    VARCHAR(80),
      image_url  TEXT,
      sort_order INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS menu_items (
      id             SERIAL PRIMARY KEY,
      tenant_id      INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      category_id    INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      name           VARCHAR(120) NOT NULL,
      name_ar        VARCHAR(120),
      name_ku        VARCHAR(120),
      price          VARCHAR(20) NOT NULL,
      description    TEXT,
      description_ar TEXT,
      description_ku TEXT,
      image_url      TEXT,
      badge          VARCHAR(30),
      is_available   BOOLEAN DEFAULT true,
      sort_order     INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      email         VARCHAR(120) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          VARCHAR(20) DEFAULT 'admin',
      created_at    TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      customer_name VARCHAR(200),
      table_no      VARCHAR(50),
      items         TEXT,
      item_count    INTEGER DEFAULT 0,
      created_at    TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS feedback (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      rating     INTEGER CHECK (rating >= 1 AND rating <= 5),
      comment    TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_menu_items_tenant_sort ON menu_items(tenant_id, sort_order)`,
    `CREATE INDEX IF NOT EXISTS idx_categories_tenant_sort ON categories(tenant_id, sort_order)`,
    `CREATE INDEX IF NOT EXISTS idx_tenants_subdomain       ON tenants(subdomain)`,
    `CREATE INDEX IF NOT EXISTS idx_feedback_tenant         ON feedback(tenant_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_tenant           ON orders(tenant_id, created_at DESC)`,
    // Column migrations
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
    `ALTER TABLE pos_sessions ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(12,4) DEFAULT 1`,
    `ALTER TABLE pos_payments ADD COLUMN IF NOT EXISTS received_currency VARCHAR(5) DEFAULT 'USD'`,
    `ALTER TABLE pos_payments ADD COLUMN IF NOT EXISTS amount_paid_iqd  NUMERIC(14,2) DEFAULT 0`,
    `ALTER TABLE pos_payments ADD COLUMN IF NOT EXISTS exchange_rate     NUMERIC(12,4) DEFAULT 1`,
    `CREATE TABLE IF NOT EXISTS customers (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name        VARCHAR(120) NOT NULL,
      phone       VARCHAR(30),
      email       VARCHAR(120),
      notes       TEXT,
      total_spent NUMERIC(12,2) DEFAULT 0,
      visit_count INTEGER DEFAULT 0,
      created_at  TIMESTAMP DEFAULT NOW()
    )`,
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL`,
    `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_raw_material  BOOLEAN DEFAULT false`,
    `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_semi_finished BOOLEAN DEFAULT false`,
    `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS can_be_sold      BOOLEAN DEFAULT false`,
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bill_language     VARCHAR(20) DEFAULT 'en'`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bill_show_iqd     BOOLEAN DEFAULT true`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bill_custom_header TEXT`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bill_custom_footer TEXT`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bill_font_size     VARCHAR(10) DEFAULT 'normal'`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bill_paper_width   VARCHAR(10) DEFAULT '80mm'`,
    `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS selling_price NUMERIC(12,4) DEFAULT 0`,
    `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS notes TEXT`,
    `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS description TEXT`,
    `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS image_url TEXT`,
    `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS badge VARCHAR(40)`,
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
    `CREATE TABLE IF NOT EXISTS inventory_categories (
      id        SERIAL PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name      VARCHAR(80) NOT NULL,
      color     VARCHAR(20) DEFAULT '#7c5cbf',
      sort_order INTEGER DEFAULT 0
    )`,
    `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS inv_category_id INTEGER REFERENCES inventory_categories(id) ON DELETE SET NULL`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_accounting BOOLEAN DEFAULT false`,
    `CREATE TABLE IF NOT EXISTS supplier_payments (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      supplier_name VARCHAR(120) NOT NULL,
      amount        NUMERIC(12,2) NOT NULL,
      payment_date  DATE DEFAULT CURRENT_DATE,
      method        VARCHAR(30) DEFAULT 'cash',
      notes         TEXT,
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS customer_credits (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      customer_name VARCHAR(120) NOT NULL,
      amount        NUMERIC(12,2) NOT NULL,
      amount_paid   NUMERIC(12,2) DEFAULT 0,
      credit_date   DATE DEFAULT CURRENT_DATE,
      due_date      DATE,
      notes         TEXT,
      status        VARCHAR(20) DEFAULT 'open',
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS customer_credit_payments (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      credit_id     INTEGER REFERENCES customer_credits(id) ON DELETE CASCADE,
      amount        NUMERIC(12,2) NOT NULL,
      payment_date  DATE DEFAULT CURRENT_DATE,
      notes         TEXT,
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS expense_categories (
      id        SERIAL PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name      VARCHAR(80) NOT NULL,
      color     VARCHAR(20) DEFAULT '#e74c3c',
      sort_order INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS expenses (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
      description VARCHAR(200) NOT NULL,
      amount      NUMERIC(12,2) NOT NULL,
      expense_date DATE DEFAULT CURRENT_DATE,
      notes       TEXT,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    )`,
    // Proper supplier entities
    `CREATE TABLE IF NOT EXISTS suppliers (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name            VARCHAR(120) NOT NULL,
      phone           VARCHAR(30),
      email           VARCHAR(120),
      address         TEXT,
      tax_no          VARCHAR(60),
      opening_balance NUMERIC(12,2) DEFAULT 0,
      notes           TEXT,
      created_at      TIMESTAMP DEFAULT NOW()
    )`,
    `ALTER TABLE purchase_receipts ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL`,
    `ALTER TABLE supplier_payments  ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL`,
    // Bank accounts & cheques
    `CREATE TABLE IF NOT EXISTS bank_accounts (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name            VARCHAR(80) NOT NULL,
      bank_name       VARCHAR(80),
      account_no      VARCHAR(40),
      type            VARCHAR(20) DEFAULT 'bank',
      currency        VARCHAR(5)  DEFAULT 'USD',
      opening_balance NUMERIC(12,2) DEFAULT 0,
      is_active       BOOLEAN DEFAULT true,
      created_at      TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS cheques (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL,
      cheque_no       VARCHAR(40),
      type            VARCHAR(20) DEFAULT 'issued',
      party_name      VARCHAR(120),
      amount          NUMERIC(12,2) NOT NULL,
      issue_date      DATE DEFAULT CURRENT_DATE,
      due_date        DATE,
      status          VARCHAR(20) DEFAULT 'pending',
      notes           TEXT,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TIMESTAMP DEFAULT NOW()
    )`,
    // ERP feature flags
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_hr           BOOLEAN DEFAULT false`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_reservations BOOLEAN DEFAULT false`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_loyalty      BOOLEAN DEFAULT false`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_delivery     BOOLEAN DEFAULT false`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_assets       BOOLEAN DEFAULT false`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_reports      BOOLEAN DEFAULT false`,
    // HR & Payroll
    `CREATE TABLE IF NOT EXISTS hr_employees (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name        VARCHAR(120) NOT NULL,
      phone       VARCHAR(30),
      email       VARCHAR(120),
      role        VARCHAR(60),
      department  VARCHAR(60),
      salary      NUMERIC(12,2) DEFAULT 0,
      salary_type VARCHAR(20) DEFAULT 'monthly',
      hire_date   DATE DEFAULT CURRENT_DATE,
      status      VARCHAR(20) DEFAULT 'active',
      notes       TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS hr_shifts (
      id           SERIAL PRIMARY KEY,
      tenant_id    INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      employee_id  INTEGER REFERENCES hr_employees(id) ON DELETE CASCADE,
      shift_date   DATE NOT NULL,
      start_time   TIME,
      end_time     TIME,
      hours_worked NUMERIC(5,2),
      status       VARCHAR(20) DEFAULT 'scheduled',
      notes        TEXT,
      created_at   TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS hr_payroll (
      id           SERIAL PRIMARY KEY,
      tenant_id    INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      employee_id  INTEGER REFERENCES hr_employees(id) ON DELETE CASCADE,
      period_start DATE NOT NULL,
      period_end   DATE NOT NULL,
      base_salary  NUMERIC(12,2) DEFAULT 0,
      allowances   NUMERIC(12,2) DEFAULT 0,
      deductions   NUMERIC(12,2) DEFAULT 0,
      net_pay      NUMERIC(12,2) DEFAULT 0,
      status       VARCHAR(20) DEFAULT 'draft',
      paid_at      TIMESTAMP,
      notes        TEXT,
      created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TIMESTAMP DEFAULT NOW()
    )`,
    // Reservations
    `CREATE TABLE IF NOT EXISTS reservations (
      id               SERIAL PRIMARY KEY,
      tenant_id        INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      customer_name    VARCHAR(120) NOT NULL,
      phone            VARCHAR(30),
      party_size       INTEGER DEFAULT 1,
      table_id         INTEGER REFERENCES restaurant_tables(id) ON DELETE SET NULL,
      reservation_date DATE NOT NULL,
      reservation_time TIME NOT NULL,
      duration_mins    INTEGER DEFAULT 90,
      status           VARCHAR(20) DEFAULT 'confirmed',
      notes            TEXT,
      created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at       TIMESTAMP DEFAULT NOW()
    )`,
    // Tax Rates
    `CREATE TABLE IF NOT EXISTS tax_rates (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name        VARCHAR(60) NOT NULL,
      rate        NUMERIC(6,3) NOT NULL,
      description TEXT,
      is_active   BOOLEAN DEFAULT true,
      created_at  TIMESTAMP DEFAULT NOW()
    )`,
    `ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS tax_rate_id INTEGER REFERENCES tax_rates(id) ON DELETE SET NULL`,
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS tax_amount  NUMERIC(12,2) DEFAULT 0`,
    // Inventory Adjustments
    `CREATE TABLE IF NOT EXISTS inventory_adjustments (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      item_id     INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
      item_name   VARCHAR(120),
      type        VARCHAR(30) DEFAULT 'write-off',
      qty_change  NUMERIC(14,4) NOT NULL,
      reason      VARCHAR(200),
      cost_impact NUMERIC(12,2) DEFAULT 0,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    )`,
    // Budgets
    `CREATE TABLE IF NOT EXISTS budgets (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name        VARCHAR(120) NOT NULL,
      period_type VARCHAR(20) DEFAULT 'monthly',
      start_date  DATE NOT NULL,
      end_date    DATE NOT NULL,
      notes       TEXT,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS budget_lines (
      id        SERIAL PRIMARY KEY,
      budget_id INTEGER REFERENCES budgets(id) ON DELETE CASCADE,
      category  VARCHAR(80) NOT NULL,
      planned   NUMERIC(12,2) DEFAULT 0,
      notes     TEXT
    )`,
    // Assets
    `CREATE TABLE IF NOT EXISTS assets (
      id               SERIAL PRIMARY KEY,
      tenant_id        INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name             VARCHAR(120) NOT NULL,
      category         VARCHAR(60),
      purchase_date    DATE,
      purchase_price   NUMERIC(12,2) DEFAULT 0,
      current_value    NUMERIC(12,2) DEFAULT 0,
      depreciation_pct NUMERIC(5,2) DEFAULT 0,
      serial_no        VARCHAR(80),
      location         VARCHAR(80),
      status           VARCHAR(20) DEFAULT 'active',
      notes            TEXT,
      created_at       TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS asset_maintenance (
      id                SERIAL PRIMARY KEY,
      asset_id          INTEGER REFERENCES assets(id) ON DELETE CASCADE,
      service_date      DATE DEFAULT CURRENT_DATE,
      description       VARCHAR(200),
      cost              NUMERIC(12,2) DEFAULT 0,
      next_service_date DATE,
      created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at        TIMESTAMP DEFAULT NOW()
    )`,
    // Loyalty
    `CREATE TABLE IF NOT EXISTS loyalty_programs (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name            VARCHAR(120) NOT NULL,
      points_per_unit NUMERIC(8,2) DEFAULT 1,
      unit_amount     NUMERIC(10,2) DEFAULT 1,
      redeem_rate     NUMERIC(8,2) DEFAULT 0.01,
      min_redeem_pts  INTEGER DEFAULT 100,
      is_active       BOOLEAN DEFAULT true,
      created_at      TIMESTAMP DEFAULT NOW()
    )`,
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_points INTEGER DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
      order_id    INTEGER REFERENCES pos_orders(id) ON DELETE SET NULL,
      type        VARCHAR(20) DEFAULT 'earn',
      points      INTEGER NOT NULL,
      notes       TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    )`,
    // Delivery
    `CREATE TABLE IF NOT EXISTS delivery_orders (
      id             SERIAL PRIMARY KEY,
      tenant_id      INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      order_id       INTEGER REFERENCES pos_orders(id) ON DELETE SET NULL,
      customer_name  VARCHAR(120),
      phone          VARCHAR(30),
      address        TEXT,
      zone           VARCHAR(60),
      rider_name     VARCHAR(80),
      delivery_fee   NUMERIC(10,2) DEFAULT 0,
      status         VARCHAR(20) DEFAULT 'pending',
      estimated_mins INTEGER DEFAULT 45,
      dispatched_at  TIMESTAMP,
      delivered_at   TIMESTAMP,
      notes          TEXT,
      created_at     TIMESTAMP DEFAULT NOW()
    )`,
    // ── POS Pro upgrades ─────────────────────────────────────────────────
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS cover_count  INTEGER DEFAULT 1`,
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS tip_amount   NUMERIC(10,2) DEFAULT 0`,
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS receipt_no   VARCHAR(20)`,
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS is_held      BOOLEAN DEFAULT false`,
    `ALTER TABLE pos_order_items ADD COLUMN IF NOT EXISTS sent_to_kitchen BOOLEAN DEFAULT false`,
    `ALTER TABLE pos_order_items ADD COLUMN IF NOT EXISTS course   VARCHAR(20) DEFAULT 'main'`,
    `ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_out_of_stock BOOLEAN DEFAULT false`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS receipt_seq     INTEGER DEFAULT 0`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS receipt_prefix  VARCHAR(10) DEFAULT ''`,
    // ── Advanced POS feature flags ─────────────────────────────────────────────
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_modifiers       BOOLEAN DEFAULT false`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_happy_hour      BOOLEAN DEFAULT false`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_kitchen_routing BOOLEAN DEFAULT false`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_no_sale         BOOLEAN DEFAULT false`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feat_prep_time       BOOLEAN DEFAULT false`,
    // Kitchen routing per category
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS kitchen_station   VARCHAR(40) DEFAULT 'main'`,
    // Manager PIN
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_pin            VARCHAR(6)`,
    // Prep time tracking
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS kitchen_done_at   TIMESTAMP`,
    // Modifier groups
    `CREATE TABLE IF NOT EXISTS modifier_groups (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name        VARCHAR(80) NOT NULL,
      min_select  INTEGER DEFAULT 0,
      max_select  INTEGER DEFAULT 1,
      is_required BOOLEAN DEFAULT false,
      created_at  TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS modifier_options (
      id          SERIAL PRIMARY KEY,
      group_id    INTEGER REFERENCES modifier_groups(id) ON DELETE CASCADE,
      name        VARCHAR(80) NOT NULL,
      price_adj   NUMERIC(10,2) DEFAULT 0,
      sort_order  INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS menu_item_modifier_groups (
      menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
      group_id     INTEGER REFERENCES modifier_groups(id) ON DELETE CASCADE,
      sort_order   INTEGER DEFAULT 0,
      PRIMARY KEY (menu_item_id, group_id)
    )`,
    `CREATE TABLE IF NOT EXISTS pos_order_item_modifiers (
      id            SERIAL PRIMARY KEY,
      order_item_id INTEGER REFERENCES pos_order_items(id) ON DELETE CASCADE,
      option_id     INTEGER REFERENCES modifier_options(id) ON DELETE SET NULL,
      name          VARCHAR(80) NOT NULL,
      price_adj     NUMERIC(10,2) DEFAULT 0
    )`,
    // Happy hours
    `CREATE TABLE IF NOT EXISTS happy_hours (
      id             SERIAL PRIMARY KEY,
      tenant_id      INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name           VARCHAR(80) NOT NULL,
      discount_type  VARCHAR(10) DEFAULT 'percent',
      discount_value NUMERIC(10,2) DEFAULT 10,
      days_of_week   INTEGER[] DEFAULT '{1,2,3,4,5,6,7}',
      start_time     TIME NOT NULL,
      end_time       TIME NOT NULL,
      is_active      BOOLEAN DEFAULT true,
      created_at     TIMESTAMP DEFAULT NOW()
    )`,
    // Permanent manager passcodes for void / discount
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_perm_void_code     VARCHAR(20)`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_perm_discount_code VARCHAR(20)`,
    // Service fee
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_service_fee_enabled BOOLEAN DEFAULT false`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_service_fee_pct     NUMERIC(5,2) DEFAULT 0`,
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS service_fee          NUMERIC(10,2) DEFAULT 0`,
    `ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS apply_service_fee    BOOLEAN DEFAULT false`,
    // Custom bill label overrides (JSON blob)
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bill_custom_labels TEXT DEFAULT NULL`,
    // Local print agent settings
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_print_agent_port    VARCHAR(10) DEFAULT NULL`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_print_agent_printer VARCHAR(200) DEFAULT NULL`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_print_agent_lan_ip  VARCHAR(40) DEFAULT NULL`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_agent_token VARCHAR(64) DEFAULT NULL`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pos_agent_last_seen TIMESTAMPTZ DEFAULT NULL`,
    `CREATE TABLE IF NOT EXISTS pos_print_jobs (
       id SERIAL PRIMARY KEY,
       tenant_id INTEGER NOT NULL,
       payload JSONB NOT NULL,
       status VARCHAR(20) DEFAULT 'pending',
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_print_jobs_pending ON pos_print_jobs (tenant_id, status, id)`,
    // Floor plan layout per table
    `ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS floor_x       INTEGER DEFAULT NULL`,
    `ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS floor_y       INTEGER DEFAULT NULL`,
    `ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS floor_shape   VARCHAR(20) DEFAULT 'square'`,
    `ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS floor_w       INTEGER DEFAULT 80`,
    `ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS floor_h       INTEGER DEFAULT 80`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subcategory_text_color TEXT`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS category_text_color TEXT`,
    // No-sale cash drawer log
    `CREATE TABLE IF NOT EXISTS pos_no_sale_log (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      session_id INTEGER REFERENCES pos_sessions(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason     TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    // Feedback extended columns
    `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS q1            INTEGER`,
    `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS q2            INTEGER`,
    `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS q3            INTEGER`,
    `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS q4            INTEGER`,
    `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS q5            INTEGER`,
    `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS customer_name VARCHAR(120)`,
    `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS mobile        VARCHAR(30)`,
    `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS table_no      VARCHAR(50)`,
  ];
  for (const sql of migrations) {
    await pool.query(sql);
  }
  console.log('Migrations done');
})().catch(err => console.error('Migration error:', err.message));

module.exports = pool;
