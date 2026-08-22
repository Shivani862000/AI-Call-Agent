const express = require('express');
const router = express.Router();
const Tenant = require('../src/models/Tenant');
const User = require('../src/models/User');
const bcrypt = require('bcrypt');

// Get all tenants (WEBMASTER only)
router.get('/', async (req, res) => {
  try {
    const tenants = await Tenant.find().sort({ created_at: -1 });
    res.json(tenants.map(t => ({ ...t.toObject(), id: t._id })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a new tenant (WEBMASTER only)
router.post('/', async (req, res) => {
  try {
    const { name, dailyReportTime, adminEmail, adminUsername, adminPassword } = req.body;
    
    if (!name || !adminEmail || !adminUsername || !adminPassword) {
      return res.status(400).json({ error: 'Name, admin email, admin username, and admin password are required.' });
    }

    // Create the tenant
    const tenant = await Tenant.create({ 
      name, 
      dailyReportTime: dailyReportTime || '19:00' 
    });

    // Hash password and create initial CLIENT_ADMIN user for this tenant
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(adminPassword, salt);
    
    const adminUser = await User.create({
      username: adminUsername,
      email: adminEmail,
      password_hash,
      role: 'CLIENT_ADMIN',
      tenantId: tenant._id
    });

    res.json({ 
      message: 'Tenant and initial admin created successfully', 
      tenantId: tenant._id,
      adminId: adminUser._id
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A tenant, username, or email with that value already exists.' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Update a tenant config (WEBMASTER only)
router.put('/:id', async (req, res) => {
  try {
    const { name, dailyReportTime, status } = req.body;
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (dailyReportTime !== undefined) patch.dailyReportTime = dailyReportTime;
    if (status !== undefined) patch.status = status;

    const tenant = await Tenant.findByIdAndUpdate(req.params.id, patch, { new: true });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    
    res.json({ message: 'Tenant updated successfully', tenant });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
