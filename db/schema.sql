-- Run this once in your Railway PostgreSQL database

CREATE TABLE tenants (
  id           SERIAL PRIMARY KEY,
  subdomain    VARCHAR(60) UNIQUE NOT NULL,
  name         VARCHAR(120) NOT NULL,
  logo_url     TEXT,
  active       BOOLEAN DEFAULT true,
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE categories (
  id           SERIAL PRIMARY KEY,
  tenant_id    INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  name         VARCHAR(80) NOT NULL,
  sort_order   INTEGER DEFAULT 0
);

CREATE TABLE menu_items (
  id           SERIAL PRIMARY KEY,
  tenant_id    INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name         VARCHAR(120) NOT NULL,
  price        VARCHAR(20) NOT NULL,
  description  TEXT,
  image_url    TEXT,
  sort_order   INTEGER DEFAULT 0
);

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  email         VARCHAR(120) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          VARCHAR(20) DEFAULT 'admin',
  created_at    TIMESTAMP DEFAULT NOW()
);

-- ── Example: create your first tenant + admin user ────────────────────────
-- Replace values as needed. Password below is: admin123
-- Generate a real hash with: node -e "require('bcrypt').hash('yourpassword',10).then(console.log)"

-- INSERT INTO tenants (subdomain, name) VALUES ('demo', 'Demo Restaurant');
-- INSERT INTO categories (tenant_id, name, sort_order) VALUES (1,'Burgers',1),(1,'Pizza',2),(1,'Drinks',3);
-- INSERT INTO users (tenant_id, email, password_hash, role)
--   VALUES (1, 'admin@demo.com', '$2b$10$...paste_hash_here...', 'admin');
