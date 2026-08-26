const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');

const upload = multer({ storage: multer.memoryStorage() });
const PHONE_PATTERN = /^\+\d{10,15}$/;
const SLOT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toBooleanFlag(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized) ? 1 : 0;
}

function normalizeCustomerPayload(payload = {}) {
  return {
    name: String(payload.name || '').trim(),
    phone: String(payload.phone || '').trim(),
    preferred_slot: String(payload.preferred_slot || '10:00').trim() || '10:00',
    customer_value: String(payload.customer_value || 'standard').trim().toLowerCase() || 'standard',
    urgency_level: String(payload.urgency_level || 'normal').trim().toLowerCase() || 'normal',
    preferred_language: String(payload.preferred_language || 'hi').trim().toLowerCase() || 'hi',
    preferred_dialect: String(payload.preferred_dialect || '').trim(),
    do_not_call: toBooleanFlag(payload.do_not_call),
    consent_status: String(payload.consent_status || 'unknown').trim().toLowerCase() || 'unknown',
    outstanding_issues: String(payload.outstanding_issues || '').trim(),
    pending_follow_ups: String(payload.pending_follow_ups || '').trim(),
    revenue_stage: String(payload.revenue_stage || 'unassigned').trim().toLowerCase() || 'unassigned',
    revenue_estimate: Number(payload.revenue_estimate || 0) || 0
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

  return errors;
}

function handleCustomerError(error, res) {
  if (error?.code === 'CUSTOMER_PHONE_EXISTS') {
    return res.status(409).json({
      error: 'A customer with this phone number already exists',
      fieldErrors: { phone: 'Phone number already exists' }
    });
  }

  console.error('Customer route error:', error);
  return res.status(500).json({ error: error.message });
}

function createCustomersRouter({ customers, getClientId }) {
  if (!customers || typeof getClientId !== 'function') {
    throw new TypeError('Customer router requires customers and getClientId dependencies');
  }

  const router = express.Router();
  const resolveClientId = (req) => Promise.resolve(getClientId(req));

  router.post('/', async (req, res) => {
    try {
      const payload = normalizeCustomerPayload(req.body);
      const fieldErrors = validateCustomerPayload(payload);

      if (Object.keys(fieldErrors).length > 0) {
        return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
      }

      const customer = await customers.create(await resolveClientId(req), {
        ...payload,
        status: 'pending'
      });
      return res.json({ id: customer.id, message: 'Customer added successfully' });
    } catch (error) {
      return handleCustomerError(error, res);
    }
  });

  router.post('/csv', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const clientId = await resolveClientId(req);
      const records = parse(req.file.buffer.toString('utf-8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });
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
          await customers.create(clientId, { ...payload, status: 'pending' });
          successCount += 1;
        } catch (error) {
          errorCount += 1;
          errors.push({ row: index + 2, error: error.message });
        }
      }

      return res.json({
        message: 'CSV import completed',
        successCount,
        errorCount,
        totalRows: records.length,
        errors: errors.slice(0, 10)
      });
    } catch (error) {
      console.error('Error processing CSV:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/', async (req, res) => {
    try {
      return res.json(await customers.list(await resolveClientId(req)));
    } catch (error) {
      console.error('Error fetching customers:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const customer = await customers.findById(await resolveClientId(req), req.params.id);
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      return res.json(customer);
    } catch (error) {
      console.error('Error fetching customer:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const clientId = await resolveClientId(req);
      const existing = await customers.findById(clientId, req.params.id);
      if (!existing) return res.status(404).json({ error: 'Customer not found' });

      const payload = normalizeCustomerPayload(req.body);
      const fieldErrors = validateCustomerPayload(payload);
      if (Object.keys(fieldErrors).length > 0) {
        return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
      }

      await customers.update(clientId, req.params.id, payload);
      return res.json({ message: 'Customer updated successfully' });
    } catch (error) {
      return handleCustomerError(error, res);
    }
  });

  router.patch('/:id/workflow', async (req, res) => {
    try {
      const clientId = await resolveClientId(req);
      const existing = await customers.findById(clientId, req.params.id);
      if (!existing) return res.status(404).json({ error: 'Customer not found' });

      await customers.update(clientId, req.params.id, {
        do_not_call: req.body.do_not_call === undefined ? existing.do_not_call : toBooleanFlag(req.body.do_not_call),
        wrong_number_flag: req.body.wrong_number_flag === undefined ? existing.wrong_number_flag : toBooleanFlag(req.body.wrong_number_flag),
        admin_review_required: req.body.admin_review_required === undefined ? existing.admin_review_required : toBooleanFlag(req.body.admin_review_required),
        consent_status: req.body.consent_status ? String(req.body.consent_status).trim().toLowerCase() : existing.consent_status,
        next_retry_at: req.body.next_retry_at === undefined ? existing.next_retry_at : req.body.next_retry_at,
        pending_follow_ups: req.body.pending_follow_ups === undefined
          ? existing.pending_follow_ups
          : String(req.body.pending_follow_ups || '').trim() || null
      });
      return res.json({ message: 'Workflow updated successfully' });
    } catch (error) {
      console.error('Error updating customer workflow:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/:id/retry', async (req, res) => {
    try {
      const clientId = await resolveClientId(req);
      const existing = await customers.findById(clientId, req.params.id);
      if (!existing) return res.status(404).json({ error: 'Customer not found' });

      const retryAt = req.body.retry_at || new Date(Date.now() + (60 * 60 * 1000)).toISOString();
      await customers.scheduleRetry(clientId, req.params.id, retryAt);
      return res.json({ message: 'Retry scheduled successfully', retry_at: retryAt });
    } catch (error) {
      console.error('Error scheduling retry:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const deleted = await customers.deleteWithRelations(await resolveClientId(req), req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Customer not found' });
      return res.json({ message: 'Customer deleted successfully' });
    } catch (error) {
      console.error('Error deleting customer:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = {
  createCustomersRouter,
  normalizeCustomerPayload,
  validateCustomerPayload
};
