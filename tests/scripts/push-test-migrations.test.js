const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const scriptPath = path.resolve(process.cwd(), 'scripts/push-test-migrations.js');

test('hosted migration push refuses to run without explicit test-project settings', () => {
  const env = { ...process.env };
  delete env.SUPABASE_TEST_DB_URL;
  delete env.SUPABASE_TEST_PROJECT_REF;
  delete env.SUPABASE_TEST_ALLOW_RESET;

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Hosted database tests require SUPABASE_TEST_DB_URL/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /postgresql:\/\//);
});
