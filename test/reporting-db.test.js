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

test('owner dashboard alert totals include records beyond the bounded alert list', async () => {
  const { initializeDatabase, dbRun, closeDatabase } = require('../db');
  const { buildOwnerDashboardData } = require('../services/reporting');
  await initializeDatabase();
  try {
    await withTestPatient(async ({ patientId }) => {
      const customer = await dbRun('INSERT INTO customers (patient_id, status) VALUES (?, ?)', [patientId, 'called']);
      for (let index = 0; index < 15; index += 1) {
        await dbRun(
          `INSERT INTO calls (customer_id, patient_id, called_at, outcome, sentiment_label, hot_lead_score)
           VALUES (?, ?, now(), ?, ?, ?)`,
          [customer.lastID, patientId, index < 10 ? 'interested' : 'callback', index < 10 ? null : 'negative', index < 10 ? 90 : 0]
        );
      }
      const dashboard = await buildOwnerDashboardData();
      assert.equal(dashboard.alerts.length, 12);
      assert.equal(dashboard.owner_cards.find((card) => card.label === 'Hot leads').value, 10);
      assert.equal(dashboard.callback_count, 5);
      assert.equal(dashboard.critical_alert_count, 15);
    });
  } finally {
    await closeDatabase();
  }
});
