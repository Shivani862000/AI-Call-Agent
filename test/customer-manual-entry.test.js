'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Customer = require('../src/models/Customer');
const customersRouter = require('../routes/customers');

test('manual customer entry saves to MongoDB without a deprecated SQLite write', async (t) => {
  const originalCreate = Customer.create;
  Customer.create = async (value) => ({ _id: 'customer-1', ...value });
  t.after(() => { Customer.create = originalCreate; });

  const handler = customersRouter.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.post).route.stack[0].handle;
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; }
  };

  await handler({
    body: { name: 'Asha Rao', phone: '+919876543210', preferred_slot: '' },
    tenantId: 'tenant-1',
    adminSession: { username: 'admin@example.com' }
  }, response);

  assert.equal(response.statusCode, null);
  assert.deepEqual(response.body, { id: 'customer-1', message: 'Customer added successfully' });
});

test('manual customer entry submits the selected preferred language', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'customer-list.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'customer-list.js'), 'utf8');

  assert.match(page, /id="addCustomerPreferredLanguage" name="preferred_language"/);
  assert.match(script, /preferred_language:\s*document\.getElementById\('addCustomerPreferredLanguage'\)\.value/);
});

test('customer directory provides a prefilled edit action that uses the update endpoint', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'customer-list.js'), 'utf8');

  assert.match(script, /data-edit-customer/);
  assert.match(script, /function openEditCustomerModal\(customer\)/);
  assert.match(script, /method: editingCustomerId \? 'PUT' : 'POST'/);
  assert.match(script, /\/customers\/\$\{editingCustomerId\}/);
});
