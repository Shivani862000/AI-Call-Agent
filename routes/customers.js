const express = require('express');
const router = express.Router();
const { dbRun, dbGet, dbAll } = require('../db');
const multer = require('multer');
const { parse } = require('csv-parse/sync');

const upload = multer({ storage: multer.memoryStorage() });

// Add single customer
router.post('/', async (req, res) => {
  try {
    const { name, phone, preferred_slot } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }

    const result = await dbRun(
      'INSERT INTO customers (name, phone, preferred_slot, status) VALUES (?, ?, ?, ?)',
      [name, phone, preferred_slot || '10:00', 'pending']
    );

    res.json({ id: result.lastID, message: 'Customer added successfully' });
  } catch (error) {
    console.error('Error adding customer:', error);
    res.status(500).json({ error: error.message });
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

    for (const record of records) {
      try {
        await dbRun(
          'INSERT INTO customers (name, phone, preferred_slot, status) VALUES (?, ?, ?, ?)',
          [
            record.name,
            record.phone,
            record.preferred_slot || '10:00',
            'pending'
          ]
        );
        successCount++;
      } catch (err) {
        console.error('Error inserting row:', err.message);
        errorCount++;
      }
    }

    res.json({
      message: `CSV import completed`,
      successCount,
      errorCount,
      totalRows: records.length
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

// Delete customer
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Delete related calls and feedback first
    await dbRun('DELETE FROM feedback WHERE customer_id = ?', [id]);
    await dbRun('DELETE FROM calls WHERE customer_id = ?', [id]);
    await dbRun('DELETE FROM customers WHERE id = ?', [id]);

    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    console.error('Error deleting customer:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
