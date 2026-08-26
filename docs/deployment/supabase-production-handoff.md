# Supabase Production Handoff

Date: 2026-08-26

This runbook is the application-readiness handoff for the separate DigitalOcean production deployment pipeline. Supabase Postgres is the only persistent application data source. The production database starts empty; legacy local data is intentionally abandoned with no backup, export, import, reconciliation, or dual write.

## Verified application baseline

- Source-controlled migrations are idempotently up to date on a dedicated hosted non-production Supabase project.
- The destructive-test guard verifies the test project reference, requires explicit reset consent, and rejects a test database URL equal to the production URL.
- The complete test suite exercises hosted Postgres, authentication/session behavior, two-client isolation, reports, callbacks, payload limits, transactions, and removal of obsolete persistence.
- Two distinct webmaster profiles can coexist; independent session, role reload, disable/version invalidation, and continued authorization of the other webmaster are covered.
- Existing authenticated routes can switch between two active clients and store the same customer phone independently without cross-client visibility.
- Twilio HTTP callbacks and media WebSocket upgrades use signature validation against the canonical external URL.

No real customer call is part of automated acceptance.

## Required runtime secrets and configuration

Inject these through DigitalOcean deployment-secret management; never commit values:

- `SUPABASE_DB_URL`: production runtime database connection.
- `SUPABASE_DB_CA_CERT`: CA certificate for strict database TLS verification.
- `SUPABASE_URL`: production Supabase project URL used for Auth.
- `SUPABASE_PUBLISHABLE_KEY`: server-side password-verification client key.
- `COOKIE_SECRET`: random value of at least 32 characters.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, and optional WhatsApp sender.
- `NGROK_URL` or `WEBHOOK_URL`: stable public HTTPS origin for the production Droplet. Despite the legacy variable name, this must be the final canonical production URL.
- Credentials for the selected OpenAI or Gemini call mode.
- Business/email configuration used by the existing workflows.

Do not inject `SUPABASE_SECRET_KEY` into normal application runtime. It is needed only for the one-time webmaster provisioning command.

## Database preparation

1. Create the empty production Supabase project and restrict database/network access to the production deployment path.
2. Apply every migration in `supabase/migrations/` using the Supabase CLI from the deployment runner. Do not use the destructive hosted-test script against production.
3. Create a dedicated login credential for the application and grant it membership in the bounded `ai_call_agent_runtime` role created by the migration. Build `SUPABASE_DB_URL` from that credential; do not run the application as the project-owner database user.
4. Insert the two initial `clients` rows with unique slugs, display names, time zones, and `active` status. Client-management UI/API is intentionally outside this readiness scope.
5. Confirm the runtime credential can perform application CRUD but cannot administer roles or schemas.

The isolated integration project uses:

```bash
npm run db:push:test -- --dry-run
npm run db:push:test
npm run test:db
```

Its credentials belong only in ignored `.env.test.local` or CI secrets. `SUPABASE_TEST_ALLOW_RESET=true` is never valid for a production secret set.

## Webmaster provisioning

Temporarily inject `SUPABASE_SECRET_KEY` into a deployment job, then run once per account:

```bash
npm run provision:webmaster -- --username webmaster-name --email webmaster@example.com
```

Enter the password through the hidden prompt, or pipe it through standard input from the deployment secret provider. Do not use a command-line password flag or password environment variable. The password must be at least 12 characters and is stored only by Supabase Auth. The application database stores the Auth UUID, normalized username/email, active flag, auth version, and role—never a password or hash.

Repeat with a distinct username/email for the second webmaster. The command never updates an existing account and normal server startup never creates, resets, or limits webmaster accounts. Remove `SUPABASE_SECRET_KEY` from the job/runtime after provisioning.

Before accepting production traffic, perform a credentialed smoke test against the production Supabase Auth project: sign in as each webmaster, select each active client, disable one test account, confirm its session is rejected, confirm the other remains authorized, then restore or remove the test identity by its explicit Auth UUID.

## Runtime and health contract

Start one application replica with `npm start`. One replica is required for now because the scheduler and live-call state are process-local.

Startup validates configuration, opens the Postgres pool with strict TLS, verifies connectivity, constructs repositories/routes, starts scheduling, and listens. `GET /health` returns:

- `200` with `ok: true` and `database: connected` when Postgres responds.
- `503` with `ok: false` and `database: unavailable` when it does not.

DigitalOcean health checks should target `/health`. On `SIGTERM`, the process stops scheduling, stops accepting HTTP traffic, drains the server, and closes the Postgres pool. Logs are one-line redacted JSON and include request IDs.

## Canonical URL and Twilio gate

Configure the final public HTTPS origin before placing calls. Signature validation reconstructs the externally visible HTTPS or WSS URL, including query strings, so the Droplet reverse proxy must preserve the original path/query and forward HTTPS correctly. Update Twilio callbacks only after this URL is stable.

Production cutover is intentionally short:

1. Deploy the Supabase-backed application to the production Droplet.
2. Apply migrations and create the two active client rows.
3. Provision at least two webmasters and remove the provisioning secret.
4. Confirm `/health`, both webmaster logins, both client selections, and one controlled test call.
5. Confirm customer, call, feedback, transcript, report, and callback visibility for the selected client.
6. Remove any old persistent volume or database file from the Droplet. There is nothing to migrate or recover.

The DigitalOcean build/release/reverse-proxy pipeline and later UAT Droplet are separate follow-up work.
