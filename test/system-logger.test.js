'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { maskPhone, sanitizeLogDetails } = require('../services/system-logger');

test('system logs mask phones and remove sensitive text fields', () => {
  assert.equal(maskPhone('+91 98765 43210'), '***3210');
  assert.deepEqual(
    sanitizeLogDetails({
      phone: '+91 98765 43210',
      patient: 'Example Patient',
      transcript: 'private conversation',
      token: 'secret-token',
      callId: 42,
      reason: 'provider timeout'
    }),
    {
      phone: '***3210',
      patient: '[redacted]',
      transcript: '[redacted]',
      token: '[redacted]',
      callId: 42,
      reason: 'provider timeout'
    }
  );
});
