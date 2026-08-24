'use strict';

const mongoose = require('mongoose');

const platformSettingsSchema = new mongoose.Schema({
  singletonKey: {
    type: String,
    enum: ['platform'],
    default: 'platform',
    required: true,
    unique: true,
    immutable: true
  },
  schemaVersion: { type: Number, min: 1, default: 1, required: true },
  application: { type: mongoose.Schema.Types.Mixed, default: {} },
  defaults: { type: mongoose.Schema.Types.Mixed, default: {} },
  featureFlags: { type: mongoose.Schema.Types.Mixed, default: {} },
  policies: { type: mongoose.Schema.Types.Mixed, default: {} },
  providers: { type: mongoose.Schema.Types.Mixed, default: {} },
  notificationTemplates: { type: mongoose.Schema.Types.Mixed, default: {} },
  retention: { type: mongoose.Schema.Types.Mixed, default: {} },
  maintenance: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  strict: true,
  minimize: false,
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

module.exports = mongoose.model('PlatformSettings', platformSettingsSchema);
