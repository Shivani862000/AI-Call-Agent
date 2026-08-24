'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWebmasterAuthorization } = require('../src/webmaster/authorization');

test('environment webmaster resolves as owner and support is rejected', async () => {
  const auth = createWebmasterAuthorization({
    UserModel: { findOne: async () => null },
    TenantModel: {},
    env: { ADMIN_USERNAME: 'root' }
  });

  const actor = await auth.resolveActor({ username: 'root', role: 'WEBMASTER' });
  assert.equal(actor.username, 'root');
  assert.equal(actor.role, 'WEBMASTER');
  assert.equal(actor.platformAccessLevel, 'OWNER');
  assert.equal(actor.source, 'environment');

  await assert.rejects(
    auth.resolveActor({ username: 'support', role: 'SUPPORT_TEAM' }),
    (error) => error.code === 'WEBMASTER_FORBIDDEN'
  );
});

test('database webmaster must be active and assigned owner or admin access', async () => {
  const UserModel = {
    findOne: () => ({
      lean: async () => ({
        username: 'wm',
        role: 'WEBMASTER',
        status: 'suspended',
        platformAccessLevel: 'ADMIN'
      })
    })
  };
  const auth = createWebmasterAuthorization({ UserModel, TenantModel: {}, env: {} });

  await assert.rejects(
    auth.resolveActor({ username: 'wm', role: 'WEBMASTER' }),
    (error) => error.code === 'ACCOUNT_INACTIVE'
  );
});

test('database webmaster resolves only with owner or admin access', async () => {
  const UserModel = {
    findOne: () => ({
      lean: async () => ({
        _id: 'user-id',
        username: 'wm',
        role: 'WEBMASTER',
        status: 'active',
        platformAccessLevel: null
      })
    })
  };
  const auth = createWebmasterAuthorization({ UserModel, TenantModel: {}, env: {} });

  await assert.rejects(
    auth.resolveActor({ username: 'wm', role: 'WEBMASTER' }),
    (error) => error.code === 'WEBMASTER_ACCESS_UNASSIGNED'
  );
});
