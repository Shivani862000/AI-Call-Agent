const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  toApiCall,
  toApiCustomer,
  toApiFeedback,
  toApiSupervisorEvent
} = require('../../persistence/mappers');

test('customer mapper preserves snake_case and converts database-native values', () => {
  const createdAt = new Date('2026-08-26T00:00:00.000Z');
  const row = {
    id: '41',
    client_id: '2',
    name: 'Asha Rao',
    do_not_call: true,
    wrong_number_flag: false,
    admin_review_required: true,
    created_at: createdAt
  };

  const mapped = toApiCustomer(row);

  assert.deepEqual(mapped, {
    id: 41,
    client_id: 2,
    name: 'Asha Rao',
    do_not_call: 1,
    wrong_number_flag: 0,
    admin_review_required: 1,
    created_at: createdAt
  });
  assert.equal(row.id, '41');
  assert.equal(row.do_not_call, true);
});

test('call mapper converts IDs, boolean flags, and jsonb compatibility fields', () => {
  const mapped = toApiCall({
    id: '7',
    client_id: '2',
    customer_id: '41',
    consent_detected: true,
    whatsapp_sent: false,
    fallback_triggered: true,
    analysis: { summary: 'Helpful visit' },
    key_points: ['clean'],
    objections: ['wait time'],
    competitor_mentions: ['Competitor A']
  });

  assert.equal(mapped.id, 7);
  assert.equal(mapped.client_id, 2);
  assert.equal(mapped.customer_id, 41);
  assert.equal(mapped.consent_detected, 1);
  assert.equal(mapped.whatsapp_sent, 0);
  assert.equal(mapped.fallback_triggered, 1);
  assert.equal(mapped.analysis_json, '{"summary":"Helpful visit"}');
  assert.equal(mapped.key_points_json, '["clean"]');
  assert.equal(mapped.objections_json, '["wait time"]');
  assert.equal(mapped.competitor_mentions_json, '["Competitor A"]');
  assert.equal('analysis' in mapped, false);
  assert.equal('key_points' in mapped, false);
});

test('feedback and supervisor event mappers convert related IDs and payload json', () => {
  assert.deepEqual(
    toApiFeedback({ id: '8', client_id: '2', customer_id: '41', call_id: null, stars: 5 }),
    { id: 8, client_id: 2, customer_id: 41, call_id: null, stars: 5 }
  );

  assert.deepEqual(
    toApiSupervisorEvent({
      id: '9',
      client_id: '2',
      call_id: '7',
      event_type: 'escalated',
      payload: { reason: 'requested' }
    }),
    {
      id: 9,
      client_id: 2,
      call_id: 7,
      event_type: 'escalated',
      payload_json: '{"reason":"requested"}'
    }
  );
});

test('mapper rejects a bigint outside JavaScript safe integer range', () => {
  assert.throws(
    () => toApiCustomer({ id: '9007199254740992', client_id: '1' }),
    (error) => error.code === 'UNSAFE_DATABASE_ID' && /id/.test(error.message)
  );
});

test('mappers preserve null and undefined inputs', () => {
  assert.equal(toApiCustomer(null), null);
  assert.equal(toApiCall(undefined), undefined);
});
