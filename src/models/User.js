const mongoose = require('mongoose');

const PLATFORM_ACCESS_LEVELS = ['OWNER', 'ADMIN'];

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password_hash: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['WEBMASTER', 'SUPPORT_TEAM', 'CLIENT_ADMIN', 'CLIENT_AGENT'],
    required: true
  },
  platformAccessLevel: {
    type: String,
    enum: PLATFORM_ACCESS_LEVELS,
    default: null,
    validate: {
      validator(value) {
        return this.role === 'WEBMASTER' ? Boolean(value) : value == null;
      },
      message: 'Platform access level is valid only for Webmaster accounts'
    }
  },
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: function() {
      // WEBMASTER and SUPPORT_TEAM can be system-level (null tenantId)
      return this.role === 'CLIENT_ADMIN' || this.role === 'CLIENT_AGENT';
    }
  },
  status: {
    type: String,
    enum: ['active', 'suspended', 'archived'],
    default: 'active'
  },
  password_changed_at: {
    type: Date,
    default: null
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

module.exports = mongoose.model('User', userSchema);
