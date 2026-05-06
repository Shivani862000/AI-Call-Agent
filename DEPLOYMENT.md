# Production Deployment Guide

This document explains how to take this project live safely.

## What This App Needs in Production

This app depends on:

- Node.js app server running `index.js`
- SQLite database file (`feedback.db`)
- Public HTTPS base URL reachable by Exotel
- WebSocket support for `/call/stream`
- Exotel outbound calling + Voicebot flow
- Gemini API key
- Deepgram API key

## Before You Go Live

Do these first:

1. Rotate exposed credentials immediately.
2. Replace `ngrok` URL with a permanent production domain.
3. Put the app behind HTTPS.
4. Make sure Exotel Voicebot applet points to the production URL.
5. Keep the server process managed by `pm2`, `systemd`, or Docker restart policy.
6. Take regular backups of `feedback.db`.

## Critical Security Note

Your current [.env.example](/Users/shivaniverma/Desktop/testing/.env.example:1) contains real-looking Exotel credentials.

Before production:

- rotate `EXOTEL_API_KEY`
- rotate `EXOTEL_API_TOKEN`
- move secrets to real `.env` only
- replace `.env.example` with placeholder values

Do not deploy with real secrets committed in templates.

## Recommended Production Stack

Recommended simple setup:

- Ubuntu VPS or cloud VM
- Node.js 20+
- `pm2` for process management
- `nginx` as reverse proxy
- real domain like `calls.yourdomain.com`
- TLS via Let's Encrypt

## Required Environment Variables

Use a production `.env` with values like:

```env
EXOTEL_SID=your_exotel_sid
EXOTEL_API_KEY=your_exotel_api_key
EXOTEL_API_TOKEN=your_exotel_api_token
EXOTEL_API_HOST=api.exotel.com
EXOTEL_CALLER_ID=01141189053
EXOTEL_APP_ID=1239002
EXOTEL_APPLET_URL=http://my.exotel.com/your_sid/exoml/start_voice/1239002
EXOTEL_WHATSAPP_FROM=your_whatsapp_sender

CALL_MODE=gemini
VOICE_PIPELINE=legacy

GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=models/gemini-3.1-flash-live-preview
GEMINI_VOICE=Kore

DEEPGRAM_API_KEY=your_deepgram_api_key

NGROK_URL=https://calls.yourdomain.com
WEBHOOK_URL=https://calls.yourdomain.com

CLIENT_NAME=Your Business Name
PORT=3000
NODE_ENV=production
```

Notes:

- `NGROK_URL` and `WEBHOOK_URL` should both be your real public domain in production.
- Even though the variable says `NGROK_URL`, it can hold your normal production URL.

## Server Setup

Install dependencies:

```bash
npm install
```

Run once locally to confirm:

```bash
node index.js
```

Health check:

```bash
curl http://127.0.0.1:3000/health
```

Expected:

- `ok: true`
- correct public base URL
- correct call mode

## Run With PM2

Install PM2:

```bash
npm install -g pm2
```

Start app:

```bash
pm2 start index.js --name feedback-agent
pm2 save
pm2 startup
```

Useful commands:

```bash
pm2 logs feedback-agent
pm2 restart feedback-agent
pm2 status
```

## Nginx Reverse Proxy

Example `/etc/nginx/sites-available/feedback-agent`:

```nginx
server {
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

Then enable TLS:

```bash
sudo certbot --nginx -d calls.yourdomain.com
```

## Exotel Production Configuration

Your Exotel flow must use:

- `Voicebot`
- `Hangup`

Recommended flow:

- `Call Start -> Voicebot -> Hangup`

Voicebot URL:

```text
https://calls.yourdomain.com/call/exotel/voicebot-url
```

Do not use:

- `Greeting` before Voicebot if you want direct AI greeting
- old landing flow steps that bypass Voicebot

## Required Public Endpoints

These must be reachable from Exotel:

- `/call/exotel/voicebot-url`
- `/call/stream`
- `/call/status`
- `/health`
- `/admin.html`

## Important Production Limitations

Current project behavior to know before go-live:

1. Database is SQLite
   Use it for low to moderate traffic only.

2. Recordings are fetched from Exotel on demand
   Playback works, but recording pipeline should be monitored.

3. Transcript pipeline can still fail on some calls
   `transcript_status=download_failed` and `analysis_status=blocked` can happen.

4. Live supervisor is best-effort
   It now shows active and recent supervised calls, not only currently open streams.

## Go-Live Checklist

Use this exact checklist:

- real domain configured
- HTTPS enabled
- `.env` set for production
- Exotel Voicebot URL updated to production domain
- health check returns `ok: true`
- admin dashboard opens from public domain
- customer list loads
- manual `Call now` works
- scheduled call works
- AI speaks first on call
- call status updates in dashboard
- `Play recording` works
- retry flow works
- reschedule flow works
- logs visible via `pm2 logs`
- database backup job configured

## Final End-to-End Test

Test this before client launch:

1. Add a new customer from admin UI.
2. Trigger `Call now`.
3. Confirm AI greeting starts directly.
4. Speak for 20-30 seconds.
5. End the call.
6. Confirm customer status updates.
7. Confirm latest call appears in recent calls.
8. Confirm `Play recording` works.
9. Confirm live supervisor row appears during or after call.
10. Edit time and verify rescheduled call also works.

## Backup Recommendation

At minimum, back up:

- `feedback.db`
- `.env`

Example cron backup:

```bash
mkdir -p /var/backups/feedback-agent
cp /Users/shivaniverma/Desktop/testing/feedback.db /var/backups/feedback-agent/feedback-$(date +%F-%H%M).db
```

## Monitoring Recommendation

Watch these regularly:

- `pm2 logs feedback-agent`
- failed Exotel calls
- `transcript_status`
- `analysis_status`
- `recording_status`
- server memory and disk

## Recommended Next Improvements Before Client Launch

- move from SQLite to Postgres
- fix transcript download pipeline for all Exotel recordings
- add authenticated admin login
- add server-side audit logs
- add automated nightly DB backup
- add error monitoring like Sentry
- remove all placeholder and old Twilio references from docs and schema naming

## Quick Launch Summary

For production, the real essentials are:

- stable server
- real HTTPS domain
- Exotel Voicebot pointed to that domain
- production secrets
- process manager
- backups

If you want, I can do the next step and make a second document called `PRODUCTION_CHECKLIST.md` with a short client-ready checklist only.
