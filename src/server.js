/**
 * src/server.js
 * Main entry point bootstrap script for starting the server and background jobs.
 */

'use strict';

const {
  PORT,
  PUBLIC_BASE_URL,
  CALL_MODE,
  VOICE_PIPELINE,
  REALTIME_MODEL,
  DISABLE_SCHEDULER,
  DISABLE_OWNER_DIGEST,
  validateConfig,
  logConfigSnapshot
} = require('./config');

const { initializeDatabase, startDatabaseBackupSchedule } = require('../db');
const { runSchedulerTick, runOwnerDigestTick } = require('./scheduler');
const { pruneLiveCallState } = require('./helpers');
const { validateAuthConfig } = require('./auth');

module.exports = function startServer(server) {
  (async () => {
  try {
    validateConfig();
    validateAuthConfig();
    await initializeDatabase();
    startDatabaseBackupSchedule();
    logConfigSnapshot('SERVER');

    if (!DISABLE_SCHEDULER) {
      setInterval(() => {
        runSchedulerTick().catch((error) => {
          console.error('[SCHEDULER ERROR]', error.message);
        });
      }, 10000);
    }

    if (!DISABLE_OWNER_DIGEST) {
      setInterval(() => {
        runOwnerDigestTick().catch((error) => {
          console.error('[OWNER DIGEST ERROR]', error.message);
        });
      }, 60000);
    }

    setInterval(() => {
      pruneLiveCallState();
    }, 60000);

    if (!DISABLE_SCHEDULER) {
      runSchedulerTick().catch((error) => {
        console.error('[SCHEDULER ERROR]', error.message);
      });
    }

    if (!DISABLE_OWNER_DIGEST) {
      runOwnerDigestTick().catch((error) => {
        console.error('[OWNER DIGEST ERROR]', error.message);
      });
    }

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[SERVER] Running on port ${PORT} (0.0.0.0)`);
      console.log(`[SERVER] Public base URL: ${PUBLIC_BASE_URL}`);
      console.log(`[SERVER] Call mode: ${CALL_MODE}`);
      console.log(`[SERVER] Voice pipeline: ${VOICE_PIPELINE}`);
      console.log(`[SERVER] Realtime model: ${REALTIME_MODEL}`);
      console.log(DISABLE_SCHEDULER
        ? '[SERVER] Scheduler disabled by DISABLE_SCHEDULER=true'
        : '[SERVER] Scheduler active: checks pending customers every 10 seconds');
      console.log(DISABLE_OWNER_DIGEST
        ? '[SERVER] Owner digest disabled by DISABLE_OWNER_DIGEST=true'
        : '[SERVER] Owner digest active: checks 8 AM morning delivery every 60 seconds');
      console.log('[SERVER] Admin UI: http://localhost:3000/admin.html');
      console.log('[SERVER] Ready. Trigger a call with: curl -X POST http://localhost:3000/call/start');
    });
  } catch (error) {
    console.error('[CONFIG ERROR]', error.message);
    process.exit(1);
  }
  })();
};
