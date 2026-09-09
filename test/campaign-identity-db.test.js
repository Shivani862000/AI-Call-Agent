'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withTestPatient } = require('./support/fixtures');

test('campaign identity survives a campaign rename and queue history remains attributable', async () => {
  const { initializeDatabase, dbRun, dbGet, closeDatabase } = require('../db');
  await initializeDatabase();
  try {
    await withTestPatient(async ({ patientId }) => {
      const campaign = await dbRun(
        'INSERT INTO campaign_configs (name, service_name, status) VALUES (?, ?, ?)',
        ['Spring Drive', 'screening', 'active']
      );
      const customer = await dbRun(
        'INSERT INTO customers (patient_id, campaign_name, status) VALUES (?, ?, ?)',
        [patientId, 'Spring Drive', 'pending']
      );
      let row = await dbGet('SELECT campaign_id, campaign_name FROM customers WHERE id = ?', [customer.lastID]);
      assert.equal(Number(row.campaign_id), Number(campaign.lastID));
      assert.equal(row.campaign_name, 'Spring Drive');

      await dbRun('UPDATE campaign_configs SET name = ? WHERE id = ?', ['Spring Drive Renamed', campaign.lastID]);
      row = await dbGet(
        `SELECT c.campaign_id, c.campaign_name, cc.name AS resolved_name
           FROM customers c LEFT JOIN campaign_configs cc ON cc.id = c.campaign_id
          WHERE c.id = ?`,
        [customer.lastID]
      );
      assert.equal(Number(row.campaign_id), Number(campaign.lastID));
      assert.equal(row.resolved_name, 'Spring Drive Renamed');
    });
  } finally {
    await closeDatabase();
  }
});
