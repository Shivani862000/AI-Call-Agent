'use strict';

const { WebmasterError } = require('./errors');

const TRANSITIONS = Object.freeze({ suspend: 'suspended', archive: 'archived', restore: 'active' });
const SAFE_FIELDS = ['name', 'primaryContact', 'address', 'timezone', 'dailyReportTime', 'branding', 'plan', 'limits', 'billingContact', 'internalNotes', 'tags'];
const FEEDBACK_CATEGORIES = new Set(['positive', 'negative', 'neutral', 'complaint', 'suggestion', 'question']);

function problem(status, code, message, fieldErrors = {}) {
  return new WebmasterError({ status, code, message, fieldErrors });
}

function objectValue(value) { return value instanceof Map ? Object.fromEntries(value) : (value || {}); }

function toSafeTenant(item) {
  if (!item) return {};
  return {
    id: String(item.id || ''),
    name: item.name || '',
    primaryContact: item.primary_contact || item.primaryContact || {},
    address: item.address || '',
    timezone: item.timezone || 'Asia/Kolkata',
    dailyReportTime: item.daily_report_time || item.dailyReportTime || '19:00',
    branding: item.branding || {},
    plan: item.plan || 'standard',
    limits: item.limits || {},
    billingContact: item.billing_contact || item.billingContact || '',
    internalNotes: item.internal_notes || item.internalNotes || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    settingsOverrides: objectValue(item.settings_overrides || item.settingsOverrides),
    status: item.status || 'active',
    createdAt: item.created_at || null,
    updatedAt: item.updated_at || null,
    // Provide a dummy version if undefined
    version: 1
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
  const { supabase, auditService, integrationStatus = async () => [], passwordPolicy = async () => ({ minLength: 12, maxLength: 128 }) } = deps;
  if (!supabase) throw new TypeError('supabase is required');

  async function list({ status, search, page = 1, pageSize = 25 } = {}) {
    const size = Math.min(100, Math.max(1, Number(pageSize) || 25));
    const current = Math.max(1, Number(page) || 1);
    
    let query = supabase.from('tenants').select('*', { count: 'exact' });
    
    if (status) {
      query = query.eq('status', status);
    } else {
      query = query.neq('status', 'archived');
    }
    
    if (search && search.trim()) {
      // In Supabase we can use ilike for search
      query = query.ilike('name', `%${search.trim()}%`);
    }
    
    const { data: rows, count, error } = await query
      .order('updated_at', { ascending: false })
      .range((current - 1) * size, current * size - 1);
      
    if (error) throw problem(500, 'TENANT_LIST_FAILED', 'Failed to list tenants');

    return { items: rows.map(toSafeTenant), page: current, pageSize: size, total: count, totalPages: Math.ceil(count / size) };
  }

  async function createWithAdmin(input = {}, actor = {}) {
    validateProfile(input, { creating: true });
    if (!input.initialAdmin) throw problem(422, 'INITIAL_ADMIN_REQUIRED', 'Initial administrator is required', { initialAdmin: 'Required' });
    const admin = input.initialAdmin;
    const policy = await passwordPolicy();
    const minLength = Math.max(8, Number(policy?.minLength) || 12);
    const maxLength = Math.max(minLength, Number(policy?.maxLength) || 128);
    
    if (!admin.username || !admin.email || !admin.password || String(admin.password).length < minLength || String(admin.password).length > maxLength) {
        throw problem(422, 'INITIAL_ADMIN_INVALID', 'Initial administrator is invalid', { initialAdmin: `Username, email, and a password of ${minLength}-${maxLength} characters are required` });
    }
    
    // 1. Create Tenant in DB
    const profile = {
        name: input.name,
        primary_contact: input.primaryContact || {},
        address: input.address || '',
        timezone: input.timezone || 'Asia/Kolkata',
        daily_report_time: input.dailyReportTime || '19:00',
        branding: input.branding || {},
        plan: input.plan || 'standard',
        limits: input.limits || {},
        billing_contact: input.billingContact || '',
        internal_notes: input.internalNotes || '',
        tags: input.tags || []
    };
    
    const { data: tenant, error: tErr } = await supabase.from('tenants').insert(profile).select().maybeSingle();
    if (tErr) {
        if (tErr.code === '23505') throw problem(409, 'TENANT_CONFLICT', 'Tenant already exists');
        console.error(tErr); throw problem(500, "TENANT_CREATE_FAILED", "Failed to create tenant");
    }

    // 2. Create Auth User
    const { data: authUser, error: aErr } = await supabase.auth.admin.createUser({
        email: admin.email.trim().toLowerCase(),
        password: admin.password,
        email_confirm: true
    });
    
    if (aErr) {
        await supabase.from('tenants').delete().eq('id', tenant.id); // Rollback
        throw problem(409, 'USER_CONFLICT', 'Administrator email is already used');
    }

    // 3. Create User Profile
    const { error: uErr } = await supabase.from('users').insert({
        id: authUser.user.id,
        username: admin.username.trim(),
        email: admin.email.trim().toLowerCase(),
        role: 'CLIENT_ADMIN',
        tenant_id: tenant.id,
        status: 'active'
    });
    
    if (uErr) {
        await supabase.auth.admin.deleteUser(authUser.user.id);
        await supabase.from('tenants').delete().eq('id', tenant.id);
        throw problem(409, 'USER_CONFLICT', 'Administrator username is already used');
    }

    await auditService?.record({ actor, action: 'tenant.create', target: { type: 'tenant', id: tenant.id }, tenantId: tenant.id, after: toSafeTenant(tenant) });
    return toSafeTenant(tenant);
  }

  async function update(id, patch = {}, expectedVersion, actor = {}) {
    validateProfile(patch);
    const safePatch = {};
    if (patch.name !== undefined) safePatch.name = patch.name;
    if (patch.primaryContact !== undefined) safePatch.primary_contact = patch.primaryContact;
    if (patch.address !== undefined) safePatch.address = patch.address;
    if (patch.timezone !== undefined) safePatch.timezone = patch.timezone;
    if (patch.dailyReportTime !== undefined) safePatch.daily_report_time = patch.dailyReportTime;
    if (patch.branding !== undefined) safePatch.branding = patch.branding;
    if (patch.plan !== undefined) safePatch.plan = patch.plan;
    if (patch.limits !== undefined) safePatch.limits = patch.limits;
    if (patch.billingContact !== undefined) safePatch.billing_contact = patch.billingContact;
    if (patch.internalNotes !== undefined) safePatch.internal_notes = patch.internalNotes;
    if (patch.tags !== undefined) safePatch.tags = patch.tags;
    
    safePatch.updated_at = new Date().toISOString();

    const { data: tenant, error } = await supabase.from('tenants').update(safePatch).eq('id', id).select().maybeSingle();
    if (error || !tenant) throw problem(409, 'TENANT_VERSION_CONFLICT', 'Tenant changed or not found; refresh and retry');
    
    await auditService?.record({ actor, action: 'tenant.update', target: { type: 'tenant', id: String(id) }, tenantId: String(id), after: toSafeTenant(tenant) });
    return toSafeTenant(tenant);
  }

  async function transition(id, transitionName, expectedVersion, actor = {}, reason = '') {
    const status = TRANSITIONS[transitionName];
    if (!status) throw problem(422, 'TENANT_TRANSITION_INVALID', 'Lifecycle transition is invalid');
    const now = new Date().toISOString();
    const fields = status === 'archived'
      ? { status, archived_at: now, archived_by: actor.username || 'system', archive_reason: String(reason || '').slice(0, 500) || null }
      : { status, archived_at: null, archived_by: null, archive_reason: null };
      
    fields.updated_at = now;
    
    const { data: tenant, error } = await supabase.from('tenants').update(fields).eq('id', id).select().maybeSingle();
    if (error || !tenant) throw problem(409, 'TENANT_VERSION_CONFLICT', 'Tenant changed or not found; refresh and retry');
    
    await auditService?.record({ actor, action: `tenant.${transitionName}`, target: { type: 'tenant', id: String(id) }, tenantId: String(id), after: { status } });
    return toSafeTenant(tenant);
  }

  async function get(id) {
    const { data: tenant, error } = await supabase.from('tenants').select('*').eq('id', id).maybeSingle();
    if (error || !tenant) throw problem(404, 'TENANT_NOT_FOUND', 'Tenant not found');
    return toSafeTenant(tenant);
  }

  async function getOperationalSnapshot(id) {
    const tenant = await get(id);
    
    const [{ count: customers }, { count: totalCalls }, { data: callRows }, { count: totalFeedback }, { data: feedbackRows }] = await Promise.all([
        supabase.from('customers').select('*', { count: 'exact', head: true }).eq('tenant_id', id),
        supabase.from('calls').select('*', { count: 'exact', head: true }).eq('tenant_id', id),
        supabase.from('calls').select('outcome').eq('tenant_id', id),
        supabase.from('feedback').select('*', { count: 'exact', head: true }).eq('tenant_id', id),
        supabase.from('feedback').select('category').eq('tenant_id', id)
    ]);
    
    const callGroups = {};
    if (callRows) {
        for (const row of callRows) {
            const status = row.outcome || 'unknown';
            callGroups[status] = (callGroups[status] || 0) + 1;
        }
    }
    
    const safeFeedback = {};
    if (feedbackRows) {
        for (const row of feedbackRows) {
            const category = FEEDBACK_CATEGORIES.has(String(row.category || '').toLowerCase()) ? String(row.category).toLowerCase() : 'other';
            safeFeedback[category] = (safeFeedback[category] || 0) + 1;
        }
    }
    
    const integrations = await integrationStatus(id);
    const failedNotifications = 0; // Notifications not yet supported in Supabase tables
    
    return { tenant, usage: { customers: customers || 0, calls: totalCalls || 0, feedback: totalFeedback || 0 }, calls: callGroups, feedback: safeFeedback, integrations, notifications: { failed: failedNotifications } };
  }

  return { list, get, createWithAdmin, update, transition, getOperationalSnapshot };
}

module.exports = { createTenantService, toSafeTenant, validateProfile };
