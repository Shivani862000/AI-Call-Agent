'use strict';

const bcrypt = require('bcrypt');
const { WebmasterError } = require('./errors');
const { supabase } = require('../supabase'); // Supabase client

const TRANSITIONS = Object.freeze({ suspend: 'suspended', archive: 'archived', restore: 'active' });
const SAFE_FIELDS = ['name', 'primaryContact', 'address', 'timezone', 'dailyReportTime', 'branding', 'plan', 'limits', 'billingContact', 'internalNotes', 'tags'];
const FEEDBACK_CATEGORIES = new Set(['positive', 'negative', 'neutral', 'complaint', 'suggestion', 'question']);

function problem(status, code, message, fieldErrors = {}) {
  return new WebmasterError({ status, code, message, fieldErrors });
}

function safeSearch(value) { return String(value || '').trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function toSafeTenant(record) {
  const item = record || {};
  return {
    id: item.id || '',
    name: item.name || '',
    primaryContact: {
      name: item.primary_contact_name || '',
      email: item.primary_contact_email || '',
      phone: item.primary_contact_phone || ''
    },
    address: item.address || '',
    timezone: item.timezone || 'Asia/Kolkata',
    dailyReportTime: item.daily_report_time || '19:00',
    branding: {
      displayName: item.branding_display_name || '',
      primaryColor: item.branding_primary_color || '#155eef'
    },
    plan: item.plan || 'standard',
    limits: {
      users: item.limits_users || 0,
      monthlyCalls: item.limits_monthly_calls || 0
    },
    billingContact: item.billing_contact || '',
    internalNotes: item.internal_notes || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    settingsOverrides: item.settings_overrides || {},
    status: item.status || 'active',
    createdAt: item.created_at || null,
    updatedAt: item.updated_at || null,
    version: item.lifecycle_guard_version || 0
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

function mapToSupabaseTenant(patch) {
  const mapped = {};
  if (patch.name !== undefined) mapped.name = patch.name;
  if (patch.primaryContact) {
    if (patch.primaryContact.name !== undefined) mapped.primary_contact_name = patch.primaryContact.name;
    if (patch.primaryContact.email !== undefined) mapped.primary_contact_email = patch.primaryContact.email;
    if (patch.primaryContact.phone !== undefined) mapped.primary_contact_phone = patch.primaryContact.phone;
  }
  if (patch.address !== undefined) mapped.address = patch.address;
  if (patch.timezone !== undefined) mapped.timezone = patch.timezone;
  if (patch.dailyReportTime !== undefined) mapped.daily_report_time = patch.dailyReportTime;
  if (patch.branding) {
    if (patch.branding.displayName !== undefined) mapped.branding_display_name = patch.branding.displayName;
    if (patch.branding.primaryColor !== undefined) mapped.branding_primary_color = patch.branding.primaryColor;
  }
  if (patch.plan !== undefined) mapped.plan = patch.plan;
  if (patch.limits) {
    if (patch.limits.users !== undefined) mapped.limits_users = patch.limits.users;
    if (patch.limits.monthlyCalls !== undefined) mapped.limits_monthly_calls = patch.limits.monthlyCalls;
  }
  if (patch.billingContact !== undefined) mapped.billing_contact = patch.billingContact;
  if (patch.internalNotes !== undefined) mapped.internal_notes = patch.internalNotes;
  if (patch.tags !== undefined) mapped.tags = patch.tags;
  return mapped;
}

function createTenantService(deps = {}) {
  const { auditService, integrationStatus = async () => [], passwordPolicy = async () => ({ minLength: 12, maxLength: 128 }) } = deps;

  async function list({ status, search, page = 1, pageSize = 25 } = {}) {
    const size = Math.min(100, Math.max(1, Number(pageSize) || 25));
    const current = Math.max(1, Number(page) || 1);
    
    let query = supabase.from('tenants').select('*', { count: 'exact' });
    
    if (status) {
      query = query.eq('status', status);
    } else {
      query = query.neq('status', 'archived');
    }

    if (search) {
      const s = safeSearch(search);
      query = query.or(`name.ilike.%${s}%,plan.ilike.%${s}%`);
    }

    const { data, count, error } = await query
      .order('updated_at', { ascending: false })
      .range((current - 1) * size, current * size - 1);
      
    if (error) throw error;

    return { items: (data || []).map(toSafeTenant), page: current, pageSize: size, total: count || 0, totalPages: Math.ceil((count || 0) / size) };
  }

  async function createWithAdmin(input = {}, actor = {}) {
    validateProfile(input, { creating: true });
    if (!input.initialAdmin) throw problem(422, 'INITIAL_ADMIN_REQUIRED', 'Initial administrator is required', { initialAdmin: 'Required' });
    const admin = input.initialAdmin;
    const policy = await passwordPolicy();
    const minLength = Math.max(8, Number(policy?.minLength) || 12);
    const maxLength = Math.max(minLength, Number(policy?.maxLength) || 128);
    if (!admin.username || !admin.email || !admin.password || String(admin.password).length < minLength || String(admin.password).length > maxLength) throw problem(422, 'INITIAL_ADMIN_INVALID', 'Initial administrator is invalid', { initialAdmin: `Username, email, and a password of ${minLength}-${maxLength} characters are required` });
    
    const mappedTenant = mapToSupabaseTenant(input);
    
    // Insert Tenant
    const { data: tenantData, error: tenantError } = await supabase.from('tenants').insert([mappedTenant]).select().single();
    if (tenantError) {
      if (tenantError.code === '23505') throw problem(409, 'TENANT_CONFLICT', 'Tenant or administrator already exists', { identity: 'Name, username, or email is already used' });
      throw tenantError;
    }
    
    // Insert Admin User
    const password_hash = await bcrypt.hash(String(admin.password), 10);
    const { error: userError } = await supabase.from('users').insert([{
      username: String(admin.username).trim(),
      email: String(admin.email).trim().toLowerCase(),
      password_hash,
      role: 'CLIENT_ADMIN',
      tenant_id: tenantData.id,
      status: 'active',
      password_changed_at: new Date().toISOString()
    }]);

    if (userError) {
      // rollback tenant creation
      await supabase.from('tenants').delete().eq('id', tenantData.id);
      if (userError.code === '23505') throw problem(409, 'TENANT_CONFLICT', 'Tenant or administrator already exists', { identity: 'Name, username, or email is already used' });
      throw userError;
    }

    const safeTenant = toSafeTenant(tenantData);
    await auditService?.record({ actor, action: 'tenant.create', target: { type: 'tenant', id: String(tenantData.id) }, tenantId: String(tenantData.id), after: safeTenant });
    return safeTenant;
  }

  async function update(id, patch = {}, expectedVersion, actor = {}) {
    validateProfile(patch);
    const mappedPatch = mapToSupabaseTenant(patch);
    
    // Check version
    const { data: currentTenant, error: getError } = await supabase.from('tenants').select('lifecycle_guard_version').eq('id', id).single();
    if (getError || !currentTenant) throw problem(409, 'TENANT_VERSION_CONFLICT', 'Tenant changed; refresh and retry');
    if (currentTenant.lifecycle_guard_version !== Number(expectedVersion)) throw problem(409, 'TENANT_VERSION_CONFLICT', 'Tenant changed; refresh and retry');
    
    mappedPatch.lifecycle_guard_version = currentTenant.lifecycle_guard_version + 1;
    
    const { data, error } = await supabase.from('tenants').update(mappedPatch).eq('id', id).select().single();
    if (error) throw error;
    
    const safeTenant = toSafeTenant(data);
    await auditService?.record({ actor, action: 'tenant.update', target: { type: 'tenant', id: String(id) }, tenantId: String(id), after: safeTenant });
    return safeTenant;
  }

  async function transition(id, transitionName, expectedVersion, actor = {}, reason = '') {
    const status = TRANSITIONS[transitionName];
    if (!status) throw problem(422, 'TENANT_TRANSITION_INVALID', 'Lifecycle transition is invalid');
    
    const { data: currentTenant, error: getError } = await supabase.from('tenants').select('lifecycle_guard_version').eq('id', id).single();
    if (getError || !currentTenant) throw problem(409, 'TENANT_VERSION_CONFLICT', 'Tenant changed; refresh and retry');
    if (currentTenant.lifecycle_guard_version !== Number(expectedVersion)) throw problem(409, 'TENANT_VERSION_CONFLICT', 'Tenant changed; refresh and retry');

    const now = new Date().toISOString();
    const patch = status === 'archived'
      ? { status, archived_at: now, archived_by: actor.username || 'system', archive_reason: String(reason || '').slice(0, 500) || null, lifecycle_guard_version: currentTenant.lifecycle_guard_version + 1 }
      : { status, archived_at: null, archived_by: null, archive_reason: null, lifecycle_guard_version: currentTenant.lifecycle_guard_version + 1 };
      
    const { data, error } = await supabase.from('tenants').update(patch).eq('id', id).select().single();
    if (error) throw error;

    await auditService?.record({ actor, action: `tenant.${transitionName}`, target: { type: 'tenant', id: String(id) }, tenantId: String(id), after: { status } });
    return toSafeTenant(data);
  }

  async function get(id) {
    const { data, error } = await supabase.from('tenants').select('*').eq('id', id).single();
    if (error || !data) throw problem(404, 'TENANT_NOT_FOUND', 'Tenant not found');
    return toSafeTenant(data);
  }

  async function getOperationalSnapshot(id) {
    const tenant = await get(id);
    
    const [customersRes, totalCallsRes, callGroupsRes, totalFeedbackRes, feedbackGroupsRes, failedNotificationsRes, integrations] = await Promise.all([
      supabase.from('customers').select('*', { count: 'exact', head: true }).eq('tenant_id', id).neq('status', 'archived'),
      supabase.from('calls').select('*', { count: 'exact', head: true }).eq('tenant_id', id).neq('status', 'archived'),
      supabase.from('calls').select('status').eq('tenant_id', id), // Note: Need group by in JS
      supabase.from('feedback').select('*', { count: 'exact', head: true }).eq('tenant_id', id).neq('status', 'archived'),
      supabase.from('feedback').select('category').eq('tenant_id', id), // Note: Need group by in JS
      supabase.from('notification_deliveries').select('*', { count: 'exact', head: true }).eq('tenant_id', id).eq('status', 'failed'),
      integrationStatus(id)
    ]);
    
    const customers = customersRes.count || 0;
    const totalCalls = totalCallsRes.count || 0;
    const totalFeedback = totalFeedbackRes.count || 0;
    const failedNotifications = failedNotificationsRes.count || 0;

    const callGroupsMap = {};
    if (callGroupsRes.data) {
      callGroupsRes.data.forEach(c => {
        callGroupsMap[c.status] = (callGroupsMap[c.status] || 0) + 1;
      });
    }

    const safeFeedback = {};
    if (feedbackGroupsRes.data) {
      feedbackGroupsRes.data.forEach(f => {
        const category = f.category && FEEDBACK_CATEGORIES.has(f.category.toLowerCase()) ? f.category.toLowerCase() : 'other';
        safeFeedback[category] = (safeFeedback[category] || 0) + 1;
      });
    }
    
    return { 
      tenant, 
      usage: { customers, calls: totalCalls, feedback: totalFeedback }, 
      calls: callGroupsMap, 
      feedback: safeFeedback, 
      integrations, 
      notifications: { failed: failedNotifications } 
    };
  }

  return { list, get, createWithAdmin, update, transition, getOperationalSnapshot };
}

module.exports = { createTenantService, toSafeTenant, validateProfile };
