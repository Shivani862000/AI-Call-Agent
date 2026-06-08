const express = require('express');
const router = express.Router();
const { dbRun, dbGet, dbAll } = require('../db');
const { initiateCall } = require('../services/icallmate');
const { createMediaToken } = require('../src/auth');

// Initiate call to a customer
router.post('/initiate/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;

    // Fetch customer
    const customer = await dbGet('SELECT * FROM customers WHERE id = ?', [customerId]);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Get the base URL for callbacks (for production, use ngrok or actual domain)
    const baseUrl = process.env.WEBHOOK_URL || `http://localhost:${process.env.PORT || 3000}`;

    const call = await initiateCall(
      customer.phone,
      customerId,
      {
        baseUrl,
        callType: customer.call_type || 'REVIEW_CALL',
        wsurl: `${baseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')}/icallmate/media?token=${createMediaToken()}`,
        callbackapi: `${baseUrl}/api/icallmate/callback`
      }
    );

    // Save call record
    const result = await dbRun(
      'INSERT INTO calls (customer_id, outcome, provider_call_id, called_at, call_direction, call_source, call_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [customerId, 'initiated', call.sid, new Date().toISOString(), 'outbound', 'icallmate', customer.call_type || 'REVIEW_CALL']
    );

    // Update customer status
    await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', customerId]);

    res.json({
      message: 'Call initiated',
      callId: result.lastID,
      sid: call.sid
    });
  } catch (error) {
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
      if (callStatus === 'no-answer' || callStatus === 'failed') {
        await dbRun('UPDATE calls SET outcome = ? WHERE id = ?', ['no_answer', call.id]);
        await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['no_answer', call.customer_id]);
      } else if (callStatus === 'completed') {
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
