/**
 * src/api-routes.js
 * Express route handlers for the API and web interface.
 */

'use strict';

const fs = require('fs');
const customersRouter = require('../routes/customers');
const clientsRouter = require('../routes/clients');
const campaignsRouter = require('../routes/campaigns');
const feedbackRouter = require('../routes/feedback');
const createSupportTicketsRouter = require('../routes/support-tickets');
const { createSlackSupportNotifier } = require('../services/slack-support');
const reportsRouter = require('../routes/reports');
const agentsRouter = require('../routes/agents');
const testCallRouter = require('../routes/test-call');
const testAiCallRouter = require('../routes/test-ai-call');

const {
  CALL_MODE,
  VOICE_PIPELINE,
  REALTIME_MODEL,
  PUBLIC_BASE_URL,
  CLIENT_NAME,
  ICALLMATE_DEFAULT_DID,
  ICALLMATE_DEFAULT_TEST_NUMBER,
  liveCallState,
  incomingCallState,
  validateConfig,
  describeEnvValue
} = require('./config');

const {
  readAuthSession,
  setAuthCookie,
  clearAuthCookie,
  createAuthToken,
  createMediaToken,
  ADMIN_USERNAME,
  verifyCredentials
} = require('./auth');

const {
  normalizeOutboundCallType,
  pickRequestValue,
  safeJsonParse,
  xmlEscape,
  toWssUrl,
  normalizeIcallTimestamp,
  getRequestPublicBaseUrl,
  getSecurePublicBaseUrl,
  buildTranscriptPreviewText,
  runInBackground,
  schedulePendingCallDiagnostic,
  markPendingCallDiagnostic,
  pruneLiveCallState,
  pruneIncomingCallState
} = require('./helpers');

const {
  ensureCustomerForCall,
  claimCustomerForOutboundCall,
  releaseCustomerOutboundClaim,
  hydratePreCallIntelligence,
  shouldBlockCustomerCall,
  placeRealtimeCall,
  upsertIncomingCallFromIcall
} = require('./call-management');

const {
  buildScriptedConsentResponse,
  buildScriptedLanguageResponse,
  buildScriptedRatingResponse
} = require('./scripted-ivr');

const { dbGet, dbRun, dbAll } = require('../db');
const { computePriorityScore, applyCallOutcomeWorkflow, createSupervisorEvent } = require('../services/call-orchestration');
const { getAgentConfigById, getDefaultAgentConfig } = require('./prompt-builder');
const { buildCallAnalysis, storeCallAnalysis } = require('../services/call-analysis');
const { generateCallAnalysisPDF } = require('../services/pdf');
const { initiateCall, buildMasterPostPayload } = require('../services/icallmate');
const { processCompletedCallPipeline } = require('../services/post-call-pipeline');
const {
  buildIcallMateCallbackUrl,
  hasValidIcallMateWebhookSecret
} = require('./icallmate-webhook');
const logger = require('../services/system-logger');

module.exports = function mountApiRoutes(app) {
  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      mode: CALL_MODE,
      pipeline: VOICE_PIPELINE,
      model: REALTIME_MODEL,
      publicBaseUrl: PUBLIC_BASE_URL,
      timestamp: new Date().toISOString()
    });
  });

  app.get('/', (req, res) => {
    if (readAuthSession(req)) {
      return res.redirect('/admin.html');
    }

    return res.redirect('/login.html');
  });

  app.get('/api/auth/session', (req, res) => {
    const session = readAuthSession(req);
    if (!session) {
      return res.status(401).json({ authenticated: false });
    }

    return res.json({
      authenticated: true,
      username: session.username,
      role: session.role
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    const authResult = await verifyCredentials(username, password);

    if (!authResult.success) {
      clearAuthCookie(req, res);
      logger.warn('USER_LOGIN', { user: username || 'unknown', status: 'failed' });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = createAuthToken(username, authResult.role);
    setAuthCookie(req, res, token);
    logger.info('USER_LOGIN', { user: username, role: authResult.role });
    return res.json({
      success: true,
      username,
      role: authResult.role
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const session = readAuthSession(req);
    clearAuthCookie(req, res);
    logger.info('USER_LOGOUT', { user: session?.username || req.adminSession?.username || 'admin' });
    return res.json({ success: true });
  });

  app.use('/api/customers', customersRouter);
  app.use('/api/clients', clientsRouter);
  app.use('/api/campaigns', campaignsRouter);
  app.use('/api/feedback', feedbackRouter);
  app.use('/api/support-tickets', createSupportTicketsRouter({ dbRun, dbGet, dbAll, notifyNewTicket: createSlackSupportNotifier({ webhookUrl: process.env.SLACK_SUPPORT_WEBHOOK_URL }) }));
  app.use('/api/reports', reportsRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/test-call', testCallRouter);
  app.use('/api/test-ai-call', testAiCallRouter);

  app.get('/api/logs', async (req, res) => {
    try {
      const filter = String(req.query.filter || 'all').toLowerCase();
      const max = Math.min(Math.max(Number(req.query.limit || 200), 1), 1000);
      if (!fs.existsSync(logger.LOG_FILE)) {
        return res.json({ logs: [] });
      }

      const text = await fs.promises.readFile(logger.LOG_FILE, 'utf8');
      const filters = {
        calls: /\[(CALL_[A-Z_]+)\]/,
        users: /\[(USER_[A-Z_]+)\]/,
        feedback: /\[(FEEDBACK_[A-Z_]+)\]/,
        errors: /\[ERROR\]/
      };
      const matcher = filters[filter] || null;
      const logs = text
        .split('\n')
        .filter(Boolean)
        .filter((line) => !matcher || matcher.test(line))
        .slice(-max)
        .reverse();

      res.json({ logs });
    } catch (error) {
      logger.error('LOG_READ_FAILED', { reason: error.message });
      res.status(500).json({ error: 'Failed to read logs' });
    }
  });

  app.post('/call/start', async (req, res) => {
    let customer = null;
    try {
      const customerPhone = req.body.customerPhone || process.env.CUSTOMER_PHONE;
      const customerName = req.body.customerName || process.env.CUSTOMER_NAME;
      const requestedCustomerId = req.body.customerId;
      const requestedAgentId = Number(req.body.agentId || req.query.agentId || 0) || null;
      const callType = normalizeOutboundCallType(req.body.callType || req.body.call_type);
      customer = await ensureCustomerForCall({
        customerId: requestedCustomerId,
        customerName,
        customerPhone
      });
      customer = await hydratePreCallIntelligence(customer);
      const agentConfig = requestedAgentId ? await getAgentConfigById(requestedAgentId) : await getDefaultAgentConfig();
      const clientName = req.body.clientName || agentConfig?.client_name || CLIENT_NAME;

      const blockedReason = await shouldBlockCustomerCall(customer);
      if (blockedReason) {
        if (blockedReason.code === 'CALL_SKIPPED_QUIET_HOURS') {
          logger.warn('CALL_SKIPPED_QUIET_HOURS', { phone: customer.phone, scheduledTime: 'Manual Trigger', reason: blockedReason.reason });
        } else if (blockedReason.code === 'CALL_BLOCKED_DAILY_LIMIT') {
          logger.error('CALL_BLOCKED_DAILY_LIMIT', { phone: customer.phone, reason: blockedReason.reason });
        }
        return res.status(409).json({ success: false, error: blockedReason.reason, code: blockedReason.code });
      }

      const claimed = await claimCustomerForOutboundCall(customer.id);
      if (!claimed) {
        return res.status(409).json({ success: false, error: 'A call for this customer is already in progress' });
      }

      console.log(
        `[CALL REQUEST] to=${logger.maskPhone(customerPhone)} serviceNo=${process.env.ICALLMATE_SERVICE_NO || ''} baseUrl=${PUBLIC_BASE_URL} ` +
        `mode=${CALL_MODE} pipeline=${VOICE_PIPELINE} model=${REALTIME_MODEL}`
      );
      console.log(
        `[CALL REQUEST CONFIG] ` +
        `APP_BASE_URL=${describeEnvValue(process.env.APP_BASE_URL || '')} ` +
        `NGROK_URL=${describeEnvValue(process.env.NGROK_URL || '')} ` +
        `WEBHOOK_URL=${describeEnvValue(process.env.WEBHOOK_URL || '')} ` +
        `SERVER_NAME=${describeEnvValue(process.env.SERVER_NAME || '')} ` +
        `ICALLMATE_OBD_API_ENDPOINT=${process.env.ICALLMATE_OBD_API_ENDPOINT || 'https://ecp1.icallmate.in'} ` +
        `ICALLMATE_SERVICE_NO=${process.env.ICALLMATE_SERVICE_NO || ''} ` +
        `ICALLMATE_IVR_TEMPLATE_ID=${process.env.ICALLMATE_IVR_TEMPLATE_ID || ''} ` +
        `TZ=${process.env.TZ || ''}`
      );
      const call = await placeRealtimeCall({
        customerPhone,
        customerName: customer.name || customerName,
        customerId: customer.id,
        clientName,
        agentId: agentConfig?.id || null,
        callType
      });

      const result = await dbRun(
        `INSERT INTO calls (
        customer_id, agent_id, outcome, provider_call_id, called_at, hot_lead_score,
        consent_message_played, call_script_version, supervisor_alert_level, call_direction, call_source, call_type,
        provider_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customer.id,
          agentConfig?.id || null,
          'initiated',
          call.sid,
          new Date().toISOString(),
          customer.priority_score || computePriorityScore(customer),
          1,
          agentConfig?.slug || 'hindi-feedback-v1',
          'normal',
          'outbound',
          'icallmate',
          callType,
          JSON.stringify({ request: call.requestPayload || null, response: call.raw || null })
        ]
      );
      await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', customer.id]);
      
      const callsTodayRow = await dbGet(
        `SELECT COUNT(*) as count FROM calls c WHERE c.customer_id = ? AND DATE(c.called_at, 'localtime') = DATE('now', 'localtime') AND COALESCE(c.call_direction, 'outbound') = 'outbound'`,
        [customer.id]
      );
      const attempt = callsTodayRow ? callsTodayRow.count : 1;
      logger.info('CALL_ATTEMPT_STARTED', { phone: customer.phone || customerPhone, attempt });
      
      logger.info('CALL_STARTED', {
        callId: result.lastID,
        customerId: customer.id,
        patient: customer.name || customerName,
        phone: customer.phone || customerPhone,
        type: logger.formatCallType(callType),
        provider: 'icallmate',
        providerCallId: call.sid
      });

      schedulePendingCallDiagnostic(call.sid, {
        customerId: customer.id,
        customerPhone,
        customerName: customer.name || customerName,
        agentId: agentConfig?.id || null,
        trigger: '/call/start'
      });
      res.json({ success: true, sid: call.sid, callId: result.lastID, customerId: customer.id, agentId: agentConfig?.id || null });
    } catch (error) {
      if (customer?.id) {
        try {
          await releaseCustomerOutboundClaim(customer.id, customer.status || 'pending');
        } catch (releaseError) {
          console.error('[CALL CLAIM RELEASE ERROR]', releaseError.message);
        }
      }
      logger.error('CALL_FAILED', {
        customerId: customer?.id,
        patient: customer?.name,
        phone: customer?.phone || req.body.customerPhone,
        reason: error.message
      });
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/call/scripted/consent', (req, res) => {
    console.log(`[SCRIPTED] Consent lang=${req.query.lang || 'hi'} digits=${req.body.Digits || ''} speech=${req.body.SpeechResult || ''}`);
    res.type('text/xml').send(buildScriptedConsentResponse(req));
  });

  app.post('/call/scripted/language', (req, res) => {
    console.log(`[SCRIPTED] Language digits=${req.body.Digits || ''} speech=${req.body.SpeechResult || ''}`);
    res.type('text/xml').send(buildScriptedLanguageResponse(req));
  });

  // app.post('/call/scripted/rating', (req, res) => {
  //   res.type('text/xml').send(buildScriptedRatingResponse(req));
  // });

  app.all('/call/status', async (req, res) => {
    try {
      const providerStatus = pickRequestValue(req, ['CallStatus', 'Status', 'status']);
      const providerCallSid = pickRequestValue(req, ['CallSid', 'call_sid', 'Sid', 'sid']);
      const providerRecordingUrl = pickRequestValue(req, ['RecordingUrl', 'recording_url']);
      const providerRecordingSid = pickRequestValue(req, ['RecordingSid', 'recording_sid']);
      const eventType = pickRequestValue(req, ['EventType', 'event_type']);
      console.log(
        `[CALL STATUS] method=${req.method} status=${providerStatus || ''} sid=${providerCallSid || ''} ` +
        `query=${JSON.stringify(req.query || {})} bodyKeys=${JSON.stringify(Object.keys(req.body || {}))}`
      );

      if (providerCallSid) {
        markPendingCallDiagnostic(providerCallSid, {
          statusHitAt: new Date().toISOString(),
          statusMethod: req.method,
          providerStatus: providerStatus || null,
          eventType: eventType || null
        });
      }

      const callRecord = await dbGet('SELECT * FROM calls WHERE provider_call_id = ?', [providerCallSid]);
      const customerId = req.query.customerId || callRecord?.customer_id;
      const customer = customerId ? await dbGet('SELECT * FROM customers WHERE id = ?', [customerId]) : null;

      if (callRecord) {
        let mappedOutcome = null;
        if (providerStatus === 'completed') mappedOutcome = 'completed';
        if (providerStatus === 'no-answer') mappedOutcome = 'no_answer';
        if (providerStatus === 'failed') mappedOutcome = 'failed';
        if (providerStatus === 'busy') mappedOutcome = 'busy';
        if (providerStatus === 'ringing') mappedOutcome = 'ringing';
        if (providerStatus === 'in-progress') mappedOutcome = 'in_progress';
        if (providerStatus === 'queued') mappedOutcome = 'queued';
        if (providerStatus === 'initiated') mappedOutcome = 'initiated';
        if (providerStatus === 'voicemail') mappedOutcome = 'voicemail';
        if (providerStatus === 'canceled' || providerStatus === 'cancelled') mappedOutcome = 'cancelled';

        const normalizedRecordingUrl = providerRecordingUrl
          ? String(providerRecordingUrl).endsWith('.mp3') ? providerRecordingUrl : `${providerRecordingUrl}.mp3`
          : null;

        if (normalizedRecordingUrl || providerRecordingSid) {
          await dbRun(
            `UPDATE calls
              SET recording_sid = COALESCE(?, recording_sid),
                  recording_url = COALESCE(?, recording_url),
                  recording_status = ?
            WHERE id = ?`,
            [
              providerRecordingSid || null,
              normalizedRecordingUrl,
              normalizedRecordingUrl ? 'completed' : (providerStatus || eventType || 'pending'),
              callRecord.id
            ]
          );
        }

        if (mappedOutcome) {
          await dbRun('UPDATE calls SET outcome = ?, outcome_detail = ? WHERE id = ?', [mappedOutcome, providerStatus, callRecord.id]);
          const eventName = mappedOutcome === 'completed'
            ? 'CALL_COMPLETED'
            : (mappedOutcome === 'failed' || mappedOutcome === 'busy' || mappedOutcome === 'no_answer' ? 'CALL_FAILED' : 'CALL_PENDING');
          const statusDetails = {
            callId: callRecord.id,
            customerId: customerId || callRecord.customer_id,
            patient: customer?.name,
            phone: customer?.phone,
            status: mappedOutcome,
            providerStatus,
            duration: logger.formatDuration(callRecord.call_duration || 0)
          };
          if (eventName === 'CALL_FAILED') {
            logger.warn(eventName, statusDetails);
          } else {
            logger.info(eventName, statusDetails);
          }
        }

        if (mappedOutcome === 'completed' && normalizedRecordingUrl) {
          setTimeout(() => {
            runInBackground('POST CALL PIPELINE ERROR', async () => {
              const result = await processCompletedCallPipeline({ dbGet, dbRun, callSid: providerCallSid, callId: callRecord.id });
              if (result.ok) {
                console.log(`[POST CALL PIPELINE] Processed call ${providerCallSid} with feedback ${result.feedbackId}`);
              } else {
                console.log(`[POST CALL PIPELINE] Skipped call ${providerCallSid}: ${result.reason}`);
              }
            });
          }, 1500);
        }

        if (customerId) {
          if (customer && mappedOutcome) {
            await applyCallOutcomeWorkflow({
              dbGet,
              dbRun,
              callRecord: { ...callRecord, outcome: mappedOutcome },
              customer,
              providerStatus: mappedOutcome,
              inferredOutcome: mappedOutcome
            });
          }
        }
      }

      res.sendStatus(200);
    } catch (error) {
      console.error('[CALL STATUS ERROR]', error.message);
      res.sendStatus(500);
    }
  });

  app.post('/call/recording-status', async (req, res) => {
    try {
      const callSid = req.body.CallSid;
      const recordingSid = req.body.RecordingSid;
      const recordingStatus = req.body.RecordingStatus;
      const recordingUrl = req.body.RecordingUrl ? `${req.body.RecordingUrl}.mp3` : null;

      console.log(`[RECORDING STATUS] ${recordingStatus} | Call SID: ${callSid} | Recording SID: ${recordingSid}`);

      const callRecord = await dbGet('SELECT * FROM calls WHERE provider_call_id = ? ORDER BY id DESC LIMIT 1', [callSid]);
      if (callRecord) {
        const customer = await dbGet('SELECT * FROM customers WHERE id = ?', [callRecord.customer_id]);
        await dbRun(
          `UPDATE calls
            SET recording_sid = ?,
                recording_url = ?,
                recording_status = ?
          WHERE id = ?`,
          [recordingSid || null, recordingUrl, recordingStatus || null, callRecord.id]
        );

        if (recordingStatus === 'completed' && recordingUrl) {
          setTimeout(() => {
            runInBackground('POST CALL PIPELINE ERROR', async () => {
              const result = await processCompletedCallPipeline({ dbGet, dbRun, callSid, callId: callRecord.id });
              if (result.ok) {
                console.log(`[POST CALL PIPELINE] Processed call ${callSid} with feedback ${result.feedbackId}`);
              } else {
                console.log(`[POST CALL PIPELINE] Skipped call ${callSid}: ${result.reason}`);
              }
            });
          }, 1500);
        }
        if (recordingStatus && recordingStatus !== 'completed') {
          logger.info('CALL_PENDING', {
            callId: callRecord.id,
            customerId: callRecord.customer_id,
            patient: customer?.name,
            phone: customer?.phone,
            status: recordingStatus
          });
        }
      }

      res.sendStatus(200);
    } catch (error) {
      console.error('[RECORDING STATUS ERROR]', error.message);
      res.sendStatus(500);
    }
  });

  app.post('/api/calls/initiate/:customerId', async (req, res) => {
    let customer = null;
    try {
      customer = await dbGet('SELECT * FROM customers WHERE id = ?', [req.params.customerId]);
      if (!customer) {
        return res.status(404).json({ error: 'Customer not found' });
      }

      customer = await hydratePreCallIntelligence(customer);
      const requestedAgentId = Number(req.body?.agentId || req.query.agentId || customer.default_agent_id || 0) || null;
      const callType = normalizeOutboundCallType(req.body?.callType || req.body?.call_type || customer.call_type);
      const agentConfig = requestedAgentId ? await getAgentConfigById(requestedAgentId) : await getDefaultAgentConfig();
      const blockedReason = await shouldBlockCustomerCall(customer);
      if (blockedReason) {
        if (blockedReason.code === 'CALL_SKIPPED_QUIET_HOURS') {
          logger.warn('CALL_SKIPPED_QUIET_HOURS', { phone: customer.phone, scheduledTime: 'Manual Trigger', reason: blockedReason.reason });
        } else if (blockedReason.code === 'CALL_BLOCKED_DAILY_LIMIT') {
          logger.error('CALL_BLOCKED_DAILY_LIMIT', { phone: customer.phone, reason: blockedReason.reason });
        }
        return res.status(409).json({ error: blockedReason.reason, code: blockedReason.code });
      }

      const claimed = await claimCustomerForOutboundCall(customer.id);
      if (!claimed) {
        return res.status(409).json({ error: 'A call for this customer is already in progress' });
      }

      const call = await placeRealtimeCall({
        customerPhone: customer.phone,
        customerName: customer.name,
        customerId: customer.id,
        clientName: agentConfig?.client_name || CLIENT_NAME,
        agentId: agentConfig?.id || null,
        callType
      });

      const result = await dbRun(
        `INSERT INTO calls (
        customer_id, agent_id, outcome, provider_call_id, called_at, hot_lead_score,
        consent_message_played, call_script_version, supervisor_alert_level, call_direction, call_source, call_type,
        provider_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customer.id,
          agentConfig?.id || null,
          'initiated',
          call.sid,
          new Date().toISOString(),
          customer.priority_score || computePriorityScore(customer),
          1,
          agentConfig?.slug || 'hindi-feedback-v1',
          'normal',
          'outbound',
          'icallmate',
          callType,
          JSON.stringify({ request: call.requestPayload || null, response: call.raw || null })
        ]
      );

      await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', customer.id]);
      
      const callsTodayRow = await dbGet(
        `SELECT COUNT(*) as count FROM calls c WHERE c.customer_id = ? AND DATE(c.called_at, 'localtime') = DATE('now', 'localtime') AND COALESCE(c.call_direction, 'outbound') = 'outbound'`,
        [customer.id]
      );
      const attempt = callsTodayRow ? callsTodayRow.count : 1;
      logger.info('CALL_ATTEMPT_STARTED', { phone: customer.phone, attempt });

      logger.info('CALL_STARTED', {
        callId: result.lastID,
        customerId: customer.id,
        patient: customer.name,
        phone: customer.phone,
        type: logger.formatCallType(callType),
        provider: 'icallmate',
        providerCallId: call.sid
      });
      schedulePendingCallDiagnostic(call.sid, {
        customerId: customer.id,
        customerPhone: customer.phone,
        customerName: customer.name,
        agentId: agentConfig?.id || null,
        trigger: '/api/calls/initiate/:customerId'
      });
      res.json({ message: 'Call initiated', callId: result.lastID, sid: call.sid, agentId: agentConfig?.id || null, agentName: agentConfig?.name || null });
    } catch (error) {
      if (customer?.id) {
        try {
          await releaseCustomerOutboundClaim(customer.id, customer.status || 'pending');
        } catch (releaseError) {
          console.error('[API CALL CLAIM RELEASE ERROR]', releaseError.message);
        }
      }
      logger.error('CALL_FAILED', {
        customerId: customer?.id,
        patient: customer?.name,
        phone: customer?.phone,
        reason: error.message
      });
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/calls/incoming', async (req, res) => {
    pruneIncomingCallState();
    const dbRows = await dbAll(
      `SELECT
       calls.id,
       calls.provider_call_id AS stream_id,
       customers.name AS caller_name,
       customers.phone AS phone,
       calls.did,
       calls.call_direction,
       calls.outcome AS status,
       calls.called_at AS received_at,
       calls.answered_at,
       calls.ended_at,
       calls.media_packets,
       calls.last_event,
       calls.notes,
       calls.created_at,
       calls.provider_payload_json
     FROM calls
     JOIN customers ON customers.id = calls.customer_id
     WHERE calls.call_direction = 'incoming'
     ORDER BY COALESCE(calls.ended_at, calls.answered_at, calls.called_at, calls.created_at) DESC
     LIMIT 100`
    );

    const seen = new Set(dbRows.map((row) => row.stream_id).filter(Boolean));
    const liveOnlyRows = [...incomingCallState.values()].filter((row) => row.stream_id && !seen.has(row.stream_id));
    const calls = [
      ...dbRows.map((row) => ({
        ...row,
        status: row.status || 'active',
        updated_at: row.ended_at || row.answered_at || row.received_at || row.created_at
      })),
      ...liveOnlyRows
    ].sort((a, b) => new Date(b.updated_at || b.received_at || 0) - new Date(a.updated_at || a.received_at || 0));

    res.json({
      calls,
      active_count: calls.filter((call) => call.status === 'active').length,
      missed_count: calls.filter((call) => call.status === 'missed').length,
      completed_count: calls.filter((call) => call.status === 'completed').length,
      total_media_packets: calls.reduce((sum, call) => sum + Number(call.media_packets || 0), 0),
      updated_at: new Date().toISOString()
    });
  });

  app.get('/api/calls/metrics', async (req, res) => {
    try {
      const rows = await dbAll(
        `SELECT
         COALESCE(call_direction, 'outbound') AS direction,
         COALESCE(outcome, 'unknown') AS outcome,
         COUNT(*) AS count,
         SUM(CASE WHEN DATE(called_at) = DATE('now') THEN 1 ELSE 0 END) AS today_count,
         SUM(COALESCE(media_packets, 0)) AS media_packets
       FROM calls
       GROUP BY COALESCE(call_direction, 'outbound'), COALESCE(outcome, 'unknown')`
      );

      const summary = {
        inbound: { total: 0, today: 0, active: 0, completed: 0, missed: 0, media_packets: 0 },
        outbound: { total: 0, today: 0, initiated: 0, completed: 0, failed: 0, scheduled: 0, media_packets: 0 },
        all: { total: 0, today: 0, media_packets: 0 }
      };

      for (const row of rows) {
        const direction = row.direction === 'incoming' ? 'inbound' : 'outbound';
        const outcome = String(row.outcome || 'unknown').toLowerCase();
        const count = Number(row.count || 0);
        const todayCount = Number(row.today_count || 0);
        const mediaPackets = Number(row.media_packets || 0);
        const target = summary[direction];

        target.total += count;
        target.today += todayCount;
        target.media_packets += mediaPackets;
        summary.all.total += count;
        summary.all.today += todayCount;
        summary.all.media_packets += mediaPackets;

        if (direction === 'inbound') {
          if (outcome === 'active') target.active += count;
          if (outcome === 'completed') target.completed += count;
          if (outcome === 'missed') target.missed += count;
        } else {
          if (['initiated', 'scheduled_initiated', 'active'].includes(outcome)) target.initiated += count;
          if (outcome === 'completed') target.completed += count;
          if (['failed', 'busy', 'no_answer'].includes(outcome)) target.failed += count;
          if (outcome === 'scheduled_initiated') target.scheduled += count;
        }
      }

      res.json({
        ...summary,
        updated_at: new Date().toISOString()
      });
    } catch (error) {
      console.error('[CALL METRICS ERROR]', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/icallmate/config', async (req, res) => {
    const requestBaseUrl = getRequestPublicBaseUrl(req);
    const token = createMediaToken();
    res.json({
      websocket_url: `${toWssUrl(requestBaseUrl, `/icallmate/media?token=${token}`)}`,
      did: process.env.ICALLMATE_DID || ICALLMATE_DEFAULT_DID,
      test_number: process.env.ICALLMATE_TEST_NUMBER || ICALLMATE_DEFAULT_TEST_NUMBER,
      incoming_api_endpoint: process.env.ICALLMATE_IBD_API_ENDPOINT || 'https://crm.icallmate.in',
      outbound_api_endpoint: process.env.ICALLMATE_OBD_API_ENDPOINT || 'https://ecp1.icallmate.in',
      callback_url: buildIcallMateCallbackUrl(requestBaseUrl),
      audio_format: {
        sampleRate: 8000,
        encoding: 'LINEAR16',
        channels: 1,
        bitsPerSample: 16
      }
    });
  });

  app.post('/api/icallmate/callback', async (req, res) => {
    try {
      if (!hasValidIcallMateWebhookSecret(req)) {
        return res.status(401).json({ error: 'Invalid webhook secret' });
      }

      const payload = req.body || {};
      const key = String(payload.ref_no || payload.leadid || payload.phoneno || `${Date.now()}`);
      const callType = String(payload.call_type || '').toLowerCase();
      const status = String(payload.call_status || '') === '1' ? 'completed' : 'missed';
      const eventName = payload.event || payload.call_event || payload.call_status || 'callback';
      const callerId = payload.callerId || payload.phoneno || payload.customer_number || '';
      const did = payload.did || payload.serviceno || payload.dnis || '';

      logger.info('ICALLMATE_CALLBACK', {
        event: eventName,
        key,
        callerId,
        did,
        callType: callType || 'unknown',
        status
      });

      if (callType === 'inbound' || callType === 'inbou' || !callType) {
        incomingCallState.set(key, {
          id: key,
          stream_id: key,
          caller_name: payload.customer_name || 'Incoming caller',
          phone: payload.phoneno || '--',
          did: payload.serviceno || '',
          call_direction: 'incoming',
          status,
          received_at: normalizeIcallTimestamp(payload.call_start_time),
          updated_at: new Date().toISOString(),
          notes: payload.recording_filename ? 'Callback received with recording' : 'Callback received',
          last_event: 'callback',
          answered_at: payload.call_ansd_time ? normalizeIcallTimestamp(payload.call_ansd_time) : null,
          ended_at: payload.call_end_time ? normalizeIcallTimestamp(payload.call_end_time) : null,
          recording_url: payload.recording_filename || '',
          talktime: payload.talktime || ''
        });

        await upsertIncomingCallFromIcall({
          streamId: key,
          callerId: callerId || payload.phoneno || '',
          did,
          event: 'callback',
          timestamp: payload.call_start_time || payload.timestamp,
          extraParams: JSON.stringify({ callbackPayload: true })
        }, {
          status,
          call_direction: 'incoming',
          caller_name: payload.customer_name || 'Incoming caller',
          answered_at: payload.call_ansd_time ? normalizeIcallTimestamp(payload.call_ansd_time) : null,
          ended_at: payload.call_end_time ? normalizeIcallTimestamp(payload.call_end_time) : null,
          notes: payload.recording_filename ? 'Callback received with recording' : 'Callback received'
        });
      } else {
        const phone = payload.phoneno || payload.customer_number || '';
        const mappedOutcome = status === 'completed' ? 'completed' : 'no_answer';

        if (phone) {
          const cleanPhone = phone.replace(/^\\+91/, '').slice(-10);
          const callRecord = await dbGet(`
            SELECT calls.* FROM calls
            JOIN customers ON customers.id = calls.customer_id
            WHERE customers.phone LIKE '%' || ? AND calls.call_direction = 'outbound'
            ORDER BY calls.id DESC LIMIT 1
          `, [cleanPhone]);

          if (callRecord) {
            await dbRun('UPDATE calls SET outcome = ?, status = ?, outcome_detail = ?, recording_url = COALESCE(NULLIF(?, \'\'), recording_url) WHERE id = ?', [
              mappedOutcome,
              mappedOutcome,
              payload.call_status || 'callback',
              payload.recording_filename || '',
              callRecord.id
            ]);

            if (mappedOutcome === 'completed' && payload.recording_filename) {
              setTimeout(() => {
                runInBackground('POST CALL PIPELINE ERROR', async () => {
                  const result = await processCompletedCallPipeline({ dbGet, dbRun, callSid: callRecord.provider_call_id, callId: callRecord.id });
                  if (result.ok) {
                    console.log(`[POST CALL PIPELINE] Processed call ${callRecord.provider_call_id} with feedback ${result.feedbackId}`);
                  } else {
                    console.log(`[POST CALL PIPELINE] Skipped call ${callRecord.provider_call_id}: ${result.reason}`);
                  }
                });
              }, 1500);
            }

            const customer = await dbGet('SELECT * FROM customers WHERE id = ?', [callRecord.customer_id]);
            if (customer) {
              await applyCallOutcomeWorkflow({
                dbGet,
                dbRun,
                callRecord: { ...callRecord, outcome: mappedOutcome },
                customer,
                providerStatus: payload.call_status || mappedOutcome,
                inferredOutcome: mappedOutcome
              });
            }
          }
        }
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[ICALLMATE CALLBACK ERROR]', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/icallmate/incoming-config', async (req, res) => {
    try {
      const requestBaseUrl = getRequestPublicBaseUrl(req);
      const dnisNo = String(req.body.dnisNo || req.body.virtualNumber || process.env.ICALLMATE_DID || ICALLMATE_DEFAULT_DID).trim();
      if (!dnisNo) {
        return res.status(400).json({ error: 'dnisNo or virtualNumber is required' });
      }

      const endpoint = `${String(process.env.ICALLMATE_IBD_API_ENDPOINT || 'https://crm.icallmate.in').replace(/\/+$/, '')}/Test_WSS/setMacroDnis`;
      const token = createMediaToken({ reusable: true });
      const websocketUrl = req.body.wsurl || req.body.websocket_url || `${toWssUrl(requestBaseUrl, `/icallmate/media?token=${token}`)}`;
      const callbackUrl = req.body.callbackapi || req.body.callback_url || buildIcallMateCallbackUrl(requestBaseUrl);
      const macros = [
        { dnisNo, macroName: 'llm_wssurl', macroValue: websocketUrl },
        { dnisNo, macroName: 'llm_botid', macroValue: String(req.body.botid || process.env.ICALLMATE_BOT_ID || '') },
        { dnisNo, macroName: 'llm_agentid', macroValue: String(req.body.agentid || process.env.ICALLMATE_AGENT_ID || '') },
        { dnisNo, macroName: 'llm_extraparam', macroValue: String(req.body.extraParams || req.body.extra_param || 'path-lab') },
        { dnisNo, macroName: 'llm_iscallbackapi', macroValue: String(req.body.iscallbackapi ?? '0') },
        { dnisNo, macroName: 'llm_callbackapi', macroValue: callbackUrl }
      ];

      if (String(req.body.dryRun || '').toLowerCase() === 'true') {
        return res.json({ endpoint, macros, dryRun: true });
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(macros)
      });
      const text = await response.text();
      let parsed = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch (error) {
        parsed = { rawText: text };
      }
      const providerSuccess = response.ok && String(parsed.status || '').toLowerCase() !== 'failure';

      res.status(providerSuccess ? 200 : (response.ok ? 502 : response.status)).json({
        success: providerSuccess,
        endpoint,
        macros,
        response: text
      });
    } catch (error) {
      console.error('[ICALLMATE INCOMING CONFIG ERROR]', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // app.post('/api/icallmate/outbound-campaign', async (req, res) => {
  //   try {
  //     const requestBaseUrl = getRequestPublicBaseUrl(req);
  //     const endpoint = `${String(process.env.ICALLMATE_OBD_API_ENDPOINT || 'https://ecp1.icallmate.in').replace(/\/+$/, '')}/OBDAPI/webresources/CreateOBDCampaignPost`;
  //     const msisdnlist = Array.isArray(req.body.msisdnlist) ? req.body.msisdnlist : [];
  //     if (!msisdnlist.length) {
  //       return res.status(400).json({ error: 'msisdnlist is required' });
  //     }

  //     const payload = {
  //       sourcetype: String(req.body.sourcetype || '0'),
  //       customivr: req.body.customivr ?? true,
  //       campaigntype: String(req.body.campaigntype || '4'),
  //       filetype: String(req.body.filetype || '2'),
  //       ukey: req.body.ukey || process.env.ICALLMATE_UKEY || '',
  //       serviceno: req.body.serviceno || process.env.ICALLMATE_SERVICE_NO || '',
  //       ivrtemplateid: req.body.ivrtemplateid || process.env.ICALLMATE_IVR_TEMPLATE_ID || '',
  //       maxTalkTimeInSec: Number(req.body.maxTalkTimeInSec || 0),
  //       retryatmpt: String(req.body.retryatmpt || '2'),
  //       sendnow: String(req.body.sendnow || '0'),
  //       schddate: req.body.schddate || '',
  //       retryduration: String(req.body.retryduration || '5'),
  //       s_unique: req.body.s_unique || '',
  //       msisdnlist: msisdnlist.map((item) => ({
  //         ...item,
  //         wsurl: item.wsurl || `${toWssUrl(requestBaseUrl, '/icallmate/media')}`,
  //         agentid: String(item.agentid || process.env.ICALLMATE_AGENT_ID || '0'),
  //         iscallbackapi: String(item.iscallbackapi ?? '0'),
  //         callbackapi: item.callbackapi || `${requestBaseUrl}/api/icallmate/callback`
  //       }))
  //     };

  //     if (String(req.body.dryRun || '').toLowerCase() === 'true') {
  //       return res.json({ endpoint, payload, dryRun: true });
  //     }

  //     const response = await fetch(endpoint, {
  //       method: 'POST',
  //       headers: { 'Content-Type': 'application/json' },
  //       body: JSON.stringify(payload)
  //     });
  //     const text = await response.text();
  //     let parsed = {};
  //     try {
  //       parsed = text ? JSON.parse(text) : {};
  //     } catch (error) {
  //       parsed = { rawText: text };
  //     }
  //     const providerSuccess = response.ok && String(parsed.status || '').toLowerCase() !== 'failure';

  //     res.status(providerSuccess ? 200 : (response.ok ? 502 : response.status)).json({
  //       success: providerSuccess,
  //       endpoint,
  //       response: text
  //     });
  //   } catch (error) {
  //     console.error('[ICALLMATE OUTBOUND CAMPAIGN ERROR]', error.message);
  //     res.status(500).json({ error: error.message });
  //   }
  // });

  app.post('/api/icallmate/outgoing-call', async (req, res) => {
    let customer = null;
    try {
      const fieldpairs = Array.isArray(req.body.fieldpairs) ? req.body.fieldpairs : [];
      const firstFieldPair = fieldpairs[0] || {};
      const phone = req.body.Phone_No || req.body.phone || req.body.customerPhone || firstFieldPair.Phone_No;
      const leadId = req.body.leadid || req.body.leadId || '1031';
      const campid = req.body.campid || '54';
      const wsurl = firstFieldPair.wsurl || req.body.wsurl || toWssUrl(getRequestPublicBaseUrl(req), '/icallmate/media');
      const callbackapi = buildIcallMateCallbackUrl(getRequestPublicBaseUrl(req));
      const customerName = req.body.customerName || firstFieldPair.Name || 'Outgoing Customer';
      const requestedAgentId = Number(req.body.agentId || req.query.agentId || 0) || null;
      const callType = normalizeOutboundCallType(req.body.callType || req.body.call_type || firstFieldPair.callType || firstFieldPair.call_type);

      if (!phone) {
        return res.status(400).json({ error: 'Phone_No, phone, customerPhone, or fieldpairs[0].Phone_No is required' });
      }

      const payload = buildMasterPostPayload(phone, leadId, { campid, wsurl, callbackapi });
      if (String(req.body.dryRun || '').toLowerCase() === 'true') {
        return res.json({
          success: true,
          dryRun: true,
          endpoint: process.env.ICALLMATE_MASTER_POST_API_ENDPOINT || 'https://crm.icallmate.in/WebSVC111/setMasterPostAPI',
          payload
        });
      }

      customer = await ensureCustomerForCall({
        customerId: req.body.customerId,
        customerName,
        customerPhone: phone
      });
      customer = await hydratePreCallIntelligence(customer);
      const agentConfig = requestedAgentId ? await getAgentConfigById(requestedAgentId) : await getDefaultAgentConfig();
      const blockedReason = await shouldBlockCustomerCall(customer);
      if (blockedReason) {
        if (blockedReason.code === 'CALL_SKIPPED_QUIET_HOURS') {
          logger.warn('CALL_SKIPPED_QUIET_HOURS', { phone: customer.phone, scheduledTime: 'Manual Trigger', reason: blockedReason.reason });
        } else if (blockedReason.code === 'CALL_BLOCKED_DAILY_LIMIT') {
          logger.error('CALL_BLOCKED_DAILY_LIMIT', { phone: customer.phone, reason: blockedReason.reason });
        }
        return res.status(409).json({ error: blockedReason.reason, code: blockedReason.code });
      }

      const claimed = await claimCustomerForOutboundCall(customer.id);
      if (!claimed) {
        return res.status(409).json({ error: 'A call for this customer is already in progress' });
      }

      const call = await initiateCall(phone, customer.id, {
        provider: 'masterpost',
        campid,
        leadid: leadId,
        wsurl,
        callbackapi,
        customerName: customer.name || customerName,
        clientName: agentConfig?.client_name || CLIENT_NAME,
        agentId: agentConfig?.id || null,
        callType
      });

      const result = await dbRun(
        `INSERT INTO calls (
        customer_id, agent_id, outcome, provider_call_id, called_at, hot_lead_score,
        consent_message_played, call_script_version, supervisor_alert_level, call_direction, call_source,
        provider_payload_json, call_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customer.id,
          agentConfig?.id || null,
          'initiated',
          call.sid,
          new Date().toISOString(),
          customer.priority_score || computePriorityScore(customer),
          1,
          agentConfig?.slug || 'gemini-deepgram-outgoing-v1',
          'normal',
          'outbound',
          'icallmate-masterpost',
          JSON.stringify({ request: call.requestPayload || payload, response: call.raw || null }),
          callType
        ]
      );

      await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', customer.id]);
      logger.info('CALL_STARTED', {
        callId: result.lastID,
        customerId: customer.id,
        patient: customer.name || customerName,
        phone: customer.phone || phone,
        type: logger.formatCallType(callType),
        provider: 'icallmate-masterpost',
        providerCallId: call.sid
      });
      schedulePendingCallDiagnostic(call.sid, {
        customerId: customer.id,
        customerPhone: phone,
        customerName: customer.name || customerName,
        agentId: agentConfig?.id || null,
        trigger: '/api/icallmate/outgoing-call'
      });

      res.json({
        success: true,
        message: 'Outgoing call initiated',
        sid: call.sid,
        callId: result.lastID,
        customerId: customer.id,
        agentId: agentConfig?.id || null,
        provider: 'icallmate-masterpost',
        payload
      });
    } catch (error) {
      if (customer?.id) {
        try {
          await releaseCustomerOutboundClaim(customer.id, customer.status || 'pending');
        } catch (releaseError) {
          console.error('[OUTGOING CALL CLAIM RELEASE ERROR]', releaseError.message);
        }
      }
      logger.error('CALL_FAILED', {
        customerId: customer?.id,
        patient: customer?.name,
        phone: customer?.phone || req.body.Phone_No || req.body.phone || req.body.customerPhone,
        reason: error.message
      });
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/icallmate/health', (req, res) => {
    const requestBaseUrl = getRequestPublicBaseUrl(req);
    res.json({
      ok: true,
      websocket_path: '/icallmate/media',
      websocket_url: `${toWssUrl(requestBaseUrl, '/icallmate/media')}`,
      did: process.env.ICALLMATE_DID || ICALLMATE_DEFAULT_DID,
      test_number: process.env.ICALLMATE_TEST_NUMBER || ICALLMATE_DEFAULT_TEST_NUMBER,
      timestamp: new Date().toISOString()
    });
  });

  app.get('/icallmate/media', (req, res) => {
    const requestBaseUrl = getRequestPublicBaseUrl(req);
    res.status(426).json({
      error: 'WebSocket upgrade required',
      websocket_url: `${toWssUrl(requestBaseUrl, '/icallmate/media')}`,
      expected_protocol: 'wss',
      did: process.env.ICALLMATE_DID || ICALLMATE_DEFAULT_DID
    });
  });

  app.get('/api/calls/recent', async (req, res) => {
    try {
      const rows = await dbAll(
        `SELECT
         calls.id,
         calls.customer_id,
         calls.agent_id,
         customers.name AS customer_name,
         customers.phone AS customer_phone,
         agents.name AS agent_name,
         agents.slug AS agent_slug,
         calls.called_at,
         calls.outcome,
         calls.outcome_detail,
         calls.call_type,
         calls.call_direction,
         calls.call_source,
         calls.did,
         calls.media_packets,
         calls.answered_at,
         calls.ended_at,
         calls.notes,
         calls.provider_call_id,
         calls.recording_sid,
         calls.recording_url,
         calls.recording_status,
         calls.recording_local_path,
         calls.transcript_text,
         calls.transcript_status,
         calls.transcript_source,
         calls.analysis_status,
         calls.summary,
         calls.analysis_summary,
         calls.analysis_json,
         calls.key_points_json,
         calls.report_excerpt,
         calls.language,
         calls.extracted_rating,
         calls.extracted_review_text,
         calls.sentiment_label,
         calls.sentiment,
         calls.sentiment_score,
         calls.call_duration,
         calls.ai_talk_time,
         calls.patient_talk_time,
         calls.quality_score,
         calls.timeline_events,
         calls.extracted_entities,
         calls.hot_lead_score,
         calls.next_action_at,
         calls.follow_up_task,
         calls.crm_sync_status,
         calls.live_sentiment_score,
         calls.live_sentiment_label,
         calls.live_red_flag,
         calls.supervisor_alert_level,
         calls.human_escalation_requested,
         calls.objections_json,
         calls.competitor_mentions_json
       FROM calls
       JOIN customers ON customers.id = calls.customer_id
       LEFT JOIN agents ON agents.id = calls.agent_id
       ORDER BY calls.id DESC
       LIMIT 25`
      );

      res.json(rows);
    } catch (error) {
      console.error('[RECENT CALLS ERROR]', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/calls/:callId(\\d+)', async (req, res) => {
    try {
      const row = await dbGet(
        `SELECT
         calls.id,
         calls.customer_id,
         calls.agent_id,
         customers.name AS customer_name,
         customers.phone AS customer_phone,
         agents.name AS agent_name,
         agents.slug AS agent_slug,
         calls.called_at,
         calls.outcome,
         calls.call_type,
         calls.call_direction,
         calls.call_source,
         calls.did,
         calls.media_packets,
         calls.answered_at,
         calls.ended_at,
         calls.notes,
         calls.provider_call_id,
         calls.recording_sid,
         calls.recording_url,
         calls.recording_status,
         calls.recording_local_path,
         calls.transcript_text,
         calls.transcript_status,
         calls.transcript_source,
         calls.analysis_status,
         calls.summary,
         calls.analysis_summary,
         calls.analysis_json,
         calls.key_points_json,
         calls.report_excerpt,
         calls.language,
         calls.extracted_rating,
         calls.extracted_review_text,
         calls.sentiment_label,
         calls.sentiment,
         calls.sentiment_score,
         calls.call_duration,
         calls.ai_talk_time,
         calls.patient_talk_time,
         calls.quality_score,
         calls.timeline_events,
         calls.extracted_entities,
         calls.hot_lead_score,
         calls.next_action_at,
         calls.follow_up_task,
         calls.crm_sync_status,
         calls.live_sentiment_score,
         calls.live_sentiment_label,
         calls.live_red_flag,
         calls.supervisor_alert_level,
         calls.human_escalation_requested,
         calls.objections_json,
         calls.competitor_mentions_json
       FROM calls
       JOIN customers ON customers.id = calls.customer_id
       LEFT JOIN agents ON agents.id = calls.agent_id
      WHERE calls.id = ?`,
        [req.params.callId]
      );

      if (!row) {
        return res.status(404).json({ error: 'Call not found' });
      }

      const storedAnalysis = safeJsonParse(row.analysis_json, null);
      const generatedAnalysis = buildCallAnalysis(row);
      const analysis = storedAnalysis?.product_analysis || storedAnalysis || generatedAnalysis;
      const timelineEvents = safeJsonParse(row.timeline_events, analysis.timeline_events || []);
      const extractedEntities = safeJsonParse(row.extracted_entities, analysis.entities || {});

      res.json({
        ...row,
        summary: row.summary || row.analysis_summary || analysis.summary || null,
        analysis_summary: row.analysis_summary || row.summary || analysis.summary || null,
        sentiment: row.sentiment || row.sentiment_label || analysis.sentiment || 'neutral',
        sentiment_label: row.sentiment_label || row.sentiment || analysis.sentiment || 'neutral',
        sentiment_score: Number(row.sentiment_score || analysis.sentiment_score || 0),
        call_duration: Number(row.call_duration || analysis.metrics?.total_duration || 0),
        ai_talk_time: Number(row.ai_talk_time || analysis.metrics?.ai_talk_time || 0),
        patient_talk_time: Number(row.patient_talk_time || analysis.metrics?.patient_talk_time || 0),
        quality_score: Number(row.quality_score || analysis.quality_score || 0),
        timeline_events: timelineEvents,
        extracted_entities: extractedEntities,
        analysis: {
          ...generatedAnalysis,
          ...analysis,
          timeline_events: timelineEvents,
          entities: extractedEntities,
          summary: row.summary || row.analysis_summary || analysis.summary || generatedAnalysis.summary,
          sentiment: row.sentiment || row.sentiment_label || analysis.sentiment || generatedAnalysis.sentiment,
          sentiment_score: Number(row.sentiment_score || analysis.sentiment_score || generatedAnalysis.sentiment_score || 0),
          quality_score: Number(row.quality_score || analysis.quality_score || generatedAnalysis.quality_score || 0)
        }
      });
    } catch (error) {
      console.error('[CALL DETAIL ERROR]', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/calls/:callId(\\d+)/analyze', async (req, res) => {
    try {
      const call = await dbGet(
        `SELECT calls.*, customers.name AS customer_name, customers.phone AS customer_phone, agents.name AS agent_name, agents.slug AS agent_slug
         FROM calls
         JOIN customers ON customers.id = calls.customer_id
         LEFT JOIN agents ON agents.id = calls.agent_id
        WHERE calls.id = ?`,
        [req.params.callId]
      );

      if (!call) {
        return res.status(404).json({ error: 'Call not found' });
      }

      logger.info('FEEDBACK_ANALYSIS_STARTED', {
        callId: call.id,
        customerId: call.customer_id,
        patient: call.customer_name,
        phone: call.customer_phone,
        source: 'manual_rerun'
      });
      const existingAnalysisJson = call.analysis_json ? (typeof safeJsonParse === 'function' ? safeJsonParse(call.analysis_json, {}) : JSON.parse(call.analysis_json)) : {};
      const productAnalysis = buildCallAnalysis(call);
      const analysis = {
        ...existingAnalysisJson,
        ...productAnalysis,
        product_analysis: productAnalysis
      };
      await storeCallAnalysis({ dbRun, callId: call.id, analysis });
      const updatedCall = await dbGet('SELECT * FROM calls WHERE id = ?', [call.id]);
      const sentiment = updatedCall.sentiment || updatedCall.sentiment_label || analysis.sentiment || 'neutral';
      const rating = Number(updatedCall.extracted_rating || 0);
      logger.info('FEEDBACK_ANALYSIS_COMPLETED', {
        callId: call.id,
        customerId: call.customer_id,
        patient: call.customer_name,
        phone: call.customer_phone,
        sentiment,
        rating: rating ? `${rating}/5` : ''
      });
      res.json({
        success: true,
        call: updatedCall,
        analysis
      });
    } catch (error) {
      console.error('[CALL ANALYSIS RERUN ERROR]', error.message);
      res.status(500).json({ error: 'Failed to re-run analysis' });
    }
  });

  app.get('/api/calls/:callId(\\d+)/analysis-pdf', async (req, res) => {
    try {
      const call = await dbGet(
        `SELECT calls.*, customers.name AS customer_name, customers.phone AS customer_phone, agents.name AS agent_name, agents.slug AS agent_slug
         FROM calls
         JOIN customers ON customers.id = calls.customer_id
         LEFT JOIN agents ON agents.id = calls.agent_id
        WHERE calls.id = ?`,
        [req.params.callId]
      );

      if (!call) {
        return res.status(404).json({ error: 'Call not found' });
      }

      const storedAnalysis = safeJsonParse(call.analysis_json, null);
      const analysis = storedAnalysis?.product_analysis || storedAnalysis || buildCallAnalysis(call);
      const pdfPath = await generateCallAnalysisPDF({
        call,
        analysis: {
          ...buildCallAnalysis(call),
          ...analysis,
          timeline_events: safeJsonParse(call.timeline_events, analysis.timeline_events || []),
          entities: safeJsonParse(call.extracted_entities, analysis.entities || {})
        }
      });

      const filename = `Call-Analysis-${call.id}-${new Date().toISOString().slice(0, 10)}.pdf`;
      res.download(pdfPath, filename);
    } catch (error) {
      console.error('[CALL ANALYSIS PDF ERROR]', error.message);
      res.status(500).json({ error: 'Failed to export analysis PDF' });
    }
  });

  app.get('/api/calls/live', async (req, res) => {
    try {
      pruneLiveCallState();
      const inMemoryRows = [...liveCallState.values()];
      const seenCallSids = new Set(inMemoryRows.map((row) => row.call_sid).filter(Boolean));
      const now = Date.now();
      const recentDbRows = await dbAll(
        `SELECT
         calls.id,
         calls.customer_id,
         calls.agent_id,
         calls.called_at,
         calls.outcome,
         calls.provider_call_id,
         calls.transcript_text,
         calls.live_sentiment_score,
         calls.live_sentiment_label,
         calls.live_red_flag,
         calls.supervisor_alert_level,
         calls.human_escalation_requested,
         customers.name AS customer_name,
         agents.name AS agent_name
       FROM calls
       JOIN customers ON customers.id = calls.customer_id
       LEFT JOIN agents ON agents.id = calls.agent_id
       WHERE DATETIME(calls.called_at) >= DATETIME('now', '-60 minutes')
       ORDER BY calls.called_at DESC
       LIMIT 12`
      );

      const mergedRows = [
        ...inMemoryRows,
        ...recentDbRows
          .filter((row) => row.provider_call_id && !seenCallSids.has(row.provider_call_id))
          .map((row) => {
            const calledAtMs = new Date(row.called_at || 0).getTime();
            const isFreshPending = (
              (row.outcome === 'initiated' || row.outcome === 'scheduled_initiated')
              && calledAtMs
              && !Number.isNaN(calledAtMs)
              && (now - calledAtMs) <= (10 * 60 * 1000)
            );

            return {
              call_sid: row.provider_call_id,
              customer_name: row.customer_name,
              customer_id: row.customer_id,
              call_id: row.id,
              started_at: row.called_at,
              transcript_preview: buildTranscriptPreviewText(row.transcript_text),
              live_sentiment_label: row.live_sentiment_label || 'neutral',
              live_sentiment_score: Number(row.live_sentiment_score || 0),
              red_flag: Boolean(Number(row.live_red_flag || 0)),
              escalation_requested: Boolean(Number(row.human_escalation_requested || 0)),
              status: isFreshPending ? 'active' : 'recent',
              agent_id: row.agent_id,
              agent_name: row.agent_name || 'Default Feedback Agent',
              supervisor_alert_level: row.supervisor_alert_level || 'normal'
            };
          })
      ].sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0));

      res.json(mergedRows);
    } catch (error) {
      console.error('[LIVE CALLS ERROR]', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/calls/:callId/supervisor-events', async (req, res) => {
    try {
      const rows = await dbAll(
        'SELECT * FROM call_supervisor_events WHERE call_id = ? ORDER BY created_at DESC LIMIT 50',
        [req.params.callId]
      );
      res.json(rows);
    } catch (error) {
      console.error('[SUPERVISOR EVENTS ERROR]', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/calls/:callId/escalate', async (req, res) => {
    try {
      await dbRun(
        'UPDATE calls SET human_escalation_requested = ?, supervisor_alert_level = ?, supervisor_notes = ? WHERE id = ?',
        [1, 'critical', String(req.body.note || 'Manual escalation requested').trim(), req.params.callId]
      );
      await createSupervisorEvent({
        dbRun,
        callId: Number(req.params.callId),
        eventType: 'human_escalation_requested',
        severity: 'critical',
        payload: { note: String(req.body.note || 'Manual escalation requested').trim() }
      });
      res.json({ success: true });
    } catch (error) {
      console.error('[CALL ESCALATION ERROR]', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/calls/:callId/recording', async (req, res) => {
    try {
      const call = await dbGet('SELECT id, provider_call_id, recording_url, recording_status, recording_local_path FROM calls WHERE id = ?', [req.params.callId]);

      if (call?.recording_local_path) {
        const fs = require('fs');
        if (fs.existsSync(call.recording_local_path)) {
          res.setHeader('Content-Type', 'audio/wav');
          res.setHeader('Cache-Control', 'private, max-age=300');
          return res.sendFile(call.recording_local_path);
        }
      }

      if (!call?.recording_url && !call?.provider_call_id) {
        return res.status(404).json({ error: 'Recording not available yet' });
      }

      let playbackUrl = call.recording_url || null;
      let response = playbackUrl
        ? await fetch(playbackUrl)
        : null;

      if (!response || !response.ok) {
        const statusCode = response?.status || 404;
        return res.status(statusCode).json({ error: `Unable to fetch recording (${statusCode})` });
      }

      const arrayBuffer = await response.arrayBuffer();
      res.setHeader('Content-Type', response.headers.get('content-type') || 'audio/mpeg');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(Buffer.from(arrayBuffer));
    } catch (error) {
      console.error('[RECORDING PROXY ERROR]', error.message);
      res.status(500).json({ error: 'Failed to stream recording' });
    }
  });

  app.delete('/api/calls/bulk', async (req, res) => {
    try {
      const counts = await dbGet('SELECT COUNT(*) AS call_count FROM calls');
      await dbRun('DELETE FROM call_supervisor_events');
      await dbRun('DELETE FROM calls');
      logger.warn('ALL_RECORDS_DELETED', {
        deletedBy: req.adminSession?.username || 'admin',
        calls: counts?.call_count || 0,
        scope: 'call_history'
      });
      res.json({ message: 'All call history deleted successfully' });
    } catch (error) {
      console.error('Error in calls bulk delete:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/calls/:callId/transcript', async (req, res) => {
    try {
      const call = await dbGet(
        `SELECT
         calls.id,
         calls.provider_call_id,
         calls.called_at,
         calls.outcome,
         calls.language,
         calls.transcript_text,
         calls.transcript_status,
         customers.name AS customer_name
       FROM calls
       LEFT JOIN customers ON customers.id = calls.customer_id
       WHERE calls.id = ?`,
        [req.params.callId]
      );

      if (!call) {
        return res.status(404).json({ error: 'Call not found' });
      }

      if (!call.transcript_text) {
        return res.status(404).json({ error: 'Transcript not available yet' });
      }

      res.setHeader('Cache-Control', 'private, max-age=300');

      if (String(req.query.raw || '') === '1') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(call.transcript_text);
        return;
      }

      const turns = String(call.transcript_text || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^\[([A-Z]+)\]:\s*(.*)$/);
          return {
            role: match?.[1] || 'NOTE',
            text: match?.[2] || line
          };
        });

      const escapedTurns = turns.map((turn) => ({
        role: String(turn.role).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])),
        text: String(turn.text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]))
      }));

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Call Transcript</title>
  <style>
    :root {
      --bg: #f4f8ff;
      --panel: #ffffff;
      --line: rgba(118, 146, 182, 0.18);
      --text: #18233f;
      --muted: #6f7e99;
      --blue: #2d6df6;
      --green: #2ea043;
      --shadow: 0 18px 40px rgba(65, 92, 136, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Aptos", "Segoe UI", sans-serif;
      background: linear-gradient(180deg, #f9fbff 0%, #eef4ff 100%);
      color: var(--text);
      padding: 28px;
    }
    .shell {
      max-width: 980px;
      margin: 0 auto;
      background: rgba(255,255,255,0.88);
      border: 1px solid var(--line);
      border-radius: 28px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .hero {
      padding: 28px 30px 20px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(135deg, rgba(45,109,246,0.10), rgba(45,109,246,0.02));
    }
    .hero h1 { margin: 0 0 8px; font-size: 30px; }
    .muted { color: var(--muted); }
    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 14px;
      margin-top: 18px;
    }
    .meta-card {
      padding: 14px 16px;
      border-radius: 18px;
      background: #fff;
      border: 1px solid var(--line);
    }
    .meta-card strong { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
    .body { padding: 26px 30px 30px; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 22px; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 12px 16px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--text);
      text-decoration: none;
      font-weight: 700;
    }
    .btn.primary { background: linear-gradient(135deg, #2d6df6 0%, #1d57d7 100%); color: #fff; border-color: transparent; }
    .turns { display: grid; gap: 14px; }
    .turn {
      border-radius: 20px;
      padding: 16px 18px;
      border: 1px solid var(--line);
      background: #fff;
    }
    .turn.agent { border-left: 4px solid var(--blue); }
    .turn.customer { border-left: 4px solid var(--green); }
    .turn.note { border-left: 4px solid #9aa9c5; }
    .turn-role {
      font-size: 12px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 800;
      margin-bottom: 8px;
    }
    .turn-text {
      white-space: pre-wrap;
      line-height: 1.7;
      font-size: 15px;
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="hero">
      <h1>Call Transcript</h1>
      <div class="muted">Readable transcript view for review, QA, and reporting.</div>
      <div class="meta">
        <div class="meta-card"><strong>Customer</strong>${call.customer_name || 'Customer'}</div>
        <div class="meta-card"><strong>Call SID</strong>${call.provider_call_id || '--'}</div>
        <div class="meta-card"><strong>Outcome</strong>${call.outcome || '--'}</div>
        <div class="meta-card"><strong>Called At</strong>${call.called_at ? new Date(call.called_at).toLocaleString() : '--'}</div>
      </div>
    </div>
    <div class="body">
      <div class="actions">
        <a class="btn primary" href="${getSecurePublicBaseUrl() || ''}/admin.html">Open Dashboard</a>
        <a class="btn" href="?raw=1" target="_blank" rel="noopener">Open Raw Transcript</a>
      </div>
      <div class="turns">
        ${escapedTurns.map((turn) => `
          <div class="turn ${turn.role === 'AGENT' ? 'agent' : turn.role === 'CUSTOMER' ? 'customer' : 'note'}">
            <div class="turn-role">${turn.role}</div>
            <div class="turn-text">${turn.text}</div>
          </div>
        `).join('')}
      </div>
    </div>
  </div>
</body>
</html>`);
    } catch (error) {
      console.error('[TRANSCRIPT FETCH ERROR]', error.message);
      res.status(500).json({ error: 'Failed to fetch transcript' });
    }
  });

};
