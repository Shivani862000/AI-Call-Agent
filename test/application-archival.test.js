'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  archiveFields,
  activeRecordFilter,
  recordFilterFromRequest,
  activeOperationalFilter,
  createMongooseArchiveHandlers,
  createSqlArchiveHandlers
} = require('../src/webmaster/lifecycle');
const Customer = require('../src/models/Customer');
const Call = require('../src/models/Call');
const Agent = require('../src/models/Agent');
const Feedback = require('../src/models/Feedback');
const User = require('../src/models/User');
const Tenant = require('../src/models/Tenant');
const { isAdminOnlyRequest } = require('../src/authorization');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function matchesFilter(record, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = record[key];
    if (expected && typeof expected === 'object' && '$ne' in expected) {
      return actual !== expected.$ne;
    }
    return String(actual) === String(expected);
  });
}

function createMemoryModel(initialRecords) {
  const records = initialRecords.map((record) => ({ ...record }));
  return {
    records,
    async findOneAndUpdate(filter, update) {
      const record = records.find((candidate) => matchesFilter(candidate, filter));
      if (!record) return null;
      Object.assign(record, update.$set);
      return { ...record };
    },
    async updateMany(filter, update) {
      let modifiedCount = 0;
      for (const record of records) {
        if (!matchesFilter(record, filter)) continue;
        Object.assign(record, update.$set);
        modifiedCount += 1;
      }
      return { modifiedCount };
    }
  };
}

test('archive fields and active filters preserve the lifecycle contract', () => {
  // Mutation caught: omitting archive metadata or allowing archived records through active queries.
  const before = Date.now();
  const fields = archiveFields({ username: 'webmaster' }, '  retention request  ');

  assert.equal(fields.status, 'archived');
  assert.equal(fields.archived_by, 'webmaster');
  assert.equal(fields.archive_reason, 'retention request');
  assert.ok(fields.archived_at instanceof Date);
  assert.ok(fields.archived_at.getTime() >= before);
  assert.deepEqual(activeRecordFilter({ tenantId: 'tenant-a' }), {
    tenantId: 'tenant-a',
    status: { $ne: 'archived' }
  });
});

test('Mongoose archive handlers retain, scope, and restore records without exposing record data', async () => {
  // Mutation caught: deleting a document, dropping tenant scope, or returning its PII after archival.
  const Model = createMemoryModel([
    { _id: 'customer-1', tenantId: 'tenant-a', status: 'pending', phone: '+911111111111' },
    { _id: 'customer-1', tenantId: 'tenant-b', status: 'pending', phone: '+922222222222' }
  ]);
  const handlers = createMongooseArchiveHandlers({
    Model,
    resourceName: 'customer',
    restoreStatus: 'pending'
  });
  const request = {
    params: { id: 'customer-1' },
    tenantId: 'tenant-a',
    adminSession: { username: 'admin-a' },
    body: { reason: 'duplicate import' }
  };
  const archiveResponse = createResponse();

  await handlers.archive(request, archiveResponse);

  assert.equal(archiveResponse.statusCode, 200);
  assert.equal(Model.records.length, 2);
  assert.equal(Model.records[0].status, 'archived');
  assert.equal(Model.records[0].archived_by, 'admin-a');
  assert.equal(Model.records[1].status, 'pending');
  assert.deepEqual(Object.keys(archiveResponse.body.resource).sort(), [
    'archive_reason', 'archived_at', 'archived_by', 'id', 'status'
  ]);
  assert.equal('phone' in archiveResponse.body.resource, false);

  const restoreResponse = createResponse();
  await handlers.restore({ ...request, body: {} }, restoreResponse);

  assert.equal(restoreResponse.statusCode, 200);
  assert.equal(Model.records[0].status, 'pending');
  assert.equal(Model.records[0].archived_at, null);
  assert.equal(Model.records[1].status, 'pending');
});

test('SQL archive handlers retain, tenant-scope, and restore legacy records', async () => {
  // Mutation caught: issuing SQL DELETE, mutating another tenant, or making archived rows unrestorable.
  const rows = [
    { id: 7, tenant_id: 'tenant-a', status: 'active' },
    { id: 7, tenant_id: 'tenant-b', status: 'active' }
  ];
  const dbGet = async (_sql, params) => rows.find((row) => (
    String(row.id) === String(params[0]) && String(row.tenant_id) === String(params[1])
  )) || null;
  const dbRun = async (sql, params) => {
    const row = rows.find((candidate) => (
      String(candidate.id) === String(params.at(-2))
      && String(candidate.tenant_id) === String(params.at(-1))
    ));
    if (!row) return { changes: 0 };
    if (sql.includes("status = 'archived'")) {
      Object.assign(row, {
        status: 'archived',
        archived_at: params[0],
        archived_by: params[1],
        archive_reason: params[2]
      });
    } else {
      Object.assign(row, {
        status: params[0],
        archived_at: null,
        archived_by: null,
        archive_reason: null
      });
    }
    return { changes: 1 };
  };
  const handlers = createSqlArchiveHandlers({
    dbGet,
    dbRun,
    tableName: 'clients',
    resourceName: 'client',
    restoreStatus: 'active'
  });
  const request = {
    params: { id: 7 },
    tenantId: 'tenant-a',
    adminSession: { username: 'admin-a' },
    body: { reason: 'inactive account' }
  };
  const archiveResponse = createResponse();

  await handlers.archive(request, archiveResponse);

  assert.equal(archiveResponse.statusCode, 200);
  assert.equal(rows[0].status, 'archived');
  assert.equal(rows[1].status, 'active');
  assert.equal(archiveResponse.body.resource.archive_reason, 'inactive account');

  const restoreResponse = createResponse();
  await handlers.restore({ ...request, body: {} }, restoreResponse);

  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].archived_at, null);
  assert.equal(rows[1].status, 'active');
});

test('application record schemas retain archive metadata for recovery', () => {
  // Mutation caught: strict Mongoose schemas discard archive metadata and make recovery unauditable.
  for (const Model of [Customer, Call, Agent, Feedback, User, Tenant]) {
    assert.ok(Model.schema.path('status'), `${Model.modelName} status`);
    assert.ok(Model.schema.path('archived_at'), `${Model.modelName} archived_at`);
    assert.ok(Model.schema.path('archived_by'), `${Model.modelName} archived_by`);
    assert.ok(Model.schema.path('archive_reason'), `${Model.modelName} archive_reason`);
  }
});

test('bulk archive transitions only active records in the current tenant', async () => {
  // Mutation caught: bulk archival crosses tenant boundaries or rewrites already archived records.
  const Model = createMemoryModel([
    { _id: '1', tenantId: 'tenant-a', status: 'pending' },
    { _id: '2', tenantId: 'tenant-a', status: 'archived', archived_by: 'first-admin' },
    { _id: '3', tenantId: 'tenant-b', status: 'pending' }
  ]);
  const handlers = createMongooseArchiveHandlers({ Model, resourceName: 'customer' });
  const response = createResponse();

  await handlers.archiveBulk({
    tenantId: 'tenant-a',
    adminSession: { username: 'bulk-admin' },
    body: { reason: 'account closure' }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.archivedCount, 1);
  assert.equal(Model.records[0].status, 'archived');
  assert.equal(Model.records[0].archived_by, 'bulk-admin');
  assert.equal(Model.records[1].archived_by, 'first-admin');
  assert.equal(Model.records[2].status, 'pending');
});

test('archive, restore, and archived-record retrieval require administrator authorization', () => {
  // Mutation caught: compatibility POST actions or archive views bypass the destructive-action policy.
  const protectedRequests = [
    { method: 'POST', path: '/api/customers/42/archive', query: {} },
    { method: 'POST', path: '/api/customers/42/restore', query: {} },
    { method: 'POST', path: '/api/users/agents/42/archive', query: {} },
    { method: 'GET', path: '/api/customers', query: { status: 'archived' } },
    { method: 'GET', path: '/api/calls/recent', query: { status: 'archived' } }
  ];

  protectedRequests.forEach((request) => assert.equal(isAdminOnlyRequest(request), true));
});

test('active lists hide archived records unless an authorized caller explicitly requests them', () => {
  // Mutation caught: list and detail queries include archived rows by default or cannot retrieve them for recovery.
  assert.deepEqual(
    recordFilterFromRequest({ query: {} }, { tenantId: 'tenant-a' }),
    { tenantId: 'tenant-a', status: { $ne: 'archived' } }
  );
  assert.deepEqual(
    recordFilterFromRequest({ query: { status: 'archived' } }, { tenantId: 'tenant-a' }),
    { tenantId: 'tenant-a', status: 'archived' }
  );
  assert.deepEqual(
    activeOperationalFilter({ status: { $in: ['pending', 'scheduled'] } }),
    {
      $and: [
        { status: { $ne: 'archived' } },
        { status: { $in: ['pending', 'scheduled'] } }
      ]
    }
  );
});

test('customer browser action archives through the explicit endpoint and explains recovery', async () => {
  // Mutation caught: the UI calls compatibility DELETE or presents archival as irreversible deletion.
  const { createCustomerArchivalActions, ARCHIVE_CONFIRMATION } = require('../public/customer-archival');
  const confirmations = [];
  const requests = [];
  const alerts = [];
  let reloads = 0;
  const actions = createCustomerArchivalActions({
    confirmAction(message) {
      confirmations.push(message);
      return true;
    },
    async fetchJson(url, options) {
      requests.push({ url, options });
      return { message: 'customer archived successfully' };
    },
    showAlert(message) {
      alerts.push(message);
    },
    async reload() {
      reloads += 1;
    },
    apiBase: '/api'
  });

  await actions.archiveCustomer('customer-9');

  assert.deepEqual(confirmations, [ARCHIVE_CONFIRMATION]);
  assert.equal(ARCHIVE_CONFIRMATION, 'Archive this record? It will be retained and can be restored later.');
  assert.deepEqual(requests, [{
    url: '/api/customers/customer-9/archive',
    options: { method: 'POST' }
  }]);
  assert.deepEqual(alerts, ['customer archived successfully']);
  assert.equal(reloads, 1);
});
