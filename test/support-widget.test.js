'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('support popup close control never submits the required description form', () => {
  const widget = fs.readFileSync(path.join(__dirname, '..', 'public', 'support-widget.js'), 'utf8');
  assert.match(widget, /class="support-close" type="button"/);
});
