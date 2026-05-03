# DigitalOcean Deployment Guide

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

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_WHATSAPP_FROM=

CALL_MODE=gemini
GEMINI_API_KEY=
GEMINI_MODEL=models/gemini-3.1-flash-live-preview
GEMINI_VOICE=Kore

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
- Gemini session connected
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
- Gemini API
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

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_WHATSAPP_FROM=

CALL_MODE=gemini
GEMINI_API_KEY=
GEMINI_MODEL=models/gemini-3.1-flash-live-preview
GEMINI_VOICE=Kore

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
- verify recording callback works
- verify `/api/reports/owner-preview`

## Nginx WebSocket Note
This app requires WebSocket proxying for Twilio media streams and Gemini bridge stability.

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
- DB: Managed PostgreSQL
- Storage: Spaces
- TLS: Nginx + Let's Encrypt
- Process management: PM2/systemd
- Monitoring: PM2 + DO monitoring

## Go/No-Go Recommendation

### Deploy now
Yes, on:

- `1 DigitalOcean Droplet`

### Do not deploy current version as multi-instance PaaS yet
Avoid until:

- scheduler is separated
- SQLite is replaced
- recording storage is externalized
