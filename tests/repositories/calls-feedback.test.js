const assert = require('node:assert/strict');
const { test } = require('node:test');
const { withTransaction } = require('../../persistence/postgres');
const {
  hasHostedTestDatabase,
  withTestDatabase
} = require('../helpers/postgres-test-context');

process.env.TWILIO_ACCOUNT_SID ||= 'AC00000000000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN ||= 'test-auth-token';

const databaseTest = hasHostedTestDatabase() ? test : test.skip;

function databaseFacade(pool) {
  return {
    query: pool.query.bind(pool),
    transaction(work) {
      return withTransaction(pool, work);
    }
  };
}

function repositories(pool) {
  const { createRepositories } = require('../../repositories');
  return createRepositories(databaseFacade(pool));
}

async function seedClientAndCustomer(repos, suffix) {
  const client = await repos.clients.create({ slug: `calls-${suffix}`, name: `Calls ${suffix}` });
  const customer = await repos.customers.create(client.id, {
    name: `Customer ${suffix}`,
    phone: `+91970000${String(suffix).padStart(4, '0')}`
  });
  return { client, customer };
}

databaseTest('call creation and customer status update commit or roll back together', async () => {
  await withTestDatabase(async ({ pool }) => {
    const repos = repositories(pool);
    const { client, customer } = await seedClientAndCustomer(repos, 1);

    const call = await repos.calls.createAndMarkCustomer(client.id, {
      customer_id: customer.id,
      twilio_sid: 'CA-transaction-success',
      outcome: 'initiated',
      called_at: '2026-08-26T09:00:00.000Z',
      customer_status: 'called'
    });
    assert.equal(typeof call.id, 'number');
    assert.equal(call.customer_id, customer.id);
    assert.equal((await repos.customers.findById(client.id, customer.id)).status, 'called');

    await repos.customers.update(client.id, customer.id, { status: 'pending' });
    await assert.rejects(
      repos.calls.createAndMarkCustomer(client.id, {
        customer_id: customer.id,
        twilio_sid: 'CA-transaction-rollback',
        extracted_rating: 6,
        customer_status: 'called'
      }),
      (error) => error.code === '23514'
    );
    assert.equal((await repos.customers.findById(client.id, customer.id)).status, 'pending');
    assert.equal(await repos.calls.findByTwilioSid(client.id, 'CA-transaction-rollback'), null);
  });
});

databaseTest('call repository isolates tenants and makes callback updates idempotent', async () => {
  await withTestDatabase(async ({ pool }) => {
    const repos = repositories(pool);
    const first = await seedClientAndCustomer(repos, 2);
    const second = await seedClientAndCustomer(repos, 3);
    const call = await repos.calls.create(first.client.id, {
      customer_id: first.customer.id,
      twilio_sid: 'CA-callback-idempotent',
      outcome: 'initiated'
    });

    assert.equal(await repos.calls.findById(second.client.id, call.id), null);
    assert.equal(await repos.calls.findByTwilioSid(second.client.id, call.twilio_sid), null);
    await repos.calls.updateByTwilioSid(first.client.id, call.twilio_sid, {
      outcome: 'busy',
      outcome_detail: 'busy'
    });
    await repos.calls.updateByTwilioSid(first.client.id, call.twilio_sid, {
      outcome: 'completed',
      outcome_detail: 'completed'
    });
    assert.equal((await repos.calls.findById(first.client.id, call.id)).outcome, 'completed');

    await assert.rejects(
      repos.calls.create(second.client.id, {
        customer_id: second.customer.id,
        twilio_sid: call.twilio_sid
      }),
      (error) => error.code === 'CALL_SID_EXISTS'
    );
    assert.equal((await repos.calls.listRecent(first.client.id)).length, 1);
    assert.equal((await repos.calls.listRecent(second.client.id)).length, 0);
  });
});

databaseTest('call repository preserves native jsonb and rejects payloads over 2 MiB', async () => {
  await withTestDatabase(async ({ pool }) => {
    const repos = repositories(pool);
    const { client, customer } = await seedClientAndCustomer(repos, 4);
    const call = await repos.calls.create(client.id, {
      customer_id: customer.id,
      analysis_json: JSON.stringify({ summary: 'Helpful visit' }),
      key_points_json: JSON.stringify(['clean']),
      objections_json: JSON.stringify(['wait']),
      competitor_mentions_json: JSON.stringify(['Other Clinic'])
    });

    assert.equal(call.analysis_json, '{"summary":"Helpful visit"}');
    const raw = await pool.query(
      `select jsonb_typeof(analysis) as analysis_type,
              jsonb_typeof(key_points) as key_points_type
         from calls where id = $1`,
      [call.id]
    );
    assert.deepEqual(raw.rows[0], { analysis_type: 'object', key_points_type: 'array' });

    await assert.rejects(
      repos.calls.create(client.id, {
        customer_id: customer.id,
        transcript_text: 'x'.repeat(2_097_153)
      }),
      (error) => error.code === 'CALL_PAYLOAD_TOO_LARGE'
    );
  });
});

databaseTest('feedback upsert is conflict-safe and listings retain joined customer fields', async () => {
  await withTestDatabase(async ({ pool }) => {
    const repos = repositories(pool);
    const { client, customer } = await seedClientAndCustomer(repos, 5);
    const call = await repos.calls.create(client.id, { customer_id: customer.id, outcome: 'completed' });

    const results = await Promise.all([
      repos.feedback.upsertForCall(client.id, {
        customer_id: customer.id,
        call_id: call.id,
        review_text: 'First version',
        category: 'average',
        stars: 3,
        source: 'call'
      }),
      repos.feedback.upsertForCall(client.id, {
        customer_id: customer.id,
        call_id: call.id,
        review_text: 'Final version',
        category: 'good',
        stars: 5,
        source: 'call'
      })
    ]);

    assert.equal(results[0].id, results[1].id);
    const listed = await repos.feedback.list(client.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].customer_name, customer.name);
    assert.equal(listed[0].call_id, call.id);
    assert.ok(['First version', 'Final version'].includes(listed[0].review_text));
    assert.deepEqual(await repos.feedback.list(client.id + 1), []);
  });
});

databaseTest('supervisor events are tenant-scoped and newest first', async () => {
  await withTestDatabase(async ({ pool }) => {
    const repos = repositories(pool);
    const { client, customer } = await seedClientAndCustomer(repos, 6);
    const other = await seedClientAndCustomer(repos, 7);
    const call = await repos.calls.create(client.id, { customer_id: customer.id });
    const first = await repos.supervisorEvents.append(client.id, {
      call_id: call.id,
      event_type: 'warning',
      severity: 'medium',
      payload_json: JSON.stringify({ order: 1 }),
      created_at: '2026-08-26T09:00:00.000Z'
    });
    const second = await repos.supervisorEvents.append(client.id, {
      call_id: call.id,
      event_type: 'escalated',
      severity: 'high',
      payload: { order: 2 },
      created_at: '2026-08-26T09:01:00.000Z'
    });

    assert.deepEqual(
      (await repos.supervisorEvents.listForCall(client.id, call.id)).map(({ id }) => id),
      [second.id, first.id]
    );
    assert.deepEqual(await repos.supervisorEvents.listForCall(other.client.id, call.id), []);
  });
});

databaseTest('deleting a customer removes repository-visible calls, feedback, and events', async () => {
  await withTestDatabase(async ({ pool }) => {
    const repos = repositories(pool);
    const { client, customer } = await seedClientAndCustomer(repos, 8);
    const call = await repos.calls.create(client.id, { customer_id: customer.id });
    await repos.feedback.create(client.id, {
      customer_id: customer.id,
      call_id: call.id,
      review_text: 'Good service',
      stars: 5
    });
    await repos.supervisorEvents.append(client.id, {
      call_id: call.id,
      event_type: 'noted'
    });

    await repos.customers.deleteWithRelations(client.id, customer.id);
    assert.deepEqual(await repos.calls.listRecent(client.id), []);
    assert.deepEqual(await repos.feedback.list(client.id), []);
    assert.deepEqual(await repos.supervisorEvents.listForCall(client.id, call.id), []);
  });
});

databaseTest('call feedback and outcome services persist only through tenant repositories', async () => {
  await withTestDatabase(async ({ pool }) => {
    const repos = repositories(pool);
    const { client, customer } = await seedClientAndCustomer(repos, 9);
    const call = await repos.calls.create(client.id, {
      customer_id: customer.id,
      twilio_sid: 'CA-service-feedback',
      outcome: 'initiated'
    });
    const { saveCallFeedbackFromTranscript } = require('../../services/call-feedback');
    const {
      applyCallOutcomeWorkflow,
      createSupervisorEvent
    } = require('../../services/call-orchestration');

    const saved = await saveCallFeedbackFromTranscript({
      repositories: repos,
      clientId: client.id,
      callSid: call.twilio_sid,
      customerId: customer.id,
      transcript: [
        { role: 'AGENT', text: 'How was your overall experience?' },
        { role: 'CUSTOMER', text: 'The service was very good and helpful.' },
        { role: 'AGENT', text: 'What star rating would you give?' },
        { role: 'CUSTOMER', text: '5' }
      ],
      categorize: async () => ({ category: 'good', reason: 'Positive' })
    });
    assert.equal(saved.saved, true);
    assert.equal((await repos.feedback.list(client.id)).length, 1);

    const workflow = await applyCallOutcomeWorkflow({
      repositories: repos,
      clientId: client.id,
      callRecord: await repos.calls.findById(client.id, call.id),
      customer: await repos.customers.findById(client.id, customer.id),
      providerStatus: 'completed',
      inferredOutcome: 'completed'
    });
    assert.equal(workflow.customerStatus, 'completed');
    assert.equal((await repos.calls.findById(client.id, call.id)).outcome, 'completed');

    await createSupervisorEvent({
      repositories: repos,
      clientId: client.id,
      callId: call.id,
      eventType: 'service_event',
      payload: { safe: true }
    });
    assert.equal((await repos.supervisorEvents.listForCall(client.id, call.id)).length, 1);
  });
});

test('all call-domain tenant methods reject missing client context before SQL', async () => {
  let queries = 0;
  const database = {
    query() {
      queries += 1;
      throw new Error('SQL must not run');
    },
    transaction() {
      queries += 1;
      throw new Error('transaction must not run');
    }
  };
  const { createCallsRepository } = require('../../repositories/calls');
  const { createFeedbackRepository } = require('../../repositories/feedback');
  const { createSupervisorEventsRepository } = require('../../repositories/supervisor-events');
  const calls = createCallsRepository(database);
  const feedback = createFeedbackRepository(database);
  const events = createSupervisorEventsRepository(database);

  const operations = [
    () => calls.create(null, { customer_id: 1 }),
    () => calls.createAndMarkCustomer(undefined, { customer_id: 1 }),
    () => calls.findById(0, 1),
    () => calls.findByTwilioSid('', 'CA1'),
    () => calls.update(null, 1, {}),
    () => calls.updateByTwilioSid(undefined, 'CA1', {}),
    () => calls.listRecent(null),
    () => calls.listForCustomer(0, 1),
    () => feedback.create(null, { customer_id: 1 }),
    () => feedback.upsertForCall(undefined, { customer_id: 1, call_id: 1 }),
    () => feedback.findByCallId(0, 1),
    () => feedback.list(null),
    () => events.append(undefined, { call_id: 1, event_type: 'test' }),
    () => events.listForCall(0, 1)
  ];
  for (const operation of operations) {
    await assert.rejects(operation, (error) => error.code === 'CLIENT_ID_REQUIRED');
  }
  assert.equal(queries, 0);
});
