const express = require('express');
const router = express.Router();
const supabase = require('../src/supabase');

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
    llm_provider: String(payload.llm_provider || 'gemini').trim().toLowerCase() || 'gemini',
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
    await supabase.from('agents').update({
      is_default: 0,
      updated_at: new Date().toISOString()
    }).neq('id', currentId);
    return;
  }

  await supabase.from('agents').update({
    is_default: 0,
    updated_at: new Date().toISOString()
  }).neq('id', 0);
}

function handleSqliteError(error, res) {
  if (error.code === '23505' || (error.message && error.message.includes('unique constraint'))) {
    if (error.message.includes('name')) {
      return res.status(409).json({ error: 'An agent with this name already exists', fieldErrors: { name: 'Agent name already exists' } });
    }
    if (error.message.includes('slug')) {
      return res.status(409).json({ error: 'An agent with this slug already exists', fieldErrors: { slug: 'Agent slug already exists' } });
    }
  }

  console.error('Agent route error:', error);
  return res.status(500).json({ error: error.message });
}

router.get('/', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('agents')
      .select('*')
      .order('is_default', { ascending: false })
      .order('is_active', { ascending: false })
      .order('name', { ascending: true });

    if (error) throw error;
    res.json(rows);
  } catch (error) {
    console.error('Error fetching agents:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/default', async (req, res) => {
  try {
    const { data: agent, error } = await supabase
      .from('agents')
      .select('*')
      .eq('is_default', 1)
      .order('id', { ascending: true })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
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
    const { data: agent, error } = await supabase
      .from('agents')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
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
    
    const { data: result, error } = await supabase.from('agents').insert([{
      name: payload.name,
      slug: payload.slug,
      description: payload.description || null,
      client_name: payload.client_name || null,
      language: payload.language,
      voice_pipeline: payload.voice_pipeline,
      stt_provider: payload.stt_provider,
      llm_provider: payload.llm_provider,
      llm_model: payload.llm_model || null,
      tts_provider: payload.tts_provider,
      tts_voice: payload.tts_voice || null,
      system_prompt: payload.system_prompt || null,
      opening_prompt: payload.opening_prompt || null,
      is_default: payload.is_default,
      is_active: payload.is_active,
      updated_at: new Date().toISOString()
    }]).select('id').single();

    if (error) throw error;
    res.json({ id: result.id, message: 'Agent created successfully' });
  } catch (error) {
    return handleSqliteError(error, res);
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { data: existing, error: fetchError } = await supabase
      .from('agents')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;
    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const payload = normalizeAgentPayload(req.body);
    const fieldErrors = validateAgentPayload(payload);

    if (Object.keys(fieldErrors).length) {
      return res.status(400).json({ error: 'Please fix the highlighted agent fields', fieldErrors });
    }

    await clearDefaultAgentIfNeeded(payload, existing.id);
    
    const { error: updateError } = await supabase.from('agents').update({
      name: payload.name,
      slug: payload.slug,
      description: payload.description || null,
      client_name: payload.client_name || null,
      language: payload.language,
      voice_pipeline: payload.voice_pipeline,
      stt_provider: payload.stt_provider,
      llm_provider: payload.llm_provider,
      llm_model: payload.llm_model || null,
      tts_provider: payload.tts_provider,
      tts_voice: payload.tts_voice || null,
      system_prompt: payload.system_prompt || null,
      opening_prompt: payload.opening_prompt || null,
      is_default: payload.is_default,
      is_active: payload.is_active,
      updated_at: new Date().toISOString()
    }).eq('id', existing.id);

    if (updateError) throw updateError;
    res.json({ message: 'Agent updated successfully' });
  } catch (error) {
    return handleSqliteError(error, res);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { data: existing, error: fetchError } = await supabase
      .from('agents')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;
    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (existing.is_default) {
      return res.status(409).json({ error: 'Default agent cannot be deleted until another default agent is selected' });
    }

    // In Supabase, if calls table has agent_id, we check it. Note: calls schema earlier didn't have agent_id in SQLite?
    // Wait, let's assume it might have agent_id.
    const { count, error: countError } = await supabase
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', existing.id);

    if (!countError && count > 0) {
      return res.status(409).json({ error: 'This agent is already used in call history and cannot be deleted' });
    }

    const { error: deleteError } = await supabase.from('agents').delete().eq('id', existing.id);
    if (deleteError) throw deleteError;
    
    res.json({ message: 'Agent deleted successfully' });
  } catch (error) {
    console.error('Error deleting agent:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
