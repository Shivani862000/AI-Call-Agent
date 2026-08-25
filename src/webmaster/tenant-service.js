'use strict';

const bcrypt = require('bcrypt');
const { WebmasterError } = require('./errors');

const TRANSITIONS = Object.freeze({ suspend: 'suspended', archive: 'archived', restore: 'active' });
const SAFE_FIELDS = ['name', 'primaryContact', 'address', 'timezone', 'dailyReportTime', 'branding', 'plan', 'limits', 'billingContact', 'internalNotes', 'tags'];
const FEEDBACK_CATEGORIES = new Set(['positive', 'negative', 'neutral', 'complaint', 'suggestion', 'question']);

function problem(status, code, message, fieldErrors = {}) {
  return new WebmasterError({ status, code, message, fieldErrors });
}

function valueOf(record) { return record && typeof record.toObject === 'function' ? record.toObject() : record; }
function objectValue(value) { return value instanceof Map ? Object.fromEntries(value) : (value || {}); }
function safeSearch(value) { return String(value || '').trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function toSafeTenant(record) {
  const item = valueOf(record) || {};
  return {
    id: String(item._id || item.id || ''),
    name: item.name || '',
    primaryContact: item.primaryContact || {},
    address: item.address || '',
    timezone: item.timezone || 'Asia/Kolkata',
    dailyReportTime: item.dailyReportTime || '19:00',
    branding: item.branding || {},
    plan: item.plan || 'standard',
    limits: item.limits || {},
    billingContact: item.billingContact || '',
    internalNotes: item.internalNotes || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    settingsOverrides: objectValue(item.settingsOverrides),
    status: item.status || 'active',
    createdAt: item.created_at || item.createdAt || null,
    updatedAt: item.updated_at || item.updatedAt || null,
    version: Number(item.__v || item.version || 0)
  };
}

function validateProfile(input = {}, { creating = false } = {}) {
  const fieldErrors = {};
  if (creating && (!input.name || !String(input.name).trim())) fieldErrors.name = 'Tenant name is required';
  if (input.dailyReportTime != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.dailyReportTime))) fieldErrors.dailyReportTime = 'Use HH:mm';
  if (input.timezone != null && (!String(input.timezone).trim() || String(input.timezone).length > 80)) fieldErrors.timezone = 'Timezone is invalid';
  for (const [key, value] of Object.entries(input.limits || {})) if (!Number.isSafeInteger(value) || value < 0) fieldErrors[`limits.${key}`] = 'Limit must be a non-negative integer';
  if (Object.keys(fieldErrors).length) throw problem(422, 'TENANT_VALIDATION_FAILED', 'Tenant details are invalid', fieldErrors);
}

function createTenantService(deps = {}) {
  const { TenantModel, UserModel, CustomerModel, CallModel, FeedbackModel, NotificationModel, auditService, integrationStatus = async () => [], startSession, passwordPolicy = async () => ({ minLength: 12, maxLength: 128 }) } = deps;
  if (!TenantModel) throw new TypeError('TenantModel is required');

  async function list({ status, search, page = 1, pageSize = 25 } = {}) {
    const size = Math.min(100, Math.max(1, Number(pageSize) || 25));
    const current = Math.max(1, Number(page) || 1);
    const filter = { ...(status ? { status } : { status: { $ne: 'archived' } }), ...(safeSearch(search) ? { $or: [{ name: { $regex: safeSearch(search), $options: 'i' } }, { plan: { $regex: safeSearch(search), $options: 'i' } }, { tags: { $regex: safeSearch(search), $options: 'i' } }] } : {}) };
    const [rows, total] = await Promise.all([
      TenantModel.find(filter).sort({ updated_at: -1 }).skip((current - 1) * size).limit(size).lean(),
      TenantModel.countDocuments(filter)
    ]);
    return { items: rows.map(toSafeTenant), page: current, pageSize: size, total, totalPages: Math.ceil(total / size) };
  }

  async function createWithAdmin(input = {}, actor = {}) {
    validateProfile(input, { creating: true });
    if (!UserModel || !input.initialAdmin) throw problem(422, 'INITIAL_ADMIN_REQUIRED', 'Initial administrator is required', { initialAdmin: 'Required' });
    const admin = input.initialAdmin;
    const policy = await passwordPolicy();
    const minLength = Math.max(8, Number(policy?.minLength) || 12);
    const maxLength = Math.max(minLength, Number(policy?.maxLength) || 128);
    if (!admin.username || !admin.email || !admin.password || String(admin.password).length < minLength || String(admin.password).length > maxLength) throw problem(422, 'INITIAL_ADMIN_INVALID', 'Initial administrator is invalid', { initialAdmin: `Username, email, and a password of ${minLength}-${maxLength} characters are required` });
    const session = startSession ? await startSession() : await TenantModel.startSession();
    let tenant;
    try {
      await session.withTransaction(async () => {
        const profile = Object.fromEntries(SAFE_FIELDS.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
        [tenant] = await TenantModel.create([profile], { session });
        await UserModel.create([{ username: String(admin.username).trim(), email: String(admin.email).trim().toLowerCase(), password_hash: await bcrypt.hash(String(admin.password), 10), role: 'CLIENT_ADMIN', tenantId: tenant._id, status: 'active', password_changed_at: new Date() }], { session });
      });
    } catch (error) {
      if (error?.code === 11000) throw problem(409, 'TENANT_CONFLICT', 'Tenant or administrator already exists', { identity: 'Name, username, or email is already used' });
      throw error;
    } finally { await session.endSession?.(); }
    await auditService?.record({ actor, action: 'tenant.create', target: { type: 'tenant', id: String(tenant._id) }, tenantId: String(tenant._id), after: toSafeTenant(tenant) });
    return toSafeTenant(tenant);
  }

  async function update(id, patch = {}, expectedVersion, actor = {}) {
    validateProfile(patch);
    const safePatch = Object.fromEntries(SAFE_FIELDS.filter(key => patch[key] !== undefined).map(key => [key, patch[key]]));
    const tenant = await TenantModel.findOneAndUpdate({ _id: id, __v: Number(expectedVersion) }, { $set: safePatch, $inc: { __v: 1 } }, { new: true, runValidators: true }).lean();
    if (!tenant) throw problem(409, 'TENANT_VERSION_CONFLICT', 'Tenant changed; refresh and retry');
    await auditService?.record({ actor, action: 'tenant.update', target: { type: 'tenant', id: String(id) }, tenantId: String(id), after: toSafeTenant(tenant) });
    return toSafeTenant(tenant);
  }

  async function transition(id, transitionName, expectedVersion, actor = {}, reason = '') {
    const status = TRANSITIONS[transitionName];
    if (!status) throw problem(422, 'TENANT_TRANSITION_INVALID', 'Lifecycle transition is invalid');
    const now = new Date();
    const fields = status === 'archived'
      ? { status, archived_at: now, archived_by: actor.username || 'system', archive_reason: String(reason || '').slice(0, 500) || null }
      : { status, archived_at: null, archived_by: null, archive_reason: null };
    const tenant = await TenantModel.findOneAndUpdate({ _id: id, __v: Number(expectedVersion) }, { $set: fields, $inc: { __v: 1 } }, { new: true, runValidators: true }).lean();
    if (!tenant) throw problem(409, 'TENANT_VERSION_CONFLICT', 'Tenant changed; refresh and retry');
    await auditService?.record({ actor, action: `tenant.${transitionName}`, target: { type: 'tenant', id: String(id) }, tenantId: String(id), after: { status } });
    return toSafeTenant(tenant);
  }

  async function get(id) {
    const tenant = await TenantModel.findById(id).lean();
    if (!tenant) throw problem(404, 'TENANT_NOT_FOUND', 'Tenant not found');
    return toSafeTenant(tenant);
  }

  async function getOperationalSnapshot(id) {
    const tenant = await get(id);
    const scoped = { tenantId: id };
    const [customers, totalCalls, callGroups, totalFeedback, feedbackGroups, failedNotifications, integrations] = await Promise.all([
      CustomerModel?.countDocuments({ ...scoped, status: { $ne: 'archived' } }) || 0,
      CallModel?.countDocuments({ ...scoped, status: { $ne: 'archived' } }) || 0,
      CallModel?.aggregate([{ $match: scoped }, { $group: { _id: '$status', count: { $sum: 1 } } }]) || [],
      FeedbackModel?.countDocuments({ ...scoped, status: { $ne: 'archived' } }) || 0,
      FeedbackModel?.aggregate([{ $match: scoped }, { $group: { _id: '$category', count: { $sum: 1 } } }]) || [],
      NotificationModel?.countDocuments({ ...scoped, status: 'failed' }) || 0,
      integrationStatus(id)
    ]);
    const grouped = rows => Object.fromEntries(rows.map(row => [String(row._id || 'unknown'), Number(row.count || 0)]));
    const safeFeedback = {};
    for (const row of feedbackGroups) {
      const category = FEEDBACK_CATEGORIES.has(String(row._id || '').toLowerCase()) ? String(row._id).toLowerCase() : 'other';
      safeFeedback[category] = (safeFeedback[category] || 0) + Number(row.count || 0);
    }
    return { tenant, usage: { customers, calls: totalCalls, feedback: totalFeedback }, calls: grouped(callGroups), feedback: safeFeedback, integrations, notifications: { failed: failedNotifications } };
  }

  return { list, get, createWithAdmin, update, transition, getOperationalSnapshot };
}

module.exports = { createTenantService, toSafeTenant, validateProfile };
