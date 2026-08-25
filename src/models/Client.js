'use strict';

const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  date_of_birth: { type: String, default: null },
  last_visit_date: { type: String, required: true },
  treatment_type: { type: String, required: true },
  annual_reminder_enabled: { type: Number, default: 1 },
  annual_reminder_slot: { type: String, default: '10:00' },
  next_annual_reminder_date: { type: String, default: null },
  last_annual_reminder_at: { type: Date, default: null },
  last_annual_reminder_year: { type: Number, default: null },
  notes: { type: String, default: null },
  status: { type: String, enum: ['active', 'paused', 'archived'], default: 'active' },
  archived_at: { type: Date, default: null },
  archived_by: { type: String, default: null },
  archive_reason: { type: String, default: null },
  pre_archive_status: { type: String, default: null }
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

clientSchema.index({ tenantId: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model('Client', clientSchema);
