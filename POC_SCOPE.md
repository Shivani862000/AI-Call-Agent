# AI Call Agent POC

## Objective

Build a working proof of concept for an AI-powered outbound feedback calling system for a diagnostic / pathology collection center.

The POC should prove that the system can:

1. Trigger outbound calls automatically or manually.
2. Prioritize customers before dialing based on business value and urgency.
3. Run a Hindi-first AI conversation with the customer.
4. Record the call.
5. Generate transcript and key insights after the call.
6. Save structured feedback into the system.
7. Trigger fallback workflows such as retry, WhatsApp, and admin review.
8. Show results in the admin dashboard.
9. Generate a PDF / email report for daily review and weekly review.

## POC Problem Statement

Today, patient feedback is often collected manually, inconsistently, or not at all.  
This POC demonstrates how an AI voice agent can automate the follow-up process and convert calls into usable operational feedback.

## In-Scope Features

### 1. Admin Dashboard

- Add customer manually
- Upload customers by CSV
- Edit / delete customer
- Schedule call time
- Set customer value and urgency
- Manage DND and consent status
- Flag wrong number
- Schedule retry manually
- Trigger call instantly
- View recent feedback
- View call pipeline status
- Play call recordings
- Download report

### 2. AI Voice Call

- Outbound call using Twilio
- Hindi-first conversational agent
- Short feedback survey
- Collect customer rating
- Ask open-ended improvement feedback
- Handle answered / no-answer / busy / declined states

### 3. Pre-Call Scoring and Workflow Control

- AI-style pre-call scoring
- Priority queue ordering
- Retry queue scheduling
- Callback scheduling
- DND / denied-consent blocking
- Wrong-number admin review flow

### 4. Call Intelligence Pipeline

- Twilio call recording
- Recording callback capture
- Store recording metadata
- Transcript generation
- Analysis agent summary
- Rating extraction
- Review text extraction
- Sentiment label
- Follow-up task generation
- Pending / completed pipeline statuses

### 5. CRM / Follow-Up Automation

- CRM-style webhook payload on post-call completion
- Hot lead alert email
- WhatsApp summary after completed call

### 6. Reporting

- Dashboard preview
- PDF report
- Email report
- Weekly AI summary email
- Call details with recording / transcript links

## Out of Scope for POC

- Production-grade authentication / RBAC
- Multi-tenant client isolation
- Payment gateway
- Hospital / LIS / HIS integration
- Advanced retry queue / dead-letter jobs
- Cloud object storage for recordings
- Compliance-grade encryption / audit trail
- SLA-backed deployment
- Revenue attribution model with real billing/lead closure integration

## Target Users

- Diagnostic center owner
- Operations manager
- Front-desk / quality team
- Admin who schedules and reviews calls

## Proposed POC Flow

```text
Admin adds customer
  -> customer scored by value + urgency
  -> eligible customer enters priority queue
  -> blocked if DND / wrong number / denied consent
  -> customer scheduled or called manually
  -> Twilio places outbound call
  -> Gemini voice agent speaks to customer
  -> call is recorded
  -> transcript is generated
  -> analysis extracts rating, summary, sentiment, and key points
  -> outcome workflow decides retry / callback / hot lead / admin review
  -> feedback is saved in database
  -> CRM webhook + WhatsApp summary can be triggered
  -> dashboard + PDF + email reflect the result
```

## Success Criteria

The POC is successful if it demonstrates all of the following:

1. Admin can create and schedule a customer call from UI.
2. System assigns priority / workflow metadata before call.
3. Outbound call is placed successfully.
4. AI agent conducts a Hindi conversation.
5. Call recording is available after completion.
6. Transcript and post-call analysis are generated.
7. Feedback is stored against the correct customer / call.
8. Retry / busy / wrong-number workflows are triggered correctly.
9. Dashboard shows updated insights.
10. Report can be downloaded and emailed.

## Key Deliverables

- Working Node.js application
- Admin dashboard UI
- Twilio call integration
- Gemini live voice integration
- Priority and retry workflow engine
- Post-call analysis pipeline
- CRM-style sync webhook payload
- Hot lead alert + weekly summary flows
- SQLite-backed data storage
- Daily reporting flow
- Architecture documentation

## Suggested Demo Script

1. Open admin dashboard.
2. Add a customer with value, urgency, and slot.
3. Trigger a manual call.
4. Customer answers and AI collects feedback in Hindi.
5. Show recording availability.
6. Open transcript / analysis details.
7. Show saved review and follow-up status in dashboard.
8. Show DND / retry / wrong-number controls.
9. Download the generated PDF report.

## POC Timeline Estimate

This is an implementation estimate, not a fixed commercial quote.

- Setup and core calling flow: 3 to 5 days
- Dashboard and CRUD: 2 to 4 days
- Recording + transcript + analysis pipeline: 3 to 5 days
- Reporting + polish + testing: 2 to 4 days

Estimated POC effort:

- `10 to 18 working days`

## POC Risks / Dependencies

- Twilio trial restrictions on unverified numbers
- AI API quota / billing availability
- Speech-to-text quality for noisy calls
- Network quality during real-time voice sessions
- Hindi transcription accuracy
- CRM webhook endpoint availability for sync scenarios

## Recommended Next Step After POC

If the POC is approved, the next phase should focus on:

- production hosting
- login/auth
- worker queue for post-call jobs
- object storage for recordings
- Postgres migration
- client-specific templates / prompts
- retry / escalation workflow
- analytics and SLA monitoring
- revenue attribution and lead-conversion tracking
