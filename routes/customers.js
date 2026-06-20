const express = require('express');
const router = express.Router();
const { dbRun, dbGet, dbAll } = require('../db');
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
  'scheduled',
  'called',
  'no_answer',
  'busy',
  'failed',
  'completed',
  'retry_scheduled',
  'callback_scheduled'
]);
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
  if (directSlot) {
    return directSlot;
  }

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
  if (Number.isNaN(parsed.getTime())) {
    return callTime;
  }

  return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
}

function normalizeCustomerPayload(payload = {}) {
  const preferredSlot = normalizePreferredSlot(payload);
  const scheduledDate = normalizeScheduledDate(payload);
  const scheduled = buildScheduledDateTime(scheduledDate, preferredSlot);
  return {
    name: String(payload.name || payload.patientName || '').trim(),
    phone: String(payload.phone || payload.phoneNumber || '').trim(),
    scheduled_date: scheduledDate,
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

  if (!payload.scheduled_date) {
    errors.scheduled_date = 'Scheduled date is required';
  } else if (!DATE_PATTERN.test(payload.scheduled_date)) {
    errors.scheduled_date = 'Scheduled date must be in YYYY-MM-DD format';
  }

  const scheduled = buildScheduledDateTime(payload.scheduled_date, payload.preferred_slot);
  if (!errors.scheduled_date && !errors.preferred_slot && !scheduled) {
    errors.scheduled_datetime = 'Scheduled date and time are invalid';
  } else if (scheduled && scheduled.getTime() <= Date.now()) {
    if (payload.scheduled_date === getLocalDateValue()) {
      errors.preferred_slot = 'Choose a future time for today';
    } else {
      errors.scheduled_date = 'Choose today or a future date';
    }
  }

  if (scheduled) {
    const hours = scheduled.getHours();
    if (hours < 7 || hours >= 21) {
      errors.preferred_slot = 'Calls can only be scheduled between 7:00 AM and 9:00 PM.';
      logger.warn('CALL_SCHEDULE_BLOCKED_QUIET_HOURS', {
        phone: payload.phone,
        selectedTime: payload.preferred_slot,
        reason: 'Calls can only be scheduled between 7 AM and 9 PM'
      });
    }
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

function handleSqliteError(error, res) {
  if (error.message && error.message.includes('UNIQUE constraint failed: customers.phone')) {
    return res.status(409).json({
      error: 'The database still has an old unique phone constraint. Restart the server so migrations can remove it.',
      fieldErrors: { phone: 'Phone number can be reused after the database migration runs' }
    });
  }

  console.error('Customer route error:', error);
  return res.status(500).json({ error: error.message });
}

async function saveCustomer(payload, isManual = false) {
  const initialStatus = payload.preferred_slot ? 'scheduled' : 'pending';
  return dbRun(
    `INSERT INTO customers (
      name, phone, preferred_slot, scheduled_datetime, status, customer_value, urgency_level,
      preferred_language, preferred_dialect, do_not_call, consent_status,
      outstanding_issues, pending_follow_ups, revenue_stage, revenue_estimate,
      campaign_name, service_interest, call_type, is_manual
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.name,
      payload.phone,
      payload.preferred_slot,
      payload.scheduled_datetime,
      initialStatus,
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
      isManual ? 1 : 0
    ]
  );
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
    const payload = normalizeCustomerPayload(req.body);
    const fieldErrors = validateCustomerPayload(payload);

    if (payload.phone && payload.scheduled_date === getLocalDateValue()) {
      const callsTodayRow = await dbGet(
        `SELECT COUNT(*) as count 
         FROM calls c
         JOIN customers cu ON cu.id = c.customer_id
         WHERE cu.phone = ? 
           AND DATE(c.called_at, 'localtime') = DATE('now', 'localtime')
           AND COALESCE(c.call_direction, 'outbound') = 'outbound'`,
        [payload.phone]
      );
      if (callsTodayRow && callsTodayRow.count >= 3) {
        fieldErrors.preferred_slot = 'Maximum 3 attempts completed for the day';
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
    }

    const result = await saveCustomer(payload, true);
    const customer = { ...payload, id: result.lastID };
    logger.info('USER_CREATED_CALL', baseCustomerLogDetails(customer, { user: req.adminSession?.username || 'admin' }));
    logger.info('CALL_CREATED', baseCustomerLogDetails(customer));
    logger.info('CALL_PENDING', baseCustomerLogDetails(customer, { status: 'scheduled' }));
    res.json({ id: result.lastID, message: 'Customer added successfully' });
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
        await saveCustomer(payload, false);
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

// Search customers
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.json([]);
    }
    const pattern = `%${q}%`;
    const customers = await dbAll(
      `SELECT id, name, phone, call_type, preferred_slot
       FROM customers 
       WHERE name LIKE ? OR phone LIKE ? 
       ORDER BY created_at DESC 
       LIMIT 20`,
      [pattern, pattern]
    );
    res.json(customers);
  } catch (error) {
    console.error('Error searching customers:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all customers
router.get('/', async (req, res) => {
  try {
    const customers = await dbAll('SELECT * FROM customers ORDER BY COALESCE(priority_score, 0) DESC, created_at DESC');
    res.json(customers);
  } catch (error) {
    console.error('Error fetching customers:', error);
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

    if (payload.phone && payload.scheduled_date === getLocalDateValue()) {
      const callsTodayRow = await dbGet(
        `SELECT COUNT(*) as count 
         FROM calls c
         JOIN customers cu ON cu.id = c.customer_id
         WHERE cu.phone = ? 
           AND DATE(c.called_at, 'localtime') = DATE('now', 'localtime')
           AND COALESCE(c.call_direction, 'outbound') = 'outbound'`,
        [payload.phone]
      );
      if (callsTodayRow && callsTodayRow.count >= 3) {
        fieldErrors.preferred_slot = 'Maximum 3 attempts completed for the day';
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
    }

    const slotChanged = payload.preferred_slot !== (existing.preferred_slot || '10:00')
      || payload.scheduled_datetime !== (existing.scheduled_datetime || null);
    const existingStatus = String(existing.status || '').toLowerCase();
    const shouldRescheduleStatus = slotChanged && RESCHEDULABLE_STATUSES.has(existingStatus);
    const nextRetryAt = shouldRescheduleStatus
      ? (payload.scheduled_datetime || getNextIsoForPreferredSlot(payload.preferred_slot))
      : existing.next_retry_at;
    const nextStatus = shouldRescheduleStatus ? 'scheduled' : existing.status;

    await dbRun(
      `UPDATE customers
          SET name = ?,
              phone = ?,
              preferred_slot = ?,
              scheduled_datetime = ?,
              status = ?,
              customer_value = ?,
              urgency_level = ?,
              preferred_language = ?,
              preferred_dialect = ?,
              do_not_call = ?,
              consent_status = ?,
              outstanding_issues = ?,
              pending_follow_ups = ?,
              next_retry_at = ?,
              revenue_stage = ?,
              revenue_estimate = ?,
              campaign_name = ?,
              service_interest = ?,
              call_type = ?,
              is_manual = 1,
              locked_at = NULL
        WHERE id = ?`,
      [
        payload.name,
        payload.phone,
        payload.preferred_slot,
        payload.scheduled_datetime,
        nextStatus,
        payload.customer_value,
        payload.urgency_level,
        payload.preferred_language,
        payload.preferred_dialect || null,
        payload.do_not_call,
        payload.consent_status,
        payload.outstanding_issues || null,
        payload.pending_follow_ups || null,
        nextRetryAt,
        payload.revenue_stage,
        payload.revenue_estimate,
        payload.campaign_name || null,
        payload.service_interest || null,
        payload.call_type,
        req.params.id
      ]
    );

    if (existingStatus === 'completed' && nextStatus === 'scheduled') {
      logger.info('CALL_MANUALLY_RESCHEDULED', {
        phone: payload.phone,
        callType: payload.call_type,
        updatedBy: req.adminSession?.username || 'admin'
      });
    }

    const updatedCustomer = { ...existing, ...payload, id: existing.id };
    logger.info('USER_EDITED_CALL', baseCustomerLogDetails(updatedCustomer, { user: req.adminSession?.username || 'admin' }));
    logger.info('CALL_PENDING', baseCustomerLogDetails(updatedCustomer, { status: nextStatus }));
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

    logger.info('CALL_RETRY', baseCustomerLogDetails(existing, {
      customerId: existing.id,
      retryAt: logger.formatHumanDateTime(retryAt),
      user: req.adminSession?.username || 'admin'
    }));
    res.json({ message: 'Retry scheduled successfully', retry_at: retryAt });
  } catch (error) {
    console.error('Error scheduling retry:', error);
    res.status(500).json({ error: error.message });
  }
});
// Toggle auto-retry
router.put('/:id/auto-retry', async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const auto_retry_enabled = req.body.auto_retry_enabled ? 1 : 0;
    await dbRun('UPDATE customers SET auto_retry_enabled = ? WHERE id = ?', [auto_retry_enabled, req.params.id]);

    if (auto_retry_enabled === 0) {
      logger.info('AUTO_RETRY_DISABLED', {
        customerId: existing.id,
        patient: existing.name,
        phone: existing.phone,
        user: req.adminSession?.username || 'admin'
      });
    } else {
      logger.info('AUTO_RETRY_ENABLED', {
        customerId: existing.id,
        patient: existing.name,
        phone: existing.phone,
        user: req.adminSession?.username || 'admin'
      });
    }

    res.json({ message: 'Auto retry toggled successfully', auto_retry_enabled });
  } catch (error) {
    console.error('Error toggling auto-retry:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete all customers and their data
router.delete('/bulk', async (req, res) => {
  try {
    const counts = await dbGet(`
      SELECT
        (SELECT COUNT(*) FROM customers) AS customer_count,
        (SELECT COUNT(*) FROM calls) AS call_count,
        (SELECT COUNT(*) FROM feedback) AS feedback_count
    `);
    await dbRun('DELETE FROM feedback');
    await dbRun('DELETE FROM call_supervisor_events');
    await dbRun('DELETE FROM calls');
    await dbRun('DELETE FROM customers');
    logger.warn('ALL_RECORDS_DELETED', {
      deletedBy: req.adminSession?.username || 'admin',
      customers: counts?.customer_count || 0,
      calls: counts?.call_count || 0,
      feedback: counts?.feedback_count || 0
    });
    res.json({ message: 'All patients and call history deleted successfully' });
  } catch (error) {
    console.error('Error in bulk delete:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete customer
router.delete('/:id', async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const latestCall = await dbGet('SELECT id, outcome FROM calls WHERE customer_id = ? ORDER BY id DESC LIMIT 1', [req.params.id]);

    await dbRun('DELETE FROM feedback WHERE customer_id = ?', [req.params.id]);
    await dbRun('DELETE FROM calls WHERE customer_id = ?', [req.params.id]);
    await dbRun('DELETE FROM customers WHERE id = ?', [req.params.id]);

    logger.warn('USER_DELETED_CALL', baseCustomerLogDetails(existing, {
      callId: latestCall?.id,
      user: req.adminSession?.username || 'admin'
    }));
    logger.warn('CALL_DELETED', baseCustomerLogDetails(existing, {
      callId: latestCall?.id,
      deletedBy: req.adminSession?.username || 'admin'
    }));
    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    console.error('Error deleting customer:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
