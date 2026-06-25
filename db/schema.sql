-- Run this once in a FRESH Railway PostgreSQL database.
-- If your database already exists, run the migration block at the bottom instead.

CREATE TABLE tenants (
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
);

CREATE TABLE categories (
  id         SERIAL PRIMARY KEY,
  tenant_id  INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  name       VARCHAR(80) NOT NULL,
  name_ar    VARCHAR(80),
  name_ku    VARCHAR(80),
  image_url  TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE menu_items (
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
);

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  email         VARCHAR(120) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          VARCHAR(20) DEFAULT 'admin',
  created_at    TIMESTAMP DEFAULT NOW()
);

-- ── Migration: run this block if your database already exists ─────────────────
-- ALTER TABLE tenants ADD COLUMN IF NOT EXISTS description TEXT;
-- ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cover_image TEXT;
-- ALTER TABLE tenants ADD COLUMN IF NOT EXISTS theme_color VARCHAR(20) DEFAULT '#e94560';
-- ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bg_video TEXT;
-- ALTER TABLE tenants ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(30);
-- ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cart_enabled BOOLEAN DEFAULT true;
-- ALTER TABLE categories ADD COLUMN IF NOT EXISTS name_ar VARCHAR(80);
-- ALTER TABLE categories ADD COLUMN IF NOT EXISTS name_ku VARCHAR(80);
-- ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_url TEXT;
-- ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS name_ar VARCHAR(120);
-- ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS name_ku VARCHAR(120);
-- ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS description_ar TEXT;
-- ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS description_ku TEXT;
-- ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS badge VARCHAR(30);
-- ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT true;
