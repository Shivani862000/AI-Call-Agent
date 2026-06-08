/**
 * index.js
 * Modular entry point for AI-Call-Agent.
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');

// Import modular components
const { PORT } = require('./src/config');
const { PROTECTED_HTML_PATHS, requireAdminAuth, basicAuth } = require('./src/auth');
const mountApiRoutes = require('./src/api-routes');
const setupWebSocketBridge = require('./src/websocket-bridge');
const startServer = require('./src/server');

const app = express();

// Basic Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

  if (PROTECTED_HTML_PATHS.has(req.path) || req.path.startsWith('/api/')) {
    return requireAdminAuth(req, res, next);
  }

  return next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Create Server
const server = http.createServer(app);

// Mount Application Routes
mountApiRoutes(app);

// Setup WebSocket Bridge
setupWebSocketBridge(server);

// Boot Server
startServer(server);
