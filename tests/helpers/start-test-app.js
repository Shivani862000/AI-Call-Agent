const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
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
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'ai-call-agent-contract-'));
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
  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: path.join(tempDirectory, 'contract-test.db'),
      NODE_ENV: 'test',
      SUPABASE_DB_URL: connectionString,
      SUPABASE_DB_TLS_INSECURE_TEST_ONLY: 'true',
      DEFAULT_CLIENT_ID: String(clientId),
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
    await truncateApplicationTables(pool);
    await pool.end();
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    baseUrl,
    output,
    async stop() {
      await stopChild(child);
      await truncateApplicationTables(pool);
      await pool.end();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  };
}

module.exports = { startTestApp };
