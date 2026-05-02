# Project Cost Estimate

## Purpose

This document gives a practical cost estimate for the current AI call agent project.

It includes:

- one-time implementation estimate
- recurring monthly platform cost
- cost drivers
- example operating scenarios

## Important Note

This is an estimate, not a final commercial quotation.

Two cost buckets are included:

1. `Build cost`
2. `Monthly running cost`

Monthly running cost depends heavily on:

- number of calls
- average call duration
- AI token consumption
- whether reports and emails are sent daily

## 1. One-Time Build Cost

This section is an engineering estimate based on the current architecture and scope.

### POC Build Estimate

For the current POC scope:

- effort: `10 to 18 working days`
- estimated cost range: `small-team / freelance style estimate only`

Suggested budgeting model:

- `₹75,000 to ₹2,00,000` for a polished POC

This is an inference based on typical small-team internal delivery, not an official market rate.

### Production Upgrade Estimate

If this system is taken to production, expected additional work includes:

- authentication and user roles
- production hosting
- queue workers
- recording storage hardening
- database migration to Postgres
- observability and retry logic
- security / compliance hardening

Suggested production-hardening budget:

- `₹2,50,000 to ₹6,00,000+`

This is also an inference and depends on team rates and compliance needs.

## 2. Monthly Running Cost

## Main Cost Components

### A. Twilio Voice

Current official Twilio India Voice pricing indicates:

- India local outbound voice: `$0.0497 / min`
- India mobile outbound voice: `$0.0405 / min`

For this project, mobile pricing is the more relevant baseline in most cases.

Reference:

- https://www.twilio.com/en-us/voice/pricing/in
- https://www.twilio.com/en-us/pricing/current-rates

### B. Gemini Live / Audio Model

Current official Gemini Developer API pricing shows for native audio Live API:

- input text: `$0.50 / 1M tokens`
- input audio / video: `$3.00 / 1M tokens`
- output text: `$2.00 / 1M tokens`
- output audio: `$12.00 / 1M tokens`

Reference:

- https://ai.google.dev/pricing

Important:

AI cost depends on actual token usage, so the exact monthly amount can only be confirmed from live billing data after real usage starts.

### C. SendGrid Email

Current SendGrid Email API pricing says:

- free plan available
- paid Email API starts at `$19.95 / month`

Reference:

- https://sendgrid.com/en-us/pricing

### D. Phone Number / Environment

Potential additional cost items:

- Twilio phone number rental
- production server / hosting
- domain / SSL
- object storage for recordings

These are not fully included below because they depend on deployment choice.

## Cost Formula

### Voice Cost

```text
Voice Cost = total call minutes x Twilio outbound rate
```

Using India mobile outbound:

```text
Voice Cost = total call minutes x $0.0405
```

### AI Cost

```text
AI Cost = input audio tokens x Gemini input audio price
        + output audio tokens x Gemini output audio price
        + any extra text token usage
```

Because audio token usage varies, use dashboard billing data after pilot usage for precise forecasting.

## Example Monthly Scenarios

These are working estimates with explicit assumptions.

Assumptions:

- 26 working days / month
- average call duration = 3 minutes
- Twilio India mobile outbound pricing = `$0.0405 / min`
- Gemini estimate shown as a range because token usage varies by pacing and interruptions

### Scenario 1: Small Pilot

- 20 calls / day
- 3 minutes / call
- total monthly minutes: `1,560`

Estimated voice cost:

- `1,560 x 0.0405 = $63.18 / month`

Estimated AI cost:

- `~$40 to $120 / month`

Estimated email cost:

- `$0 to $19.95 / month`

Estimated total monthly run cost:

- `~$103 to $203 / month`

### Scenario 2: Medium Operations

- 100 calls / day
- 3 minutes / call
- total monthly minutes: `7,800`

Estimated voice cost:

- `7,800 x 0.0405 = $315.90 / month`

Estimated AI cost:

- `~$200 to $600 / month`

Estimated email cost:

- `$19.95 / month` or free if within limits

Estimated total monthly run cost:

- `~$535 to $936 / month`

### Scenario 3: Larger Daily Follow-Up

- 300 calls / day
- 3 minutes / call
- total monthly minutes: `23,400`

Estimated voice cost:

- `23,400 x 0.0405 = $947.70 / month`

Estimated AI cost:

- `~$600 to $1,800 / month`

Estimated email cost:

- `$19.95+ / month`

Estimated total monthly run cost:

- `~$1,568 to $2,768 / month`

## What Dominates the Cost?

Primary cost drivers:

1. `Call minutes`
2. `AI audio tokens`
3. `Scale of daily usage`

In most real deployments:

- Twilio is the fixed and predictable part
- AI cost is the variable part

## Best Way to Control Cost

To reduce operating cost:

1. Keep calls short: `2 to 3 minutes`
2. Use a tightly scripted conversation
3. End call quickly for no-interest / busy users
4. Run post-call analysis only once per completed call
5. Send reports in digest form instead of large volumes
6. Use lower-cost models where quality remains acceptable

## Recommended Budgeting View for Senior Review

### If this is just a POC

- one-time build budget: `₹75,000 to ₹2,00,000`
- monthly infra budget for pilot: `~$100 to $250`

### If this moves into active business usage

- one-time production-hardening budget: `₹2,50,000 to ₹6,00,000+`
- monthly run cost:
  - small usage: `~$100 to $250`
  - medium usage: `~$500 to $1,000`
  - larger usage: `~$1,500+`

## Recommendation

For internal approval, the safest way to present this project is:

1. approve as `POC first`
2. cap pilot usage to a fixed daily call volume
3. measure real Twilio minutes and Gemini token usage for 2 to 4 weeks
4. then produce a more accurate production forecast

That is the best architecture and budgeting path because AI voice costs become much more accurate after real transcripts and token usage are observed.
