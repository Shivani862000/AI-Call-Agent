# AI Call Agent

Node.js/Express application for tenant-scoped outbound feedback calls, live AI voice conversations, feedback analysis, supervisor events, and PDF reporting.

Persistent application data lives only in hosted Supabase Postgres. Supabase Auth verifies webmaster passwords; the application retains authorization and active-client selection in signed HTTP-only sessions. Twilio HTTP callbacks and media WebSocket upgrades require valid provider signatures.

## Requirements

- Node.js 24
- A hosted Supabase project
- Twilio Programmable Voice credentials and a public HTTPS callback URL
- The configured OpenAI or Gemini provider credentials

Copy `.env.example` to `.env` and supply secrets through the deployment environment. `SUPABASE_SECRET_KEY` is provisioning-only and should not be present during normal server startup.

## Database setup

Schema changes are source-controlled under `supabase/migrations/`. This project deliberately starts Supabase empty: legacy local database contents are discarded and must not be copied, backed up, or imported.

For an isolated hosted test project, keep these values only in ignored `.env.test.local` or CI secrets:

```env
SUPABASE_TEST_DB_URL=
SUPABASE_TEST_PROJECT_REF=
SUPABASE_TEST_ALLOW_RESET=true
```

Never point destructive tests at production. The test guard verifies the project reference, explicit reset consent, and separation from `SUPABASE_DB_URL`.

Preview and apply migrations to the isolated hosted test project:

```bash
npm run db:push:test -- --dry-run
npm run db:push:test
npm run test:db
```

## Webmaster provisioning

Create each webmaster once during deployment. Password input is hidden when interactive or may be piped through standard input; password flags and password environment variables are rejected.

```bash
npm run provision:webmaster -- --username webmaster-name --email webmaster@example.com
```

The command creates a new Supabase Auth identity and matching Postgres profile/role. It never updates an existing account, and normal startup never creates or resets users. Run the command repeatedly with distinct usernames/emails to provision multiple webmasters.

## Run and verify

```bash
npm ci
npm test
npm start
curl -i http://127.0.0.1:3000/health
```

`GET /health` returns `200` only when Postgres is reachable; otherwise it returns `503`. Runtime logs are one-line redacted JSON with request IDs. `SIGTERM` stops scheduling, drains HTTP, and closes the Postgres pool.

After login, a webmaster can select either active client from the existing dashboard. Repository queries, joins, reports, callbacks, and scheduled jobs retain that tenant boundary. The current deployment model is one application replica because the scheduler and live-call state remain process-local.

## Production notes

- Use a direct/pooler Postgres connection appropriate for the runtime and provide the Supabase CA certificate.
- Keep the public callback URL canonical and stable; Twilio signature checks use it for HTTPS and WSS validation.
- Keep runtime database credentials, cookie secret, Twilio credentials, and AI keys in deployment-secret management.
- Keep the provisioning secret out of the normal runtime environment.
- The DigitalOcean production pipeline is a separate implementation phase after this application-readiness cutover.
