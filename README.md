# Conversational Voice Agent POC
ngrok http 3000
A simple Node.js + Express proof of concept for outbound AI phone calls using:

- Twilio Programmable Voice
- Twilio Media Streams
- OpenAI Realtime API over WebSocket
- ngrok for local webhook exposure

The flow is intentionally minimal: trigger one outbound call, let the AI agent run a multi-turn conversation, and print the final transcript to the console.

## Endpoints

- `POST /call/start` places an outbound call to `CUSTOMER_PHONE`
- `GET /call/twiml` returns TwiML that opens a Twilio Media Stream
- `POST /call/status` logs Twilio call status changes
- `WS /call/stream` bridges Twilio audio to OpenAI Realtime and streams AI audio back
- `GET /health` returns a basic health payload

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the env template and fill in real values:

```bash
cp .env.example .env
```

Required fields:

```env
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=+14155550100
OPENAI_API_KEY=
OPENAI_REALTIME_MODEL=gpt-realtime
NGROK_URL=https://abc123.ngrok-free.app
CUSTOMER_PHONE=+14155550123
CUSTOMER_NAME=Ramesh
CLIENT_NAME=My Diagnostic Center
PORT=3000
```

Notes:

- `TWILIO_PHONE_NUMBER` must be a Twilio-owned voice-capable number.
- If your Twilio account is still on trial, `CUSTOMER_PHONE` must be verified in Twilio.
- `NGROK_URL` should not have a trailing slash.

## Run

Start the server:

```bash
node index.js
```

Start ngrok in another terminal:

```bash
ngrok http 3000
```

Copy the HTTPS forwarding URL from ngrok into `.env` as `NGROK_URL`, then restart the server.

Trigger the outbound call:

```bash
curl -X POST http://localhost:3000/call/start
```

## Expected console flow

```text
[SERVER] Running on http://localhost:3000
[CALL STARTED] SID: CA...
[STREAM] Twilio Media Stream connected
[OPENAI] Realtime session opened
[AGENT]: Hello, am I speaking with Ramesh? My name is Priya...
[CUSTOMER]: Yes, this is Ramesh.
...
════════════════════════════════════
         CALL TRANSCRIPT
════════════════════════════════════
[AGENT] (2026-04-29T16:30:01.000Z)
  Hello, am I speaking with Ramesh?...
```

## Troubleshooting

- No TwiML request from Twilio: confirm `NGROK_URL` is reachable and the server was restarted after editing `.env`.
- Twilio `11200`: webhook or stream URL is not reachable.
- No audio both ways: confirm the stream URL resolves to `wss://.../call/stream`.
- OpenAI auth errors: verify the API key has access to Realtime.
- Twilio trial failure: verify the destination number in Twilio or upgrade the account.

## Docker Development

Build and start locally with Docker Compose:

```bash
docker compose up --build
```

The app listens on:

```text
http://localhost:3000
```

The Compose setup persists SQLite data in a Docker volume and is ready to accept a production image through the `IMAGE_NAME` variable during deployment.

## CI/CD

The repository includes a GitHub Actions deployment workflow:

- workflow file: `.github/workflows/deploy.yml`
- release branch: `deploy`
- Artifact Registry: `asia-south2-docker.pkg.dev/lively-math-495604-b5/feedback-agent`
- runtime target: `GKE + Kubernetes Ingress`

Google Cloud deployment notes live in:

- `GKE_NEXT_STEPS.md`
