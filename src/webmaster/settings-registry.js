'use strict';

function setting(type, fallback, options = {}) {
  const normalized = { type, fallback, ...options };
  for (const key of ['env', 'values', 'items', 'protocols']) {
    if (Array.isArray(normalized[key])) normalized[key] = Object.freeze([...normalized[key]]);
  }
  if (Array.isArray(fallback)) normalized.fallback = Object.freeze([...fallback]);
  return Object.freeze(normalized);
}

const SETTING_DEFINITIONS = Object.freeze({
  'application.name': setting('string', 'AI Call Agent', { env: ['APPLICATION_NAME'], minLength: 1, maxLength: 120 }),
  'application.supportEmail': setting('email', '', { env: ['SUPPORT_EMAIL'], maxLength: 254 }),
  'application.supportPhone': setting('string', '', { env: ['SUPPORT_PHONE'], maxLength: 32 }),
  'defaults.timezone': setting('timezone', 'UTC', { env: ['DEFAULT_TIMEZONE', 'TZ'], tenantOverridable: true }),
  'defaults.dailyReportTime': setting('time', '19:00', { env: ['DEFAULT_DAILY_REPORT_TIME'], tenantOverridable: true }),
  'defaults.limits.maxUsers': setting('integer', 25, { env: ['DEFAULT_MAX_USERS'], min: 1, max: 100000, tenantOverridable: true }),
  'defaults.limits.maxConcurrentCalls': setting('integer', 5, { env: ['DEFAULT_MAX_CONCURRENT_CALLS'], min: 0, max: 10000, tenantOverridable: true }),
  'defaults.limits.maxCallsPerDay': setting('integer', 1000, { env: ['DEFAULT_MAX_CALLS_PER_DAY'], min: 0, max: 10000000, tenantOverridable: true }),
  'maintenance.enabled': setting('boolean', false, { env: ['MAINTENANCE_MODE'] }),
  'maintenance.message': setting('string', 'Service is temporarily unavailable for maintenance.', { env: ['MAINTENANCE_MESSAGE'], minLength: 1, maxLength: 500 }),
  'featureFlags.outboundCalling': setting('boolean', true, { env: ['FEATURE_OUTBOUND_CALLING'], tenantOverridable: true }),
  'featureFlags.incomingCalling': setting('boolean', true, { env: ['FEATURE_INCOMING_CALLING'], tenantOverridable: true }),
  'featureFlags.dailyReports': setting('boolean', true, { env: ['FEATURE_DAILY_REPORTS'], tenantOverridable: true }),
  'featureFlags.supportTickets': setting('boolean', true, { env: ['FEATURE_SUPPORT_TICKETS'], tenantOverridable: true }),
  'policies.password.minLength': setting('integer', 12, { env: ['PASSWORD_MIN_LENGTH'], min: 8, max: 128 }),
  'policies.password.maxLength': setting('integer', 128, { env: ['PASSWORD_MAX_LENGTH'], min: 32, max: 1024 }),
  'policies.session.maxAgeMinutes': setting('integer', 480, { env: ['SESSION_MAX_AGE_MINUTES'], min: 5, max: 43200 }),
  'policies.rateLimits.loginPer15Minutes': setting('integer', 10, { env: ['LOGIN_RATE_LIMIT'], min: 1, max: 10000 }),
  'policies.rateLimits.apiPerMinute': setting('integer', 60, { env: ['API_RATE_LIMIT'], min: 1, max: 100000 }),
  'policies.rateLimits.webhookPerMinute': setting('integer', 300, { env: ['WEBHOOK_RATE_LIMIT'], min: 1, max: 100000 }),
  'notificationTemplates.tenantSuspended.subject': setting('string', 'Your account has been suspended', { minLength: 1, maxLength: 200 }),
  'notificationTemplates.tenantSuspended.body': setting('string', 'Your organization account is currently suspended. Contact support for assistance.', { minLength: 1, maxLength: 4000 }),
  'notificationTemplates.tenantRestored.subject': setting('string', 'Your account has been restored', { minLength: 1, maxLength: 200 }),
  'notificationTemplates.tenantRestored.body': setting('string', 'Your organization account has been restored.', { minLength: 1, maxLength: 4000 }),
  'notificationTemplates.tenantArchived.subject': setting('string', 'Your account has been archived', { minLength: 1, maxLength: 200 }),
  'notificationTemplates.tenantArchived.body': setting('string', 'Your organization account has been archived and retained.', { minLength: 1, maxLength: 4000 }),
  'retention.customers.archiveAfterDays': setting('integer', 365, { env: ['CUSTOMER_ARCHIVE_AFTER_DAYS'], min: 1, max: 36500 }),
  'retention.calls.archiveAfterDays': setting('integer', 365, { env: ['CALL_ARCHIVE_AFTER_DAYS'], min: 1, max: 36500 }),
  'retention.feedback.archiveAfterDays': setting('integer', 365, { env: ['FEEDBACK_ARCHIVE_AFTER_DAYS'], min: 1, max: 36500 }),
  'retention.audit.classification': setting('enum', 'retained', { values: ['retained', 'cold-retained'] }),
  'providers.supported.ai': setting('array', ['gemini', 'gemini-live'], { items: ['gemini', 'gemini-live'] }),
  'providers.supported.calling': setting('array', ['icallmate'], { items: ['icallmate'] }),
  'providers.supported.transcription': setting('array', ['deepgram'], { items: ['deepgram'] }),
  'providers.supported.email': setting('array', ['smtp'], { items: ['smtp'] }),
  'providers.supported.notifications': setting('array', ['slack', 'webhook'], { items: ['slack', 'webhook'] })
});

const INTEGRATION_DEFINITIONS = Object.freeze({
  icallmate: Object.freeze({
    settings: Object.freeze({
      enabled: setting('boolean', true, { env: ['ICALLMATE_ENABLED'] }),
      outboundProvider: setting('enum', 'campaign', { env: ['ICALLMATE_OUTBOUND_PROVIDER'], values: ['campaign', 'masterpost', 'master-post'], tenantOverridable: true }),
      outboundApiEndpoint: setting('url', 'https://ecp1.icallmate.in', { env: ['ICALLMATE_OBD_API_ENDPOINT'] }),
      incomingApiEndpoint: setting('url', 'https://crm.icallmate.in', { env: ['ICALLMATE_IBD_API_ENDPOINT'] }),
      masterPostApiEndpoint: setting('url', 'https://crm.icallmate.in/WebSVC111/setMasterPostAPI', { env: ['ICALLMATE_MASTER_POST_API_ENDPOINT'] }),
      masterPostWsUrl: setting('url', '', { env: ['ICALLMATE_MASTER_POST_WSURL'], protocols: ['ws:', 'wss:'], tenantOverridable: true, allowEmpty: true }),
      did: setting('string', '8037259753', { env: ['ICALLMATE_DID'], maxLength: 64, tenantOverridable: true }),
      testNumber: setting('string', '+918037259753', { env: ['ICALLMATE_TEST_NUMBER'], maxLength: 64 }),
      serviceNo: setting('string', '', { env: ['ICALLMATE_SERVICE_NO'], maxLength: 128, tenantOverridable: true }),
      ivrTemplateId: setting('string', '', { env: ['ICALLMATE_IVR_TEMPLATE_ID'], maxLength: 128, tenantOverridable: true }),
      agentId: setting('string', '0', { env: ['ICALLMATE_AGENT_ID'], maxLength: 128, tenantOverridable: true }),
      botId: setting('string', '0', { env: ['ICALLMATE_BOT_ID'], maxLength: 128, tenantOverridable: true }),
      leadId: setting('string', '1031', { env: ['ICALLMATE_MASTER_POST_LEAD_ID'], maxLength: 128, tenantOverridable: true }),
      campaignId: setting('string', '54', { env: ['ICALLMATE_MASTER_POST_CAMP_ID'], maxLength: 128, tenantOverridable: true }),
      maxTalkTimeSec: setting('integer', 0, { env: ['ICALLMATE_MAX_TALK_TIME_SEC'], min: 0, max: 86400, tenantOverridable: true }),
      retryAttempt: setting('integer', 2, { env: ['ICALLMATE_RETRY_ATTEMPT'], min: 0, max: 20, tenantOverridable: true }),
      retryDurationMinutes: setting('integer', 5, { env: ['ICALLMATE_RETRY_DURATION'], min: 0, max: 10080, tenantOverridable: true }),
      callbackEnabled: setting('boolean', true, { env: ['ICALLMATE_IS_CALLBACK_API'], tenantOverridable: true })
    }),
    secrets: Object.freeze({
      ukey: Object.freeze({ env: ['ICALLMATE_UKEY'] }),
      webhookSecret: Object.freeze({ env: ['ICALLMATE_WEBHOOK_SECRET', 'WEBHOOK_SECRET'] }),
      mediaSharedSecret: Object.freeze({ env: ['ICALLMATE_MEDIA_SHARED_SECRET'] })
    })
  }),
  gemini: Object.freeze({
    settings: Object.freeze({
      enabled: setting('boolean', true, { env: ['GEMINI_ENABLED'], tenantOverridable: true }),
      provider: setting('enum', 'gemini', { env: ['AI_PROVIDER', 'LLM_PROVIDER'], values: ['gemini', 'gemini-live'], tenantOverridable: true }),
      model: setting('string', 'gemini-2.5-flash', { env: ['GEMINI_MODEL'], minLength: 1, maxLength: 160, tenantOverridable: true }),
      voice: setting('string', 'Kore', { env: ['GEMINI_VOICE'], minLength: 1, maxLength: 80, tenantOverridable: true }),
      temperature: setting('number', 0.3, { env: ['GEMINI_TEMPERATURE', 'LIVE_TEMPERATURE'], min: 0, max: 2, tenantOverridable: true }),
      maxOutputTokens: setting('integer', 180, { env: ['GEMINI_MAX_OUTPUT_TOKENS', 'LIVE_MAX_RESPONSE_TOKENS'], min: 24, max: 65536, tenantOverridable: true }),
      thinkingBudget: setting('integer', 0, { env: ['GEMINI_THINKING_BUDGET'], min: 0, max: 65536, tenantOverridable: true }),
      liveThinkingLevel: setting('enum', 'minimal', { env: ['GEMINI_LIVE_THINKING_LEVEL'], values: ['minimal', 'low', 'medium', 'high'], tenantOverridable: true }),
      liveSilenceDurationMs: setting('integer', 600, { env: ['GEMINI_LIVE_SILENCE_DURATION_MS'], min: 100, max: 10000, tenantOverridable: true }),
      livePrefixPaddingMs: setting('integer', 100, { env: ['GEMINI_LIVE_PREFIX_PADDING_MS'], min: 20, max: 5000, tenantOverridable: true }),
      liveDirectAudio: setting('boolean', false, { env: ['GEMINI_LIVE_DIRECT_AUDIO'], tenantOverridable: true })
    }),
    secrets: Object.freeze({ apiKey: Object.freeze({ env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] }) })
  }),
  deepgram: Object.freeze({
    settings: Object.freeze({
      enabled: setting('boolean', true, { env: ['DEEPGRAM_ENABLED'], tenantOverridable: true }),
      listenModel: setting('string', 'nova-2', { env: ['DEEPGRAM_LISTEN_MODEL'], minLength: 1, maxLength: 120, tenantOverridable: true }),
      ttsModel: setting('string', 'aura-2-thalia-en', { env: ['DEEPGRAM_TTS_MODEL'], minLength: 1, maxLength: 120, tenantOverridable: true }),
      language: setting('string', 'hi', { env: ['DEEPGRAM_LANGUAGE'], minLength: 2, maxLength: 20, tenantOverridable: true }),
      endpointingMs: setting('integer', 220, { env: ['DEEPGRAM_ENDPOINTING_MS'], min: 80, max: 10000, tenantOverridable: true }),
      finalFlushMs: setting('integer', 180, { env: ['DEEPGRAM_FINAL_FLUSH_MS'], min: 50, max: 10000, tenantOverridable: true })
    }),
    secrets: Object.freeze({ apiKey: Object.freeze({ env: ['DEEPGRAM_API_KEY'] }) })
  }),
  smtp: Object.freeze({
    settings: Object.freeze({
      enabled: setting('boolean', true, { env: ['SMTP_ENABLED'] }),
      host: setting('string', 'smtp.gmail.com', { env: ['SMTP_HOST'], minLength: 1, maxLength: 255 }),
      port: setting('integer', 587, { env: ['SMTP_PORT'], min: 1, max: 65535 }),
      secure: setting('boolean', false, { env: ['SMTP_SECURE'] }),
      user: setting('string', '', { env: ['SMTP_USER'], maxLength: 320 }),
      fromName: setting('string', 'AI Call Agent', { env: ['SMTP_FROM_NAME'], minLength: 1, maxLength: 120, tenantOverridable: true }),
      fromAddress: setting('email', '', { env: ['SMTP_FROM_ADDRESS', 'SMTP_USER'], maxLength: 254, tenantOverridable: true })
    }),
    secrets: Object.freeze({ password: Object.freeze({ env: ['SMTP_PASS'] }) })
  }),
  slack: Object.freeze({
    settings: Object.freeze({
      enabled: setting('boolean', true, { env: ['SLACK_SUPPORT_ENABLED'], tenantOverridable: true }),
      accountLabel: setting('string', '', { env: ['SLACK_ACCOUNT_LABEL'], maxLength: 120 })
    }),
    secrets: Object.freeze({ supportWebhookUrl: Object.freeze({ env: ['SLACK_SUPPORT_WEBHOOK_URL'] }) })
  }),
  webhook: Object.freeze({
    settings: Object.freeze({
      enabled: setting('boolean', true, { env: ['WEBHOOKS_ENABLED'], tenantOverridable: true }),
      endpoint: setting('url', '', { env: ['OUTBOUND_WEBHOOK_URL'], allowEmpty: true, tenantOverridable: true }),
      timeoutMs: setting('integer', 5000, { env: ['WEBHOOK_TIMEOUT_MS'], min: 100, max: 120000, tenantOverridable: true })
    }),
    secrets: Object.freeze({ signingSecret: Object.freeze({ env: ['WEBHOOK_SIGNING_SECRET', 'WEBHOOK_SECRET'] }) })
  })
});

const overridableKeys = new Set(
  Object.entries(SETTING_DEFINITIONS)
    .filter(([, definition]) => definition.tenantOverridable)
    .map(([path]) => path)
);

for (const [integration, definition] of Object.entries(INTEGRATION_DEFINITIONS)) {
  for (const [key, field] of Object.entries(definition.settings)) {
    if (field.tenantOverridable) overridableKeys.add(`providers.${integration}.${key}`);
  }
}

const OVERRIDABLE_KEYS = Object.freeze({
  has: (key) => overridableKeys.has(key),
  get size() { return overridableKeys.size; },
  values: () => overridableKeys.values(),
  [Symbol.iterator]: () => overridableKeys[Symbol.iterator]()
});

function environmentKeyForSecret(integration, key) {
  return INTEGRATION_DEFINITIONS[integration]?.secrets?.[key]?.env?.[0] || null;
}

module.exports = {
  SETTING_DEFINITIONS,
  INTEGRATION_DEFINITIONS,
  OVERRIDABLE_KEYS,
  environmentKeyForSecret
};
