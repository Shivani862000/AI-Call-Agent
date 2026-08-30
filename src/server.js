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


const { runSchedulerTick, runOwnerDigestTick } = require('./scheduler');
const { pruneLiveCallState } = require('./helpers');
const { validateAuthConfig } = require('./auth');
const logger = require('./logger');

module.exports = function startServer(server) {
  (async () => {
  try {
    logger.info('SERVER_STARTING');
    validateConfig();
    validateAuthConfig();

    // Configuration is logged separately or we can just log success
    logger.info('CONFIG_LOADED', { environment: process.env.NODE_ENV || 'development' });

    if (!DISABLE_SCHEDULER) {
      setInterval(() => {
        runSchedulerTick().catch((error) => logger.error('SCHEDULER_FAILED', { error }));
      }, 10000);
    }

    if (!DISABLE_OWNER_DIGEST) {
      setInterval(() => {
        runOwnerDigestTick().catch((error) => logger.error('OWNER_DIGEST_FAILED', { error }));
      }, 60000);
    }

    setInterval(() => pruneLiveCallState(), 60000);

    if (!DISABLE_SCHEDULER) {
      runSchedulerTick().catch((error) => logger.error('SCHEDULER_FAILED', { error }));
    }

    if (!DISABLE_OWNER_DIGEST) {
      runOwnerDigestTick().catch((error) => logger.error('OWNER_DIGEST_FAILED', { error }));
    }

    const supabaseAdmin = require('./supabase');
    logger.info('DATABASE_CONNECTION_START', { provider: 'supabase' });
    const { error: dbError } = await supabaseAdmin.from('customers').select('id').limit(1);
    if (dbError) {
      logger.error('DATABASE_CONNECTION_FAILED', { error: dbError });
    } else {
      logger.info('DATABASE_CONNECTION_SUCCESS');
    }
    
    logger.info('AUTH_INITIALIZED', { provider: 'supabase' });
    logger.info('SCHEDULER_INITIALIZED', { enabled: !DISABLE_SCHEDULER, interval: '10s' });

    server.listen(PORT, '0.0.0.0', () => {
      logger.info('SERVER_READY', { 
        port: PORT, 
        publicBaseUrl: PUBLIC_BASE_URL,
        callMode: CALL_MODE,
        voicePipeline: VOICE_PIPELINE
      });
    });
  } catch (error) {
    logger.fatal('CONFIG_ERROR', { error });
    process.exit(1);
  }
  })();
};
