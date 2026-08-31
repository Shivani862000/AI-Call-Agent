'use strict';

const express = require('express');
const supabase = require('../../src/supabase');
const { WebmasterError } = require('../../src/webmaster/errors');
const { createTenantService } = require('../../src/webmaster/tenant-service');
const { createUserService } = require('../../src/webmaster/user-service');
const { createAuditService } = require('../../src/webmaster/audit-service');
const { createDashboardService } = require('../../src/webmaster/dashboard-service');
const { createSettingsService } = require('../../src/webmaster/settings-service');
const { createSecretService } = require('../../src/webmaster/secret-service');
const { INTEGRATION_DEFINITIONS, environmentKeyForSecret } = require('../../src/webmaster/settings-registry');

function pageInput(query = {}) { return { page: Math.max(1, Number(query.page) || 1), pageSize: Math.min(100, Math.max(1, Number(query.pageSize) || 25)), status: query.status ? String(query.status) : undefined, role: query.role ? String(query.role) : undefined, search: query.search ? String(query.search).slice(0, 100) : undefined }; }

function createWebmasterRouter({ authorization, services = {} } = {}) {
  if (!authorization) throw new TypeError('Webmaster authorization is required');
  const router = express.Router();
  
  const auditService = services.auditService || createAuditService({ supabase });
  const secretService = services.secretService || createSecretService({ supabase, environmentKeyFor: (integration, key) => environmentKeyForSecret(integration, key, process.env) });
  const settingsService = services.settingsService || createSettingsService({ supabase, auditService, secretService });
  const passwordPolicy = async () => (await settingsService.getGlobal()).global?.policies?.password || {};
  const tenantService = services.tenantService || createTenantService({ supabase, auditService, passwordPolicy, integrationStatus: async tenantId => integrationMetadata(secretService, settingsService, tenantId) });
  const userService = services.userService || createUserService({ supabase, auditService, passwordPolicy });
  
  // Mocks for Notifications for now, since we don't have NotificationService in Supabase yet
  const notificationService = {
      sendLifecycle: async () => ({ notificationDeliveries: [] }),
      retry: async () => ({})
  };
  
  const dashboardService = services.dashboardService || createDashboardService({ 
      supabase, 
      integrationStatus: async () => integrationMetadata(secretService, settingsService), 
      recentAudit: async (limit) => {
          const { data } = await supabase.from('audit_events').select('*').order('created_at', { ascending: false }).limit(limit);
          return data || [];
      } 
  });

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
  
  router.use((error, _req, res, _next) => { 
      const safe = error instanceof WebmasterError ? error : new WebmasterError({ status: 500, code: 'WEBMASTER_INTERNAL_ERROR', message: 'The platform operation could not be completed' }); 
      console.error(error);
      res.status(safe.status).json(safe.toResponse()); 
  });
  
  return router;
}

function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
function lifecycleEvent(transition) { return transition === 'restore' ? 'restored' : transition === 'suspend' ? 'suspended' : 'archived'; }
async function notifySafely(operation) { try { return { notificationDeliveries: await operation() }; } catch (_error) { return { notificationDeliveries: [], notificationWarning: 'NOTIFICATION_DELIVERY_UNAVAILABLE' }; } }

async function integrationMetadata(secretService, settingsService, tenantId = null) { 
    const settingsResult = tenantId ? await settingsService.getEffectiveForTenant(tenantId) : await settingsService.getGlobal(); 
    const effective = tenantId ? settingsResult.effective : settingsResult.global; 
    return Promise.all(Object.entries(INTEGRATION_DEFINITIONS).map(async ([id, definition]) => { 
        const secrets = {}; 
        for (const key of Object.keys(definition.secrets)) secrets[key] = await secretService.getMetadata(id, key); 
        return { id, enabled: effective.providers?.[id]?.enabled !== false, provider: id, settings: effective.providers?.[id] || {}, secrets, configured: Object.values(secrets).every(value => value.configured) }; 
    })); 
}

function applyTimeFilter(queryObj, query) { 
    if (query.from && !Number.isNaN(Date.parse(query.from))) queryObj = queryObj.gte('created_at', new Date(query.from).toISOString()); 
    if (query.to && !Number.isNaN(Date.parse(query.to))) { 
        const end = new Date(query.to); 
        if (/^\d{4}-\d{2}-\d{2}$/.test(query.to)) end.setUTCHours(23, 59, 59, 999); 
        queryObj = queryObj.lte('created_at', end.toISOString()); 
    }
    return queryObj;
}

async function readAudit({ page, pageSize }, query = {}) { 
    let queryObj = supabase.from('audit_events').select('*', { count: 'exact' });
    for (const key of ['action', 'outcome']) {
        if (query[key]) queryObj = queryObj.eq(key, String(query[key])); 
    }
    // actor mapping
    if (query.actor) queryObj = queryObj.eq('actor', String(query.actor));
    if (query.tenantId) queryObj = queryObj.eq('tenant_id', String(query.tenantId));
    if (query.targetType) queryObj = queryObj.eq('target_type', String(query.targetType));
    
    queryObj = applyTimeFilter(queryObj, query); 
    
    const { data: items, count } = await queryObj
        .order('created_at', { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1);
        
    // Mapping from snake_case back to frontend expected properties
    const mapped = (items || []).map(row => ({
        ...row,
        targetType: row.target_type,
        targetId: row.target_id,
        tenantId: row.tenant_id,
        actorAccessLevel: row.actor_access_level,
        failureCode: row.failure_code,
        before: row.before_state,
        after: row.after_state
    }));

    return { items: mapped, page, pageSize, total: count || 0, totalPages: Math.ceil((count || 0) / pageSize) }; 
}

async function readNotifications({ page, pageSize }, query = {}) { 
    // Mocks for now
    return { items: [], page, pageSize, total: 0, totalPages: 0 }; 
}

module.exports = { createWebmasterRouter };
