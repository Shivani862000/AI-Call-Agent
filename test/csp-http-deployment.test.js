'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('upgrade-insecure-requests is conditional on serving over HTTPS', () => {
  // Emitted unconditionally, it breaks every plain-HTTP deployment: the page
  // loads but its scripts and fetches are rewritten to a port nothing serves.
  assert.match(source, /SERVES_OVER_HTTPS\s*=\s*\/\^https:\/i\.test/);
  assert.match(source, /SERVES_OVER_HTTPS \? \{\} : \{ upgradeInsecureRequests: null \}/);
});

test('HSTS is also conditional', () => {
  // A year-long HSTS pin against a host that cannot serve TLS is unrecoverable
  // from the user's side.
  assert.match(source, /hsts: SERVES_OVER_HTTPS/);
});
