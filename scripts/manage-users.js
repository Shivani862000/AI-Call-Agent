require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { initializeDatabase, dbAll, dbGet, dbRun, closeDatabase } = require('../db');
const { normalizeRole, validatePassword, validateUsername } = require('../src/user-rules');

/**
 * Break-glass user administration, for bootstrapping the first admin and for
 * recovering when nobody can log in. Day-to-day management belongs in the app.
 *
 *   node scripts/manage-users.js list
 *   node scripts/manage-users.js create --username a@b.c --role ADMIN [--password X]
 *   node scripts/manage-users.js reset  --username a@b.c [--password X]
 *   node scripts/manage-users.js activate|deactivate --username a@b.c
 *
 * Omitting --password generates a strong one and prints it once.
 */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1], i += 1;
    else args._.push(argv[i]);
  }
  return args;
}

function generatePassword(length = 24) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^&*-_=+';
  let out = '';
  while (out.length < length) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < 256 - (256 % alphabet.length)) out += alphabet[byte % alphabet.length];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  await initializeDatabase();

  if (command === 'list') {
    const users = await dbAll(
      'SELECT username, role, is_active, last_login_at FROM users ORDER BY role, username'
    );
    if (!users.length) return console.log('No users exist.');
    users.forEach((u) => console.log(
      `  ${u.username.padEnd(34)} ${u.role.padEnd(6)} ${Number(u.is_active) ? 'active  ' : 'INACTIVE'} `
      + `last login: ${u.last_login_at ? new Date(u.last_login_at).toISOString() : 'never'}`
    ));
    return;
  }

  const username = String(args.username || '').trim();
  if (!username) throw new Error('--username is required');

  if (command === 'activate' || command === 'deactivate') {
    const isActive = command === 'activate' ? 1 : 0;
    if (!isActive) {
      const admins = await dbGet(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'ADMIN' AND is_active = 1 AND lower(username) <> lower(?)",
        [username]
      );
      if (Number(admins.count) === 0) throw new Error('That is the last active admin; promote another first');
    }
    const result = await dbRun(
      'UPDATE users SET is_active = ?, updated_at = now() WHERE lower(username) = lower(?)',
      [isActive, username]
    );
    if (!result.changes) throw new Error(`No user named ${username}`);
    return console.log(`✓ ${username} is now ${isActive ? 'active' : 'inactive'}`);
  }

  if (command !== 'create' && command !== 'reset') {
    throw new Error('Usage: list | create | reset | activate | deactivate');
  }

  const generated = !args.password;
  const password = args.password || generatePassword();
  const passwordIssue = validatePassword(password);
  if (passwordIssue) throw new Error(passwordIssue);

  const hash = await bcrypt.hash(password, 12);

  if (command === 'create') {
    const usernameIssue = validateUsername(username);
    if (usernameIssue) throw new Error(usernameIssue);
    const role = normalizeRole(args.role || 'ADMIN');
    if (!role) throw new Error('--role must be ADMIN or AGENT');

    await dbRun(
      'INSERT INTO users (username, password_hash, role, created_by) VALUES (?, ?, ?, ?)',
      [username, hash, role, 'manage-users.js']
    );
    console.log(`✓ Created ${role} ${username}`);
  } else {
    const result = await dbRun(
      'UPDATE users SET password_hash = ?, updated_at = now() WHERE lower(username) = lower(?)',
      [hash, username]
    );
    if (!result.changes) throw new Error(`No user named ${username}`);
    console.log(`✓ Reset password for ${username}`);
  }

  if (generated) {
    console.log(`\n  Password: ${password}\n`);
    console.log('  Shown once. Store it in a password manager now.');
  }
}

main()
  .then(() => closeDatabase())
  .catch(async (error) => {
    console.error('[MANAGE USERS]', error.message);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
