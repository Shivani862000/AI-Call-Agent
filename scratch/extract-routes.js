const fs = require('fs');

const indexCode = fs.readFileSync('/Users/admin/AI-Call-Agent/index.js', 'utf8');
const lines = indexCode.split('\n');
const routeLines = lines.slice(2138, 3491);

const header = `/**
 * src/api-routes.js
 * Express route handlers for the API and web interface.
 */

'use strict';

const {
  CALL_MODE,
  VOICE_PIPELINE,
  REALTIME_MODEL,
  PUBLIC_BASE_URL,
  liveCallState,
  incomingCallState,
  pendingCallDiagnostics
} = require('./config');
const {
  setAuthCookie,
  clearAuthCookie,
  requireAdminAuth,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  createAuthToken
} = require('./auth');
const {
  pickRequestValue,
  safeJsonParse,
  getLocalDateKey,
  xmlEscape,
  toWssUrl
} = require('./helpers');
const { placeRealtimeCall } = require('./call-management');
const {
  buildScriptedTwiml,
  buildScriptedLanguageResponse,
  buildScriptedConsentResponse,
  buildScriptedRatingResponse
} = require('./scripted-ivr');
const { dbAll, dbGet, dbRun } = require('../db');
const { generateCallAnalysisPDF } = require('../services/pdf');
const { buildMasterPostPayload } = require('../services/icallmate');
const { buildOwnerDashboardData } = require('../services/reporting');

module.exports = function mountApiRoutes(app) {
`;

const footer = `\n};\n`;

fs.writeFileSync('/Users/admin/AI-Call-Agent/src/api-routes.js', header + routeLines.join('\n') + footer);
console.log('Successfully extracted API routes.');
