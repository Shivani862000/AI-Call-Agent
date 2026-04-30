const express = require('express');
const router = express.Router();
const { dbRun, dbGet, dbAll } = require('../db');
const multer = require('multer');
const { parse } = require('csv-parse/sync');

const upload = multer({ storage: multer.memoryStorage() });
const PHONE_PATTERN = /^\+\d{10,15}$/;
const SLOT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function normalizeCustomerPayload(payload = {}) {
  return {
    name: String(payload.name || '').trim(),
    phone: String(payload.phone || '').trim(),
    preferred_slot: String(payload.preferred_slot || '10:00').trim() || '10:00'
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

  return errors;
}

function handleSqliteError(error, res) {
  if (error.message && error.message.includes('UNIQUE constraint failed: customers.phone')) {
    return res.status(409).json({
      error: 'A customer with this phone number already exists',
      fieldErrors: { phone: 'Phone number already exists' }
    });
  }

  console.error('Customer route error:', error);
  return res.status(500).json({ error: error.message });
}

async function saveCustomer(payload) {
  return dbRun(
    'INSERT INTO customers (name, phone, preferred_slot, status) VALUES (?, ?, ?, ?)',
    [payload.name, payload.phone, payload.preferred_slot, 'pending']
  );
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

// List all customers
router.get('/', async (req, res) => {
  try {
    const customers = await dbAll('SELECT * FROM customers ORDER BY created_at DESC');
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

    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ error: 'Please fix the highlighted fields', fieldErrors });
    }

    await dbRun(
      'UPDATE customers SET name = ?, phone = ?, preferred_slot = ? WHERE id = ?',
      [payload.name, payload.phone, payload.preferred_slot, req.params.id]
    );

    res.json({ message: 'Customer updated successfully' });
  } catch (error) {
    return handleSqliteError(error, res);
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
