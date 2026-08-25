'use strict';

const cron = require('node-cron');
const Customer = require('../models/Customer');
const Call = require('../models/Call');
const Feedback = require('../models/Feedback');
const { getGlobalRuntimeSettings } = require('../webmaster/settings-service');
const { archiveUpdate } = require('../webmaster/lifecycle');
const logger = require('../../services/system-logger');

const TARGETS = Object.freeze([
  ['customers', Customer, 'created_at'],
  ['calls', Call, 'started_at'],
  ['feedback', Feedback, 'created_at']
]);

function createRetentionArchiver({ targets = TARGETS, settingsProvider = getGlobalRuntimeSettings, log = logger } = {}) {
  return async function archiveExpiredRecords(now = new Date()) {
    const settings = await settingsProvider();
    const results = {};
    for (const [key, Model, dateField] of targets) {
      const days = Number(settings.retention?.[key]?.archiveAfterDays);
      if (!Number.isInteger(days) || days < 1) continue;
      const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      const result = await Model.updateMany(
        { status: { $ne: 'archived' }, [dateField]: { $lt: cutoff } },
        archiveUpdate({ status: 'archived', archived_at: now, archived_by: 'retention-policy', archive_reason: `Configured ${days}-day retention policy` }),
        { runValidators: true }
      );
      results[key] = Number(result.modifiedCount || 0);
    }
    log.info('RETENTION_ARCHIVAL_COMPLETE', results);
    return results;
  };
}

const archiveExpiredRecords = createRetentionArchiver();

function scheduleRetentionArchival() { return cron.schedule('15 2 * * *', () => archiveExpiredRecords().catch(() => logger.error('RETENTION_ARCHIVAL_FAILED', { code: 'RETENTION_ARCHIVAL_FAILED' }))); }

module.exports = { archiveExpiredRecords, createRetentionArchiver, scheduleRetentionArchival };
