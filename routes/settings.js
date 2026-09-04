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
/**
 * Turns a rendered prompt back into its template form.
 *
 * The built-in prompt is built by filling values in, so rendering it for the
 * editor would put a literal patient name, greeting and date into the box. Save
 * that and every call greets every patient as "Ankita" at "Good Afternoon".
 * Each value is put back as the placeholder that produced it, longest first so
 * a client name nested inside a longer phrase is not half-replaced.
 */
function toTemplate(text, values) {
  return Object.entries(values)
    .filter(([, value]) => String(value || '').trim())
    .sort((a, b) => String(b[1]).length - String(a[1]).length)
    .reduce((out, [name, value]) => {
      const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return out.replace(new RegExp(`\\b${escaped}\\b`, 'g'), `{{${name}}}`);
    }, String(text || ''));
}

router.get('/scripts/builtin', async (req, res, next) => {
  try {
    const { buildCallTypeSystemPrompt, buildCallTypeOpeningPrompt } = require('../src/prompt-builder');
    const { describeVisit, describeEligibility } = require('../prompts/review-calling.ts');
    const { getGreeting } = require('../utils/greeting');

    const callType = String(req.query.call_type || 'review_call');
    // Rendered with values chosen so they can be put back as placeholders.
    const sampleName = 'Ankita';
    const lastVisitDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const options = { lastVisitDate };

    const values = {
      client_name: process.env.CALL_PROMPT_CLIENT_NAME || 'Apna Blood Centre',
      client_city: process.env.CALL_PROMPT_CLIENT_CITY === undefined ? 'Palwal' : process.env.CALL_PROMPT_CLIENT_CITY,
      patient_name: sampleName,
      greeting: getGreeting(),
      last_visit: describeVisit(lastVisitDate),
      next_eligible: describeEligibility(lastVisitDate)
    };

    res.json({
      call_type: callType,
      opening_prompt: toTemplate(buildCallTypeOpeningPrompt(callType, null, sampleName, options), values),
      system_prompt: toTemplate(buildCallTypeSystemPrompt(callType, null, sampleName, options), values)
    });
  } catch (error) { next(error); }
});

module.exports = router;
