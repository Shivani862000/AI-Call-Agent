const { createMediaToken } = require('../src/auth');
const {
  buildIcallMateCallbackUrl,
  redactIcallMateCallbackUrl
} = require('../src/icallmate-webhook');
const logger = require('./system-logger');
const { getIntegrationRuntimeConfig: defaultRuntimeConfigResolver } = require('../src/webmaster/settings-service');

const ICALLMATE_MEDIA_ENDPOINT_UNAVAILABLE = 'ICALLMATE_MEDIA_ENDPOINT_UNAVAILABLE';

function getOutboundEndpoint(settings = {}) {
  return `${String(settings.outboundApiEndpoint || process.env.ICALLMATE_OBD_API_ENDPOINT || 'https://ecp1.icallmate.in').replace(/\/+$/, '')}/OBDAPI/webresources/CreateOBDCampaignPost`;
}

function getDefaultMediaUrl(settings = {}) {
  const configuredUrl = String(settings.masterPostWsUrl || process.env.ICALLMATE_MASTER_POST_WSURL || '').trim();
  if (configuredUrl) {
    return configuredUrl;
  }

  const publicBaseUrl = String(
    process.env.APP_BASE_URL
    || process.env.NGROK_URL
    || process.env.WEBHOOK_URL
    || ''
  ).trim();
  if (!publicBaseUrl) {
    return '';
  }

  return `${publicBaseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:').replace(/\/+$/, '')}/icallmate/media`;
}

function getDefaultCallbackUrl(webhookSecret = null) {
  const publicBaseUrl = String(
    process.env.APP_BASE_URL
    || process.env.NGROK_URL
    || process.env.WEBHOOK_URL
    || ''
  ).trim();
  return publicBaseUrl
    ? buildIcallMateCallbackUrl(publicBaseUrl, {
      ICALLMATE_WEBHOOK_SECRET: webhookSecret || process.env.ICALLMATE_WEBHOOK_SECRET,
      WEBHOOK_SECRET: webhookSecret ? '' : process.env.WEBHOOK_SECRET
    })
    : '';
}

function ensureAuthenticatedMediaUrl(value, settings = {}) {
  const rawUrl = String(value || getDefaultMediaUrl(settings)).trim();
  if (!rawUrl) {
    return '';
  }

  const url = new URL(rawUrl);
  if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('iCallMate media URL must use ws:// or wss://');
  }

  if (!url.searchParams.get('token')) {
    url.searchParams.set('token', createMediaToken());
  }
  return url.toString();
}

function getMediaHealthUrl(value) {
  const mediaUrl = new URL(String(value || '').trim());
  if (!['ws:', 'wss:'].includes(mediaUrl.protocol)) {
    throw new Error('iCallMate media URL must use ws:// or wss://');
  }

  mediaUrl.protocol = mediaUrl.protocol === 'wss:' ? 'https:' : 'http:';
  mediaUrl.pathname = '/health';
  mediaUrl.search = '';
  mediaUrl.hash = '';
  return mediaUrl.toString();
}

async function assertPublicMediaEndpointReachable(mediaUrl, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(Number(options.timeoutMs || 5000) || 5000, 500);
  const healthUrl = getMediaHealthUrl(mediaUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(healthUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error('Public media URL returned a non-success response');
      error.code = 'ICALLMATE_MEDIA_HTTP_ERROR';
      error.status = response.status;
      throw error;
    }
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? `timed out after ${timeoutMs}ms`
      : error?.code === 'ICALLMATE_MEDIA_HTTP_ERROR'
        ? `public URL returned HTTP ${error.status}`
        : 'unreachable';
    const preflightError = new Error(
      `iCallMate media endpoint preflight failed: ${reason}. Keep the public tunnel running before placing calls.`
    );
    preflightError.code = ICALLMATE_MEDIA_ENDPOINT_UNAVAILABLE;
    throw preflightError;
  } finally {
    clearTimeout(timeout);
  }
}

function redactMediaUrlToken(value) {
  const rawUrl = String(value || '').trim();
  if (!rawUrl) {
    return rawUrl;
  }

  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('token')) {
      url.searchParams.set('token', '[redacted]');
    }
    return url.toString();
  } catch (error) {
    return '[invalid-media-url]';
  }
}

function redactRequestPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const copy = JSON.parse(JSON.stringify(payload));
  if (Object.hasOwn(copy, 'ukey')) copy.ukey = '[redacted]';
  if (Array.isArray(copy.msisdnlist)) {
    copy.msisdnlist.forEach((entry) => {
      if (entry?.wsurl) entry.wsurl = redactMediaUrlToken(entry.wsurl);
      if (entry?.callbackapi) entry.callbackapi = redactIcallMateCallbackUrl(entry.callbackapi);
    });
  }
  if (Array.isArray(copy.fieldpairs)) {
    copy.fieldpairs.forEach((entry) => {
      if (entry?.wsurl) entry.wsurl = redactMediaUrlToken(entry.wsurl);
      if (entry?.callbackapi) entry.callbackapi = redactIcallMateCallbackUrl(entry.callbackapi);
    });
  }
  return copy;
}

function getMasterPostEndpoint(settings = {}) {
  return String(settings.masterPostApiEndpoint || process.env.ICALLMATE_MASTER_POST_API_ENDPOINT || 'https://crm.icallmate.in/WebSVC111/setMasterPostAPI').trim();
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function buildOutboundCampaignPayload(customerPhone, customerId, options = {}) {
  const phoneNo = normalizePhone(customerPhone).replace(/^\+/, '');
  if (!phoneNo) {
    throw new Error('Customer phone is required for iCallMate outbound call');
  }

  return {
    sourcetype: String(options.sourcetype || '0'),
    customivr: options.customivr ?? true,
    campaigntype: String(options.campaigntype || '4'),
    filetype: String(options.filetype || '2'),
    ukey: options.ukey || process.env.ICALLMATE_UKEY || '',
    serviceno: options.serviceno || process.env.ICALLMATE_SERVICE_NO || '',
    ivrtemplateid: options.ivrtemplateid || process.env.ICALLMATE_IVR_TEMPLATE_ID || '',
    maxTalkTimeInSec: Number(options.maxTalkTimeInSec ?? process.env.ICALLMATE_MAX_TALK_TIME_SEC ?? 0),
    retryatmpt: String(options.retryatmpt ?? process.env.ICALLMATE_RETRY_ATTEMPT ?? '2'),
    sendnow: String(options.sendnow || '0'),
    schddate: options.schddate || '',
    retryduration: String(options.retryduration ?? process.env.ICALLMATE_RETRY_DURATION ?? '5'),
    s_unique: options.s_unique || (customerId ? `customer-${customerId}-${Date.now()}` : `call-${Date.now()}`),
    msisdnlist: [
      {
        phoneno: phoneNo,
        customer_name: options.customerName || '',
        wsurl: options.wsurl || '',
        agentid: String(options.agentId ?? process.env.ICALLMATE_AGENT_ID ?? '0'),
        botid: String(options.botId ?? process.env.ICALLMATE_BOT_ID ?? '0'),
        extraparam: JSON.stringify({
          callDirection: 'outbound',
          customerId: customerId || null,
          customerName: options.customerName || '',
          clientName: options.clientName || '',
          tenantId: options.tenantId ?? null,
          callType: options.callType || 'REVIEW_CALL'
        }),
        iscallbackapi: String(options.iscallbackapi ?? process.env.ICALLMATE_IS_CALLBACK_API ?? '1'),
        callbackapi: options.callbackapi || ''
      }
    ]
  };
}

function buildMasterPostPayload(customerPhone, leadId, options = {}) {
  const phoneNo = normalizePhone(customerPhone).replace(/^\+91/, '');
  if (!phoneNo) {
    throw new Error('Customer phone is required for iCallMate master-post call');
  }

  const wsurl = options.wsurl || process.env.ICALLMATE_MASTER_POST_WSURL || '';
  const resolvedLeadId = String(leadId || options.leadid || options.leadId || process.env.ICALLMATE_MASTER_POST_LEAD_ID || '1031').replace(/\D/g, '') || '1031';
  return {
    campid: String(options.campid || process.env.ICALLMATE_MASTER_POST_CAMP_ID || '54'),
    leadid: resolvedLeadId,
    fieldpairs: [
      {
        Phone_No: phoneNo,
        Name: options.customerName || '',
        wsurl,
        iscallbackapi: String(options.iscallbackapi ?? process.env.ICALLMATE_IS_CALLBACK_API ?? '1'),
        callbackapi: options.callbackapi || '',
        extraparam: JSON.stringify({
          callDirection: 'outbound',
          customerId: options.customerId || null,
          customerName: options.customerName || '',
          clientName: options.clientName || '',
          tenantId: options.tenantId ?? null,
          callType: options.callType || 'REVIEW_CALL',
          leadId: resolvedLeadId
        })
      }
    ]
  };
}

function extractCallSid(payload, fallback) {
  const parsedSid = (
    payload?.sid
    || payload?.callSid
    || payload?.campaignId
    || payload?.campaignid
    || payload?.data?.sid
    || payload?.data?.campaignId
    || payload?.response?.sid
    || payload?.response?.campaignId
    || null
  );

  return parsedSid || fallback || `icallmate-${Date.now()}`;
}

function hasProviderCallSid(payload) {
  return Boolean(
    payload?.sid
    || payload?.callSid
    || payload?.campaignId
    || payload?.campaignid
    || payload?.data?.sid
    || payload?.data?.campaignId
    || payload?.response?.sid
    || payload?.response?.campaignId
  );
}

function isFailurePayload(payload) {
  const status = String(payload?.status || payload?.Status || '').toLowerCase();
  const statusCode = Number(payload?.statuscode || payload?.statusCode || payload?.code || 0);
  return status === 'failure' || (statusCode >= 400 && statusCode !== 0);
}

async function readProviderResponseText(response) {
  try {
    return await response.text();
  } catch (_error) {
    const error = new Error('iCallMate provider response could not be read');
    error.code = 'ICALLMATE_RESPONSE_READ_FAILED';
    throw error;
  }
}

async function initiateMasterPostCall(customerPhone, customerId, options = {}) {
  const endpoint = getMasterPostEndpoint(options.runtimeSettings);
  const leadId = options.leadid || options.leadId || process.env.ICALLMATE_MASTER_POST_LEAD_ID || '1031';
  const payload = buildMasterPostPayload(customerPhone, leadId, { ...options, customerId });

  if (!payload.fieldpairs[0].wsurl) {
    throw new Error('Missing iCallMate master-post config: wsurl or ICALLMATE_MASTER_POST_WSURL is required.');
  }

  console.log(
    `[ICALLMATE OUTBOUND] Initiating call to ${logger.maskPhone(customerPhone)} provider=masterpost endpoint=${endpoint} ` +
    `campid=${payload.campid} leadid=${payload.leadid}`
  );

  let response;
  try {
    response = await (options.fetchImpl || global.fetch)(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (_error) {
    const error = new Error('iCallMate master-post request failed');
    error.code = 'ICALLMATE_REQUEST_FAILED';
    throw error;
  }
  const rawText = await readProviderResponseText(response);
  let parsed = {};
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch (error) {
    parsed = { rawText };
  }

  if (!response.ok) {
    throw new Error(`iCallMate master-post call failed with HTTP ${response.status}`);
  }

  if (isFailurePayload(parsed)) {
    throw new Error('iCallMate master-post call was rejected by the provider');
  }

  const providerReturnedSid = hasProviderCallSid(parsed);
  const sid = extractCallSid(parsed, `icallmate-masterpost-${payload.leadid}-${Date.now()}`);
  const status = providerReturnedSid ? 'queued' : 'submitted';
  console.log(`[ICALLMATE OUTBOUND] Call ${status} sid=${sid}`);
  return {
    sid,
    status,
    providerReturnedSid
  };
}

async function initiateCall(customerPhone, customerId, options = {}) {
  const getIntegrationRuntimeConfig = options.getIntegrationRuntimeConfig || defaultRuntimeConfigResolver;
  const runtime = await getIntegrationRuntimeConfig('icallmate', options.tenantId ?? null);
  const settings = runtime.settings || {};
  if (settings.enabled === false) {
    const error = new Error('iCallMate integration is disabled');
    error.code = 'INTEGRATION_DISABLED';
    throw error;
  }
  const callbackSecret = runtime.secrets?.webhookSecret || null;
  let callbackapi = options.callbackapi || getDefaultCallbackUrl(callbackSecret);
  if (callbackapi && callbackSecret) {
    const callbackUrl = new URL(callbackapi);
    callbackUrl.searchParams.set('secret', callbackSecret);
    callbackapi = callbackUrl.toString();
  }
  const authenticatedOptions = {
    runtimeSettings: settings,
    fetchImpl: options.fetchImpl || global.fetch,
    ...options,
    ukey: options.ukey ?? runtime.secrets?.ukey ?? '',
    serviceno: options.serviceno ?? settings.serviceNo ?? '',
    ivrtemplateid: options.ivrtemplateid ?? settings.ivrTemplateId ?? '',
    maxTalkTimeInSec: options.maxTalkTimeInSec ?? settings.maxTalkTimeSec,
    retryatmpt: options.retryatmpt ?? settings.retryAttempt,
    retryduration: options.retryduration ?? settings.retryDurationMinutes,
    agentId: options.agentId ?? settings.agentId,
    botId: options.botId ?? settings.botId,
    leadid: options.leadid ?? options.leadId ?? settings.leadId,
    campid: options.campid ?? settings.campaignId,
    iscallbackapi: options.iscallbackapi ?? (settings.callbackEnabled ? '1' : '0'),
    wsurl: ensureAuthenticatedMediaUrl(options.wsurl, settings),
    callbackapi
  };
  await assertPublicMediaEndpointReachable(authenticatedOptions.wsurl, { fetchImpl: authenticatedOptions.fetchImpl });

  const provider = String(authenticatedOptions.provider || settings.outboundProvider || process.env.ICALLMATE_OUTBOUND_PROVIDER || '').toLowerCase();
  if (provider === 'masterpost' || provider === 'master-post') {
    return initiateMasterPostCall(customerPhone, customerId, authenticatedOptions);
  }

  const endpoint = getOutboundEndpoint(settings);
  const payload = buildOutboundCampaignPayload(customerPhone, customerId, authenticatedOptions);

  if (!payload.ukey || !payload.serviceno || !payload.ivrtemplateid) {
    if (settings.masterPostApiEndpoint || settings.masterPostWsUrl || process.env.ICALLMATE_MASTER_POST_API_ENDPOINT || process.env.ICALLMATE_MASTER_POST_WSURL) {
      console.log('[ICALLMATE OUTBOUND] Falling back to masterpost provider due to missing campaign credentials');
      return initiateMasterPostCall(customerPhone, customerId, authenticatedOptions);
    }
    throw new Error('Missing iCallMate outbound config: ICALLMATE_UKEY, ICALLMATE_SERVICE_NO, and ICALLMATE_IVR_TEMPLATE_ID are required.');
  }

  console.log(
    `[ICALLMATE OUTBOUND] Initiating call to ${logger.maskPhone(customerPhone)} endpoint=${endpoint} ` +
    `serviceNo=${payload.serviceno} ivrTemplate=${payload.ivrtemplateid}`
  );

  let response;
  try {
    response = await authenticatedOptions.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (_error) {
    const error = new Error('iCallMate outbound request failed');
    error.code = 'ICALLMATE_REQUEST_FAILED';
    throw error;
  }
  const rawText = await readProviderResponseText(response);
  let parsed = {};
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch (error) {
    parsed = { rawText };
  }

  if (!response.ok) {
    throw new Error(`iCallMate outbound call failed with HTTP ${response.status}`);
  }

  if (isFailurePayload(parsed)) {
    throw new Error('iCallMate outbound call was rejected by the provider');
  }

  const sid = extractCallSid(parsed, payload.s_unique);
  console.log(`[ICALLMATE OUTBOUND] Call accepted sid=${sid}`);
  return {
    sid,
    status: 'queued'
  };
}

module.exports = {
  buildOutboundCampaignPayload,
  buildMasterPostPayload,
  ensureAuthenticatedMediaUrl,
  getMediaHealthUrl,
  assertPublicMediaEndpointReachable,
  ICALLMATE_MEDIA_ENDPOINT_UNAVAILABLE,
  redactMediaUrlToken,
  redactRequestPayload,
  initiateCall,
};
