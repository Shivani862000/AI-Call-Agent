function getOutboundEndpoint() {
  return `${String(process.env.ICALLMATE_OBD_API_ENDPOINT || 'https://ecp1.icallmate.in').replace(/\/+$/, '')}/OBDAPI/webresources/CreateOBDCampaignPost`;
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
          customerId: customerId || null,
          customerName: options.customerName || '',
          clientName: options.clientName || ''
        }),
        iscallbackapi: String(options.iscallbackapi ?? process.env.ICALLMATE_IS_CALLBACK_API ?? '1'),
        callbackapi: options.callbackapi || ''
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

async function initiateCall(customerPhone, customerId, options = {}) {
  const endpoint = getOutboundEndpoint();
  const payload = buildOutboundCampaignPayload(customerPhone, customerId, options);

  if (!payload.ukey || !payload.serviceno || !payload.ivrtemplateid) {
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

  const sid = extractCallSid(parsed, payload.s_unique);
  console.log(`[ICALLMATE OUTBOUND] Call accepted sid=${sid}`);
  return {
    sid,
    status: 'queued',
    raw: parsed
  };
}

async function sendWhatsAppMessage() {
  console.warn('[ICALLMATE] WhatsApp sending is disabled; only iCallMate voice calls are configured.');
  return { sid: null, skipped: true };
}

module.exports = {
  buildOutboundCampaignPayload,
  initiateCall,
  sendWhatsAppMessage
};
