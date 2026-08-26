const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const request = require('supertest');
const {
  hasHostedTestDatabase,
  withTestDatabase
} = require('../helpers/postgres-test-context');
const { withTransaction } = require('../../persistence/postgres');

const databaseTest = hasHostedTestDatabase() ? test : test.skip;

function databaseFacade(pool) {
  return {
    query: pool.query.bind(pool),
    transaction(work) {
      return withTransaction(pool, work);
    }
  };
}

databaseTest('customer routes preserve contracts while resolving tenant context internally', async () => {
  await withTestDatabase(async ({ pool }) => {
    const { createRepositories } = require('../../repositories');
    const { createCustomersRouter } = require('../../routes/customers');
    const { clients, customers } = createRepositories(databaseFacade(pool));
    const client = await clients.create({ slug: 'route-clinic', name: 'Route Clinic' });
    const observedRequests = [];
    const app = express();
    app.use(express.json());
    app.use('/api/customers', createCustomersRouter({
      customers,
      getClientId(req) {
        observedRequests.push(req.method);
        return client.id;
      }
    }));

    const malformed = await request(app).get('/api/customers/not-a-number');
    assert.equal(malformed.status, 404);
    assert.deepEqual(malformed.body, { error: 'Customer not found' });

    const created = await request(app)
      .post('/api/customers')
      .send({
        name: 'Asha Rao',
        phone: '+919876543210',
        preferred_slot: '10:30',
        customer_value: 'vip',
        urgency_level: 'high',
        preferred_language: 'hi',
        consent_status: 'granted'
      });
    assert.equal(created.status, 200);
    assert.equal(created.body.message, 'Customer added successfully');
    assert.equal(typeof created.body.id, 'number');

    const duplicate = await request(app)
      .post('/api/customers')
      .send({ name: 'Duplicate', phone: '+919876543210', preferred_slot: '11:00' });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(duplicate.body, {
      error: 'A customer with this phone number already exists',
      fieldErrors: { phone: 'Phone number already exists' }
    });

    const listed = await request(app).get('/api/customers');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].client_id, client.id);
    assert.equal(listed.body[0].do_not_call, 0);

    const updated = await request(app)
      .put(`/api/customers/${created.body.id}`)
      .send({
        name: 'Asha Sharma',
        phone: '+919876543210',
        preferred_slot: '14:15',
        customer_value: 'high',
        urgency_level: 'normal',
        preferred_language: 'hinglish',
        consent_status: 'pending',
        revenue_stage: 'qualified',
        revenue_estimate: 2500
      });
    assert.deepEqual(updated.body, { message: 'Customer updated successfully' });

    const workflow = await request(app)
      .patch(`/api/customers/${created.body.id}/workflow`)
      .send({ do_not_call: true, pending_follow_ups: 'Call after lunch' });
    assert.deepEqual(workflow.body, { message: 'Workflow updated successfully' });

    const retryAt = '2026-08-26T08:30:00.000Z';
    const retry = await request(app)
      .post(`/api/customers/${created.body.id}/retry`)
      .send({ retry_at: retryAt });
    assert.deepEqual(retry.body, {
      message: 'Retry scheduled successfully',
      retry_at: retryAt
    });

    const found = await request(app).get(`/api/customers/${created.body.id}`);
    assert.equal(found.body.name, 'Asha Sharma');
    assert.equal(found.body.do_not_call, 1);
    assert.equal(found.body.retry_count, 1);
    assert.equal(found.body.revenue_estimate, 2500);

    const deleted = await request(app).delete(`/api/customers/${created.body.id}`);
    assert.deepEqual(deleted.body, { message: 'Customer deleted successfully' });
    const missing = await request(app).get(`/api/customers/${created.body.id}`);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'Customer not found' });
    assert.ok(observedRequests.length >= 8);
  });
});
