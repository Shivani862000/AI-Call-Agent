'use strict';

const express = require('express');
const { supabase } = require('../src/supabase');

function normalizePayload(payload = {}) {
  return {
    name: String(payload.name || '').trim(),
    service_name: String(payload.service_name || '').trim() || null,
    monthly_spend_inr: Number(payload.monthly_spend_inr || 0) || 0,
    status: String(payload.status || 'active').trim().toLowerCase() || 'active'
  };
}

function serialize(record) {
  const value = { ...record };
  return value;
}

function createCampaignsRouter() {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      let query = supabase.from('campaigns').select('*').eq('tenant_id', req.tenantId).order('created_at', { ascending: false }).order('name', { ascending: true });
      if (req.query.status) {
        query = query.eq('status', req.query.status);
      } else {
        query = query.neq('status', 'archived');
      }
      
      const { data, error } = await query;
      if (error) throw error;
      res.json((data || []).map(serialize));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const payload = normalizePayload(req.body);
      if (!payload.name) return res.status(400).json({ error: 'Campaign name is required' });
      
      const insertData = { ...payload, tenant_id: req.tenantId };
      const { data, error } = await supabase.from('campaigns').insert([insertData]).select().single();
      
      if (error) {
        if (error.code === '23505') {
          return res.status(409).json({ error: 'Campaign already exists' });
        }
        throw error;
      }
      
      res.json({ id: String(data.id), message: 'Campaign created successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const normalizedStatus = req.body?.status === undefined
        ? undefined
        : String(req.body.status).trim().toLowerCase();
        
      if (normalizedStatus === 'archived') {
        return res.status(400).json({ error: 'Use the explicit archive endpoint to archive a campaign' });
      }
      if (normalizedStatus !== undefined && !['active', 'paused'].includes(normalizedStatus)) {
        return res.status(400).json({ error: 'Campaign status must be active or paused' });
      }
      
      const payload = normalizePayload(req.body);
      if (normalizedStatus !== undefined) payload.status = normalizedStatus;
      if (!payload.name) return res.status(400).json({ error: 'Campaign name is required' });
      
      const { data: existing, error: findError } = await supabase.from('campaigns').select('*').eq('id', req.params.id).eq('tenant_id', req.tenantId).neq('status', 'archived').maybeSingle();
      if (findError) throw findError;
      if (!existing) return res.status(404).json({ error: 'Campaign not found' });

      const { data, error } = await supabase.from('campaigns').update(payload).eq('id', req.params.id).eq('tenant_id', req.tenantId).select().single();
      if (error) throw error;
      
      res.json({ message: 'Campaign updated successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Archive Handlers
  const archiveHandler = async (req, res) => {
    try {
      const username = req.adminSession?.username || req.user?.username || 'system';
      const updatePayload = {
        status: 'archived',
        archived_at: new Date().toISOString(),
        archived_by: username,
        archive_reason: (req.body?.reason || '').substring(0, 500) || null
      };

      const { data, error } = await supabase.from('campaigns').update(updatePayload).eq('id', req.params.id).eq('tenant_id', req.tenantId).neq('status', 'archived').select().maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Campaign not found or already archived' });
      
      res.json({ message: 'Campaign archived successfully', id: data.id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };

  const restoreHandler = async (req, res) => {
    try {
      const updatePayload = {
        status: 'active',
        archived_at: null,
        archived_by: null,
        archive_reason: null
      };

      const { data, error } = await supabase.from('campaigns').update(updatePayload).eq('id', req.params.id).eq('tenant_id', req.tenantId).eq('status', 'archived').select().maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Archived Campaign not found' });
      
      res.json({ message: 'Campaign restored successfully', id: data.id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };

  router.post('/:id/archive', archiveHandler);
  router.post('/:id/restore', restoreHandler);
  router.delete('/:id', archiveHandler);
  
  return router;
}

module.exports = createCampaignsRouter();
module.exports.createCampaignsRouter = createCampaignsRouter;
