const mongoose = require('mongoose');

const agentSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name: { type: String, required: true },
  slug: { type: String, required: true },
  client_name: { type: String, required: true },
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
  archived_at: { type: Date, default: null },
  archived_by: { type: String, default: null },
  archive_reason: { type: String, default: null },
  is_active: { type: Boolean, default: true },
  is_default: { type: Boolean, default: false }
});

module.exports = mongoose.model('Agent', agentSchema);
