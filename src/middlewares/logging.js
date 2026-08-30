'use strict';

const crypto = require('crypto');
const logger = require('../logger');

function requestLoggingMiddleware(req, res, next) {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  const startTime = Date.now();

  // Wait for the auth middleware to parse these if they exist, but initially they might be undefined
  // We will update the context dynamically if needed, or rely on objects. 
  // AsyncLocalStorage allows object mutation to reflect down the stack.
  const context = {
    requestId,
    method: req.method,
    route: req.originalUrl,
    // We will populate these down the line when Auth middleware runs
    userId: undefined,
    tenantId: undefined,
    role: undefined
  };

  logger.runWithContext(context, () => {
    // Add requestId to response
    res.setHeader('X-Request-ID', requestId);

    logger.info('REQUEST_START', { url: req.url });

    // Track response finish
    res.on('finish', () => {
      const durationMs = Date.now() - startTime;
      const statusCode = res.statusCode;
      
      // Attempt to pull user/tenant from the modified request object if the context wasn't updated
      if (!context.userId && req.adminSession) {
        context.userId = req.adminSession.username;
        context.role = req.adminSession.role;
      }
      if (!context.tenantId && req.tenantId) {
        context.tenantId = req.tenantId;
      }

      const level = statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'INFO';
      
      logger[level.toLowerCase()]('REQUEST_COMPLETE', {
        statusCode,
        durationMs
      });
    });

    next();
  });
}

module.exports = {
  requestLoggingMiddleware
};
