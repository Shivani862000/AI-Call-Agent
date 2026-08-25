# Conversational Voice Agent

Node.js + Express voice agent for iCallMate inbound and outbound calls, with selectable OpenAI Realtime or Gemini Live voice, plus Deepgram transcription. Gemini Live mode streams native Gemini audio directly back to the call.

## Endpoints

- `POST /call/start` places an outbound iCallMate call.
- `POST /api/calls/initiate/:customerId` places an outbound iCallMate call for a saved customer.
- `POST /api/icallmate/outgoing-call` places an iCallMate master-post outgoing call.
- `GET /api/icallmate/config` returns the current iCallMate media and callback URLs.
- `POST /api/icallmate/incoming-config` configures iCallMate DNIS macros.
- `POST /api/icallmate/outbound-campaign` creates an iCallMate outbound campaign.
- `POST /api/icallmate/callback` receives iCallMate call callbacks.
- `WS /icallmate/media` handles iCallMate bidirectional media.
- `GET /icallmate/health` returns iCallMate media health details.

## Setup

```bash
npm install
cp .env.example .env
```

Required voice fields:

```env
ICALLMATE_UKEY=
ICALLMATE_SERVICE_NO=
ICALLMATE_IVR_TEMPLATE_ID=
ICALLMATE_AGENT_ID=0
ICALLMATE_BOT_ID=0
ICALLMATE_DID=07971644996
ICALLMATE_IBD_API_ENDPOINT=https://crm.icallmate.in
ICALLMATE_OBD_API_ENDPOINT=https://ecp1.icallmate.in
OPENAI_API_KEY=
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_REALTIME_VOICE=marin
AI_PROVIDER=gemini-live
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.1-flash-live-preview
GEMINI_VOICE=Kore
GEMINI_LIVE_THINKING_LEVEL=minimal
GEMINI_LIVE_SILENCE_DURATION_MS=120
GEMINI_LIVE_PREFIX_PADDING_MS=20
DEEPGRAM_API_KEY=
DEEPGRAM_TTS_MODEL=aura-2-thalia-en
APP_BASE_URL=https://your-public-domain.example
PORT=3000
```

## Run

```bash
node index.js
```

For local public testing:

```bash
ngrok http 3000
```

Set the HTTPS forwarding URL as `APP_BASE_URL` or `NGROK_URL`, restart the server, then trigger:

```bash
curl -X POST http://localhost:3000/call/start
```

Master-post outgoing test:

```bash
curl -X POST http://localhost:3000/api/icallmate/outgoing-call \
  -H 'Content-Type: application/json' \
  -d '{
    "campid": "54",
    "leadid": "1031",
    "fieldpairs": [
      {
        "Phone_No": "8800453310",
        "wsurl": "wss://kcpathlab.vikitechsolution.in/icallmate/media"
      }
    ]
  }'
```

## iCallMate Media

iCallMate should connect to:

```text
wss://<APP_BASE_URL>/icallmate/media
```

The app expects `8000 Hz`, `LINEAR16`, `1 channel`, `16 bits` media payloads.
ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no -R 80:localhost:3000 ssh.localhost.run

## Webmaster Console

Authorized platform Owners and Webmaster Admins use `/webmaster.html`. The environment account named by `ADMIN_USERNAME` is the recovery Owner; its password is verified against `ADMIN_PASSWORD_HASH`. Persisted `WEBMASTER` accounts require an active status and an `OWNER` or `ADMIN` platform access level.

Generate the production encryption key with:

```bash
openssl rand -base64 32
```

Store the result as `WEBMASTER_SECRETS_KEY`. Integration secrets saved from the console are encrypted with AES-256-GCM and override environment fallbacks. Secret values are write-only: the browser receives configured/source metadata, never the secret or encrypted envelope.

The console manages tenants, tenant users, platform administrators, settings, integration configuration, maintenance policy, aggregate operational health, notification delivery state, and immutable audit history. Tenant operational snapshots are aggregate-only and exclude customer-level content.

Application records are archived and restorable rather than permanently deleted. Maintenance mode blocks tenant mutations while Webmaster access remains available for recovery. Failed lifecycle notifications remain recorded and retryable; a delivery failure does not reverse the lifecycle change.

Managed policy values are enforced at runtime: password bounds govern account creation and resets, session duration governs newly issued cookies, feature flags gate mapped operational mutations, and the daily archive-only retention job applies the configured customer/call/feedback ages. Lifecycle emails create immutable delivery records and failed deliveries can be retried manually from the console.

For production, set a stable `AUTH_SIGNING_SECRET`, retain access to the environment Owner credentials, and back up MongoDB before schema rollout.
