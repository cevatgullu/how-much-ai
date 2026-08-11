# Strict-local Claude add repair

Date: 2026-08-11
Status: user-approved through the instruction to continue and repair the visibly broken add fields

## Problem

The installed dashboard renders no actionable Claude connection control in strict-local mode. It tells the user to choose a Claude action in the secure launcher, but that launcher has no such action. In addition, browser mutation and secure handoff routes compare the browser's external origin with Next's internal request URL, so valid loopback requests fail as cross-origin.

## Selected design

Reuse the existing private Claude PKCE form in strict-local mode. The user opens Claude's authorization page and pastes only the one-time authorization response; the server exchanges it, verifies the subscription identity, and stores the renewable access/refresh pair in the encrypted vault. Long-lived tokens are never returned to the browser.

Strict-local browser mutations trust only the exact external origin `http://127.0.0.1:37645`, even when Next supplies an internal `req.url`. Ordinary deployments keep their existing same-origin comparison. The standalone secure connector's launch and callback routes receive the equivalent internal-URL correction so the documented fallback remains usable.

## Boundaries

- Keep session authentication, exact Host/Origin checks, Fetch Metadata checks, bounded JSON schemas, PKCE state/verifier validation, provider identity verification, and token-free responses.
- Do not restore raw credential or Claude Code token entry as the primary path.
- Do not launch or complete a provider login automatically; the user performs provider authentication.
- Keep ChatGPT's independent device-login flow unchanged.

## Tests

- Strict-local Add Account renders the private Claude authorization controls instead of instruction-only prose.
- The authenticated Claude OAuth route accepts an exact external Host/Origin when `req.url` is internal and still rejects a foreign origin.
- The shared browser mutation guard accepts only the exact strict-local origin under internal routing.
- Secure connector launch and callback accept the exact external boundary under internal routing while preserving replay and schema guards.
