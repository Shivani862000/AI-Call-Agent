# Conversational Voice Agent

Node.js + Express voice agent for iCallMate inbound and outbound calls, with Gemini Live audio and Deepgram transcription.

## Endpoints

- `POST /call/start` places an outbound iCallMate call.
- `POST /api/calls/initiate/:customerId` places an outbound iCallMate call for a saved customer.
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
GEMINI_API_KEY=
DEEPGRAM_API_KEY=
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

## iCallMate Media

iCallMate should connect to:

```text
wss://<APP_BASE_URL>/icallmate/media
```

The app expects `8000 Hz`, `LINEAR16`, `1 channel`, `16 bits` media payloads.
