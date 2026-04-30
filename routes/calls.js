const express = require('express');
const router = express.Router();
const { dbRun, dbGet, dbAll } = require('../db');
const { initiateCall } = require('../services/twilio');

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

    // Initiate Twilio call
    const call = await initiateCall(
      customer.phone,
      customerId,
      `${baseUrl}/api/calls/status`,
      `${baseUrl}/api/twiml/intro?customerId=${customerId}`
    );

    // Save call record
    const result = await dbRun(
      'INSERT INTO calls (customer_id, outcome, twilio_sid, called_at) VALUES (?, ?, ?, ?)',
      [customerId, 'initiated', call.sid, new Date().toISOString()]
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

    if (error.isTwilioTrialRestriction) {
      const { customerId } = req.params;

      await dbRun(
        'INSERT INTO calls (customer_id, outcome, called_at) VALUES (?, ?, ?)',
        [customerId, 'twilio_unverified', new Date().toISOString()]
      );
      await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['twilio_trial_blocked', customerId]);

      return res.status(400).json({ error: error.userMessage });
    }

    res.status(500).json({ error: error.message });
  }
});

// Status callback from Twilio
router.post('/status', async (req, res) => {
  try {
    const { CallSid, CallStatus, Digits } = req.body;

    console.log(`Call status update: ${CallSid} -> ${CallStatus}`);

    // Find call by Twilio SID
    const call = await dbGet('SELECT * FROM calls WHERE twilio_sid = ?', [CallSid]);

    if (call) {
      if (CallStatus === 'no-answer' || CallStatus === 'failed') {
        await dbRun('UPDATE calls SET outcome = ? WHERE id = ?', ['no_answer', call.id]);
        await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['no_answer', call.customer_id]);
      } else if (CallStatus === 'completed') {
        // Outcome should be updated via TwiML gather
        console.log(`Call completed: ${CallSid}`);
      }
    }

    // Return empty TwiML response
    res.set('Content-Type', 'text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (error) {
    console.error('Error processing call status:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
