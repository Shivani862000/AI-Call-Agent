'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parse } = require('csv-parse/sync');

process.env.NODE_ENV = 'test';

async function listen(t, app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('csv-parse keeps duplicate prototype-named columns as data without replacing the record prototype', () => {
  const [record] = parse([
    '__proto__,__proto__,constructor,name',
    'first,second,value,Aarti'
  ].join('\n'), {
    columns: true,
    group_columns_by_name: true,
    skip_empty_lines: true,
    trim: true
  });

  assert.equal(Object.getPrototypeOf(record), Object.prototype);
  assert.equal(Object.hasOwn(record, '__proto__'), true);
  assert.deepEqual(record.__proto__, ['first', 'second']);
  assert.equal(record.constructor, 'value');
  assert.equal({}.first, undefined);
});

async function createCustomerUploadApp(t) {
  const db = require('../db');
  const originals = { dbRun: db.dbRun, dbGet: db.dbGet, dbAll: db.dbAll };
  const writes = [];
  db.dbRun = async (sql, params) => {
    writes.push({ sql, params });
    return { lastID: writes.length, changes: 1 };
  };
  db.dbGet = async (sql) => (/COUNT\(\*\)/i.test(sql) ? { count: 0 } : undefined);
  db.dbAll = async () => [];
  const routePath = require.resolve('../routes/customers');
  const patientLinkPath = require.resolve('../src/patient-link');
  let customerRouter;
  try {
    delete require.cache[routePath];
    delete require.cache[patientLinkPath];
    customerRouter = require(routePath);
  } finally {
    Object.assign(db, originals);
  }
  t.after(() => {
    delete require.cache[routePath];
    delete require.cache[patientLinkPath];
  });

  const pass = (req, res, next) => next();
  const app = require('../src/app')({
    publicBaseUrl: 'http://localhost:3000',
    auth: {
      PROTECTED_HTML_PATHS: [], requireAdminAuth: pass, basicAuth: pass,
      requireRole: () => pass
    },
    mountApiRoutes(target) {
      target.use('/api/customers', customerRouter);
    }
  });
  return { baseUrl: await listen(t, app), writes };
}

test('customer CSV import accepts prototype-named columns as inert data', async t => {
  const fixture = await createCustomerUploadApp(t);
  const form = new FormData();
  form.append('file', new Blob([[
    '__proto__,__proto__,constructor,name,phone,scheduled_date,preferred_slot',
    'first,second,value,Synthetic Customer,+919876543210,2099-01-01,10:00'
  ].join('\n')], { type: 'text/csv' }), 'customers.csv');

  const response = await fetch(`${fixture.baseUrl}/api/customers/csv`, { method: 'POST', body: form });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    message: 'CSV import completed', successCount: 1, errorCount: 0, totalRows: 1, errors: []
  });
  assert.equal(fixture.writes.length, 2);
  assert.match(fixture.writes[0].sql, /INSERT INTO patients/);
  assert.match(fixture.writes[1].sql, /INSERT INTO customers/);
});

test('customer CSV upload rejects more than 5000 parsed rows before any database write', async t => {
  const fixture = await createCustomerUploadApp(t);
  const rows = ['name,phone,scheduled_date,preferred_slot'];
  for (let index = 0; index < 5001; index += 1) {
    rows.push(`Customer ${index},+9190000${String(index).padStart(5, '0')},2099-01-01,10:00`);
  }
  const form = new FormData();
  form.append('file', new Blob([rows.join('\n')], { type: 'text/csv' }), 'customers.csv');

  const response = await fetch(`${fixture.baseUrl}/api/customers/csv`, { method: 'POST', body: form });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'CSV file exceeds maximum row limit of 5000' });
  assert.equal(fixture.writes.length, 0);
});

test('customer upload rejects malformed and oversized multipart input without database effects', async t => {
  const fixture = await createCustomerUploadApp(t);
  const errors = [];
  const error = console.error;
  console.error = (...args) => { errors.push(args); };
  let malformed;
  let oversized;
  try {
    malformed = await fetch(`${fixture.baseUrl}/api/customers/csv`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=synthetic-boundary' },
      body: [
        '--synthetic-boundary',
        'Content-Disposition: form-data; name="file"; filename="customers.csv"',
        'Content-Type: text/csv',
        '',
        'name,phone',
        'Aarti,+919876543210'
      ].join('\r\n')
    });

    const oversizedForm = new FormData();
    oversizedForm.append('file', new Blob([Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)], {
      type: 'text/csv'
    }), 'oversized.csv');
    oversized = await fetch(`${fixture.baseUrl}/api/customers/csv`, {
      method: 'POST', body: oversizedForm
    });
  } finally {
    console.error = error;
  }

  for (const response of [malformed, oversized]) {
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error, 'An internal server error occurred. Please try again later.');
    assert.equal(typeof body.reqId, 'string');
  }
  assert.equal(errors.length, 2);
  assert.equal(fixture.writes.length, 0);
});

test('production form and query parsing preserve scalar values and inert bracket-named input', async t => {
  const createApp = require('../src/app');
  const pass = (req, res, next) => next();
  const app = createApp({
    publicBaseUrl: 'http://localhost:3000',
    auth: {
      PROTECTED_HTML_PATHS: [], requireAdminAuth: pass, basicAuth: pass,
      requireRole: () => pass
    },
    mountApiRoutes(target) {
      const reply = (req, res) => res.json({ body: req.body, query: req.query });
      target.get('/compat/parsing', reply);
      target.post('/compat/parsing', reply);
    }
  });
  const baseUrl = await listen(t, app);

  const query = await fetch(`${baseUrl}/compat/parsing?filter=ready&filter=waiting&constructor%5BisBuffer%5D=x`);
  assert.deepEqual((await query.json()).query, {
    filter: ['ready', 'waiting'], constructor: { isBuffer: 'x' }
  });

  const form = await fetch(`${baseUrl}/compat/parsing`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=synthetic-admin&password=synthetic-pass&constructor%5BisBuffer%5D=x'
  });
  assert.deepEqual((await form.json()).body, {
    username: 'synthetic-admin', password: 'synthetic-pass', 'constructor[isBuffer]': 'x'
  });
  assert.equal({}.isBuffer, undefined);
});

test('mailer composes text and HTML with Nodemailer while outbound delivery stays in memory', async t => {
  const nodemailer = require('nodemailer');
  const createTransport = nodemailer.createTransport;
  let smtpOptions;
  let messageOptions;
  let captured;
  nodemailer.createTransport = (options) => {
    smtpOptions = options;
    const sink = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    return {
      async sendMail(message) {
        messageOptions = message;
        captured = await sink.sendMail(message);
        return { ...captured, accepted: String(message.to).split(',').map((value) => value.trim()) };
      }
    };
  };
  t.after(() => { nodemailer.createTransport = createTransport; });

  const previous = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    SMTP_AUTH_MODE: process.env.SMTP_AUTH_MODE,
    MAIL_FROM: process.env.MAIL_FROM,
    GMAIL_CLIENT_EMAIL: process.env.GMAIL_CLIENT_EMAIL,
    GMAIL_PRIVATE_KEY: process.env.GMAIL_PRIVATE_KEY,
    GMAIL_KEY_FILE: process.env.GMAIL_KEY_FILE,
    GMAIL_IMPERSONATE: process.env.GMAIL_IMPERSONATE
  };
  Object.assign(process.env, {
    SMTP_HOST: 'smtp.invalid', SMTP_PORT: '587', SMTP_USER: 'synthetic-user',
    SMTP_PASS: 'synthetic-password', SMTP_AUTH_MODE: 'password',
    MAIL_FROM: 'noreply@example.test', GMAIL_CLIENT_EMAIL: '',
    GMAIL_PRIVATE_KEY: '', GMAIL_KEY_FILE: '', GMAIL_IMPERSONATE: ''
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const mailerPath = require.resolve('../services/mailer');
  delete require.cache[mailerPath];
  const mailer = require(mailerPath);
  t.after(() => {
    mailer.resetTransport();
    delete require.cache[mailerPath];
  });

  const result = await mailer.sendMail({
    to: ['owner@example.test', 'audit@example.test'],
    subject: 'Synthetic digest',
    text: 'plain synthetic body',
    html: '<p>html synthetic body</p>'
  });
  const raw = captured.message.toString('utf8');

  assert.equal(result.sent, true);
  assert.deepEqual(result.accepted, ['owner@example.test', 'audit@example.test']);
  assert.equal(smtpOptions.requireTLS, true);
  assert.deepEqual(messageOptions, {
    from: 'noreply@example.test',
    to: 'owner@example.test, audit@example.test',
    subject: 'Synthetic digest',
    text: 'plain synthetic body',
    html: '<p>html synthetic body</p>'
  });
  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.match(raw, /plain synthetic body/);
  assert.match(raw, /html synthetic body/);
});
