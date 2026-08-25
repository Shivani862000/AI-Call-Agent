'use strict';

const mongoose = require('mongoose');

const supportTicketSchema = new mongoose.Schema({
  ticket_id: { type: String, required: true, unique: true, index: true },
  sequence: { type: Number, required: true, unique: true },
  tenant_id: { type: String, default: null, index: true },
  type: { type: String, required: true, enum: ['BUG', 'IDEA', 'QUESTION'] },
  description: { type: String, required: true, maxlength: 4000 },
  status: { type: String, required: true, enum: ['NEW', 'IN_PROGRESS', 'RESOLVED'], default: 'NEW' },
  reporter_username: { type: String, required: true },
  reporter_role: { type: String, required: true },
  page_url: { type: String, required: true },
  page_title: { type: String, required: true },
  context_json: { type: mongoose.Schema.Types.Mixed, required: true },
  assignee_username: { type: String, default: null },
  internal_update: { type: String, default: null },
  resolution_note: { type: String, default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, { versionKey: false });

supportTicketSchema.index({ updated_at: -1 });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
