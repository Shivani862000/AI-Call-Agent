const { createMediaToken } = require('../src/auth');
const {
  buildIcallMateCallbackUrl,
  redactIcallMateCallbackUrl
} = require('../src/icallmate-webhook');
const logger = require('./system-logger');

const ICALLMATE_MEDIA_ENDPOINT_UNAVAILABLE = 'ICALLMATE_MEDIA_ENDPOINT_UNAVAILABLE';

function getOutboundEndpoint() {
  return `${String(process.env.ICALLMATE_OBD_API_ENDPOINT || 'https://ecp1.icallmate.in').replace(/\/+$/, '')}/OBDAPI/webresources/CreateOBDCampaignPost`;
}

function getDefaultMediaUrl() {
  const configuredUrl = String(process.env.ICALLMATE_MASTER_POST_WSURL || '').trim();
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

function getDefaultCallbackUrl() {
  const publicBaseUrl = String(
    process.env.APP_BASE_URL
    || process.env.NGROK_URL
    || process.env.WEBHOOK_URL
    || ''
  ).trim();
  return publicBaseUrl ? buildIcallMateCallbackUrl(publicBaseUrl) : '';
}

function ensureAuthenticatedMediaUrl(value) {
  const rawUrl = String(value || getDefaultMediaUrl()).trim();
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
      throw new Error(`public URL returned HTTP ${response.status}`);
    }
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? `timed out after ${timeoutMs}ms`
      : String(error?.message || 'unreachable');
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

function getMasterPostEndpoint() {
  return String(process.env.ICALLMATE_MASTER_POST_API_ENDPOINT || 'https://crm.icallmate.in/WebSVC111/setMasterPostAPI').trim();
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
    maxTalkTimeInSec: Number(options.maxTalkTimeInSec || process.env.ICALLMATE_MAX_TALK_TIME_SEC || 0),
    retryatmpt: String(options.retryatmpt || process.env.ICALLMATE_RETRY_ATTEMPT || '2'),
    sendnow: String(options.sendnow || '0'),
    schddate: options.schddate || '',
    retryduration: String(options.retryduration || process.env.ICALLMATE_RETRY_DURATION || '5'),
    s_unique: options.s_unique || (customerId ? `customer-${customerId}-${Date.now()}` : `call-${Date.now()}`),
    msisdnlist: [
      {
        phoneno: phoneNo,
        customer_name: options.customerName || '',
        wsurl: options.wsurl || '',
        agentid: String(options.agentId || process.env.ICALLMATE_AGENT_ID || '0'),
        botid: String(options.botId || process.env.ICALLMATE_BOT_ID || '0'),
        extraparam: JSON.stringify({
          callDirection: 'outbound',
          customerId: customerId || null,
          customerName: options.customerName || '',
          clientName: options.clientName || '',
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

function getProviderReason(payload) {
  if (typeof payload === 'string') {
    return payload;
  }
  return String(payload?.reason || payload?.message || payload?.rawText || '');
}

function isFailurePayload(payload) {
  const status = String(payload?.status || payload?.Status || '').toLowerCase();
  const statusCode = Number(payload?.statuscode || payload?.statusCode || payload?.code || 0);
  return status === 'failure' || (statusCode >= 400 && statusCode !== 0);
}

async function initiateMasterPostCall(customerPhone, customerId, options = {}) {
  const endpoint = getMasterPostEndpoint();
  const leadId = options.leadid || options.leadId || process.env.ICALLMATE_MASTER_POST_LEAD_ID || '1031';
  const payload = buildMasterPostPayload(customerPhone, leadId, { ...options, customerId });

  if (!payload.fieldpairs[0].wsurl) {
    throw new Error('Missing iCallMate master-post config: wsurl or ICALLMATE_MASTER_POST_WSURL is required.');
  }

  console.log(
    `[ICALLMATE OUTBOUND] Initiating call to ${logger.maskPhone(customerPhone)} provider=masterpost endpoint=${endpoint} ` +
    `campid=${payload.campid} leadid=${payload.leadid}`
  );

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const rawText = await response.text();
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
  const providerReason = getProviderReason(parsed);
  const status = providerReturnedSid ? 'queued' : 'submitted';
  console.log(`[ICALLMATE OUTBOUND] Call ${status} sid=${sid}${providerReason ? ` reason="${providerReason}"` : ''}`);
  return {
    sid,
    status,
    providerReturnedSid,
    providerReason,
    raw: parsed,
    requestPayload: payload
  };
}

async function initiateCall(customerPhone, customerId, options = {}) {
  // Refuse before dialling if we cannot speak. Every outbound path — the
  // scheduler, the API and the call routes — funnels through here, so this is
  // the one place that has to hold.
  const { unusableCredentials, describeCallBlock } = require('../src/call-capability');
  const unusable = unusableCredentials();
  if (unusable.length > 0) {
    const message = describeCallBlock(unusable);
    logger.error('CALL_BLOCKED_NO_VOICE', { missing: unusable.join(','), customerId });
    throw new Error(message);
  }

  const authenticatedOptions = {
    ...options,
    wsurl: ensureAuthenticatedMediaUrl(options.wsurl),
    callbackapi: options.callbackapi || getDefaultCallbackUrl()
  };
  await assertPublicMediaEndpointReachable(authenticatedOptions.wsurl);

  const provider = String(authenticatedOptions.provider || process.env.ICALLMATE_OUTBOUND_PROVIDER || '').toLowerCase();
  if (provider === 'masterpost' || provider === 'master-post') {
    const result = await initiateMasterPostCall(customerPhone, customerId, authenticatedOptions);
    return { ...result, requestPayload: redactRequestPayload(result.requestPayload) };
  }

  const endpoint = getOutboundEndpoint();
  const payload = buildOutboundCampaignPayload(customerPhone, customerId, authenticatedOptions);

  if (!payload.ukey || !payload.serviceno || !payload.ivrtemplateid) {
    if (process.env.ICALLMATE_MASTER_POST_API_ENDPOINT || process.env.ICALLMATE_MASTER_POST_WSURL) {
      console.log('[ICALLMATE OUTBOUND] Falling back to masterpost provider due to missing campaign credentials');
      const result = await initiateMasterPostCall(customerPhone, customerId, authenticatedOptions);
      return { ...result, requestPayload: redactRequestPayload(result.requestPayload) };
    }
    throw new Error('Missing iCallMate outbound config: ICALLMATE_UKEY, ICALLMATE_SERVICE_NO, and ICALLMATE_IVR_TEMPLATE_ID are required.');
  }

  console.log(
    `[ICALLMATE OUTBOUND] Initiating call to ${logger.maskPhone(customerPhone)} endpoint=${endpoint} ` +
    `serviceNo=${payload.serviceno} ivrTemplate=${payload.ivrtemplateid}`
  );

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const rawText = await response.text();
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
    status: 'queued',
    raw: parsed,
    requestPayload: redactRequestPayload(payload)
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
  initiateCall,
};
