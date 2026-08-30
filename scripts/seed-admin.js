require('dotenv').config();
const { initializeDatabase, dbGet, dbRun, closeDatabase } = require('../db');

async function seedAdmin() {
  await initializeDatabase();

  const username = String(process.env.ADMIN_USERNAME || '').trim();
  const passwordHash = String(process.env.ADMIN_PASSWORD_HASH || '').trim();

  if (!username || !passwordHash) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD_HASH must both be set');
  }
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash)) {
    throw new Error('ADMIN_PASSWORD_HASH must be a bcrypt hash');
  }

  const existing = await dbGet('SELECT COUNT(*) AS count FROM users');
  if (Number(existing.count) > 0) {
    console.log(`Users table already has ${existing.count} row(s); leaving it alone.`);
    return;
  }

  await dbRun(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
    [username, passwordHash, 'ADMIN']
  );
  console.log(`✓ Seeded admin "${username}"`);
}

seedAdmin()
  .then(() => closeDatabase())
  .catch(async (error) => {
    console.error('[SEED ADMIN ERROR]', error.message);
    await closeDatabase();
    process.exit(1);
  });
