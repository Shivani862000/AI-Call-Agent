'use strict';

const express = require('express');
const { supabase } = require('../../src/supabase');
const { WebmasterError } = require('../../src/webmaster/errors');
const { createTenantService } = require('../../src/webmaster/tenant-service');
const { createUserService } = require('../../src/webmaster/user-service');
const { createAuditService } = require('../../src/webmaster/audit-service');
const { createDashboardService } = require('../../src/webmaster/dashboard-service');
const { createSettingsService } = require('../../src/webmaster/settings-service');
const { createSecretService } = require('../../src/webmaster/secret-service');
const { createNotificationService } = require('../../src/webmaster/notification-service');
const emailService = require('../../src/services/email-service');
const { INTEGRATION_DEFINITIONS, environmentKeyForSecret } = require('../../src/webmaster/settings-registry');

function pageInput(query = {}) { return { page: Math.max(1, Number(query.page) || 1), pageSize: Math.min(100, Math.max(1, Number(query.pageSize) || 25)), status: query.status ? String(query.status) : undefined, role: query.role ? String(query.role) : undefined, search: query.search ? String(query.search).slice(0, 100) : undefined }; }
function createWebmasterRouter({ authorization, services = {} } = {}) {
  if (!authorization) throw new TypeError('Webmaster authorization is required');
  const router = express.Router();
  const auditService = services.auditService || createAuditService();
  const secretService = services.secretService || createSecretService({ environmentKeyFor: (integration, key) => environmentKeyForSecret(integration, key, process.env) });
  const settingsService = services.settingsService || createSettingsService({ auditService, secretService });
  const passwordPolicy = async () => (await settingsService.getGlobal()).global?.policies?.password || {};
  const startSession = () => null;
  const tenantService = services.tenantService || createTenantService({ auditService, startSession, passwordPolicy, integrationStatus: async tenantId => integrationMetadata(secretService, settingsService, tenantId) });
  const userService = services.userService || createUserService({ auditService, startSession, passwordPolicy });
  const notificationService = services.notificationService || createNotificationService({ mailer: emailService, auditService, templateProvider: async ({ event, scope, tenantId }) => lifecycleTemplate(settingsService, event, scope, tenantId) });
  const dashboardService = services.dashboardService || createDashboardService({ integrationStatus: async () => integrationMetadata(secretService, settingsService), recentAudit: limit => readAudit({ page: 1, pageSize: limit }).then(result => result.items) });

  router.use(authorization.requireWebmaster);
  router.get('/dashboard', asyncRoute(async (_req, res) => res.json(await dashboardService.get())));
  router.get('/tenants', asyncRoute(async (req, res) => res.json(await tenantService.list(pageInput(req.query)))));
  router.post('/tenants', asyncRoute(async (req, res) => res.status(201).json(await tenantService.createWithAdmin(req.body, req.webmasterActor))));
  router.get('/tenants/:tenantId', asyncRoute(async (req, res) => res.json(await tenantService.get(req.params.tenantId))));
  router.patch('/tenants/:tenantId', asyncRoute(async (req, res) => res.json(await tenantService.update(req.params.tenantId, req.body.patch || req.body, req.body.expectedVersion, req.webmasterActor))));
  router.post('/tenants/:tenantId/lifecycle', asyncRoute(async (req, res) => {
    const tenant = await tenantService.transition(req.params.tenantId, req.body.transition, req.body.expectedVersion, req.webmasterActor, req.body.reason);
    const notification = await notifySafely(async () => { const { data: users } = await supabase.from('users').select('*').eq('tenant_id', req.params.tenantId).eq('role', 'CLIENT_ADMIN').eq('status', 'active'); return notificationService.sendLifecycle({ tenant, users: users || [], event: lifecycleEvent(req.body.transition), actor: req.webmasterActor }); });
    res.json({ ...tenant, ...notification });
  }));
  router.get('/tenants/:tenantId/operations', asyncRoute(async (req, res) => res.json(await tenantService.getOperationalSnapshot(req.params.tenantId))));
  router.get('/tenants/:tenantId/overrides', asyncRoute(async (req, res) => res.json(await settingsService.getEffectiveForTenant(req.params.tenantId))));
  router.put('/tenants/:tenantId/overrides', asyncRoute(async (req, res) => res.json(await settingsService.setTenantOverrides(req.params.tenantId, req.body.overrides || {}, req.body.expectedVersion, req.webmasterActor))));

  router.get('/tenants/:tenantId/users', asyncRoute(async (req, res) => res.json(await userService.listTenantUsers(req.params.tenantId, pageInput(req.query)))));
  router.post('/tenants/:tenantId/users', asyncRoute(async (req, res) => res.status(201).json(await userService.createTenantUser(req.params.tenantId, req.body, req.webmasterActor))));
  router.patch('/tenants/:tenantId/users/:userId', asyncRoute(async (req, res) => res.json(await userService.updateTenantUser(req.params.tenantId, req.params.userId, req.body.patch || req.body, req.body.expectedVersion, req.webmasterActor))));
  router.post('/tenants/:tenantId/users/:userId/password', asyncRoute(async (req, res) => res.json(await userService.replacePassword(req.params.userId, req.body.password, req.body.expectedVersion, req.webmasterActor, req.params.tenantId))));
  router.post('/tenants/:tenantId/users/:userId/lifecycle', asyncRoute(async (req, res) => {
    const user = await userService.transitionTenantUser(req.params.tenantId, req.params.userId, req.body.transition, req.body.expectedVersion, req.webmasterActor, req.body.reason);
    const notification = await notifySafely(async () => { const tenant = await tenantService.get(req.params.tenantId); return notificationService.sendLifecycle({ tenant, users: [user], event: lifecycleEvent(req.body.transition), actor: req.webmasterActor, scope: 'account' }); });
    res.json({ ...user, ...notification });
  }));

  router.get('/platform-users', authorization.requireOwner, asyncRoute(async (req, res) => res.json(await userService.listPlatformUsers(req.webmasterActor, pageInput(req.query)))));
  router.post('/platform-users', authorization.requireOwner, asyncRoute(async (req, res) => res.status(201).json(await userService.createWebmasterAdmin(req.body, req.webmasterActor))));
  router.patch('/platform-users/:userId', authorization.requireOwner, asyncRoute(async (req, res) => res.json(await userService.updatePlatformUser(req.params.userId, req.body.patch || req.body, req.body.expectedVersion, req.webmasterActor))));
  router.post('/platform-users/:userId/password', authorization.requireOwner, asyncRoute(async (req, res) => res.json(await userService.replacePassword(req.params.userId, req.body.password, req.body.expectedVersion, req.webmasterActor))));
  router.post('/platform-users/:userId/lifecycle', authorization.requireOwner, asyncRoute(async (req, res) => res.json(await userService.transitionPlatformUser(req.params.userId, req.body.transition, req.body.expectedVersion, req.webmasterActor, req.body.reason))));
  router.post('/platform-users/transfer-ownership', authorization.requireOwner, asyncRoute(async (req, res) => res.json(await userService.transferOwnership(req.body, req.webmasterActor))));

  router.get('/settings', asyncRoute(async (_req, res) => res.json(await settingsService.getGlobal())));
  router.patch('/settings/:section', asyncRoute(async (req, res) => res.json(await settingsService.updateSection(req.params.section, req.body.patch || {}, req.body.expectedVersion, req.webmasterActor))));
  router.get('/integrations', asyncRoute(async (_req, res) => res.json({ items: await integrationMetadata(secretService, settingsService) })));
  router.patch('/integrations/:id', asyncRoute(async (req, res) => res.json(await settingsService.updateSection('providers', { [req.params.id]: req.body.patch || {} }, req.body.expectedVersion, req.webmasterActor))));
  router.put('/integrations/:id/secrets/:key', authorization.requireOwner, asyncRoute(async (req, res) => {
    const result = await secretService.replaceSecret({ integration: req.params.id, key: req.params.key, value: req.body.value, actor: req.webmasterActor });
    await auditService.record({ actor: req.webmasterActor, action: 'secret.replace', target: { type: 'integration-secret', id: `${req.params.id}.${req.params.key}` }, after: { integration: req.params.id, key: req.params.key, configured: Boolean(result.configured) } });
    res.json(result);
  }));
  router.get('/audit-events', asyncRoute(async (req, res) => res.json(await readAudit(pageInput(req.query), req.query))));
  router.get('/notification-deliveries', asyncRoute(async (req, res) => res.json(await readNotifications(pageInput(req.query), req.query))));
  router.post('/notification-deliveries/:id/retry', asyncRoute(async (req, res) => res.json(await notificationService.retry(req.params.id, req.webmasterActor))));
  router.use((error, _req, res, _next) => { const safe = error instanceof WebmasterError ? error : new WebmasterError({ status: 500, code: 'WEBMASTER_INTERNAL_ERROR', message: 'The platform operation could not be completed' }); res.status(safe.status).json(safe.toResponse()); });
  return router;
}

function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
function lifecycleEvent(transition) { return transition === 'restore' ? 'restored' : transition === 'suspend' ? 'suspended' : 'archived'; }
async function notifySafely(operation) { try { return { notificationDeliveries: await operation() }; } catch (_error) { return { notificationDeliveries: [], notificationWarning: 'NOTIFICATION_DELIVERY_UNAVAILABLE' }; } }
async function lifecycleTemplate(settingsService, event, scope, tenantId) { const resolved = await settingsService.getEffectiveForTenant(tenantId); const prefix = scope === 'account' ? 'account' : 'tenant'; const suffix = event === 'suspended' ? 'Suspended' : event === 'restored' ? 'Restored' : 'Archived'; const template = resolved.effective?.notificationTemplates?.[`${prefix}${suffix}`] || {}; return { subject: template.subject || `${prefix === 'account' ? 'Account' : 'Tenant'} ${event}`, body: template.body || `Your ${prefix === 'account' ? 'user' : 'organization'} account is now ${event}.` }; }
async function integrationMetadata(secretService, settingsService, tenantId = null) { const settingsResult = tenantId ? await settingsService.getEffectiveForTenant(tenantId) : await settingsService.getGlobal(); const effective = tenantId ? settingsResult.effective : settingsResult.global; return Promise.all(Object.entries(INTEGRATION_DEFINITIONS).map(async ([id, definition]) => { const secrets = {}; for (const key of Object.keys(definition.secrets)) secrets[key] = await secretService.getMetadata(id, key); return { id, enabled: effective.providers?.[id]?.enabled !== false, provider: id, settings: effective.providers?.[id] || {}, secrets, configured: Object.values(secrets).every(value => value.configured) }; })); }
function applyTimeFilter(filter, query) { const range = {}; if (query.from && !Number.isNaN(Date.parse(query.from))) range.$gte = new Date(query.from); if (query.to && !Number.isNaN(Date.parse(query.to))) { const end = new Date(query.to); if (/^\d{4}-\d{2}-\d{2}$/.test(query.to)) end.setUTCHours(23, 59, 59, 999); range.$lte = end; } if (Object.keys(range).length) filter.created_at = range; }
async function readAudit({ page, pageSize }, query = {}) { const filter = {}; for (const key of ['actor', 'action', 'tenantId', 'targetType', 'outcome']) if (query[key]) filter[key] = String(query[key]); applyTimeFilter(filter, query); const total = await AuditEvent.countDocuments(filter); const items = await AuditEvent.find(filter, { actor: 1, actorAccessLevel: 1, action: 1, targetType: 1, targetId: 1, tenantId: 1, before: 1, after: 1, outcome: 1, failureCode: 1, created_at: 1 }, { sort: { created_at: -1 }, skip: (page - 1) * pageSize, limit: pageSize, lean: true }).exec(); return { items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) }; }
async function readNotifications({ page, pageSize }, query = {}) { const filter = {}; for (const key of ['tenantId', 'status', 'event']) if (query[key]) filter[key] = String(query[key]); applyTimeFilter(filter, query); const total = await NotificationDelivery.countDocuments(filter); const items = await NotificationDelivery.find(filter, { tenantId: 1, accountId: 1, event: 1, template: 1, status: 1, retryCount: 1, failureCode: 1, lastAttemptAt: 1, sentAt: 1, created_at: 1 }, { sort: { created_at: -1 }, skip: (page - 1) * pageSize, limit: pageSize, lean: true }).exec(); return { items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) }; }
module.exports = { createWebmasterRouter };
