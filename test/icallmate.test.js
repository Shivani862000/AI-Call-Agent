const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMasterPostPayload,
  buildOutboundCampaignPayload
} = require('../services/icallmate');

test('builds iCallMate master-post outbound payload', () => {
  const payload = buildMasterPostPayload('9354197715', '1031', {
    campid: '54',
    wsurl: 'wss://kcpathlab.vikitechsolution.in/icallmate/media'
  });

  assert.deepEqual(payload, {
    campid: '54',
    leadid: '1031',
    fieldpairs: [
      {
        Phone_No: '9354197715',
        wsurl: 'wss://kcpathlab.vikitechsolution.in/icallmate/media'
      }
    ]
  });
});

test('includes call type in iCallMate outbound extra params', () => {
  const payload = buildOutboundCampaignPayload('+919876543210', 42, {
    customerName: 'Rahul Sharma',
    clientName: 'Apna Blood Centre',
    callType: 'THREE_MONTH_FOLLOWUP',
    wsurl: 'wss://example.com/icallmate/media'
  });

  const extraParams = JSON.parse(payload.msisdnlist[0].extraparam);
  assert.equal(extraParams.callType, 'THREE_MONTH_FOLLOWUP');
  assert.equal(extraParams.customerName, 'Rahul Sharma');
});
