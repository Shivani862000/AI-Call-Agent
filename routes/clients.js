'use strict';

const express = require('express');
const Client = require('../src/models/Client');
const { activeRecordFilter, recordFilterFromRequest, createMongooseArchiveHandlers } = require('../src/webmaster/lifecycle');

const PHONE_PATTERN = /^\+\d{10,15}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toBooleanFlag(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase()) ? 1 : 0;
}

function createAnniversaryDate(lastVisitDate, year) {
  const [, monthText, dayText] = String(lastVisitDate || '').split('-');
  const month = Number(monthText);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(Number(dayText), lastDay)));
}

function computeNextAnnualReminderDate(lastVisitDate, referenceDate = new Date()) {
  const format = (date) => date.toISOString().slice(0, 10);
  let candidate = format(createAnniversaryDate(lastVisitDate, referenceDate.getUTCFullYear()));
  if (candidate < format(referenceDate)) candidate = format(createAnniversaryDate(lastVisitDate, referenceDate.getUTCFullYear() + 1));
  return candidate;
}

function normalizePayload(payload = {}) {
  return {
    name: String(payload.name || '').trim(),
    phone: String(payload.phone || '').trim(),
    date_of_birth: String(payload.date_of_birth || '').trim() || null,
    last_visit_date: String(payload.last_visit_date || '').trim(),
    treatment_type: String(payload.treatment_type || '').trim(),
    annual_reminder_enabled: toBooleanFlag(payload.annual_reminder_enabled === undefined ? 1 : payload.annual_reminder_enabled),
    annual_reminder_slot: String(payload.annual_reminder_slot || '10:00').trim() || '10:00',
    notes: String(payload.notes || '').trim() || null,
    status: String(payload.status || 'active').trim().toLowerCase() || 'active'
  };
}

function validate(payload) {
  const fieldErrors = {};
  if (!payload.name || payload.name.length < 2) fieldErrors.name = payload.name ? 'Client name must be at least 2 characters' : 'Client name is required';
  if (!payload.phone || !PHONE_PATTERN.test(payload.phone)) fieldErrors.phone = payload.phone ? 'Phone must be in E.164 format, e.g. +919876543210' : 'Phone number is required';
  if (payload.date_of_birth && !DATE_PATTERN.test(payload.date_of_birth)) fieldErrors.date_of_birth = 'Date of birth must be in YYYY-MM-DD format';
  if (!payload.last_visit_date || !DATE_PATTERN.test(payload.last_visit_date)) fieldErrors.last_visit_date = payload.last_visit_date ? 'Visit date must be in YYYY-MM-DD format' : 'Visit date is required';
  if (!payload.treatment_type || payload.treatment_type.length < 2) fieldErrors.treatment_type = payload.treatment_type ? 'Treatment type must be at least 2 characters' : 'Treatment type is required';
  if (!SLOT_PATTERN.test(payload.annual_reminder_slot)) fieldErrors.annual_reminder_slot = 'Reminder time must be in HH:MM format';
  if (!['active', 'paused'].includes(payload.status)) fieldErrors.status = 'Status must be active or paused';
  return fieldErrors;
}

function reminderFields(payload, existing = null) {
  return {
    next_annual_reminder_date: payload.annual_reminder_enabled && payload.status === 'active' ? computeNextAnnualReminderDate(payload.last_visit_date) : null,
    last_annual_reminder_at: existing?.last_annual_reminder_at || null,
    last_annual_reminder_year: existing?.last_annual_reminder_year || null
  };
}

function serialize(record) {
  const value = record?.toObject ? record.toObject() : { ...record };
  if (value._id !== undefined) value.id = String(value._id);
  delete value._id;
  delete value.archived_by;
  return value;
}

function duplicateResponse(error, res) {
  if (error.code !== 11000) return res.status(500).json({ error: error.message });
  return res.status(409).json({ error: 'A client with this phone number already exists', fieldErrors: { phone: 'Phone number already exists' } });
}

function createClientsRouter({ Model = Client } = {}) {
  const router = express.Router();
  const archiveHandlers = createMongooseArchiveHandlers({ Model, resourceName: 'Client' });

  router.get('/', async (req, res) => {
    try {
      const rows = await Model.find(recordFilterFromRequest(req, { tenantId: req.tenantId })).sort({ status: 1, next_annual_reminder_date: 1, created_at: -1 }).lean();
      res.json(rows.map(serialize));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const row = await Model.findOne(recordFilterFromRequest(req, { _id: req.params.id, tenantId: req.tenantId })).lean();
      if (!row) return res.status(404).json({ error: 'Client not found' });
      res.json(serialize(row));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  router.post('/', async (req, res) => {
    try {
      const payload = normalizePayload(req.body);
      const fieldErrors = validate(payload);
      if (Object.keys(fieldErrors).length) return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
      const record = await Model.create({ ...payload, ...reminderFields(payload), tenantId: req.tenantId });
      res.json({ id: String(record._id), message: 'Client added successfully' });
    } catch (error) { duplicateResponse(error, res); }
  });

  router.put('/:id', async (req, res) => {
    try {
      const existing = await Model.findOne(activeRecordFilter({ _id: req.params.id, tenantId: req.tenantId })).lean();
      if (!existing) return res.status(404).json({ error: 'Client not found' });
      const payload = normalizePayload(req.body);
      const fieldErrors = validate(payload);
      if (Object.keys(fieldErrors).length) return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
      await Model.findOneAndUpdate(activeRecordFilter({ _id: req.params.id, tenantId: req.tenantId }), { $set: { ...payload, ...reminderFields(payload, existing) } }, { runValidators: true });
      res.json({ message: 'Client updated successfully' });
    } catch (error) { duplicateResponse(error, res); }
  });

  router.post('/:id/archive', archiveHandlers.archive);
  router.post('/:id/restore', archiveHandlers.restore);
  router.delete('/:id', archiveHandlers.archive);
  return router;
}

module.exports = createClientsRouter();
module.exports.createClientsRouter = createClientsRouter;
