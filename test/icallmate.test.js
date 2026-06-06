const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMasterPostPayload } = require('../services/icallmate');

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
