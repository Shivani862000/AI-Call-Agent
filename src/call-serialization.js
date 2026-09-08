'use strict';

const { maskPhone, maskEmail } = require('./patient-rules');

// Call/AI/provider rows can gain arbitrary JSON and free-text fields. An
// allowlist prevents new fields or nested joins silently widening AGENT access.
const AGENT_CALL_FIELDS = [
  'id', 'call_id', 'customer_id', 'patient_id', 'agent_id',
  'customer_name', 'caller_name', 'agent_name', 'agent_slug',
  'called_at', 'answered_at', 'ended_at', 'created_at', 'received_at',
  'started_at', 'updated_at', 'next_action_at',
  'outcome', 'call_type', 'call_direction', 'call_source', 'status',
  'recording_status', 'transcript_status', 'transcript_source', 'analysis_status',
  'language', 'extracted_rating', 'sentiment', 'sentiment_label', 'sentiment_score',
  'call_duration', 'ai_talk_time', 'patient_talk_time', 'quality_score',
  'media_packets', 'hot_lead_score', 'crm_sync_status',
  'live_sentiment_label', 'live_sentiment_score', 'live_red_flag',
  'red_flag', 'escalation_requested', 'human_escalation_requested', 'supervisor_alert_level'
];

function serializeCall(row, role) {
  if (!row) return row;
  if (String(role || '').toUpperCase() === 'ADMIN') return { ...row };

  const result = {};
  for (const field of AGENT_CALL_FIELDS) {
    if (Object.hasOwn(row, field)) result[field] = row[field];
  }
  result.phone_masked = maskPhone(row.normalized_phone || row.customer_phone || row.phone);
  result.email_masked = maskEmail(row.customer_email || row.email);
  return result;
}

module.exports = { serializeCall };
