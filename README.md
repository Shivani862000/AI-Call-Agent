# Conversational Voice Agent

Node.js + Express voice agent for iCallMate inbound and outbound calls, with Gemini Live audio and Deepgram live transcription.

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
ICALLMATE_OUTBOUND_PROVIDER=campaign
CALL_MODE=gemini
AI_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_REALTIME_MODEL=models/gemini-2.5-flash-native-audio-preview-12-2025
GEMINI_REALTIME_VOICE=Aoede
GEMINI_REALTIME_REASONING_EFFORT=low
GEMINI_TRANSCRIPTION_MODEL=gpt-realtime-whisper
GEMINI_TRANSCRIPTION_LANGUAGE=hi
GEMINI_TRANSCRIPTION_DELAY=low
GEMINI_BATCH_TRANSCRIPTION_MODEL=gpt-4o-transcribe
APP_BASE_URL=https://your-public-domain.example
PORT=3000
```

For CRM master-post outbound calls, set:

```env
ICALLMATE_OUTBOUND_PROVIDER=masterpost
ICALLMATE_MASTER_POST_API_ENDPOINT=https://crm.icallmate.in/WebSVC111/setMasterPostAPI
ICALLMATE_MASTER_POST_CAMP_ID=54
ICALLMATE_MASTER_POST_LEAD_ID=1031
ICALLMATE_MASTER_POST_WSURL=wss://your-public-domain.example/icallmate/media
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
