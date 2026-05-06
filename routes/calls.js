const express = require('express');
const router = express.Router();
const { dbRun, dbGet, dbAll } = require('../db');
const { initiateCall } = require('../services/exotel');

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

    // Initiate Exotel call
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

    res.status(500).json({ error: error.message });
  }
});

// Status callback from Exotel
router.post('/status', async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const callStatus = req.body.Status || req.body.CallStatus;

    console.log(`Call status update: ${callSid} -> ${callStatus}`);

    const call = await dbGet('SELECT * FROM calls WHERE twilio_sid = ?', [callSid]);

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
