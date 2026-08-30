# Deployment Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy production and UAT to a single $6 DigitalOcean droplet in Bangalore, with images built in CI, TLS handled automatically, and migrations applied before new code takes traffic.

**Architecture:** GitHub Actions builds one image per commit and pushes it to GHCR. The droplet runs Caddy plus two app containers — prod and UAT — each with its own env file and its own Supabase project. Deploys are a pull-and-restart driven over SSH; migrations run against the target database *before* the container restarts, because the app refuses to boot on a schema mismatch.

**Tech Stack:** Docker Compose, Caddy 2 (automatic TLS, WebSocket passthrough), GitHub Actions, GHCR, DigitalOcean droplet (1 GB, Bangalore BLR1), Supabase Mumbai.

---

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Host | One DO droplet, Bangalore, $6/mo | Low expected traffic; per-tenant droplets later |
| Environments | prod + UAT on the same box | Cost. Blast radius accepted — mitigated by memory limits |
| Reverse proxy | Caddy | Free, automatic TLS, WebSocket passthrough with no config |
| Image build | GitHub Actions → GHCR | A 1 GB droplet can OOM building native `bcrypt`; and tenant #2 pulls the same image |
| Migrations | Before container restart, from CI | `EXPECTED_SCHEMA_VERSION` makes the app refuse to start on mismatch |

**Accepted risk, recorded:** UAT and prod share a droplet. A UAT fault can take production down. Mitigated with per-container memory limits and separate env files, not eliminated. Splitting to two droplets is +$6/month whenever that trade stops being worth it.

**Out of scope:** the shared iCallMate DID (see Open Questions), retention, `replicas: 1`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `.github/workflows/deploy.yml` | **Rewritten.** Build → GHCR → migrate → restart. Replaces the GCP/GKE workflow. |
| `deploy/Caddyfile` | **New.** Two hostnames → two containers, automatic TLS. |
| `docker-compose.prod.yml` | **Rewritten.** Caddy + prod + uat, memory-capped, no volumes for app data. |
| `deploy/droplet-setup.sh` | **New.** One-time droplet bootstrap: Docker, swap, firewall, deploy user. |
| `scripts/migrate.js` | **New.** Applies every pending migration to whichever database the env points at. Wraps the existing per-file applier. |
| `.env.prod.example`, `.env.uat.example` | **New.** What each environment needs, no secrets. |
| `k8s/`, `deploy/nginx/`, `cloudflared/` | **Deleted.** GKE is $70/mo for one pinned container; nginx and the tunnel are superseded by Caddy. |

---

## Task 1: Remove the GKE and nginx deployment path

Dead weight that will otherwise be copied by whoever deploys tenant #2.

**Files:**
- Delete: `k8s/` (5 manifests), `deploy/nginx/`, `cloudflared/`
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Confirm nothing references them**

```bash
grep -rn "k8s/\|deploy/nginx\|cloudflared" --exclude-dir=node_modules --exclude-dir=.git . | grep -v claude-docs
```

Expected: only `docker-compose.prod.yml` (the nginx service, replaced in Task 4).

- [ ] **Step 2: Delete**

```bash
git rm -r k8s deploy/nginx cloudflared
git rm .github/workflows/deploy.yml
```

- [ ] **Step 3: Commit**

```bash
git commit -m "chore(deploy): remove the GKE, nginx and tunnel deployment path"
```

---

## Task 2: A migration runner CI can call

`scripts/apply-migration.js` takes one file. Deploys need "apply everything pending".

**Files:**
- Create: `scripts/migrate.js`

- [ ] **Step 1: Write it**

```javascript
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { resolveDatabaseUrl, databaseUrlVarName } = require('../src/config');

/**
 * Applies every migration not yet recorded, in order, each in its own
 * transaction. Run before the new image starts: the app refuses to boot when
 * EXPECTED_SCHEMA_VERSION does not match the database.
 *
 *   node scripts/migrate.js            # whichever env .env selects
 *   NODE_ENV=production node scripts/migrate.js
 */
async function main() {
  const client = new Client({ connectionString: resolveDatabaseUrl(), connectionTimeoutMillis: 20000 });
  await client.connect();
  console.log(`Migrating ${databaseUrlVarName()} -> ${new URL(resolveDatabaseUrl()).hostname}`);

  await client.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations');
  await client.query(`CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
    version text PRIMARY KEY, statements text[], name text)`);

  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let applied = 0;

  for (const file of files) {
    const version = file.split('_')[0];
    const name = path.basename(file, '.sql').split('_').slice(1).join('_');
    const seen = await client.query(
      'SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = $1', [version]
    );
    if (seen.rowCount) continue;

    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query(
        'INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2)',
        [version, name]
      );
      await client.query('COMMIT');
      console.log(`  applied ${version} (${name})`);
      applied += 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${file} failed: ${error.message}`);
    }
  }

  const latest = await client.query(
    'SELECT max(version) AS v FROM supabase_migrations.schema_migrations'
  );
  console.log(`  ${applied} applied, database at ${latest.rows[0].v}`);
  await client.end();
}

main().catch((error) => { console.error('[MIGRATE FAILED]', error.message); process.exit(1); });
```

- [ ] **Step 2: Verify it is a no-op against an up-to-date database**

```bash
node scripts/migrate.js
```

Expected: `0 applied, database at 0011`.

- [ ] **Step 3: Add the npm script**

In `package.json` scripts: `"migrate": "node scripts/migrate.js"`.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate.js package.json
git commit -m "tools: add a migration runner for deploys"
```

---

## Task 3: Caddyfile

**Files:**
- Create: `deploy/Caddyfile`

- [ ] **Step 1: Write it**

```
# Two hostnames, two containers, on one droplet.
# Caddy obtains and renews TLS from Let's Encrypt automatically, and proxies
# WebSocket upgrades without any extra configuration — the media bridge needs
# no special handling here.

{
	email {$ACME_EMAIL}
}

app.vikitechsolutions.in {
	# reverse_proxy passes WebSocket upgrades through on its own — the media
	# bridge needs no special handling, and no default timeout cuts a call off.
	reverse_proxy prod:3000

	encode gzip
	log {
		output file /var/log/caddy/prod.log
		format json
	}
}

uat.vikitechsolutions.in {
	reverse_proxy uat:3000

	encode gzip
	log {
		output file /var/log/caddy/uat.log
		format json
	}
}
```

- [ ] **Step 2: Validate the syntax without a droplet**

```bash
docker run --rm -v "$PWD/deploy/Caddyfile":/etc/caddy/Caddyfile caddy:2 caddy validate --config /etc/caddy/Caddyfile
```

Expected: `Valid configuration`.

- [ ] **Step 3: Commit**

```bash
git add deploy/Caddyfile
git commit -m "feat(deploy): Caddy config for prod and uat hostnames"
```

---

## Task 4: Compose file for the droplet

**Files:**
- Rewrite: `docker-compose.prod.yml`

- [ ] **Step 1: Replace it**

```yaml
# One droplet, two environments. Both pull the same image; only the env file
# and the database behind it differ.
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      ACME_EMAIL: ${ACME_EMAIL}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data        # certificates — losing these means re-issuing
      - caddy_config:/config
      - caddy_logs:/var/log/caddy
    depends_on:
      - prod
      - uat

  prod:
    image: ${APP_IMAGE}
    restart: always
    env_file: [.env.prod]
    environment:
      NODE_ENV: production
    # mem_limit, not deploy.resources — the latter is swarm-oriented and is
    # quietly ignored by a plain `docker compose up`.
    mem_limit: 512m
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/login.html').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

  uat:
    image: ${APP_IMAGE}
    restart: unless-stopped
    env_file: [.env.uat]
    environment:
      NODE_ENV: uat        # not "production": keeps it on SUPABASE_URL_DEV
    # Capped so a runaway test cannot take production down with it. This does
    # not remove the shared-droplet risk, only its most likely cause.
    mem_limit: 256m

volumes:
  caddy_data:
  caddy_config:
  caddy_logs:
```

**Note on `NODE_ENV: uat`:** `resolveDatabaseUrl()` selects the production database only when `NODE_ENV === 'production'`. Any other value falls through to `SUPABASE_URL_DEV`, so UAT cannot reach the production database even if its env file is wrong.

- [ ] **Step 2: Validate**

```bash
APP_IMAGE=ghcr.io/example/app:test ACME_EMAIL=x@y.z docker compose -f docker-compose.prod.yml config >/dev/null && echo "compose valid"
```

- [ ] **Step 3: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "feat(deploy): compose for prod and uat on one droplet"
```

---

## Task 5: Droplet bootstrap script

**Files:**
- Create: `deploy/droplet-setup.sh`

- [ ] **Step 1: Write it**

```bash
#!/usr/bin/env bash
# One-time droplet setup. Run as root on a fresh Ubuntu 24.04 droplet.
#   ssh root@<ip> 'bash -s' < deploy/droplet-setup.sh
set -euo pipefail

echo "== packages =="
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw

echo "== docker =="
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "== swap =="
# 1 GB of RAM with two Node processes plus Caddy is tight. Swap turns a
# transient spike into slowness rather than the OOM killer picking a victim.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
fi

echo "== firewall =="
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "== deploy user =="
id -u deploy >/dev/null 2>&1 || useradd -m -s /bin/bash deploy
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh /opt/app
chown -R deploy:deploy /home/deploy/.ssh /opt/app
chmod 700 /home/deploy/.ssh

echo "== log rotation =="
# Container logs on a 25 GB disk will fill it otherwise.
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
JSON
systemctl restart docker

echo
echo "Done. Next:"
echo "  1. Put the deploy public key in /home/deploy/.ssh/authorized_keys"
echo "  2. Copy Caddyfile, docker-compose.prod.yml, .env.prod and .env.uat to /opt/app"
echo "  3. Point app. and uat. DNS A records at this droplet"
```

- [ ] **Step 2: Check it parses**

```bash
bash -n deploy/droplet-setup.sh && echo "syntax ok"
chmod +x deploy/droplet-setup.sh
```

- [ ] **Step 3: Commit**

```bash
git add deploy/droplet-setup.sh
git commit -m "feat(deploy): droplet bootstrap script"
```

---

## Task 6: Build and deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Write it**

```yaml
name: Deploy

on:
  push:
    branches: [master]
  workflow_dispatch:
    inputs:
      environment:
        description: Which environment to deploy
        type: choice
        options: [uat, prod]
        default: uat

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20.x', cache: npm }
      - run: npm ci
      - run: npm test

  build:
    needs: test
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    outputs:
      image: ${{ steps.meta.outputs.image }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        # Tagged by commit so a rollback is "deploy the previous SHA".
        run: echo "image=ghcr.io/${{ github.repository }}:${{ github.sha }}" >> "$GITHUB_OUTPUT"
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ${{ steps.meta.outputs.image }}
            ghcr.io/${{ github.repository }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment || 'uat' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20.x', cache: npm }
      - run: npm ci --omit=dev

      # Migrations run from CI, before the container restarts. The app refuses
      # to boot on a schema mismatch, so the order matters: migrate first and a
      # failure stops the deploy with the old version still serving.
      - name: Apply migrations
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
        run: node scripts/migrate.js

      - name: Deploy over SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.DROPLET_HOST }}
          username: deploy
          key: ${{ secrets.DROPLET_SSH_KEY }}
          script: |
            set -euo pipefail
            cd /opt/app
            echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin
            export APP_IMAGE=${{ needs.build.outputs.image }}
            docker compose -f docker-compose.prod.yml pull ${{ inputs.environment || 'uat' }}
            docker compose -f docker-compose.prod.yml up -d ${{ inputs.environment || 'uat' }}
            docker image prune -f

      - name: Verify it came back
        run: |
          HOST=${{ inputs.environment == 'prod' && 'app' || 'uat' }}.vikitechsolutions.in
          for i in $(seq 1 12); do
            code=$(curl -s -o /dev/null -w '%{http_code}' "https://$HOST/login.html" || true)
            [ "$code" = "200" ] && echo "healthy" && exit 0
            sleep 5
          done
          echo "did not become healthy"; exit 1
```

- [ ] **Step 2: List the secrets that must exist**

In GitHub → Settings → Environments, create `uat` and `prod`, each with:

| Secret | Value |
| --- | --- |
| `DATABASE_URL` | Session pooler string for that environment's Supabase project |
| `DROPLET_HOST` | Droplet IP |
| `DROPLET_SSH_KEY` | Private key whose public half is in `deploy`'s `authorized_keys` |

`DATABASE_URL` overrides the `SUPABASE_URL` / `SUPABASE_URL_DEV` split, which is exactly what it exists for — CI targets one database explicitly.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat(deploy): build to GHCR, migrate, then restart"
```

---

## Task 7: Environment file templates

**Files:**
- Create: `.env.prod.example`, `.env.uat.example`

- [ ] **Step 1: Write both**

`.env.prod.example`:

```
# Production. Lives at /opt/app/.env.prod on the droplet, never in git.
NODE_ENV=production
PORT=3000
APP_BASE_URL=https://app.vikitechsolutions.in

SUPABASE_URL=postgresql://postgres.<prod-ref>:<pw>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORAGE_BUCKET=call-recordings

AUTH_SIGNING_SECRET=
GEMINI_API_KEY=
DEEPGRAM_API_KEY=
ICALLMATE_UKEY=
ICALLMATE_WEBHOOK_SECRET=
ICALLMATE_MEDIA_SHARED_SECRET=
ICALLMATE_MASTER_POST_WSURL=wss://app.vikitechsolutions.in/icallmate/media

SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM=
```

`.env.uat.example` is the same with these differences:

```
NODE_ENV=uat
APP_BASE_URL=https://uat.vikitechsolutions.in
SUPABASE_URL_DEV=postgresql://postgres.<dev-ref>:<pw>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
SUPABASE_SERVICE_ROLE_KEY_DEV=
ICALLMATE_MASTER_POST_WSURL=wss://uat.vikitechsolutions.in/icallmate/media
```

**`AUTH_SIGNING_SECRET` must differ between the two.** A shared secret means a UAT session token authenticates against production.

- [ ] **Step 2: Commit**

```bash
git add .env.prod.example .env.uat.example
git commit -m "docs(deploy): environment templates for prod and uat"
```

---

## Task 8: First deploy

Operational, in order.

- [ ] **Step 1** — Create the droplet: DigitalOcean → Ubuntu 24.04, Basic, Regular, **$6/mo**, region **Bangalore (BLR1)**, your SSH key.

- [ ] **Step 2** — Bootstrap it:

```bash
ssh root@<ip> 'bash -s' < deploy/droplet-setup.sh
```

- [ ] **Step 3** — DNS: two A records at `<ip>` — `app` and `uat` on `vikitechsolutions.in`. Wait for propagation; Caddy cannot get a certificate before the name resolves.

- [ ] **Step 4** — Copy the config up:

```bash
scp deploy/Caddyfile docker-compose.prod.yml deploy@<ip>:/opt/app/
# then create /opt/app/.env.prod and /opt/app/.env.uat from the templates
```

- [ ] **Step 5** — Deploy UAT first, from the Actions tab: **Deploy → Run workflow → environment: uat**.

- [ ] **Step 6** — Verify UAT: `https://uat.vikitechsolutions.in/login.html` returns 200 with a valid certificate, you can sign in, and `docker compose logs uat` shows the schema-version line and no scheduler errors.

- [ ] **Step 7** — Only then deploy prod, and repeat the check on `app.`.

---

## Definition of done

- Both hostnames serve over HTTPS with automatic certificates
- A push to `master` runs tests, builds, migrates and deploys UAT unattended
- Prod deploys only on an explicit `workflow_dispatch`
- A failed migration stops the deploy with the previous version still serving
- `docker stats` shows both apps well inside their limits
- Rollback works: re-run the workflow against an earlier commit SHA

## Open questions

**One iCallMate DID (`8037259753`), one campaign (`54`), one media URL.** With prod and UAT both reachable, a test call can land on production. Options: UAT outbound-only, a second DID, or manual coordination. This gates real end-to-end testing and is worth asking iCallMate before Task 8.

**Supabase free tier caps at 2 active projects** — you are at 2. Tenant #2 needs the Pro plan (~$25/mo). Free projects also pause after 7 days idle, so UAT will need waking between test rounds.
