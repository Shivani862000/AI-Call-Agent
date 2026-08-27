const express = require('express');
const router = express.Router();
const { supabase } = require('../src/supabase');
const { initiateCall } = require('../services/icallmate');
const { buildIcallMateCallbackUrl } = require('../src/icallmate-webhook');

// Initiate call to a customer
router.post('/initiate/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;

    // Fetch customer
    const { data: customer, error: fetchError } = await supabase.from('customers').select('*').eq('id', customerId).single();
    if (fetchError || !customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const baseUrl = process.env.WEBHOOK_URL || `http://localhost:${process.env.PORT || 3000}`;

    const call = await initiateCall(
      customer.phone,
      customerId,
      {
        baseUrl,
        callType: customer.call_type || 'REVIEW_CALL',
        wsurl: `${baseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')}/icallmate/media`,
        callbackapi: buildIcallMateCallbackUrl(baseUrl)
      }
    );

    // Save call record
    const { data: result, error: insertError } = await supabase.from('calls').insert([{
      tenant_id: customer.tenant_id,
      customer_id: customerId,
      outcome: 'initiated',
      provider_call_id: call.sid,
      started_at: new Date().toISOString(),
      call_direction: 'outbound',
      call_source: 'icallmate',
      call_type: customer.call_type || 'REVIEW_CALL',
      status: 'initiated'
    }]).select().single();
    
    if (insertError) throw insertError;

    // Update customer status
    await supabase.from('customers').update({ status: 'initiated' }).eq('id', customerId);

    res.json({
      message: 'Call initiated',
      callId: result.id,
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

    const { data: call, error: findError } = await supabase.from('calls').select('*').eq('provider_call_id', callSid).maybeSingle();

    if (call && !findError) {
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
      const isFinal = ['completed', 'failed', 'busy', 'no_answer', 'cancelled'].includes(mappedStatus);
      const newOutcome = isFinal ? mappedStatus : call.outcome;
      
      // Update call table
      await supabase.from('calls').update({ outcome: newOutcome, status: mappedStatus, completed_at: isFinal ? new Date().toISOString() : null }).eq('id', call.id);
      
      // Update customer table
      await supabase.from('customers').update({ status: mappedStatus }).eq('id', call.customer_id);
      
      // Retry Logic
      if (['failed', 'busy', 'no_answer'].includes(mappedStatus)) {
        const { data: customer } = await supabase.from('customers').select('*').eq('id', call.customer_id).single();
        if (customer && customer.auto_retry_enabled !== 0) {
          const attemptCount = (customer.attempt_count || 0);
          if (attemptCount < 3) {
            // Schedule Retry
            const nextRetry = new Date(Date.now() + 3 * 60 * 60 * 1000);
            await supabase.from('customers').update({ 
              status: 'retry_scheduled', 
              next_retry_at: nextRetry.toISOString(), 
              retry_count: (customer.retry_count || 0) + 1 
            }).eq('id', customer.id);
            console.log(`Call retry scheduled for customerId=${customer.id} (Attempt ${attemptCount + 1})`);
          } else {
            // Max Retries Reached
            await supabase.from('customers').update({ 
              status: 'failed', 
              failed_reason: 'Max retries reached' 
            }).eq('id', customer.id);
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
