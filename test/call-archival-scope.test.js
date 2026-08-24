'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyCallScope, tenantVisibleRows } = require('../src/legacy-call-scope');

test('legacy operational call scope requires a concrete tenant and excludes archived calls', () => {
  // Mutation caught: omitting either predicate exposes archived or cross-tenant call rows.
  assert.throws(() => createLegacyCallScope(), /tenant/i);
  assert.deepEqual(createLegacyCallScope('tenant-a'), {
    clause: "calls.tenant_id = ? AND calls.status <> 'archived'",
    params: ['tenant-a']
  });
});

test('explicit archived call scope remains tenant-bound', () => {
  // Mutation caught: archived retrieval skips authorization-derived tenant scope.
  assert.deepEqual(createLegacyCallScope('tenant-a', { archived: true }), {
    clause: "calls.tenant_id = ? AND calls.status = 'archived'",
    params: ['tenant-a']
  });
  assert.deepEqual(createLegacyCallScope('tenant-a', { alias: 'c' }), {
    clause: "c.tenant_id = ? AND c.status <> 'archived'",
    params: ['tenant-a']
  });
});

test('in-memory live and incoming state hides unscoped and cross-tenant rows', () => {
  // Mutation caught: merging the global live maps into a response leaks another tenant's calls.
  assert.deepEqual(tenantVisibleRows([
    { id: 'a', tenantId: 'tenant-a' },
    { id: 'b', tenantId: 'tenant-b' },
    { id: 'legacy-without-scope' }
  ], 'tenant-a'), [{ id: 'a', tenantId: 'tenant-a' }]);
  assert.throws(() => tenantVisibleRows([], null), /tenant/i);
});
