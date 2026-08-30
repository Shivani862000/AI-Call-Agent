# Recordings and Audit Log to Supabase — Implementation Plan (2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Move the last two on-disk stores — call recordings and the audit log — into Supabase, then delete every persistent volume from the deployment.

**Architecture:** The audit log becomes a `system_logs` table written through a buffered, fire-and-forget writer, so `logger.info()` stays synchronous for callers and never injects network latency into a live call. Recordings upload to a private Supabase Storage bucket on a background task after the WebSocket closes, with the local file retained and a `pending_upload` marker if the upload fails. Only once both are done do the volumes come out.

**Tech Stack:** Node 22, `pg`, Supabase Storage REST API (no SDK — one `fetch` per upload), `node:test`.

**Spec:** `claude-docs/superpowers/specs/2026-08-30-supabase-migration-design.md`

**Supersedes:** the original plan-2 / plan-3 split. Combining them is correct because the volume removal in Task 6 is only valid once *both* stores have moved; splitting would leave a plan whose final task cannot be safely executed.

**Prerequisite:** Plan 1 complete (commit `0c39077`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/0002_system_logs.sql` | **New.** The `system_logs` table and its indexes. |
| `services/log-sink.js` | **New.** Buffered batch writer for `system_logs`. Owns the buffer, the flush timer, and the overflow policy. Nothing else knows the log is in a database. |
| `services/system-logger.js` | Swaps `appendFileSync` for the sink. Public API (`info`/`warn`/`error`/`debug`) and `sanitizeLogDetails` unchanged. |
| `src/api-routes.js` | `/api/logs` reads SQL instead of parsing a file. |
| `services/supabase-storage.js` | **New.** `upload`, `signedUrl`, `remove` against the Storage REST API. |
| `src/websocket-bridge.js` | Uploads the mixed WAV after the socket closes. |
| `services/post-call-pipeline.js` | Uploads the downloaded MP3; drops the hardcoded `/tmp` path. |
| `src/scheduler.js` | Retry sweep for recordings stuck at `pending_upload`. |
| `docker-compose.yml`, `docker-compose.prod.yml`, `k8s/*` | Volumes removed. |

---

## Task 1: The `system_logs` table

**Files:**
- Create: `supabase/migrations/0002_system_logs.sql`
- Modify: `db.js` (bump `EXPECTED_SCHEMA_VERSION`)

- [ ] **Step 1: Write the migration**

```sql
-- 0002_system_logs.sql
create table system_logs (
  id      bigint generated always as identity primary key,
  ts      timestamptz not null default now(),
  level   text not null,
  event   text not null,
  details jsonb
);

create index system_logs_ts_idx    on system_logs(ts desc);
create index system_logs_event_idx on system_logs(event);
create index system_logs_level_idx on system_logs(level) where level in ('WARN','ERROR');
```

The partial index on `level` exists because the only level filter the UI offers
is "errors"; a full index on a column with four values would not be used.

- [ ] **Step 2: Apply it to both projects**

```bash
node scripts/apply-migration.js 0002_system_logs.sql
NODE_ENV=production node scripts/apply-migration.js 0002_system_logs.sql
```

- [ ] **Step 3: Bump the expected version**

In `db.js`, change `EXPECTED_SCHEMA_VERSION` from `'0001'` to `'0002'`.

- [ ] **Step 4: Verify**

Boot the app. Expected: `✓ Schema version 0002 verified`.

---

## Task 2: The buffered log sink

The sink is the whole risk of this plan. `logger.info()` is called 8 times inside
`src/websocket-bridge.js` during a live call and is synchronous today. It must
stay synchronous for callers.

**Files:**
- Create: `services/log-sink.js`
- Test: `test/log-sink.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createLogSink } = require('../services/log-sink');

test('push returns immediately without awaiting a write', () => {
  const sink = createLogSink({ write: async () => { throw new Error('should not be awaited'); } });
  sink.push({ level: 'INFO', event: 'X', details: {} });   // must not throw
  assert.strictEqual(sink.pending(), 1);
});

test('flushes as one batch', async () => {
  const batches = [];
  const sink = createLogSink({ write: async (rows) => { batches.push(rows.length); } });
  for (let i = 0; i < 3; i += 1) sink.push({ level: 'INFO', event: `E${i}`, details: {} });
  await sink.flush();
  assert.deepStrictEqual(batches, [3]);
  assert.strictEqual(sink.pending(), 0);
});

test('flushes automatically once the batch size is reached', async () => {
  const batches = [];
  const sink = createLogSink({ maxBatch: 2, write: async (rows) => { batches.push(rows.length); } });
  sink.push({ level: 'INFO', event: 'A', details: {} });
  sink.push({ level: 'INFO', event: 'B', details: {} });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(batches, [2]);
});

test('drops the oldest rows rather than growing without bound', () => {
  const sink = createLogSink({ maxBuffer: 3, maxBatch: 999, write: async () => {} });
  for (let i = 0; i < 5; i += 1) sink.push({ level: 'INFO', event: `E${i}`, details: {} });
  assert.strictEqual(sink.pending(), 3);
  assert.strictEqual(sink.dropped(), 2);
});

test('a failing write never rejects into the caller', async () => {
  const sink = createLogSink({ write: async () => { throw new Error('supabase down'); } });
  sink.push({ level: 'ERROR', event: 'X', details: {} });
  await sink.flush();          // must resolve, not reject
  assert.strictEqual(sink.pending(), 0);
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
node --test test/log-sink.test.js
```

Expected: FAIL — `Cannot find module '../services/log-sink'`.

- [ ] **Step 3: Implement**

```javascript
'use strict';

/**
 * Buffered, fire-and-forget writer for system_logs.
 *
 * logger.info() is called during live calls and must never await a network
 * round-trip, so push() only appends to an in-memory buffer. Rows leave in
 * batches on a timer or when the batch size is reached. A failing write drops
 * its batch: losing log lines is strictly better than breaking a call or
 * growing memory without bound during an outage.
 */
function createLogSink({ write, maxBatch = 50, maxBuffer = 1000, intervalMs = 2000 } = {}) {
  let buffer = [];
  let droppedCount = 0;
  let timer = null;
  let flushing = false;

  async function flush() {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer;
    buffer = [];
    try {
      await write(batch);
    } catch (error) {
      console.error('[LOG SINK] dropped', batch.length, 'rows:', error.message);
    } finally {
      flushing = false;
    }
  }

  function push(row) {
    buffer.push(row);
    if (buffer.length > maxBuffer) {
      droppedCount += buffer.length - maxBuffer;
      buffer = buffer.slice(-maxBuffer);
    }
    if (buffer.length >= maxBatch) {
      setImmediate(() => { flush(); });
      return;
    }
    if (!timer) {
      timer = setTimeout(() => { timer = null; flush(); }, intervalMs);
      timer.unref?.();
    }
  }

  return {
    push,
    flush,
    pending: () => buffer.length,
    dropped: () => droppedCount,
    stop: () => { if (timer) { clearTimeout(timer); timer = null; } }
  };
}

module.exports = { createLogSink };
```

- [ ] **Step 4: Run and confirm pass**

```bash
node --test test/log-sink.test.js
```

Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add services/log-sink.js test/log-sink.test.js supabase/migrations/0002_system_logs.sql db.js
git commit -m "feat(logs): add system_logs table and a buffered sink"
```

---

## Task 3: Point the logger at the sink

**Files:**
- Modify: `services/system-logger.js`

- [ ] **Step 1: Replace the file writer**

Delete `rotateLogIfNeeded`, `writeLine`, `LOG_DIR`, `LOG_FILE`, `MAX_LOG_BYTES`,
`MAX_LOG_FILES` and the `fs` / `path` imports. Keep everything else — in
particular `sanitizeDetail` and `sanitizeLogDetails`, which are the redaction
this system depends on.

In `log()`, after the existing console output, replace `writeLine(line)` with:

```javascript
  getSink().push({
    level: normalizedLevel,
    event: normalizeEvent(event),
    details: sanitizeLogDetails(details)
  });
```

Add the lazy sink accessor above `log()`. It is lazy because `system-logger` is
required by modules that load before the database pool exists:

```javascript
let sink = null;

function getSink() {
  if (!sink) {
    const { createLogSink } = require('./log-sink');
    const { dbRun } = require('../db');
    sink = createLogSink({
      write: async (rows) => {
        const values = rows.map((_, i) =>
          `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(', ');
        const params = rows.flatMap((r) => [r.level, r.event, JSON.stringify(r.details || {})]);
        // Raw $n placeholders: this is built for pg directly, not translated.
        await dbRun(`INSERT INTO system_logs (level, event, details) VALUES ${values}`, params);
      }
    });
  }
  return sink;
}
```

Note the export list must drop `LOG_FILE` and gain `getSink` (for tests) — check
`src/api-routes.js` for the `logger.LOG_FILE` reference, which Task 4 removes.

- [ ] **Step 2: Verify the redaction still runs**

```bash
node --test test/system-logger.test.js
```

Expected: `# fail 0`. This test covers the phone masking and sensitive-field
dropping and must not have changed behaviour.

- [ ] **Step 3: Commit**

```bash
git add services/system-logger.js
git commit -m "feat(logs): write the audit log to Supabase instead of a file"
```

---

## Task 4: `/api/logs` reads SQL

**Files:**
- Modify: `src/api-routes.js:162`

- [ ] **Step 1: Replace the handler**

```javascript
  app.get('/api/logs', async (req, res) => {
    try {
      const filter = String(req.query.filter || 'all').toLowerCase();
      const max = Math.min(Math.max(Number(req.query.limit || 200), 1), 1000);

      // These mirror the regexes the file-based reader used.
      const clauses = {
        calls: "event LIKE 'CALL\\_%'",
        users: "event LIKE 'USER\\_%'",
        feedback: "event LIKE 'FEEDBACK\\_%'",
        errors: "level = 'ERROR'"
      };
      const where = clauses[filter] ? `WHERE ${clauses[filter]}` : '';

      const rows = await dbAll(
        `SELECT ts, level, event, details FROM system_logs ${where}
          ORDER BY ts DESC LIMIT ?`,
        [max]
      );

      // The UI renders plain strings, so keep the original line shape.
      const logs = rows.map((row) => {
        const detail = Object.entries(row.details || {})
          .map(([key, value]) => `${key}="${value}"`).join(' ');
        return `[${new Date(row.ts).toISOString()}] [${row.level}] [${row.event}] ${detail}`.trim();
      });

      res.json({ logs });
    } catch (error) {
      console.error('[LOG READ FAILED]', error.message);
      res.status(500).json({ error: 'Failed to read logs' });
    }
  });
```

Remove the now-unused `fs` import if nothing else in the file uses it.

- [ ] **Step 2: Verify end to end**

Boot, log in, then:

```bash
curl -s -b /tmp/pgck.txt 'localhost:3000/api/logs?filter=users&limit=5'
```

Expected: at least one `[USER_LOGIN]` line from the login you just performed.

- [ ] **Step 3: Commit**

```bash
git add src/api-routes.js
git commit -m "feat(logs): serve /api/logs from system_logs"
```

---

## Task 5: Recordings to Supabase Storage

**Blocked until `SUPABASE_SERVICE_ROLE_KEY` is configured.**

**Files:**
- Create: `services/supabase-storage.js`
- Test: `test/supabase-storage.test.js`
- Modify: `src/websocket-bridge.js:1505-1540`, `services/post-call-pipeline.js:16-36`, `src/scheduler.js`

- [ ] **Step 1: Config**

Add to `src/config.js`, next to `resolveDatabaseUrl`:

```javascript
/** Service-role key for the current environment. Server-side only. */
function resolveServiceRoleKey(env = process.env) {
  const isProduction = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const key = isProduction ? 'SUPABASE_SERVICE_ROLE_KEY' : 'SUPABASE_SERVICE_ROLE_KEY_DEV';
  return String(env[key] || env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
}

/**
 * Storage REST base, derived from the Postgres connection string's username
 * (`postgres.<ref>`) so there is no separate API-URL variable to keep in sync.
 */
function resolveStorageUrl(env = process.env) {
  const explicit = String(env.SUPABASE_API_URL || '').trim();
  if (explicit) return `${explicit.replace(/\/$/, '')}/storage/v1`;
  const connection = resolveDatabaseUrl(env);
  if (!connection) return '';
  const user = new URL(connection).username;          // postgres.<ref>
  const ref = user.includes('.') ? user.split('.').pop() : '';
  return ref ? `https://${ref}.supabase.co/storage/v1` : '';
}
```

- [ ] **Step 2: Write the storage client**

```javascript
'use strict';
const { resolveServiceRoleKey, resolveStorageUrl } = require('../src/config');

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'call-recordings';

async function uploadObject(key, body, contentType) {
  const base = resolveStorageUrl();
  const token = resolveServiceRoleKey();
  if (!base || !token) throw new Error('Supabase Storage is not configured');

  const response = await fetch(`${base}/object/${BUCKET}/${key}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    body
  });
  if (!response.ok) {
    throw new Error(`Storage upload failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  }
  return key;
}

async function createSignedUrl(key, expiresIn = 60) {
  const base = resolveStorageUrl();
  const token = resolveServiceRoleKey();
  const response = await fetch(`${base}/object/sign/${BUCKET}/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn })
  });
  if (!response.ok) {
    throw new Error(`Signed URL failed (${response.status})`);
  }
  const { signedURL } = await response.json();
  return `${base.replace(/\/storage\/v1$/, '')}/storage/v1${signedURL}`;
}

module.exports = { uploadObject, createSignedUrl, BUCKET };
```

- [ ] **Step 3: Create the bucket**

In the Supabase dashboard for both projects: Storage → New bucket →
name `call-recordings`, **Private**. No RLS policies are needed because only the
service role touches it.

- [ ] **Step 4: Upload after the socket closes**

In `src/websocket-bridge.js`, after `session.audioRecorder.saveToFile(recordingPath)`
succeeds, upload on a background task and record the object key. The local file
is only removed once the upload succeeds:

```javascript
const objectKey = `calls/${session.callId}/${session.streamId}.wav`;
runInBackground('RECORDING UPLOAD', async () => {
  try {
    await uploadObject(objectKey, require('fs').readFileSync(recordingPath), 'audio/wav');
    await dbRun(
      "UPDATE calls SET recording_object_key = ?, recording_status = 'stored' WHERE id = ?",
      [objectKey, session.callId]
    );
    require('fs').promises.unlink(recordingPath).catch(() => {});
  } catch (error) {
    await dbRun(
      "UPDATE calls SET recording_object_key = ?, recording_status = 'pending_upload' WHERE id = ?",
      [recordingPath, session.callId]
    );
    console.error('[RECORDING UPLOAD ERROR]', error.message);
  }
});
```

- [ ] **Step 5: Serve playback as a signed URL**

Replace the `res.sendFile` branch in `src/api-routes.js:1466`:

```javascript
      if (call?.recording_object_key && call.recording_status === 'stored') {
        return res.redirect(await createSignedUrl(call.recording_object_key, 60));
      }
```

- [ ] **Step 6: Retry sweep**

Add to the scheduler tick: select calls with
`recording_status = 'pending_upload'`, and for each whose local file still
exists, retry the upload.

- [ ] **Step 7: Verify**

Place a test call, confirm the object appears in the bucket, then play it back
from the call history UI.

- [ ] **Step 8: Commit**

```bash
git add services/supabase-storage.js src/websocket-bridge.js services/post-call-pipeline.js src/scheduler.js src/config.js src/api-routes.js
git commit -m "feat(recordings): store call audio in Supabase Storage"
```

---

## Task 6: Delete the persistent volumes

**Only valid once Tasks 3 and 5 are both done.** Nothing writes to disk after
that except temporary WAV staging.

**Files:**
- Modify: `docker-compose.yml`, `docker-compose.prod.yml`, `k8s/deployment.yaml`, `Dockerfile`
- Delete: `k8s/pvc.yaml`

- [ ] **Step 1: Compose**

Remove the `feedback_data` and `feedback_recordings` volume mounts and the
top-level `volumes:` entries for them from both compose files. Keep
`nginx_certs` and `nginx_acme` in the prod file.

- [ ] **Step 2: Kubernetes**

```bash
git rm k8s/pvc.yaml
```

In `k8s/deployment.yaml` replace the PVC volume with an `emptyDir` for WAV
staging:

```yaml
      volumes:
        - name: recording-staging
          emptyDir: {}
```

and reduce `volumeMounts` to that one, mounted at the staging path.

- [ ] **Step 3: Dockerfile**

Remove `RUN mkdir -p /app/data /tmp/feedback-call-recordings`.

- [ ] **Step 4: Verify**

```bash
docker compose config
```

Expected: no `feedback_data` or `feedback_recordings`.

- [ ] **Step 5: Commit**

```bash
git add -A docker-compose.yml docker-compose.prod.yml k8s Dockerfile
git commit -m "chore(deploy): remove persistent volumes, containers are stateless"
```

---

## Definition of done

- `npm test` passes
- A login writes a row to `system_logs`, and `/api/logs?filter=users` returns it
- A live call produces an object in the `call-recordings` bucket and plays back
  from the UI
- Killing network access to Supabase does not break a call — logs drop, the
  recording lands at `pending_upload`, and the sweep uploads it later
- `docker compose config` shows no persistent volumes
- `grep -rn "logs/system.log" src services routes` returns nothing

## Deferred

- `system_logs` retention. No deletion job here, per the spec. Revisit at roughly
  one million rows.
- Migrating the WAV staging out of the container filesystem entirely, which
  would need streaming uploads rather than write-then-read.
