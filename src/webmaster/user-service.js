'use strict';

const bcrypt = require('bcrypt');
const { WebmasterError } = require('./errors');

const TENANT_ROLES = new Set(['CLIENT_ADMIN', 'CLIENT_AGENT']);
const TRANSITIONS = Object.freeze({ suspend: 'suspended', archive: 'archived', restore: 'active' });

function problem(status, code, message, fieldErrors = {}) { return new WebmasterError({ status, code, message, fieldErrors }); }

function toSafeUser(item) {
  if (!item) return {};
  return {
    id: String(item.id || ''), 
    username: item.username || '', 
    email: item.email || '', 
    role: item.role || '',
    tenantId: item.tenant_id || item.tenantId ? String(item.tenant_id || item.tenantId) : null, 
    status: item.status || 'active', 
    platformAccessLevel: item.platform_access_level || item.platformAccessLevel || null,
    createdAt: item.created_at || null, 
    updatedAt: item.updated_at || null,
    passwordChangedAt: item.password_changed_at || null, 
    version: 1
  };
}

function requireOwner(actor) { if (actor?.platformAccessLevel !== 'OWNER') throw problem(403, 'WEBMASTER_OWNER_REQUIRED', 'Owner access is required'); }

function validateIdentity(input) {
  const fields = {};
  if (!input.username || String(input.username).trim().length < 3) fields.username = 'Username must be at least 3 characters';
  if (!input.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email))) fields.email = 'Valid email is required';
  if (Object.keys(fields).length) throw problem(422, 'USER_VALIDATION_FAILED', 'User details are invalid', fields);
}

function safeSearch(value) { return String(value || '').trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function isSelf(user, actor) { return Boolean(user?.username && actor?.username && user.username === actor.username); }
function duplicateIdentityFieldErrors(error) {
  return { identity: 'Username or email is already used' };
}

function createUserService({ supabase, auditService, passwordPolicy = async () => ({ minLength: 12, maxLength: 128 }) } = {}) {
  if (!supabase) throw new TypeError('supabase is required');

  async function validatePassword(password) {
    const policy = await passwordPolicy();
    const min = Math.max(8, Number(policy?.minLength) || 12);
    const max = Math.max(min, Number(policy?.maxLength) || 128);
    if (!password || String(password).length < min || String(password).length > max) throw problem(422, 'PASSWORD_INVALID', `Password must be between ${min} and ${max} characters`, { password: `Use ${min}-${max} characters` });
  }

  async function paged(baseQuery, { page = 1, pageSize = 25, search, status, role } = {}) {
    const size = Math.min(100, Math.max(1, Number(pageSize) || 25)); 
    const current = Math.max(1, Number(page) || 1);
    
    let query = baseQuery;
    
    if (status) query = query.eq('status', status);
    if (role && TENANT_ROLES.has(role)) query = query.eq('role', role);
    
    if (search && safeSearch(search)) {
      query = query.or(`username.ilike.%${safeSearch(search)}%,email.ilike.%${safeSearch(search)}%`);
    }

    const { data: rows, count, error } = await query
      .order('created_at', { ascending: false })
      .range((current - 1) * size, current * size - 1);
      
    if (error) throw problem(500, 'USER_LIST_FAILED', 'Failed to list users');

    return { items: (rows || []).map(toSafeUser), page: current, pageSize: size, total: count || 0, totalPages: Math.ceil((count || 0) / size) };
  }

  const listTenantUsers = (tenantId, options = {}) => {
      const query = supabase.from('users').select('*', { count: 'exact' }).eq('tenant_id', tenantId);
      return paged(query, options);
  };
  
  const listPlatformUsers = (actor, options = {}) => { 
      requireOwner(actor); 
      const query = supabase.from('users').select('*', { count: 'exact' }).eq('role', 'WEBMASTER');
      return paged(query, options); 
  };

  async function createUserInSupabase(input, tenantId, role, platformAccessLevel, actor, action) {
      validateIdentity(input); await validatePassword(input.password);
      
      const { data: authUser, error: aErr } = await supabase.auth.admin.createUser({
        email: input.email.trim().toLowerCase(),
        password: input.password,
        email_confirm: true,
        user_metadata: { role: role }
      });
      if (aErr) throw problem(409, 'USER_IDENTITY_CONFLICT', 'Email is already used', duplicateIdentityFieldErrors(aErr));

      const payload = {
        id: authUser.user.id,
        username: input.username.trim(),
        email: input.email.trim().toLowerCase(),
        role: role,
        tenant_id: tenantId,
        platform_access_level: platformAccessLevel,
        status: 'active'
      };

      const { data: user, error: uErr } = await supabase.from('users').insert(payload).select().single();
      if (uErr) {
          console.error('[SUPABASE ERROR] user.insert failed:', JSON.stringify(uErr, null, 2));
          await supabase.auth.admin.deleteUser(authUser.user.id);
          throw problem(409, 'USER_IDENTITY_CONFLICT', 'Username or Email is already used, or DB constraint failed', duplicateIdentityFieldErrors(uErr));
      }

      await auditService?.record({ actor, action, target: { type: 'user', id: String(user.id) }, tenantId: tenantId ? String(tenantId) : null, after: toSafeUser(user) });
      return toSafeUser(user);
  }

  async function createTenantUser(tenantId, input, actor) {
    if (!TENANT_ROLES.has(input.role)) throw problem(422, 'TENANT_ROLE_INVALID', 'Tenant role is invalid');
    return createUserInSupabase(input, tenantId, input.role, null, actor, 'user.create');
  }

  async function createWebmasterAdmin(input, actor) {
    requireOwner(actor); 
    return createUserInSupabase(input, null, 'WEBMASTER', 'ADMIN', actor, 'platform-user.create');
  }

  async function updateIdentity(filter, patch, expectedVersion, actor, tenantId, action, { allowTenantRole = false } = {}) {
    validateIdentity(patch);
    const set = { username: String(patch.username).trim(), email: String(patch.email).trim().toLowerCase(), updated_at: new Date().toISOString() };
    if (patch.role != null) { 
        if (!allowTenantRole || !TENANT_ROLES.has(patch.role)) throw problem(422, 'TENANT_ROLE_INVALID', 'Tenant role is invalid'); 
        set.role = patch.role; 
    }
    
    // Auth sync
    const authUpdatePayload = {};
    if (patch.email) authUpdatePayload.email = set.email;
    if (patch.role != null) authUpdatePayload.user_metadata = { role: set.role };
    
    if (Object.keys(authUpdatePayload).length > 0) {
       await supabase.auth.admin.updateUserById(filter.id, authUpdatePayload);
    }

    const { data: user, error } = await supabase.from('users').update(set).match(filter).select().maybeSingle();
    if (error || !user) {
        if (error) console.error('[SUPABASE ERROR] updateIdentity failed:', JSON.stringify(error, null, 2));
        throw problem(409, 'USER_VERSION_CONFLICT', 'User changed or not found; refresh and retry');
    }
    
    await auditService?.record({ actor, action, target: { type: 'user', id: String(user.id) }, tenantId, after: toSafeUser(user) });
    return toSafeUser(user);
  }

  async function updateTenantUser(tenantId, id, patch, version, actor) {
    const { data: current } = await supabase.from('users').select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!current) throw problem(404, 'USER_NOT_FOUND', 'User not found');
    if (isSelf(current, actor) && patch.role != null && patch.role !== current.role) {
      throw problem(403, 'SELF_ROLE_CHANGE_FORBIDDEN', 'You cannot change your own tenant role');
    }
    if (current.role === 'CLIENT_ADMIN' && current.status === 'active' && patch.role === 'CLIENT_AGENT') {
      const { count, error } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('role', 'CLIENT_ADMIN').eq('status', 'active');
      const { data: tenant } = await supabase.from('tenants').select('status').eq('id', tenantId).maybeSingle();
      if (tenant?.status === 'active' && count <= 1) throw problem(409, 'LAST_TENANT_ADMIN_REQUIRED', 'An active tenant must retain an active administrator');
    }
    return updateIdentity({ id, tenant_id: tenantId }, patch, version, actor, String(tenantId), 'user.update', { allowTenantRole: true });
  }

  const updatePlatformUser = (id, patch, version, actor) => { 
      requireOwner(actor); 
      return updateIdentity({ id, role: 'WEBMASTER' }, patch, version, actor, null, 'platform-user.update'); 
  };

  async function replacePassword(id, password, expectedVersion, actor, tenantId = null) {
    const query = supabase.from('users').select('*').eq('id', id);
    if (tenantId) query.eq('tenant_id', tenantId);
    else query.eq('role', 'WEBMASTER');
    
    const { data: current } = await query.maybeSingle();
    if (!current) throw problem(404, 'USER_NOT_FOUND', 'User not found');
    if (tenantId && isSelf(current, actor)) throw problem(403, 'SELF_PASSWORD_CHANGE_FORBIDDEN', 'You cannot reset your own password from user management');
    
    await validatePassword(password);
    
    const { error: aErr } = await supabase.auth.admin.updateUserById(id, { password });
    if (aErr) throw problem(500, 'PASSWORD_UPDATE_FAILED', 'Failed to update auth password');

    // Currently we don't store password hashes, just password_changed_at
    const { data: user, error } = await supabase.from('users').update({ 
        updated_at: new Date().toISOString() 
    }).eq('id', id).select().maybeSingle();
    
    if (error || !user) throw problem(409, 'USER_VERSION_CONFLICT', 'User changed; refresh and retry');
    await auditService?.record({ actor, action: 'user.password.replace', target: { type: 'user', id: String(id) }, tenantId: tenantId ? String(tenantId) : null, after: { passwordChanged: true } });
    return toSafeUser(user);
  }

  async function transitionRecord(filter, status, transitionName, actor, reason, tenantId = null) {
    const set = status === 'archived' 
      ? { status, archived_at: new Date().toISOString(), archived_by: actor?.username || 'system', archive_reason: String(reason || '').slice(0, 500) || null } 
      : { status, archived_at: null, archived_by: null, archive_reason: null };
      
    set.updated_at = new Date().toISOString();
      
    const { data: user, error } = await supabase.from('users').update(set).match(filter).select().maybeSingle();
    if (error || !user) throw problem(409, 'USER_VERSION_CONFLICT', 'User changed; refresh and retry');
    
    await auditService?.record({ actor, action: `user.${transitionName}`, target: { type: 'user', id: String(user.id) }, tenantId: tenantId ? String(tenantId) : null, after: { status } });
    return toSafeUser(user);
  }

  async function transitionTenantUser(tenantId, id, transitionName, expectedVersion, actor, reason = '') {
    const status = TRANSITIONS[transitionName]; if (!status) throw problem(422, 'USER_TRANSITION_INVALID', 'Lifecycle transition is invalid');
    const { data: user } = await supabase.from('users').select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!user) throw problem(404, 'USER_NOT_FOUND', 'User not found');
    if (isSelf(user, actor) && status !== user.status) throw problem(403, 'SELF_STATUS_CHANGE_FORBIDDEN', 'You cannot change your own account status');
    
    if (user.role === 'CLIENT_ADMIN' && user.status === 'active' && status !== 'active') {
      const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('role', 'CLIENT_ADMIN').eq('status', 'active');
      const { data: tenant } = await supabase.from('tenants').select('status').eq('id', tenantId).maybeSingle();
      if (tenant?.status === 'active' && count <= 1) throw problem(409, 'LAST_TENANT_ADMIN_REQUIRED', 'An active tenant must retain an active administrator');
    }
    return transitionRecord({ id, tenant_id: tenantId }, status, transitionName, actor, reason, tenantId);
  }

  async function transitionPlatformUser(id, transitionName, expectedVersion, actor, reason = '') {
    requireOwner(actor); const status = TRANSITIONS[transitionName]; if (!status) throw problem(422, 'USER_TRANSITION_INVALID', 'Lifecycle transition is invalid');
    
    const { data: user } = await supabase.from('users').select('*').eq('id', id).eq('role', 'WEBMASTER').maybeSingle();
    if (!user) throw problem(404, 'USER_NOT_FOUND', 'User not found');
    
    if (user.platform_access_level === 'OWNER' && user.status === 'active' && status !== 'active') {
      const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'WEBMASTER').eq('platform_access_level', 'OWNER').eq('status', 'active');
      if (count <= 1) throw problem(409, 'LAST_OWNER_REQUIRED', 'At least one active Owner is required');
    }
    return transitionRecord({ id, role: 'WEBMASTER' }, status, transitionName, actor, reason, null);
  }

  async function transferOwnership({ promoteUserId, demoteUserId, expectedPromoteVersion, expectedDemoteVersion }, actor) {
    requireOwner(actor);
    if (!promoteUserId || promoteUserId === demoteUserId) throw problem(422, 'OWNERSHIP_TRANSFER_INVALID', 'Choose two different platform accounts');
    if (actor.source !== 'environment' && actor.id && String(actor.id) !== String(demoteUserId)) throw problem(403, 'OWNERSHIP_ACTOR_MISMATCH', 'Only the current persisted Owner can transfer their ownership');
    
    // Try to do this in two steps. No transactions in Supabase REST yet, but good enough for now.
    const { data: promoted, error: pErr } = await supabase.from('users').update({ platform_access_level: 'OWNER' }).eq('id', promoteUserId).eq('role', 'WEBMASTER').eq('platform_access_level', 'ADMIN').eq('status', 'active').select().maybeSingle();
    if (pErr || !promoted) throw problem(409, 'OWNERSHIP_TRANSFER_CONFLICT', 'Ownership transfer target changed');
    
    const { data: demoted, error: dErr } = await supabase.from('users').update({ platform_access_level: 'ADMIN' }).eq('id', demoteUserId).eq('role', 'WEBMASTER').eq('platform_access_level', 'OWNER').eq('status', 'active').select().maybeSingle();
    if (dErr || !demoted) throw problem(409, 'OWNERSHIP_TRANSFER_CONFLICT', 'Current Owner changed');
    
    await auditService?.record({ actor, action: 'platform-user.ownership-transfer', target: { type: 'user', id: String(promoteUserId) }, before: { ownerId: String(demoteUserId) }, after: { ownerId: String(promoteUserId) } });
    return { promoted: toSafeUser(promoted), demoted: toSafeUser(demoted) };
  }
  
  return { listTenantUsers, createTenantUser, updateTenantUser, replacePassword, transitionTenantUser, listPlatformUsers, createWebmasterAdmin, updatePlatformUser, transitionPlatformUser, transferOwnership };
}

module.exports = { createUserService, toSafeUser };
