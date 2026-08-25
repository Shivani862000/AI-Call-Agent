'use strict';

function mountTenantScopedRoutes(app, {
  requireTenantAccess,
  usersRouter,
  customersRouter,
  clientsRouter,
  campaignsRouter,
  feedbackRouter,
  agentsRouter,
  callArchiveRouter
}) {
  const mounts = [
    ['/api/users', usersRouter],
    ['/api/customers', customersRouter],
    ['/api/clients', clientsRouter],
    ['/api/campaigns', campaignsRouter],
    ['/api/feedback', feedbackRouter],
    ['/api/agents', agentsRouter],
    ['/api/calls', callArchiveRouter]
  ];

  for (const [path, router] of mounts) {
    if (router) app.use(path, requireTenantAccess, router);
  }
}

module.exports = { mountTenantScopedRoutes };
