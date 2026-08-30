'use strict';

const express = require('express');
const { dbGet, dbRun } = require('../db');
const logger = require('../services/system-logger');
const { createSettingsStore } = require('../src/app-settings');
const { isMailConfigured } = require('../services/mailer');

const settings = createSettingsStore({ dbGet, dbRun });
const KEYS = new Set(['owner_digest', 'auto_queue']);

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    res.json({
      owner_digest: await settings.get('owner_digest'),
      auto_queue: await settings.get('auto_queue'),
      // The screen needs to explain *why* the digest cannot send, rather than
      // letting someone switch it on and wonder where the mail went.
      mail_configured: isMailConfigured()
    });
  } catch (error) { next(error); }
});

router.put('/:key', async (req, res, next) => {
  try {
    const key = String(req.params.key);
    if (!KEYS.has(key)) return res.status(404).json({ error: 'Unknown setting' });

    const saved = await settings.set(key, req.body, req.adminSession?.username);
    logger.warn('SETTINGS_UPDATED', { setting: key, by: req.adminSession?.username });
    res.json({ [key]: saved });
  } catch (error) {
    if (error.statusCode === 400) return res.status(400).json({ error: error.message });
    next(error);
  }
});

/** Sends the digest immediately to the configured recipients. */
router.post('/digest/test', async (req, res, next) => {
  try {
    const { sendOwnerDigest } = require('../src/scheduler');
    const result = await sendOwnerDigest({ force: true });
    if (!result.sent) return res.status(400).json({ error: `Not sent — ${result.reason}` });
    res.json({ success: true, accepted: result.accepted });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/** Shows what would be sent, without sending it. */
router.get('/digest/preview', async (req, res, next) => {
  try {
    const { buildDigestBody } = require('../src/scheduler');
    res.json({ body: await buildDigestBody() });
  } catch (error) { next(error); }
});

module.exports = router;
