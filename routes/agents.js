const express = require('express');
const router = express.Router();
const { dbRun, dbGet, dbAll } = require('../db');

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function toBooleanFlag(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase()) ? 1 : 0;
}

function normalizeAgentPayload(payload = {}) {
  const name = String(payload.name || '').trim();
  return {
    name,
    slug: slugify(payload.slug || name),
    description: String(payload.description || '').trim(),
    client_name: String(payload.client_name || '').trim(),
    language: String(payload.language || 'hi').trim().toLowerCase() || 'hi',
    voice_pipeline: String(payload.voice_pipeline || 'legacy').trim().toLowerCase() || 'legacy',
    stt_provider: String(payload.stt_provider || 'deepgram').trim().toLowerCase() || 'deepgram',
    llm_provider: String(payload.llm_provider || 'openai').trim().toLowerCase() || 'openai',
    llm_model: String(payload.llm_model || '').trim(),
    tts_provider: String(payload.tts_provider || 'native').trim().toLowerCase() || 'native',
    tts_voice: String(payload.tts_voice || '').trim(),
    system_prompt: String(payload.system_prompt || '').trim(),
    opening_prompt: String(payload.opening_prompt || '').trim(),
    is_default: toBooleanFlag(payload.is_default, 0),
    is_active: toBooleanFlag(payload.is_active, 1)
  };
}

function validateAgentPayload(payload) {
  const fieldErrors = {};

  if (!payload.name) {
    fieldErrors.name = 'Agent name is required';
  } else if (payload.name.length < 2) {
    fieldErrors.name = 'Agent name must be at least 2 characters';
  } else if (payload.name.length > 100) {
    fieldErrors.name = 'Agent name must be 100 characters or fewer';
  }

  if (!payload.slug) {
    fieldErrors.slug = 'Agent slug is required';
  }

  if (!['hi', 'en', 'hinglish', 'mixed'].includes(payload.language)) {
    fieldErrors.language = 'Language must be hi, en, hinglish, or mixed';
  }

  if (!['legacy', 'orchestrated'].includes(payload.voice_pipeline)) {
    fieldErrors.voice_pipeline = 'Voice pipeline must be legacy or orchestrated';
  }

  if (!payload.llm_provider) {
    fieldErrors.llm_provider = 'LLM provider is required';
  }

  if (!payload.system_prompt && payload.language === 'hi') {
    fieldErrors.system_prompt = 'System prompt is required for custom agents';
  }

  if (!payload.opening_prompt) {
    fieldErrors.opening_prompt = 'Opening prompt is required';
  }

  return fieldErrors;
}

async function clearDefaultAgentIfNeeded(payload, currentId = null) {
  if (!payload.is_default) return;
  if (currentId) {
    await dbRun('UPDATE agents SET is_default = 0, updated_at = ? WHERE id != ?', [new Date().toISOString(), currentId]);
    return;
  }

  await dbRun('UPDATE agents SET is_default = 0, updated_at = ?', [new Date().toISOString()]);
}

function handleSqliteError(error, res) {
  if (error.message && error.message.includes('UNIQUE constraint failed: agents.name')) {
    return res.status(409).json({ error: 'An agent with this name already exists', fieldErrors: { name: 'Agent name already exists' } });
  }

  if (error.message && error.message.includes('UNIQUE constraint failed: agents.slug')) {
    return res.status(409).json({ error: 'An agent with this slug already exists', fieldErrors: { slug: 'Agent slug already exists' } });
  }

  console.error('Agent route error:', error);
  return res.status(500).json({ error: error.message });
}

router.get('/', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM agents ORDER BY is_default DESC, is_active DESC, name ASC');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching agents:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/default', async (req, res) => {
  try {
    const agent = await dbGet('SELECT * FROM agents WHERE is_default = 1 ORDER BY id ASC LIMIT 1');
    if (!agent) {
      return res.status(404).json({ error: 'Default agent not found' });
    }

    res.json(agent);
  } catch (error) {
    console.error('Error fetching default agent:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const agent = await dbGet('SELECT * FROM agents WHERE id = ?', [req.params.id]);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json(agent);
  } catch (error) {
    console.error('Error fetching agent:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const payload = normalizeAgentPayload(req.body);
    const fieldErrors = validateAgentPayload(payload);

    if (Object.keys(fieldErrors).length) {
      return res.status(400).json({ error: 'Please fix the highlighted agent fields', fieldErrors });
    }

    await clearDefaultAgentIfNeeded(payload);
    const now = new Date().toISOString();
    const result = await dbRun(
      `INSERT INTO agents (
        name, slug, description, client_name, language, voice_pipeline, stt_provider,
        llm_provider, llm_model, tts_provider, tts_voice, system_prompt, opening_prompt,
        is_default, is_active, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.name,
        payload.slug,
        payload.description || null,
        payload.client_name || null,
        payload.language,
        payload.voice_pipeline,
        payload.stt_provider,
        payload.llm_provider,
        payload.llm_model || null,
        payload.tts_provider,
        payload.tts_voice || null,
        payload.system_prompt || null,
        payload.opening_prompt || null,
        payload.is_default,
        payload.is_active,
        now
      ]
    );

    res.json({ id: result.lastID, message: 'Agent created successfully' });
  } catch (error) {
    return handleSqliteError(error, res);
  }
});

router.put('/:id', async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM agents WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const payload = normalizeAgentPayload(req.body);
    const fieldErrors = validateAgentPayload(payload);

    if (Object.keys(fieldErrors).length) {
      return res.status(400).json({ error: 'Please fix the highlighted agent fields', fieldErrors });
    }

    await clearDefaultAgentIfNeeded(payload, existing.id);
    await dbRun(
      `UPDATE agents
          SET name = ?,
              slug = ?,
              description = ?,
              client_name = ?,
              language = ?,
              voice_pipeline = ?,
              stt_provider = ?,
              llm_provider = ?,
              llm_model = ?,
              tts_provider = ?,
              tts_voice = ?,
              system_prompt = ?,
              opening_prompt = ?,
              is_default = ?,
              is_active = ?,
              updated_at = ?
        WHERE id = ?`,
      [
        payload.name,
        payload.slug,
        payload.description || null,
        payload.client_name || null,
        payload.language,
        payload.voice_pipeline,
        payload.stt_provider,
        payload.llm_provider,
        payload.llm_model || null,
        payload.tts_provider,
        payload.tts_voice || null,
        payload.system_prompt || null,
        payload.opening_prompt || null,
        payload.is_default,
        payload.is_active,
        new Date().toISOString(),
        existing.id
      ]
    );

    res.json({ message: 'Agent updated successfully' });
  } catch (error) {
    return handleSqliteError(error, res);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM agents WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (existing.is_default) {
      return res.status(409).json({ error: 'Default agent cannot be deleted until another default agent is selected' });
    }

    const callsUsingAgent = await dbGet('SELECT COUNT(*) AS count FROM calls WHERE agent_id = ?', [existing.id]);
    if (Number(callsUsingAgent?.count || 0) > 0) {
      return res.status(409).json({ error: 'This agent is already used in call history and cannot be deleted' });
    }

    await dbRun('DELETE FROM agents WHERE id = ?', [existing.id]);
    res.json({ message: 'Agent deleted successfully' });
  } catch (error) {
    console.error('Error deleting agent:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
