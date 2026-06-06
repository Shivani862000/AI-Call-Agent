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
