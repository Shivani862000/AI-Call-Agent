const { randomUUID } = require('node:crypto');

function createRequestContext({ logger, idFactory = randomUUID } = {}) {
  if (!logger) throw new TypeError('Request context requires a logger');
  return (req, res, next) => {
    req.requestId = idFactory();
    res.setHeader('x-request-id', req.requestId);
    const startedAt = Date.now();
    res.on('finish', () => logger.info('http_request_completed', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt
    }));
    next();
  };
}

module.exports = { createRequestContext };
