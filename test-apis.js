const http = require('http');

const API_BASE = 'http://localhost:3000/api';
let authCookie = '';

async function fetchJson(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + endpoint);
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };
    if (authCookie) {
      headers['Cookie'] = authCookie;
    }

    const req = http.request(url, {
      method: options.method || 'GET',
      headers
    }, (res) => {
      if (res.headers['set-cookie']) {
        authCookie = res.headers['set-cookie'][0].split(';')[0];
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function runTests() {
  console.log('Starting E2E API tests...\n');
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } catch (e) {
      console.error(`❌ [FAIL] ${name}`);
      console.error('   ', e.message);
      failed++;
    }
  }

  // 0. Login
  await test('Login as Admin', async () => {
    const res = await fetchJson('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: '1234' })
    });
    if (res.status !== 200 || !res.data.success) throw new Error('Login failed');
  });

  // 1. Dashboard metrics
  await test('Dashboard Metrics Load', async () => {
    const res = await fetchJson('/calls/metrics');
    if (res.status !== 200 || !res.data) throw new Error('Failed to load metrics');
  });

  // 2. Fetch Customers
  await test('Fetch Customers list', async () => {
    const res = await fetchJson('/customers?limit=10');
    if (res.status !== 200 || !Array.isArray(res.data)) throw new Error('Customers list invalid');
  });

  // 3. Search Customers
  await test('Search Customers', async () => {
    const res = await fetchJson('/customers/search?q=test');
    if (res.status !== 200) throw new Error('Search failed');
  });

  // 4. Create new customer with invalid data
  await test('Create Customer Validation', async () => {
    const res = await fetchJson('/customers', {
      method: 'POST',
      body: JSON.stringify({ name: '' }) // Invalid
    });
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
  });

  // 5. Fetch feedback
  await test('Fetch Feedback', async () => {
    const res = await fetchJson('/feedback');
    if (res.status !== 200 || !Array.isArray(res.data)) throw new Error('Feedback list invalid');
  });

  console.log(`\nTests completed. Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

runTests().catch(console.error);
