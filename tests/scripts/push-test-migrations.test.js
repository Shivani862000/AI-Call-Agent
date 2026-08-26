const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const scriptPath = path.resolve(process.cwd(), 'scripts/push-test-migrations.js');

test('hosted migration push refuses to run without explicit test-project settings', () => {
  const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supabase-migration-guard-'));
  const env = { ...process.env };
  delete env.SUPABASE_TEST_DB_URL;
  delete env.SUPABASE_TEST_PROJECT_REF;
  delete env.SUPABASE_TEST_ALLOW_RESET;

  let result;
  try {
    result = spawnSync(process.execPath, [scriptPath], {
      cwd: emptyCwd,
      env,
      encoding: 'utf8'
    });
  } finally {
    fs.rmSync(emptyCwd, { recursive: true, force: true });
  }

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Hosted database tests require SUPABASE_TEST_DB_URL/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /postgresql:\/\//);
});
