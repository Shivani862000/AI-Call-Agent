'use strict';

const path = require('path');

const TENANT_WORKSPACE_ROUTES = new Set([
  '/admin.html',
  '/customer-list.html',
  '/customers.html',
  '/feedback.html',
  '/feedback-analysis.html',
  '/support-tickets.html',
  '/users.html'
]);

function createTenantWorkspaceDispatcher({ publicDirectory }) {
  return (req, res, next) => {
    if (!TENANT_WORKSPACE_ROUTES.has(req.path)) {
      return next();
    }

    const fileName = req.query?.embedded === '1'
      ? req.path.slice(1)
      : 'tenant-workspace.html';

    return res.sendFile(path.join(publicDirectory, fileName));
  };
}

module.exports = {
  TENANT_WORKSPACE_ROUTES,
  createTenantWorkspaceDispatcher
};
