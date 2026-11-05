// One-off: create or reset a login in the DEV database only.
// Usage: node reset_dev_user.cjs <email> '<new-password>'
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const { createHash } = require('crypto');

// Same SHA-256 helper as initDb.ts / auth.controller.ts (not exported there).
const hashPassword = (plain) => createHash('sha256').update(plain).digest('hex');

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("Usage: node reset_dev_user.cjs <email> '<new-password>'");
  process.exit(1);
}

const devUrl = process.env.DATABASE_URL_DEV;
if (!devUrl) { console.error('DATABASE_URL_DEV is not set in .env'); process.exit(1); }
if (process.env.DATABASE_URL_PROD && devUrl === process.env.DATABASE_URL_PROD) {
  console.error('DATABASE_URL_DEV equals DATABASE_URL_PROD, refusing to run.');
  process.exit(1);
}

(async () => {
  const pool = new Pool({ connectionString: devUrl });
  try {
    // Login lowercases the email and trims the password before hashing — match that.
    const e = email.trim().toLowerCase();
    const hash = hashPassword(password.trim());
    const host = new URL(devUrl).hostname;

    const { rows } = await pool.query('SELECT id, role FROM users WHERE LOWER(email) = $1 LIMIT 1', [e]);
    if (rows.length) {
      await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, rows[0].id]);
      console.log(`[${host}] Password reset for ${e} (id ${rows[0].id}, role ${rows[0].role})`);
    } else {
      // Same columns/values as the founder seed in initDb.ts
      const r = await pool.query(
        'INSERT INTO users (name, email, password, role, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        ['Founder', e, hash, 'Super Admin', 'active'],
      );
      console.log(`[${host}] Created ${e} (id ${r.rows[0].id}, role Super Admin)`);
    }
  } finally {
    await pool.end();
  }
})().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
