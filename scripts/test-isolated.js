#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const UNIT_FILES = [
  'test/storage-boundaries.test.js', 'test/recording-boundaries.test.js', 'test/recording-fetch.test.js',
  'test/agent-prompt-override.test.js', 'test/app-settings.test.js',
  'test/audio-drain.test.js', 'test/auth-security.test.js',
  'test/auth-session-state.test.js', 'test/authorization-routes.test.js',
  'test/auto-queue-settings.test.js', 'test/boolean-flag.test.js',
  'test/call-analysis-prompts.test.js', 'test/call-capability.test.js',
  'test/call-flow-regressions.test.js', 'test/call-hours.test.js',
  'test/call-response-privacy.test.js', 'test/call-scripts-setting.test.js',
  'test/call-sentiment.test.js', 'test/closing-flow.test.js',
  'test/config-database-url.test.js', 'test/config-redaction.test.js',
  'test/config.test.js', 'test/csp-http-deployment.test.js',
  'test/call-events.test.js',
  'test/contact-policy.test.js',
  'test/customer-phone-lookup.test.js', 'test/database-isolation.test.js',
  'test/dependency-compatibility.test.js',
  'test/deepgram-transcript.test.js', 'test/digest.test.js',
  'test/followup-call-script.test.js', 'test/gmail-transport.test.js',
  'test/health-endpoint.test.js', 'test/icallmate-config.test.js',
  'test/icallmate-log-privacy.test.js',
  'test/icallmate-preflight.test.js', 'test/icallmate-protocol.test.js',
  'test/icallmate-webhook.test.js', 'test/inbound-disabled.test.js',
  'test/legacy-callback-auth.test.js', 'test/log-sink.test.js',
  'test/mailer-config.test.js', 'test/media-auth.test.js',
  'test/media-bridge-auth.test.js', 'test/no-dropped-column-writes.test.js',
  'test/no-sqlite-sql.test.js', 'test/patient-import.test.js',
  'test/outbound-admission.test.js',
  'test/patient-rules.test.js', 'test/queue-rules.test.js',
  'test/post-call-jobs.test.js',
  'test/review-call-script.test.js', 'test/slack-alerts.test.js',
  'test/sql-compat.test.js', 'test/supabase-storage-config.test.js',
  'test/support-ticket.test.js', 'test/support-widget.test.js',
  'test/system-logger.test.js', 'test/user-rules.test.js'
];
const DB_FILES = [
  'test/daily-call-limit.test.js', 'test/fixture-cleanup.test.js',
  'test/outbound-admission-db.test.js', 'test/outbound-context.test.js', 'test/patient-import-route.test.js', 'test/retention.test.js', 'test/role-isolation.test.js',
  'test/post-call-jobs-db.test.js',
  'test/feedback-patient-ownership-db.test.js',
  'test/reporting-db.test.js',
  'test/schema-triggers.test.js', 'test/schedule-edit.test.js'
];
const PACKAGING_FILES = ['test/image-context.test.js'];
const RUNTIME_FILES = ['test/production-runtime.test.js'];
const STAGED_FILES = ['package.json', 'package-lock.json', 'index.js', 'db.js'];
const STAGED_DIRECTORIES = ['prompts', 'public', 'routes', 'scripts', 'services', 'src', 'utils', 'supabase', 'test'];

function assertSafeStageEntry(sourceRoot, sourcePath) {
  const relative = path.relative(sourceRoot, sourcePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('staging path escaped source root');
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) throw new Error(`staging rejects symlink: ${relative}`);
  const name = path.basename(sourcePath).toLowerCase();
  if (name.startsWith('.env')
      || /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|backups?|archives?)(?:[._-]|$)/i.test(name)
      || /(?:credential|service[-_]account|oauth|client[-_]secret|gmail[-_]key)/i.test(name)
      || /\.(?:pem|key|p12|pfx|db|sqlite|sqlite3|bak|backup|archive|archived|zip|tgz|tar|gz)$/i.test(name)
      || /\.(?:db|sqlite|sqlite3)[._-](?:archive|archived|backup|bak)(?:[._-]|$)/i.test(name)) {
    throw new Error(`staging rejects sensitive/archive path: ${relative}`);
  }
  return stat;
}

function copyTreeChecked(sourceRoot, sourcePath, targetPath) {
  const stat = assertSafeStageEntry(sourceRoot, sourcePath);
  if (stat.isDirectory()) {
    fs.mkdirSync(targetPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyTreeChecked(sourceRoot, path.join(sourcePath, entry), path.join(targetPath, entry));
    }
  } else if (stat.isFile()) {
    fs.copyFileSync(sourcePath, targetPath);
  } else {
    throw new Error(`staging rejects non-file entry: ${path.relative(sourceRoot, sourcePath)}`);
  }
}

function stageAllowedSource(sourceRoot, targetRoot, files = STAGED_FILES, directories = STAGED_DIRECTORIES) {
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const file of files) copyTreeChecked(sourceRoot, path.join(sourceRoot, file), path.join(targetRoot, file));
  for (const directory of directories) {
    copyTreeChecked(sourceRoot, path.join(sourceRoot, directory), path.join(targetRoot, directory));
  }
}

// Existing unit coverage reads one flag from the tracked UAT example. Project
// only a strict boolean assignment; never copy an environment file payload.
function stageUatTemplateFlag(sourceRoot, targetRoot) {
  const source = path.join(sourceRoot, '.env.uat.example');
  if (!fs.lstatSync(source).isFile()) throw new Error('UAT template must be a regular file');
  const flags = fs.readFileSync(source, 'utf8').split(/\r?\n/)
    .filter((line) => /^DISABLE_INBOUND_CALLS=(?:true|false)$/.test(line));
  fs.writeFileSync(path.join(targetRoot, '.env.uat.example'), flags.map((line) => `${line}\n`).join(''));
}

function auditManifest() {
  const discovered = fs.readdirSync(path.join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.js')).map((name) => `test/${name}`).sort();
  const classified = [...UNIT_FILES, ...DB_FILES, ...PACKAGING_FILES, ...RUNTIME_FILES].sort();
  if (!discovered.length || JSON.stringify(discovered) !== JSON.stringify(classified)) {
    const missing = discovered.filter((file) => !classified.includes(file));
    const stale = classified.filter((file) => !discovered.includes(file));
    throw new Error(`test manifest mismatch; unclassified=${missing.join(',') || '(none)'} stale=${stale.join(',') || '(none)'}`);
  }
}

function minimalEnvironment(extra = {}) {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    NODE_ENV: 'test', TZ: 'UTC', CI: process.env.CI || '',
    DISABLE_INBOUND_CALLS: 'true', DISABLE_SCHEDULER: 'true',
    DISABLE_OWNER_DIGEST: 'true',
    NODE_OPTIONS: `--require=${path.join(ROOT, 'test/support/provider-fakes.js')}`,
    ...extra
  };
}

function runNodeTests(files, env) {
  if (!files.length) throw new Error('zero required tests selected');
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], {
    cwd: ROOT, env, stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`test process exited ${result.status}`);
}

function runUnit(requestedFile) {
  auditManifest();
  const selected = requestedFile ? [requestedFile] : UNIT_FILES;
  for (const file of selected) {
    if (!UNIT_FILES.includes(file)) throw new Error(`--file is not an audited unit test: ${file}`);
  }
  runNodeTests(selected, minimalEnvironment());
}

function dockerJson(args) {
  return JSON.parse(execFileSync('docker', args, { encoding: 'utf8' }));
}

async function runDatabase(requestedFile, { runtime = false, full = false } = {}) {
  auditManifest();
  const selected = requestedFile ? [requestedFile] : DB_FILES;
  for (const file of selected) {
    if (!DB_FILES.includes(file)) throw new Error(`--file is not an audited database test: ${file}`);
  }
  const context = execFileSync('docker', ['context', 'show'], { encoding: 'utf8' }).trim();
  if (!['default', 'desktop-linux'].includes(context)) throw new Error(`unsupported Docker context: ${context}`);
  if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://')) {
    throw new Error('remote DOCKER_HOST is unsupported');
  }

  const { PostgreSqlContainer } = require('@testcontainers/postgresql');
  const {
    GenericContainer, StartedNetwork, Wait, getContainerRuntimeClient,
    getReaper, LABEL_TESTCONTAINERS_SESSION_ID
  } = require('testcontainers');
  class InternalPostgres extends PostgreSqlContainer {
    constructor(image) {
      super(image);
      this.exposedPorts = [];
      this.createOpts.ExposedPorts = {};
      this.hostConfig.PortBindings = {};
      this.withWaitStrategy(Wait.forHealthCheck());
    }
  }

  const runId = crypto.randomUUID();
  const resourceName = `ai-call-agent-test-${runId}`;
  const identityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-call-agent-test-'));
  let network;
  let container;
  let runner;
  let production;
  let stageDir;
  let interrupted = false;
  let cleanupPromise;
  let releasePreassignment;
  let barrierKeepAlive;
  const interruptionGate = new Promise((resolve) => {
    releasePreassignment = () => {
      clearInterval(barrierKeepAlive);
      resolve();
    };
  });
  const cleanup = async ({ fresh = false } = {}) => {
    if (fresh && cleanupPromise) {
      try { await cleanupPromise; } catch {}
      cleanupPromise = undefined;
    }
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const failures = [];
      const attempt = async (label, action) => {
        let timer;
        let cleaned = true;
        try {
          await Promise.race([
            action(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('timed out')), 10_000);
            })
          ]);
        } catch (error) {
          if (!/no such (?:container|network)|already (?:stopped|removed)/i.test(error.message)) {
            failures.push(`${label}: ${error.message}`);
            cleaned = false;
          }
        } finally { clearTimeout(timer); }
        return cleaned;
      };
      if (production) {
        const owned = production;
        if (await attempt('production image cleanup', () => owned.stop()) && production === owned) production = undefined;
      }
      if (runner) {
        const owned = runner;
        if (await attempt('test runner cleanup', () => owned.stop()) && runner === owned) runner = undefined;
      }
      if (container) {
        const owned = container;
        if (await attempt('PostgreSQL cleanup', () => owned.stop()) && container === owned) container = undefined;
      }
      if (network) {
        const owned = network;
        if (await attempt('network cleanup', () => owned.stop()) && network === owned) network = undefined;
      }
      try { fs.rmSync(identityDir, { recursive: true, force: true }); }
      catch (error) { failures.push(`identity cleanup: ${error.message}`); }
      if (stageDir) {
        try { fs.rmSync(stageDir, { recursive: true, force: true }); }
        catch (error) { failures.push(`staging cleanup: ${error.message}`); }
      }
      if (process.env.AI_CALL_AGENT_TEST_RESOURCE_FILE) {
        try {
          fs.writeFileSync(process.env.AI_CALL_AGENT_TEST_RESOURCE_FILE,
            JSON.stringify({ resourceName, cleaned: failures.length === 0, failures }));
        } catch (error) { failures.push(`cleanup evidence: ${error.message}`); }
      }
      if (failures.length) throw new Error(`isolated test cleanup failed: ${failures.join('; ')}`);
    })();
    return cleanupPromise;
  };
  const markInterrupted = (signal) => {
    interrupted = true;
    releasePreassignment();
    console.error(`Received ${signal}; stopping isolated test resources`);
    void cleanup().catch((error) => console.error(error.message));
  };
  process.once('SIGINT', markInterrupted);
  process.once('SIGTERM', markInterrupted);
  try {
    const stopIfInterrupted = () => {
      if (interrupted) throw new Error('test run interrupted');
    };
    const assignOwned = async (kind, creation, wrap, assign) => {
      const owned = wrap(await creation);
      if (process.env.AI_CALL_AGENT_TEST_PREASSIGN_BARRIER === kind) {
        const barrierFile = process.env.AI_CALL_AGENT_TEST_BARRIER_FILE;
        if (!barrierFile) throw new Error('pre-assignment barrier file is required');
        barrierKeepAlive = setInterval(() => {}, 1_000);
        fs.writeFileSync(barrierFile, JSON.stringify({ resourceName, kind, ready: true }));
        await interruptionGate;
      }
      assign(owned);
      stopIfInterrupted();
      return owned;
    };
    const client = await getContainerRuntimeClient();
    const reaper = await getReaper(client);
    await assignOwned('network', client.network.create({
      Name: resourceName, CheckDuplicate: true, Driver: 'bridge', Internal: true,
      Attachable: false, Ingress: false, EnableIPv6: false,
      Labels: {
        'ai.call-agent.test-run': runId,
        [LABEL_TESTCONTAINERS_SESSION_ID]: reaper.sessionId
      }
    }), (raw) => new StartedNetwork(client, resourceName, raw), (owned) => { network = owned; });
    stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-call-agent-stage-'));
    stageAllowedSource(ROOT, stageDir);
    stageUatTemplateFlag(ROOT, stageDir);
    fs.writeFileSync(path.join(stageDir, 'Dockerfile.test'), [
      'FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e', 'WORKDIR /app',
      'COPY package.json package-lock.json ./', 'RUN npm ci --ignore-scripts',
      'COPY db.js index.js .env.uat.example ./', 'COPY prompts ./prompts', 'COPY public ./public', 'COPY routes ./routes',
      'COPY scripts ./scripts', 'COPY services ./services', 'COPY src ./src', 'COPY supabase ./supabase',
      'COPY utils ./utils', 'COPY test ./test', 'CMD ["tail", "-f", "/dev/null"]', ''
    ].join('\n'));
    const runnerImage = await GenericContainer.fromDockerfile(stageDir, 'Dockerfile.test')
      .withCache(false).build(`ai-call-agent-test-runner:${runId}`, { deleteOnExit: true });
    stopIfInterrupted();

    const password = crypto.randomBytes(24).toString('hex');
    const database = `test_${runId.replaceAll('-', '')}`;
    const user = `runner_${runId.replaceAll('-', '_')}`;
    await assignOwned('postgres', new InternalPostgres('postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3')
      .withName(resourceName).withNetworkMode(resourceName)
      .withDatabase(database).withUsername(user).withPassword(password).start(),
    (owned) => owned, (owned) => { container = owned; });

    const ports = dockerJson(['inspect', container.getId(), '--format', '{{json .NetworkSettings.Ports}}']);
    const inspectedNetwork = dockerJson(['network', 'inspect', network.getId()])[0];
    if (ports['5432/tcp']?.length) throw new Error('PostgreSQL unexpectedly publishes a host port');
    if (!inspectedNetwork.Internal) throw new Error('PostgreSQL network is not internal');

    const roleSuffix = runId.replaceAll('-', '_');
    const roles = {
      application: { name: `app_${roleSuffix}`, password: crypto.randomBytes(24).toString('hex') },
      anon: { name: `anon_${roleSuffix}`, password: crypto.randomBytes(24).toString('hex') },
      authenticated: { name: `auth_${roleSuffix}`, password: crypto.randomBytes(24).toString('hex') }
    };
    const makeIdentity = (purpose, role) => {
      const connectionString = `postgres://${encodeURIComponent(role.name)}:${encodeURIComponent(role.password)}@${resourceName}:5432/${database}`;
      const url = new URL(connectionString);
      return {
        runId, purpose, containerId: container.getId(), networkId: network.getId(),
        connectionString, host: url.hostname, port: Number(url.port), database,
        user: role.name, transport: 'docker-internal', internalNetwork: true
      };
    };
    const identities = {
      owner: makeIdentity('migration-owner', { name: user, password }),
      application: makeIdentity('application', roles.application),
      anon: makeIdentity('anon', roles.anon),
      authenticated: makeIdentity('authenticated', roles.authenticated)
    };
    for (const [purpose, identity] of Object.entries(identities)) {
      fs.writeFileSync(path.join(identityDir, `${purpose}.json`), JSON.stringify(identity), {
        mode: 0o600, flag: 'wx'
      });
    }
    const ownerEnv = minimalEnvironment({
      DATABASE_URL: identities.owner.connectionString, AI_CALL_AGENT_TEST_RUN_ID: runId,
      AI_CALL_AGENT_TEST_DB_IDENTITY: '/run/owner.json', NODE_OPTIONS: '',
      AI_CALL_AGENT_TEST_ROLES: JSON.stringify(roles)
    });
    const env = minimalEnvironment({
      DATABASE_URL: identities.application.connectionString, AI_CALL_AGENT_TEST_RUN_ID: runId,
      AI_CALL_AGENT_TEST_DB_IDENTITY: '/run/application.json', NODE_OPTIONS: '',
      AI_CALL_AGENT_TEST_OWNER_URL: identities.owner.connectionString,
      AI_CALL_AGENT_TEST_OWNER_IDENTITY: '/run/owner.json',
      AI_CALL_AGENT_TEST_ANON_URL: identities.anon.connectionString,
      AI_CALL_AGENT_TEST_ANON_IDENTITY: '/run/anon.json',
      AI_CALL_AGENT_TEST_AUTHENTICATED_URL: identities.authenticated.connectionString,
      AI_CALL_AGENT_TEST_AUTHENTICATED_IDENTITY: '/run/authenticated.json'
    });
    await assignOwned('runner', runnerImage.withName(`${resourceName}-runner`).withNetworkMode(resourceName)
      .withEnvironment(env)
      .withCopyContentToContainer(Object.entries(identities).map(([purpose, identity]) => ({
        content: JSON.stringify(identity), target: `/run/${purpose}.json`, mode: 0o600
      })))
      .start(), (owned) => owned, (owned) => { runner = owned; });
    if (process.env.AI_CALL_AGENT_TEST_RESOURCE_FILE) {
      fs.writeFileSync(process.env.AI_CALL_AGENT_TEST_RESOURCE_FILE,
        JSON.stringify({ resourceName, cleaned: false }));
    }
    const runnerInspect = dockerJson(['inspect', runner.getId(), '--format', '{{json .NetworkSettings.Networks}}']);
    if (!runnerInspect[resourceName]) throw new Error('test runner is not attached to owned internal network');
    if (process.env.AI_CALL_AGENT_TEST_INJECT_FAILURE === 'migration') {
      throw new Error('injected outer migration failure');
    }
    const holdMs = Number(process.env.AI_CALL_AGENT_TEST_HOLD_MS || 0);
    if (holdMs > 0) {
      const held = await runner.exec(['node', '-e', `setTimeout(() => {}, ${Math.min(holdMs, 60_000)})`]);
      if (!interrupted && held.exitCode !== 0) throw new Error(`held workload exited ${held.exitCode}`);
      if (interrupted) throw new Error('test run interrupted');
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const migrated = await runner.exec(['node', 'scripts/test-migrate.js'], { workingDir: '/app', env: ownerEnv });
      process.stdout.write(migrated.output);
      if (migrated.exitCode !== 0) throw new Error(`test migration attempt ${attempt} exited ${migrated.exitCode}`);
    }
    const provisioned = await runner.exec(['node', 'scripts/test-roles.js'], {
      workingDir: '/app', env: ownerEnv
    });
    process.stdout.write(provisioned.output);
    if (provisioned.exitCode !== 0) throw new Error(`test role provisioning exited ${provisioned.exitCode}`);
    if (!runtime || full) {
      const tested = await runner.exec(
        ['node', '--test', '--test-reporter=spec', ...selected], { workingDir: '/app', env }
      );
      process.stdout.write(tested.output);
      if (tested.exitCode !== 0) throw new Error(`database test process exited ${tested.exitCode}`);
    }
    if (full) {
      const version = await runner.exec(['node', '-p', 'process.version']);
      if (version.exitCode !== 0 || !/^v24\./.test(version.output.trim())) throw new Error('unit runner must use Node24');
      console.log(`Audited unit runner: ${version.output.trim()}`);
      const unit = await runner.exec(['node', 'scripts/test-isolated.js', 'unit'], {
        workingDir: '/app', env: { NODE_ENV: 'test', NODE_OPTIONS: '', DATABASE_URL: '' }
      });
      process.stdout.write(unit.output);
      if (unit.exitCode !== 0) throw new Error(`Node24 unit process exited ${unit.exitCode}`);
    }
    if (runtime) {
      const productionStage = path.join(stageDir, 'production-context');
      stageAllowedSource(ROOT, productionStage,
        ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'index.js', 'db.js'],
        ['prompts', 'public', 'routes', 'scripts', 'services', 'src', 'utils', 'supabase']);
      const productionTag = `ai-call-agent-production-test:${runId}`;
      const productionImage = await GenericContainer.fromDockerfile(productionStage)
        .withBuildkit().withPlatform('linux/amd64').build(productionTag, { deleteOnExit: true });
      stopIfInterrupted();
      const imageInfo = dockerJson(['image', 'inspect', productionTag])[0];
      if (imageInfo.Architecture !== 'amd64' || imageInfo.Os !== 'linux') throw new Error('production target must be linux/amd64');
      console.log(`Production build identity: ${imageInfo.Id}; target ${imageInfo.Os}/${imageInfo.Architecture}`);
      console.log(`Docker host: ${execFileSync('docker', ['info', '--format', '{{.OSType}}/{{.Architecture}}'], { encoding: 'utf8' }).trim()}; non-amd64 hosts use emulation`);
      const adminPassword = crypto.randomBytes(24).toString('hex');
      const seeded = await runner.exec(['node', 'test/support/runtime-seed.js'], {
        workingDir: '/app', env: { ...env, RUNTIME_ADMIN_PASSWORD: adminPassword }
      });
      process.stdout.write(seeded.output);
      if (seeded.exitCode !== 0) throw new Error('runtime administrator seeding failed');
      const productionEnv = {
        NODE_ENV: 'production', DATABASE_URL: identities.application.connectionString,
        AI_CALL_AGENT_TEST_RUN_ID: runId, AI_CALL_AGENT_TEST_DB_IDENTITY: '/run/application.json',
        RUNTIME_ADMIN_PASSWORD: adminPassword, AI_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'synthetic-gemini', DEEPGRAM_API_KEY: 'synthetic-deepgram',
        AUTH_SIGNING_SECRET: crypto.randomBytes(32).toString('hex'),
        ICALLMATE_WEBHOOK_SECRET: crypto.randomBytes(32).toString('hex'),
        ICALLMATE_MEDIA_SHARED_SECRET: crypto.randomBytes(32).toString('hex'),
        APP_BASE_URL: 'http://127.0.0.1:3000', CLIENT_NAME: 'Synthetic runtime lab',
        DISABLE_SCHEDULER: 'true', DISABLE_OWNER_DIGEST: 'true', DISABLE_INBOUND_CALLS: 'true',
        NODE_OPTIONS: '--require=/app/test/support/runtime-provider-fakes.js'
      };
      let startupOutput = '';
      try {
        await assignOwned('production', productionImage.withPlatform('linux/amd64')
          .withName(`${resourceName}-production`).withNetworkMode(resourceName)
          .withEnvironment(productionEnv)
          .withLogConsumer((stream) => stream.on('data', (chunk) => { startupOutput = (startupOutput + chunk).slice(-8000); }))
          .withCopyDirectoriesToContainer([{ source: path.join(stageDir, 'test'), target: '/app/test' }])
          .withCopyContentToContainer([{ content: JSON.stringify(identities.application), target: '/run/application.json', mode: 0o600 }])
          .withWaitStrategy(Wait.forLogMessage('[SERVER] Running on port 3000 (0.0.0.0)'))
          .withStartupTimeout(120_000).start(), (owned) => owned, (owned) => { production = owned; });
      } catch (error) {
        console.error(startupOutput);
        throw error;
      }
      const info = dockerJson(['inspect', production.getId()])[0];
      if (Object.keys(info.NetworkSettings.Networks).join() !== resourceName
          || Object.values(info.NetworkSettings.Ports).some((ports) => ports?.length)
          || info.Mounts.length) throw new Error('production workload isolation failed');
      const checked = await production.exec(['node', '--test', '--test-reporter=spec', ...RUNTIME_FILES], {
        workingDir: '/app', env: { NODE_OPTIONS: '' }
      });
      process.stdout.write(checked.output);
      if (checked.exitCode !== 0) throw new Error(`production runtime checks exited ${checked.exitCode}`);
    }
    if (interrupted) throw new Error('test run interrupted');
  } finally {
    process.removeListener('SIGINT', markInterrupted);
    process.removeListener('SIGTERM', markInterrupted);
    await cleanup({ fresh: true });
  }
}

function parseArgs(argv) {
  const mode = argv[0] || 'isolated';
  let file;
  if (argv[1] === '--file') file = argv[2];
  else if (argv[1]?.startsWith('--file=')) file = argv[1].slice(7);
  else if (argv.length > 1) throw new Error(`unknown arguments: ${argv.slice(1).join(' ')}`);
  return { mode, file };
}

async function main() {
  const { mode, file } = parseArgs(process.argv.slice(2));
  if (mode === 'unit') runUnit(file);
  else if (mode === 'db') await runDatabase(file);
  else if (mode === 'packaging') { auditManifest(); runNodeTests(PACKAGING_FILES, minimalEnvironment({ AI_CALL_AGENT_CONTEXT_TEST: '1', NODE_OPTIONS: '' })); }
  else if (mode === 'runtime') await runDatabase(file, { runtime: true });
  else if (mode === 'isolated') {
    auditManifest();
    runNodeTests(PACKAGING_FILES, minimalEnvironment({ AI_CALL_AGENT_CONTEXT_TEST: '1', NODE_OPTIONS: '' }));
    await runDatabase(file, { runtime: true, full: true });
  }
  else if (mode === 'browser') throw new Error('browser harness is unavailable until P17');
  else throw new Error(`unknown test group: ${mode}`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = {
  UNIT_FILES, DB_FILES, PACKAGING_FILES, RUNTIME_FILES, auditManifest, minimalEnvironment, parseArgs, stageAllowedSource, stageUatTemplateFlag
};
