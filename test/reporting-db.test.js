'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withTestPatient } = require('./support/fixtures');

test('report recovery totals cover the full period and exclude unrated positive calls', async () => {
  const { initializeDatabase, dbRun, closeDatabase } = require('../db');
  const { buildReportData } = require('../services/reporting');
  await initializeDatabase();
  try {
    await withTestPatient(async ({ patientId }) => {
      const customer = await dbRun('INSERT INTO customers (patient_id, status) VALUES (?, ?)', [patientId, 'called']);
      for (let index = 0; index < 10; index += 1) {
        await dbRun(
          `INSERT INTO calls (customer_id, patient_id, called_at, outcome, sentiment_label, extracted_rating, analysis_status)
           VALUES (?, ?, now(), 'completed', 'negative', 1, 'completed')`,
          [customer.lastID, patientId]
        );
      }
      await dbRun(
        `INSERT INTO calls (customer_id, patient_id, called_at, outcome, sentiment_label, extracted_rating, analysis_status)
         VALUES (?, ?, now(), 'completed', 'positive', NULL, 'completed')`,
        [customer.lastID, patientId]
      );
      const report = await buildReportData({ start: '2020-01-01T00:00:00.000Z', end: '2030-01-01T00:00:00.000Z' });
      assert.equal(report.service_recovery_count, 10);
      assert.equal(report.service_recovery_queue.length, 6);
    });
  } finally {
    await closeDatabase();
  }
});
