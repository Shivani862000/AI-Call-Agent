'use strict';

const bcrypt = require('bcrypt');
const { WebmasterError } = require('./errors');

const TENANT_ROLES = new Set(['CLIENT_ADMIN', 'CLIENT_AGENT']);
const TRANSITIONS = Object.freeze({ suspend: 'suspended', archive: 'archived', restore: 'active' });
function problem(status, code, message, fieldErrors = {}) { return new WebmasterError({ status, code, message, fieldErrors }); }
function valueOf(record) { return record && typeof record.toObject === 'function' ? record.toObject() : record; }
function toSafeUser(record) {
  const item = valueOf(record) || {};
  return {
    id: String(item._id || item.id || ''), username: item.username || '', email: item.email || '', role: item.role || '',
    tenantId: item.tenantId ? String(item.tenantId) : null, status: item.status || 'active', platformAccessLevel: item.platformAccessLevel || null,
    createdAt: item.created_at || item.createdAt || null, updatedAt: item.updated_at || item.updatedAt || null,
    passwordChangedAt: item.password_changed_at || null, version: Number(item.__v || item.version || 0)
  };
}
function requireOwner(actor) { if (actor?.platformAccessLevel !== 'OWNER') throw problem(403, 'WEBMASTER_OWNER_REQUIRED', 'Owner access is required'); }
function validateIdentity(input) {
  const fields = {};
  if (!input.username || String(input.username).trim().length < 3) fields.username = 'Username must be at least 3 characters';
  if (!input.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email))) fields.email = 'Valid email is required';
  if (Object.keys(fields).length) throw problem(422, 'USER_VALIDATION_FAILED', 'User details are invalid', fields);
}
function queryWithSession(query, session) { return session && typeof query?.session === 'function' ? query.session(session) : query; }
async function lean(query, session) { return queryWithSession(query, session).lean(); }
function safeSearch(value) { return String(value || '').trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function createUserService({ UserModel, TenantModel, PlatformSettingsModel, auditService, startSession, passwordPolicy = async () => ({ minLength: 12, maxLength: 128 }) } = {}) {
  if (!UserModel) throw new TypeError('UserModel is required');
  async function validatePassword(password) {
    const policy = await passwordPolicy();
    const min = Math.max(8, Number(policy?.minLength) || 12);
    const max = Math.max(min, Number(policy?.maxLength) || 128);
    if (!password || String(password).length < min || String(password).length > max) throw problem(422, 'PASSWORD_INVALID', `Password must be between ${min} and ${max} characters`, { password: `Use ${min}-${max} characters` });
  }
  async function paged(filter, { page = 1, pageSize = 25 } = {}) {
    const size = Math.min(100, Math.max(1, Number(pageSize) || 25)); const current = Math.max(1, Number(page) || 1);
    const [rows, total] = await Promise.all([UserModel.find(filter).sort({ updated_at: -1 }).skip((current - 1) * size).limit(size).lean(), UserModel.countDocuments(filter)]);
    return { items: rows.map(toSafeUser), page: current, pageSize: size, total, totalPages: Math.ceil(total / size) };
  }
  const searchFilter = search => safeSearch(search) ? { $or: [{ username: { $regex: safeSearch(search), $options: 'i' } }, { email: { $regex: safeSearch(search), $options: 'i' } }] } : {};
  const listTenantUsers = (tenantId, options = {}) => paged({ tenantId, ...(options.status ? { status: options.status } : {}), ...(TENANT_ROLES.has(options.role) ? { role: options.role } : {}), ...searchFilter(options.search) }, options);
  const listPlatformUsers = (actor, options = {}) => { requireOwner(actor); return paged({ role: 'WEBMASTER', ...searchFilter(options.search) }, options); };

  async function createTenantUser(tenantId, input, actor) {
    validateIdentity(input); await validatePassword(input.password);
    if (!TENANT_ROLES.has(input.role)) throw problem(422, 'TENANT_ROLE_INVALID', 'Tenant role is invalid');
    try {
      const user = await UserModel.create({ username: String(input.username).trim(), email: String(input.email).trim().toLowerCase(), password_hash: await bcrypt.hash(String(input.password), 10), role: input.role, tenantId, status: 'active', password_changed_at: new Date() });
      await auditService?.record({ actor, action: 'user.create', target: { type: 'user', id: String(user._id) }, tenantId: String(tenantId), after: toSafeUser(user) });
      return toSafeUser(user);
    } catch (error) { if (error?.code === 11000) throw problem(409, 'USER_IDENTITY_CONFLICT', 'Username or email is already used', { identity: 'Already used' }); throw error; }
  }
  async function createWebmasterAdmin(input, actor) {
    requireOwner(actor); validateIdentity(input); await validatePassword(input.password);
    try {
      const user = await UserModel.create({ username: String(input.username).trim(), email: String(input.email).trim().toLowerCase(), password_hash: await bcrypt.hash(String(input.password), 10), role: 'WEBMASTER', platformAccessLevel: 'ADMIN', tenantId: null, status: 'active', password_changed_at: new Date() });
      await auditService?.record({ actor, action: 'platform-user.create', target: { type: 'user', id: String(user._id) }, after: toSafeUser(user) });
      return toSafeUser(user);
    } catch (error) { if (error?.code === 11000) throw problem(409, 'USER_IDENTITY_CONFLICT', 'Username or email is already used'); throw error; }
  }
  async function updateIdentity(filter, patch, expectedVersion, actor, tenantId, action, { allowTenantRole = false, session = null } = {}) {
    validateIdentity(patch);
    const set = { username: String(patch.username).trim(), email: String(patch.email).trim().toLowerCase() };
    if (patch.role != null) { if (!allowTenantRole || !TENANT_ROLES.has(patch.role)) throw problem(422, 'TENANT_ROLE_INVALID', 'Tenant role is invalid'); set.role = patch.role; }
    try {
      const user = await UserModel.findOneAndUpdate({ ...filter, __v: Number(expectedVersion) }, { $set: set, $inc: { __v: 1 } }, { new: true, runValidators: true, ...(session ? { session } : {}) }).lean();
      if (!user) throw problem(409, 'USER_VERSION_CONFLICT', 'User changed; refresh and retry');
      await auditService?.record({ actor, action, target: { type: 'user', id: String(user._id) }, tenantId, after: toSafeUser(user) }, session ? { session } : undefined);
      return toSafeUser(user);
    } catch (error) { if (error?.code === 11000) throw problem(409, 'USER_IDENTITY_CONFLICT', 'Username or email is already used'); throw error; }
  }
  async function updateTenantUser(tenantId, id, patch, version, actor) {
    return inOptionalTransaction(async session => {
      const current = await lean(UserModel.findOne({ _id: id, tenantId }), session);
      if (!current) throw problem(404, 'USER_NOT_FOUND', 'User not found');
      if (current.role === 'CLIENT_ADMIN' && current.status === 'active' && patch.role === 'CLIENT_AGENT') {
        if (session) await TenantModel.updateOne({ _id: tenantId }, { $inc: { lifecycleGuardVersion: 1 } }, { session });
        const countQuery = UserModel.countDocuments({ tenantId, role: 'CLIENT_ADMIN', status: 'active' }); const tenantQuery = TenantModel?.findById(tenantId);
        const [count, tenant] = await Promise.all([session && countQuery.session ? countQuery.session(session) : countQuery, tenantQuery ? lean(tenantQuery, session) : null]);
        if (tenant?.status === 'active' && count <= 1) throw problem(409, 'LAST_TENANT_ADMIN_REQUIRED', 'An active tenant must retain an active administrator');
      }
      return updateIdentity({ _id: id, tenantId }, patch, version, actor, String(tenantId), 'user.update', { allowTenantRole: true, session });
    });
  }
  const updatePlatformUser = (id, patch, version, actor) => { requireOwner(actor); return updateIdentity({ _id: id, role: 'WEBMASTER' }, patch, version, actor, null, 'platform-user.update'); };

  async function replacePassword(id, password, expectedVersion, actor, tenantId = null) {
    await validatePassword(password);
    const filter = { _id: id, __v: Number(expectedVersion), ...(tenantId ? { tenantId } : { role: 'WEBMASTER' }) };
    const user = await UserModel.findOneAndUpdate(filter, { $set: { password_hash: await bcrypt.hash(String(password), 10), password_changed_at: new Date() }, $inc: { __v: 1 } }, { new: true, runValidators: true }).lean();
    if (!user) throw problem(409, 'USER_VERSION_CONFLICT', 'User changed; refresh and retry');
    await auditService?.record({ actor, action: 'user.password.replace', target: { type: 'user', id: String(id) }, tenantId: tenantId ? String(tenantId) : null, after: { passwordChanged: true } });
    return toSafeUser(user);
  }
  async function transitionRecord(filter, status, transitionName, actor, reason, tenantId = null, session = null) {
    const set = status === 'archived' ? { status, archived_at: new Date(), archived_by: actor?.username || 'system', archive_reason: String(reason || '').slice(0, 500) || null } : { status, archived_at: null, archived_by: null, archive_reason: null };
    const user = await UserModel.findOneAndUpdate(filter, { $set: set, $inc: { __v: 1 } }, { new: true, runValidators: true, ...(session ? { session } : {}) }).lean();
    if (!user) throw problem(409, 'USER_VERSION_CONFLICT', 'User changed; refresh and retry');
    await auditService?.record({ actor, action: `user.${transitionName}`, target: { type: 'user', id: String(user._id) }, tenantId: tenantId ? String(tenantId) : null, after: { status } }, session ? { session } : undefined);
    return toSafeUser(user);
  }
  async function inOptionalTransaction(work) {
    if (!startSession) return work(null);
    const session = await startSession(); let result;
    try { await session.withTransaction(async () => { result = await work(session); }); return result; }
    finally { await session.endSession?.(); }
  }
  async function transitionTenantUser(tenantId, id, transitionName, expectedVersion, actor, reason = '') {
    const status = TRANSITIONS[transitionName]; if (!status) throw problem(422, 'USER_TRANSITION_INVALID', 'Lifecycle transition is invalid');
    return inOptionalTransaction(async session => {
      const user = await lean(UserModel.findOne({ _id: id, tenantId }), session); if (!user) throw problem(404, 'USER_NOT_FOUND', 'User not found');
      if (user.role === 'CLIENT_ADMIN' && user.status === 'active' && status !== 'active') {
        if (session) await TenantModel.updateOne({ _id: tenantId }, { $inc: { lifecycleGuardVersion: 1 } }, { session });
        const countQuery = UserModel.countDocuments({ tenantId, role: 'CLIENT_ADMIN', status: 'active' }); const tenantQuery = TenantModel?.findById(tenantId);
        const [count, tenant] = await Promise.all([session && countQuery.session ? countQuery.session(session) : countQuery, tenantQuery ? lean(tenantQuery, session) : null]);
        if (tenant?.status === 'active' && count <= 1) throw problem(409, 'LAST_TENANT_ADMIN_REQUIRED', 'An active tenant must retain an active administrator');
      }
      return transitionRecord({ _id: id, tenantId, __v: Number(expectedVersion) }, status, transitionName, actor, reason, tenantId, session);
    });
  }
  async function transitionPlatformUser(id, transitionName, expectedVersion, actor, reason = '') {
    requireOwner(actor); const status = TRANSITIONS[transitionName]; if (!status) throw problem(422, 'USER_TRANSITION_INVALID', 'Lifecycle transition is invalid');
    return inOptionalTransaction(async session => {
      const user = await lean(UserModel.findOne({ _id: id, role: 'WEBMASTER' }), session); if (!user) throw problem(404, 'USER_NOT_FOUND', 'User not found');
      if (user.platformAccessLevel === 'OWNER' && user.status === 'active' && status !== 'active') {
        if (session) await PlatformSettingsModel.findOneAndUpdate({ singletonKey: 'platform' }, { $inc: { ownershipGuardVersion: 1 }, $setOnInsert: { schemaVersion: 1 } }, { session, upsert: true, setDefaultsOnInsert: true });
        const countQuery = UserModel.countDocuments({ role: 'WEBMASTER', platformAccessLevel: 'OWNER', status: 'active' }); const count = session && countQuery.session ? await countQuery.session(session) : await countQuery;
        if (count <= 1) throw problem(409, 'LAST_OWNER_REQUIRED', 'At least one active Owner is required');
      }
      return transitionRecord({ _id: id, role: 'WEBMASTER', __v: Number(expectedVersion) }, status, transitionName, actor, reason, null, session);
    });
  }
  async function transferOwnership({ promoteUserId, demoteUserId, expectedPromoteVersion, expectedDemoteVersion }, actor) {
    requireOwner(actor);
    if (!startSession) throw problem(503, 'OWNERSHIP_TRANSFER_UNAVAILABLE', 'Transactional ownership transfer is unavailable');
    if (!promoteUserId || promoteUserId === demoteUserId) throw problem(422, 'OWNERSHIP_TRANSFER_INVALID', 'Choose two different platform accounts');
    if (actor.source !== 'environment' && actor.id && String(actor.id) !== String(demoteUserId)) throw problem(403, 'OWNERSHIP_ACTOR_MISMATCH', 'Only the current persisted Owner can transfer their ownership');
    return inOptionalTransaction(async session => {
      await PlatformSettingsModel.findOneAndUpdate({ singletonKey: 'platform' }, { $inc: { ownershipGuardVersion: 1 }, $setOnInsert: { schemaVersion: 1 } }, { session, upsert: true, setDefaultsOnInsert: true });
      const promoted = await UserModel.findOneAndUpdate({ _id: promoteUserId, role: 'WEBMASTER', platformAccessLevel: 'ADMIN', status: 'active', __v: Number(expectedPromoteVersion) }, { $set: { platformAccessLevel: 'OWNER' }, $inc: { __v: 1 } }, { new: true, runValidators: true, session }).lean();
      if (!promoted) throw problem(409, 'OWNERSHIP_TRANSFER_CONFLICT', 'Ownership transfer target changed');
      const demoted = await UserModel.findOneAndUpdate({ _id: demoteUserId, role: 'WEBMASTER', platformAccessLevel: 'OWNER', status: 'active', __v: Number(expectedDemoteVersion) }, { $set: { platformAccessLevel: 'ADMIN' }, $inc: { __v: 1 } }, { new: true, runValidators: true, session }).lean();
      if (!demoted) throw problem(409, 'OWNERSHIP_TRANSFER_CONFLICT', 'Current Owner changed');
      await auditService?.record({ actor, action: 'platform-user.ownership-transfer', target: { type: 'user', id: String(promoteUserId) }, before: { ownerId: String(demoteUserId) }, after: { ownerId: String(promoteUserId) } }, { session });
      return { promoted: toSafeUser(promoted), demoted: toSafeUser(demoted) };
    });
  }
  return { listTenantUsers, createTenantUser, updateTenantUser, replacePassword, transitionTenantUser, listPlatformUsers, createWebmasterAdmin, updatePlatformUser, transitionPlatformUser, transferOwnership };
}
module.exports = { createUserService, toSafeUser };
