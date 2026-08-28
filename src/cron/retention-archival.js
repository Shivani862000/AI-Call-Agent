'use strict';

const cron = require('node-cron');
const { getGlobalRuntimeSettings } = require('../webmaster/settings-service');
const logger = require('../../services/system-logger');
const { supabase } = require('../supabase');

const TARGETS = Object.freeze([
  ['customers', 'customers', 'created_at'],
  ['calls', 'calls', 'started_at'],
  ['feedback', 'feedback', 'created_at']
]);

function createRetentionArchiver({ targets = TARGETS, settingsProvider = getGlobalRuntimeSettings, log = logger } = {}) {
  return async function archiveExpiredRecords(now = new Date()) {
    const settings = await settingsProvider();
    const results = {};
    for (const [key, table, dateField] of targets) {
      const days = Number(settings.retention?.[key]?.archiveAfterDays);
      if (!Number.isInteger(days) || days < 1) continue;
      
      const threshold = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      try {
        const { data, error } = await supabase
          .from(table)
          .update({ status: 'archived', updated_at: now.toISOString() })
          .lt(dateField, threshold.toISOString())
          .neq('status', 'archived')
          .select('id');
          
        if (error) throw error;
        results[key] = (data || []).length;
      } catch (err) {
        log.error(`Archival failed for ${key}`, { error: err.message });
      }
    }
    return results;
  };
}

function scheduleRetentionArchival() {
  const archiver = createRetentionArchiver();
  return cron.schedule('0 2 * * *', async () => {
    try {
      await archiver();
    } catch (err) {
      logger.error('Retention archival job failed', { error: err.message });
    }
  });
}

module.exports = {
  createRetentionArchiver,
  scheduleRetentionArchival
};
