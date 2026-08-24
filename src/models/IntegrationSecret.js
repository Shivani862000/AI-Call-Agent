'use strict';

const mongoose = require('mongoose');

function validBase64Length(value, byteLength) {
  if (typeof value !== 'string' || !value) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === byteLength && decoded.toString('base64') === value;
}

function validCiphertext(value) {
  if (typeof value !== 'string' || !value) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 && decoded.toString('base64') === value;
}

const integrationSecretSchema = new mongoose.Schema({
  integration: { type: String, required: true, trim: true, maxlength: 128 },
  key: { type: String, required: true, trim: true, maxlength: 128 },
  ciphertext: {
    type: String,
    required: true,
    select: false,
    validate: { validator: validCiphertext, message: 'Invalid encrypted secret ciphertext' }
  },
  iv: {
    type: String,
    required: true,
    select: false,
    validate: { validator: (value) => validBase64Length(value, 12), message: 'Invalid encrypted secret IV' }
  },
  authTag: {
    type: String,
    required: true,
    select: false,
    validate: { validator: (value) => validBase64Length(value, 16), message: 'Invalid encrypted secret authentication tag' }
  },
  encryptionVersion: { type: Number, enum: [1], default: 1, required: true },
  updatedBy: { type: String, required: true, maxlength: 128 },
  updatedByAccessLevel: { type: String, enum: ['OWNER', 'ADMIN', 'SYSTEM'], required: true }
}, {
  strict: true,
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

integrationSecretSchema.index({ integration: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('IntegrationSecret', integrationSecretSchema);
