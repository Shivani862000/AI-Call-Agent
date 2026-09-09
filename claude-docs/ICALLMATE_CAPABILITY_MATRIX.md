# iCallMate Capability Evidence and Operating Restrictions

Updated 9 September 2026. Sources inspected: `services/icallmate.js`, `src/icallmate-webhook.js`, `src/icallmate-protocol.js`, `src/api-routes.js`, and `claude-docs/ICALLMATE_INTEGRATION.md`. Official-domain searches for callback metadata, `s_unique`, and `setMasterPostAPI` yielded no additional public contract. No provider endpoint or account was called.

`Implemented locally` establishes application behavior only. `Unknown externally` requires vendor documentation or a redacted observed fixture; it does not mean unsupported.

| Capability | Local evidence | External status | Required behavior until verified |
| --- | --- | --- | --- |
| Callback authentication | App generates query secret and verifies header/query with timing-safe comparison | Exact configured provider forwarding unknown | Canonical callback rejects missing/invalid credentials; legacy callbacks default disabled. |
| Legacy `/call/status` and `/call/recording-status` consumers | Handlers exist; current application URL generation uses canonical callback | Dashboard/older integrations unknown | Enable only after proving compatible authenticated delivery. |
| Unique per-attempt ID | Adapter accepts SID and also campaign ID; can fabricate fallback IDs | Uniqueness/account scope/echo unknown | Never treat campaign ID or generated fallback as proven unique provider identity. |
| Attempt metadata echo | Requests contain `extraparam` and campaign `s_unique` | Preservation through media/callback unknown | Send durable opaque attempt identity; accept only unambiguous correlated events. Quarantine unknown/conflicting identity. |
| Idempotent submission | No proven idempotency-key contract in adapter | Unknown | One locally reserved submission; uncertainty goes to manual reconciliation, no automatic redial. |
| Submission status lookup | No implemented verified status lookup | Unknown | Preserve `submission_unknown`; operator review rather than inferred failure/retry. |
| Remote hangup | Media stop/close exists locally | Provider call termination guarantee unknown | Pause new admissions; do not claim socket closure ends the phone call. |
| Recording origin/port | Callback stores a URL; existing code fetches it directly | Exact origins and redirects unknown | New retrieval service requires individually configured HTTPS origins, pinned public DNS and bounded streams; empty policy denies. |
| Stable media identity/order | App handles connected/start/answer/media/hangup | Timing, duplicate/order and reconnect guarantees unknown | Persist attempt first; bind using verified identity and retry hydration on later identity evidence. |
| Payload/content limits | Local JSON body limits exist | Provider maximum event/audio sizes unknown | Enforce documented local bounded defaults and record incompatibility rather than silently widening limits. |

## Provider questions for the integration owner

1. Which exact callback URLs/methods are active, and are custom headers or callback query strings preserved?
2. Which field uniquely identifies one attempted phone call, within which account scope, across submission response, media and callbacks? Can a campaign ID represent several calls?
3. Are `extraparam` and `s_unique` returned unchanged? Supply redacted submission/connected/start/answer/hangup examples for the same attempt, including early and duplicate events.
4. Does submission support idempotency or status lookup after a timeout? What response proves no call was placed?
5. Which API terminates an active phone call, and how is termination confirmed?
6. What are the exact recording HTTPS origins/ports, redirect behavior, MIME types, maximum sizes and signed-URL lifetime?

This brief is prepared for the owner; it has not been sent to the provider. Pending inputs do not block isolated code/test work, but they block activation of the affected provider-dependent capabilities. Review at the next integration response and before any G2 activation; no elapsed deadline is treated as verification.
