const mongoose = require('mongoose');

const callSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  call_type: { type: String, required: true },
  status: { type: String, required: true },
  archived_at: { type: Date, default: null },
  archived_by: { type: String, default: null },
  archive_reason: { type: String, default: null },
  pre_archive_status: { type: String, default: null },
  outcome: { type: String }, // e.g., initiated, scheduled_initiated, answered, no_answer
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

module.exports = mongoose.model('Call', callSchema);
