const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    unique: true
  },
  primaryContact: {
    name: { type: String, trim: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 32 }
  },
  address: { type: String, trim: true, maxlength: 500, default: '' },
  timezone: { type: String, trim: true, maxlength: 80, default: 'Asia/Kolkata' },
  branding: {
    displayName: { type: String, trim: true, maxlength: 120, default: '' },
    primaryColor: { type: String, trim: true, match: /^#[0-9a-f]{6}$/i, default: '#155eef' }
  },
  plan: { type: String, trim: true, maxlength: 64, default: 'standard' },
  limits: {
    users: { type: Number, min: 0, default: 25 },
    monthlyCalls: { type: Number, min: 0, default: 10000 }
  },
  billingContact: { type: String, trim: true, maxlength: 254, default: '' },
  internalNotes: { type: String, maxlength: 2000, default: '' },
  tags: [{ type: String, trim: true, maxlength: 40 }],
  settingsOverrides: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
  dailyReportTime: {
    type: String,
    default: '19:00', // Default 7:00 PM
    match: /^([01]\d|2[0-3]):([0-5]\d)$/
  },
  status: {
    type: String,
    enum: ['active', 'suspended', 'archived'],
    default: 'active'
  },
  archived_at: { type: Date, default: null },
  archived_by: { type: String, default: null },
  archive_reason: { type: String, default: null },
  pre_archive_status: { type: String, default: null },
  lifecycleGuardVersion: { type: Number, min: 0, default: 0, select: false }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

module.exports = mongoose.model('Tenant', tenantSchema);
