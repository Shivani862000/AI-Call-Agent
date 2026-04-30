const express = require('express');
const router = express.Router();
const { dbGet, dbRun } = require('../db');
const { generateCallScript } = require('../services/openai');

// TwiML intro script
router.get('/intro', async (req, res) => {
  try {
    const { customerId } = req.query;

    if (!customerId) {
      return res.status(400).send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Invalid request.</Say></Response>');
    }

    // Fetch customer
    const customer = await dbGet('SELECT * FROM customers WHERE id = ?', [customerId]);

    if (!customer) {
      return res.status(404).send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Customer not found.</Say></Response>');
    }

    // Generate intro script using OpenAI
    const script = await generateCallScript(customer.name);

    // Get the base URL for gather callback (for production, use ngrok or actual domain)
    const baseUrl = process.env.WEBHOOK_URL || `http://localhost:${process.env.PORT || 3000}`;

    // Build TwiML response
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${script}</Say>
  <Gather numDigits="1" action="${baseUrl}/api/twiml/gather?customerId=${customerId}" method="POST">
    <Say>Press 1 to receive a review link, or press 2 to skip.</Say>
  </Gather>
  <Say>We didn't receive your input. Goodbye.</Say>
  <Hangup></Hangup>
</Response>`;

    res.set('Content-Type', 'text/xml');
    res.send(twiml);
  } catch (error) {
    console.error('Error generating TwiML intro:', error);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>An error occurred. Goodbye.</Say>
  <Hangup></Hangup>
</Response>`;
    res.set('Content-Type', 'text/xml');
    res.status(500).send(twiml);
  }
});

// TwiML gather (digit input)
router.post('/gather', async (req, res) => {
  try {
    const { customerId } = req.query;
    const { Digits, CallSid } = req.body;

    console.log(`Gather input: ${Digits} from call ${CallSid}`);

    // Find call
    const call = await dbGet('SELECT * FROM calls WHERE twilio_sid = ?', [CallSid]);

    if (call) {
      if (Digits === '1') {
        // User agreed - mark as consent_given
        await dbRun('UPDATE calls SET outcome = ? WHERE id = ?', ['consent_given', call.id]);
        
        // Trigger WhatsApp send
        try {
          const baseUrl = process.env.WEBHOOK_URL || `http://localhost:${process.env.PORT || 3000}`;
          await fetch(`${baseUrl}/api/whatsapp/send/${call.id}`, { method: 'POST' });
        } catch (err) {
          console.error('Error triggering WhatsApp:', err.message);
        }
      } else if (Digits === '2') {
        // User declined
        await dbRun('UPDATE calls SET outcome = ? WHERE id = ?', ['declined', call.id]);
      }
    }

    // Return thank you TwiML
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Thank you. Have a great day!</Say>
  <Hangup></Hangup>
</Response>`;

    res.set('Content-Type', 'text/xml');
    res.send(twiml);
  } catch (error) {
    console.error('Error processing gather:', error);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Thank you. Have a great day!</Say>
  <Hangup></Hangup>
</Response>`;
    res.set('Content-Type', 'text/xml');
    res.status(500).send(twiml);
  }
});

module.exports = router;
