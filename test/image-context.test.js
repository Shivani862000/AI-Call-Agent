'use strict';

// Docker is invoked only by the explicit packaging group, never the unit group.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('Docker excludes synthetic secrets from every layer; removing exclusions exposes them', () => {
  assert.equal(process.env.AI_CALL_AGENT_CONTEXT_TEST, '1', 'use npm run test:packaging');
  const context = docker(['context', 'show']).trim();
  assert.ok(['default', 'desktop-linux'].includes(context));
  assert.ok(!process.env.DOCKER_HOST || process.env.DOCKER_HOST.startsWith('unix://'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-call-agent-context-'));
  const runId = crypto.randomUUID();
  const images = [];
  const excluded = [
    '.env', '.env.production', 'src/.env', 'src/nested/.env.local',
    'gmail-key.json', 'src/gmail-key.json', 'src/test-service-account.json',
    'src/test_service_account.json', 'src/test.iam.gserviceaccount.com.json',
    'client_secret_dummy.json', 'src/client-secret-dummy.json', 'src/oauth-client.json',
    'src/private.pem', 'src/private.key', 'src/private.p12', 'src/private.pfx',
    'src/id_rsa', 'src/id_ed25519', 'feedback.db.archived-20260830',
    'src/feedback.db.archived-20260830', 'src/cache.sqlite3', 'src/cache.db.backup-1',
    'src/data.bak', 'src/data.backup', 'src/archive.tar.gz', 'src/archive.zip',
    'src/backups/dump.sql', 'src/archives/dump.sql', 'src/private.sql',
    '.superpowers/sdd/secret.md', '.codex/state.json', 'scratch/note.md',
    'test/secret.js', 'claude-docs/review.md', 'src/runtime.log',
    'utils/.env', 'utils/private.key', 'utils/data.db.archived-20260830',
    'supabase/migrations/client_secret_dummy.sql', 'supabase/migrations/feedback.db.archived-20260830.sql'
  ];
  const tokens = excluded.map((name, index) => ({ name, token: `SYNTHETIC_${runId}_${index}_DO_NOT_SHIP` }));
  try {
    const fixture = path.join(root, 'fixture');
    fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
    for (const { name, token } of tokens) {
      fs.mkdirSync(path.dirname(path.join(fixture, name)), { recursive: true });
      fs.writeFileSync(path.join(fixture, name), token);
    }
    fs.writeFileSync(path.join(fixture, 'src/keep.js'), 'RUNTIME_ASSET_CONTROL');
    fs.writeFileSync(path.join(fixture, 'utils/greeting.js'), 'UTILS_ASSET_CONTROL');
    fs.writeFileSync(path.join(fixture, 'supabase/migrations/0019_fixture.sql'), 'MIGRATION_ASSET_CONTROL');
    fs.writeFileSync(path.join(fixture, 'Dockerfile'), 'FROM scratch\nCOPY . /fixture/\nCOPY src/keep.js /keep.js\n');
    for (const safe of [true, false]) {
      fs.writeFileSync(path.join(fixture, '.dockerignore'), safe
        ? fs.readFileSync(path.join(__dirname, '../.dockerignore')) : '');
      const tag = `ai-call-agent-context:${runId}-${safe ? 'safe' : 'control'}`;
      images.push(tag);
      docker(['build', '--platform=linux/amd64', '--network=none', '--no-cache', '-t', tag, fixture]);
      const saved = path.join(root, safe ? 'safe' : 'control');
      fs.mkdirSync(saved);
      const archive = path.join(saved, 'image.tar');
      docker(['image', 'save', '--output', archive, tag]);
      execFileSync('tar', ['-xf', archive, '-C', saved]);
      const manifest = JSON.parse(fs.readFileSync(path.join(saved, 'manifest.json')));
      const layers = manifest.flatMap((entry) => entry.Layers).map((layer) => {
        const bytes = fs.readFileSync(path.join(saved, layer));
        return bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes) : bytes;
      });
      assert.ok(layers.length >= 2, 'inspect all layers, not a flattened filesystem');
      assert.ok(layers.some((layer) => layer.includes('RUNTIME_ASSET_CONTROL')));
      assert.ok(layers.some((layer) => layer.includes('UTILS_ASSET_CONTROL')));
      assert.ok(layers.some((layer) => layer.includes('MIGRATION_ASSET_CONTROL')));
      for (const { name, token } of tokens) {
        assert.equal(layers.some((layer) => layer.includes(token)), !safe,
          `${safe ? 'excluded' : 'positive control'} sentinel: ${name}`);
      }
      console.log(`Context ${safe ? 'safe' : 'positive control'}: ${tokens.length} sentinels, ${layers.length} layers verified`);
    }
  } finally {
    const failures = [];
    for (const tag of images) {
      try { docker(['image', 'rm', '-f', tag]); } catch (error) { failures.push(error.message); }
    }
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(failures, [], 'owned fixture images must be removed');
  }
});
