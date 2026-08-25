'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('webmaster operational source does not project customer content', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/webmaster/tenant-service.js'), 'utf8');
  assert.doesNotMatch(source, /CustomerModel\.find\s*\(/);
  assert.doesNotMatch(source, /transcript|recording_url|review_text|customerName/);
});
