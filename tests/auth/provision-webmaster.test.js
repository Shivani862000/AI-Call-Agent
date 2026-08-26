const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { withTransaction } = require('../../persistence/postgres');
const { hasHostedTestDatabase, withTestDatabase } = require('../helpers/postgres-test-context');

const { parseProvisionArgs, provisionWebmaster } = require('../../scripts/provision-webmaster');
const databaseTest = hasHostedTestDatabase() ? test : test.skip;

function fixture() {
  const profiles = [];
  const roles = [];
  const deleted = [];
  let sequence = 0;
  const adminAuth = {
    async createUser({ email, password }) {
      assert.match(email, /@/);
      assert.ok(password.length >= 12);
      sequence += 1;
      return { id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}` };
    },
    async deleteUser(id) { deleted.push(id); }
  };
  const database = {
    async query(text, values) {
      if (/select .*app_users/i.test(text)) {
        return { rows: profiles.filter((profile) => profile.username_normalized === values[0] || profile.email_normalized === values[1]) };
      }
      throw new Error('Unexpected preflight query');
    },
    async transaction(work) {
      const client = {
        async query(text, values) {
          if (/insert into app_users/i.test(text)) {
            const row = {
              id: values[0], username: values[1], username_normalized: values[2],
              email: values[3], email_normalized: values[4], active: true
            };
            profiles.push(row);
            return { rows: [row], rowCount: 1 };
          }
          if (/insert into app_user_roles/i.test(text)) {
            roles.push({ user_id: values[0], role: values[1] });
            return { rows: [], rowCount: 1 };
          }
          throw new Error('Unexpected transaction query');
        }
      };
      return work(client);
    }
  };
  return { adminAuth, database, profiles, roles, deleted };
}

test('provisioning creates multiple normalized webmasters without storing passwords', async () => {
  const state = fixture();
  const first = await provisionWebmaster({
    adminAuth: state.adminAuth, database: state.database,
    username: ' First.Admin ', email: 'FIRST@EXAMPLE.COM ', password: 'first-password-123'
  });
  const second = await provisionWebmaster({
    adminAuth: state.adminAuth, database: state.database,
    username: 'Second.Admin', email: 'second@example.com', password: 'second-password-123'
  });
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first, { id: first.id, username: 'First.Admin' });
  assert.equal(state.roles.filter((role) => role.role === 'webmaster').length, 2);
  assert.equal(state.profiles.some((profile) => 'password' in profile || 'password_hash' in profile), false);
  assert.equal(JSON.stringify(first).includes('first-password'), false);
});

test('provisioning validates credentials, rejects duplicates, and compensates Auth creation', async () => {
  const state = fixture();
  await assert.rejects(
    provisionWebmaster({ adminAuth: state.adminAuth, database: state.database, username: 'admin', email: 'admin@example.com', password: 'too-short' }),
    /at least 12 characters/
  );
  await provisionWebmaster({ adminAuth: state.adminAuth, database: state.database, username: 'Admin', email: 'admin@example.com', password: 'valid-password-123' });
  await assert.rejects(
    provisionWebmaster({ adminAuth: state.adminAuth, database: state.database, username: ' admin ', email: 'different@example.com', password: 'valid-password-456' }),
    (error) => error.code === 'WEBMASTER_EXISTS'
  );

  const failing = fixture();
  failing.database.transaction = async () => { throw new Error('profile failed'); };
  await assert.rejects(
    provisionWebmaster({ adminAuth: failing.adminAuth, database: failing.database, username: 'admin', email: 'admin@example.com', password: 'valid-password-123' }),
    /profile failed/
  );
  assert.equal(failing.deleted.length, 1);
});

test('CLI parsing requires username/email and rejects password arguments', () => {
  assert.deepEqual(parseProvisionArgs(['--username', 'admin', '--email', 'admin@example.com']), {
    username: 'admin', email: 'admin@example.com'
  });
  assert.throws(() => parseProvisionArgs(['--username', 'admin', '--email', 'a@b.com', '--password', 'secret']), /Password flags are not allowed/);
  assert.throws(() => parseProvisionArgs(['--username', 'admin']), /--email is required/);
});

databaseTest('hosted Postgres accepts two independent active webmaster profiles', async () => {
  await withTestDatabase(async ({ pool }) => {
    const authIds = [];
    const adminAuth = {
      async createUser({ email }) {
        const id = randomUUID();
        authIds.push(id);
        await pool.query(
          `insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
           values ($1, 'authenticated', 'authenticated', $2, now(), now(), now())`,
          [id, email]
        );
        return { id };
      },
      async deleteUser(id) { await pool.query('delete from auth.users where id = $1', [id]); }
    };
    const database = {
      query: pool.query.bind(pool),
      transaction: (work) => withTransaction(pool, work)
    };
    try {
      const first = await provisionWebmaster({ adminAuth, database, username: 'hosted-one', email: 'hosted-one@example.test', password: 'hosted-password-one' });
      const second = await provisionWebmaster({ adminAuth, database, username: 'hosted-two', email: 'hosted-two@example.test', password: 'hosted-password-two' });
      assert.notEqual(first.id, second.id);
      const count = await pool.query(
        `select count(*) as total from app_users u join app_user_roles r on r.user_id = u.id
          where u.active and r.role = 'webmaster'`
      );
      assert.equal(Number(count.rows[0].total), 2);
    } finally {
      await pool.query('delete from auth.users where id = any($1::uuid[])', [authIds]);
    }
  });
});
