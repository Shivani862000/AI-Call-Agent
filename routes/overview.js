const express = require('express');
const router = express.Router();
const logger = require('../services/system-logger');
const {
  RANGES,
  buildOverview,
  hideAttentionItem,
  unhideAttentionItem,
  isAttentionKey
} = require('../services/overview');

router.get('/', async (req, res) => {
  const range = RANGES.includes(req.query.range) ? req.query.range : '24h';
  try {
    res.json(await buildOverview({ range, role: req.adminSession?.role }));
  } catch (error) {
    console.error('[OVERVIEW ERROR]', error.message);
    res.status(500).json({ error: 'Could not load the overview' });
  }
});

// POST rather than DELETE for unhide: every DELETE under /api is admin-only
// (src/authorization.js), and hiding is open to agents, so undoing it must be too.
router.post('/attention/hide', async (req, res) => {
  const key = String(req.body?.key || '');
  if (!isAttentionKey(key)) return res.status(400).json({ error: 'Unknown attention item' });
  try {
    await hideAttentionItem(key, req.adminSession?.username);
    logger.info('OVERVIEW_ITEM_HIDDEN', { key, by: req.adminSession?.username || null });
    res.json({ success: true });
  } catch (error) {
    console.error('[OVERVIEW HIDE ERROR]', error.message);
    res.status(500).json({ error: 'Could not hide the item' });
  }
});

router.post('/attention/unhide', async (req, res) => {
  const key = String(req.body?.key || '');
  if (!isAttentionKey(key)) return res.status(400).json({ error: 'Unknown attention item' });
  try {
    await unhideAttentionItem(key);
    logger.info('OVERVIEW_ITEM_UNHIDDEN', { key, by: req.adminSession?.username || null });
    res.json({ success: true });
  } catch (error) {
    console.error('[OVERVIEW UNHIDE ERROR]', error.message);
    res.status(500).json({ error: 'Could not unhide the item' });
  }
});

module.exports = router;
