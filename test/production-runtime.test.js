'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const WebSocket = require('ws');
const { assertOwnedTestDatabase } = require('./support/database');

test('production amd64 image boots and serves bcrypt login, XLSX import, Unicode PDF and fake-provider media', { timeout: 60_000 }, async (t) => {
  assert.equal(process.env.NODE_ENV, 'production');
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.match(process.version, /^v24\./);
  assertOwnedTestDatabase(process.env.DATABASE_URL, { ...process.env, NODE_ENV: 'test' }, 'application');
  const db = require('../db');
  t.after(() => db.closeDatabase());
  await db.initializeDatabase();
  console.log(`Observed production runtime ${process.version} ${process.platform}/${process.arch}`);
  assert.equal(fs.existsSync('/app/node_modules/@testcontainers'), false, 'production install omits development dependencies');
  for (const name of ['.env', 'feedback.db.archived-20260830', '.superpowers', '.git']) {
    assert.equal(fs.existsSync(`/app/${name}`), false);
  }

  const base = 'http://127.0.0.1:3000';
  const request = (route, options = {}) => fetch(base + route, { signal: AbortSignal.timeout(10_000), ...options });
  const health = await request('/health');
  assert.equal(health.status, 200);
  const ready = await health.json();
  assert.equal(ready.ok, true);
  assert.equal(ready.checks.database, 'ok');
  assert.equal(ready.checks.schema, 'ok');
  assert.equal((await request('/login.html')).status, 200);
  assert.equal((await request('/api/patients')).status, 401);
  const login = (password) => request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'runtime-admin', password })
  });
  assert.equal((await login('wrong-synthetic-password')).status, 401);
  const signedIn = await login(process.env.RUNTIME_ADMIN_PASSWORD);
  assert.equal(signedIn.status, 200);
  assert.equal((await signedIn.json()).role, 'ADMIN');
  const cookie = signedIn.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, origin: base };
  assert.equal((await request('/admin.html', { headers })).status, 200);
  console.log('Readiness, database schema 0022 and real bcrypt password login verified');

  const workbook = new (require('exceljs').Workbook)();
  const sheet = workbook.addWorksheet('Synthetic patients');
  sheet.addRow(['Reference ID', 'First Name', 'Mobile Number', 'Preferred Language']);
  sheet.addRow(['RUNTIME-XLSX', 'Synthetic Runtime', '9000000001', 'en']);
  const form = new FormData();
  form.append('file', new Blob([await workbook.xlsx.writeBuffer()]), 'synthetic.xlsx');
  const preview = await request('/api/patients/import/preview', { method: 'POST', headers, body: form });
  assert.equal(preview.status, 200);
  const parsed = await preview.json();
  assert.deepEqual(parsed.summary, { total: 1, new: 1, updates: 0, problems: 0 });
  const committed = await request('/api/patients/import/commit', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ token: parsed.token })
  });
  assert.equal(committed.status, 200);
  assert.deepEqual(await committed.json(), { created: 1, updated: 0, failures: [] });
  const stored = await db.dbGet('SELECT first_name, normalized_phone FROM patients WHERE reference_id = ?', ['RUNTIME-XLSX']);
  assert.deepEqual(stored, { first_name: 'Synthetic Runtime', normalized_phone: '9000000001' });
  console.log('Authenticated real XLSX preview/commit and persisted values verified');

  const fontPath = '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf';
  assert.ok(fs.statSync(fontPath).size > 10_000);
  const devanagari = 'नमस्ते भारत';
  const font = require('fontkit').openSync(fontPath);
  assert.ok(font.layout(devanagari).glyphs.every((glyph) => glyph.id !== 0), 'Devanagari glyphs must exist');
  const pdfPath = await require('../services/pdf').generateReportPDF({
    date: '2026-09-09', summary_text: devanagari, feedback_count: 1, average_rating: 5,
    analyzed_calls: [{ customer_name: 'Synthetic', analysis_summary: devanagari }]
  });
  t.after(() => fs.rmSync(pdfPath, { force: true }));
  const pdf = fs.readFileSync(pdfPath);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.toString('latin1'), /NotoSansDevanagari/);
  assert.match(pdf.toString('latin1'), /\/FontFile2/);
  assert.ok(pdf.length > 5000);
  console.log(`Real PDF service generated ${pdf.length} bytes with embedded Noto Devanagari font`);

  await new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:3000/icallmate/media');
    ws.once('unexpected-response', (req, res) => {
      try { assert.equal(res.statusCode, 401); res.resume(); req.destroy(); resolve(); } catch (error) { reject(error); }
    });
    ws.once('open', () => { ws.terminate(); reject(new Error('tokenless media accepted')); });
    ws.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    const token = encodeURIComponent(process.env.ICALLMATE_MEDIA_SHARED_SECRET);
    const ws = new WebSocket(`ws://127.0.0.1:3000/icallmate/media?token=${token}`);
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('fake-provider reverse audio timed out')); }, 15_000);
    t.after(() => { clearTimeout(timeout); ws.terminate(); });
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({
      event: 'answer', streamId: 'runtime-synthetic-stream', callerId: '9000000002',
      extraParams: { callDirection: 'outbound', customerName: 'Synthetic' }
    })));
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.event === 'reverse-media') {
          assert.ok(Buffer.from(message.payload, 'base64').length > 0);
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      } catch (error) { reject(error); }
    });
  });
  const providerEvents = fs.readFileSync('/tmp/runtime-provider-events', 'utf8');
  for (const event of ['/listen', '/speak', 'gemini-reply', 'tts-speak', 'tts-audio']) assert.ok(providerEvents.includes(event), event);
  console.log('Real authenticated WebSocket bridge returned reverse audio through local Gemini/Deepgram fakes');
});
