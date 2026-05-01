# Feedback Automation System

## Executive Summary

This project is an outbound customer-feedback automation platform for a diagnostic / collection center.  
It places scheduled or on-demand phone calls, conducts a Hindi-first feedback conversation with an AI voice agent, records the call, extracts structured feedback, stores it in SQLite, and surfaces results in an admin dashboard, JSON APIs, PDF reports, and email summaries.

The current architecture is designed as a practical monolith for fast iteration, with clear seams for future extraction into independent services if scale or compliance requirements grow.

## Business Flow

1. Admin adds customer records and preferred call slots.
2. Scheduler or admin triggers outbound call through Twilio.
3. Twilio connects call audio to the server over Media Streams.
4. Gemini Live handles the real-time Hindi conversation.
5. Twilio records the call.
6. After call completion, the system:
   - stores recording metadata
   - downloads recording locally
   - generates transcript
   - runs transcript analysis
   - detects rating / sentiment / key feedback points
   - upserts structured feedback
7. Dashboard and reports show both raw operational status and business insights.

## High-Level Architecture

```text
Browser Admin UI
  -> Express App (index.js)
     -> Customer APIs
     -> Feedback APIs
     -> Reports APIs
     -> Calls APIs
     -> Twilio Webhooks / Media Stream Endpoints
     -> Scheduler
     -> Post-Call Processing Pipeline

Express App
  -> SQLite (customers, calls, feedback)
  -> Twilio Voice + Recording
  -> Gemini Live (real-time voice conversation)
  -> OpenAI APIs (post-call transcription/analysis helpers, categorization fallback path)
  -> SendGrid (report email)
  -> PDFKit (PDF generation)
```

## Core Components

### 1. Admin Dashboard

File:
- [public/admin.html](/Users/shivaniverma/Desktop/testing/public/admin.html)

Responsibilities:
- customer CRUD
- CSV import
- manual feedback entry
- call triggering
- reporting preview
- feedback intelligence view
- recording playback
- analysis detail modal

### 2. Application Server

File:
- [index.js](/Users/shivaniverma/Desktop/testing/index.js)

Responsibilities:
- Express bootstrap
- Twilio call initiation
- TwiML generation
- Twilio status callbacks
- Twilio recording callbacks
- WebSocket bridge between Twilio and Gemini/OpenAI realtime
- scheduler loop
- recent call API
- orchestration of post-call pipeline

### 3. Database Layer

File:
- [db.js](/Users/shivaniverma/Desktop/testing/db.js)

Storage:
- `customers`
- `calls`
- `feedback`

Important `calls` fields:
- call lifecycle: `twilio_sid`, `outcome`, `called_at`
- recording: `recording_sid`, `recording_url`, `recording_local_path`, `recording_status`
- transcript: `transcript_text`, `transcript_status`, `transcript_source`
- analysis: `analysis_status`, `analysis_summary`, `analysis_json`, `key_points_json`, `report_excerpt`
- extraction: `extracted_rating`, `extracted_review_text`, `language`, `consent_detected`

Important `feedback` fields:
- `customer_id`
- `call_id`
- `review_text`
- `category`
- `stars`
- `source` (`manual` or `call`)

### 4. Real-Time Voice Layer

Primary runtime:
- Gemini Live API

Fallback / alternate runtime:
- OpenAI Realtime path remains available in code design

Responsibilities:
- conduct multi-turn phone conversation
- ask business-scripted questions
- respond in Hindi
- support interruption / live turn-taking
- emit live transcript chunks

### 5. Post-Call Pipeline

File:
- [services/post-call-pipeline.js](/Users/shivaniverma/Desktop/testing/services/post-call-pipeline.js)

Pipeline stages:
- fetch call record
- download protected Twilio recording
- local recording storage under `/tmp/feedback-call-recordings`
- speech-to-text
- transcript analysis
- feedback upsert
- call record enrichment

This is the most important architectural addition because it decouples business reporting quality from noisy live-stream transcript quality.

### 6. Feedback Intelligence

Files:
- [services/call-feedback.js](/Users/shivaniverma/Desktop/testing/services/call-feedback.js)
- [services/openai.js](/Users/shivaniverma/Desktop/testing/services/openai.js)

Responsibilities:
- heuristic extraction from transcript
- rating detection
- language detection
- category assignment
- analysis-agent style structured summary generation

### 7. Reporting

Files:
- [routes/reports.js](/Users/shivaniverma/Desktop/testing/routes/reports.js)
- [services/pdf.js](/Users/shivaniverma/Desktop/testing/services/pdf.js)
- [services/email.js](/Users/shivaniverma/Desktop/testing/services/email.js)

Outputs:
- dashboard preview JSON
- downloadable PDF
- email report

## End-to-End Data Flow

```text
Customer Record
  -> Call Triggered
  -> Twilio Call SID stored
  -> Twilio Media Stream connects
  -> AI Conversation runs
  -> Twilio Recording completes
  -> Recording callback updates calls table
  -> Post-call pipeline downloads recording
  -> Transcript generated
  -> Analysis JSON generated
  -> Feedback row inserted or updated
  -> Dashboard / Report / Email consume results
```

## APIs of Interest

### Operations
- `POST /call/start`
- `POST /api/calls/initiate/:customerId`
- `GET /api/calls/recent`

### Webhooks
- `GET /call/twiml`
- `POST /call/status`
- `POST /call/recording-status`
- `WS /call/stream`

### Business Data
- `GET /api/customers`
- `POST /api/customers`
- `POST /api/customers/csv`
- `GET /api/feedback`
- `POST /api/feedback/manual`
- `GET /api/reports/preview`
- `POST /api/reports/generate`
- `GET /api/reports/download`

## Architectural Strengths

- Single deployable unit keeps local iteration fast.
- Clear separation between:
  - real-time call handling
  - post-call processing
  - reporting
  - dashboard rendering
- Recording-backed pipeline improves reliability over live transcript alone.
- Feedback storage is normalized enough for reporting without overengineering.
- UI and backend are tightly aligned for demos and operational usage.

## Current Limitations

- SQLite is fine for local/small-team use but not ideal for higher concurrency or audit/compliance-heavy workloads.
- Real-time STT quality can still drift during live conversation.
- Post-call STT and analysis depend on external AI availability and key/billing status.
- Background jobs currently run inside the main Node process rather than a separate worker queue.
- No authentication / RBAC around admin panel yet.

## Recommended Next Improvements

### Near Term
- move all post-call processing to a durable async job queue
- add retry and dead-letter strategy for recording download / STT / analysis
- expose transcript preview in dashboard
- add admin auth
- add observability around:
  - call start success rate
  - recording callback success rate
  - transcript completion rate
  - analysis completion rate

### Medium Term
- replace SQLite with Postgres
- split post-call pipeline into worker service
- store recordings in object storage instead of `/tmp`
- add structured JSON schema validation for analysis output
- add tenant/client separation if productized for multiple labs

## Senior Review Notes

If this were being prepared for production hardening, the top 3 priorities would be:

1. Reliability  
Move recording download, transcription, and analysis into a queue-backed worker model.

2. Data / compliance  
Move recordings and transcripts into managed storage with retention controls and access policy.

3. Accuracy  
Use recording-based transcription as source of truth and validate structured analysis output before feedback upsert.

## Code Map

- App entrypoint: [index.js](/Users/shivaniverma/Desktop/testing/index.js)
- DB + migrations: [db.js](/Users/shivaniverma/Desktop/testing/db.js)
- Dashboard UI: [public/admin.html](/Users/shivaniverma/Desktop/testing/public/admin.html)
- Customers routes: [routes/customers.js](/Users/shivaniverma/Desktop/testing/routes/customers.js)
- Feedback routes: [routes/feedback.js](/Users/shivaniverma/Desktop/testing/routes/feedback.js)
- Reports routes: [routes/reports.js](/Users/shivaniverma/Desktop/testing/routes/reports.js)
- Real-time feedback extraction: [services/call-feedback.js](/Users/shivaniverma/Desktop/testing/services/call-feedback.js)
- Post-call orchestration: [services/post-call-pipeline.js](/Users/shivaniverma/Desktop/testing/services/post-call-pipeline.js)
- AI helper services: [services/openai.js](/Users/shivaniverma/Desktop/testing/services/openai.js)
- PDF service: [services/pdf.js](/Users/shivaniverma/Desktop/testing/services/pdf.js)
- Email service: [services/email.js](/Users/shivaniverma/Desktop/testing/services/email.js)
