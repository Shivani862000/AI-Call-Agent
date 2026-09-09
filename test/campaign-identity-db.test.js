'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withTestPatient } = require('./support/fixtures');

test('campaign identity survives a campaign rename and queue history remains attributable', async () => {
  const { initializeDatabase, dbRun, dbGet, closeDatabase } = require('../db');
  const { buildOwnerDashboardData } = require('../services/reporting');
  let campaignId;
  await initializeDatabase();
  try {
    await withTestPatient(async ({ patientId }) => {
      const campaign = await dbRun(
        'INSERT INTO campaign_configs (name, service_name, monthly_spend_inr, status) VALUES (?, ?, ?, ?)',
        ['Spring Drive', 'screening', 250, 'active']
      );
      campaignId = campaign.lastID;
      const customer = await dbRun(
        'INSERT INTO customers (patient_id, campaign_id, campaign_name, status, revenue_estimate) VALUES (?, ?, ?, ?, ?)',
        [patientId, campaign.lastID, 'Spring Drive', 'completed', 900]
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

      const call = await dbRun(
        `INSERT INTO calls (customer_id, patient_id, called_at, outcome)
         VALUES (?, ?, now(), 'completed')`,
        [customer.lastID, patientId]
      );
      row = await dbGet('SELECT campaign_id, campaign_name FROM calls WHERE id = ?', [call.lastID]);
      assert.equal(Number(row.campaign_id), Number(campaign.lastID));
      assert.equal(row.campaign_name, 'Spring Drive');

      const queue = await dbGet('SELECT campaign_id FROM customer_queue WHERE id = ?', [customer.lastID]);
      assert.equal(Number(queue.campaign_id), Number(campaign.lastID));

      const report = await buildOwnerDashboardData();
      const campaignReport = report.campaign_roi.find((item) => Number(item.campaign_id) === Number(campaign.lastID));
      assert.ok(campaignReport);
      assert.equal(campaignReport.campaign_name, 'Spring Drive Renamed');
      assert.equal(campaignReport.historical_campaign_name, 'Spring Drive');
      assert.equal(campaignReport.spend_inr, 250);
      assert.equal(campaignReport.revenue_pipeline, 900);
    });
  } finally {
    if (campaignId) await dbRun('DELETE FROM campaign_configs WHERE id = ?', [campaignId]);
    await closeDatabase();
  }
});
