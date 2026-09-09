# P19 CSP string-evaluation removal (first slice)

Date: 9 September 2026. Scope is the application-wide Helmet policy.

## Implemented

- Inventory found no `eval()`, `new Function()` or equivalent string-evaluation consumer under the application source or public pages.
- Removed `unsafe-eval` from `script-src` while preserving the current inline-script compatibility exception.
- Added a source regression that fails if the directive is reintroduced.

## Verification

- `node --test test/csp-http-deployment.test.js` includes the new directive regression; the HTTP integration checks require the approved local listener boundary.
- No browser/provider/database/storage boundary was used for this slice.

## Remaining P19 work

Inline script bodies and event attributes still require page-by-page extraction to remove `unsafe-inline` and `script-src-attr`. The authenticated browser CSP workflow and report-only/enforcement rollout remain open.
