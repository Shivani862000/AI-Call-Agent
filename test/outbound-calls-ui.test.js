'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('outbound calls opens on the scheduled queue', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'customers.html'), 'utf8');

  assert.match(page, /data-customer-filter="scheduled" aria-pressed="true"/);
  assert.match(page, /let activeCustomerMetricFilter = 'scheduled';/);
});
