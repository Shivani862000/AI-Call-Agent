'use strict';

const mongoose = require('mongoose');

const supportTicketCounterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  sequence: { type: Number, required: true, default: 0 }
}, { versionKey: false });

module.exports = mongoose.model('SupportTicketCounter', supportTicketCounterSchema);
