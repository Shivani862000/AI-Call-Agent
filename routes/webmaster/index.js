'use strict';

const express = require('express');
const supabase = require('../../src/supabase');

function pageInput(query = {}) { 
  return { 
    page: Math.max(1, Number(query.page) || 1), 
    pageSize: Math.min(100, Math.max(1, Number(query.pageSize) || 25)), 
    status: query.status ? String(query.status) : undefined, 
    role: query.role ? String(query.role) : undefined, 
    search: query.search ? String(query.search).slice(0, 100) : undefined 
  }; 
}

function createWebmasterRouter({ authorization } = {}) {
  const router = express.Router();
  router.use(authorization.requireWebmaster);

  router.get('/dashboard', asyncRoute(async (req, res) => {
    const { count: tenants } = await supabase.from('tenants').select('*', { count: 'exact', head: true });
    const { count: customers } = await supabase.from('customers').select('*', { count: 'exact', head: true });
    const { count: calls } = await supabase.from('calls').select('*', { count: 'exact', head: true });
    
    // We can query calls by status if needed, simplified for now
    const callsData = { scheduled: 0, completed: 0, failed: 0, canceled: 0 };
    const { data: callsStatus } = await supabase.from('calls').select('status');
    callsStatus?.forEach(c => callsData[c.status] = (callsData[c.status] || 0) + 1);

    res.json({
      summary: { tenants: tenants || 0, calls: calls || 0, customers: customers || 0 },
      calls: callsData,
      integrations: [],
      recentAudit: [],
      notifications: { failed: 0 }
    });
  }));

  // Tenants
  router.get('/tenants', asyncRoute(async (req, res) => {
    const p = pageInput(req.query);
    let query = supabase.from('tenants').select('*', { count: 'exact' }).order('created_at', { ascending: false });
    
    if (p.status) query = query.eq('status', p.status);
    if (p.search) query = query.ilike('name', `%${p.search}%`);
    
    const { data, count, error } = await query.range((p.page - 1) * p.pageSize, p.page * p.pageSize - 1);
    if (error) throw error;
    
    res.json({ items: data, page: p.page, pageSize: p.pageSize, total: count, totalPages: Math.ceil(count / p.pageSize) });
  }));

  router.post('/tenants', asyncRoute(async (req, res) => {
    const { name, plan, initialAdmin } = req.body;
    
    // 1. Create Tenant
    const { data: tenant, error: tErr } = await supabase.from('tenants').insert({ name, plan }).select().single();
    if (tErr) throw tErr;

    // 2. Create User
    if (initialAdmin) {
      const { data: authUser, error: aErr } = await supabase.auth.admin.createUser({
        email: initialAdmin.email,
        password: initialAdmin.password,
        email_confirm: true
      });
      if (aErr) throw aErr;

      await supabase.from('users').insert({
        id: authUser.user.id,
        username: initialAdmin.username,
        email: initialAdmin.email,
        role: 'CLIENT_ADMIN',
        tenant_id: tenant.id
      });
    }

    res.status(201).json(tenant);
  }));

  router.get('/tenants/:tenantId', asyncRoute(async (req, res) => {
    const { data, error } = await supabase.from('tenants').select('*').eq('id', req.params.tenantId).single();
    if (error) throw error;
    res.json(data);
  }));

  router.patch('/tenants/:tenantId', asyncRoute(async (req, res) => {
    const patch = req.body.patch || req.body;
    const { data, error } = await supabase.from('tenants').update(patch).eq('id', req.params.tenantId).select().single();
    if (error) throw error;
    res.json(data);
  }));

  // Users
  router.get('/tenants/:tenantId/users', asyncRoute(async (req, res) => {
    const p = pageInput(req.query);
    const { data, count, error } = await supabase.from('users')
      .select('*', { count: 'exact' })
      .eq('tenant_id', req.params.tenantId)
      .range((p.page - 1) * p.pageSize, p.page * p.pageSize - 1);
    if (error) throw error;
    res.json({ items: data, page: p.page, pageSize: p.pageSize, total: count, totalPages: Math.ceil(count / p.pageSize) });
  }));

  router.get('/platform-users', authorization.requireOwner, asyncRoute(async (req, res) => {
    const p = pageInput(req.query);
    const { data, count, error } = await supabase.from('users')
      .select('*', { count: 'exact' })
      .in('role', ['WEBMASTER', 'SUPPORT_TEAM'])
      .range((p.page - 1) * p.pageSize, p.page * p.pageSize - 1);
    if (error) throw error;
    res.json({ items: data, page: p.page, pageSize: p.pageSize, total: count, totalPages: Math.ceil(count / p.pageSize) });
  }));

  // Settings & Others
  router.get('/settings', asyncRoute(async (req, res) => {
    const { data, error } = await supabase.from('platform_settings').select('*').eq('singleton_key', 'platform').maybeSingle();
    res.json({ global: data || {} });
  }));
  
  router.get('/integrations', asyncRoute(async (req, res) => {
    res.json({ items: [] });
  }));

  router.get('/audit-events', asyncRoute(async (req, res) => {
    const p = pageInput(req.query);
    const { data, count, error } = await supabase.from('audit_events')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((p.page - 1) * p.pageSize, p.page * p.pageSize - 1);
    res.json({ items: data || [], page: p.page, pageSize: p.pageSize, total: count || 0, totalPages: Math.ceil((count||0) / p.pageSize) });
  }));

  router.use((error, req, res, next) => {
    console.error('[WEBMASTER API ERROR]', error);
    res.status(error.status || 500).json({ error: error.message || 'Internal Server Error' });
  });

  return router;
}

function asyncRoute(handler) { 
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); 
}

module.exports = { createWebmasterRouter };
