'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRetentionArchiver } = require('../src/cron/retention-archival');

test('retention archives with per-model dates and preserves workflow status for restore', async () => {
  const writes = [];
  const model = name => ({ async updateMany(filter, update) { writes.push({ name, filter, update }); return { modifiedCount: 1 }; } });
  const archive = createRetentionArchiver({
    targets: [['customers', model('customers'), 'created_at'], ['calls', model('calls'), 'started_at'], ['feedback', model('feedback'), 'created_at']],
    settingsProvider: async () => ({ retention: { customers: { archiveAfterDays: 30 }, calls: { archiveAfterDays: 60 }, feedback: { archiveAfterDays: 90 } } }),
    log: { info() {} }
  });
  const result = await archive(new Date('2026-08-25T00:00:00Z'));
  assert.deepEqual(result, { customers: 1, calls: 1, feedback: 1 });
  assert.ok(writes[1].filter.started_at.$lt instanceof Date);
  for (const write of writes) assert.deepEqual(write.update[0].$set.pre_archive_status, { $ifNull: ['$pre_archive_status', '$status'] });
});
