# OpenAI Private Device Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an app-owned ChatGPT/Codex device login whose independently rotating credentials remain active for multiple accounts while preserving shared CLI import as a legacy fallback.

**Architecture:** A server-only OpenAI device-protocol module talks to the existing allowlisted `auth.openai.com` origin. A bounded in-memory attempt store fences browser polling and holds device capabilities only until a one-use authorization-code exchange saves a `managed` credential in the encrypted vault. A focused client component drives the primary login UI; existing local/paste imports remain `rotating` fallbacks.

**Tech Stack:** Next.js 16 App Router route handlers, React 19, TypeScript 6, Node.js 22 test runner, encrypted vault and owner-fenced refresh coordination already in this repository.

## Global Constraints

- Keep zero-configuration local use and the existing strict-local Windows launcher/integrity model.
- Do not add a dependency or an OpenAI API key requirement.
- Never print, log, return, snapshot, or commit provider access tokens, refresh tokens, device ids, authorization codes, or PKCE verifiers.
- Browser responses remain credential-free and every mutation remains authenticated, same-origin, body-bounded, and `Cache-Control: no-store`.
- Device attempts expire after exactly 15 minutes; completed credential-free results remain replayable for at most 60 seconds; at most eight records exist.
- HTTP 404 from the upstream device-token endpoint means `pending`; an authorization-code exchange is attempted at most once.
- Device login saves OpenAI credentials as `managed`; local and pasted Codex credentials remain `rotating`.
- Reconnecting an existing id preserves its nickname and original `addedAt`; a mismatched account saves nothing.
- Keep `Legacy shared CLI login` available during rollout, including the strict-local same-machine reader; strict-local credential paste remains unavailable.
- Use Node.js 22.18.0 or newer.
- Required final validation order is `npm test`, `npm run typecheck`, then `npm run build`.
- Stop/restart only the How Much AI service during final installation; never stop Codex desktop or CLI processes.

---

### Task 1: OpenAI device authorization protocol

**Files:**
- Create: `lib/providers/openai-device-auth.ts`
- Create: `lib/providers/openai-device-auth.test.ts`
- Modify: `lib/providers/openai.ts`

**Interfaces:**
- Produces: `OPENAI_DEVICE_AUTH`, `OpenAIDeviceAuthorization`, `OpenAIDevicePollResult`, `startOpenAIDeviceAuthorization(options?)`, and `pollOpenAIDeviceAuthorization(authorization, options?)`.
- `startOpenAIDeviceAuthorization` returns `{ deviceAuthId, userCode, intervalMs, expiresAt }` but callers must never serialize `deviceAuthId` to the browser.
- `pollOpenAIDeviceAuthorization` returns `{ status: "pending" }` or `{ status: "authorized", tokens: AccountTokens }`.
- Reuses: exported `expiryFromAccessToken` from `lib/providers/openai-credential-source.mjs`.

- [ ] **Step 1: Write failing protocol tests**

Add Node tests with an injected `fetchImpl` that assert exact request boundaries:

```ts
test("device start posts only the public client id and validates string interval", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const authorization = await startOpenAIDeviceAuthorization({
    now: () => 1_700_000_000_000,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: "5" });
    },
  });
  assert.equal(calls[0]?.url, "https://auth.openai.com/api/accounts/deviceauth/usercode");
  assert.equal(calls[0]?.init?.body, JSON.stringify({ client_id: OPENAI_DEVICE_AUTH.clientId }));
  assert.deepEqual(authorization, {
    deviceAuthId: "device-1",
    userCode: "ABCD-EFGH",
    intervalMs: 5_000,
    expiresAt: 1_700_000_900_000,
  });
});
```

Also cover 404 pending, one successful token poll plus exact form exchange, missing refresh token, non-404 upstream failures, malformed/oversized fields, timeouts, manual redirects, and a transport failure during exchange making exactly one `/oauth/token` call.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/providers/openai-device-auth.test.ts
```

Expected: FAIL because `openai-device-auth.ts` does not exist.

- [ ] **Step 3: Implement the minimal protocol module**

Use exact constants and injected dependencies:

```ts
export const OPENAI_DEVICE_AUTH = {
  issuer: "https://auth.openai.com",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  verificationUrl: "https://auth.openai.com/codex/device",
  redirectUri: "https://auth.openai.com/deviceauth/callback",
  attemptTtlMs: 15 * 60_000,
} as const;

export type OpenAIDevicePollResult =
  | { status: "pending" }
  | { status: "authorized"; tokens: AccountTokens };
```

`startOpenAIDeviceAuthorization` must POST JSON with `redirect: "manual"`, `cache: "no-store"`, and a 15-second timeout; clamp the numeric string interval to 1–10 seconds. `pollOpenAIDeviceAuthorization` must POST only the two device fields, treat only 404 as pending, validate `authorization_code` and `code_verifier`, then issue one form-encoded `/oauth/token` request with a 30-second timeout. Require non-empty access and refresh tokens and derive `expiresAt` with `expiryFromAccessToken`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 command. Expected: all protocol tests pass and no test output contains fixture token values.

- [ ] **Step 5: Commit the protocol boundary**

```powershell
git add lib/providers/openai-device-auth.ts lib/providers/openai-device-auth.test.ts lib/providers/openai.ts
git commit -m "feat: add OpenAI device authorization protocol"
```

---

### Task 2: Bounded, owner-fenced device attempt store

**Files:**
- Create: `lib/openai-device-attempt-store.ts`
- Create: `lib/openai-device-attempt-store.test.ts`

**Interfaces:**
- Consumes: `OpenAIDeviceAuthorization` from Task 1.
- Produces: `createOpenAIDeviceAttemptStore(options?)`, `OpenAIDeviceAttemptStore`, `OpenAIDeviceAttemptCapacityError`, and production singleton `openAIDeviceAttemptStore`.
- Public store methods: `start`, `claimPoll`, `releasePending`, `complete`, `fail`, and `status`.
- `claimPoll` returns no record unless both the base64url attempt capability and authenticated `userId` match.

- [ ] **Step 1: Write failing lifecycle tests**

Use injected clock/random bytes and inspect an injected records map. Cover canonical 32-byte capability validation, user binding, 15-minute expiry, eight-record capacity and reclamation, interval wait, one live poll owner, reclaim after a 30-second poll fence, wrong-owner completion rejection, secret deletion on done/fail/expiry, and 60-second replay of credential-free completion.

Representative assertion:

```ts
const claim = store.claimPoll(started.attemptId, "user-a");
assert.equal(claim?.kind, "poll");
assert.equal(store.claimPoll(started.attemptId, "user-a")?.kind, "processing");
assert.equal(store.claimPoll(started.attemptId, "user-b"), null);
assert.equal(store.complete(started.attemptId, claim!.owner, {
  email: "account@example.com",
  plan: "ChatGPT Plus",
  label: "account@example.com",
  alreadyConnected: false,
}), true);
assert.equal(records.get(started.attemptId)?.deviceAuthId, undefined);
```

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/openai-device-attempt-store.test.ts
```

Expected: FAIL because the store module does not exist.

- [ ] **Step 3: Implement the state machine**

Use discriminated records for `pending`, `polling`, `done`, `failed`, and `expired`. Hash nothing that needs later upstream use, but delete `deviceAuthId`, `userCode`, `expectedAccountId`, and poll owner as soon as the attempt becomes terminal. Generate attempt and owner capabilities from 32 random bytes. Keep the singleton on a dedicated `globalThis.__hmcOpenAIDeviceAttemptStore` key so Next development reloads do not orphan active attempts.

The browser-facing status union must contain only:

```ts
type PublicStatus =
  | { status: "pending" | "processing"; pollAfterMs: number; expiresAt: number }
  | { status: "done"; account: ConnectedAccountInfo }
  | { status: "failed" | "expired"; error: string };
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 command. Expected: all store tests pass.

- [ ] **Step 5: Commit the store**

```powershell
git add lib/openai-device-attempt-store.ts lib/openai-device-attempt-store.test.ts
git commit -m "feat: fence OpenAI device login attempts"
```

---

### Task 3: Authenticated routes and managed account persistence

**Files:**
- Create: `app/api/connect/openai/device/start/route.ts`
- Create: `app/api/connect/openai/device/status/route.ts`
- Create: `lib/providers/connect-openai-device.test.ts`
- Modify: `lib/connect-account.ts`
- Modify: `lib/providers/connect-openai.test.ts`
- Modify: `lib/usage-service.ts`
- Modify: `lib/providers/usage-service-openai.test.ts`
- Modify: `lib/request-route-guards.test.ts`

**Interfaces:**
- Consumes: protocol functions from Task 1 and store singleton from Task 2.
- Produces: credential-free `POST /api/connect/openai/device/start` and `POST /api/connect/openai/device/status`.
- Extends: `buildProviderAccount(identity, tokens, providerId, now?, credentialKindOverride?)` and `saveProviderAccount(userId, identity, tokens, providerId, credentialKindOverride?)`.

- [ ] **Step 1: Add failing persistence tests**

Prove a managed override requires a refresh token and that reconnecting the same OpenAI id replaces the credential while preserving label and `addedAt`:

```ts
const built = buildProviderAccount(identity, tokens, "openai", 2000, "managed");
assert.equal(built.credentialKind, "managed");
await saveProviderAccount("default", identity, tokens, "openai", "managed");
const [saved] = await loadAccounts("default");
assert.equal(saved.credentialKind, "managed");
assert.equal(saved.label, "Primary");
assert.equal(saved.addedAt, 1000);
```

Add a usage-service test with three distinct managed OpenAI accounts whose expired access tokens each rotate once to a distinct refresh generation. Assert three token calls, three usage calls, three independent persisted refresh tokens, and no cross-account token reuse.

- [ ] **Step 2: Run persistence tests and verify RED**

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/providers/connect-openai.test.ts lib/providers/usage-service-openai.test.ts
```

Expected: the override call/type fails and the three-account managed scenario is not implemented.

- [ ] **Step 3: Implement the credential-kind override and provider-neutral refresh copy**

Validate `managed` exactly like the Claude path: it must have a refresh token. Pass `"managed"` only from device completion. In `usage-service.ts`, pass Claude scopes only when `provider.id === "anthropic"`, and replace hard-coded post-refresh rejection text with a provider helper that names `ChatGPT` for OpenAI and `Claude` for Anthropic.

- [ ] **Step 4: Add failing route tests**

Stub the upstream sequence and call the real route handlers. Test:

- start response contains code/verification metadata but not `device_auth_id`;
- status maps upstream 404 to pending;
- authorized status verifies identity and saves `managed`;
- wrong expected id returns 409 and leaves the vault unchanged;
- repeated status after a lost success response returns the same browser-safe account metadata without a second exchange;
- malformed bodies, extra fields, cross-origin mutations, missing sessions, oversized bodies, and invalid capabilities fail closed;
- token/access/refresh/auth-code/verifier fixtures are absent from serialized responses and captured diagnostics.

- [ ] **Step 5: Run route tests and verify RED**

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/providers/connect-openai-device.test.ts lib/request-route-guards.test.ts
```

Expected: FAIL because both route handlers are missing.

- [ ] **Step 6: Implement start and status routes**

Follow the ordinary browser route pattern:

```ts
const guard = browserMutationFailure(req);
if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status, headers: NO_STORE });
const userId = await requireUser(req);
if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: NO_STORE });
```

Start accepts only `expectedAccountId`; status accepts only `attemptId`. Status claims one poll owner, returns pending on 404, releases the owner with the upstream interval, and on authorization resolves identity, checks the expected id, calls `saveProviderAccount(..., "managed")`, completes the store with browser-safe metadata, and returns it. Every exception path must either restore pending state for a safe pre-code transient failure or terminally clear secrets once an authorization code may have been consumed.

- [ ] **Step 7: Run all Task 3 tests and verify GREEN**

Run both Step 2 and Step 5 commands. Expected: all pass.

- [ ] **Step 8: Commit the server flow**

```powershell
git add app/api/connect/openai/device lib/connect-account.ts lib/usage-service.ts lib/providers/connect-openai.test.ts lib/providers/connect-openai-device.test.ts lib/providers/usage-service-openai.test.ts lib/request-route-guards.test.ts
git commit -m "feat: persist private ChatGPT device logins"
```

---

### Task 4: Primary private-login UI with legacy fallback

**Files:**
- Create: `lib/openai-device-login-session.ts`
- Create: `lib/openai-device-login-session.test.ts`
- Create: `components/OpenAIDeviceLogin.tsx`
- Modify: `components/AddAccountModal.tsx`
- Modify: `components/AccountCard.tsx`
- Modify: `components/providers-ui.tsx`
- Modify: `lib/bootstrap-ui.test.ts`
- Modify: `lib/usage-dashboard-ui.test.ts`

**Interfaces:**
- `createOpenAIDeviceLoginSession(deps)` returns `{ start(expectedAccountId?): Promise<void>; cancel(): void }`; injected browser dependencies cover `fetch`, `open`, recursive timers, navigation, and state callbacks.
- `OpenAIDeviceLogin` props: `{ expectedAccountId?: string; disabled: boolean; onConnected(account): void; onBusyChange(busy): void }`.
- The component calls only the two credential-free device routes and opens only the exact `verificationUrl` returned by start after checking it equals `OPENAI_DEVICE_AUTH.verificationUrl` through a browser-safe constant.
- `AddAccountModal` keeps existing `connectOpenAILocal` and `connectOpenAIPaste` callbacks as fallback paths.

- [ ] **Step 1: Write failing UI boundary tests**

Extend static-render tests to require:

- primary `Connect private ChatGPT login` copy;
- `private app login · auto-renews` explanation;
- a collapsed/secondary `Legacy shared CLI login` heading;
- warning that CLI rotation can disconnect the dashboard;
- strict-local markup contains same-machine fallback but no credential textarea;
- OpenAI reauth text says ChatGPT, never Claude;
- provider metadata reports OpenAI private login support.
- the client session opens only the exact verification origin, schedules one recursive poll at a time using `pollAfterMs`, cancels its timer and request, ignores late responses after cancellation, redirects only on an exact `Not signed in` 401, and emits `done` once.

- [ ] **Step 2: Run UI tests and verify RED**

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/bootstrap-ui.test.ts lib/usage-dashboard-ui.test.ts
```

Expected: FAIL because OpenAI still renders the local shared login as primary and the client session module does not exist.

- [ ] **Step 3: Implement and test the cancellable client session**

Keep browser effects behind injected functions so Node tests need no DOM package. `start` calls the start route once, validates `verificationUrl === "https://auth.openai.com/codex/device"`, opens that exact URL, emits the user code state, and schedules recursive status requests. `cancel` aborts the current request, clears the one timer, increments a generation fence, and suppresses every late callback.

Run the Step 2 command again with `lib/openai-device-login-session.test.ts` included; expected: session tests pass while static UI expectations remain red.

- [ ] **Step 4: Implement the device-login component**

The component starts on explicit click, opens a new browser tab only from that click, displays/copies the one-time code, and polls with recursive `setTimeout` using `pollAfterMs` rather than `setInterval`. Abort outstanding fetches and clear timers on modal close/unmount. Handle 401 by navigating to `/login`; render generic failed/expired copy; call `onConnected` only on a credential-free done response.

Required visible warning:

```tsx
<p>Continue only because you started this login in How Much AI. Never enter a code sent by another person.</p>
```

- [ ] **Step 5: Integrate primary and legacy sections**

Render `OpenAIDeviceLogin` first for ChatGPT. Put the current local reader and non-strict paste UI under a secondary `Legacy shared CLI login` disclosure; keep strict-local paste exclusion. Add device busy state to modal dismissal and provider switching. Preserve current success/reload behavior.

Update AccountCard explanations using `account.provider`:

```ts
const providerName = account.provider === "openai" ? "ChatGPT" : "Claude";
```

Managed and shared badges remain exactly `private app login · auto-renews` and `shared CLI login`.

- [ ] **Step 6: Run UI tests and verify GREEN**

Run:

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/openai-device-login-session.test.ts lib/bootstrap-ui.test.ts lib/usage-dashboard-ui.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit the UI**

```powershell
git add lib/openai-device-login-session.ts lib/openai-device-login-session.test.ts components/OpenAIDeviceLogin.tsx components/AddAccountModal.tsx components/AccountCard.tsx components/providers-ui.tsx lib/bootstrap-ui.test.ts lib/usage-dashboard-ui.test.ts
git commit -m "feat: make private ChatGPT login primary"
```

---

### Task 5: Security regression, full verification, and secure-local installation

**Files:**
- Modify only if required by evidence: `lib/outbound-fetch-policy.test.ts`
- Modify only if generated/reviewed evidence requires it: `audit/baseline/network-surfaces.txt`
- Verify: all changed files and secure-local installer/runtime manifests

**Interfaces:**
- Consumes all prior tasks.
- Produces a validated secure-local runtime installed through the existing manifest-driven installer.

- [ ] **Step 1: Run focused security and secret-boundary tests**

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/outbound-fetch-policy.test.ts lib/browser-boundary.test.ts lib/server-error-diagnostics.test.ts lib/vault-trace-assertion.test.ts lib/safe-secret-scan.test.ts
```

Expected: PASS. The strict fetch policy already allows the exact `https://auth.openai.com` origin; do not broaden it.

- [ ] **Step 2: Review the diff for secrets and scope**

```powershell
git diff --check
git diff --stat secure-local-dashboard...HEAD
git diff secure-local-dashboard...HEAD -- . ':!docs/superpowers'
```

Confirm no fixture resembles a live JWT/refresh token, no new dependency exists, no external origin was added, and legacy CLI methods were retained.

- [ ] **Step 3: Run the complete suite with port 37645 free**

Record the exact current How Much AI PID and executable/command line, stop only that validated service process, and verify `Get-NetTCPConnection -LocalPort 37645` has no listener. Never target `codex.exe`, a parent process, a wildcard process name, or an unresolved PID.

Then run, in repository-required order:

```powershell
npm test
npm run typecheck
npm run build
```

Expected: 0 failed tests, TypeScript success, production build success, and vault-trace assertion success.

- [ ] **Step 4: Commit any evidence-only correction**

If Step 1 or Step 2 proves an audit baseline must include the reviewed device endpoints, update only those exact lines and commit:

```powershell
git add audit/baseline/network-surfaces.txt lib/outbound-fetch-policy.test.ts
git commit -m "test: record OpenAI device login network surface"
```

Skip this commit when no evidence file changes.

- [ ] **Step 5: Install with the existing secure-local pipeline**

Use the repository's `scripts/windows/install-secure-local.ps1` with the same validated state root and pinned Node executable recorded by the current installation. Do not hand-edit the installed runtime. Require the installer to create a new immutable runtime, refresh integrity metadata, preserve the encrypted vault, and start only the How Much AI service.

- [ ] **Step 6: Verify the installed behavior**

Check:

```powershell
Get-NetTCPConnection -LocalPort 37645 -State Listen
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:37645/login
```

Open the dashboard and verify the ChatGPT modal shows private device login first and legacy CLI fallback second. Complete one real account login with the user, confirm the card reads `private app login · auto-renews`, refresh its usage, then repeat for the remaining accounts. Do not remove the legacy flow in this release.

- [ ] **Step 7: Confirm the source worktree is clean**

Do not commit generated `.next`, runtime directories, vault files, Edge profiles, secrets, or inspection artifacts. Run `git status --short`; expected output is empty because every reviewed source change was committed in Tasks 1–4 or the conditional evidence commit in Step 4.
