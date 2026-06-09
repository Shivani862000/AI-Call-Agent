function getOutboundEndpoint() {
  return `${String(process.env.ICALLMATE_OBD_API_ENDPOINT || 'https://ecp1.icallmate.in').replace(/\/+$/, '')}/OBDAPI/webresources/CreateOBDCampaignPost`;
}

function getMasterPostEndpoint() {
  return String(process.env.ICALLMATE_MASTER_POST_API_ENDPOINT || 'https://crm.icallmate.in/WebSVC111/setMasterPostAPI').trim();
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function buildOutboundCampaignPayload(customerPhone, customerId, options = {}) {
  const msisdn = normalizePhone(customerPhone);
  if (!msisdn) {
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
        msisdn,
        name: options.customerName || '',
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
  return {
    campid: String(options.campid || process.env.ICALLMATE_MASTER_POST_CAMP_ID || '54'),
    leadid: String(leadId || options.leadid || process.env.ICALLMATE_MASTER_POST_LEAD_ID || '1031'),
    fieldpairs: [
      {
        Phone_No: phoneNo,
        Mobile_No: phoneNo,
        Moblie_No: phoneNo,
        wsurl,
        Customer_Name: options.customerName || '',
        Customer_ID: options.customerId || ''
      }
    ]
  };
}

function extractCallSid(payload, fallback) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
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

function isFailurePayload(payload) {
  const status = String(payload?.status || payload?.Status || '').toLowerCase();
  const statusCode = Number(payload?.statuscode || payload?.statusCode || payload?.code || 0);
  return status === 'failure' || (statusCode >= 400 && statusCode !== 0);
}

async function initiateMasterPostCall(customerPhone, customerId, options = {}) {
  const endpoint = getMasterPostEndpoint();
  const payload = buildMasterPostPayload(customerPhone, options.leadid || process.env.ICALLMATE_MASTER_POST_LEAD_ID, options);

  if (!payload.fieldpairs[0].wsurl) {
    throw new Error('Missing iCallMate master-post config: wsurl or ICALLMATE_MASTER_POST_WSURL is required.');
  }

  console.log(
    `[ICALLMATE OUTBOUND] Initiating call to ${customerPhone} provider=masterpost endpoint=${endpoint} ` +
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
    throw new Error(`iCallMate master-post call failed (${response.status}): ${rawText || response.statusText}`);
  }

  if (isFailurePayload(parsed)) {
    throw new Error(`iCallMate master-post call rejected: ${parsed.message || rawText || 'unknown failure'}`);
  }

  const sid = extractCallSid(parsed, `icallmate-masterpost-${Date.now()}`);
  console.log(`[ICALLMATE OUTBOUND] Call accepted sid=${sid}`);
  return {
    sid,
    status: 'queued',
    raw: parsed
  };
}

async function initiateCall(customerPhone, customerId, options = {}) {
  const provider = String(options.provider || process.env.ICALLMATE_OUTBOUND_PROVIDER || '').toLowerCase();
  if (provider === 'masterpost' || provider === 'master-post') {
    return initiateMasterPostCall(customerPhone, customerId, options);
  }

  const endpoint = getOutboundEndpoint();
  const payload = buildOutboundCampaignPayload(customerPhone, customerId, options);

  if (!payload.ukey || !payload.serviceno || !payload.ivrtemplateid) {
    if (process.env.ICALLMATE_MASTER_POST_API_ENDPOINT || process.env.ICALLMATE_MASTER_POST_WSURL) {
      console.log('[ICALLMATE OUTBOUND] Falling back to masterpost provider due to missing campaign credentials');
      return initiateMasterPostCall(customerPhone, customerId, options);
    }
    throw new Error('Missing iCallMate outbound config: ICALLMATE_UKEY, ICALLMATE_SERVICE_NO, and ICALLMATE_IVR_TEMPLATE_ID are required.');
  }

  console.log(
    `[ICALLMATE OUTBOUND] Initiating call to ${customerPhone} endpoint=${endpoint} ` +
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
    throw new Error(`iCallMate outbound call failed (${response.status}): ${rawText || response.statusText}`);
  }

  if (isFailurePayload(parsed)) {
    throw new Error(`iCallMate outbound call rejected: ${parsed.message || rawText || 'unknown failure'}`);
  }

  const sid = extractCallSid(parsed, payload.s_unique);
  console.log(`[ICALLMATE OUTBOUND] Call accepted sid=${sid}`);
  return {
    sid,
    status: 'queued',
    raw: parsed
  };
}

module.exports = {
  buildOutboundCampaignPayload,
  buildMasterPostPayload,
  initiateCall,
};
