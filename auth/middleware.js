const { runWithClient } = require('./client-context');

function unauthorized(req, res) {
  req.session = null;
  if (req.path.endsWith('.html') && req.accepts('html')) return res.redirect('/login.html');
  return res.status(401).json({ error: 'Authentication required' });
}

function createAuthMiddleware({ users, clients }) {
  if (!users || !clients) throw new TypeError('Auth middleware requires user and client repositories');
  return {
    async reload(req, res, next) {
      try {
        const session = req.session;
        if (!session?.userId || !Number.isInteger(session.authVersion)) return unauthorized(req, res);
        const authority = await users.findAuthority(session.userId);
        if (!authority?.active || Number(authority.auth_version) !== session.authVersion) return unauthorized(req, res);
        const activeClients = await clients.listActive();
        let activeClientId = session.activeClientId ? Number(session.activeClientId) : null;
        if (activeClientId && !activeClients.some((client) => client.id === activeClientId)) return unauthorized(req, res);
        if (!activeClientId) activeClientId = activeClients[0]?.id || null;
        if (!activeClientId) return unauthorized(req, res);
        req.session.activeClientId = activeClientId;
        req.auth = authority;
        req.activeClientId = activeClientId;
        req.activeClients = activeClients;
        runWithClient(activeClientId, next);
      } catch (error) {
        next(error);
      }
    }
  };
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.auth?.roles?.includes(role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

function sameOrigin({ publicBaseUrl = '' } = {}) {
  const expected = publicBaseUrl ? new URL(publicBaseUrl).origin : null;
  return (req, res, next) => {
    const origin = req.get('origin');
    const fetchSite = req.get('sec-fetch-site');
    if ((origin && expected && origin !== expected) || (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite))) {
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    }
    next();
  };
}

module.exports = { createAuthMiddleware, requireRole, sameOrigin };
