# Azure Deployment Guide

## Fastest Recommended Azure Path
If you want Azure now, the cleanest practical path is:

1. Azure App Service on Linux
2. single app instance
3. Azure PostgreSQL Flexible Server preferred
4. custom domain + HTTPS

---

## Step-by-Step Deployment Checklist

### Before you start
Keep these ready:

- Azure subscription
- GitHub repo URL
- Twilio credentials
- Gemini API key
- SendGrid API key
- owner email
- domain if using custom domain

### Step 1. Create Resource Group
In Azure Portal:

1. Go to `Resource groups`
2. Click `Create`
3. Choose region
4. Name it something like `rg-ai-call-agent`

### Step 2. Create App Service Plan

1. Go to `App Service Plans`
2. Click `Create`
3. OS: `Linux`
4. Pricing tier: at least `Basic` or `Standard`

Use Standard if you want better production stability.

### Step 3. Create Web App

1. Go to `App Services`
2. Click `Create`
3. Select the resource group
4. Runtime stack: `Node 20 LTS`
5. OS: `Linux`
6. Choose the App Service Plan created above
7. Create app name like `ai-call-agent-prod`

Your default URL will be:

```text
https://ai-call-agent-prod.azurewebsites.net
```

### Step 4. Create PostgreSQL Flexible Server
Recommended even if app still has SQLite assumptions.

1. Go to `Azure Database for PostgreSQL flexible server`
2. Click `Create`
3. Choose small burstable or general purpose tier
4. Save:
   - hostname
   - db name
   - username
   - password

If you are not migrating to Postgres right now, keep this as planned phase 2.

### Step 5. Configure App Settings
In App Service:

1. Open your app
2. Go to `Environment variables` / `Configuration`
3. Add these keys

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

WEBHOOK_URL=https://ai-call-agent-prod.azurewebsites.net
NGROK_URL=https://ai-call-agent-prod.azurewebsites.net

OWNER_EMAIL=
OWNER_PHONE=
SENDGRID_API_KEY=
GOOGLE_REVIEW_LINK=
CLIENT_NAME=
```

Important:

- use the Azure app URL, not ngrok
- do not commit production secrets

### Step 6. Set startup command
In App Service configuration, if needed:

```bash
node index.js
```

### Step 7. Deploy code
Choose one:

#### Option A: GitHub deployment
1. Open App Service
2. Go to `Deployment Center`
3. Connect GitHub repo
4. Select branch
5. Save and deploy

#### Option B: Zip deploy
Build a zip of repo and deploy using Azure zip deployment.

### Step 8. Restart app
After deployment:

1. Go to App Service
2. Click `Restart`

### Step 9. Check app logs
In App Service:

1. Go to `Log stream`
2. Verify app starts correctly

You want to see app startup logs like:

- server running
- scheduler active
- owner digest active

### Step 10. Verify endpoints
Open:

- `https://ai-call-agent-prod.azurewebsites.net/admin.html`
- `https://ai-call-agent-prod.azurewebsites.net/api/customers`
- `https://ai-call-agent-prod.azurewebsites.net/api/reports/owner-preview`

### Step 11. Update Twilio webhook
Point Twilio to:

- `https://ai-call-agent-prod.azurewebsites.net/call/twiml`

### Step 12. Run a test call
Verify:

- TwiML loads
- media stream opens
- Gemini connects
- recording callback comes back
- transcript + analysis pipeline completes

### Step 13. Add custom domain
If using your own domain:

1. Go to `Custom domains`
2. Add `calls.yourdomain.com`
3. create DNS records as Azure asks
4. bind certificate

### Step 14. Enable HTTPS only
In App Service:

1. go to TLS/SSL settings
2. enforce HTTPS only

### Step 15. Post-deploy validation
Check:

- admin page loads
- feedback table loads
- owner command center loads
- recording proxy works
- weekly report downloads
- owner digest can be sent manually

---

## Goal
Deploy the current AI call agent stack on Azure with:

- public HTTPS endpoint for Twilio
- WebSocket support for media streaming
- persistent Node.js runtime
- database persistence
- admin dashboard access

## Current Codebase Reality
This project currently includes:

- Node.js + Express app in [index.js](/Users/shivaniverma/Desktop/testing/index.js)
- Twilio webhooks and WebSocket stream handling
- Gemini live integration
- internal scheduler and owner digest in the app process
- SQLite file database
- temporary local recording download path

Because of that, Azure deployment should be planned carefully.

## Recommended Azure Option
### Option A: Azure App Service (Linux) + Azure PostgreSQL
This is the best managed Azure path.

Why:

- Azure App Service on Linux supports WebSockets
- easy environment variable management
- custom domain + TLS is straightforward
- Azure Database for PostgreSQL is a good managed database target

## Strong Recommendation Before Full Production
If you want a clean production Azure deployment:

1. migrate SQLite to PostgreSQL
2. move recordings to object storage
3. separate scheduler/digest jobs from the web instance

Until then, Azure can still host the app, but it is less clean than a single VM deployment.

## Recommended Infra

### App
- Azure App Service on Linux
- Node.js runtime or custom container

### Database
- Azure Database for PostgreSQL Flexible Server

### Storage
- optional Azure Blob Storage for recordings

### Jobs
For later hardening:

- Azure WebJobs
or
- Azure Container Apps Jobs

## Azure Services Needed

- App Service Plan
- Web App (Linux)
- Azure Database for PostgreSQL Flexible Server
- Storage Account optional
- Key Vault optional
- Application Insights optional

## Env Vars Needed

```env
PORT=3000
NODE_ENV=production
DATABASE_URL=<sqlite path for temporary phase OR postgres url after migration>

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_WHATSAPP_FROM=

CALL_MODE=gemini
GEMINI_API_KEY=
GEMINI_MODEL=models/gemini-3.1-flash-live-preview
GEMINI_VOICE=Kore

WEBHOOK_URL=https://your-app.azurewebsites.net
NGROK_URL=https://your-app.azurewebsites.net

OWNER_EMAIL=
OWNER_PHONE=
SENDGRID_API_KEY=
GOOGLE_REVIEW_LINK=
CLIENT_NAME=
```

## App Service Deployment Steps

### Step 1. Create App Service Plan
- Linux plan
- Basic or Standard minimum for stable long-running app

### Step 2. Create Web App
- Runtime: Node.js 20 LTS
- Region close to users/Twilio usage

### Step 3. Configure application settings
In App Service > Environment Variables / App Settings, add:

- Twilio vars
- Gemini vars
- SendGrid vars
- owner vars
- `WEBHOOK_URL`
- `NODE_ENV=production`

### Step 4. Deploy code
Options:

- GitHub deployment
- Zip deploy
- Azure CLI

### Step 5. Startup command
If needed:

```bash
node index.js
```

### Step 6. Verify WebSocket support
Azure App Service Linux supports WebSockets on Linux apps.  
Reference: [App Service on Linux FAQ](https://learn.microsoft.com/en-us/troubleshoot/azure/app-service/faqs-app-service-linux-new)

### Step 7. Point Twilio
Use:

- `https://your-app.azurewebsites.net/call/twiml`

## Database Recommendation

### Short-term
You can technically keep SQLite for a small test, but it is not recommended on App Service for production reliability.

### Recommended
Use Azure Database for PostgreSQL Flexible Server.  
Reference: [Azure Database for PostgreSQL Flexible Server](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/overview)

## Best Azure Production Pattern

### Web tier
- Azure App Service (single instance initially)

### DB tier
- Azure PostgreSQL Flexible Server

### Background jobs
Later split scheduler/digest into:

- Azure WebJobs if staying on App Service
- or Azure Container Apps Jobs for scheduled cron-style work

References:

- [Azure WebJobs overview](https://learn.microsoft.com/en-us/azure/app-service/overview-webjobs)
- [Azure Container Apps Jobs](https://learn.microsoft.com/en-us/azure/container-apps/jobs)

## Health / Validation Checklist

After deploy, verify:

- `/admin.html`
- `/api/customers`
- `/api/reports/owner-preview`
- Twilio call test
- recording callback
- transcript generation
- owner digest send route

## Risks With Current Code on Azure

### 1. SQLite on managed web hosting
Not ideal for:

- persistent production state
- app restarts
- scale-out

### 2. In-process scheduler
If Azure scales to more than one instance:

- scheduler can fire more than once
- duplicate retries / digests can happen

### 3. Local temp recordings
Temporary filesystem is fine for short processing, but not for long archive strategy.

## Better Azure Architecture

### Phase 1
- App Service Linux
- single instance
- current app
- PostgreSQL preferred

### Phase 2
- App Service or Container App
- PostgreSQL Flexible Server
- Blob Storage for recordings
- WebJobs / Container Apps Jobs for scheduled tasks
- optional Key Vault for secrets
- optional App Insights for observability

## Azure vs DigitalOcean For This Codebase

### Azure wins when
- you want managed enterprise infrastructure
- you already use Microsoft stack
- you want PostgreSQL + monitoring + managed jobs in one cloud

### Azure is less ideal right now when
- you want the fastest low-friction first deployment
- you want to keep SQLite temporarily
- you want simplest WebSocket + scheduler behavior

## Final Recommendation

### Best quick production-like deployment
- DigitalOcean Droplet

### Best long-term managed cloud target
- Azure App Service + Azure PostgreSQL Flexible Server

If choosing Azure today, I recommend:

1. App Service Linux
2. PostgreSQL Flexible Server
3. single app instance only
4. later split scheduler into WebJob or Container Apps Job
