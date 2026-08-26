const CUSTOMER_BOOLEAN_FIELDS = [
  'do_not_call',
  'wrong_number_flag',
  'admin_review_required'
];

const CALL_BOOLEAN_FIELDS = [
  'consent_detected',
  'whatsapp_sent',
  'fallback_triggered',
  'whatsapp_summary_sent',
  'interest_detected',
  'callback_requested',
  'human_escalation_requested',
  'consent_message_played',
  'recording_consent_captured',
  'invoice_triggered',
  'proposal_triggered',
  'live_red_flag'
];

function safeId(value, field) {
  if (value === null || value === undefined) return value;

  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number)) {
    const error = new Error(`${field} is outside JavaScript's safe integer range`);
    error.code = 'UNSAFE_DATABASE_ID';
    throw error;
  }
  return number;
}

function mapIds(row, fields) {
  for (const field of fields) {
    if (Object.hasOwn(row, field)) row[field] = safeId(row[field], field);
  }
}

function mapBooleans(row, fields) {
  for (const field of fields) {
    if (typeof row[field] === 'boolean') row[field] = row[field] ? 1 : 0;
  }
}

function moveJson(row, source, target) {
  if (!Object.hasOwn(row, source)) return;
  row[target] = row[source] === null ? null : JSON.stringify(row[source]);
  delete row[source];
}

function clone(row) {
  return row === null || row === undefined ? row : { ...row };
}

function toApiCustomer(input) {
  const row = clone(input);
  if (row === null || row === undefined) return row;
  mapIds(row, ['id', 'client_id']);
  mapBooleans(row, CUSTOMER_BOOLEAN_FIELDS);
  return row;
}

function toApiCall(input) {
  const row = clone(input);
  if (row === null || row === undefined) return row;
  mapIds(row, ['id', 'client_id', 'customer_id']);
  mapBooleans(row, CALL_BOOLEAN_FIELDS);
  moveJson(row, 'analysis', 'analysis_json');
  moveJson(row, 'key_points', 'key_points_json');
  moveJson(row, 'objections', 'objections_json');
  moveJson(row, 'competitor_mentions', 'competitor_mentions_json');
  return row;
}

function toApiFeedback(input) {
  const row = clone(input);
  if (row === null || row === undefined) return row;
  mapIds(row, ['id', 'client_id', 'customer_id', 'call_id']);
  return row;
}

function toApiSupervisorEvent(input) {
  const row = clone(input);
  if (row === null || row === undefined) return row;
  mapIds(row, ['id', 'client_id', 'call_id']);
  moveJson(row, 'payload', 'payload_json');
  return row;
}

module.exports = {
  toApiCall,
  toApiCustomer,
  toApiFeedback,
  toApiSupervisorEvent
};
