'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the flag defaults to off, so production is unaffected', () => {
  delete process.env.DISABLE_INBOUND_CALLS;
  delete require.cache[require.resolve('../src/config')];
  assert.strictEqual(require('../src/config').DISABLE_INBOUND_CALLS, false);
});

test('the flag reads the usual truthy spellings', () => {
  for (const value of ['true', '1', 'yes', 'on', 'TRUE']) {
    process.env.DISABLE_INBOUND_CALLS = value;
    delete require.cache[require.resolve('../src/config')];
    assert.strictEqual(require('../src/config').DISABLE_INBOUND_CALLS, true, value);
  }
  for (const value of ['false', '0', '', 'no']) {
    process.env.DISABLE_INBOUND_CALLS = value;
    delete require.cache[require.resolve('../src/config')];
    assert.strictEqual(require('../src/config').DISABLE_INBOUND_CALLS, false, value);
  }
  delete process.env.DISABLE_INBOUND_CALLS;
  delete require.cache[require.resolve('../src/config')];
});

test('the inbound webhook is guarded when the flag is set', () => {
  const source = read('src/api-routes.js');
  const handler = source.slice(source.indexOf("app.post('/api/icallmate/callback'"));
  assert.match(handler.slice(0, 700), /DISABLE_INBOUND_CALLS/,
    'the guard must be the first thing the callback does');
  assert.match(handler.slice(0, 700), /403/);
});

test('UAT is configured outbound-only in the deployment template', () => {
  assert.match(read('.env.uat.example'), /DISABLE_INBOUND_CALLS=true/,
    'UAT shares a DID with production and must never answer an inbound call');
});
