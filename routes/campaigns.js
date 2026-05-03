const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../db');

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
    const rows = await dbAll('SELECT * FROM campaign_configs ORDER BY created_at DESC, name ASC');
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

    const result = await dbRun(
      'INSERT INTO campaign_configs (name, service_name, monthly_spend_inr, status) VALUES (?, ?, ?, ?)',
      [payload.name, payload.service_name || null, payload.monthly_spend_inr, payload.status]
    );
    res.json({ id: result.lastID, message: 'Campaign created successfully' });
  } catch (error) {
    console.error('Error creating campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM campaign_configs WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const payload = normalizePayload(req.body);
    if (!payload.name) {
      return res.status(400).json({ error: 'Campaign name is required' });
    }

    await dbRun(
      'UPDATE campaign_configs SET name = ?, service_name = ?, monthly_spend_inr = ?, status = ? WHERE id = ?',
      [payload.name, payload.service_name || null, payload.monthly_spend_inr, payload.status, req.params.id]
    );
    res.json({ message: 'Campaign updated successfully' });
  } catch (error) {
    console.error('Error updating campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM campaign_configs WHERE id = ?', [req.params.id]);
    res.json({ message: 'Campaign deleted successfully' });
  } catch (error) {
    console.error('Error deleting campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
