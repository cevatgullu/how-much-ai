# Task 2 report: fail-closed strict-local mode

Implemented the strict-local runtime boundary and the required strict-only Host guard.

## Changes

- Added `lib/strict-local-mode.ts` with strict-mode detection, reviewed-environment validation, fail-closed assertion, Host validation, and cookie policy.
- Made `authOpen()` validate strict mode before legacy authentication handling and always keep the password gate closed in a valid strict configuration.
- Added a proxy guard before all route/public/auth handling; strict mode accepts only `Host: 127.0.0.1:37645` and returns a generic 400 for all other Host values.
- Updated login cookies to use the strict host-only HTTP policy (`Secure=false`, `SameSite=Strict`) after validation.
- Disabled password-manager storage hints on the dashboard password field.
- Added behavioral tests for strict configuration, invalid configuration, cookie policy, strict authentication, and exact Host acceptance/rejection. Tests use generated placeholder secrets and test-only paths.

## TDD evidence

1. `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/strict-local-mode.test.ts` failed because `lib/strict-local-mode.ts` did not exist.
2. The same strict-mode test passed after the minimal validator implementation.
3. `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/session.test.ts` failed because missing `APP_PASSWORD` still allowed open mode.
4. The session test passed after `authOpen()` became fail-closed in strict mode.
5. The Host-header test initially failed because `strictLocalHostAllowed` was not exported, then passed after the strict-only helper and proxy guard were added.

## Verification

- `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/strict-local-mode.test.ts lib/session.test.ts` — PASS (11 tests).
- `npm.cmd test` — PASS (318 tests).
- `npm.cmd run typecheck` — PASS.
- `npm.cmd run build` — PASS after a network-enabled retry for the repository's Google Fonts fetch. The initial sandboxed build failed only on fetching Inter and Lora. The successful build also verified 22 Next output traces exclude local vault material. Existing Turbopack workspace-root/NFT tracing warnings remain.

## Security notes

- No `.env*`, `.data`, browser profile, auth store, or real credential was read or modified.
- Strict mode rejects missing, short, or reused secrets; non-loopback or wrong-port listener settings; proxy trust; relative vault paths; telemetry/process overrides; and configured remote/notification services.
- Strict Host validation is exact and rejects absent, malformed, localhost, IPv6, alternate-port, and hostile hosts before any public or authentication logic.
