'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWebmasterAuthorization } = require('../src/webmaster/authorization');

function supabaseReturning(result) {
  return {
    from(table) {
      assert.equal(table, 'users');
      return {
        select(columns) {
          assert.equal(columns, '*');
          return {
            eq(column, value) {
              assert.equal(column, 'username');
              assert.ok(value);
              return {
                maybeSingle: async () => ({
                  data: result.data,
                  error: result.error || null,
                  count: null,
                  status: result.error ? 500 : 200,
                  statusText: result.error ? 'Internal Server Error' : 'OK'
                })
              };
            }
          };
        }
      };
    }
  };
}

test('database Webmaster resolves from Supabase snake_case fields', async () => {
  const auth = createWebmasterAuthorization({
    supabaseClient: supabaseReturning({
      data: {
        id: 'user-id',
        username: 'webmaster@vikitech.in',
        role: 'WEBMASTER',
        status: 'active',
        platform_access_level: 'OWNER'
      }
    })
  });

  const actor = await auth.resolveActor({
    username: 'webmaster@vikitech.in',
    role: 'WEBMASTER',
    authSource: 'database'
  });

  assert.deepEqual(actor, {
    id: 'user-id',
    username: 'webmaster@vikitech.in',
    role: 'WEBMASTER',
    platformAccessLevel: 'OWNER',
    source: 'database'
  });
});

test('database Webmaster must be active', async () => {
  const auth = createWebmasterAuthorization({
    supabaseClient: supabaseReturning({
      data: {
        id: 'user-id',
        username: 'webmaster@vikitech.in',
        role: 'WEBMASTER',
        status: 'suspended',
        platform_access_level: 'ADMIN'
      }
    })
  });

  await assert.rejects(
    auth.resolveActor({ username: 'webmaster@vikitech.in', role: 'WEBMASTER', authSource: 'database' }),
    (error) => error.code === 'ACCOUNT_INACTIVE'
  );
});

test('database Webmaster requires owner or admin platform access', async () => {
  const auth = createWebmasterAuthorization({
    supabaseClient: supabaseReturning({
      data: {
        id: 'user-id',
        username: 'webmaster@vikitech.in',
        role: 'WEBMASTER',
        status: 'active',
        platform_access_level: null
      }
    })
  });

  await assert.rejects(
    auth.resolveActor({ username: 'webmaster@vikitech.in', role: 'WEBMASTER', authSource: 'database' }),
    (error) => error.code === 'WEBMASTER_ACCESS_UNASSIGNED'
  );
});

test('database lookup errors fail closed', async () => {
  const auth = createWebmasterAuthorization({
    supabaseClient: supabaseReturning({ data: null, error: new Error('database unavailable') })
  });

  await assert.rejects(
    auth.resolveActor({ username: 'webmaster@vikitech.in', role: 'WEBMASTER', authSource: 'database' }),
    (error) => error.code === 'WEBMASTER_FORBIDDEN'
  );
});
