const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const {
  getTestConnectionString,
  truncateApplicationTables
} = require('./postgres-test-context');

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl, child, output) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Test application exited with ${child.exitCode}\n${output.join('')}`);
    }

    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The server has not bound the port yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for test application\n${output.join('')}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;

  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);

  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function startTestApp() {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const connectionString = getTestConnectionString();
  const pool = new Pool({
    connectionString,
    max: 2,
    ssl: { rejectUnauthorized: false }
  });
  await truncateApplicationTables(pool);
  const clientResult = await pool.query(
    `insert into clients (name, slug, status)
     values ($1, $2, $3)
     returning id`,
    ['Contract Test Clinic', 'contract-test-clinic', 'active']
  );
  const clientId = clientResult.rows[0].id;
  const authUserId = randomUUID();
  const authEmail = `contract-${authUserId}@example.test`;
  const authPassword = 'contract-test-password';
  await pool.query(
    `insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
     values ($1, 'authenticated', 'authenticated', $2, now(), now(), now())`,
    [authUserId, authEmail]
  );
  await pool.query(
    `insert into app_users (id, username, username_normalized, email, email_normalized)
     values ($1, 'contract-webmaster', 'contract-webmaster', $2, $2)`,
    [authUserId, authEmail]
  );
  await pool.query(
    `insert into app_user_roles (user_id, role) values ($1, 'webmaster')`,
    [authUserId]
  );
  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      COOKIE_SECRET: 'contract-test-cookie-secret-at-least-32-bytes',
      SUPABASE_DB_URL: connectionString,
      SUPABASE_DB_TLS_INSECURE_TEST_ONLY: 'true',
      DEFAULT_CLIENT_ID: String(clientId),
      SUPABASE_URL: 'https://contract-test.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'contract-test-publishable-key',
      SUPABASE_TEST_AUTH_BYPASS: 'true',
      SUPABASE_TEST_AUTH_USER_ID: authUserId,
      SUPABASE_TEST_AUTH_EMAIL: authEmail,
      SUPABASE_TEST_AUTH_PASSWORD: authPassword,
      CALL_MODE: 'scripted',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
      TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
      TWILIO_AUTH_TOKEN: 'test-auth-token',
      TWILIO_PHONE_NUMBER: '+14155550100',
      CUSTOMER_PHONE: '+14155550123',
      CUSTOMER_NAME: 'Contract Test Customer',
      CLIENT_NAME: 'Contract Test Clinic',
      NGROK_URL: 'https://example.test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    await waitForHealth(baseUrl, child, output);
  } catch (error) {
    await stopChild(child);
    await pool.query('delete from auth.users where id = $1', [authUserId]);
    await truncateApplicationTables(pool);
    await pool.end();
    throw error;
  }

  const loginResponse = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'contract-webmaster', password: authPassword })
  });
  if (!loginResponse.ok) {
    await stopChild(child);
    await pool.query('delete from auth.users where id = $1', [authUserId]);
    await truncateApplicationTables(pool);
    await pool.end();
    throw new Error(`Contract-test login failed (${loginResponse.status})`);
  }
  const setCookies = typeof loginResponse.headers.getSetCookie === 'function'
    ? loginResponse.headers.getSetCookie()
    : [loginResponse.headers.get('set-cookie')];
  const sessionCookie = setCookies.filter(Boolean).map((value) => value.split(';', 1)[0]).join('; ');

  return {
    baseUrl,
    output,
    fetch(pathname, options = {}) {
      return fetch(`${baseUrl}${pathname}`, {
        ...options,
        headers: { ...options.headers, cookie: sessionCookie }
      });
    },
    async stop() {
      await stopChild(child);
      await pool.query('delete from auth.users where id = $1', [authUserId]);
      await truncateApplicationTables(pool);
      await pool.end();
    }
  };
}

module.exports = { startTestApp };
