const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  hasHostedTestDatabase,
  withTestDatabase
} = require('../helpers/postgres-test-context');

const databaseTest = hasHostedTestDatabase() ? test : test.skip;

const REQUIRED_TABLES = [
  'agents',
  'app_user_roles',
  'app_users',
  'application_state',
  'call_supervisor_events',
  'calls',
  'campaign_configurations',
  'clients',
  'customers',
  'feedback',
  'support_tickets'
];

async function createClient(pool, slug) {
  const result = await pool.query(
    `insert into clients (slug, name, timezone)
     values ($1, $2, 'Asia/Kolkata')
     returning id`,
    [slug, `${slug} name`]
  );
  return result.rows[0].id;
}

async function createCustomer(pool, clientId, phone) {
  const result = await pool.query(
    `insert into customers (client_id, name, phone)
     values ($1, 'Test Customer', $2)
     returning id`,
    [clientId, phone]
  );
  return result.rows[0].id;
}

databaseTest('migration creates every approved application table with RLS enabled', async () => {
  await withTestDatabase(async ({ pool }) => {
    const tables = await pool.query(
      `select c.relname as table_name, c.relrowsecurity as rls_enabled
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname = any($1::text[])
        order by c.relname`,
      [REQUIRED_TABLES]
    );

    assert.deepEqual(tables.rows.map((row) => row.table_name), REQUIRED_TABLES);
    assert.equal(tables.rows.every((row) => row.rls_enabled), true);
  });
});

databaseTest('public Data API roles have no application-table access while runtime role is bounded', async () => {
  await withTestDatabase(async ({ pool }) => {
    const privileges = await pool.query(
      `select
         has_table_privilege('anon', 'public.customers', 'select') as anon_select,
         has_table_privilege('authenticated', 'public.customers', 'select') as authenticated_select,
         has_table_privilege('service_role', 'public.customers', 'select') as service_select,
         has_table_privilege('ai_call_agent_runtime', 'public.customers', 'select') as runtime_select,
         has_table_privilege('ai_call_agent_runtime', 'public.customers', 'insert') as runtime_insert,
         r.rolcanlogin as runtime_can_login,
         r.rolsuper as runtime_superuser,
         r.rolbypassrls as runtime_bypass_rls
       from pg_roles r
       where r.rolname = 'ai_call_agent_runtime'`
    );

    assert.deepEqual(privileges.rows[0], {
      anon_select: false,
      authenticated_select: false,
      service_select: false,
      runtime_select: true,
      runtime_insert: true,
      runtime_can_login: false,
      runtime_superuser: false,
      runtime_bypass_rls: false
    });
  });
});

databaseTest('customer phone uniqueness is tenant-scoped and IDs are generated', async () => {
  await withTestDatabase(async ({ pool }) => {
    const firstClient = await createClient(pool, 'first-client');
    const secondClient = await createClient(pool, 'second-client');
    const firstCustomer = await createCustomer(pool, firstClient, '+919876543210');
    const secondCustomer = await createCustomer(pool, secondClient, '+919876543210');

    assert.equal(typeof firstClient, 'string');
    assert.equal(typeof firstCustomer, 'string');
    assert.notEqual(firstCustomer, secondCustomer);

    await assert.rejects(
      createCustomer(pool, firstClient, '+919876543210'),
      (error) => error.code === '23505' && error.constraint === 'customers_client_phone_unique'
    );
  });
});

databaseTest('composite foreign keys reject cross-client call relationships', async () => {
  await withTestDatabase(async ({ pool }) => {
    const firstClient = await createClient(pool, 'first-client');
    const secondClient = await createClient(pool, 'second-client');
    const firstCustomer = await createCustomer(pool, firstClient, '+919876543210');

    await assert.rejects(
      pool.query(
        `insert into calls (client_id, customer_id, outcome)
         values ($1, $2, 'initiated')`,
        [secondClient, firstCustomer]
      ),
      (error) => error.code === '23503' && error.constraint === 'calls_client_customer_fk'
    );
  });
});

databaseTest('provider and feedback idempotency constraints reject duplicates', async () => {
  await withTestDatabase(async ({ pool }) => {
    const clientId = await createClient(pool, 'idempotency-client');
    const customerId = await createCustomer(pool, clientId, '+919876543210');
    const call = await pool.query(
      `insert into calls (client_id, customer_id, twilio_sid, outcome)
       values ($1, $2, 'CA00000000000000000000000000000001', 'initiated')
       returning id`,
      [clientId, customerId]
    );

    await assert.rejects(
      pool.query(
        `insert into calls (client_id, customer_id, twilio_sid, outcome)
         values ($1, $2, 'CA00000000000000000000000000000001', 'initiated')`,
        [clientId, customerId]
      ),
      (error) => error.code === '23505' && error.constraint === 'calls_twilio_sid_unique'
    );

    await pool.query(
      `insert into feedback (client_id, customer_id, call_id, review_text, category, stars)
       values ($1, $2, $3, 'Helpful service', 'good', 5)`,
      [clientId, customerId, call.rows[0].id]
    );
    await assert.rejects(
      pool.query(
        `insert into feedback (client_id, customer_id, call_id, review_text, category, stars)
         values ($1, $2, $3, 'Repeated feedback', 'good', 5)`,
        [clientId, customerId, call.rows[0].id]
      ),
      (error) => error.code === '23505' && error.constraint === 'feedback_call_id_unique'
    );
  });
});

databaseTest('application state permits one global and one tenant value per key', async () => {
  await withTestDatabase(async ({ pool }) => {
    const clientId = await createClient(pool, 'state-client');
    await pool.query(
      `insert into application_state (client_id, key, value)
       values (null, 'scheduler', '{"enabled":true}'),
              ($1, 'scheduler', '{"enabled":false}')`,
      [clientId]
    );

    await assert.rejects(
      pool.query(
        `insert into application_state (client_id, key, value)
         values (null, 'scheduler', '{}')`
      ),
      (error) => error.code === '23505' && error.constraint === 'application_state_scope_key_unique'
    );
  });
});

databaseTest('deleting an agent clears only the campaign agent reference', async () => {
  await withTestDatabase(async ({ pool }) => {
    const clientId = await createClient(pool, 'campaign-client');
    const agent = await pool.query(
      `insert into agents (client_id, name)
       values ($1, 'Test Agent')
       returning id`,
      [clientId]
    );
    const campaign = await pool.query(
      `insert into campaign_configurations (client_id, agent_id, name)
       values ($1, $2, 'Test Campaign')
       returning id`,
      [clientId, agent.rows[0].id]
    );

    await pool.query('delete from agents where id = $1', [agent.rows[0].id]);

    const retained = await pool.query(
      'select client_id, agent_id from campaign_configurations where id = $1',
      [campaign.rows[0].id]
    );
    assert.deepEqual(retained.rows[0], { client_id: clientId, agent_id: null });
  });
});

databaseTest('deleting a call clears only the support ticket call reference', async () => {
  await withTestDatabase(async ({ pool }) => {
    const clientId = await createClient(pool, 'ticket-client');
    const customerId = await createCustomer(pool, clientId, '+919876543211');
    const call = await pool.query(
      `insert into calls (client_id, customer_id, outcome)
       values ($1, $2, 'initiated')
       returning id`,
      [clientId, customerId]
    );
    const ticket = await pool.query(
      `insert into support_tickets (client_id, customer_id, call_id, title)
       values ($1, $2, $3, 'Follow up')
       returning id`,
      [clientId, customerId, call.rows[0].id]
    );

    await pool.query('delete from calls where id = $1', [call.rows[0].id]);

    const retained = await pool.query(
      `select client_id, customer_id, call_id
         from support_tickets
        where id = $1`,
      [ticket.rows[0].id]
    );
    assert.deepEqual(retained.rows[0], {
      client_id: clientId,
      customer_id: customerId,
      call_id: null
    });
  });
});
