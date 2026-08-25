const express = require('express');
const router = express.Router();
const User = require('../src/models/User');
const bcrypt = require('bcrypt');
const { getGlobalRuntimeSettings } = require('../src/webmaster/settings-service');
const {
  recordFilterFromRequest,
  createMongooseArchiveHandlers
} = require('../src/webmaster/lifecycle');

const userArchiveHandlers = createMongooseArchiveHandlers({
  Model: User,
  resourceName: 'Agent',
  scopeFromRequest(req, extra = {}) {
    return { ...extra, tenantId: req.tenantId, role: 'CLIENT_AGENT' };
  }
});

// Get all agents for the current tenant (CLIENT_ADMIN only)
router.get('/agents', async (req, res) => {
  try {
    if (req.adminSession.role !== 'CLIENT_ADMIN') {
      return res.status(403).json({ error: 'Only Client Admins can view agents' });
    }

    const agents = await User.find(recordFilterFromRequest(req, {
      tenantId: req.tenantId, 
      role: 'CLIENT_AGENT' 
    })).select('-password_hash').sort({ created_at: -1 });
    
    res.json(agents.map(a => ({ ...a.toObject(), id: a._id })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a new agent (CLIENT_ADMIN only)
router.post('/agents', async (req, res) => {
  try {
    if (req.adminSession.role !== 'CLIENT_ADMIN') {
      return res.status(403).json({ error: 'Only Client Admins can create agents' });
    }

    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }
    const settings = await getGlobalRuntimeSettings();
    const minLength = Math.max(8, Number(settings.policies?.password?.minLength) || 12);
    const maxLength = Math.max(minLength, Number(settings.policies?.password?.maxLength) || 128);
    if (String(password).length < minLength || String(password).length > maxLength) return res.status(422).json({ error: `Password must be between ${minLength} and ${maxLength} characters` });

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const agent = await User.create({
      username,
      email,
      password_hash,
      role: 'CLIENT_AGENT',
      tenantId: req.tenantId
    });

    res.json({ message: 'Agent created successfully', agentId: agent._id });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

function requireClientAdmin(handler) {
  return async (req, res) => {
    if (req.adminSession.role !== 'CLIENT_ADMIN') {
      return res.status(403).json({ error: 'Only Client Admins can archive or restore agents' });
    }
    return handler(req, res);
  };
}

router.post('/agents/:id/archive', requireClientAdmin(userArchiveHandlers.archive));
router.post('/agents/:id/restore', requireClientAdmin(userArchiveHandlers.restore));
router.delete('/agents/:id', requireClientAdmin(userArchiveHandlers.archive));

module.exports = router;
