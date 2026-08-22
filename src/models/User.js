const mongoose = require('mongoose');

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
    enum: ['active', 'inactive'],
    default: 'active'
  },
  created_at: {
    type: Date,
    default: Date.now
  }
});

// Index to ensure email is unique globally, and username is unique globally
// Mongoose handles unique fields with unique:true but we should ensure they are explicit
userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ email: 1 }, { unique: true });

module.exports = mongoose.model('User', userSchema);
