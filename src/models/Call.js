const mongoose = require('mongoose');

const callSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    default: null,
    required() { return !this.legacy_customer_ref_hash; }
  },
  legacy_customer_ref_hash: {
    type: String,
    default: null,
    select: false,
    match: /^[a-f0-9]{64}$/,
    required() { return !this.customerId; }
  },
  customer_phone_ref_hash: {
    type: String,
    default: null,
    select: false,
    match: /^[a-f0-9]{64}$/
  },
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent', default: null },
  call_type: { type: String, required: true },
  status: { type: String, required: true },
  archived_at: { type: Date, default: null },
  archived_by: { type: String, default: null },
  archive_reason: { type: String, default: null },
  pre_archive_status: { type: String, default: null },
  outcome: { type: String }, // e.g., initiated, scheduled_initiated, answered, no_answer
  provider_call_id: { type: String, default: null },
  context_state: {
    type: String,
    enum: [
      'prepared',
      'provider_acceptance_pending',
      'provider_failure_pending',
      'provider_accepted',
      'provider_failed'
    ],
    default: null
  },
  call_direction: { type: String, default: 'outbound' },
  call_source: { type: String, default: null },
  client_name: { type: String, default: null },
  provider_payload_json: { type: mongoose.Schema.Types.Mixed, default: null },
  recording_url: { type: String, default: null },
  transcript: { type: String, default: null }, // previously transcript_text
  transcript_status: { type: String },
  duration_seconds: { type: Number, default: 0 },
  started_at: { type: Date, default: Date.now }, // previously called_at
  completed_at: { type: Date, default: null }, // previously ended_at
  
  // Analysis Fields
  extracted_review_text: { type: String },
  extracted_rating: { type: Number },
  sentiment_label: { type: String },
  sentiment: { type: String },
  analysis_summary: { type: String },
  analysis_status: { type: String },
  analysis_json: { type: mongoose.Schema.Types.Mixed }, // Store JSON directly instead of string
  analysis_completed_at: { type: Date }
});

callSchema.index({ tenantId: 1, customer_phone_ref_hash: 1, started_at: -1 });

module.exports = mongoose.model('Call', callSchema);
