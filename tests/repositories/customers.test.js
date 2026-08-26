const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  hasHostedTestDatabase,
  withTestDatabase
} = require('../helpers/postgres-test-context');
const { withTransaction } = require('../../persistence/postgres');

const databaseTest = hasHostedTestDatabase() ? test : test.skip;

function databaseFacade(pool) {
  return {
    query(text, values) {
      return pool.query(text, values);
    },
    transaction(work) {
      return withTransaction(pool, work);
    }
  };
}

function loadRepositories(database) {
  const { createRepositories } = require('../../repositories');
  return createRepositories(database);
}

async function createClient(clients, suffix) {
  return clients.create({
    slug: `clinic-${suffix}`,
    name: `Clinic ${suffix}`,
    timezone: 'Asia/Kolkata',
    metadata: { region: suffix }
  });
}

databaseTest('client repository creates and finds API-safe client records', async () => {
  await withTestDatabase(async ({ pool }) => {
    const { clients } = loadRepositories(databaseFacade(pool));

    const created = await clients.create({
      id: 999,
      slug: 'north-clinic',
      name: 'North Clinic',
      timezone: 'Asia/Kolkata',
      metadata: { plan: 'starter' },
      ignored_field: 'not persisted'
    });

    assert.equal(typeof created.id, 'number');
    assert.notEqual(created.id, 999);
    assert.equal(created.slug, 'north-clinic');
    assert.deepEqual(created.metadata, { plan: 'starter' });
    assert.equal(typeof created.created_at, 'string');
    assert.equal(Object.hasOwn(created, 'ignored_field'), false);
    assert.deepEqual(await clients.findById(created.id), created);
    assert.deepEqual(await clients.findBySlug('north-clinic'), created);
  });
});

databaseTest('customer phone uniqueness is isolated per client', async () => {
  await withTestDatabase(async ({ pool }) => {
    const { clients, customers } = loadRepositories(databaseFacade(pool));
    const north = await createClient(clients, 'north');
    const south = await createClient(clients, 'south');

    const first = await customers.create(north.id, {
      name: 'Asha North',
      phone: '+919876543210'
    });
    const second = await customers.create(south.id, {
      name: 'Asha South',
      phone: '+919876543210'
    });

    assert.equal(first.client_id, north.id);
    assert.equal(second.client_id, south.id);
    await assert.rejects(
      customers.create(north.id, { name: 'Duplicate', phone: '+919876543210' }),
      (error) => error.code === 'CUSTOMER_PHONE_EXISTS'
        && error.constraint === 'customers_client_phone_unique'
    );
    assert.deepEqual((await customers.list(north.id)).map(({ name }) => name), ['Asha North']);
    assert.deepEqual((await customers.list(south.id)).map(({ name }) => name), ['Asha South']);
  });
});

databaseTest('customer CRUD uses explicit field whitelists and API-compatible values', async () => {
  await withTestDatabase(async ({ pool }) => {
    const { clients, customers } = loadRepositories(databaseFacade(pool));
    const client = await createClient(clients, 'crud');

    const created = await customers.create(client.id, {
      id: 777,
      client_id: 999,
      name: 'Ravi Kumar',
      phone: '+919800000001',
      preferred_slot: '14:15',
      customer_value: 'vip',
      revenue_estimate: 2500,
      do_not_call: false,
      unapproved: 'ignore me'
    });

    assert.notEqual(created.id, 777);
    assert.equal(created.client_id, client.id);
    assert.equal(created.revenue_estimate, 2500);
    assert.equal(created.do_not_call, 0);
    assert.equal(typeof created.created_at, 'string');
    assert.equal(Object.hasOwn(created, 'unapproved'), false);
    assert.deepEqual(await customers.findByPhone(client.id, created.phone), created);

    const updated = await customers.update(client.id, created.id, {
      id: 888,
      client_id: 888,
      name: 'Ravi Sharma',
      priority_score: 91,
      do_not_call: true,
      unknown_column: 'ignore me'
    });

    assert.equal(updated.id, created.id);
    assert.equal(updated.client_id, client.id);
    assert.equal(updated.name, 'Ravi Sharma');
    assert.equal(updated.priority_score, 91);
    assert.equal(updated.do_not_call, 1);
    assert.equal(Object.hasOwn(updated, 'unknown_column'), false);
    assert.equal(await customers.findById(client.id + 1, created.id), null);
  });
});

databaseTest('scheduling a retry increments the stored counter atomically', async () => {
  await withTestDatabase(async ({ pool }) => {
    const { clients, customers } = loadRepositories(databaseFacade(pool));
    const client = await createClient(clients, 'retry');
    const customer = await customers.create(client.id, {
      name: 'Retry Customer',
      phone: '+919800000002'
    });
    const retryAt = '2026-08-26T08:30:00.000Z';

    const first = await customers.scheduleRetry(client.id, customer.id, retryAt);
    const second = await customers.scheduleRetry(client.id, customer.id, retryAt);

    assert.equal(first.retry_count, 1);
    assert.equal(second.retry_count, 2);
    assert.equal(second.status, 'retry_scheduled');
    assert.equal(second.next_retry_at, retryAt);
  });
});

databaseTest('scheduler query returns only due, callable, non-recent customers for one client', async () => {
  await withTestDatabase(async ({ pool }) => {
    const { clients, customers } = loadRepositories(databaseFacade(pool));
    const client = await createClient(clients, 'scheduler');
    const otherClient = await createClient(clients, 'other');
    const now = '2026-08-26T09:00:00.000Z';

    const pending = await customers.create(client.id, {
      name: 'High Priority Slot',
      phone: '+919800000010',
      best_call_slot: '09:00',
      priority_score: 90
    });
    await customers.create(client.id, {
      name: 'Due Retry',
      phone: '+919800000011',
      status: 'retry_scheduled',
      next_retry_at: '2026-08-26T08:59:00.000Z',
      priority_score: 70
    });
    await customers.create(client.id, {
      name: 'Blocked DND',
      phone: '+919800000012',
      best_call_slot: '09:00',
      do_not_call: true,
      priority_score: 100
    });
    const recent = await customers.create(client.id, {
      name: 'Recently Called',
      phone: '+919800000013',
      best_call_slot: '09:00',
      priority_score: 95
    });
    await customers.create(otherClient.id, {
      name: 'Other Tenant',
      phone: '+919800000010',
      best_call_slot: '09:00',
      priority_score: 99
    });
    await pool.query(
      `insert into calls (client_id, customer_id, called_at, outcome)
       values ($1, $2, $3, 'completed')`,
      [client.id, recent.id, '2026-08-26T08:40:00.000Z']
    );

    const eligible = await customers.findEligibleForScheduler(client.id, {
      currentSlot: '09:00',
      now,
      recentCallMinutes: 45,
      limit: 10
    });

    assert.deepEqual(eligible.map(({ name }) => name), ['High Priority Slot', 'Due Retry']);
    assert.equal(eligible[0].id, pending.id);
  });
});

databaseTest('customer deletion cascades through calls and feedback without crossing tenants', async () => {
  await withTestDatabase(async ({ pool }) => {
    const { clients, customers } = loadRepositories(databaseFacade(pool));
    const client = await createClient(clients, 'delete');
    const customer = await customers.create(client.id, {
      name: 'Delete Customer',
      phone: '+919800000020'
    });
    const call = await pool.query(
      `insert into calls (client_id, customer_id, outcome)
       values ($1, $2, 'completed') returning id`,
      [client.id, customer.id]
    );
    await pool.query(
      `insert into feedback (client_id, customer_id, call_id, review_text, stars)
       values ($1, $2, $3, 'Good', 5)`,
      [client.id, customer.id, call.rows[0].id]
    );

    assert.equal(await customers.deleteWithRelations(client.id, customer.id), true);
    assert.equal(await customers.deleteWithRelations(client.id, customer.id), false);
    const counts = await pool.query(
      `select
         (select count(*)::int from customers) as customers,
         (select count(*)::int from calls) as calls,
         (select count(*)::int from feedback) as feedback`
    );
    assert.deepEqual(counts.rows[0], { customers: 0, calls: 0, feedback: 0 });
  });
});

test('every tenant-owned customer method rejects a missing client before querying', async () => {
  let queryCount = 0;
  const database = {
    query() {
      queryCount += 1;
      throw new Error('SQL must not run');
    },
    transaction() {
      queryCount += 1;
      throw new Error('transaction must not run');
    }
  };
  const { customers } = loadRepositories(database);

  const operations = [
    () => customers.create(undefined, { name: 'No tenant', phone: '+919800000099' }),
    () => customers.findById(null, 1),
    () => customers.findByPhone('', '+919800000099'),
    () => customers.list(0),
    () => customers.update(undefined, 1, { name: 'No tenant' }),
    () => customers.scheduleRetry(null, 1, new Date().toISOString()),
    () => customers.deleteWithRelations(undefined, 1),
    () => customers.findEligibleForScheduler(null, { currentSlot: '09:00' })
  ];

  for (const operation of operations) {
    await assert.rejects(operation, (error) => error.code === 'CLIENT_ID_REQUIRED');
  }
  assert.equal(queryCount, 0);
});
