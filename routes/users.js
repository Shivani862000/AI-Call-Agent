'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const supabase = require('../src/supabase');

const router = express.Router();

router.use((req, res, next) => {
  const role = req.adminSession?.role;
  if (role !== 'ADMIN' && role !== 'AGENT') {
    return res.status(403).json({ error: 'Only administrators can manage users' });
  }
  next();
});

router.get('/', async (req, res, next) => {
  try {
    let query = supabase.from('users').select('*').order('created_at', { ascending: false });
    
    // Support search or basic filtering if query parameters exist
    if (req.query.role) query = query.eq('role', req.query.role);
    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.search) query = query.ilike('username', `%${req.query.search}%`);
    
    // In current branch, since multitenancy isn't fully enabled in Supabase users table yet,
    // we omit tenant_id filter if it's not present, or filter if the admin belongs to a tenant.
    if (req.tenantId) query = query.eq('tenant_id', req.tenantId);

    const { data: items, error, count } = await query;
    if (error) throw error;

    res.json({
      items: items || [],
      page: 1,
      pageSize: 100,
      totalItems: items?.length || 0
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { username, email, password, role } = req.body;
    if (!username || !password || !role) {
      return res.status(400).json({ error: 'Username, password, and role are required' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase.from('users').insert([{
      username,
      email: email || null,
      password_hash,
      role,
      status: 'active',
      tenant_id: req.tenantId || null
    }]).select('id, username, email, role, status').single();

    if (error) throw error;
    res.status(201).json(user);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Username or email already exists' });
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const updates = {};
    if (req.body.email !== undefined) updates.email = req.body.email;
    if (req.body.role !== undefined) updates.role = req.body.role;
    if (req.body.password) {
      updates.password_hash = await bcrypt.hash(req.body.password, 10);
    }

    const { data: user, error } = await supabase.from('users').update(updates).eq('id', req.params.id).select('id, username, email, role, status').single();
    if (error) throw error;
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/archive', async (req, res, next) => {
  try {
    const { data: user, error } = await supabase.from('users').update({ status: 'archived' }).eq('id', req.params.id).select('id, username, email, role, status').single();
    if (error) throw error;
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User archived successfully', user });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/restore', async (req, res, next) => {
  try {
    const { data: user, error } = await supabase.from('users').update({ status: 'active' }).eq('id', req.params.id).select('id, username, email, role, status').single();
    if (error) throw error;
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User restored successfully', user });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
