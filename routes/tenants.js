const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { supabase } = require('../src/supabase');
const {
  activeRecordFilter,
  recordFilterFromRequest,
} = require('../src/webmaster/lifecycle');

function handleSupabaseError(error, res) {
  if (error.code === '23505') {
    return res.status(409).json({ error: 'A record with that value already exists.' });
  }
  return res.status(500).json({ error: error.message });
}

// Get all tenants (WEBMASTER only)
router.get('/', async (req, res) => {
  try {
    let query = supabase.from('tenants').select('*').order('created_at', { ascending: false });
    const showArchived = req.query.showArchived === 'true';
    if (!showArchived) {
      query = query.neq('status', 'archived');
    }
    const { data: tenants, error } = await query;
    if (error) throw error;
    res.json(tenants);
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
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .insert([{ 
        name, 
        daily_report_time: dailyReportTime || '19:00',
        status: 'active'
      }])
      .select()
      .single();

    if (tenantError) return handleSupabaseError(tenantError, res);

    // Hash password and create initial CLIENT_ADMIN user for this tenant
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(adminPassword, salt);
    
    const { data: adminUser, error: userError } = await supabase
      .from('users')
      .insert([{
        username: adminUsername,
        email: adminEmail,
        password_hash,
        role: 'CLIENT_ADMIN',
        tenant_id: tenant.id,
        status: 'active'
      }])
      .select()
      .single();

    if (userError) {
      // Rollback tenant creation since we couldn't create admin user
      await supabase.from('tenants').delete().eq('id', tenant.id);
      return handleSupabaseError(userError, res);
    }

    res.json({ 
      message: 'Tenant and initial admin created successfully', 
      tenantId: tenant.id,
      adminId: adminUser.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update a tenant config (WEBMASTER only)
router.put('/:id', async (req, res) => {
  try {
    const { name, dailyReportTime, status } = req.body;
    const normalizedStatus = status === undefined ? undefined : String(status).trim().toLowerCase();
    if (normalizedStatus === 'archived') {
      return res.status(400).json({ error: 'Use the explicit archive endpoint to archive a tenant' });
    }
    if (normalizedStatus !== undefined && !['active', 'suspended'].includes(normalizedStatus)) {
      return res.status(400).json({ error: 'Tenant status must be active or suspended' });
    }
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (dailyReportTime !== undefined) patch.daily_report_time = dailyReportTime;
    if (normalizedStatus !== undefined) patch.status = normalizedStatus;

    // First check if active
    const { data: existing, error: checkError } = await supabase
      .from('tenants')
      .select('id')
      .eq('id', req.params.id)
      .neq('status', 'archived')
      .maybeSingle();

    if (checkError) throw checkError;
    if (!existing) return res.status(404).json({ error: 'Tenant not found' });

    const { data: tenant, error: updateError } = await supabase
      .from('tenants')
      .update(patch)
      .eq('id', req.params.id)
      .select()
      .single();

    if (updateError) return handleSupabaseError(updateError, res);
    
    res.json({ message: 'Tenant updated successfully', tenant });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/archive', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tenants')
      .update({ status: 'archived' })
      .eq('id', req.params.id)
      .neq('status', 'archived')
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Tenant not found or already archived' });
    res.json({ message: 'Archived successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/restore', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tenants')
      .update({ status: 'active' })
      .eq('id', req.params.id)
      .eq('status', 'archived')
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Tenant not found or not archived' });
    res.json({ message: 'Restored successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
