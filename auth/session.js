const cookieSession = require('cookie-session');

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

function createSessionMiddleware({ secret, secure = true, maxAgeMs = EIGHT_HOURS_MS }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Cookie secret must be at least 32 characters');
  return cookieSession({
    name: 'ai_call_agent_session',
    keys: [secret],
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: maxAgeMs,
    overwrite: true
  });
}

module.exports = { EIGHT_HOURS_MS, createSessionMiddleware };
