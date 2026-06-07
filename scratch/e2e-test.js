const http = require('http');

let sessionCookie = null;

function request(path, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data || {});
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    };

    if (sessionCookie) {
      headers['Cookie'] = sessionCookie;
    }

    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: 'POST',
      headers: headers
    }, (res) => {
      let body = '';
      if (res.headers['set-cookie']) {
        sessionCookie = res.headers['set-cookie'][0];
      }
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  try {
    console.log('--- STARTING E2E TEST ---');

    console.log('0. Logging in...');
    const loginRes = await request('/api/auth/login', { username: 'admin', password: '1234' });
    console.log('Status:', loginRes.status);
    console.log('Body:', loginRes.body);

    if (loginRes.status !== 200) throw new Error('Login failed');

    console.log('\n1. Starting Call...');
    const startRes = await request('/api/test-ai-call/start');
    console.log('Status:', startRes.status);
    console.log('Body:', startRes.body);

    if (startRes.status !== 200) {
      throw new Error('Failed to start call');
    }

    const sessionId = startRes.body.sessionId;

    console.log('\n2. Sending User Message...');
    const msgRes = await request('/api/test-ai-call/message', {
      sessionId,
      message: 'Mera experience bahut achha raha. Staff kaafi polite tha.'
    });
    console.log('Status:', msgRes.status);
    console.log('Body:', msgRes.body);

    console.log('\n3. Ending Call...');
    const endRes = await request('/api/test-ai-call/end', {
      sessionId
    });
    console.log('Status:', endRes.status);
    console.log('Body:', endRes.body);

    console.log('\n--- E2E TEST COMPLETE ---');
  } catch (error) {
    console.error('Error during E2E test:', error.message);
  }
}

run();
