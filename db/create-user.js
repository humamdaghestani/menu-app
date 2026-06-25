// Usage: node db/create-user.js
// Creates a tenant + admin user directly in the database

require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('./index');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, resolve));

async function main() {
  console.log('\n── Create New Tenant & Admin User ──\n');
  const subdomain = await ask('Subdomain (e.g. burger99): ');
  const name      = await ask('Restaurant name: ');
  const email     = await ask('Admin email: ');
  const password  = await ask('Admin password: ');

  const hash = await bcrypt.hash(password, 10);

  const tenant = await db.query(
    'INSERT INTO tenants (subdomain, name) VALUES ($1, $2) RETURNING id',
    [subdomain.trim(), name.trim()]
  );
  const tenantId = tenant.rows[0].id;

  await db.query(
    'INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4)',
    [tenantId, email.trim(), hash, 'admin']
  );

  console.log(`\n✓ Created tenant "${name}" → ${subdomain}.yourdomain.com`);
  console.log(`✓ Admin login: ${email}\n`);
  rl.close();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
