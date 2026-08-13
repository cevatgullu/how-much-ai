# Task 6 bootstrap report

Implemented only Task 6 Step 6's one-use strict-local browser bootstrap slice.

## Changes

- Added a `globalThis`-backed in-memory bootstrap store that issues random 32-byte base64url tickets, retains only SHA-256 digests, expires tickets after 20 seconds, invalidates older tickets on issuance, deletes before success, rejects replay/malformed input, and loses state on process restart.
- Moved password JSON parsing, constant-time verification, and the bounded singleton login limiter into `lib/password-auth.ts`; ordinary login and bootstrap start now share that exact path.
- Added strict-local bootstrap start and consume routes with exact loopback Host and distinct Origin policies, `Cache-Control: no-store`, generic failures, and the existing host-only `HttpOnly` `SameSite=Strict` session cookie only after a successful consume.
- Replaced prefix-based public-route matching with one exact-path predicate covering the existing public paths and the three bootstrap paths.
- Added the dynamic strict-local `/bootstrap` page and browser session consumer. The fragment is captured and removed from the visible URL/current history entry synchronously before the same-origin consume request begins.
- Changed strict-local login to show only launcher guidance; non-strict password deployments retain the existing form and password-manager opt-out hints.

## TDD evidence

1. `lib/local-bootstrap.test.ts` and `lib/self-authenticating-public-paths.test.ts` failed because their production modules did not exist, then passed after the minimal store and predicate implementations.
2. `lib/local-bootstrap-route.test.ts` failed because the bootstrap routes did not exist, then passed after the shared authentication refactor, proxy change, and route implementations.
3. The browser/UI tests failed because `lib/bootstrap-session.ts` did not exist, then passed after the synchronous fragment flow, bootstrap page, and strict-login UI were implemented.
4. Focused verification passed 23 tests covering store bounds/hash-only retention, exact public paths, Host/Origin failures, shared rate limiting, cookie shape, valid-session consumption, synchronous fragment erasure, replay rejection, and strict/non-strict login rendering.

## Verification

- `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/local-bootstrap.test.ts lib/local-bootstrap-route.test.ts lib/self-authenticating-public-paths.test.ts lib/bootstrap-ui.test.ts lib/proxy.test.ts lib/request-route-guards.test.ts` — PASS (23 tests).
- `npm.cmd test` — PASS (340 tests).
- `npm.cmd run typecheck` — PASS.
- `npm.cmd run build` — PASS; the first sandboxed attempt could not fetch the repository's configured Google Fonts, and the network-enabled retry compiled all routes and verified 25 Next output traces exclude local vault material.

The build retained the pre-existing Turbopack workspace-root and NFT tracing warnings.

## Security and scope notes

- Start accepts no `Origin` and sets no cookie; consume requires the exact loopback origin and sets exactly one existing session cookie.
- No bootstrap/browser code uses browser storage, extension storage, clipboard APIs, keyboard injection, or console logging.
- No environment file, vault data, browser profile, or real credential was read or changed.
- Route modules export only their supported Next.js runtime configuration and `POST` handler.
