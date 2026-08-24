'use strict';

const express = require('express');
const Agent = require('../src/models/Agent');
const { activeRecordFilter, recordFilterFromRequest, createMongooseArchiveHandlers } = require('../src/webmaster/lifecycle');

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
  const value = record?.toObject ? record.toObject() : { ...record };
  if (value._id !== undefined) value.id = String(value._id);
  delete value._id;
  delete value.archived_by;
  return value;
}

async function clearDefault(Model, tenantId, currentId) {
  const filter = activeRecordFilter({ tenantId });
  if (currentId) filter._id = { $ne: currentId };
  await Model.updateMany(filter, { $set: { is_default: false } });
}

function errorResponse(error, res) {
  if (error.code === 11000) return res.status(409).json({ error: 'An agent with this name or slug already exists' });
  return res.status(500).json({ error: error.message });
}

function createAgentsRouter({ Model = Agent } = {}) {
  const router = express.Router();
  const archiveHandlers = createMongooseArchiveHandlers({ Model, resourceName: 'Agent' });

  router.get('/', async (req, res) => {
    try {
      const rows = await Model.find(recordFilterFromRequest(req, { tenantId: req.tenantId })).sort({ is_default: -1, is_active: -1, name: 1 }).lean();
      res.json(rows.map(serialize));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  router.get('/default', async (req, res) => {
    try {
      const row = await Model.findOne(activeRecordFilter({ tenantId: req.tenantId, is_default: true })).sort({ _id: 1 }).lean();
      if (!row) return res.status(404).json({ error: 'Default agent not found' });
      res.json(serialize(row));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const row = await Model.findOne(recordFilterFromRequest(req, { _id: req.params.id, tenantId: req.tenantId })).lean();
      if (!row) return res.status(404).json({ error: 'Agent not found' });
      res.json(serialize(row));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  router.post('/', async (req, res) => {
    try {
      const payload = normalizePayload(req.body);
      const fieldErrors = validate(payload);
      if (Object.keys(fieldErrors).length) return res.status(400).json({ error: 'Please fix the highlighted agent fields', fieldErrors });
      if (payload.is_default) await clearDefault(Model, req.tenantId);
      const record = await Model.create({ ...payload, tenantId: req.tenantId, status: 'active' });
      res.json({ id: String(record._id), message: 'Agent created successfully' });
    } catch (error) { errorResponse(error, res); }
  });

  router.put('/:id', async (req, res) => {
    try {
      const payload = normalizePayload(req.body);
      const fieldErrors = validate(payload);
      if (Object.keys(fieldErrors).length) return res.status(400).json({ error: 'Please fix the highlighted agent fields', fieldErrors });
      const targetFilter = activeRecordFilter({ _id: req.params.id, tenantId: req.tenantId });
      const existing = await Model.findOne(targetFilter).lean();
      if (!existing) return res.status(404).json({ error: 'Agent not found' });
      const record = await Model.findOneAndUpdate(targetFilter, { $set: payload }, { new: true, runValidators: true });
      if (!record) return res.status(404).json({ error: 'Agent not found' });
      if (payload.is_default) await clearDefault(Model, req.tenantId, req.params.id);
      res.json({ message: 'Agent updated successfully' });
    } catch (error) { errorResponse(error, res); }
  });

  router.post('/:id/archive', archiveHandlers.archive);
  router.post('/:id/restore', archiveHandlers.restore);
  router.delete('/:id', archiveHandlers.archive);
  return router;
}

module.exports = createAgentsRouter();
module.exports.createAgentsRouter = createAgentsRouter;
