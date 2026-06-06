const fs = require('fs');
const path = require('path');

function ensureAuditDir() {
  const dir = path.join(__dirname, '..', 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
  return path.join(dir, 'icallmate-audit.log');
}

function getOutboundEndpoint() {
  return `${String(process.env.ICALLMATE_OBD_API_ENDPOINT || 'https://ecp1.icallmate.in').replace(/\/+$/, '')}/OBDAPI/webresources/CreateOBDCampaignPost`;
}

function getMasterPostEndpoint() {
  return process.env.ICALLMATE_MASTER_POST_API_ENDPOINT
    || `${String(process.env.ICALLMATE_IBD_API_ENDPOINT || 'https://crm.icallmate.in').replace(/\/+$/, '')}/WebSVC111/setMasterPostAPI`;
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function normalizeWsUrl(value) {
  return String(value || '').trim().replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}

function normalizeMasterPostPhone(value) {
  const phone = normalizePhone(value);
  const localIndiaMatch = /^\+?91(\d{10})$/.exec(phone);
  return localIndiaMatch ? localIndiaMatch[1] : phone;
}

function isPlaceholderOrLocalWsUrl(value) {
  const url = String(value || '').trim();
  if (!url) return true;
  if (/your-ngrok-url|example|localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url)) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:';
  } catch (error) {
    return true;
  }
}

function getNgrokWsUrl() {
  const ngrokUrl = String(process.env.NGROK_URL || '').trim().replace(/\/+$/g, '');
  if (!ngrokUrl) {
    return '';
  }
  return normalizeWsUrl(`${ngrokUrl}/icallmate/media`);
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
          clientName: options.clientName || ''
        }),
        iscallbackapi: String(options.iscallbackapi ?? process.env.ICALLMATE_IS_CALLBACK_API ?? '1'),
        callbackapi: options.callbackapi || ''
      }
    ]
  };
}

function buildMasterPostPayload(customerPhone, customerId, options = {}) {
  const phone = normalizeMasterPostPhone(customerPhone);
  if (!phone) {
    throw new Error('Customer phone is required for iCallMate outbound call');
  }

  let wsurl = normalizeWsUrl(
    options.wsurl
    || process.env.ICALLMATE_MASTER_POST_WSURL
    || process.env.ICALLMATE_WSURL
    || ''
  );
  const ngrokWsUrl = getNgrokWsUrl();
  if (isPlaceholderOrLocalWsUrl(wsurl)) {
    if (ngrokWsUrl) {
      console.warn(`[ICALLMATE MASTERPOST] Replacing invalid or local wsurl=${wsurl} with public NGROK wsurl=${ngrokWsUrl}`);
      wsurl = ngrokWsUrl;
    }
  }

  if (!wsurl) {
    if (ngrokWsUrl) {
      wsurl = ngrokWsUrl;
      console.warn(`[ICALLMATE MASTERPOST] Using NGROK_URL fallback wsurl=${wsurl}`);
    } else {
      throw new Error('Missing iCallMate outbound config: ICALLMATE_MASTER_POST_WSURL or NGROK_URL is required for masterpost calls.');
    }
  }

  const campid = String(options.campid || process.env.ICALLMATE_MASTER_POST_CAMP_ID || '');
  const leadid = String(options.leadid || process.env.ICALLMATE_MASTER_POST_LEAD_ID || customerId || '');
  if (!campid || !leadid) {
    throw new Error('Missing iCallMate outbound config: ICALLMATE_MASTER_POST_CAMP_ID and ICALLMATE_MASTER_POST_LEAD_ID are required for masterpost calls.');
  }

  const fieldpair = {
    Phone_No: phone,
    wsurl
  };

  if (options.customerName) {
    fieldpair.Customer_Name = options.customerName;
  }
  if (customerId) {
    fieldpair.Customer_ID = String(customerId);
  }

  return {
    campid,
    leadid,
    fieldpairs: [fieldpair]
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
  const status = String(payload?.status || payload?.Status || payload?.success || '').toLowerCase();
  const message = String(payload?.message || payload?.Message || payload?.error || '').toLowerCase();
  const statusCode = Number(payload?.statuscode || payload?.statusCode || payload?.code || 0);
  return status === 'failure'
    || status === 'false'
    || message.includes('error')
    || message.includes('failed')
    || (statusCode >= 400 && statusCode !== 0);
}

function getOutboundProvider(options = {}) {
  return String(options.provider || process.env.ICALLMATE_OUTBOUND_PROVIDER || 'campaign').trim().toLowerCase();
}

async function initiateCall(customerPhone, customerId, options = {}) {
  let provider = getOutboundProvider(options);
  let endpoint = provider === 'masterpost' ? getMasterPostEndpoint() : getOutboundEndpoint();
  let payload = provider === 'masterpost'
    ? buildMasterPostPayload(customerPhone, customerId, options)
    : buildOutboundCampaignPayload(customerPhone, customerId, options);

  // If campaign-mode is requested but missing required campaign credentials,
  // attempt to fall back to masterpost if masterpost params are available.
  if (provider !== 'masterpost' && (!payload.ukey || !payload.serviceno || !payload.ivrtemplateid)) {
    const hasMasterPostEnv = Boolean(process.env.ICALLMATE_MASTER_POST_WSURL || process.env.ICALLMATE_MASTER_POST_CAMP_ID || process.env.ICALLMATE_MASTER_POST_LEAD_ID || process.env.ICALLMATE_WSURL);
    const hasMasterPostOptions = Boolean(options.campid || options.leadid || options.wsurl);
    if (hasMasterPostEnv || hasMasterPostOptions) {
      provider = 'masterpost';
        endpoint = getMasterPostEndpoint();
        payload = buildMasterPostPayload(customerPhone, customerId, options);
        // If a dedicated master-post WS URL is set in env, prefer it (avoid PUBLIC_BASE_URL placeholders)
        try {
          const envWs = normalizeWsUrl(process.env.ICALLMATE_MASTER_POST_WSURL || '');
          if (envWs) {
            payload.fieldpairs[0].wsurl = envWs;
            console.log('[ICALLMATE OUTBOUND] Using ICALLMATE_MASTER_POST_WSURL from env for wsurl');
          }
        } catch (e) {
          // ignore
        }
        console.log('[ICALLMATE OUTBOUND] Falling back to masterpost provider due to missing campaign credentials');
    } else {
      throw new Error('Missing iCallMate outbound config: ICALLMATE_UKEY, ICALLMATE_SERVICE_NO, and ICALLMATE_IVR_TEMPLATE_ID are required.');
    }
  }

  console.log(
    `[ICALLMATE OUTBOUND] Initiating call to ${customerPhone} provider=${provider} endpoint=${endpoint} ` +
    `serviceNo=${payload.serviceno || ''} ivrTemplate=${payload.ivrtemplateid || ''} campid=${payload.campid || ''} leadid=${payload.leadid || ''}` +
    `${provider === 'masterpost' ? ` wsurl=${payload.fieldpairs?.[0]?.wsurl || ''}` : ''}`
  );

  // Audit: write full request payload to audit log before sending
  try {
    const auditFile = ensureAuditDir();
    const ts = new Date().toISOString();
    fs.appendFileSync(auditFile, `\n--- REQUEST ${ts} provider=${provider} endpoint=${endpoint} ---\n` + JSON.stringify(payload, null, 2) + '\n');
  } catch (e) {
    console.warn('[ICALLMATE AUDIT] failed to write request audit', e.message);
  }

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

  // Audit: write full response to audit log
  try {
    const auditFile = ensureAuditDir();
    const ts = new Date().toISOString();
    fs.appendFileSync(auditFile, `\n--- RESPONSE ${ts} status=${response.status} ---\n` + JSON.stringify(parsed, null, 2) + '\n');
  } catch (e) {
    console.warn('[ICALLMATE AUDIT] failed to write response audit', e.message);
  }

  if (!response.ok) {
    throw new Error(`iCallMate outbound call failed (${response.status}): ${rawText || response.statusText}`);
  }

  if (isFailurePayload(parsed)) {
    throw new Error(`iCallMate outbound call rejected: ${parsed.message || rawText || 'unknown failure'}`);
  }

  const sid = extractCallSid(parsed, payload.s_unique || `icallmate-${provider}-${Date.now()}`);
  console.log(`[ICALLMATE OUTBOUND] Call accepted sid=${sid}`);
  return {
    sid,
    status: 'queued',
    provider,
    raw: parsed
  };
}

async function sendWhatsAppMessage() {
  console.warn('[ICALLMATE] WhatsApp sending is disabled; only iCallMate voice calls are configured.');
  return { sid: null, skipped: true };
}

module.exports = {
  buildOutboundCampaignPayload,
  buildMasterPostPayload,
  initiateCall,
  sendWhatsAppMessage
};
