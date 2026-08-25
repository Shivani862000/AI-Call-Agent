'use strict';

const rateLimit = require('express-rate-limit');
function createCachedProvider(provider, maxAgeMs = 30000) { let value; let loadedAt = 0; return async () => { const now = Date.now(); if (!value || now - loadedAt >= maxAgeMs) { value = await provider(); loadedAt = now; } return value || {}; }; }
function createMaintenanceMiddleware({ settingsProvider, maxAgeMs = 30000 } = {}) {
  const read = createCachedProvider(settingsProvider, maxAgeMs);
  return async function maintenance(req, res, next) { try { const settings = await read(); const maintenance = settings.maintenance || settings.policies?.maintenance || {}; const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method); if (maintenance.enabled && mutation && !req.webmasterActor && !req.path?.startsWith('/api/webmaster')) return res.status(503).json({ error: maintenance.message || 'Service is temporarily in maintenance mode', code: 'MAINTENANCE_MODE' }); return next(); } catch (_error) { return next(); } };
}
function createConfiguredRateLimit({ settingsProvider, scope, fallback, factory = rateLimit, maxAgeMs = 30000, windowMs = 60000 } = {}) { const read = createCachedProvider(settingsProvider, maxAgeMs); return factory({ windowMs, limit: async () => { try { const settings = await read(); const candidate = settings.rateLimits?.[scope] ?? settings.policies?.rateLimits?.[scope]; return Number.isInteger(candidate) && candidate > 0 ? candidate : fallback; } catch (_error) { return fallback; } }, message: { error: 'Too many requests' } }); }
function createFeatureFlagMiddleware({ settingsProvider, maxAgeMs = 30000 } = {}) {
  return async function managedFeatureFlags(req, res, next) {
    if (req.webmasterActor || req.path?.startsWith('/api/webmaster')) return next();
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (!mutation) return next();
    try {
      const flags = (await settingsProvider(req)).featureFlags || {};
      const path = String(req.path || '');
      const feature = path === '/call/start' || path.startsWith('/api/test-call') || path.startsWith('/api/test-ai-call') || path.includes('/outbound')
        ? 'outboundCalling'
        : path.startsWith('/api/icallmate/callback') || path.includes('/incoming')
          ? 'incomingCalling'
          : path.startsWith('/api/support-tickets') ? 'supportTickets' : null;
      if (feature && flags[feature] === false) return res.status(503).json({ error: 'This feature is temporarily disabled', code: 'FEATURE_DISABLED', feature });
    } catch (_error) { /* Fail open so a settings read outage does not stop operations. */ }
    return next();
  };
}
module.exports = { createMaintenanceMiddleware, createConfiguredRateLimit, createFeatureFlagMiddleware };
