# Architecture & API Reference

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Admin Dashboard                           │
│              (public/admin.html - Browser)                  │
│  - Customer management (add, delete, CSV upload)            │
│  - Manual feedback entry                                     │
│  - Report generation & download                              │
│  - Real-time stats display                                   │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                 Express.js Server                             │
│                 (index.js - Port 3000)                       │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Middleware: CORS, Body Parser, Static Files          │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Routes                                                │   │
│  │  ├─ /api/customers    → routes/customers.js          │   │
│  │  ├─ /api/calls        → routes/calls.js              │   │
│  │  ├─ /api/twiml        → routes/twiml.js              │   │
│  │  ├─ /api/whatsapp     → routes/whatsapp.js           │   │
│  │  ├─ /api/feedback     → routes/feedback.js           │   │
│  │  └─ /api/reports      → routes/reports.js            │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Scheduled Jobs (node-cron)                           │   │
│  │  ├─ Every minute: Check for pending calls            │   │
│  │  └─ Daily 20:00: Generate & email report            │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
         │                        │                    │
         ▼                        ▼                    ▼
    ┌─────────┐          ┌──────────────┐        ┌──────────┐
    │ Database │          │ AI Services   │        │ External │
    │(Supabase │          │(OpenAI GPT-4o)│        │Services  │
    │Postgres) │          │               │        │          │
    │          │          │               │        │          │
    │tables:   │          │-Call scripts  │        │-Twilio   │
    │·customers│          │-Categorize    │        │-SendGrid │
    │·calls    │          │ feedback      │        │-ngrok    │
    │·feedback │          └──────────────┘        └──────────┘
    └─────────┘
```

---

## Post-Call Intelligence Flow

```
Call
  -> Twilio Recording
  -> Recording URL stored in calls table
  -> Recording downloaded to local storage (/tmp/feedback-call-recordings)
  -> Speech-to-Text
  -> Analysis Agent
      -> summary
      -> key points
      -> sentiment
      -> rating
      -> review_text
  -> Feedback upsert
  -> Reporting
      -> JSON preview
      -> PDF
      -> Email
      -> UI dashboard
```

## Call Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Admin UI or Cron Job                                         │
│    Clicks "Call Now" or time matches preferred_slot            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
        POST /api/calls/initiate/:customerId
                           │
        ┌──────────────────┴──────────────────┐
        │ twilio.initiateCall())              │
        │  - From: TWILIO_PHONE_NUMBER        │
        │  - To: customer.phone               │
        │  - TwiML URL: /api/twiml/intro      │
        │  - Status callback: /api/calls/status
        └──────────────┬───────────────────────┘
                       │
                       ▼ Twilio Voice API
        ┌──────────────────────────────────────┐
        │ Customer's Phone Rings               │
        └──────────────┬───────────────────────┘
                       │
        ┌──────────────┴──────────────────────┐
        │ Customer Answers                    │
        │ Twilio fetches TwiML from server    │
        └──────────────┬───────────────────────┘
                       │
                       ▼
        GET /api/twiml/intro?customerId={id}
                       │
        ┌──────────────┴──────────────┐
        │ openai.generateCallScript() │
        │ Input: Customer name        │
        │ Output: 2-3 sentence greeting
        └──────────────┬──────────────┘
                       │
                       ▼
        <Response>
          <Say>Hi John! Thank you for choosing us...</Say>
          <Gather numDigits="1" action="/api/twiml/gather">
            <Say>Press 1 for review link, press 2 to skip</Say>
          </Gather>
        </Response>
                       │
        ┌──────────────┴───────────────────────┐
        │ Customer presses digit on phone      │
        └──────────────┬───────────────────────┘
                       │
                       ├── Press 1 ──┐
                       │              │
                       │              ▼
                       │    POST /api/twiml/gather
                       │      Digits="1"
                       │              │
                       │              ▼
                       │    ┌──────────────────────┐
                       │    │ outcome = "consent"  │
                       │    │ Call → whatsapp/send │
                       │    └──────────────────────┘
                       │              │
                       │              ▼
                       │    POST /api/whatsapp/send/:callId
                       │      (twilio.sendWhatsAppMessage)
                       │              │
                       │              ▼
                       │    ┌──────────────────────┐
                       │    │ WhatsApp Message     │
                       │    │ with review link     │
                       │    └──────────────────────┘
                       │
                       ├── Press 2 ──┐
                       │              │
                       │              ▼
                       │    POST /api/twiml/gather
                       │      Digits="2"
                       │              │
                       │              ▼
                       │    ┌──────────────────────┐
                       │    │ outcome = "declined" │
                       │    └──────────────────────┘
                       │
                       ▼
        <Response>
          <Say>Thank you. Have a great day!</Say>
          <Hangup></Hangup>
        </Response>
```

---

## Request/Response Examples

### Add Customer
```bash
POST /api/customers
Content-Type: application/json

{
  "name": "John Doe",
  "phone": "+919876543210",
  "preferred_slot": "14:30"
}

Response: 200 OK
{
  "id": 1,
  "message": "Customer added successfully"
}
```

### Bulk Import CSV
```bash
POST /api/customers/csv
Content-Type: multipart/form-data

file: customers.csv (with columns: name, phone, preferred_slot)

Response: 200 OK
{
  "message": "CSV import completed",
  "successCount": 5,
  "errorCount": 0,
  "totalRows": 5
}
```

### Initiate Call
```bash
POST /api/calls/initiate/1
(no body)

Response: 200 OK
{
  "message": "Call initiated",
  "callId": 42,
  "sid": "CA1234567890abcdef"
}
```

### TwiML Intro (Twilio fetches this)
```bash
GET /api/twiml/intro?customerId=1

Response: 200 OK (text/xml)
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Hi John! Thank you for choosing us. We would love to hear your feedback...</Say>
  <Gather numDigits="1" action="http://localhost:3000/api/twiml/gather?customerId=1" method="POST">
    <Say>Press 1 to receive a review link, or press 2 to skip.</Say>
  </Gather>
  <Say>We didn't receive your input. Goodbye.</Say>
  <Hangup></Hangup>
</Response>
```

### TwiML Gather (Twilio sends digit)
```bash
POST /api/twiml/gather?customerId=1
Content-Type: application/x-www-form-urlencoded

CallSid=CA1234567890abcdef&Digits=1

Response: 200 OK (text/xml)
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Thank you. Have a great day!</Say>
  <Hangup></Hangup>
</Response>
```

### Call Status Callback (Twilio sends this)
```bash
POST /api/calls/status
Content-Type: application/x-www-form-urlencoded

CallSid=CA1234567890abcdef&CallStatus=no-answer

Response: 200 OK (text/xml)
<?xml version="1.0" encoding="UTF-8"?>
<Response></Response>
```

### Send WhatsApp
```bash
POST /api/whatsapp/send/42

Response: 200 OK
{
  "message": "WhatsApp sent successfully",
  "sid": "SM1234567890abcdef"
}
```

### Manual Feedback Entry
```bash
POST /api/feedback/manual
Content-Type: application/json

{
  "customer_id": 1,
  "review_text": "Excellent service, highly recommend!",
  "stars": 5
}

Response: 200 OK
{
  "id": 12,
  "category": "good",
  "reason": "5 stars, positive sentiment"
}
```

### Get Feedback List
```bash
GET /api/feedback

Response: 200 OK
[
  {
    "id": 12,
    "customer_id": 1,
    "customer_name": "John Doe",
    "review_text": "Excellent service, highly recommend!",
    "category": "good",
    "stars": 5,
    "submitted_at": "2024-01-15T18:30:00.000Z"
  }
]
```

### Report Preview
```bash
GET /api/reports/preview

Response: 200 OK
{
  "date": "2024-01-15",
  "total_calls": 5,
  "answered": 4,
  "no_answer": 1,
  "declined": 1,
  "consent_given": 3,
  "whatsapp_sent": 3,
  "feedback_count": 2,
  "good_count": 1,
  "average_count": 1,
  "bad_count": 0,
  "feedback": [
    {
      "customer_name": "John Doe",
      "category": "good",
      "stars": 5,
      "review_excerpt": "Excellent service!",
      "submitted_at": "2024-01-15T18:30:00.000Z"
    }
  ]
}
```

### Generate Report (PDF + Email)
```bash
POST /api/reports/generate
(no body)

Response: 200 OK
{
  "success": true,
  "path": "/tmp/report_2024-01-15.pdf",
  "message": "Report generated and emailed successfully"
}
```

---

## Database Schema

### customers
```sql
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) NOT NULL UNIQUE,      -- E.164 format: +919876543210
  preferred_slot VARCHAR(10) DEFAULT '10:00',  -- HH:MM in 24h format
  status VARCHAR(20) DEFAULT 'pending',   -- pending | called | no_answer | declined
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sample data
INSERT INTO customers VALUES (1, 'John Doe', '+919876543210', '14:30', 'pending', '2024-01-15 10:00:00');
```

### calls
```sql
CREATE TABLE calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  called_at TIMESTAMP,
  outcome VARCHAR(20),        -- initiated | answered | no_answer | declined | consent_given
  twilio_sid VARCHAR(100),
  whatsapp_sent BOOLEAN DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

-- Sample data
INSERT INTO calls VALUES (1, 1, '2024-01-15 14:30:00', 'consent_given', 'CA123...', 1, '2024-01-15 14:30:00');
```

### feedback
```sql
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  call_id INTEGER,
  review_text TEXT,
  category VARCHAR(10),      -- good | average | bad
  stars INTEGER,             -- 1-5
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (call_id) REFERENCES calls(id)
);

-- Sample data
INSERT INTO feedback VALUES (1, 1, 1, 'Excellent service!', 'good', 5, '2024-01-15 18:30:00');
```

---

## Environment Variables Reference

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `TWILIO_ACCOUNT_SID` | Yes | `AC1234567890abcdef` | Twilio account identifier |
| `TWILIO_AUTH_TOKEN` | Yes | `auth_token_here` | Twilio authentication token |
| `TWILIO_PHONE_NUMBER` | Yes | `+15551234567` | Your Twilio phone (E.164 format) |
| `TWILIO_WHATSAPP_FROM` | Yes | `whatsapp:+14155238886` | WhatsApp sandbox number |
| `OPENAI_API_KEY` | Yes | `sk-...` | OpenAI API key for GPT-4o |
| `SENDGRID_API_KEY` | Yes | `SG....` | SendGrid API key |
| `OWNER_EMAIL` | Yes | `owner@example.com` | Email for reports |
| `GOOGLE_REVIEW_LINK` | Yes | `https://g.page/r/...` | Google Business review URL |
| `CLIENT_NAME` | Yes | `My Business` | Used in scripts & reports |
| `SUPABASE_DB_URL` | Yes | `postgresql://...` | Hosted Supabase Postgres runtime connection |
| `SUPABASE_DB_CA_CERT` | Yes | `-----BEGIN CERTIFICATE-----...` | Provider CA used for strict TLS verification |
| `SUPABASE_URL` | Yes | `https://project.supabase.co` | Supabase Auth project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Yes | `publishable-key` | Supabase Auth browser-safe project key used server-side |
| `COOKIE_SECRET` | Yes | `32-or-more-random-characters` | Signs application sessions |
| `PORT` | No | `3000` | Server port (default: 3000) |
| `NODE_ENV` | No | `development` | Environment (development/production) |
| `WEBHOOK_URL` | No | `https://abc123.ngrok.io` | External webhook URL (for Twilio) |

---

## Error Handling

The system returns standard HTTP status codes:

- `200 OK` — Successful request
- `400 Bad Request` — Missing/invalid parameters
- `404 Not Found` — Resource not found
- `500 Internal Server Error` — Server error (check console logs)

All error responses include an `error` field:
```json
{
  "error": "Customer not found"
}
```

---

## Performance & Scaling

**Current (Supabase Postgres + Single Application Replica):**
- ~100-1000 customers
- ~10-100 calls/day
- Real-time admin dashboard

**Future scale-out:**
- ~10,000+ customers
- ~1000+ calls/day
- Use connection pooling (pg-pool)
- Add rate limiting middleware
- Separate cron jobs to background worker
- Use message queue (Bull/BullMQ) for async tasks

---

## Security Considerations

1. **Authentication**: Add JWT or session middleware to `/admin`
2. **Rate Limiting**: Use `express-rate-limit` on API routes
3. **Input Validation**: Validate email, phone, text inputs
4. **HTTPS**: Use in production (SSL certificate required)
5. **Secrets**: Never commit `.env` file
6. **CORS**: Restrict to specific origins in production
7. **Database**: Use strong passwords, enable SSL for PostgreSQL

---

## Monitoring & Logging

For production, add:
- **Error tracking**: Sentry
- **Logging**: Winston or Morgan
- **APM**: New Relic or Datadog
- **Uptime monitoring**: Pingdom/Uptime Robot
- **Alert system**: PagerDuty for critical failures

---

**Last Updated**: January 2024
