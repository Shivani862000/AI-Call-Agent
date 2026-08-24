const mongoose = require('mongoose');

const agentSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name: { type: String, required: true },
  slug: { type: String, required: true },
  description: { type: String, default: null },
  client_name: { type: String, default: null },
  language: { type: String, default: 'hi' },
  voice_pipeline: { type: String, default: 'legacy' },
  stt_provider: { type: String, default: 'deepgram' },
  llm_provider: { type: String, default: 'gemini' },
  llm_model: { type: String, default: null },
  tts_provider: { type: String, default: 'native' },
  tts_voice: { type: String, default: null },
  system_prompt: { type: String, default: null },
  opening_prompt: { type: String, default: null },
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
  archived_at: { type: Date, default: null },
  archived_by: { type: String, default: null },
  archive_reason: { type: String, default: null },
  pre_archive_status: { type: String, default: null },
  is_active: { type: Boolean, default: true },
  is_default: { type: Boolean, default: false }
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

agentSchema.index({ tenantId: 1, name: 1 }, { unique: true });
agentSchema.index({ tenantId: 1, slug: 1 }, { unique: true });

module.exports = mongoose.model('Agent', agentSchema);
