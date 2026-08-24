const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  callId: { type: mongoose.Schema.Types.ObjectId, ref: 'Call' },
  rating: { type: Number, min: 1, max: 5 }, // equivalent to stars
  review_text: { type: String }, // equivalent to comments
  category: { type: String },
  source: { type: String, default: 'manual' },
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
  archived_at: { type: Date, default: null },
  archived_by: { type: String, default: null },
  archive_reason: { type: String, default: null },
  created_at: { type: Date, default: Date.now } // equivalent to submitted_at
});

module.exports = mongoose.model('Feedback', feedbackSchema);
