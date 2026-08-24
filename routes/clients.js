const express = require('express');
const router = express.Router();
const { dbRun, dbGet, dbAll } = require('../db');
const { createSqlArchiveHandlers } = require('../src/webmaster/lifecycle');

const clientArchiveHandlers = createSqlArchiveHandlers({
  dbRun,
  dbGet,
  tableName: 'clients',
  resourceName: 'Client'
});

const PHONE_PATTERN = /^\+\d{10,15}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toBooleanFlag(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized) ? 1 : 0;
}

function createAnniversaryDate(lastVisitDate, year) {
  const [, monthText, dayText] = String(lastVisitDate || '').split('-');
  const month = Number(monthText);
  const originalDay = Number(dayText);
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(originalDay, lastDayOfMonth);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function computeNextAnnualReminderDate(lastVisitDate, referenceDate = new Date()) {
  const currentYear = referenceDate.getUTCFullYear();
  const today = formatDateOnly(referenceDate);
  let candidate = formatDateOnly(createAnniversaryDate(lastVisitDate, currentYear));
  if (candidate < today) {
    candidate = formatDateOnly(createAnniversaryDate(lastVisitDate, currentYear + 1));
  }
  return candidate;
}

function normalizeClientPayload(payload = {}) {
  const normalizedVisitDate = String(payload.last_visit_date || '').trim();
  return {
    name: String(payload.name || '').trim(),
    phone: String(payload.phone || '').trim(),
    date_of_birth: String(payload.date_of_birth || '').trim(),
    last_visit_date: normalizedVisitDate,
    treatment_type: String(payload.treatment_type || '').trim(),
    annual_reminder_enabled: toBooleanFlag(payload.annual_reminder_enabled === undefined ? 1 : payload.annual_reminder_enabled),
    annual_reminder_slot: String(payload.annual_reminder_slot || '10:00').trim() || '10:00',
    notes: String(payload.notes || '').trim(),
    status: String(payload.status || 'active').trim().toLowerCase() || 'active'
  };
}

function validateClientPayload(payload) {
  const errors = {};

  if (!payload.name) {
    errors.name = 'Client name is required';
  } else if (payload.name.length < 2) {
    errors.name = 'Client name must be at least 2 characters';
  }

  if (!payload.phone) {
    errors.phone = 'Phone number is required';
  } else if (!PHONE_PATTERN.test(payload.phone)) {
    errors.phone = 'Phone must be in E.164 format, e.g. +919876543210';
  }

  if (payload.date_of_birth && !DATE_PATTERN.test(payload.date_of_birth)) {
    errors.date_of_birth = 'Date of birth must be in YYYY-MM-DD format';
  }

  if (!payload.last_visit_date) {
    errors.last_visit_date = 'Visit date is required';
  } else if (!DATE_PATTERN.test(payload.last_visit_date)) {
    errors.last_visit_date = 'Visit date must be in YYYY-MM-DD format';
  }

  if (!payload.treatment_type) {
    errors.treatment_type = 'Treatment type is required';
  } else if (payload.treatment_type.length < 2) {
    errors.treatment_type = 'Treatment type must be at least 2 characters';
  }

  if (!payload.annual_reminder_slot) {
    errors.annual_reminder_slot = 'Reminder time is required';
  } else if (!SLOT_PATTERN.test(payload.annual_reminder_slot)) {
    errors.annual_reminder_slot = 'Reminder time must be in HH:MM format';
  }

  if (!['active', 'paused'].includes(payload.status)) {
    errors.status = 'Status must be active or paused';
  }

  return errors;
}

function buildReminderFields(payload, existing = null) {
  const enabled = payload.annual_reminder_enabled;
  const status = payload.status;
  const nextReminderDate = enabled && status === 'active'
    ? computeNextAnnualReminderDate(payload.last_visit_date)
    : null;

  return {
    next_annual_reminder_date: nextReminderDate,
    last_annual_reminder_at: existing?.last_annual_reminder_at || null,
    last_annual_reminder_year: existing?.last_annual_reminder_year || null
  };
}

function handleSqliteError(error, res) {
  if (error.message && error.message.includes('UNIQUE constraint failed: clients.phone')) {
    return res.status(409).json({
      error: 'A client with this phone number already exists',
      fieldErrors: { phone: 'Phone number already exists' }
    });
  }

  console.error('Client route error:', error);
  return res.status(500).json({ error: error.message });
}

router.get('/', async (req, res) => {
  try {
    const archived = String(req.query.status || '').toLowerCase() === 'archived';
    const clients = await dbAll(
      `SELECT *
       FROM clients
       WHERE tenant_id = ? AND status ${archived ? '=' : '<>'} 'archived'
       ORDER BY
         CASE WHEN status = 'active' THEN 0 ELSE 1 END,
         COALESCE(next_annual_reminder_date, '9999-12-31') ASC,
         created_at DESC`,
      [String(req.tenantId)]
    );
    res.json(clients);
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const archived = String(req.query.status || '').toLowerCase() === 'archived';
    const client = await dbGet(
      `SELECT * FROM clients WHERE id = ? AND tenant_id = ? AND status ${archived ? '=' : '<>'} 'archived'`,
      [req.params.id, String(req.tenantId)]
    );
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.json(client);
  } catch (error) {
    console.error('Error fetching client:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const payload = normalizeClientPayload(req.body);
    const fieldErrors = validateClientPayload(payload);
    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
    }

    const reminderFields = buildReminderFields(payload);
    const result = await dbRun(
      `INSERT INTO clients (
        name, phone, date_of_birth, last_visit_date, treatment_type,
        annual_reminder_enabled, annual_reminder_slot, next_annual_reminder_date,
        notes, status, updated_at, tenant_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.name,
        payload.phone,
        payload.date_of_birth || null,
        payload.last_visit_date,
        payload.treatment_type,
        payload.annual_reminder_enabled,
        payload.annual_reminder_slot,
        reminderFields.next_annual_reminder_date,
        payload.notes || null,
        payload.status,
        new Date().toISOString(),
        String(req.tenantId)
      ]
    );

    res.json({ id: result.lastID, message: 'Client added successfully' });
  } catch (error) {
    return handleSqliteError(error, res);
  }
});

router.put('/:id', async (req, res) => {
  try {
    const existing = await dbGet(
      "SELECT * FROM clients WHERE id = ? AND tenant_id = ? AND status <> 'archived'",
      [req.params.id, String(req.tenantId)]
    );
    if (!existing) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const payload = normalizeClientPayload(req.body);
    const fieldErrors = validateClientPayload(payload);
    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
    }

    const reminderFields = buildReminderFields(payload, existing);

    await dbRun(
      `UPDATE clients
          SET name = ?,
              phone = ?,
              date_of_birth = ?,
              last_visit_date = ?,
              treatment_type = ?,
              annual_reminder_enabled = ?,
              annual_reminder_slot = ?,
              next_annual_reminder_date = ?,
              notes = ?,
              status = ?,
              updated_at = ?
        WHERE id = ? AND tenant_id = ? AND status <> 'archived'`,
      [
        payload.name,
        payload.phone,
        payload.date_of_birth || null,
        payload.last_visit_date,
        payload.treatment_type,
        payload.annual_reminder_enabled,
        payload.annual_reminder_slot,
        reminderFields.next_annual_reminder_date,
        payload.notes || null,
        payload.status,
        new Date().toISOString(),
        req.params.id,
        String(req.tenantId)
      ]
    );

    res.json({ message: 'Client updated successfully' });
  } catch (error) {
    return handleSqliteError(error, res);
  }
});

router.post('/:id/archive', clientArchiveHandlers.archive);
router.post('/:id/restore', clientArchiveHandlers.restore);
router.delete('/:id', clientArchiveHandlers.archive);

module.exports = router;
