'use strict';

const bcrypt = require('bcrypt');
const { WebmasterError } = require('./errors');
const { supabase } = require('../supabase'); // Supabase client

const TENANT_ROLES = new Set(['CLIENT_ADMIN', 'CLIENT_AGENT']);
const TRANSITIONS = Object.freeze({ suspend: 'suspended', archive: 'archived', restore: 'active' });

function problem(status, code, message, fieldErrors = {}) { return new WebmasterError({ status, code, message, fieldErrors }); }

function toSafeUser(record) {
  const item = record || {};
  return {
    id: item.id || '', 
    username: item.username || '', 
    email: item.email || '', 
    role: item.role || '',
    tenantId: item.tenant_id || null, 
    status: item.status || 'active', 
    platformAccessLevel: item.platform_access_level || null,
    createdAt: item.created_at || null, 
    updatedAt: item.updated_at || null,
    passwordChangedAt: item.password_changed_at || null, 
    version: 0 // Supabase optimistic locking could be added via a version column if needed, defaulting to 0 here to satisfy UI
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
  if (error?.message?.includes('users_username_key')) return { username: 'This username is already in use' };
  if (error?.message?.includes('users_email_key')) return { email: 'This email is already in use' };
  return { identity: 'Username or email is already used' };
}

function createUserService({ auditService, passwordPolicy = async () => ({ minLength: 12, maxLength: 128 }) } = {}) {
  
  async function validatePassword(password) {
    const policy = await passwordPolicy();
    const min = Math.max(8, Number(policy?.minLength) || 12);
    const max = Math.max(min, Number(policy?.maxLength) || 128);
    if (!password || String(password).length < min || String(password).length > max) throw problem(422, 'PASSWORD_INVALID', `Password must be between ${min} and ${max} characters`, { password: `Use ${min}-${max} characters` });
  }

  async function paged(baseQuery, { page = 1, pageSize = 25 } = {}) {
    const size = Math.min(100, Math.max(1, Number(pageSize) || 25)); 
    const current = Math.max(1, Number(page) || 1);
    
    const { data, count, error } = await baseQuery
      .order('updated_at', { ascending: false })
      .range((current - 1) * size, current * size - 1);
      
    if (error) throw error;
    
    return { items: (data || []).map(toSafeUser), page: current, pageSize: size, total: count || 0, totalPages: Math.ceil((count || 0) / size) };
  }

  const applySearchFilter = (query, search) => {
    if (search) {
      const s = safeSearch(search);
      return query.or(`username.ilike.%${s}%,email.ilike.%${s}%`);
    }
    return query;
  };

  const listTenantUsers = (tenantId, options = {}) => {
    let query = supabase.from('users').select('*', { count: 'exact' }).eq('tenant_id', tenantId);
    if (options.status) query = query.eq('status', options.status);
    if (TENANT_ROLES.has(options.role)) query = query.eq('role', options.role);
    query = applySearchFilter(query, options.search);
    return paged(query, options);
  };

  const listPlatformUsers = (actor, options = {}) => { 
    requireOwner(actor); 
    let query = supabase.from('users').select('*', { count: 'exact' }).eq('role', 'WEBMASTER');
    query = applySearchFilter(query, options.search);
    return paged(query, options); 
  };

  async function createTenantUser(tenantId, input, actor) {
    validateIdentity(input); await validatePassword(input.password);
    if (!TENANT_ROLES.has(input.role)) throw problem(422, 'TENANT_ROLE_INVALID', 'Tenant role is invalid');
    
    const password_hash = await bcrypt.hash(String(input.password), 10);
    const { data: user, error } = await supabase.from('users').insert([{
      username: String(input.username).trim(), 
      email: String(input.email).trim().toLowerCase(), 
      password_hash, 
      role: input.role, 
      tenant_id: tenantId, 
      status: 'active', 
      password_changed_at: new Date().toISOString()
    }]).select().single();
    
    if (error) {
      if (error.code === '23505') throw problem(409, 'USER_IDENTITY_CONFLICT', 'Username or email is already used', duplicateIdentityFieldErrors(error)); 
      throw error; 
    }
    
    await auditService?.record({ actor, action: 'user.create', target: { type: 'user', id: String(user.id) }, tenantId: String(tenantId), after: toSafeUser(user) });
    return toSafeUser(user);
  }

  async function createWebmasterAdmin(input, actor) {
    requireOwner(actor); validateIdentity(input); await validatePassword(input.password);
    
    const password_hash = await bcrypt.hash(String(input.password), 10);
    const { data: user, error } = await supabase.from('users').insert([{ 
      username: String(input.username).trim(), 
      email: String(input.email).trim().toLowerCase(), 
      password_hash, 
      role: 'WEBMASTER', 
      platform_access_level: 'ADMIN', 
      status: 'active', 
      password_changed_at: new Date().toISOString() 
    }]).select().single();
    
    if (error) { 
      if (error.code === '23505') throw problem(409, 'USER_IDENTITY_CONFLICT', 'Username or email is already used', duplicateIdentityFieldErrors(error)); 
      throw error; 
    }
    
    await auditService?.record({ actor, action: 'platform-user.create', target: { type: 'user', id: String(user.id) }, after: toSafeUser(user) });
    return toSafeUser(user);
  }

  async function updateIdentity(userId, tenantId, patch, actor, action, allowTenantRole = false) {
    validateIdentity(patch);
    const updatePayload = { username: String(patch.username).trim(), email: String(patch.email).trim().toLowerCase() };
    if (patch.role != null) { 
      if (!allowTenantRole || !TENANT_ROLES.has(patch.role)) throw problem(422, 'TENANT_ROLE_INVALID', 'Tenant role is invalid'); 
      updatePayload.role = patch.role; 
    }
    
    let query = supabase.from('users').update(updatePayload).eq('id', userId);
    if (tenantId) query = query.eq('tenant_id', tenantId);

    const { data: user, error } = await query.select().single();
    
    if (error) { 
      if (error.code === '23505') throw problem(409, 'USER_IDENTITY_CONFLICT', 'Username or email is already used'); 
      throw error; 
    }
    if (!user) throw problem(404, 'USER_NOT_FOUND', 'User not found');
    
    await auditService?.record({ actor, action, target: { type: 'user', id: String(user.id) }, tenantId, after: toSafeUser(user) });
    return toSafeUser(user);
  }

  async function updateTenantUser(tenantId, id, patch, version, actor) {
    const { data: current, error } = await supabase.from('users').select('*').eq('id', id).eq('tenant_id', tenantId).single();
    if (error || !current) throw problem(404, 'USER_NOT_FOUND', 'User not found');
    
    if (isSelf(current, actor) && patch.role != null && patch.role !== current.role) {
      throw problem(403, 'SELF_ROLE_CHANGE_FORBIDDEN', 'You cannot change your own tenant role');
    }
    
    if (current.role === 'CLIENT_ADMIN' && current.status === 'active' && patch.role === 'CLIENT_AGENT') {
      const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('role', 'CLIENT_ADMIN').eq('status', 'active');
      const { data: tenant } = await supabase.from('tenants').select('status').eq('id', tenantId).single();
      if (tenant?.status === 'active' && (count || 0) <= 1) throw problem(409, 'LAST_TENANT_ADMIN_REQUIRED', 'An active tenant must retain an active administrator');
    }
    return updateIdentity(id, tenantId, patch, actor, 'user.update', true);
  }

  const updatePlatformUser = (id, patch, version, actor) => { 
    requireOwner(actor); 
    return updateIdentity(id, null, patch, actor, 'platform-user.update'); 
  };

  async function replacePassword(id, password, expectedVersion, actor, tenantId = null) {
    if (tenantId) {
      const { data: current } = await supabase.from('users').select('*').eq('id', id).eq('tenant_id', tenantId).single();
      if (!current) throw problem(404, 'USER_NOT_FOUND', 'User not found');
      if (isSelf(current, actor)) throw problem(403, 'SELF_PASSWORD_CHANGE_FORBIDDEN', 'You cannot reset your own password from user management');
    }
    await validatePassword(password);
    
    const password_hash = await bcrypt.hash(String(password), 10);
    const updatePayload = { password_hash, password_changed_at: new Date().toISOString() };
    
    let query = supabase.from('users').update(updatePayload).eq('id', id);
    if (tenantId) query = query.eq('tenant_id', tenantId);
    else query = query.eq('role', 'WEBMASTER');

    const { data: user, error } = await query.select().single();
    if (error || !user) throw problem(404, 'USER_NOT_FOUND', 'User not found');
    
    await auditService?.record({ actor, action: 'user.password.replace', target: { type: 'user', id: String(id) }, tenantId: tenantId ? String(tenantId) : null, after: { passwordChanged: true } });
    return toSafeUser(user);
  }

  async function transitionRecord(userId, tenantId, filterRole, status, transitionName, actor, reason) {
    const set = status === 'archived' 
      ? { status, archived_at: new Date().toISOString(), archived_by: actor?.username || 'system', archive_reason: String(reason || '').slice(0, 500) || null } 
      : { status, archived_at: null, archived_by: null, archive_reason: null };
    
    let query = supabase.from('users').update(set).eq('id', userId);
    if (tenantId) query = query.eq('tenant_id', tenantId);
    if (filterRole) query = query.eq('role', filterRole);

    const { data: user, error } = await query.select().single();
    if (error || !user) throw problem(404, 'USER_NOT_FOUND', 'User not found');
    
    await auditService?.record({ actor, action: `user.${transitionName}`, target: { type: 'user', id: String(user.id) }, tenantId: tenantId ? String(tenantId) : null, after: { status } });
    return toSafeUser(user);
  }

  async function transitionTenantUser(tenantId, id, transitionName, expectedVersion, actor, reason = '') {
    const status = TRANSITIONS[transitionName]; if (!status) throw problem(422, 'USER_TRANSITION_INVALID', 'Lifecycle transition is invalid');
    
    const { data: user } = await supabase.from('users').select('*').eq('id', id).eq('tenant_id', tenantId).single();
    if (!user) throw problem(404, 'USER_NOT_FOUND', 'User not found');
    
    if (isSelf(user, actor) && status !== user.status) throw problem(403, 'SELF_STATUS_CHANGE_FORBIDDEN', 'You cannot change your own account status');
    
    if (user.role === 'CLIENT_ADMIN' && user.status === 'active' && status !== 'active') {
      const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('role', 'CLIENT_ADMIN').eq('status', 'active');
      const { data: tenant } = await supabase.from('tenants').select('status').eq('id', tenantId).single();
      if (tenant?.status === 'active' && (count || 0) <= 1) throw problem(409, 'LAST_TENANT_ADMIN_REQUIRED', 'An active tenant must retain an active administrator');
    }
    return transitionRecord(id, tenantId, null, status, transitionName, actor, reason);
  }

  async function transitionPlatformUser(id, transitionName, expectedVersion, actor, reason = '') {
    requireOwner(actor); const status = TRANSITIONS[transitionName]; if (!status) throw problem(422, 'USER_TRANSITION_INVALID', 'Lifecycle transition is invalid');
    
    const { data: user } = await supabase.from('users').select('*').eq('id', id).eq('role', 'WEBMASTER').single();
    if (!user) throw problem(404, 'USER_NOT_FOUND', 'User not found');
    
    if (user.platform_access_level === 'OWNER' && user.status === 'active' && status !== 'active') {
      const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'WEBMASTER').eq('platform_access_level', 'OWNER').eq('status', 'active');
      if ((count || 0) <= 1) throw problem(409, 'LAST_OWNER_REQUIRED', 'At least one active Owner is required');
    }
    return transitionRecord(id, null, 'WEBMASTER', status, transitionName, actor, reason);
  }

  async function transferOwnership({ promoteUserId, demoteUserId }, actor) {
    requireOwner(actor);
    if (!promoteUserId || promoteUserId === demoteUserId) throw problem(422, 'OWNERSHIP_TRANSFER_INVALID', 'Choose two different platform accounts');
    if (actor.source !== 'environment' && actor.id && String(actor.id) !== String(demoteUserId)) throw problem(403, 'OWNERSHIP_ACTOR_MISMATCH', 'Only the current persisted Owner can transfer their ownership');
    
    // Demote current owner
    const { data: demoted, error: demoteError } = await supabase.from('users').update({ platform_access_level: 'ADMIN' })
      .eq('id', demoteUserId).eq('role', 'WEBMASTER').eq('platform_access_level', 'OWNER').eq('status', 'active').select().single();
    if (demoteError || !demoted) throw problem(409, 'OWNERSHIP_TRANSFER_CONFLICT', 'Current Owner changed or could not be demoted');

    // Promote new owner
    const { data: promoted, error: promoteError } = await supabase.from('users').update({ platform_access_level: 'OWNER' })
      .eq('id', promoteUserId).eq('role', 'WEBMASTER').eq('platform_access_level', 'ADMIN').eq('status', 'active').select().single();
    if (promoteError || !promoted) {
      // Rollback demotion
      await supabase.from('users').update({ platform_access_level: 'OWNER' }).eq('id', demoteUserId);
      throw problem(409, 'OWNERSHIP_TRANSFER_CONFLICT', 'Ownership transfer target changed or could not be promoted');
    }

    await auditService?.record({ actor, action: 'platform-user.ownership-transfer', target: { type: 'user', id: String(promoteUserId) }, before: { ownerId: String(demoteUserId) }, after: { ownerId: String(promoteUserId) } });
    return { promoted: toSafeUser(promoted), demoted: toSafeUser(demoted) };
  }

  return { listTenantUsers, createTenantUser, updateTenantUser, replacePassword, transitionTenantUser, listPlatformUsers, createWebmasterAdmin, updatePlatformUser, transitionPlatformUser, transferOwnership };
}

module.exports = { createUserService, toSafeUser };
