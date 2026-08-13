# Task 4 review fix report

Addressed the independent review finding:

- Verified the production account-removal path is the dashboard's semantic `remove`
  mutation through `PUT /api/vault`.
- Added a 512-entry maximum and a 24-hour idle TTL to the local usage cache. Lazy
  pruning removes only settled entries, using least-recently-used order when the
  cache exceeds the maximum; active in-flight entries are never selected.
- Preserved the existing five-minute freshness, single-flight, cooldown, and stale
  fallback behavior.
- Fenced an active refresh after an exact-key clear so its eventual commit cannot
  repopulate state for a removed account, while concurrent callers still share the
  original in-flight operation.
- Wired successful vault removals to `clearAccountUsageState(userId, accountId)`.
  Conflict responses return before clearing, and sibling account keys are untouched.
- Exposed only a size-only test seam; tenant and account identifiers remain private.

TDD evidence:

- The LRU, idle-TTL, and in-flight pressure tests first failed because settled
  entries were never evicted, then passed after lifecycle pruning was added.
- The active-clear test first observed one upstream attempt instead of two because
  the cleared in-flight refresh repopulated the cache, then passed after commit
  fencing was added.
- The real vault-route removal test first observed two upstream requests instead of
  three because the removed account's cache survived, then passed after the route
  was wired to the exact-key clear helper.

Verification:

- `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/refresh-all.test.ts lib/local-usage-coordinator.test.ts lib/vault.test.ts lib/usage-cache-core.test.ts lib/usage-token-endurance.test.ts` — PASS, 86 tests.
- `npm.cmd test` — PASS, 336 tests.
- `npm.cmd run typecheck` — PASS.
- `npm.cmd run build` — PASS after network access was enabled for the existing
  Google Fonts dependency; the pre-existing workspace-root/NFT warnings remain.
