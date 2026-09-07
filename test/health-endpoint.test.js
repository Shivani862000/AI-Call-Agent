'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

require('dotenv').config();

function serve(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function get(port, path = '/health') {
  return new Promise((resolve, reject) => {
    http.get({ port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

/** Mounts only the health route, with the database module stubbed. */
function healthApp(dbBehaviour) {
  const path = require.resolve('../db');
  const original = require.cache[path];
  require.cache[path] = { id: path, filename: path, loaded: true, exports: dbBehaviour };

  const routesPath = require.resolve('../src/api-routes');
  delete require.cache[routesPath];
  const app = express();
  require(routesPath)(app);

  return {
    app,
    restore() {
      if (original) require.cache[path] = original; else delete require.cache[path];
      delete require.cache[routesPath];
    }
  };
}

// It answered {ok:true} unconditionally, so it stayed green with the database
// unreachable. A check that cannot fail is worse than no check, because an
// uptime monitor is built to trust it.
test('an unreachable database is reported as unhealthy', async () => {
  const { app, restore } = healthApp({
    EXPECTED_SCHEMA_VERSION: '0019',
    dbGet: async () => { throw new Error('connection refused'); }
  });
  const server = await serve(app);
  try {
    const { status, body } = await get(server.address().port);
    assert.equal(status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.checks.database, 'unreachable');
  } finally {
    server.close();
    restore();
  }
});

test('a schema the code does not expect is reported as unhealthy', async () => {
  const { app, restore } = healthApp({
    EXPECTED_SCHEMA_VERSION: '0019',
    dbGet: async () => ({ version: '0011' })
  });
  const server = await serve(app);
  try {
    const { status, body } = await get(server.address().port);
    assert.equal(status, 503);
    assert.equal(body.checks.schema, 'mismatch');
  } finally {
    server.close();
    restore();
  }
});

test('a working app answers 200 and says what it checked', async () => {
  const { app, restore } = healthApp({
    EXPECTED_SCHEMA_VERSION: '0019',
    dbGet: async () => ({ version: '0019_something' })
  });
  const server = await serve(app);
  try {
    const { status, body } = await get(server.address().port);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.checks.database, 'ok');
    assert.equal(body.checks.schema, 'ok');
    assert.ok(Number.isInteger(body.uptimeSeconds));
  } finally {
    server.close();
    restore();
  }
});

// The endpoint has to be unauthenticated, so it must not describe the system to
// whoever asks.
test('the public health check does not advertise internals', async () => {
  const { app, restore } = healthApp({
    EXPECTED_SCHEMA_VERSION: '0019',
    dbGet: async () => ({ version: '0019' })
  });
  const server = await serve(app);
  try {
    const { body } = await get(server.address().port);
    const text = JSON.stringify(body);
    for (const leak of ['gemini', 'deepgram', 'supabase', 'https://', 'model']) {
      assert.doesNotMatch(text.toLowerCase(), new RegExp(leak), `health leaks ${leak}`);
    }
  } finally {
    server.close();
    restore();
  }
});
