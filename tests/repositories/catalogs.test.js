const assert = require('node:assert/strict');
const test = require('node:test');
const { withTransaction } = require('../../persistence/postgres');
const { createRepositories } = require('../../repositories');
const { hasHostedTestDatabase, withTestDatabase } = require('../helpers/postgres-test-context');

const databaseTest = hasHostedTestDatabase() ? test : test.skip;

function repositories(pool) {
  return createRepositories({
    query: pool.query.bind(pool),
    transaction: (work) => withTransaction(pool, work)
  });
}

databaseTest('catalog repositories isolate clients and preserve numeric API fields', async () => {
  await withTestDatabase(async ({ pool }) => {
    const repos = repositories(pool);
    const first = await repos.clients.create({ name: 'Catalog One', slug: 'catalog-one' });
    const second = await repos.clients.create({ name: 'Catalog Two', slug: 'catalog-two' });
    const customer = await repos.customers.create(first.id, { name: 'Catalog Customer', phone: '+199900001' });

    const agent = await repos.agents.create(first.id, {
      name: 'Hindi Agent', provider: 'openai', model: 'realtime', voice: 'coral',
      language: 'hi', prompt_version: 'v1', api_key: 'must-not-be-stored'
    });
    assert.equal(typeof agent.id, 'number');
    assert.equal(agent.client_id, first.id);
    assert.equal(agent.api_key, undefined);
    assert.equal(await repos.agents.findById(second.id, agent.id), null);
    assert.equal((await repos.agents.list(first.id))[0].name, 'Hindi Agent');

    const campaign = await repos.campaignConfigurations.create(first.id, {
      agent_id: agent.id,
      name: 'August Campaign',
      status: 'active',
      schedule_policy: { timezone: 'Asia/Kolkata' },
      retry_policy: { attempts: 2 },
      script_version: 'v1'
    });
    assert.deepEqual(campaign.schedule_policy, { timezone: 'Asia/Kolkata' });
    assert.equal((await repos.campaignConfigurations.list(first.id)).length, 1);
    await assert.rejects(
      repos.campaignConfigurations.create(second.id, { agent_id: agent.id, name: 'Cross tenant' }),
      (error) => error.code === '23503'
    );

    const ticket = await repos.supportTickets.create(first.id, {
      customer_id: customer.id,
      title: 'Call back requested',
      description: 'Tomorrow afternoon',
      priority: 'high'
    });
    assert.equal(ticket.customer_id, customer.id);
    assert.equal(await repos.supportTickets.findById(second.id, ticket.id), null);
    assert.equal((await repos.supportTickets.list(first.id, { status: 'open' }))[0].title, 'Call back requested');
    await assert.rejects(
      repos.supportTickets.create(second.id, { customer_id: customer.id, title: 'Cross tenant' }),
      (error) => error.code === '23503'
    );

    const columns = await pool.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = any($1::text[])`,
      [['agents', 'campaign_configurations', 'support_tickets']]
    );
    const columnNames = columns.rows.map((row) => row.column_name);
    assert.equal(columnNames.some((name) => /secret|token|api_key|password/i.test(name)), false);
  });
});

databaseTest('application state supports global and tenant CAS updates', async () => {
  await withTestDatabase(async ({ pool }) => {
    const repos = repositories(pool);
    const first = await repos.clients.create({ name: 'State One', slug: 'state-one' });
    const second = await repos.clients.create({ name: 'State Two', slug: 'state-two' });

    assert.deepEqual(await repos.applicationState.set(null, 'scheduler', { enabled: true }), {
      client_id: null, key: 'scheduler', value: { enabled: true }, version: 1
    });
    assert.deepEqual(await repos.applicationState.set(first.id, 'scheduler', { enabled: false }), {
      client_id: first.id, key: 'scheduler', value: { enabled: false }, version: 1
    });
    const updated = await repos.applicationState.set(first.id, 'scheduler', { enabled: true }, 1);
    assert.equal(updated.version, 2);
    await assert.rejects(
      repos.applicationState.set(first.id, 'scheduler', { enabled: false }, 1),
      (error) => error.code === 'STATE_VERSION_CONFLICT'
    );
    assert.equal(await repos.applicationState.get(second.id, 'scheduler'), null);
    assert.equal((await repos.applicationState.get(null, 'scheduler')).version, 1);
  });
});

test('catalog tenant methods reject a missing client before SQL', async () => {
  let queries = 0;
  const database = { async query() { queries += 1; throw new Error('unexpected'); } };
  const { createAgentsRepository } = require('../../repositories/agents');
  const { createCampaignConfigurationsRepository } = require('../../repositories/campaign-configurations');
  const { createSupportTicketsRepository } = require('../../repositories/support-tickets');
  const methods = [
    createAgentsRepository(database).list(null),
    createCampaignConfigurationsRepository(database).findById(undefined, 1),
    createSupportTicketsRepository(database).create(null, { title: 'x' })
  ];
  for (const operation of methods) await assert.rejects(operation, /clientId is required/);
  assert.equal(queries, 0);
});
