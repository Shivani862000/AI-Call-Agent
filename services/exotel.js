function getExotelApiHost() {
  return process.env.EXOTEL_API_HOST || 'api.in.exotel.com';
}

function buildExotelAuthHeader() {
  const apiKey = process.env.EXOTEL_API_KEY;
  const apiToken = process.env.EXOTEL_API_TOKEN;
  return `Basic ${Buffer.from(`${apiKey}:${apiToken}`).toString('base64')}`;
}

function getExotelAccountSid() {
  return process.env.EXOTEL_SID;
}

function getExotelVoicebotEndpointUrl() {
  return process.env.EXOTEL_VOICEBOT_URL || '';
}

function getExotelApiBaseUrl() {
  const host = String(getExotelApiHost() || 'api.in.exotel.com')
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/g, '');
  return `https://${host}`;
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function redactSecret(value, visiblePrefix = 4, visibleSuffix = 4) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  if (text.length <= visiblePrefix + visibleSuffix) {
    return '[set]';
  }

  return `${text.slice(0, visiblePrefix)}…${text.slice(-visibleSuffix)} (len=${text.length})`;
}

function extractXmlTag(text, tagName) {
  const match = String(text || '').match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`, 'i'));
  return match ? match[1] : null;
}

async function parseExotelResponse(response) {
  const rawText = await response.text();
  const parsed = parseJsonSafely(rawText);

  if (parsed) {
    return { rawText, parsed };
  }

  return {
    rawText,
    parsed: {
      Call: {
        Sid: extractXmlTag(rawText, 'Sid'),
        Status: extractXmlTag(rawText, 'Status')
      }
    }
  };
}

async function fetchCallDetails(callSid, options = {}) {
  const accountSid = getExotelAccountSid();
  const query = new URLSearchParams();
  if (options.recordingUrlValidity) {
    query.set('RecordingUrlValidity', String(options.recordingUrlValidity));
  }

  const querySuffix = query.toString() ? `?${query.toString()}` : '';
  const response = await fetch(`${getExotelApiBaseUrl()}/v1/Accounts/${accountSid}/Calls/${callSid}.json${querySuffix}`, {
    headers: {
      Authorization: buildExotelAuthHeader()
    }
  });

  const payload = await parseExotelResponse(response);
  if (!response.ok) {
    throw new Error(`Exotel call details failed (${response.status}): ${payload.rawText || response.statusText}`);
  }

  return payload.parsed;
}

function getRecordingUrlFromCallDetails(payload) {
  const call =
    payload?.Call
    || payload?.call
    || payload?.response?.Call
    || payload?.response?.call
    || payload
    || {};

  return (
    call.PreSignedRecordingUrl
    || call.pre_signed_recording_url
    || call.PresignedRecordingUrl
    || call.presigned_recording_url
    || call.RecordingUrl
    || call.recording_url
    || null
  );
}

function buildExotelTraceId(customerPhone, customerId) {
  const phoneFragment = String(customerPhone || '').replace(/\D+/g, '').slice(-6) || 'nop';
  const customerFragment = customerId ? `c${String(customerId)}` : 'c0';
  const timeFragment = Date.now().toString(36);
  const randomFragment = Math.random().toString(36).slice(2, 8);
  return `exotel-${customerFragment}-${phoneFragment}-${timeFragment}-${randomFragment}`;
}

function isLikelyExotelFlowUrl(url) {
  const text = String(url || '').trim();
  if (!text) {
    return false;
  }

  return /my\.exotel\.com\/.+\/exoml\/start_voice\/\d+/i.test(text);
}

async function initiateCall(customerPhone, customerId, statusCallbackUrl) {
  const accountSid = getExotelAccountSid();
  const apiHost = getExotelApiHost();
  const configuredFlowUrl = process.env.EXOTEL_FLOW_URL || process.env.EXOTEL_APPLET_URL || '';
  const configuredVoicebotEndpoint = getExotelVoicebotEndpointUrl();
  const appId = process.env.EXOTEL_APP_ID;
  const traceId = buildExotelTraceId(customerPhone, customerId);
  const voiceFlowUrl = isLikelyExotelFlowUrl(configuredFlowUrl)
    ? configuredFlowUrl
    : (appId ? `http://my.exotel.com/${accountSid}/exoml/start_voice/${appId}` : '');

  if (!voiceFlowUrl) {
    throw new Error('Missing EXOTEL_FLOW_URL/EXOTEL_APPLET_URL or EXOTEL_APP_ID for outbound call flow.');
  }

  if (configuredFlowUrl && !isLikelyExotelFlowUrl(configuredFlowUrl)) {
    console.warn(
      `[EXOTEL] EXOTEL_APPLET_URL looks like a voicebot endpoint, but outbound calls need an Exotel flow URL. ` +
      `Using the Exotel flow fallback instead. Voicebot endpoint=${configuredFlowUrl}`
    );
  }

  let requestUrl = String(voiceFlowUrl).trim();
  try {
    const requestUrlObject = new URL(requestUrl);
    requestUrlObject.searchParams.set('source', 'exotel');
    requestUrlObject.searchParams.set('traceId', traceId);
    if (customerId) {
      requestUrlObject.searchParams.set('customerId', String(customerId));
    }
    if (customerPhone) {
      requestUrlObject.searchParams.set('customerPhone', String(customerPhone));
    }
    requestUrl = requestUrlObject.toString();
  } catch (error) {
    console.warn(`[EXOTEL] Unable to add trace params to request URL: ${error.message}`);
  }

  console.log(
    `[EXOTEL CONFIG] ` +
    `EXOTEL_SID=${redactSecret(accountSid)} ` +
    `EXOTEL_API_HOST=${apiHost} ` +
    `EXOTEL_APP_ID=${appId || ''} ` +
    `EXOTEL_CALLER_ID=${process.env.EXOTEL_CALLER_ID || ''} ` +
    `EXOTEL_FLOW_URL=${voiceFlowUrl || ''} ` +
    `EXOTEL_VOICEBOT_URL=${configuredVoicebotEndpoint || ''} ` +
    `TRACE_ID=${traceId} ` +
    `STATUS_CALLBACK=${statusCallbackUrl} ` +
    `CALL_TYPE=${process.env.EXOTEL_CALL_TYPE || 'trans'}`
  );
  console.log(
    `[EXOTEL] Initiating call to ${customerPhone} via ${apiHost} ` +
    `flow=${voiceFlowUrl} statusCallback=${statusCallbackUrl}`
  );
  console.log(`[EXOTEL] Request Url param=${requestUrl}`);
  console.log(
    `[EXOTEL PAYLOAD] ` +
    JSON.stringify({
      From: customerPhone,
      CallerId: process.env.EXOTEL_CALLER_ID || '',
      Url: requestUrl,
      CallType: process.env.EXOTEL_CALL_TYPE || 'trans',
      StatusCallback: statusCallbackUrl,
      StatusCallbackContentType: 'application/json',
      CustomField: customerId ? String(customerId) : null,
      TraceId: traceId
    })
  );

  const body = new URLSearchParams({
    From: customerPhone,
    CallerId: process.env.EXOTEL_CALLER_ID,
    Url: requestUrl,
    CallType: process.env.EXOTEL_CALL_TYPE || 'trans',
    StatusCallback: statusCallbackUrl,
    StatusCallbackContentType: 'application/json'
  });

  if (customerId) {
    body.set('CustomField', String(customerId));
  }

  const response = await fetch(`https://${apiHost}/v1/Accounts/${accountSid}/Calls/connect.json`, {
    method: 'POST',
    headers: {
      Authorization: buildExotelAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const payload = await parseExotelResponse(response);
  if (!response.ok) {
    throw new Error(`Exotel call initiation failed (${response.status}): ${payload.rawText || response.statusText}`);
  }

  const sid = payload.parsed?.Call?.Sid || payload.parsed?.call?.sid || null;
  console.log(`[EXOTEL] Call accepted sid=${sid || 'unknown'} status=${payload.parsed?.Call?.Status || payload.parsed?.call?.status || 'queued'}`);
  return {
    sid,
    status: payload.parsed?.Call?.Status || payload.parsed?.call?.status || 'queued',
    raw: payload.parsed
  };
}

async function sendWhatsAppMessage(customerPhone, message) {
  const accountSid = getExotelAccountSid();
  const apiHost = getExotelApiHost();
  const response = await fetch(`https://${apiHost}/v2/accounts/${accountSid}/messages`, {
    method: 'POST',
    headers: {
      Authorization: buildExotelAuthHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      whatsapp: {
        messages: [
          {
            from: process.env.EXOTEL_WHATSAPP_FROM,
            to: customerPhone,
            content: {
              recepient_type: 'individual',
              type: 'text',
              text: {
                body: message,
                preview_url: true
              }
            }
          }
        ]
      }
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Exotel WhatsApp send failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  const result =
    payload?.whatsapp?.messages?.[0]
    || payload?.response?.data?.whatsapp?.messages?.[0]
    || payload?.response?.messages?.[0]
    || {};

  return {
    sid: result.sid || result.id || null,
    raw: payload
  };
}

module.exports = {
  buildExotelAuthHeader,
  fetchCallDetails,
  getRecordingUrlFromCallDetails,
  initiateCall,
  sendWhatsAppMessage
};
