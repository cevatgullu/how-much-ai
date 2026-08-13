# Task 3 report: strict-local application Fetch boundary

Implemented the application-level outbound Fetch boundary, Node startup registration, strict-local notification inertness proof, and direct-network API inventory.

## Changes

- Added `lib/outbound-fetch-policy.ts` with a sanitized policy error, exact-origin validation for the four reviewed Anthropic/OpenAI origins, forced manual redirects, unsupported-input rejection, non-strict pass-through, and idempotent process-global installation.
- Added root `instrumentation.ts`; Node registration validates the complete strict-local environment before installing the Fetch wrapper.
- Added fresh-child-process installation tests with a minimal scrubbed environment and the repository's TypeScript resolver hook. Invalid proxy/missing-secret cases prove both zero upstream calls and that Fetch was not replaced before validation.
- Added a two-function dependency seam to `lib/notify.ts` for subscription and dynamic Web Push loading. Production defaults are unchanged.
- Added a behavioral strict-local notification test proving zero Fetch, subscription-storage, Web Push-loader, and delivery attempts when all prohibited remote configuration is absent.
- Added `audit/baseline/direct-network-apis.txt` as a filename/rule-only inventory. The only direct delivery bypass is configuration-gated `web-push`; the only `child_process` exception is the fixed-argument macOS Keychain helper.
- No dependency or package-script changes were made.

## TDD evidence

1. The initial focused run failed because `lib/outbound-fetch-policy.ts` and `instrumentation.ts` did not exist, and because the dispatcher ignored the requested dependency seam.
2. After the minimal implementations, the three Task 3 test files passed 8/8.
3. Self-review identified that an unsupported stateful stringifiable object could present different URLs to validation and upstream Fetch. The added regression failed with “Missing expected rejection”; rejecting unsupported runtime input types made it pass.

## Verification

- Corrected focused provider/security command — PASS (35 tests):
  - `lib/outbound-fetch-policy.test.ts`
  - `lib/outbound-fetch-installation.test.ts`
  - `lib/strict-local-notification.test.ts`
  - `lib/providers/openai.test.ts`
  - `lib/anthropic-refresh-safety.test.ts`
  - `lib/providers/anthropic-adapter.test.ts`
- `npm.cmd test` — PASS (331 tests).
- `npm.cmd run typecheck` — PASS.
- `npm.cmd run build` — a network-enabled run passed and verified 23 Next output traces exclude local vault material. After the final unsupported-input hardening, the exact-state sandboxed rerun was blocked only while fetching the repository's existing Inter and Lora Google Fonts; focused/full tests and typecheck remained green. Per the orchestrator's instruction, this environmental-only failure was recorded without another retry.
- Existing Turbopack workspace-root and broad NFT tracing warnings remain unchanged.

## Security and scope notes

- Blocked/malformed URLs produce only `OutboundPolicyError` with a fixed message; input canaries are absent.
- Lookalike hosts, non-HTTPS URLs, non-default ports, URL credentials, loopback, unrelated origins, and unsupported coercible objects do not reach upstream Fetch.
- The installed wrapper does not expose either `__hmaOriginalFetch` or Next's `_nextOriginalFetch`.
- Redirects are always manual in strict mode; non-strict mode returns the original Fetch function unchanged.
- The Fetch boundary intentionally does not claim to stop raw sockets or a malicious dependency. The direct-network inventory records every reviewed application-owned bypass category.
- The unrelated `.supply-chain-risk-auditor/results.md` artifact was neither modified nor staged.
