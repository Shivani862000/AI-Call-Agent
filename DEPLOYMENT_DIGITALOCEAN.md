# DigitalOcean Deployment Guide

## Target Production Voice Flow

This guide now reflects the recommended production direction for a low-latency Hindi voice agent:

`Caller -> Twilio -> Deepgram Nova-2 -> orchestration server -> Gemini -> ElevenLabs -> Twilio -> caller`

The current codebase still contains a direct Gemini realtime path, but the target production flow on DigitalOcean should be this layered design because it gives cleaner turn detection, better barge-in control, and a safer post-call pipeline.

### Layer 1. Twilio
Keep Twilio as the telephony edge:

- outbound calling
- Media Streams WebSocket
- call recording
- status and recording webhooks

Recommended Media Stream assumptions:

- `track: inbound_track`
- `encoding: audio/x-mulaw`
- `sample_rate: 8000`
- `frame size: 20ms`

Twilio should remain the only PSTN-facing component.

### Layer 2. Deepgram Nova-2
Use Deepgram as the real-time speech-to-text layer and feed it directly from the Twilio stream.



### Layer 3. Orchestration Server
This is the real brain of the system. On DigitalOcean, this should run as a stateful Node.js service behind Nginx and own the entire conversation loop.

Primary loop:

```text
Caller speaks
-> Twilio streams inbound mu-law audio
-> Deepgram emits interim and final transcript events
-> orchestration server builds prompt from system prompt + history + latest final turn
-> Gemini streams text response
-> ElevenLabs streams ulaw_8000 audio
-> Twilio plays audio back to caller
```

Core states to manage:

- `LISTENING`: Twilio and Deepgram active, waiting for caller speech
- `PROCESSING`: final transcript locked, Gemini generating response
- `SPEAKING`: ElevenLabs sending synthesized audio back to Twilio
- `BARGE_IN`: caller interrupts while bot audio is still playing


### Layer 4. Gemini
Keep Gemini as the conversation engine, but use streaming text generation rather than waiting for a full completion.

Guidance:

- keep temperature low for more stable Hindi responses
- stream partial text to TTS as soon as it is usable
- keep prompt assembly inside the orchestration layer, not inside Twilio handlers

### Layer 5. ElevenLabs v3
Use ElevenLabs as the low-latency Hindi TTS layer and return audio to Twilio in `ulaw_8000` so there is no audio conversion hop in the middle.



Why this is preferred:

- Twilio already wants telephony-friendly mu-law audio
- avoiding PCM conversion reduces latency and moving parts
- the orchestration service can pipe TTS output straight back onto the Twilio stream

### Layer 6. Post-Call Pipeline
All post-call work should move to an async queue. Do not run it on the WebSocket path.

Recommended sequence:

```text
Call ends
-> Twilio recording/status webhook
-> enqueue post-call job
-> download recording from Twilio
-> store durable copy in object storage
-> run batch transcription
-> run transcript analysis
-> upsert structured call + feedback data
-> trigger alerts if negative sentiment or escalation conditions are met
```

Suggested jobs:

1. `recording.download`
2. `transcript.batch`
3. `analysis.run`
4. `feedback.upsert`
5. `alert.evaluate`

## Latency Budget

Target end-to-end experience:

- caller stops speaking: `0ms`
- Deepgram endpointing: `+300ms`
- final transcript event: `+100ms`
- Gemini first token: `+400ms`
- ElevenLabs first audio: `+200ms`
- caller hears response: about `1.0s`

This is the right target for a human-feeling interruptible voice bot.

## Production Must-Haves

Non-negotiable controls for this design:

| Concern | Required handling |
| --- | --- |
| Deepgram outage | fallback STT provider or safe transfer path |
| ElevenLabs latency spike | fallback TTS provider or canned voice response |
| Gemini transient failure | retry up to 2 times, then safe fallback response |
| WebSocket leak | timeout, heartbeat, and per-call cleanup |
| Cost runaway | per-call budget cap and alerting |
| Compliance | consent messaging, retention policy, opt-out persistence |

## DigitalOcean Topology For This Flow

For a first production deployment of this architecture:

- `1` Ubuntu Droplet for the app and live orchestration server
- `1` Redis instance for queueing
- `1` PostgreSQL database for structured data
- object storage for recordings
- Nginx reverse proxy with WebSocket support
- PM2 or systemd for process supervision

Recommended service split:

```text
Nginx
  -> web/orchestration process
  -> worker process
  -> Redis
  -> PostgreSQL
  -> object storage
```

For phase 1 on a single Droplet, the web process and worker can run on the same VM. As call volume grows, split the worker first.

## Fastest Recommended Path
If you want the quickest stable deployment for the current codebase, use:

1. 1 Ubuntu Droplet
2. Node.js app on port `3000`
3. Nginx reverse proxy
4. HTTPS with Let's Encrypt
5. current SQLite for phase 1

---

## Step-by-Step Deployment Checklist

### Before you start
Keep these ready:

- GitHub repo URL
- domain or subdomain
- Twilio credentials
- Gemini API key
- SendGrid API key
- owner email
- owner WhatsApp/phone if using digest alerts

### Step 1. Create the Droplet
In DigitalOcean:

1. Create Droplet
2. Choose `Ubuntu 24.04 LTS`
3. Choose at least `1 vCPU / 2 GB RAM`
4. Add your SSH key
5. Create the server

### Step 2. Point domain to Droplet
In your DNS provider:

1. create an `A` record
2. point `calls.yourdomain.com` to the Droplet public IP

Wait until DNS resolves correctly.

### Step 3. SSH into the server

```bash
ssh root@YOUR_DROPLET_IP
```

### Step 4. Install base packages

```bash
sudo apt update
sudo apt install -y nginx git curl build-essential ufw
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### Step 5. Allow firewall ports

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

### Step 6. Pull the project

```bash
cd /var/www
sudo git clone YOUR_REPO_URL ai-call-agent
sudo chown -R $USER:$USER /var/www/ai-call-agent
cd /var/www/ai-call-agent
npm install
```

### Step 7. Create production env

```bash
cp .env.example .env
nano .env
```

Set at least:

```env
PORT=3000
NODE_ENV=production
DATABASE_URL=./feedback.db

REDIS_URL=
POSTGRES_URL=
OBJECT_STORAGE_BUCKET=

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_WHATSAPP_FROM=

CALL_MODE=gemini
GEMINI_API_KEY=
GEMINI_MODEL=models/gemini-3.1-flash-live-preview
GEMINI_VOICE=Kore

DEEPGRAM_API_KEY=

ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_MODEL_ID=eleven_turbo_v2_5

WEBHOOK_URL=https://calls.yourdomain.com
NGROK_URL=https://calls.yourdomain.com

OWNER_EMAIL=
OWNER_PHONE=
SENDGRID_API_KEY=
GOOGLE_REVIEW_LINK=
CLIENT_NAME=
```

Important:

- do not keep ngrok URL here in production
- use final live domain only
- if you adopt the target production flow, treat `POSTGRES_URL`, `REDIS_URL`, and object storage as required rather than optional

### Step 8. Test app directly

```bash
node index.js
```

Check logs. If all good, stop with `Ctrl + C`.

### Step 9. Start app with PM2

```bash
pm2 start index.js --name ai-call-agent
pm2 save
pm2 startup
```

Run the command PM2 gives you for startup persistence.

### Step 10. Configure Nginx
Create file:

```bash
sudo nano /etc/nginx/sites-available/ai-call-agent
```

Paste:

```nginx
server {
    listen 80;
    server_name calls.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/ai-call-agent /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Step 11. Add SSL

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d calls.yourdomain.com
```

Choose redirect to HTTPS when asked.

### Step 12. Verify public app
Open:

- `https://calls.yourdomain.com/admin.html`
- `https://calls.yourdomain.com/api/customers`
- `https://calls.yourdomain.com/api/reports/owner-preview`

### Step 13. Test Twilio webhook path
Now update Twilio to hit:

- `https://calls.yourdomain.com/call/twiml`

Then run a test call.

### Step 14. Check live logs

```bash
pm2 logs ai-call-agent
```

You should verify:

- TwiML request received
- media stream connected
- Deepgram connection established
- Gemini streaming started
- ElevenLabs audio returned to caller
- recording callback received
- transcript/analysis pipeline completed

### Step 15. Optional reboot test

```bash
sudo reboot
```

After reboot:

```bash
pm2 status
sudo systemctl status nginx
```

If both are up, deployment is stable.

---

## Goal
Deploy the current AI call agent stack on DigitalOcean with:

- public HTTPS endpoint for Twilio webhooks
- WebSocket support for `/call/stream`
- persistent application process
- database persistence
- owner/admin dashboard access

## Current Codebase Reality
The current app has these production characteristics:

- Node.js + Express server in [index.js](/Users/shivaniverma/Desktop/testing/index.js)
- Twilio webhook + media stream handling
- Gemini realtime WebSocket integration
- internal scheduler running in-process every 15 seconds
- SQLite database via [db.js](/Users/shivaniverma/Desktop/testing/db.js)
- temporary local recording download path: `/tmp/feedback-call-recordings`

## Current vs Target Architecture

Current runtime in code:

- Twilio -> app -> Gemini realtime
- SQLite for application data
- in-process scheduler
- post-call work triggered from the main app runtime

Target runtime for production hardening:

- Twilio -> Deepgram -> orchestration state machine -> Gemini streaming -> ElevenLabs streaming -> Twilio
- Redis-backed async queue for post-call jobs
- PostgreSQL for structured metadata
- object storage for recordings
- worker separation from the live call path

Because of this, the safest deployment path right now is:

## Recommended Option
### Option A: Single Droplet
Use this first for live deployment of the current codebase.

Why this is best for the current app:

- single process avoids duplicate schedulers
- SQLite can still work for a small production/Poc workload
- local `/tmp` recording flow will still behave predictably
- easier Twilio/WebSocket debugging

## Recommended Infra

- 1 Ubuntu Droplet
- Size: `Basic / Regular / 2 GB RAM / 1 vCPU` minimum
- Region: closest to your users and Twilio usage region
- 1 floating/static IP optional but helpful
- 1 domain or subdomain
- Nginx reverse proxy
- PM2 or systemd for process management
- Let's Encrypt SSL

## Better Production Option
After first live success, upgrade to:

- Droplet or App Platform for app
- Managed PostgreSQL for database
- DigitalOcean Spaces for long-term recordings

This is recommended when:

- call volume grows
- multiple admins use the dashboard
- you need better backup/recovery
- you want cleaner production operations

## Required Services

### 1. Compute
- DigitalOcean Droplet

### 2. Database
For phase 1:
- current SQLite file can stay

For phase 2:
- DigitalOcean Managed PostgreSQL

### 3. Networking
- public domain like `calls.yourdomain.com`
- DNS A record pointing to Droplet IP
- HTTPS certificate

### 4. External APIs
- Twilio
- Deepgram
- Gemini API
- ElevenLabs
- SendGrid

## Ports

- App listens on `PORT=3000`
- public traffic should terminate on:
  - `80`
  - `443`
- Nginx proxies to:
  - `127.0.0.1:3000`

## Env Vars Needed

At minimum:

```env
PORT=3000
NODE_ENV=production
DATABASE_URL=./feedback.db

REDIS_URL=
POSTGRES_URL=
OBJECT_STORAGE_BUCKET=

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_WHATSAPP_FROM=

CALL_MODE=gemini
GEMINI_API_KEY=
GEMINI_MODEL=models/gemini-3.1-flash-live-preview
GEMINI_VOICE=Kore

DEEPGRAM_API_KEY=

ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_MODEL_ID=eleven_turbo_v2_5

WEBHOOK_URL=https://calls.yourdomain.com
NGROK_URL=https://calls.yourdomain.com

OWNER_EMAIL=
OWNER_PHONE=
SENDGRID_API_KEY=
GOOGLE_REVIEW_LINK=
CLIENT_NAME=
```

## Deployment Steps

### Step 1. Create Droplet
- Ubuntu 24.04 LTS
- add SSH key
- allow ports `22`, `80`, `443`

### Step 2. Install runtime

```bash
sudo apt update
sudo apt install -y nginx git curl build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### Step 3. Pull project

```bash
git clone <your-repo-url>
cd AI-Call-Agent
npm install
```

### Step 4. Create production env

```bash
cp .env.example .env
```

Fill real production values in `.env`.

Important:

- set `WEBHOOK_URL` to your final domain
- remove any ngrok URLs
- set `NODE_ENV=production`

### Step 5. Start app with PM2

```bash
pm2 start index.js --name ai-call-agent
pm2 save
pm2 startup
```

### Step 6. Configure Nginx

Example:

```nginx
server {
    listen 80;
    server_name calls.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Enable config:

```bash
sudo ln -s /etc/nginx/sites-available/ai-call-agent /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Step 7. Enable SSL

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d calls.yourdomain.com
```

### Step 8. Update Twilio
Point Twilio flows to:

- `https://calls.yourdomain.com/call/twiml`
- WebSocket stream path inside TwiML will resolve from app config

### Step 9. Smoke test

Check:

- `https://calls.yourdomain.com/admin.html`
- `https://calls.yourdomain.com/api/customers`
- place one test call
- verify Twilio Media Stream connects
- verify Deepgram transcript events arrive
- verify Gemini starts streaming before full completion
- verify ElevenLabs audio returns to the caller
- verify recording callback works
- verify `/api/reports/owner-preview`

## Nginx WebSocket Note
This app requires WebSocket proxying for Twilio media streams, Deepgram connectivity, and the live orchestration bridge.

Do not omit:

- `proxy_set_header Upgrade $http_upgrade;`
- `proxy_set_header Connection "upgrade";`
- `proxy_http_version 1.1;`

## Logging / Operations

Useful commands:

```bash
pm2 logs ai-call-agent
pm2 restart ai-call-agent
pm2 status
sudo journalctl -u nginx -f
```

## Risks In Current Architecture

### 1. SQLite
Okay for:

- small POC
- single-node deployment

Not ideal for:

- multiple app instances
- high write concurrency
- HA failover

### 2. Scheduler in app process
Current scheduler runs inside the web app.

Okay for:

- one instance

Risky for:

- autoscaling
- multiple containers/VMs

### 3. Recordings on local temp
Current processing uses `/tmp`.

Okay for:

- active processing

Not enough for:

- long-term archive
- multi-node workers

## Production Upgrade Path

Phase 1:
- Droplet
- SQLite
- PM2
- Nginx

Phase 2:
- Managed PostgreSQL
- app code migration from SQLite to Postgres
- object storage for recordings
- dedicated worker or cron job for digest/scheduler

## Recommended DigitalOcean Final Architecture

- App: Droplet or App Platform
- Live state/orchestration: Node.js process behind Nginx
- Worker queue: Bull + Redis
- DB: Managed PostgreSQL
- Storage: Spaces
- TLS: Nginx + Let's Encrypt
- Process management: PM2/systemd
- Monitoring: PM2 + DO monitoring + Sentry/Grafana or Datadog

## Go/No-Go Recommendation

### Deploy now
Yes, on:

- `1 DigitalOcean Droplet`

### Do not deploy current version as multi-instance PaaS yet
Avoid until:

- scheduler is separated
- SQLite is replaced
- recording storage is externalized
