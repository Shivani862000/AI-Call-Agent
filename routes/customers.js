const express = require('express');
const router = express.Router();
const { supabase } = require('../src/supabase'); // Supabase client
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const logger = require('../services/system-logger');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

const PHONE_PATTERN = /^\+\d{10,15}$/;
const SLOT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_CALL_TYPES = new Set(['REVIEW_CALL', 'THREE_MONTH_FOLLOWUP']);
const RESCHEDULABLE_STATUSES = new Set([
  'scheduled', 'pending', 'called', 'no_answer', 'busy', 'failed', 'completed',
  'retry_scheduled', 'callback_scheduled', 'hot_lead', 'churn_watch', 'admin_review',
  'draft', 'queued', 'initiated', 'ringing', 'answered', 'connected', 'in_progress',
  'voicemail', 'cancelled', 'rescheduled'
]);

function toBooleanFlag(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  const normalized = String(value || '').trim().toLowerCase();
  return (normalized === '1' || normalized === 'true' || normalized === 'yes') ? 1 : 0;
}

function getNextIsoForPreferredSlot(slot, now = new Date()) {
  const match = SLOT_PATTERN.exec(String(slot || '').trim());
  if (!match) {
    return now.toISOString();
  }
  const [, hours, minutes] = match;
  const scheduled = new Date(now);
  scheduled.setHours(Number(hours), Number(minutes), 0, 0);
  if (scheduled.getTime() <= now.getTime()) {
    scheduled.setDate(scheduled.getDate() + 1);
  }
  return scheduled.toISOString();
}

function getLocalDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildScheduledDateTime(dateValue, timeValue) {
  const datePart = String(dateValue || '').trim();
  const timePart = String(timeValue || '').trim();
  if (!DATE_PATTERN.test(datePart) || !SLOT_PATTERN.test(timePart)) {
    return null;
  }
  const scheduled = new Date(`${datePart}T${timePart}:00`);
  return Number.isNaN(scheduled.getTime()) ? null : scheduled;
}

function normalizeScheduledDate(payload = {}) {
  const directDate = String(payload.scheduled_date || payload.call_date || payload.callDate || '').trim();
  if (directDate) return directDate;
  const scheduledDateTime = String(payload.scheduled_datetime || payload.scheduledDateTime || '').trim();
  if (scheduledDateTime) {
    const parsed = new Date(scheduledDateTime);
    if (!Number.isNaN(parsed.getTime())) {
      return getLocalDateValue(parsed);
    }
  }
  return '';
}

function normalizeCallType(value) {
  const normalized = String(value || 'REVIEW_CALL').trim().toUpperCase();
  if (['REVIEW', 'REVIEW_CALLING'].includes(normalized)) return 'REVIEW_CALL';
  if (['THREE_MONTH', 'THREE_MONTH_FOLLOW_UP', '3_MONTH_FOLLOWUP', '3_MONTH_FOLLOW_UP'].includes(normalized)) {
    return 'THREE_MONTH_FOLLOWUP';
  }
  return ALLOWED_CALL_TYPES.has(normalized) ? normalized : 'REVIEW_CALL';
}

function normalizePreferredSlot(payload = {}) {
  const directSlot = String(payload.preferred_slot || payload.call_time || '').trim();
  if (directSlot) return directSlot;
  const callTime = String(payload.callTime || '').trim();
  if (!callTime) {
    const scheduledDateTime = String(payload.scheduled_datetime || payload.scheduledDateTime || '').trim();
    if (scheduledDateTime) {
      const parsed = new Date(scheduledDateTime);
      if (!Number.isNaN(parsed.getTime())) {
        return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
      }
    }
    return '';
  }
  const parsed = new Date(callTime);
  if (Number.isNaN(parsed.getTime())) return callTime;
  return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
}

function normalizeCustomerPayload(payload = {}) {
  const preferredSlot = normalizePreferredSlot(payload);
  const scheduledDate = normalizeScheduledDate(payload);
  const scheduled = buildScheduledDateTime(scheduledDate, preferredSlot);
  return {
    name: String(payload.name || payload.patientName || '').trim(),
    phone: String(payload.phone || payload.phoneNumber || '').trim(),
    // scheduled_date is transient for validation, we'll store scheduled_datetime and preferred_slot
    preferred_slot: preferredSlot,
    scheduled_datetime: scheduled ? scheduled.toISOString() : null,
    call_type: normalizeCallType(payload.call_type || payload.callType),
    customer_value: String(payload.customer_value || 'standard').trim().toLowerCase() || 'standard',
    urgency_level: String(payload.urgency_level || 'normal').trim().toLowerCase() || 'normal',
    preferred_language: String(payload.preferred_language || 'hi').trim().toLowerCase() || 'hi',
    preferred_dialect: String(payload.preferred_dialect || '').trim(),
    do_not_call: toBooleanFlag(payload.do_not_call),
    consent_status: String(payload.consent_status || 'unknown').trim().toLowerCase() || 'unknown',
    outstanding_issues: String(payload.outstanding_issues || '').trim(),
    pending_follow_ups: String(payload.pending_follow_ups || '').trim(),
    revenue_stage: String(payload.revenue_stage || 'unassigned').trim().toLowerCase() || 'unassigned',
    revenue_estimate: Number(payload.revenue_estimate || 0) || 0,
    campaign_name: String(payload.campaign_name || '').trim(),
    service_interest: String(payload.service_interest || '').trim()
  };
}

function validateCustomerPayload(payload) {
  const errors = {};
  if (!payload.name) errors.name = 'Customer name is required';
  else if (payload.name.length < 2) errors.name = 'Customer name must be at least 2 characters';
  else if (payload.name.length > 100) errors.name = 'Customer name must be 100 characters or fewer';
  
  if (!payload.phone) errors.phone = 'Phone number is required';
  else if (!PHONE_PATTERN.test(payload.phone)) errors.phone = 'Phone must be in E.164 format, e.g. +919876543210';
  
  // Note: we extract scheduled_date from payload just for validation if passed in body
  const bodyScheduledDate = normalizeScheduledDate(payload);
  if (payload.preferred_slot || bodyScheduledDate) {
    if (!payload.preferred_slot) errors.preferred_slot = 'Scheduled time is required when date is provided';
    else if (!SLOT_PATTERN.test(payload.preferred_slot)) errors.preferred_slot = 'Scheduled time must be in HH:MM format';
    
    if (!bodyScheduledDate) errors.scheduled_date = 'Scheduled date is required when time is provided';
    else if (!DATE_PATTERN.test(bodyScheduledDate)) errors.scheduled_date = 'Scheduled date must be in YYYY-MM-DD format';
    
    const scheduled = buildScheduledDateTime(bodyScheduledDate, payload.preferred_slot);
    if (!errors.scheduled_date && !errors.preferred_slot && !scheduled) {
      errors.scheduled_datetime = 'Scheduled date and time are invalid';
    } else if (scheduled && scheduled.getTime() <= Date.now()) {
      if (bodyScheduledDate === getLocalDateValue()) errors.preferred_slot = 'Choose a future time for today';
      else errors.scheduled_date = 'Choose today or a future date';
    }
    if (scheduled) {
      const hours = scheduled.getHours();
      if (hours < 7 || hours >= 21) {
        errors.preferred_slot = 'Calls can only be scheduled between 7:00 AM and 9:00 PM.';
        logger.warn('CALL_SCHEDULE_BLOCKED_QUIET_HOURS', { phone: payload.phone, selectedTime: payload.preferred_slot, reason: 'Calls can only be scheduled between 7 AM and 9 PM' });
      }
    }
  }
  
  if (!['vip', 'high', 'standard', 'low'].includes(payload.customer_value)) errors.customer_value = 'Customer value must be vip, high, standard, or low';
  if (!['urgent', 'high', 'normal', 'low'].includes(payload.urgency_level)) errors.urgency_level = 'Urgency must be urgent, high, normal, or low';
  if (!['hi', 'en', 'mixed', 'hinglish'].includes(payload.preferred_language)) errors.preferred_language = 'Preferred language must be hi, en, mixed, or hinglish';
  if (!['unknown', 'granted', 'denied', 'pending'].includes(payload.consent_status)) errors.consent_status = 'Consent status must be unknown, granted, denied, or pending';
  if (!ALLOWED_CALL_TYPES.has(payload.call_type)) errors.call_type = 'Call type must be REVIEW_CALL or THREE_MONTH_FOLLOWUP';
  return errors;
}

function handleSupabaseError(error, res) {
  if (error.code === '23505') {
    return res.status(409).json({ error: 'A duplicate record exists.', fieldErrors: { phone: 'This phone number is already registered' } });
  }
  console.error('Customer route error:', error);
  return res.status(500).json({ error: error.message });
}

function baseCustomerLogDetails(customer, extra = {}) {
  return {
    customerId: customer?.id,
    patient: customer?.name,
    phone: customer?.phone,
    type: logger.formatCallType(customer?.call_type),
    scheduledAt: logger.formatHumanDateTime(customer?.scheduled_datetime),
    ...extra
  };
}

// Add single customer
router.post('/', async (req, res) => {
  try {
    // Add raw scheduled_date to body for validation logic
    const bodyForValidation = { ...req.body, scheduled_date: normalizeScheduledDate(req.body) };
    const fieldErrors = validateCustomerPayload(bodyForValidation);

    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
    }

    const payload = normalizeCustomerPayload(req.body);
    const initialStatus = payload.preferred_slot ? 'scheduled' : 'pending';
    
    const insertData = {
      ...payload,
      tenant_id: req.tenantId,
      status: initialStatus,
      is_manual: 1
    };

    const { data: customer, error } = await supabase.from('customers').insert([insertData]).select().single();
    if (error) throw error;

    logger.info('USER_CREATED_CALL', baseCustomerLogDetails(customer, { user: req.adminSession?.username || 'admin' }));
    logger.info('CALL_CREATED', baseCustomerLogDetails(customer));
    logger.info('CALL_PENDING', baseCustomerLogDetails(customer, { status: 'scheduled' }));
    res.json({ id: customer.id, message: 'Customer added successfully' });
  } catch (error) {
    return handleSupabaseError(error, res);
  }
});

// Bulk upload CSV
router.post('/csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const csvContent = req.file.buffer.toString('utf-8');
    const records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });
    if (records.length > 5000) return res.status(400).json({ error: 'CSV file exceeds maximum row limit of 5000' });

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    // Since bulk inserts are efficient, we can build the array of valid payloads
    const validInserts = [];

    for (const [index, record] of records.entries()) {
      const recordForValidation = { ...record, scheduled_date: normalizeScheduledDate(record) };
      const fieldErrors = validateCustomerPayload(recordForValidation);
      
      if (Object.keys(fieldErrors).length > 0) {
        errorCount += 1;
        errors.push({ row: index + 2, fieldErrors });
        continue;
      }
      
      const payload = normalizeCustomerPayload(record);
      const initialStatus = payload.preferred_slot ? 'scheduled' : 'pending';
      validInserts.push({
        ...payload,
        tenant_id: req.tenantId,
        status: initialStatus,
        is_manual: 0
      });
    }

    if (validInserts.length > 0) {
      // Chunk inserts just in case it's huge
      const chunkSize = 1000;
      for (let i = 0; i < validInserts.length; i += chunkSize) {
        const chunk = validInserts.slice(i, i + chunkSize);
        const { error: insertError } = await supabase.from('customers').insert(chunk);
        if (insertError) {
           // If bulk fails, we won't know exactly which row, but it's likely a constraint error
           // In a robust implementation, we would insert row-by-row or use ON CONFLICT
           // We'll just count them as errors for now if it blows up
           errorCount += chunk.length;
           errors.push({ error: 'Bulk insert error: ' + insertError.message });
        } else {
           successCount += chunk.length;
        }
      }
    }
    
    res.json({ message: 'CSV import completed', successCount, errorCount, totalRows: records.length, errors: errors.slice(0, 10) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search customers
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, phone, call_type, preferred_slot, status, archived_at, archived_by, archive_reason')
      .eq('tenant_id', req.tenantId)
      .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all customers
router.get('/', async (req, res) => {
  try {
    // Only fetching unarchived
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .neq('status', 'archived')
      .order('priority_score', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get one customer
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('customers').select('*').eq('id', req.params.id).eq('tenant_id', req.tenantId).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update customer
router.put('/:id', async (req, res) => {
  try {
    const { data: existing, error: findError } = await supabase.from('customers').select('*').eq('id', req.params.id).eq('tenant_id', req.tenantId).neq('status', 'archived').maybeSingle();
    if (findError) throw findError;
    if (!existing) return res.status(404).json({ error: 'Customer not found' });

    const bodyForValidation = { ...req.body, scheduled_date: normalizeScheduledDate(req.body) };
    const fieldErrors = validateCustomerPayload(bodyForValidation);
    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
    }

    const payload = normalizeCustomerPayload(req.body);
    const existingDate = existing.scheduled_datetime ? new Date(existing.scheduled_datetime).toISOString() : null;
    const slotChanged = payload.preferred_slot !== (existing.preferred_slot || '10:00')
      || payload.scheduled_datetime !== existingDate;
      
    const existingStatus = String(existing.status || '').toLowerCase();
    const shouldRescheduleStatus = slotChanged && RESCHEDULABLE_STATUSES.has(existingStatus);
    const nextRetryAt = shouldRescheduleStatus
      ? (payload.scheduled_datetime || getNextIsoForPreferredSlot(payload.preferred_slot))
      : existing.next_retry_at;
    const nextStatus = shouldRescheduleStatus ? 'scheduled' : existing.status;

    const updateData = { 
      ...payload, 
      status: nextStatus,
      next_retry_at: nextRetryAt,
      attempt_count: shouldRescheduleStatus ? 0 : (existing.attempt_count || 0),
      is_manual: 1,
      locked_at: null 
    };

    const { data: updatedCustomer, error: updateError } = await supabase.from('customers').update(updateData).eq('id', req.params.id).eq('tenant_id', req.tenantId).select().single();
    if (updateError) throw updateError;

    if (existingStatus === 'completed' && nextStatus === 'scheduled') {
      logger.info('CALL_MANUALLY_RESCHEDULED', { phone: payload.phone, callType: payload.call_type, updatedBy: req.adminSession?.username || 'admin' });
    }

    logger.info('USER_EDITED_CALL', baseCustomerLogDetails(updatedCustomer, { user: req.adminSession?.username || 'admin' }));
    logger.info('CALL_PENDING', baseCustomerLogDetails(updatedCustomer, { status: nextStatus }));
    res.json({ message: 'Customer updated successfully' });
  } catch (error) {
    return handleSupabaseError(error, res);
  }
});

router.patch('/:id/workflow', async (req, res) => {
  try {
    const { data: existing, error: findError } = await supabase.from('customers').select('*').eq('id', req.params.id).eq('tenant_id', req.tenantId).neq('status', 'archived').maybeSingle();
    if (findError) throw findError;
    if (!existing) return res.status(404).json({ error: 'Customer not found' });

    const patch = {
      do_not_call: req.body.do_not_call === undefined ? existing.do_not_call : toBooleanFlag(req.body.do_not_call),
      wrong_number_flag: req.body.wrong_number_flag === undefined ? existing.wrong_number_flag : toBooleanFlag(req.body.wrong_number_flag),
      admin_review_required: req.body.admin_review_required === undefined ? existing.admin_review_required : toBooleanFlag(req.body.admin_review_required),
      consent_status: req.body.consent_status ? String(req.body.consent_status).trim().toLowerCase() : existing.consent_status,
      next_retry_at: req.body.next_retry_at === undefined ? existing.next_retry_at : req.body.next_retry_at,
      pending_follow_ups: req.body.pending_follow_ups === undefined ? existing.pending_follow_ups : String(req.body.pending_follow_ups || '').trim()
    };

    const { error: updateError } = await supabase.from('customers').update(patch).eq('id', req.params.id).eq('tenant_id', req.tenantId);
    if (updateError) throw updateError;
    
    res.json({ message: 'Workflow updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/retry', async (req, res) => {
  try {
    const { data: existing, error: findError } = await supabase.from('customers').select('*').eq('id', req.params.id).eq('tenant_id', req.tenantId).neq('status', 'archived').maybeSingle();
    if (findError) throw findError;
    if (!existing) return res.status(404).json({ error: 'Customer not found' });

    const retryAt = req.body.retry_at || new Date(Date.now() + (60 * 60 * 1000)).toISOString();
    
    const { error: updateError } = await supabase.from('customers').update({ 
      status: 'retry_scheduled', 
      next_retry_at: retryAt,
      retry_count: (existing.retry_count || 0) + 1
    }).eq('id', req.params.id).eq('tenant_id', req.tenantId);
    
    if (updateError) throw updateError;
    res.json({ message: 'Retry scheduled successfully', retry_at: retryAt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id/auto-retry', async (req, res) => {
  try {
    const { data: existing, error: findError } = await supabase.from('customers').select('*').eq('id', req.params.id).eq('tenant_id', req.tenantId).neq('status', 'archived').maybeSingle();
    if (findError) throw findError;
    if (!existing) return res.status(404).json({ error: 'Customer not found' });
    
    const auto_retry_enabled = req.body.auto_retry_enabled ? 1 : 0;
    const { error: updateError } = await supabase.from('customers').update({ auto_retry_enabled }).eq('id', req.params.id).eq('tenant_id', req.tenantId);
    if (updateError) throw updateError;
    
    res.json({ message: 'Auto retry toggled successfully', auto_retry_enabled });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Archive Handlers
const archiveHandler = async (req, res) => {
  try {
    const username = req.adminSession?.username || req.user?.username || 'system';
    const updatePayload = {
      status: 'archived',
      archived_at: new Date().toISOString(),
      archived_by: username,
      archive_reason: (req.body?.reason || '').substring(0, 500) || null
    };

    const { data, error } = await supabase.from('customers').update(updatePayload).eq('id', req.params.id).eq('tenant_id', req.tenantId).neq('status', 'archived').select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Customer not found or already archived' });
    
    res.json({ message: 'Customer archived successfully', id: data.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const restoreHandler = async (req, res) => {
  try {
    const updatePayload = {
      status: 'pending', // Restoring customer goes to pending instead of active
      archived_at: null,
      archived_by: null,
      archive_reason: null
    };

    const { data, error } = await supabase.from('customers').update(updatePayload).eq('id', req.params.id).eq('tenant_id', req.tenantId).eq('status', 'archived').select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Archived Customer not found' });
    
    res.json({ message: 'Customer restored successfully', id: data.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const bulkArchiveHandler = async (req, res) => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No IDs provided for bulk operation' });
    }
    
    const username = req.adminSession?.username || req.user?.username || 'system';
    const updatePayload = {
      status: 'archived',
      archived_at: new Date().toISOString(),
      archived_by: username,
      archive_reason: 'Bulk archived'
    };

    const { data, error } = await supabase.from('customers').update(updatePayload).in('id', ids).eq('tenant_id', req.tenantId).neq('status', 'archived').select();
    if (error) throw error;
    
    res.json({ message: `${(data || []).length} customers archived successfully` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

router.post('/bulk/archive', bulkArchiveHandler);
router.delete('/bulk', bulkArchiveHandler);
router.post('/:id/archive', archiveHandler);
router.post('/:id/restore', restoreHandler);
router.delete('/:id', archiveHandler);

module.exports = router;
