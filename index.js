/**
 * index.js
 * Modular entry point for AI-Call-Agent.
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');

// Import modular components
const { PORT } = require('./src/config');
const { PROTECTED_HTML_PATHS, requireAdminAuth, requireRole, basicAuth } = require('./src/auth');
const { createWebmasterAuthorization } = require('./src/webmaster/authorization');
const { createSettingsService } = require('./src/webmaster/settings-service');
const { createSecretService } = require('./src/webmaster/secret-service');
const { environmentKeyForSecret } = require('./src/webmaster/settings-registry');
const { createMaintenanceMiddleware, createConfiguredRateLimit, createFeatureFlagMiddleware } = require('./src/webmaster/policy-middleware');
const { isAdminOnlyRequest } = require('./src/authorization');
const { createTenantWorkspaceDispatcher } = require('./src/tenant-workspace-routes');
const mountApiRoutes = require('./src/api-routes');
const setupWebSocketBridge = require('./src/websocket-bridge');
const startServer = require('./src/server');
require('./src/cron/daily-reports');
require('./src/cron/retention-archival').scheduleRetentionArchival();

const app = express();
const webmasterAuthorization = createWebmasterAuthorization();
const platformSecretService = createSecretService({ environmentKeyFor: (integration, key) => environmentKeyForSecret(integration, key, process.env) });
const platformSettingsService = createSettingsService({ secretService: platformSecretService });
const managedSettingsProvider = async () => (await platformSettingsService.getGlobal()).global;
app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      mediaSrc: ["'self'", "data:", "blob:"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

const loginLimiter = createConfiguredRateLimit({ settingsProvider: managedSettingsProvider, scope: 'loginPer15Minutes', fallback: 10, windowMs: 15 * 60 * 1000 });
const apiLimiter = createConfiguredRateLimit({ settingsProvider: managedSettingsProvider, scope: 'apiPerMinute', fallback: 60 });
const webhookLimiter = createConfiguredRateLimit({ settingsProvider: managedSettingsProvider, scope: 'webhookPerMinute', fallback: 300 });

app.use('/api/auth/login', loginLimiter);
app.use('/call/start', apiLimiter);
app.use('/api/test-call', apiLimiter);
app.use('/api/test-ai-call', apiLimiter);
app.use('/api/customers/csv', apiLimiter);
app.use('/api/icallmate/callback', webhookLimiter);

// Basic Middleware
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

// Custom Middlewares
app.use((req, res, next) => {
  if (PROTECTED_HTML_PATHS.has(req.path) || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path.startsWith('/api/auth/')) {
    return next();
  }

  if (
    req.path === '/api/icallmate/config'
    || req.path === '/icallmate/health'
  ) {
    return basicAuth(req, res, next);
  }

  if (req.path === '/api/icallmate/callback') {
    return next();
  }

  if (PROTECTED_HTML_PATHS.has(req.path) || req.path.startsWith('/api/') || req.path === '/call/start') {
    return requireAdminAuth(req, res, next);
  }

  return next();
});

app.use((req, res, next) => {
  if (req.path === '/webmaster.html' || req.path.startsWith('/api/webmaster')) {
    return webmasterAuthorization.requireWebmaster(req, res, next);
  }
  return next();
});

app.use(createMaintenanceMiddleware({ settingsProvider: managedSettingsProvider }));
app.use(createFeatureFlagMiddleware({ settingsProvider: async req => {
  const tenantId = req.adminSession?.tenantId;
  return tenantId ? (await platformSettingsService.getEffectiveForTenant(tenantId)).effective : managedSettingsProvider();
} }));

// Phase 1 RBAC: agents can work with patient records, schedules, and read-only
// call history. Configuration, feedback, real calls, and destructive actions
// remain admin-only.
const requireAdminRole = requireRole('WEBMASTER', 'CLIENT_ADMIN');
app.use((req, res, next) => {
  if (isAdminOnlyRequest(req)) {
    return requireAdminRole(req, res, next);
  }
  return next();
});

app.get('/incoming-calls.html', (req, res) => {
  res.status(404).send('Incoming Calls page is disabled.');
});

app.get('/reports.html', (req, res) => {
  res.status(404).send('Reports page is disabled.');
});

app.use(createTenantWorkspaceDispatcher({ publicDirectory: path.join(__dirname, 'public') }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Create Server
const server = http.createServer(app);

// Mount Application Routes
mountApiRoutes(app);

// Error Handling
app.use((req, res, next) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
  const reqId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  console.error(`[SERVER ERROR] reqId=${reqId}`, err);
  res.status(err.status || 500).json({ error: 'An internal server error occurred. Please try again later.', reqId });
});

// Setup WebSocket Bridge
setupWebSocketBridge(server);

// Boot Server
startServer(server);
