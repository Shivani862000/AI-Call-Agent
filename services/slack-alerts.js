'use strict';

/**
 * Operational alerts to Slack.
 *
 * Two rules shape this. Alerts must never carry patient data -- Slack is a
 * third party and a chat history is forever -- so every detail goes through the
 * same sanitiser the system log uses, which redacts names, phones, transcripts
 * and prompts. And alerting must never break the thing it is watching: a Slack
 * outage, a bad webhook or a flood of repeated errors has to degrade quietly.
 *
 * Injected dependencies rather than imports, so this can be tested without a
 * network and without a clock, and so it cannot form a cycle with the logger.
 */
function createSlackAlerter({
  webhookUrl = '',
  fetchImpl = global.fetch,
  sanitize = (details) => details,
  now = () => Date.now(),
  // A repeated identical event is worth knowing about once, not fifty times.
  repeatCooldownMs = 15 * 60 * 1000,
  // A hard ceiling, so a failure loop cannot turn into a Slack flood.
  maxPerWindow = 20,
  windowMs = 60 * 60 * 1000,
  logger = console
} = {}) {
  const lastSentAt = new Map();
  const suppressed = new Map();
  let windowStartedAt = now();
  let sentThisWindow = 0;

  function withinRateLimit() {
    const current = now();
    if (current - windowStartedAt >= windowMs) {
      windowStartedAt = current;
      sentThisWindow = 0;
    }
    return sentThisWindow < maxPerWindow;
  }

  function formatDetails(details) {
    const clean = sanitize(details || {});
    const parts = Object.entries(clean)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
    return parts.join(' ');
  }

  return async function alert({ level = 'ERROR', event = 'UNKNOWN', details = {} } = {}) {
    if (!webhookUrl || typeof fetchImpl !== 'function') return { delivered: false, skipped: true };

    const key = `${level}:${event}`;
    const current = now();
    const last = lastSentAt.get(key);

    if (last !== undefined && current - last < repeatCooldownMs) {
      suppressed.set(key, (suppressed.get(key) || 0) + 1);
      return { delivered: false, suppressed: true };
    }

    if (!withinRateLimit()) {
      suppressed.set(key, (suppressed.get(key) || 0) + 1);
      return { delivered: false, rateLimited: true };
    }

    const repeats = suppressed.get(key) || 0;
    suppressed.delete(key);
    lastSentAt.set(key, current);
    sentThisWindow += 1;

    const body = formatDetails(details);
    const text = [
      `:rotating_light: *${level}* ${event}`,
      body || null,
      repeats ? `_(${repeats} further occurrence${repeats === 1 ? '' : 's'} suppressed since the last alert)_` : null
    ].filter(Boolean).join('\n');

    try {
      const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!response.ok) throw new Error(`Slack returned ${response.status}`);
      return { delivered: true, repeats };
    } catch (error) {
      // Deliberately swallowed. This is called from the logger, and an alerting
      // failure that threw would take out the code path it was reporting on.
      logger.warn?.('[SLACK_ALERT_FAILED]', { event, message: error.message });
      return { delivered: false, error: error.message };
    }
  };
}

module.exports = { createSlackAlerter };
