'use strict';

const express = require('express');
const { supabase } = require('../src/supabase');
const { WebmasterError } = require('../src/webmaster/errors');
const { createAuditService } = require('../src/webmaster/audit-service');
const { createUserService } = require('../src/webmaster/user-service');
const { getGlobalRuntimeSettings } = require('../src/webmaster/settings-service');
const {
  recordFilterFromRequest,
  createMongooseArchiveHandlers
} = require('../src/webmaster/lifecycle');

const TENANT_ROLES = new Set(['CLIENT_ADMIN', 'CLIENT_AGENT']);
const USER_STATUSES = new Set(['active', 'suspended', 'archived']);

const auditService = createAuditService();
const defaultUserService = createUserService({
  auditService,
  passwordPolicy: async () => (await getGlobalRuntimeSettings()).policies?.password || {}
});

function pageInput(query = {}) {
  const role = String(query.role || '').toUpperCase();
  const status = String(query.status || '').toLowerCase();
  return {
    page: Math.max(1, Number(query.page) || 1),
    pageSize: Math.min(100, Math.max(1, Number(query.pageSize) || 25)),
    ...(TENANT_ROLES.has(role) ? { role } : {}),
    ...(USER_STATUSES.has(status) ? { status } : {}),
    ...(query.search ? { search: String(query.search).slice(0, 100) } : {})
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createLegacyAgentHandlers() {
  return { archive: () => {}, restore: () => {} };
}

function createUsersRouter({ userService = defaultUserService } = {}) {
  if (!userService) throw new TypeError('Tenant user service is required');
  const router = express.Router();
  const legacyAgentHandlers = createLegacyAgentHandlers();

  router.use((req, res, next) => {
    if (req.adminSession?.role !== 'CLIENT_ADMIN') {
      return res.status(403).json({ error: 'Only tenant administrators can manage users' });
    }
    return next();
  });

  // Legacy agent endpoints remain available for existing clients.
  router.get('/agents', asyncRoute(async (req, res) => {
    const { data: agents } = await supabase.from('users').select('*').eq('tenant_id', req.tenantId).eq('role', 'CLIENT_AGENT').order('created_at', { ascending: false });
    res.json((agents || []).map(agent => ({ ...agent, id: agent.id })));
  }));

  router.post('/agents', asyncRoute(async (req, res) => {
    const agent = await userService.createTenantUser(req.tenantId, {
      username: req.body?.username,
      email: req.body?.email,
      password: req.body?.password,
      role: 'CLIENT_AGENT'
    }, req.adminSession);
    res.json({ message: 'Agent created successfully', agentId: agent.id });
  }));
  router.post('/agents/:id/archive', legacyAgentHandlers.archive);
  router.post('/agents/:id/restore', legacyAgentHandlers.restore);
  router.delete('/agents/:id', legacyAgentHandlers.archive);

  router.get('/', asyncRoute(async (req, res) => {
    res.json(await userService.listTenantUsers(req.tenantId, pageInput(req.query)));
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const input = {
      username: req.body?.username,
      email: req.body?.email,
      password: req.body?.password,
      role: req.body?.role
    };
    res.status(201).json(await userService.createTenantUser(req.tenantId, input, req.adminSession));
  }));

  router.patch('/:userId', asyncRoute(async (req, res) => {
    const source = req.body?.patch || req.body || {};
    const patch = { username: source.username, email: source.email, role: source.role };
    res.json(await userService.updateTenantUser(
      req.tenantId,
      req.params.userId,
      patch,
      req.body?.expectedVersion,
      req.adminSession
    ));
  }));

  router.post('/:userId/password', asyncRoute(async (req, res) => {
    res.json(await userService.replacePassword(
      req.params.userId,
      req.body?.password,
      req.body?.expectedVersion,
      req.adminSession,
      req.tenantId
    ));
  }));

  router.post('/:userId/lifecycle', asyncRoute(async (req, res) => {
    res.json(await userService.transitionTenantUser(
      req.tenantId,
      req.params.userId,
      req.body?.transition,
      req.body?.expectedVersion,
      req.adminSession,
      req.body?.reason
    ));
  }));

  router.use((error, _req, res, _next) => {
    if (error instanceof WebmasterError) {
      return res.status(error.status).json(error.toResponse());
    }
    return res.status(500).json({ error: 'User management operation could not be completed' });
  });

  return router;
}

const router = createUsersRouter();
module.exports = router;
module.exports.createUsersRouter = createUsersRouter;
