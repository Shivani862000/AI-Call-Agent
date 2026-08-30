const express = require('express');
const router = express.Router();
const supabase = require('../src/supabase');

function normalizePayload(payload = {}) {
  return {
    name: String(payload.name || '').trim(),
    service_name: String(payload.service_name || '').trim(),
    monthly_spend_inr: Number(payload.monthly_spend_inr || 0) || 0,
    status: String(payload.status || 'active').trim().toLowerCase() || 'active'
  };
}

router.get('/', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('campaign_configs')
      .select('*')
      .order('created_at', { ascending: false })
      .order('name', { ascending: true });
    if (error) throw error;
    res.json(rows);
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const payload = normalizePayload(req.body);
    if (!payload.name) {
      return res.status(400).json({ error: 'Campaign name is required' });
    }

    const { data: result, error } = await supabase.from('campaign_configs').insert([{
      name: payload.name,
      service_name: payload.service_name || null,
      monthly_spend_inr: payload.monthly_spend_inr,
      status: payload.status
    }]).select('id').single();

    if (error) throw error;
    res.json({ id: result.id, message: 'Campaign created successfully' });
  } catch (error) {
    console.error('Error creating campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { data: existing, error: fetchError } = await supabase
      .from('campaign_configs')
      .select('*')
      .eq('id', req.params.id)
      .single();
      
    if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;
    if (!existing) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const payload = normalizePayload(req.body);
    if (!payload.name) {
      return res.status(400).json({ error: 'Campaign name is required' });
    }

    const { error: updateError } = await supabase.from('campaign_configs').update({
      name: payload.name,
      service_name: payload.service_name || null,
      monthly_spend_inr: payload.monthly_spend_inr,
      status: payload.status
    }).eq('id', req.params.id);

    if (updateError) throw updateError;
    res.json({ message: 'Campaign updated successfully' });
  } catch (error) {
    console.error('Error updating campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('campaign_configs').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Campaign deleted successfully' });
  } catch (error) {
    console.error('Error deleting campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
