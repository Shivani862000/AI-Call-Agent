/**
 * index.js
 * Modular entry point for AI-Call-Agent.
 */

require('dotenv').config();

require('./src/logger');

const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Import modular components
const { PORT } = require('./src/config');
const { PROTECTED_HTML_PATHS, requireAdminAuth, requireRole, basicAuth } = require('./src/auth');
const { isAdminOnlyRequest } = require('./src/authorization');
const mountApiRoutes = require('./src/api-routes');
const setupWebSocketBridge = require('./src/websocket-bridge');
const startServer = require('./src/server');

const app = express();
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

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts' } });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Too many requests' } });
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, message: { error: 'Too many webhook requests' } });

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

// Phase 1 RBAC: agents can work with patient records, schedules, and read-only
// call history. Configuration, feedback, real calls, and destructive actions
// remain admin-only.
const requireAdminRole = requireRole('ADMIN', 'WEBMASTER', 'SUPPORT_TEAM');
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

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Create Server
const server = http.createServer(app);

const { createWebmasterRouter } = require('./routes/webmaster/index');
const { createWebmasterAuthorization } = require('./src/webmaster/authorization');
const auth = require('./src/auth');

const webmasterAuth = createWebmasterAuthorization({ 
  resolveActor: async (session, req) => {
    try {
      const actualSession = session || (req && auth.readAuthSession ? auth.readAuthSession(req) : null);
      if (!actualSession) throw new Error('Not authenticated');

      if (!actualSession.id) {
        console.error('[AUTH DEBUG] actualSession is missing id!', actualSession);
        throw new Error('No user ID in session');
      }

      const supabase = require('./src/supabase');
      const { data: userProfile, error: dbErr } = await supabase
        .from('users')
        .select('role, platform_access_level, username')
        .eq('id', actualSession.id)
        .single();

      if (dbErr) {
        console.error('[AUTH DEBUG] resolveActor DB error:', dbErr.message);
        throw dbErr;
      }
      if (!userProfile) throw new Error('User profile not found');

      return { 
        id: actualSession.id, 
        username: userProfile.username || actualSession.email, 
        role: userProfile.role, 
        platformAccessLevel: userProfile.platform_access_level, 
        source: 'session' 
      };
    } catch (e) {
      console.error('[AUTH DEBUG] resolveActor failed:', e.message);
      throw e;
    }
  }
});

// Mount Application Routes
mountApiRoutes(app);
app.use('/api/webmaster', createWebmasterRouter({ authorization: webmasterAuth }));

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
