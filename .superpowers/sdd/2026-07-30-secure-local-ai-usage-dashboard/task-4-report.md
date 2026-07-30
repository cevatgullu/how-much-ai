# Task 4 report: five-account failure isolation and production cache boundary

Implemented the five-account batch isolation helper and extracted the local usage cache into the
production-used `LocalUsageCoordinator`.

## Changes

- Added `refreshAllAccounts`, which turns either a synchronous throw or a rejected refresh promise
  into `false` for that account while allowing every sibling refresh to finish.
- Routed Dashboard's real `refreshAll` callback through `refreshAllAccounts` and retained its
  `{ updated, total }` status display.
- Extracted the local cache, five-minute TTL decision, cooldown/stale projection, and in-process
  single-flight map from `usage-service.ts` into `LocalUsageCoordinator`.
- Injected the coordinator clock and locked upstream callback. Production uses the existing
  `usageCacheKey`, portable local refresh lock, `refreshAndFetch`, and specialized token-persistence
  failure handling.
- Preserved reauth/cooldown behavior, cache clearing after reconnect, last-known-good usage, and the
  original upstream `fetchedAt`; fake-clock timestamp `0` is no longer collapsed to `null`.

## TDD evidence

1. `lib/refresh-all.test.ts` failed with `ERR_MODULE_NOT_FOUND` because `lib/refresh-all.ts` did not
   exist.
2. The batch helper passed all three cases after the minimal implementation: one rejected account,
   synchronous and asynchronous failures together, and an empty list.
3. `lib/local-usage-coordinator.test.ts` failed with `ERR_MODULE_NOT_FOUND` because the production
   coordinator did not exist.
4. The coordinator tests passed after extraction, proving five-account polls at `0`, `60,000`,
   `120,000`, `180,000`, and `240,000` ms make one upstream attempt per account, while exactly
   `300,000` ms makes the second; concurrent requests coalesce; timestamps propagate; and stale,
   cooldown, and no-data error behavior remains isolated.
5. Existing token-endurance tests exposed a captured-clock regression after production wiring.
   Injecting `() => Date.now()` instead of a snapshot of the original function restored all 19
   rotation, cooldown, recovery-journal, and stale-data cases.

## Verification

- `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/refresh-all.test.ts lib/local-usage-coordinator.test.ts`
  — PASS (8 tests).
- `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/usage-token-endurance.test.ts`
  — PASS (19 tests).
- `npm.cmd test` — PASS (331 tests).
- `npm.cmd run typecheck` — PASS.
- `npm.cmd run build` — PASS, including verification that 22 Next output traces exclude local vault
  material. The sandboxed attempt could not fetch the configured Google Fonts; the network-enabled
  retry passed. Existing Turbopack workspace-root and NFT tracing warnings remain.

## Scope and security notes

- The branch starts exactly at `446133bd712dca94943298312059420748beb13e`.
- Only the six planned Task 4 implementation/test files and this report are changed.
- No environment file, vault state, real credential, or real account identifier was read; no package
  file or external service state was modified.
- `npm ci` continues to report the baseline lockfile's existing high-severity audit finding;
  dependency remediation is outside Task 4 and no package file changed.
