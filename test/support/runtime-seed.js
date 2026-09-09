'use strict';

const { assertOwnedTestDatabase } = require('./database');
assertOwnedTestDatabase(process.env.DATABASE_URL, process.env, 'application');
const db = require('../../db');

(async () => {
  try {
    const password = process.env.RUNTIME_ADMIN_PASSWORD;
    if (!password || password.length < 32) throw new Error('missing generated runtime password');
    await db.initializeDatabase();
    const hash = await require('bcrypt').hash(password, 12);
    await db.dbRun('INSERT INTO users (username, password_hash, role, is_active) VALUES (?, ?, ?, ?)',
      ['runtime-admin', hash, 'ADMIN', 1]);
    console.log('Seeded synthetic runtime administrator in owned database');
  } finally { await db.closeDatabase(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
