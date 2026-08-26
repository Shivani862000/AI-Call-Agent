const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { startTestApp } = require('./helpers/start-test-app');

let application;
let customerId;

async function request(path, options = {}) {
  const response = await application.fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const body = await response.json();
  return { response, body };
}

before(async () => {
  application = await startTestApp();
});

after(async () => {
  await application?.stop();
});

test('health exposes a successful JSON readiness shape', async () => {
  const { response, body } = await request('/health');

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.timestamp, 'string');
  assert.equal(Number.isNaN(Date.parse(body.timestamp)), false);
});

test('customer create returns a numeric public ID and stable message', async () => {
  const { response, body } = await request('/api/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Asha Rao',
      phone: '+919876543210',
      preferred_slot: '10:30',
      customer_value: 'vip',
      urgency_level: 'high',
      preferred_language: 'hi',
      consent_status: 'granted'
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.message, 'Customer added successfully');
  assert.equal(typeof body.id, 'number');
  customerId = body.id;
});

test('duplicate customer phone returns the current field error contract', async () => {
  const { response, body } = await request('/api/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Asha Duplicate',
      phone: '+919876543210',
      preferred_slot: '11:00'
    })
  });

  assert.equal(response.status, 409);
  assert.deepEqual(body, {
    error: 'A customer with this phone number already exists',
    fieldErrors: { phone: 'Phone number already exists' }
  });
});

test('customer list and lookup retain numeric IDs and snake_case fields', async () => {
  const listed = await request('/api/customers');
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].id, customerId);
  assert.equal(listed.body[0].preferred_slot, '10:30');
  assert.equal(listed.body[0].customer_value, 'vip');
  assert.equal(listed.body[0].do_not_call, 0);

  const found = await request(`/api/customers/${customerId}`);
  assert.equal(found.response.status, 200);
  assert.equal(found.body.name, 'Asha Rao');
  assert.equal(found.body.consent_status, 'granted');
});

test('customer update preserves its response and stored field names', async () => {
  const updated = await request(`/api/customers/${customerId}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'Asha Sharma',
      phone: '+919876543210',
      preferred_slot: '14:15',
      customer_value: 'high',
      urgency_level: 'normal',
      preferred_language: 'hinglish',
      preferred_dialect: 'Delhi',
      do_not_call: false,
      consent_status: 'pending',
      revenue_stage: 'qualified',
      revenue_estimate: 2500
    })
  });

  assert.equal(updated.response.status, 200);
  assert.deepEqual(updated.body, { message: 'Customer updated successfully' });

  const found = await request(`/api/customers/${customerId}`);
  assert.equal(found.body.name, 'Asha Sharma');
  assert.equal(found.body.preferred_slot, '14:15');
  assert.equal(found.body.preferred_language, 'hinglish');
  assert.equal(found.body.revenue_estimate, 2500);
});

test('manual feedback validation returns stable field errors', async () => {
  const { response, body } = await request('/api/feedback/manual', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerId, review_text: 'bad', stars: 0 })
  });

  assert.equal(response.status, 400);
  assert.deepEqual(body, {
    error: 'Please fix the highlighted fields',
    fieldErrors: {
      review_text: 'Review text should be at least 5 characters',
      stars: 'Rating must be between 1 and 5'
    }
  });
});

test('manual feedback returns a numeric ID and lists the joined customer', async () => {
  const created = await request('/api/feedback/manual', {
    method: 'POST',
    body: JSON.stringify({
      customer_id: customerId,
      review_text: 'Excellent and helpful service',
      stars: 5
    })
  });

  assert.equal(created.response.status, 200);
  assert.equal(typeof created.body.id, 'number');
  assert.equal(created.body.category, 'good');
  assert.equal(created.body.reason, 'High star rating');

  const listed = await request('/api/feedback');
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].customer_id, customerId);
  assert.equal(listed.body[0].customer_name, 'Asha Sharma');
  assert.equal(listed.body[0].source, 'manual');
});

test('customer deletion removes the customer and its feedback', async () => {
  const deleted = await request(`/api/customers/${customerId}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.body, { message: 'Customer deleted successfully' });

  const customer = await request(`/api/customers/${customerId}`);
  assert.equal(customer.response.status, 404);
  assert.deepEqual(customer.body, { error: 'Customer not found' });

  const feedback = await request('/api/feedback');
  assert.equal(feedback.response.status, 200);
  assert.deepEqual(feedback.body, []);
});

test('active-client selection isolates identical customer data across two tenants', async () => {
  const [firstClientId, secondClientId] = application.clientIds;
  const select = (clientId) => request('/auth/select-client', {
    method: 'POST',
    body: JSON.stringify({ clientId })
  });
  const create = (name) => request('/api/customers', {
    method: 'POST',
    body: JSON.stringify({ name, phone: '+919999000111', preferred_slot: '10:00' })
  });

  assert.equal((await select(firstClientId)).response.status, 200);
  assert.equal((await create('Tenant One Customer')).response.status, 200);
  assert.equal((await select(secondClientId)).response.status, 200);
  assert.equal((await create('Tenant Two Customer')).response.status, 200);
  const secondList = await request('/api/customers');
  assert.deepEqual(secondList.body.map((customer) => customer.name), ['Tenant Two Customer']);

  assert.equal((await select(firstClientId)).response.status, 200);
  const firstList = await request('/api/customers');
  assert.deepEqual(firstList.body.map((customer) => customer.name), ['Tenant One Customer']);
});
