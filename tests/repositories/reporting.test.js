const assert = require('node:assert/strict');
const test = require('node:test');
const { withTransaction } = require('../../persistence/postgres');
const { createRepositories } = require('../../repositories');
const { hasHostedTestDatabase, withTestDatabase } = require('../helpers/postgres-test-context');

const databaseTest = hasHostedTestDatabase() ? test : test.skip;

function databaseFacade(pool) {
  return {
    query: pool.query.bind(pool),
    transaction: (work) => withTransaction(pool, work)
  };
}

const RANGE = {
  start: '2026-08-20T00:00:00.000Z',
  end: '2026-08-20T23:59:59.999Z'
};

async function seedClient(repositories, slug) {
  return repositories.clients.create({ name: slug, slug, status: 'active' });
}

databaseTest('reporting builds exact tenant-scoped range fixtures', async () => {
  await withTestDatabase(async ({ pool }) => {
    const database = databaseFacade(pool);
    const repositories = createRepositories(database);
    const alpha = await seedClient(repositories, 'report-alpha');
    const beta = await seedClient(repositories, 'report-beta');
    const alphaCustomer = await repositories.customers.create(alpha.id, { name: 'Alpha Patient', phone: '+100000001' });
    const betaCustomer = await repositories.customers.create(beta.id, { name: 'Beta Patient', phone: '+100000001' });

    const alphaCalls = [];
    alphaCalls.push(await repositories.calls.create(alpha.id, {
      customer_id: alphaCustomer.id,
      called_at: '2026-08-20T09:15:00.000Z',
      outcome: 'hot_lead',
      whatsapp_sent: true,
      extracted_rating: 5,
      call_script_version: 'script-a',
      hot_lead_score: 80,
      recording_status: 'completed',
      transcript_status: 'completed',
      analysis_status: 'completed',
      objections: ['price', 'timing'],
      competitor_mentions: ['Competitor X']
    }));
    alphaCalls.push(await repositories.calls.create(alpha.id, {
      customer_id: alphaCustomer.id,
      called_at: '2026-08-20T09:45:00.000Z',
      outcome: 'no_answer',
      fallback_triggered: true,
      extracted_rating: 3,
      call_script_version: 'script-a',
      follow_up_task: 'Retry tomorrow',
      objections: ['price'],
      competitor_mentions: ['Competitor X', 'Competitor Y']
    }));
    alphaCalls.push(await repositories.calls.create(alpha.id, {
      customer_id: alphaCustomer.id,
      called_at: '2026-08-20T11:00:00.000Z',
      outcome: 'declined',
      extracted_rating: 2,
      call_script_version: 'script-b',
      recording_status: 'completed',
      transcript_status: 'completed',
      analysis_status: 'completed'
    }));
    await repositories.feedback.create(alpha.id, {
      customer_id: alphaCustomer.id,
      call_id: alphaCalls[0].id,
      review_text: 'Excellent and quick',
      category: 'good',
      stars: 5,
      submitted_at: '2026-08-20T10:00:00.000Z'
    });
    await repositories.feedback.create(alpha.id, {
      customer_id: alphaCustomer.id,
      call_id: alphaCalls[1].id,
      review_text: 'Average experience',
      category: 'average',
      stars: 3,
      submitted_at: '2026-08-20T10:30:00.000Z'
    });

    const betaCall = await repositories.calls.create(beta.id, {
      customer_id: betaCustomer.id,
      called_at: '2026-08-20T09:15:00.000Z',
      outcome: 'hot_lead',
      extracted_rating: 1,
      call_script_version: 'script-a',
      objections: ['price'],
      competitor_mentions: ['Competitor X']
    });
    await repositories.feedback.create(beta.id, {
      customer_id: betaCustomer.id,
      call_id: betaCall.id,
      category: 'bad',
      stars: 1,
      submitted_at: '2026-08-20T10:00:00.000Z'
    });

    const result = await repositories.reporting.buildRangeData(alpha.id, RANGE);
    assert.deepEqual(result.call_stats, {
      total_calls: 3,
      answered: 1,
      no_answer: 1,
      declined: 1,
      consent_given: 0,
      whatsapp_sent: 1,
      fallbacks_triggered: 1,
      hot_leads: 1
    });
    assert.deepEqual(result.feedback_stats, {
      feedback_count: 2,
      average_rating: 4,
      good_count: 1,
      average_count: 1,
      bad_count: 0
    });
    assert.equal(result.feedback[0].customer_name, 'Alpha Patient');
    assert.equal(result.analyzed_calls.length, 3);
    assert.equal(result.pending_items.length, 1);
    assert.equal(result.pending_items[0].follow_up_task, 'Retry tomorrow');
    assert.deepEqual(result.peak_slots[0], { slot: '09:00', total_calls: 2 });
    assert.deepEqual(result.script_performance, [
      { script_version: 'script-a', total_calls: 2, avg_rating: 4 },
      { script_version: 'script-b', total_calls: 1, avg_rating: 2 }
    ]);
    assert.deepEqual(result.analyzed_calls[0].objections_json, []);
    assert.deepEqual(result.analyzed_calls[1].objections_json, ['price']);
    assert.deepEqual(result.analyzed_calls[1].competitor_mentions_json, ['Competitor X', 'Competitor Y']);

    const { buildReportData } = require('../../services/reporting');
    const report = await buildReportData({
      repositories,
      clientId: alpha.id,
      publicBaseUrl: 'https://reports.example.test',
      ...RANGE,
      label: 'fixture day'
    });
    assert.equal(report.total_calls, 3);
    assert.equal(report.average_rating, 4);
    assert.equal(report.success_rate, 33.3);
    assert.deepEqual(report.common_objections, [
      { label: 'price', count: 2 },
      { label: 'timing', count: 1 }
    ]);
    assert.deepEqual(report.competitor_mentions, [
      { label: 'Competitor X', count: 2 },
      { label: 'Competitor Y', count: 1 }
    ]);
    assert.equal(report.revenue_pipeline_estimate, 800);
    assert.equal(report.analyzed_calls[0].recording_link, `https://reports.example.test/api/calls/${alphaCalls[2].id}/recording`);
  });
});

test('reporting rejects missing client context before issuing SQL', async () => {
  let queries = 0;
  const { createReportingRepository } = require('../../repositories/reporting');
  const repository = createReportingRepository({
    async query() {
      queries += 1;
      throw new Error('should not query');
    }
  });

  await assert.rejects(repository.buildRangeData(null, RANGE), /clientId is required/);
  assert.equal(queries, 0);
});
