const mongoose = require('mongoose');

const callSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  call_type: {
    type: String,
    required: true
  },
  status: {
    type: String,
    required: true
  },
  recording_url: {
    type: String,
    default: null
  },
  transcript: {
    type: String,
    default: null
  },
  duration_seconds: {
    type: Number,
    default: 0
  },
  started_at: {
    type: Date,
    default: Date.now
  },
  completed_at: {
    type: Date,
    default: null
  }
});

module.exports = mongoose.model('Call', callSchema);
