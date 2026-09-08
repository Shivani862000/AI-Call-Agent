'use strict';

require('dotenv').config();

const http = require('http');
const { PUBLIC_BASE_URL } = require('./src/config');
const createApp = require('./src/app');
const auth = require('./src/auth');
const mountApiRoutes = require('./src/api-routes');
const setupWebSocketBridge = require('./src/websocket-bridge');
const startServer = require('./src/server');

const app = createApp({ publicBaseUrl: PUBLIC_BASE_URL, auth, mountApiRoutes });
const server = http.createServer(app);
setupWebSocketBridge(server);
startServer(server);
