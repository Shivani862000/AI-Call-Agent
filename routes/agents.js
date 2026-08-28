'use strict';

const express = require('express');
const { supabase } = require('../src/supabase'); // Supabase client

function slugify(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizePayload(payload = {}) {
  const name = String(payload.name || '').trim();
  return {
    name,
    slug: slugify(payload.slug || name),
    description: String(payload.description || '').trim() || null,
    client_name: String(payload.client_name || '').trim() || null,
    language: String(payload.language || 'hi').trim().toLowerCase() || 'hi',
    voice_pipeline: String(payload.voice_pipeline || 'legacy').trim().toLowerCase() || 'legacy',
    stt_provider: String(payload.stt_provider || 'deepgram').trim().toLowerCase() || 'deepgram',
    llm_provider: String(payload.llm_provider || 'gemini').trim().toLowerCase() || 'gemini',
    llm_model: String(payload.llm_model || '').trim() || null,
    tts_provider: String(payload.tts_provider || 'native').trim().toLowerCase() || 'native',
    tts_voice: String(payload.tts_voice || '').trim() || null,
    system_prompt: String(payload.system_prompt || '').trim() || null,
    opening_prompt: String(payload.opening_prompt || '').trim() || null,
    is_default: toBoolean(payload.is_default),
    is_active: toBoolean(payload.is_active, true)
  };
}

function validate(payload) {
  const fieldErrors = {};
  if (!payload.name || payload.name.length < 2 || payload.name.length > 100) fieldErrors.name = !payload.name ? 'Agent name is required' : payload.name.length < 2 ? 'Agent name must be at least 2 characters' : 'Agent name must be 100 characters or fewer';
  if (!payload.slug) fieldErrors.slug = 'Agent slug is required';
  if (!['hi', 'en', 'hinglish', 'mixed'].includes(payload.language)) fieldErrors.language = 'Language must be hi, en, hinglish, or mixed';
  if (!['legacy', 'orchestrated'].includes(payload.voice_pipeline)) fieldErrors.voice_pipeline = 'Voice pipeline must be legacy or orchestrated';
  if (!payload.llm_provider) fieldErrors.llm_provider = 'LLM provider is required';
  if (!payload.system_prompt && payload.language === 'hi') fieldErrors.system_prompt = 'System prompt is required for custom agents';
  if (!payload.opening_prompt) fieldErrors.opening_prompt = 'Opening prompt is required';
  return fieldErrors;
}

function serialize(record) {
  const value = { ...record };
  // Clean up any internal fields if necessary, Supabase returns what we ask
  return value;
}

async function clearDefault(tenantId, currentId) {
  let query = supabase.from('agents').update({ is_default: false }).eq('tenant_id', tenantId).neq('status', 'archived');
  if (currentId) query = query.neq('id', currentId);
  await query;
}

function errorResponse(error, res) {
  if (error.code === '23505') return res.status(409).json({ error: 'An agent with this name or slug already exists' });
  return res.status(500).json({ error: error.message });
}

function activeRecordFilter(query) {
  // We apply this inline using Supabase query builders.
  // Instead of passing a filter object, we chain .eq() and .neq()
}

function createAgentsRouter() {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      let query = supabase.from('agents').select('*').eq('tenant_id', req.tenantId).order('is_default', { ascending: false }).order('is_active', { ascending: false }).order('name', { ascending: true });
      
      if (req.query.status) {
        query = query.eq('status', req.query.status);
      } else {
        query = query.neq('status', 'archived');
      }

      const { data, error } = await query;
      if (error) throw error;
      res.json((data || []).map(serialize));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  router.get('/default', async (req, res) => {
    try {
      const { data, error } = await supabase.from('agents').select('*').eq('tenant_id', req.tenantId).eq('is_default', true).neq('status', 'archived').order('id', { ascending: true }).limit(1).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Default agent not found' });
      res.json(serialize(data));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const { data, error } = await supabase.from('agents').select('*').eq('id', req.params.id).eq('tenant_id', req.tenantId).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Agent not found' });
      
      // If client requests exclude archived:
      if (!req.query.status && data.status === 'archived') {
         return res.status(404).json({ error: 'Agent not found' });
      }

      res.json(serialize(data));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  router.post('/', async (req, res) => {
    try {
      const payload = normalizePayload(req.body);
      const fieldErrors = validate(payload);
      if (Object.keys(fieldErrors).length) return res.status(400).json({ error: 'Please fix the highlighted agent fields', fieldErrors });
      
      if (payload.is_default) await clearDefault(req.tenantId);
      
      const insertPayload = { ...payload, tenant_id: req.tenantId, status: 'active' };
      const { data, error } = await supabase.from('agents').insert([insertPayload]).select().single();
      
      if (error) throw error;
      res.json({ id: String(data.id), message: 'Agent created successfully' });
    } catch (error) { errorResponse(error, res); }
  });

  router.put('/:id', async (req, res) => {
    try {
      const payload = normalizePayload(req.body);
      const fieldErrors = validate(payload);
      if (Object.keys(fieldErrors).length) return res.status(400).json({ error: 'Please fix the highlighted agent fields', fieldErrors });
      
      const { data: existing, error: findError } = await supabase.from('agents').select('id').eq('id', req.params.id).eq('tenant_id', req.tenantId).neq('status', 'archived').maybeSingle();
      if (findError) throw findError;
      if (!existing) return res.status(404).json({ error: 'Agent not found' });

      const { data, error } = await supabase.from('agents').update(payload).eq('id', req.params.id).eq('tenant_id', req.tenantId).neq('status', 'archived').select().single();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Agent not found' });
      
      if (payload.is_default) await clearDefault(req.tenantId, req.params.id);
      res.json({ message: 'Agent updated successfully' });
    } catch (error) { errorResponse(error, res); }
  });

  // Archive Handler
  const archiveHandler = async (req, res) => {
    try {
      const username = req.adminSession?.username || req.user?.username || 'system';
      const updatePayload = {
        status: 'archived',
        archived_at: new Date().toISOString(),
        archived_by: username,
        archive_reason: (req.body?.reason || '').substring(0, 500) || null
      };

      const { data, error } = await supabase.from('agents').update(updatePayload).eq('id', req.params.id).eq('tenant_id', req.tenantId).neq('status', 'archived').select().maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Agent not found or already archived' });
      
      res.json({ message: 'Agent archived successfully', id: data.id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };

  // Restore Handler
  const restoreHandler = async (req, res) => {
    try {
      const updatePayload = {
        status: 'active',
        archived_at: null,
        archived_by: null,
        archive_reason: null
      };

      const { data, error } = await supabase.from('agents').update(updatePayload).eq('id', req.params.id).eq('tenant_id', req.tenantId).eq('status', 'archived').select().maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Archived Agent not found' });
      
      res.json({ message: 'Agent restored successfully', id: data.id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };

  router.post('/:id/archive', archiveHandler);
  router.post('/:id/restore', restoreHandler);
  router.delete('/:id', archiveHandler);
  
  return router;
}

module.exports = createAgentsRouter();
module.exports.createAgentsRouter = createAgentsRouter;
