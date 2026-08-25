'use strict';

const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name: { type: String, required: true, trim: true },
  service_name: { type: String, default: null },
  monthly_spend_inr: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'paused', 'archived'], default: 'active' },
  archived_at: { type: Date, default: null },
  archived_by: { type: String, default: null },
  archive_reason: { type: String, default: null },
  pre_archive_status: { type: String, default: null }
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

campaignSchema.index({ tenantId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Campaign', campaignSchema);
