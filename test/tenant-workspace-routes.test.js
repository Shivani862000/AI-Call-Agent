'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { PROTECTED_HTML_PATHS } = require('../src/auth');
const { isAdminOnlyRequest } = require('../src/authorization');
const {
  TENANT_WORKSPACE_ROUTES,
  createTenantWorkspaceDispatcher
} = require('../src/tenant-workspace-routes');

test('tenant workspace dispatcher serves the shell while embedded requests receive their legacy page', () => {
  const sentFiles = [];
  const dispatcher = createTenantWorkspaceDispatcher({ publicDirectory: '/workspace/public' });
  const response = { sendFile(file) { sentFiles.push(file); } };

  dispatcher({ path: '/customers.html', query: {} }, response, assert.fail);
  dispatcher({ path: '/customers.html', query: { embedded: '1' } }, response, assert.fail);

  assert.deepEqual(sentFiles, [
    path.join('/workspace/public', 'tenant-workspace.html'),
    path.join('/workspace/public', 'customers.html')
  ]);
});

test('workspace dispatch leaves unknown paths alone and excludes Webmaster', () => {
  let nextCalled = false;
  const dispatcher = createTenantWorkspaceDispatcher({ publicDirectory: '/workspace/public' });
  dispatcher(
    { path: '/webmaster.html', query: { embedded: '1' } },
    { sendFile: assert.fail },
    () => { nextCalled = true; }
  );

  assert.equal(nextCalled, true);
  assert.equal(TENANT_WORKSPACE_ROUTES.has('/webmaster.html'), false);
});

test('customer list is protected and users stays administrator-only for embedded requests', () => {
  assert.equal(PROTECTED_HTML_PATHS.has('/customer-list.html'), true);
  assert.equal(isAdminOnlyRequest({ method: 'GET', path: '/users.html', query: { embedded: '1' } }), true);
});
