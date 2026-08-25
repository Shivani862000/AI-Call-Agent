'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createUserService, toSafeUser } = require('../src/webmaster/user-service');

function query(value) { return { lean: async () => value, sort() { return this; }, skip() { return this; }, limit() { return this; } }; }

test('safe user DTO never contains credentials', () => {
  const dto = toSafeUser({ _id: 'u1', username: 'agent', email: 'a@example.test', password_hash: 'hash', password: 'plain', role: 'CLIENT_AGENT', __v: 2 });
  assert.equal(dto.id, 'u1');
  assert.equal(dto.version, 2);
  assert.equal('password' in dto, false);
  assert.equal(Object.keys(dto).some(key => key.includes('hash')), false);
});

test('tenant user creation identifies the duplicated MongoDB identity field', async () => {
  const service = createUserService({
    UserModel: {
      async create() {
        const error = new Error('duplicate key');
        error.code = 11000;
        error.keyPattern = { email: 1 };
        throw error;
      }
    },
    passwordPolicy: async () => ({ minLength: 8, maxLength: 128 })
  });

  await assert.rejects(
    service.createTenantUser('tenant-1', {
      username: 'new-agent',
      email: 'existing@example.test',
      password: 'long-enough-password',
      role: 'CLIENT_AGENT'
    }, { username: 'tenant-admin' }),
    error => error.code === 'USER_IDENTITY_CONFLICT'
      && error.fieldErrors.email === 'This email is already in use'
      && !Object.hasOwn(error.fieldErrors, 'identity')
  );
});

test('last active tenant administrator cannot be archived while tenant is active', async () => {
  const service = createUserService({ UserModel: { findOne: () => query({ _id: 'u1', tenantId: 't1', role: 'CLIENT_ADMIN', status: 'active', __v: 1 }), countDocuments: async () => 1 }, TenantModel: { findById: () => query({ status: 'active' }) } });
  await assert.rejects(service.transitionTenantUser('t1', 'u1', 'archive', 1, { username: 'owner' }), error => error.code === 'LAST_TENANT_ADMIN_REQUIRED');
});

test('last active tenant administrator cannot be downgraded while tenant is active', async () => {
  const service = createUserService({ UserModel: { findOne: () => query({ _id: 'u1', tenantId: 't1', role: 'CLIENT_ADMIN', status: 'active', __v: 1 }), countDocuments: async () => 1 }, TenantModel: { findById: () => query({ status: 'active' }) } });
  await assert.rejects(service.updateTenantUser('t1', 'u1', { username: 'admin', email: 'admin@example.test', role: 'CLIENT_AGENT' }, 1, { username: 'owner' }), error => error.code === 'LAST_TENANT_ADMIN_REQUIRED');
});

test('last active owner cannot be archived', async () => {
  const service = createUserService({ UserModel: { findOne: () => query({ _id: 'o1', role: 'WEBMASTER', platformAccessLevel: 'OWNER', status: 'active', __v: 1 }), countDocuments: async () => 1 } });
  await assert.rejects(service.transitionPlatformUser('o1', 'archive', 1, { username: 'owner', platformAccessLevel: 'OWNER' }), error => error.code === 'LAST_OWNER_REQUIRED');
});

test('webmaster admin is rejected before platform target lookup', async () => {
  let reads = 0;
  const service = createUserService({ UserModel: { findOne() { reads += 1; return query(null); } } });
  await assert.rejects(service.transitionPlatformUser('x', 'suspend', 1, { platformAccessLevel: 'ADMIN' }), error => error.code === 'WEBMASTER_OWNER_REQUIRED');
  assert.equal(reads, 0);
});

test('platform account creation and ownership transfer emit audit events', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/webmaster/user-service.js'), 'utf8');
  assert.match(source, /platform-user\.create/);
  assert.match(source, /platform-user\.ownership-transfer/);
});

test('failed ownership transfer rolls back the promoted account', async () => {
  const state = { promote: 'ADMIN' };
  const queryUpdate = value => ({ lean: async () => value });
  const UserModel = {
    findOneAndUpdate(filter) {
      if (filter._id === 'new-owner') { state.promote = 'OWNER'; return queryUpdate({ _id: 'new-owner', username: 'next', role: 'WEBMASTER', platformAccessLevel: 'OWNER', status: 'active', __v: 2 }); }
      return queryUpdate(null);
    }
  };
  const session = {
    async withTransaction(work) { const snapshot = { ...state }; try { await work(); } catch (error) { Object.assign(state, snapshot); throw error; } },
    async endSession() {}
  };
  const service = createUserService({ UserModel, PlatformSettingsModel: { findOneAndUpdate: async () => ({}) }, startSession: async () => session });
  await assert.rejects(service.transferOwnership({ promoteUserId: 'new-owner', demoteUserId: 'old-owner', expectedPromoteVersion: 1, expectedDemoteVersion: 1 }, { id: 'old-owner', platformAccessLevel: 'OWNER', source: 'database' }), error => error.code === 'OWNERSHIP_TRANSFER_CONFLICT');
  assert.equal(state.promote, 'ADMIN');
});

test('platform password replacement scopes mutation to webmaster accounts', async () => {
  let filter;
  const service = createUserService({ UserModel: { findOneAndUpdate(value) { filter = value; return query({ _id: 'p1', role: 'WEBMASTER', __v: 1 }); } }, passwordPolicy: async () => ({ minLength: 8, maxLength: 128 }) });
  await service.replacePassword('p1', 'long-enough-password', 0, { platformAccessLevel: 'OWNER' });
  assert.equal(filter.role, 'WEBMASTER');
});

test('tenant user role and search filters are applied before pagination', async () => {
  let filter;
  const service = createUserService({ UserModel: { find(value) { filter = value; return query([]); }, countDocuments: async () => 0 } });
  await service.listTenantUsers('t1', { role: 'CLIENT_AGENT', search: 'agent.*', page: 2, pageSize: 25 });
  assert.equal(filter.role, 'CLIENT_AGENT');
  assert.equal(filter.$or[0].username.$regex, 'agent\\.\\*');
});

test('tenant administrator cannot demote their own account', async () => {
  let updates = 0;
  const service = createUserService({
    UserModel: {
      findOne: () => query({ _id: 'self', username: 'admin', tenantId: 't1', role: 'CLIENT_ADMIN', status: 'active', __v: 1 }),
      findOneAndUpdate() { updates += 1; return query(null); }
    }
  });

  await assert.rejects(
    service.updateTenantUser('t1', 'self', { username: 'admin', email: 'admin@example.test', role: 'CLIENT_AGENT' }, 1, { username: 'admin' }),
    error => error.code === 'SELF_ROLE_CHANGE_FORBIDDEN' && error.status === 403
  );
  assert.equal(updates, 0);
});

test('tenant administrator cannot suspend or archive their own account', async () => {
  let updates = 0;
  const service = createUserService({
    UserModel: {
      findOne: () => query({ _id: 'self', username: 'admin', tenantId: 't1', role: 'CLIENT_ADMIN', status: 'active', __v: 1 }),
      findOneAndUpdate() { updates += 1; return query(null); }
    }
  });

  for (const transition of ['suspend', 'archive']) {
    await assert.rejects(
      service.transitionTenantUser('t1', 'self', transition, 1, { username: 'admin' }),
      error => error.code === 'SELF_STATUS_CHANGE_FORBIDDEN' && error.status === 403
    );
  }
  assert.equal(updates, 0);
});

test('tenant administrator cannot reset their own password through user management', async () => {
  let updates = 0;
  const service = createUserService({
    UserModel: {
      findOne: () => query({ _id: 'self', username: 'admin', tenantId: 't1', role: 'CLIENT_ADMIN', status: 'active', __v: 1 }),
      findOneAndUpdate() { updates += 1; return query(null); }
    },
    passwordPolicy: async () => ({ minLength: 8, maxLength: 128 })
  });

  await assert.rejects(
    service.replacePassword('self', 'long-enough-password', 1, { username: 'admin' }, 't1'),
    error => error.code === 'SELF_PASSWORD_CHANGE_FORBIDDEN' && error.status === 403
  );
  assert.equal(updates, 0);
});

test('tenant password reset hides users from other tenants', async () => {
  let updates = 0;
  const service = createUserService({
    UserModel: {
      findOne: () => query(null),
      findOneAndUpdate() { updates += 1; return query(null); }
    },
    passwordPolicy: async () => ({ minLength: 8, maxLength: 128 })
  });

  await assert.rejects(
    service.replacePassword('foreign-user', 'long-enough-password', 1, { username: 'admin' }, 't1'),
    error => error.code === 'USER_NOT_FOUND' && error.status === 404
  );
  assert.equal(updates, 0);
});
