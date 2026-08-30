'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizePhoneLookupValue } = require('../src/helpers');

test('normalizes the formats the same customer arrives in', () => {
  const canonical = normalizePhoneLookupValue('+919354197715');
  assert.strictEqual(normalizePhoneLookupValue('919354197715'), canonical);
  assert.strictEqual(normalizePhoneLookupValue('09354197715'), canonical);
  assert.strictEqual(normalizePhoneLookupValue('+91 93541 97715'), canonical);
});

test('returns falsy for an unusable value', () => {
  assert.ok(!normalizePhoneLookupValue(''));
  assert.ok(!normalizePhoneLookupValue(null));
});
