const express = require('express');
const router = express.Router();
const { dbRun, dbGet, dbAll, dbTx } = require('../db');
const { initiateCall } = require('../services/icallmate');
const { normalizeOutboundCallType } = require('../src/helpers');
const { reserveOutboundAttempt, recordAttemptSubmission } = require('../services/outbound-admission');
const { buildIcallMateCallbackUrl } = require('../src/icallmate-webhook');
const logger = require('../services/system-logger');

// Initiate call to a customer
router.post('/initiate/:customerId', async (req, res) => {
  let attemptId = null;
  try {
    const { customerId } = req.params;

    // Fetch customer
    const customer = await dbGet('SELECT * FROM customer_queue WHERE id = ?', [customerId]);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Get the base URL for callbacks (for production, use ngrok or actual domain)
    const baseUrl = process.env.WEBHOOK_URL || `http://localhost:${process.env.PORT || 3000}`;

    const callType = normalizeOutboundCallType(customer.call_type || 'REVIEW_CALL');
    const admission = await reserveOutboundAttempt({
      dbTx,
      customerId,
      callType,
      requestKey: req.get('Idempotency-Key') || req.body?.requestKey,
      writerId: req.adminSession?.username || 'legacy-calls-router'
    });
    if (admission.outcome === 'duplicate') {
      return res.json({ message: 'Call already admitted', attemptId: admission.attemptId, sid: admission.attempt?.provider_call_id || null, idempotent: true });
    }
    if (admission.outcome !== 'accepted') {
      return res.status(admission.outcome === 'conflict' ? 409 : 422).json({ error: admission.reason, code: 'CALL_ADMISSION_REJECTED', requestKey: admission.requestKey });
    }
    attemptId = admission.attemptId;

    let call;
    try {
      call = await initiateCall(
        customer.phone,
        customerId,
        {
          baseUrl,
          callType,
          wsurl: `${baseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')}/icallmate/media`,
          callbackapi: buildIcallMateCallbackUrl(baseUrl)
        }
      );
    } catch (providerError) {
      const state = await recordAttemptSubmission({ dbTx, attemptId, error: providerError });
      return res.status(202).json({ error: 'Provider submission is unresolved; do not retry automatically', code: state.state.toUpperCase(), attemptId });
    }
    const submission = await recordAttemptSubmission({ dbTx, attemptId, response: call });
    if (submission.state !== 'submitted') {
      return res.status(submission.state === 'rejected' ? 502 : 202).json({ error: submission.reason, code: submission.state.toUpperCase(), attemptId });
    }

    // Save call record
    const result = await dbRun(
      'INSERT INTO calls (customer_id, patient_id, attempt_id, outcome, provider_call_id, called_at, call_direction, call_source, call_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [customerId, customer.patient_id, attemptId, 'initiated', call.sid, new Date().toISOString(), 'outbound', 'icallmate', callType]
    );

    // Update customer status
    await dbRun('UPDATE customers SET status = ?, locked_at = NULL WHERE id = ?', ['called', customerId]);

    res.json({
      message: 'Call initiated',
      callId: result.lastID,
      sid: call.sid
    });
  } catch (error) {
    if (attemptId) {
      logger.error('CALL_ATTEMPT_REQUIRES_RECONCILIATION', { customerId: req.params.customerId, attemptId, reason: error.message });
      return res.status(202).json({ error: 'Call admission was recorded but completion needs reconciliation', code: 'ATTEMPT_RECONCILIATION_REQUIRED', attemptId });
    }
    console.error('Error initiating call:', error);

    res.status(500).json({ error: error.message });
  }
});

// Status callback from iCallMate
router.post('/status', async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const callStatus = req.body.Status || req.body.CallStatus;

    console.log(`Call status update: ${callSid} -> ${callStatus}`);

    const call = await dbGet('SELECT * FROM calls WHERE provider_call_id = ?', [callSid]);

    if (call) {
      const statusMap = {
        'queued': 'queued',
        'initiated': 'initiated',
        'ringing': 'ringing',
        'in-progress': 'in_progress',
        'completed': 'completed',
        'busy': 'busy',
        'no-answer': 'no_answer',
        'canceled': 'cancelled',
        'failed': 'failed',
        'voicemail': 'voicemail'
      };
      
      const mappedStatus = statusMap[callStatus] || callStatus;
      
      // Update call table
      await dbRun('UPDATE calls SET outcome = ?, status = ?, last_event = ? WHERE id = ?', [
        ['completed', 'failed', 'busy', 'no_answer', 'cancelled'].includes(mappedStatus) ? mappedStatus : call.outcome,
        mappedStatus,
        callStatus,
        call.id
      ]);
      
      // Update customer table with the current state of the call
      await dbRun('UPDATE customers SET status = ? WHERE id = ?', [mappedStatus, call.customer_id]);
      
      // Retry Logic
      if (['failed', 'busy', 'no_answer'].includes(mappedStatus)) {
        const customer = await dbGet('SELECT * FROM customer_queue WHERE id = ?', [call.customer_id]);
        if (customer && customer.auto_retry_enabled !== 0) {
          const attemptCount = (customer.attempt_count || 0);
          if (attemptCount < 3) {
            // Schedule Retry
            const nextRetry = new Date(Date.now() + 3 * 60 * 60 * 1000);
            await dbRun('UPDATE customers SET status = ?, next_retry_at = ?, retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?', ['retry_scheduled', nextRetry.toISOString(), customer.id]);
            console.log(`Call retry scheduled for customerId=${customer.id} (Attempt ${attemptCount + 1})`);
          } else {
            // Max Retries Reached
            await dbRun('UPDATE customers SET status = ?, failed_reason = ? WHERE id = ?', ['failed', 'Max retries reached', customer.id]);
            console.log(`Max retries reached for customerId=${customer.id}`);
          }
        }
      }

      if (mappedStatus === 'completed') {
        console.log(`Call completed: ${callSid}`);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing call status:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
