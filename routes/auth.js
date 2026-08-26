const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireRole, sameOrigin } = require('../auth/middleware');

function publicUser(authority) {
  return { id: authority.id, username: authority.username, roles: authority.roles };
}

function createAuthRouter({ supabaseAuth, users, clients, auth, publicBaseUrl = '' }) {
  if (!supabaseAuth || !users || !clients || !auth) throw new TypeError('Auth router dependencies are required');
  const router = express.Router();
  const mutationOrigin = sameOrigin({ publicBaseUrl });
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

  router.post('/login', loginLimiter, mutationOrigin, async (req, res) => {
    try {
      const profile = await users.findByUsername(req.body.username);
      const verified = profile?.active
        ? await supabaseAuth.verifyPassword(profile.email, String(req.body.password || ''))
        : null;
      if (!profile || !verified || verified.id !== profile.id) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      const activeClients = await clients.listActive();
      const activeClientId = activeClients[0]?.id;
      if (!activeClientId) return res.status(503).json({ error: 'No active client is configured' });
      req.session = {
        userId: profile.id,
        authVersion: profile.auth_version,
        activeClientId,
        issuedAt: Date.now()
      };
      await users.markLogin(profile.id);
      res.json({ user: publicUser(profile), activeClientId, clients: activeClients });
    } catch {
      res.status(401).json({ error: 'Invalid username or password' });
    }
  });

  router.get('/session', auth.reload, requireRole('webmaster'), (req, res) => {
    res.json({ user: publicUser(req.auth), activeClientId: req.activeClientId, clients: req.activeClients });
  });

  router.post('/select-client', auth.reload, requireRole('webmaster'), mutationOrigin, async (req, res) => {
    const selected = Number(req.body.clientId);
    const client = req.activeClients.find((candidate) => candidate.id === selected);
    if (!client) return res.status(400).json({ error: 'Active client not found' });
    req.session.activeClientId = selected;
    res.json({ activeClientId: selected, client });
  });

  router.post('/logout', mutationOrigin, (req, res) => {
    req.session = null;
    res.json({ success: true });
  });

  return router;
}

module.exports = { createAuthRouter };
