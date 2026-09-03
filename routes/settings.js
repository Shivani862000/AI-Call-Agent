'use strict';

const express = require('express');
const { dbGet, dbRun } = require('../db');
const logger = require('../services/system-logger');
const { createSettingsStore } = require('../src/app-settings');
const { isMailConfigured } = require('../services/mailer');

const settings = createSettingsStore({ dbGet, dbRun });
const { SCRIPT_PLACEHOLDERS, NON_NEGOTIABLE_RULES } = require('../prompts/safety-rules.ts');

const KEYS = new Set(['owner_digest', 'auto_queue', 'call_scripts']);

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    res.json({
      owner_digest: await settings.get('owner_digest'),
      auto_queue: await settings.get('auto_queue'),
      call_scripts: await settings.get('call_scripts'),
      // Shown read-only beside the editor, so whoever writes a script can see
      // what is added to it and does not try to write the rules themselves.
      call_script_help: { placeholders: SCRIPT_PLACEHOLDERS, safety_rules: NON_NEGOTIABLE_RULES },
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

/**
 * The built-in script for a call type, as the agent would receive it.
 *
 * Shown beside the editor so a script is written by adapting the real one
 * rather than from memory, which is how the disclosure got dropped before.
 */
router.get('/scripts/builtin', async (req, res, next) => {
  try {
    const { buildCallTypeSystemPrompt, buildCallTypeOpeningPrompt } = require('../src/prompt-builder');
    const callType = String(req.query.call_type || 'review_call');
    // A sample patient and a donation dated yesterday, so the dates in the
    // preview read the way they will on a call.
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const options = { lastVisitDate: yesterday };

    res.json({
      call_type: callType,
      opening_prompt: buildCallTypeOpeningPrompt(callType, null, 'Ankita', options),
      system_prompt: buildCallTypeSystemPrompt(callType, null, 'Ankita', options)
    });
  } catch (error) { next(error); }
});

module.exports = router;
