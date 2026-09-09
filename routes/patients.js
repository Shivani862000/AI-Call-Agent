'use strict';

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { dbAll, dbGet, dbRun, dbTx } = require('../db');
const logger = require('../services/system-logger');
const {
  serializePatient,
  attemptedContactWrites,
  normalizePatientPayload,
  validatePatientPayload
} = require('../src/patient-rules');
const { mapHeaders, buildImportPlan, COLUMN_ALIASES } = require('../src/patient-import');
const { blockingReason } = require('../src/queue-rules');
const { countOutboundCallsToday, MAX_CALLS_PER_DAY } = require('../src/call-management');

const MAX_IMPORT_ROWS = 5000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const COLUMNS = `id, reference_id, first_name, last_name, phone, normalized_phone, email,
  preferred_call_slot, preferred_language, date_of_birth, gender, blood_group,
  last_donation_date, last_test_date, do_not_call, consent_status, status, notes,
  created_by, updated_by, created_at, updated_at`;

// Validated import plans awaiting confirmation. Held so the commit applies
// exactly what was previewed rather than re-parsing the file.
const pendingImports = new Map();
const IMPORT_TTL_MS = 15 * 60 * 1000;

function rememberImport(plan, username) {
  const token = crypto.randomUUID();
  pendingImports.set(token, { plan, username, expiresAt: Date.now() + IMPORT_TTL_MS });
  for (const [key, value] of pendingImports) {
    if (value.expiresAt < Date.now()) pendingImports.delete(key);
  }
  return token;
}

const router = express.Router();

function roleOf(req) {
  return String(req.adminSession?.role || '').toUpperCase();
}

function isAdmin(req) {
  return roleOf(req) === 'ADMIN';
}

/** Rejects any attempt by a non-admin to read or write contact details. */
function guardContactWrites(req, res) {
  if (isAdmin(req)) return false;
  const attempted = attemptedContactWrites(req.body);
  if (attempted.length === 0) return false;
  res.status(403).json({
    error: `Only an admin can change the ${attempted.join(' and ')} of a saved patient`,
    fieldErrors: Object.fromEntries(attempted.map((f) => [f, 'Admin only']))
  });
  return true;
}

async function findPatientMatches(payload) {
  const select = `SELECT ${COLUMNS}, xmin::text AS version FROM patients WHERE `;
  const [byReference, byPhone] = await Promise.all([
    payload.reference_id
      ? dbGet(`${select}lower(reference_id) = lower(?)`, [payload.reference_id]) : null,
    payload.normalized_phone
      ? dbGet(`${select}normalized_phone = ?`, [payload.normalized_phone]) : null
  ]);
  return { byReference: byReference || null, byPhone: byPhone || null };
}

const FIELDS = [
  'reference_id', 'first_name', 'last_name', 'phone', 'normalized_phone', 'email',
  'preferred_call_slot', 'preferred_language', 'date_of_birth', 'gender', 'blood_group',
  'last_donation_date', 'last_test_date', 'do_not_call', 'consent_status', 'status', 'notes'
];

async function insertPatient(payload, username) {
  const columns = [...FIELDS, 'created_by', 'updated_by'];
  const values = [...FIELDS.map((f) => payload[f]), username, username];
  return dbRun(
    `INSERT INTO patients (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    values
  );
}

async function updatePatient(id, payload, username, allowContact) {
  const fields = allowContact ? FIELDS : FIELDS.filter((f) => !['phone', 'normalized_phone', 'email'].includes(f));
  const sets = fields.map((f) => `${f} = ?`).concat('updated_by = ?', 'updated_at = now()');
  return dbRun(
    `UPDATE patients SET ${sets.join(', ')} WHERE id = ?`,
    [...fields.map((f) => payload[f]), username, id]
  );
}

const IMPORT_WRITE_FIELDS = [
  'reference_id', 'first_name', 'last_name', 'phone', 'normalized_phone', 'email',
  'preferred_call_slot', 'preferred_language', 'date_of_birth', 'gender', 'blood_group',
  'last_donation_date', 'last_test_date', 'notes'
];
const IMPORT_WRITE_FIELD_SET = new Set(IMPORT_WRITE_FIELDS);

function staleImportError() {
  const error = new Error('This row changed after the preview. Check the file and preview it again.');
  error.code = 'IMPORT_PREVIEW_STALE';
  return error;
}

async function transactionMatches(tx, identity) {
  const byReference = identity.reference_id
    ? await tx.get('SELECT id FROM patients WHERE lower(reference_id) = lower(?)', [identity.reference_id])
    : null;
  const byPhone = identity.normalized_phone
    ? await tx.get('SELECT id FROM patients WHERE normalized_phone = ?', [identity.normalized_phone])
    : null;
  return { byReference, byPhone };
}

async function commitImportCreate(entry, username) {
  return dbTx(async (tx) => {
    const matches = await transactionMatches(tx, {
      reference_id: entry.payload.reference_id,
      normalized_phone: entry.payload.normalized_phone
    });
    if (matches.byReference || matches.byPhone) throw staleImportError();
    const columns = [...IMPORT_WRITE_FIELDS, 'created_by', 'updated_by'];
    return tx.run(
      `INSERT INTO patients (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      [...IMPORT_WRITE_FIELDS.map((field) => entry.payload[field]), username, username]
    );
  });
}

async function commitImportUpdate(entry, username) {
  return dbTx(async (tx) => {
    const current = await tx.get(
      `SELECT ${COLUMNS}, xmin::text AS version FROM patients WHERE id = ? FOR UPDATE`, [entry.id]
    );
    if (!current || String(current.version) !== String(entry.version)) throw staleImportError();
    const matches = await transactionMatches(tx, entry.identity);
    if ((matches.byReference && Number(matches.byReference.id) !== Number(entry.id))
        || (matches.byPhone && Number(matches.byPhone.id) !== Number(entry.id))) {
      throw staleImportError();
    }
    const fields = Object.keys(entry.patch).filter((field) => IMPORT_WRITE_FIELD_SET.has(field));
    if (!fields.length) return;
    await tx.run(
      `UPDATE patients SET ${fields.map((field) => `${field} = ?`).join(', ')}, updated_by = ?, updated_at = now()
        WHERE id = ?`,
      [...fields.map((field) => entry.patch[field]), username, entry.id]
    );
  });
}

function safeImportFailure(error) {
  if (error?.code === 'IMPORT_PREVIEW_STALE' || error?.code === '23505') {
    return 'This row no longer matches the preview. Check the file and preview it again.';
  }
  return 'This row could not be saved. Check the file and preview it again.';
}

function plannedChanges(entry) {
  return Object.entries(entry.patch).flatMap(([field, to]) => {
    if (field === 'normalized_phone') return [];
    const from = entry.before?.[field] ?? null;
    const fromValue = from instanceof Date ? from.toISOString() : from;
    if (String(fromValue ?? '') === String(to ?? '')) return [];
    return [{ field, from: fromValue, to, ...(to === null ? { clear: true } : {}) }];
  });
}

// ── List and search ────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || 'all').toLowerCase();
    const params = [];
    const where = [];

    if (search) {
      // Digits are matched against the normalised number so an agent can find
      // an inbound caller; the number itself is still never returned to them.
      const digits = search.replace(/\D/g, '');
      where.push(`(lower(first_name || ' ' || coalesce(last_name, '')) LIKE lower(?)
        OR lower(coalesce(reference_id, '')) = lower(?)
        ${digits.length >= 4 ? 'OR normalized_phone LIKE ?' : ''})`);
      params.push(`%${search}%`, search);
      if (digits.length >= 4) params.push(`%${digits.slice(-10)}%`);
    }
    if (status === 'active' || status === 'inactive') {
      where.push('status = ?');
      params.push(status);
    }

    const rows = await dbAll(
      `SELECT ${COLUMNS} FROM patients
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY lower(first_name), lower(coalesce(last_name, '')) LIMIT 500`,
      params
    );
    res.json({ patients: rows.map((row) => serializePatient(row, roleOf(req))) });
  } catch (error) { next(error); }
});

router.get('/:id(\\d+)', async (req, res, next) => {
  try {
    const row = await dbGet(`SELECT ${COLUMNS} FROM patients WHERE id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Patient not found' });
    res.json({ patient: serializePatient(row, roleOf(req)) });
  } catch (error) { next(error); }
});

// ── Create ─────────────────────────────────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    // Agents may create a patient: they are typing a number they already have.
    const payload = normalizePatientPayload(req.body);
    const fieldErrors = validatePatientPayload(payload);
    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
    }

    const created = await insertPatient(payload, req.adminSession?.username);
    const row = await dbGet(`SELECT ${COLUMNS} FROM patients WHERE id = ?`, [created.lastID]);
    logger.info('PATIENT_CREATED', { patientId: created.lastID, by: req.adminSession?.username });
    res.status(201).json({ patient: serializePatient(row, roleOf(req)) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'A patient with this mobile number already exists',
        fieldErrors: { phone: 'Already on file — search for them instead' }
      });
    }
    next(error);
  }
});

// ── Update ─────────────────────────────────────────────────────────────────────

router.put('/:id(\\d+)', async (req, res, next) => {
  try {
    if (guardContactWrites(req, res)) return;

    const existing = await dbGet(`SELECT ${COLUMNS} FROM patients WHERE id = ?`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Patient not found' });

    // An agent cannot see the stored contact details, so they submit the form
    // without them; merge the stored values back before validating.
    const merged = isAdmin(req)
      ? req.body
      : { ...req.body, phone: existing.phone, email: existing.email };

    const payload = normalizePatientPayload(merged);
    const fieldErrors = validatePatientPayload(payload);
    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
    }

    await updatePatient(req.params.id, payload, req.adminSession?.username, isAdmin(req));
    const row = await dbGet(`SELECT ${COLUMNS} FROM patients WHERE id = ?`, [req.params.id]);
    logger.info('PATIENT_UPDATED', { patientId: Number(req.params.id), by: req.adminSession?.username });
    res.json({ patient: serializePatient(row, roleOf(req)) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Another patient already has this mobile number',
        fieldErrors: { phone: 'Already on file' }
      });
    }
    next(error);
  }
});

/** Soft removal — keeps the record and its call history. Available to agents. */
router.patch('/:id(\\d+)/status', async (req, res, next) => {
  try {
    const status = req.body.status === 'inactive' ? 'inactive' : 'active';
    const result = await dbRun(
      'UPDATE patients SET status = ?, updated_by = ?, updated_at = now() WHERE id = ?',
      [status, req.adminSession?.username, req.params.id]
    );
    if (!result.changes) return res.status(404).json({ error: 'Patient not found' });
    logger.info('PATIENT_STATUS_CHANGED', { patientId: Number(req.params.id), status, by: req.adminSession?.username });
    res.json({ success: true, status });
  } catch (error) { next(error); }
});

/** Hard delete — admin only, and refused when the patient has call history. */
router.delete('/:id(\\d+)', async (req, res, next) => {
  try {
    const patient = await dbGet('SELECT id, first_name, last_name FROM patients WHERE id = ?', [req.params.id]);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    const linked = await dbGet(
      'SELECT COUNT(*) AS count FROM customer_queue WHERE patient_id = ?', [req.params.id]
    );
    if (Number(linked?.count || 0) > 0) {
      return res.status(409).json({
        error: 'This patient has call history. Remove them from the calling list instead — '
          + 'deleting would destroy the record that they were called.'
      });
    }

    await dbRun('DELETE FROM patients WHERE id = ?', [req.params.id]);
    logger.warn('PATIENT_DELETED', { patientId: Number(req.params.id), by: req.adminSession?.username });
    res.json({ success: true });
  } catch (error) { next(error); }
});

// ── Scheduling a call ──────────────────────────────────────────────────────────

/**
 * Opens a queue entry for one patient. Shared by the single and bulk routes so
 * the guards cannot diverge between them.
 */
async function scheduleOne(patientId, { scheduledAt, callType, username }) {
  const patient = await dbGet(
    `SELECT id, first_name, last_name, do_not_call, consent_status, status, normalized_phone,
            preferred_call_slot
       FROM patients WHERE id = ?`, [patientId]
  );

  const blocked = blockingReason(patient);
  if (blocked) return { ok: false, patientId, reason: blocked };

  // Checked here as well as in the scheduler, so the person clicking is told
  // why. Queuing succeeded and the scheduler failed the entry seconds later
  // with nothing on screen: "Calling Ankita now", and then silence.
  const callsToday = await countOutboundCallsToday(patient.normalized_phone || patient.phone);
  if (callsToday >= MAX_CALLS_PER_DAY) {
    return {
      ok: false,
      patientId,
      reason: `Already called ${callsToday} times today. The daily limit is ${MAX_CALLS_PER_DAY}.`
    };
  }

  // A patient may have several calls scheduled -- a follow-up next week and a
  // reminder next month are two different calls. What must not happen is the
  // same call being queued twice, which is what a double-click on "Call now"
  // produces: two entries seconds apart, and two phones ringing.
  const requestedAt = new Date(scheduledAt || Date.now());
  const clash = await dbGet(
    `SELECT id FROM customers
      WHERE patient_id = ?
        AND status IN ('pending','scheduled','calling','retry_scheduled','callback_scheduled')
        AND scheduled_datetime IS NOT NULL
        AND abs(extract(epoch FROM (scheduled_datetime - ?::timestamptz))) < 300`,
    [patientId, requestedAt.toISOString()]
  );
  if (clash) {
    return { ok: false, patientId, reason: 'A call is already scheduled for around that time' };
  }

  await dbRun(
    // A new row per scheduled call. It used to upsert onto a unique patient_id,
    // so scheduling overwrote whatever that patient already had queued.
    `INSERT INTO customers (patient_id, scheduled_datetime, status, call_type, is_manual, created_at)
     VALUES (?, ?, 'scheduled', ?, 1, now())
`,
    [patientId, scheduledAt || new Date().toISOString(), callType || 'REVIEW_CALL']
  );

  logger.info('CALL_SCHEDULED', { patientId, by: username });
  return { ok: true, patientId };
}

router.post('/:id(\\d+)/schedule-call', async (req, res, next) => {
  try {
    const result = await scheduleOne(Number(req.params.id), {
      scheduledAt: req.body.scheduled_at,
      callType: req.body.call_type,
      username: req.adminSession?.username
    });
    if (!result.ok) return res.status(409).json({ error: result.reason });
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.post('/schedule-calls', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.patient_ids) ? req.body.patient_ids.map(Number).filter(Boolean) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'Select at least one patient' });
    if (ids.length > 500) return res.status(400).json({ error: 'At most 500 patients at a time' });

    const results = [];
    for (const id of ids) {
      results.push(await scheduleOne(id, {
        scheduledAt: req.body.scheduled_at,
        callType: req.body.call_type,
        username: req.adminSession?.username
      }));
    }

    const scheduled = results.filter((r) => r.ok).length;
    // Skips are reported rather than silently dropped: "12 of 20 scheduled"
    // with reasons is honest, "done" is not.
    res.json({
      scheduled,
      skipped: results.filter((r) => !r.ok).map((r) => ({ patientId: r.patientId, reason: r.reason }))
    });
  } catch (error) { next(error); }
});

// ── Import ─────────────────────────────────────────────────────────────────────

const TEMPLATE_COLUMNS = [
  ['Reference ID', 'BD-1001'],
  ['First Name', 'Aarti'],
  ['Last Name', 'Gupta'],
  ['Mobile Number', '9876543210'],
  ['Email', 'aarti@example.in'],
  ['Preferred Time', '10:00'],
  ['Preferred Language', 'hi'],
  ['Date of Birth', '1990-04-12'],
  ['Gender', 'female'],
  ['Blood Group', 'O+'],
  ['Last Blood Donation', '2026-01-15'],
  ['Last Blood Test', '2026-03-02'],
  ['Notes', 'Prefers morning calls']
];

router.get('/import/template', async (req, res, next) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Patients');
    sheet.addRow(TEMPLATE_COLUMNS.map(([header]) => header));
    sheet.addRow(TEMPLATE_COLUMNS.map(([, example]) => example));
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((column) => { column.width = 22; });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="patient-import-template.xlsx"');
    res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
  } catch (error) { next(error); }
});

router.post('/import/preview', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a file to import' });

    const workbook = new ExcelJS.Workbook();
    const name = String(req.file.originalname || '').toLowerCase();
    if (name.endsWith('.csv')) await workbook.csv.read(require('stream').Readable.from(req.file.buffer));
    else await workbook.xlsx.load(req.file.buffer);

    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) {
      return res.status(400).json({ error: 'That file has no rows below the header' });
    }
    if (sheet.rowCount - 1 > MAX_IMPORT_ROWS) {
      return res.status(400).json({ error: `That file has more than ${MAX_IMPORT_ROWS} rows` });
    }

    const toCells = (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, index) => { cells[index - 1] = cell.value; });
      return cells;
    };

    const { map, missing } = mapHeaders(toCells(sheet.getRow(1)));
    if (missing.length > 0) {
      return res.status(400).json({
        error: `The file is missing a column for ${missing.map((f) => f.replace('_', ' ')).join(' and ')}. `
          + 'Download the template to see the expected columns.'
      });
    }

    const rows = [];
    for (let i = 2; i <= sheet.rowCount; i += 1) rows.push(toCells(sheet.getRow(i)));

    // Resolve matches up front: buildImportPlan is pure and cannot await.
    const existingByIndex = [];
    for (const cells of rows) {
      const raw = {};
      Object.entries(map).forEach(([index, field]) => { raw[field] = cells[Number(index)]; });
      const payload = normalizePatientPayload(raw);
      existingByIndex.push(payload.normalized_phone || payload.reference_id
        ? await findPatientMatches(payload) : null);
    }
    const plan = buildImportPlan({
      rows, headerMap: map, findExisting: (_payload, index) => existingByIndex[index]
    });

    const token = rememberImport(plan, req.adminSession?.username);
    const previewRows = [
      ...plan.creates.map((c) => ({
        row: c.row, action: 'new',
        name: [c.payload.first_name, c.payload.last_name].filter(Boolean).join(' '), changes: []
      })),
      ...plan.updates.map((u) => ({
        row: u.row, action: 'update',
        name: [u.payload.first_name, u.payload.last_name].filter(Boolean).join(' '),
        changes: plannedChanges(u)
      }))
    ].sort((left, right) => left.row - right.row);
    res.json({
      token,
      summary: { new: plan.creates.length, updates: plan.updates.length, problems: plan.problems.length, total: plan.total },
      problems: plan.problems.slice(0, 50),
      preview: previewRows.slice(0, 20),
      previewLimit: 20,
      previewed: Math.min(20, previewRows.length)
    });
  } catch (error) {
    if (error instanceof Error && /zip|corrupt|end of central/i.test(error.message)) {
      return res.status(400).json({ error: 'That file could not be read as a spreadsheet' });
    }
    next(error);
  }
});

router.post('/import/commit', async (req, res, next) => {
  try {
    const entry = pendingImports.get(String(req.body.token || ''));
    if (!entry || entry.expiresAt < Date.now()) {
      pendingImports.delete(String(req.body.token || ''));
      return res.status(410).json({ error: 'That preview has expired. Upload the file again.' });
    }
    if (entry.username !== req.adminSession?.username) {
      return res.status(403).json({ error: 'That import was started by someone else' });
    }
    pendingImports.delete(req.body.token);

    const username = req.adminSession?.username;
    let created = 0;
    let updated = 0;
    const failures = [];

    const operations = [
      ...entry.plan.creates.map((row) => ({ action: 'create', row })),
      ...entry.plan.updates.map((row) => ({ action: 'update', row }))
    ].sort((left, right) => left.row.row - right.row.row);
    for (const operation of operations) {
      try {
        if (operation.action === 'create') {
          await commitImportCreate(operation.row, username);
          created += 1;
        } else {
          await commitImportUpdate(operation.row, username);
          updated += 1;
        }
      } catch (error) {
        failures.push({ row: operation.row.row, message: safeImportFailure(error) });
      }
    }

    logger.warn('PATIENTS_IMPORTED', { created, updated, failed: failures.length, by: username });
    const body = {
      created, updated, failures: failures.slice(0, 20),
      ...(failures.length ? { error: 'Some rows could not be imported. Preview the file again before retrying.' } : {})
    };
    res.status(failures.length ? 409 : 200).json(body);
  } catch (error) { next(error); }
});

module.exports = router;
module.exports.COLUMN_ALIASES = COLUMN_ALIASES;
