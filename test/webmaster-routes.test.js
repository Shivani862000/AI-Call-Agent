'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createDashboardService } = require('../src/webmaster/dashboard-service');

test('dashboard returns aggregate lifecycle counts and safe attention items', async () => {
  const count = filter => filter.status === 'active' ? 3 : filter.status === 'suspended' ? 1 : 0;
  const service = createDashboardService({ TenantModel: { countDocuments: async filter => count(filter) }, UserModel: { countDocuments: async filter => count(filter) }, CallModel: { countDocuments: async filter => filter.status === 'failed' ? 2 : 20 }, NotificationModel: { countDocuments: async () => 1 }, integrationStatus: async () => [{ id: 'smtp', configured: false }], recentAudit: async () => [] });
  const dashboard = await service.get();
  assert.equal(dashboard.tenants.active, 3);
  assert.equal(dashboard.usage.calls, 20);
  assert.equal(dashboard.attentionItems.length, 2);
  assert.deepEqual(Object.keys(dashboard), ['tenants', 'users', 'usage', 'health', 'integrations', 'recentAudit', 'attentionItems']);
});

test('webmaster router exposes required sections without delete or data transfer routes', () => {
  const root = path.join(__dirname, '../routes/webmaster');
  const source = fs.readdirSync(root).filter(file => file.endsWith('.js')).map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  for (const token of ['/dashboard', '/tenants', '/platform-users', '/settings', '/integrations', '/audit-events', '/notification-deliveries']) assert.match(source, new RegExp(token.replace('/', '\\/')));
  assert.doesNotMatch(source, /router\.delete|\.delete\s*\(/i);
  assert.doesNotMatch(source, /\/export|\/csv/i);
  assert.match(source, /notification-deliveries\/:id\/retry/);
  assert.match(source, /secret\.replace/);
});
