const express = require('express');
const router = express.Router();
const { dbRun, dbGet, dbAll } = require('../db');
const multer = require('multer');
const { parse } = require('csv-parse/sync');

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
const ALLOWED_CALL_TYPES = new Set(['REVIEW_CALL', 'THREE_MONTH_FOLLOWUP']);
const RESCHEDULABLE_STATUSES = new Set([
  'scheduled',
  'called',
  'no_answer',
  'busy',
  'failed',
  'completed',
  'retry_scheduled',
  'callback_scheduled'
]);
const ACTIVE_CUSTOMER_STATUSES = new Set(['scheduled', 'pending', 'called', 'retry_scheduled', 'callback_scheduled']);
const ACTIVE_CALL_OUTCOMES = new Set(['initiated', 'scheduled_initiated', 'active']);

function toBooleanFlag(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized) ? 1 : 0;
}

function getNextIsoForPreferredSlot(slot, now = new Date()) {
  const match = SLOT_PATTERN.exec(String(slot || '').trim());
  if (!match) {
    return now.toISOString();
  }

  const [, hours, minutes] = match;
  const scheduled = new Date(now);
  scheduled.setHours(Number(hours), Number(minutes), 0, 0);

  // If the selected time has already passed today, schedule the next day's run.
  if (scheduled.getTime() <= now.getTime()) {
    scheduled.setDate(scheduled.getDate() + 1);
  }

  return scheduled.toISOString();
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
  if (directSlot) {
    return directSlot;
  }

  const callTime = String(payload.callTime || '').trim();
  if (!callTime) {
    return '10:00';
  }

  const parsed = new Date(callTime);
  if (Number.isNaN(parsed.getTime())) {
    return callTime;
  }

  return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
}

function normalizeCustomerPayload(payload = {}) {
  return {
    name: String(payload.name || payload.patientName || '').trim(),
    phone: String(payload.phone || payload.phoneNumber || '').trim(),
    preferred_slot: normalizePreferredSlot(payload),
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
    service_interest: String(payload.service_interest || '').trim(),
    video_sent: toBooleanFlag(payload.video_sent),
    last_visit_date: String(payload.last_visit_date || '').trim() || null
  };
}

function validateCustomerPayload(payload) {
  const errors = {};

  if (!payload.name) {
    errors.name = 'Customer name is required';
  } else if (payload.name.length < 2) {
    errors.name = 'Customer name must be at least 2 characters';
  } else if (payload.name.length > 100) {
    errors.name = 'Customer name must be 100 characters or fewer';
  }

  if (!payload.phone) {
    errors.phone = 'Phone number is required';
  } else if (!PHONE_PATTERN.test(payload.phone)) {
    errors.phone = 'Phone must be in E.164 format, e.g. +919876543210';
  }

  if (!payload.preferred_slot) {
    errors.preferred_slot = 'Scheduled time is required';
  } else if (!SLOT_PATTERN.test(payload.preferred_slot)) {
    errors.preferred_slot = 'Scheduled time must be in HH:MM format';
  }

  if (!['vip', 'high', 'standard', 'low'].includes(payload.customer_value)) {
    errors.customer_value = 'Customer value must be vip, high, standard, or low';
  }

  if (!['urgent', 'high', 'normal', 'low'].includes(payload.urgency_level)) {
    errors.urgency_level = 'Urgency must be urgent, high, normal, or low';
  }

  if (!['hi', 'en', 'mixed', 'hinglish'].includes(payload.preferred_language)) {
    errors.preferred_language = 'Preferred language must be hi, en, mixed, or hinglish';
  }

  if (!['unknown', 'granted', 'denied', 'pending'].includes(payload.consent_status)) {
    errors.consent_status = 'Consent status must be unknown, granted, denied, or pending';
  }

  if (!ALLOWED_CALL_TYPES.has(payload.call_type)) {
    errors.call_type = 'Call type must be REVIEW_CALL or THREE_MONTH_FOLLOWUP';
  }

  return errors;
}

function normalizePhoneLookupValue(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return digits;
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

async function findCustomerByNormalizedPhone(phone, excludeCustomerId = null) {
  const normalized = normalizePhoneLookupValue(phone);
  if (!normalized) return null;

  const rows = await dbAll('SELECT * FROM customers ORDER BY id DESC LIMIT 500');
  return rows.find((row) => {
    if (excludeCustomerId && Number(row.id) === Number(excludeCustomerId)) return false;
    return normalizePhoneLookupValue(row.phone) === normalized;
  }) || null;
}

function getDuplicateScheduleMessage(phone, excludeCustomerId = null) {
  // We no longer block duplicate phones. Every schedule creates a new call job.
  return null;
}

function handleSqliteError(error, res) {
  if (error.message && error.message.includes('UNIQUE constraint failed: customers.phone')) {
    return res.status(409).json({
      error: 'This patient already has a scheduled call.',
      fieldErrors: { phone: 'This phone number is already in use' }
    });
  }

  console.error('Customer route error:', error);
  return res.status(500).json({ error: error.message });
}

async function saveCustomer(payload) {
  // Deduplicate: Find existing by phone
  let customerId;
  const existing = await findCustomerByNormalizedPhone(payload.phone);
  if (existing) {
    customerId = existing.id;
    // We could update customer fields here if needed, but for now we just use the ID
  } else {
    const res = await dbRun(
      `INSERT INTO customers (
        name, phone, preferred_slot, status, customer_value, urgency_level,
        preferred_language, preferred_dialect, do_not_call, consent_status,
        outstanding_issues, pending_follow_ups, revenue_stage, revenue_estimate,
        campaign_name, service_interest, call_type, video_sent, last_visit_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.name,
        payload.phone,
        payload.preferred_slot,
        'scheduled',
        payload.customer_value,
        payload.urgency_level,
        payload.preferred_language,
        payload.preferred_dialect || null,
        payload.do_not_call,
        payload.consent_status,
        payload.outstanding_issues || null,
        payload.pending_follow_ups || null,
        payload.revenue_stage,
        payload.revenue_estimate,
        payload.campaign_name || null,
        payload.service_interest || null,
        payload.call_type,
        payload.video_sent,
        payload.last_visit_date
      ]
    );
    customerId = res.lastID;
  }

  // Always create a new call_history row for the schedule
  const initialStatus = payload.preferred_slot ? 'scheduled' : 'pending';
  const scheduledAt = payload.preferred_slot ? getNextIsoForPreferredSlot(payload.preferred_slot) : new Date().toISOString();

  const callRes = await dbRun(
    `INSERT INTO calls (customer_id, call_type, status, scheduled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [customerId, payload.call_type, initialStatus, scheduledAt, new Date().toISOString(), new Date().toISOString()]
  );

  return { customerId, callId: callRes.lastID };
}

// Add single customer
router.post('/', async (req, res) => {
  try {
    const payload = normalizeCustomerPayload(req.body);
    const fieldErrors = validateCustomerPayload(payload);

    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
    }

    const result = await saveCustomer(payload);
    res.json({ id: result.customerId, callId: result.callId, message: 'Customer added successfully' });
  } catch (error) {
    return handleSqliteError(error, res);
  }
});

// Bulk upload CSV
router.post('/csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const csvContent = req.file.buffer.toString('utf-8');
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    if (records.length > 5000) {
      return res.status(400).json({ error: 'CSV file exceeds maximum row limit of 5000' });
    }

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const [index, record] of records.entries()) {
      const payload = normalizeCustomerPayload(record);
      const fieldErrors = validateCustomerPayload(payload);

      if (Object.keys(fieldErrors).length > 0) {
        errorCount += 1;
        errors.push({ row: index + 2, fieldErrors });
        continue;
      }

      try {
        // Always insert a new customer row for bulk uploads so each is an independent call
        await saveCustomer(payload);
        successCount += 1;
      } catch (err) {
        errorCount += 1;
        errors.push({ row: index + 2, error: err.message });
      }
    }

    res.json({
      message: 'CSV import completed',
      successCount,
      errorCount,
      totalRows: records.length,
      errors: errors.slice(0, 10)
    });
  } catch (error) {
    console.error('Error processing CSV:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all customers (Patients)
router.get('/', async (req, res) => {
  try {
    const customers = await dbAll(`
      SELECT customers.*, 
             calls.outcome AS last_call_outcome,
             calls.uuid AS call_uuid
      FROM customers
      LEFT JOIN calls ON calls.customer_id = customers.id
      ORDER BY COALESCE(customers.priority_score, 0) DESC, customers.created_at DESC
    `);
    
    // Deduplicate by customer id for the endpoint
    const unique = [];
    const seen = new Set();
    for (const c of customers) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        unique.push(c);
      }
    }
    
    res.json(unique);
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all calls (Outbound Queue)
router.get('/queue', async (req, res) => {
  try {
    const calls = await dbAll(`
      SELECT calls.*,
             customers.name as customer_name,
             customers.phone as customer_phone,
             customers.preferred_slot as customer_preferred_slot
      FROM calls
      JOIN customers ON calls.customer_id = customers.id
      ORDER BY calls.created_at DESC
    `);
    res.json(calls);
  } catch (error) {
    console.error('Error fetching calls:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get one customer
router.get('/:id', async (req, res) => {
  try {
    const customer = await dbGet('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json(customer);
  } catch (error) {
    console.error('Error fetching customer:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update customer
router.put('/:id', async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const payload = normalizeCustomerPayload(req.body);
    const fieldErrors = validateCustomerPayload(payload);

    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
    }

    const duplicateMessage = await getDuplicateScheduleMessage(payload.phone, existing.id);
    if (duplicateMessage) {
      return res.status(409).json({
        error: duplicateMessage,
        fieldErrors: { phone: duplicateMessage }
      });
    }

    await dbRun(
      `UPDATE customers
          SET name = ?,
              phone = ?,
              preferred_slot = ?,
              customer_value = ?,
              urgency_level = ?,
              preferred_language = ?,
              preferred_dialect = ?,
              do_not_call = ?,
              consent_status = ?,
              outstanding_issues = ?,
              pending_follow_ups = ?,
              revenue_stage = ?,
              revenue_estimate = ?,
              campaign_name = ?,
              service_interest = ?,
              call_type = ?
        WHERE id = ?`,
      [
        payload.name,
        payload.phone,
        payload.preferred_slot,
        payload.customer_value,
        payload.urgency_level,
        payload.preferred_language,
        payload.preferred_dialect || null,
        payload.do_not_call,
        payload.consent_status,
        payload.outstanding_issues || null,
        payload.pending_follow_ups || null,
        payload.revenue_stage,
        payload.revenue_estimate,
        payload.campaign_name || null,
        payload.service_interest || null,
        payload.call_type,
        req.params.id
      ]
    );

    // Update pending call or create a new one
    const pendingCall = await dbGet(`SELECT id, created_at FROM calls WHERE customer_id = ? AND outcome IS NULL AND status IN ('pending', 'scheduled', 'retry_scheduled', 'callback_scheduled') ORDER BY created_at DESC LIMIT 1`, [req.params.id]);
    const scheduledAt = payload.preferred_slot ? getNextIsoForPreferredSlot(payload.preferred_slot) : new Date().toISOString();
    const newStatus = payload.preferred_slot ? 'scheduled' : 'pending';

    if (pendingCall) {
      // Edit existing scheduled call
      await dbRun(
        `UPDATE calls SET scheduled_at = ?, updated_at = ?, call_type = ?, status = ? WHERE id = ?`,
        [scheduledAt, new Date().toISOString(), payload.call_type, newStatus, pendingCall.id]
      );
    } else {
      // Create new call record
      await dbRun(
        `INSERT INTO calls (customer_id, call_type, status, scheduled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.params.id, payload.call_type, newStatus, scheduledAt, new Date().toISOString(), new Date().toISOString()]
      );
    }

    res.json({ message: 'Customer updated successfully' });
  } catch (error) {
    return handleSqliteError(error, res);
  }
});

router.patch('/:id/workflow', async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const patch = {
      do_not_call: req.body.do_not_call === undefined ? existing.do_not_call : toBooleanFlag(req.body.do_not_call),
      wrong_number_flag: req.body.wrong_number_flag === undefined ? existing.wrong_number_flag : toBooleanFlag(req.body.wrong_number_flag),
      admin_review_required: req.body.admin_review_required === undefined ? existing.admin_review_required : toBooleanFlag(req.body.admin_review_required),
      consent_status: req.body.consent_status ? String(req.body.consent_status).trim().toLowerCase() : existing.consent_status,
      next_retry_at: req.body.next_retry_at === undefined ? existing.next_retry_at : req.body.next_retry_at,
      pending_follow_ups: req.body.pending_follow_ups === undefined ? existing.pending_follow_ups : String(req.body.pending_follow_ups || '').trim()
    };

    await dbRun(
      `UPDATE customers
          SET do_not_call = ?,
              wrong_number_flag = ?,
              admin_review_required = ?,
              consent_status = ?,
              next_retry_at = ?,
              pending_follow_ups = ?
        WHERE id = ?`,
      [
        patch.do_not_call,
        patch.wrong_number_flag,
        patch.admin_review_required,
        patch.consent_status,
        patch.next_retry_at,
        patch.pending_follow_ups || null,
        req.params.id
      ]
    );

    res.json({ message: 'Workflow updated successfully' });
  } catch (error) {
    console.error('Error updating customer workflow:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/retry', async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const retryAt = req.body.retry_at || new Date(Date.now() + (60 * 60 * 1000)).toISOString();
    await dbRun(
      'UPDATE customers SET status = ?, next_retry_at = ?, retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?',
      ['retry_scheduled', retryAt, req.params.id]
    );

    res.json({ message: 'Retry scheduled successfully', retry_at: retryAt });
  } catch (error) {
    console.error('Error scheduling retry:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete all customers and their data
router.delete('/bulk', async (req, res) => {
  try {
    await dbRun('DELETE FROM feedback');
    await dbRun('DELETE FROM call_supervisor_events');
    await dbRun('DELETE FROM calls');
    await dbRun('DELETE FROM customers');
    res.json({ message: 'All patients and call history deleted successfully' });
  } catch (error) {
    console.error('Error in bulk delete:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete customer
router.delete('/:id', async (req, res) => {
  try {
    const existing = await dbGet('SELECT id FROM customers WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    await dbRun('DELETE FROM feedback WHERE customer_id = ?', [req.params.id]);
    await dbRun('DELETE FROM calls WHERE customer_id = ?', [req.params.id]);
    await dbRun('DELETE FROM customers WHERE id = ?', [req.params.id]);

    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    console.error('Error deleting customer:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
