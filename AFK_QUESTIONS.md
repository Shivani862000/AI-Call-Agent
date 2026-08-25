# AFK Questions

This file records decisions that do not block the security and data-preservation work already approved in the Webmaster Console plan.

1. What production email identity and SMTP provider should lifecycle notifications use? The implementation can keep the existing environment fallback until this is supplied.
2. Which existing account should become the first persisted `WEBMASTER` Owner after deployment? The legacy `ADMIN_USERNAME` remains an Owner until then.
3. What exact tenant plans and default limits (users, calls, storage/retention classifications) should be configured for production?
4. Which integrations should be enabled in production first: iCallMate, OpenAI/Gemini, Deepgram, SMTP, Slack, and webhooks?
5. Should the production deployment include a documented one-time migration for archived legacy records, or should legacy records remain `active` unless an administrator archives them?
6. Should lifecycle notification retry be manual-only at launch, or should a scheduled retry worker be enabled after SMTP acceptance criteria are confirmed?
7. What branding name and primary color should replace the neutral VikiTech defaults for production?
8. What dedicated 32+ byte `AUTH_SIGNING_SECRET` should production use? The local preview intentionally uses an ephemeral development key when it is absent.

## Assumptions used while you are away

- The approved Webmaster Console design and implementation plan remain the target.
- Security, privacy, and archival invariants take priority over UI polish.
- No real secrets, credentials, PII, or PHI will be placed in the repository.
- Legacy records remain active unless an administrator explicitly archives them.
- Notification failures are retained for operator review; automatic retry is deferred until the delivery policy is confirmed.
- Manual notification retry is available immediately; no unattended retry loop is enabled without an approved backoff and SMTP acceptance policy.
- The neutral VikiTech visual identity and `Asia/Kolkata` tenant default are used until production branding/defaults are supplied.
