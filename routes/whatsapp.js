const express = require('express');
const router = express.Router();
const { dbGet, dbRun } = require('../db');
const { sendWhatsAppMessage } = require('../services/icallmate');

// Send WhatsApp message for a call
router.post('/send/:callId', async (req, res) => {
  try {
    const { callId } = req.params;

    // Fetch call and customer
    const call = await dbGet('SELECT * FROM calls WHERE id = ?', [callId]);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const customer = await dbGet('SELECT * FROM customers WHERE id = ?', [call.customer_id]);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Build WhatsApp message
    const message = `Namaste ${customer.name}! Aapse baat karne ke liye dhanyavaad.
Kripya WhatsApp par yeh Google Form fill karke apna feedback share kar dijiye: ${process.env.GOOGLE_REVIEW_LINK}
Dhanyavaad!`;

    const result = await sendWhatsAppMessage(customer.phone, message);

    // Update call record
    await dbRun('UPDATE calls SET whatsapp_sent = 1 WHERE id = ?', [callId]);

    res.json({
      message: 'WhatsApp sent successfully',
      sid: result.sid
    });
  } catch (error) {
    console.error('Error sending WhatsApp:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
