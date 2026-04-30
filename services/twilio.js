const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function initiateCall(customerPhone, customerId, callbackUrl, twimlUrl) {
  try {
    const call = await client.calls.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: customerPhone,
      url: twimlUrl,
      statusCallback: callbackUrl,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });
    
    console.log(`✓ Call initiated: ${call.sid} to ${customerPhone}`);
    return call;
  } catch (error) {
    if (error.code === 21219) {
      error.isTwilioTrialRestriction = true;
      error.userMessage = 'Twilio trial accounts can only call verified numbers. Verify this number in Twilio or upgrade the account.';
    }

    console.error('Error initiating call:', error.message);
    throw error;
  }
}

async function sendWhatsAppMessage(customerPhone, message) {
  try {
    const msg = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${customerPhone}`,
      body: message
    });
    
    console.log(`✓ WhatsApp sent: ${msg.sid} to ${customerPhone}`);
    return msg;
  } catch (error) {
    console.error('Error sending WhatsApp:', error.message);
    throw error;
  }
}

module.exports = {
  initiateCall,
  sendWhatsAppMessage,
  client
};
