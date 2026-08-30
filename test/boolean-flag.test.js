'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The function is module-private; evaluate it out of the source so the
// behaviour is pinned without exporting it just for a test.
const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'customers.js'), 'utf8');
const body = /function toBooleanFlag\(value\) \{[\s\S]*?\n\}/.exec(source)[0];
// eslint-disable-next-line no-new-func
const toBooleanFlag = new Function(`${body}; return toBooleanFlag;`)();

test('booleans map to 1 and 0', () => {
  assert.strictEqual(toBooleanFlag(true), 1);
  assert.strictEqual(toBooleanFlag(false), 0);
});

test('numbers and numeric strings work — the form and the API both send these', () => {
  for (const truthy of [1, '1', 'true', 'TRUE', 'yes', 'on']) {
    assert.strictEqual(toBooleanFlag(truthy), 1, `${JSON.stringify(truthy)} should be 1`);
  }
  for (const falsy of [0, '0', 'false', 'no', 'off', '']) {
    assert.strictEqual(toBooleanFlag(falsy), 0, `${JSON.stringify(falsy)} should be 0`);
  }
});

test('it never returns undefined — these values feed NOT NULL columns', () => {
  for (const value of [undefined, null, {}, [], 'nonsense', NaN]) {
    const result = toBooleanFlag(value);
    assert.ok(result === 0 || result === 1, `${JSON.stringify(value)} produced ${result}`);
  }
});
