const express = require('express');
const router = express.Router();
const User = require('../src/models/User');
const bcrypt = require('bcrypt');

// Get all agents for the current tenant (CLIENT_ADMIN only)
router.get('/agents', async (req, res) => {
  try {
    if (req.adminSession.role !== 'CLIENT_ADMIN') {
      return res.status(403).json({ error: 'Only Client Admins can view agents' });
    }

    const agents = await User.find({ 
      tenantId: req.tenantId, 
      role: 'CLIENT_AGENT' 
    }).select('-password_hash').sort({ created_at: -1 });
    
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

// Delete an agent
router.delete('/agents/:id', async (req, res) => {
  try {
    if (req.adminSession.role !== 'CLIENT_ADMIN') {
      return res.status(403).json({ error: 'Only Client Admins can remove agents' });
    }

    const agent = await User.findOne({ _id: req.params.id, tenantId: req.tenantId, role: 'CLIENT_AGENT' });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found in this tenant' });
    }

    await User.deleteOne({ _id: req.params.id, tenantId: req.tenantId });
    res.json({ message: 'Agent removed successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
