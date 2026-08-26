const twilio = require('twilio');

function externalUrl(publicBaseUrl, requestPath, websocket = false) {
  const base = new URL(publicBaseUrl);
  if (websocket) base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return new URL(requestPath, base).toString();
}

function validateTwilioHttp({ authToken, publicBaseUrl, logger }) {
  if (!authToken || !publicBaseUrl) throw new Error('Twilio validation requires authToken and publicBaseUrl');
  return (req, res, next) => {
    const valid = twilio.validateRequest(
      authToken,
      String(req.get('x-twilio-signature') || ''),
      externalUrl(publicBaseUrl, req.originalUrl),
      req.method === 'POST' ? req.body || {} : {}
    );
    if (!valid) {
      logger?.warn('twilio_http_signature_rejected', { method: req.method, path: req.path, requestId: req.requestId });
      return res.status(403).json({ error: 'Invalid provider signature' });
    }
    next();
  };
}

function validateTwilioUpgrade({ authToken, publicBaseUrl, logger }) {
  if (!authToken || !publicBaseUrl) throw new Error('Twilio upgrade validation requires authToken and publicBaseUrl');
  return (req) => {
    const valid = twilio.validateRequest(
      authToken,
      String(req.headers['x-twilio-signature'] || ''),
      externalUrl(publicBaseUrl, req.url, true),
      {}
    );
    if (!valid) logger?.warn('twilio_websocket_signature_rejected', { path: new URL(req.url, publicBaseUrl).pathname });
    return valid;
  };
}

module.exports = { externalUrl, validateTwilioHttp, validateTwilioUpgrade };
