/**
 * index.js
 * Modular entry point for AI-Call-Agent.
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Import modular components
const { PORT } = require('./src/config');
const { PROTECTED_HTML_PATHS, requireAdminAuth, basicAuth } = require('./src/auth');
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
    req.path === '/api/icallmate/callback'
    || req.path === '/api/icallmate/config'
    || req.path === '/icallmate/health'
    || req.path === '/icallmate/media'
  ) {
    return basicAuth(req, res, next);
  }

  if (PROTECTED_HTML_PATHS.has(req.path) || req.path.startsWith('/api/') || req.path === '/call/start') {
    return requireAdminAuth(req, res, next);
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
