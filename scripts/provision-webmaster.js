#!/usr/bin/env node
const path = require('node:path');
const dotenv = require('dotenv');
const { createPostgres } = require('../persistence/postgres');
const { createSupabaseAdmin } = require('../auth/supabase-auth');
const { normalize } = require('../repositories/users');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function parseProvisionArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--password' || argument.startsWith('--password=')) throw new Error('Password flags are not allowed');
    if (argument === '--username' || argument === '--email') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} is required`);
      result[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!result.username) throw new Error('--username is required');
  if (!result.email) throw new Error('--email is required');
  return result;
}

function validateInput({ username, email, password }) {
  const cleanUsername = String(username || '').trim();
  const cleanEmail = normalize(email);
  if (!cleanUsername) throw new Error('Username is required');
  if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) throw new Error('A valid email is required');
  if (String(password || '').length < 12) throw new Error('Password must be at least 12 characters');
  return { username: cleanUsername, usernameNormalized: normalize(cleanUsername), email: cleanEmail, emailNormalized: cleanEmail };
}

async function provisionWebmaster({ adminAuth, database, username, email, password }) {
  const input = validateInput({ username, email, password });
  const existing = await database.query(
    `select id from app_users where username_normalized = $1 or email_normalized = $2 limit 1`,
    [input.usernameNormalized, input.emailNormalized]
  );
  if (existing.rows.length > 0) {
    const error = new Error('A webmaster with that username or email already exists');
    error.code = 'WEBMASTER_EXISTS';
    throw error;
  }

  const authUser = await adminAuth.createUser({ email: input.email, password });
  try {
    await database.transaction(async (client) => {
      await client.query(
        `insert into app_users (id, username, username_normalized, email, email_normalized)
         values ($1, $2, $3, $4, $5)`,
        [authUser.id, input.username, input.usernameNormalized, input.email, input.emailNormalized]
      );
      await client.query(
        `insert into app_user_roles (user_id, role) values ($1, $2)`,
        [authUser.id, 'webmaster']
      );
    });
  } catch (error) {
    try { await adminAuth.deleteUser(authUser.id); } catch { /* Preserve the profile failure as the primary error. */ }
    throw error;
  }
  return { id: authUser.id, username: input.username };
}

async function readPassword(input = process.stdin, output = process.stderr) {
  if (!input.isTTY) {
    let value = '';
    for await (const chunk of input) value += chunk;
    return value.replace(/[\r\n]+$/, '');
  }
  output.write('Password (input hidden): ');
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk) => {
      const text = chunk.toString();
      if (text === '\u0003') {
        input.setRawMode(false);
        reject(new Error('Provisioning cancelled'));
        return;
      }
      if (text === '\r' || text === '\n') {
        input.off('data', onData);
        input.setRawMode(false);
        output.write('\n');
        resolve(value);
        return;
      }
      if (text === '\u007f') value = value.slice(0, -1);
      else value += text;
    };
    input.on('data', onData);
  });
}

async function main() {
  if (process.env.WEBMASTER_PASSWORD) throw new Error('WEBMASTER_PASSWORD is not accepted; provide the password via hidden prompt or stdin');
  for (const name of ['SUPABASE_DB_URL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY']) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  const args = parseProvisionArgs(process.argv.slice(2));
  const password = await readPassword();
  const database = createPostgres({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: process.env.SUPABASE_DB_CA_CERT
      ? { ca: process.env.SUPABASE_DB_CA_CERT.replaceAll('\\n', '\n'), rejectUnauthorized: true }
      : undefined
  });
  try {
    const result = await provisionWebmaster({
      adminAuth: createSupabaseAdmin({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SECRET_KEY }),
      database,
      ...args,
      password
    });
    process.stdout.write(`Webmaster created: ${result.username} (${result.id})\n`);
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Provisioning failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseProvisionArgs, provisionWebmaster, readPassword, validateInput };
