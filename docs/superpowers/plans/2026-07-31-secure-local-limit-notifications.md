# Secure Local Limit Notifications and Visual Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add private local notifications and an always-available visual dashboard for every provider-reported account limit, including Claude's five-hour limit, at the exact remaining thresholds 50, 40, 30, 20, 15, 10, 5, and 0 percent.

**Architecture:** Keep the hosted Convex/Web Push pipeline behavior-compatible. In strict-local mode, consume fresh normalized dashboard snapshots, run a pure per-account/per-limit detector, store only bounded privacy-minimized state in the dedicated Edge profile, and deliver through a validated service-worker message while the app is open or minimized. The visual dashboard consumes the same normalized remaining percentages, and a hash-bound bootstrap launcher plus Start-menu shortcut reopens the existing two-task Windows installation without carrying secrets.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6, Node.js 24 native test runner, browser Service Worker/Notifications/Web Locks APIs, Windows PowerShell 5.1, Task Scheduler, Microsoft Edge app mode, and the existing trusted audit launcher.

## Global Constraints

- Remaining thresholds are exactly `50, 40, 30, 20, 15, 10, 5, 0`; nothing fires above 50% remaining.
- The 0% copy contains `limit bitti`; every confirmed reset copy contains the exact phrase `limit sıfırlandı`.
- Track every normalized provider limit independently, including Claude's five-hour/current-session, weekly, scoped-model, and connected-app limits.
- First observation is silent. A multi-boundary jump emits only the tightest newly crossed boundary and marks skipped boundaries passed.
- A reset requires a concrete `resets_at` timestamp moving strictly later. Lower utilization, stale data, null/older timestamps, failures, and clock skew never imply reset.
- Strict-local notification delivery uses no Convex, Telegram, webhook, VAPID key, external notification service, new npm dependency, new executable, or new scheduled task.
- Notification text uses a safe nickname or provider ordinal, never email, full name, provider account ID, credential, raw payload, reset URL, or protected value.
- Persisted state is versioned, at most 64 KiB and 512 records, and contains only a SHA-256 account hash, stable limit key, accepted reset timestamp, boundary cursor, and last utilization.
- The dashboard displays remaining percentage first, used percentage second, reset countdown/exact time, freshness, and visible stale/error status from the same normalized reading used by alerts.
- Hosted notifications and public API behavior remain backward-compatible.
- Every behavior change follows red-green TDD. Each task stages only named files and ends with a focused commit.
- Installation waits for trusted tests, typecheck, build, secret/static scans, independent reviews, runtime-manifest, immutability, Defender, and a clean fresh-checkout gate.

## File Map

**Create:**

- `lib/local-notify-detect.ts` — pure boundary/reset detector and exact Turkish event copy.
- `lib/local-notify-detect.test.ts` — all thresholds, resets, jumps, and isolation.
- `lib/local-notify-store.ts` — bounded V1 codec, localStorage adapter, SHA-256 account hash, and opaque tags.
- `lib/local-notify-store.test.ts` — corruption, size, privacy, pruning, and storage failure.
- `lib/local-notify-delivery.ts` — permission request and service-worker request/ack client.
- `lib/local-notify-delivery.test.ts` — permission, timeout, negative ack, and no-Push behavior.
- `lib/local-notify-coordinator.ts` — Web Lock serialized read/diff/deliver/write cycle.
- `lib/local-notify-coordinator.test.ts` — delivery-before-state, retry, tab concurrency, and pruning.
- `lib/service-worker-notification.test.ts` — VM worker protocol and click-origin validation.
- `lib/format.test.ts` — stable normalized usage bars and Turkish reset presentation.
- `lib/usage-dashboard-ui.test.ts` — SSR/source accessibility and four-account visual checks.
- `scripts/windows/launch-secure-local.ps1` — hash-bound task-only Start-menu launcher.
- `lib/windows-start-menu-launcher.test.ts` — launcher/shortcut plan and failure cases.

**Modify:**

- `lib/format.ts` — replace ambiguous used-only `Bar` with stable `NormalizedUsageBar`.
- `app/api/cron/check/route.ts` — adapt hosted detector input to `usedPercent`.
- `components/Dashboard.tsx` — strict-local fresh-only coordinator call, status, provider ordinals, and settings props.
- `components/NotificationsPanel.tsx` — separate strict-local permission/rule UI.
- `components/UsageBar.tsx`, `components/AccountCard.tsx`, `app/globals.css` — remaining-first visual presentation.
- `lib/storage.ts`, `lib/storage.test.ts` — two local notification toggles.
- `public/sw.js` — strict local message schema/ack and same-origin click.
- `scripts/windows/SecureLocalIntegrity.psm1`, `scripts/windows/SecureLocalRuntime.psm1`, `scripts/windows/install-secure-local.ps1`, `scripts/windows/verify-final-local-state.ps1` — launcher hash, deterministic shortcut, exact verification, rollback.
- `scripts/audit/create-runtime-manifest.mjs`, `lib/runtime-manifest.test.ts`, Windows tests — tenth bootstrap file and final-state assertions.
- `lib/session.ts`, `lib/session.test.ts`, `lib/auth.ts` — remove unauthenticated development ambiguity.
- `README.md`, `.env.example`, `docs/SELF_HOSTING.md`, `docs/WINDOWS_SECURE_LOCAL.md` — exact behavior and security boundary.

---

### Task 0: Close pre-feature review findings and commit the security baseline

**Files:**

- Modify: `lib/session.ts`
- Modify: `lib/session.test.ts`
- Modify: `lib/auth.ts`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/WINDOWS_SECURE_LOCAL.md`
- Add: `.gitattributes`
- Add: `lib/trusted-node-launcher.test.ts`
- Add: `scripts/audit/invoke-trusted-node.ps1`
- Add: `scripts/test-environment.mjs`
- Commit: all other reviewed pre-feature paths enumerated by `audit/final/HOW_MUCH_AI_DIFFERENTIAL_REVIEW_2026-07-31.md`

**Interfaces:**

- Consumes: `authOpen(): boolean`, strict-local validation, and the completed pre-feature reports.
- Produces: authenticated ordinary development/self-hosting and a committed LF security baseline containing the four required untracked files.

- [ ] **Step 1: Add the failing auth regression**

Add to `lib/session.test.ts`:

```ts
test("development without APP_PASSWORD never becomes unauthenticated open mode", () => {
  delete process.env.HMC_STRICT_LOCAL_MODE;
  delete process.env.APP_PASSWORD;
  process.env.NODE_ENV = "development";
  assert.equal(authOpen(), false);
});
```

- [ ] **Step 2: Run it and observe the old branch fail**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/session.test.ts
```

Expected: FAIL because the existing development branch returns `true`.

- [ ] **Step 3: Eliminate open authentication**

Keep strict-local validation and make every environment closed:

```ts
export function authOpen(): boolean {
  if (strictLocalModeEnabled()) assertStrictLocalEnvironment();
  return false;
}
```

Update comments and docs: ordinary dev/self-hosting requires `APP_PASSWORD`; secure Windows bootstrap creates a session through challenge/server-proof/client-proof HMAC and never transmits the password.

- [ ] **Step 4: Run affected auth/bootstrap tests**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/session.test.ts lib/proxy.test.ts lib/bootstrap-ui.test.ts lib/strict-local-mode.test.ts lib/local-bootstrap-route.test.ts
```

Expected: all pass.

- [ ] **Step 5: Stage the reviewed baseline exactly**

Compare `git diff --name-only` with the differential report. The only new required source paths are:

```text
.gitattributes
lib/trusted-node-launcher.test.ts
scripts/audit/invoke-trusted-node.ps1
scripts/test-environment.mjs
```

Reject `%SystemDrive%/`, `Microsoft/`, cloned scanner repositories, caches, `.env` files, and credentials. Stage only the report allowlist plus the four additions. Run:

```powershell
git diff --cached --name-status
git diff --cached --check
```

Expected: intended source only and no whitespace errors.

- [ ] **Step 6: Run trusted full validation**

Invoke `run-sanitized-validation.mjs` through the retained hash-bound `invoke-trusted-node.ps1` with the exact Node/npm hashes from `docs/WINDOWS_SECURE_LOCAL.md`.

Expected:

```json
{"LaunchOk":true,"ExitCode":0,"CommandsPassed":3}
```

- [ ] **Step 7: Commit**

```powershell
git commit -m "security: harden the local Windows runtime"
```

---

### Task 1: Normalize stable usage bars and shared remaining presentation

**Files:**

- Modify: `lib/format.ts`
- Create: `lib/format.test.ts`
- Modify: `app/api/cron/check/route.ts`
- Modify: `lib/providers/openai.test.ts`
- Modify: `lib/providers/anthropic-adapter.test.ts`

**Interfaces:**

- Produces:

```ts
export interface NormalizedUsageBar {
  key: string;
  kind: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  severity: string;
  isActive: boolean;
}

export function extractBars(usage: UsageData): NormalizedUsageBar[];
export function formatResetSchedule(
  resetsAt: string | null,
  now: number,
  options?: { locale?: string; timeZone?: string },
): { exact: string; countdown: string | null; state: "future" | "resetting" | "past" } | null;
```

- [ ] **Step 1: Write failing normalization tests**

Test exact mappings:

```ts
assert.deepEqual(
  extractBars({ five_hour: { utilization: 40, resets_at: "2026-08-01T00:00:00.000Z" } })[0],
  {
    key: "session",
    kind: "session",
    label: "5 saatlik limit",
    usedPercent: 40,
    remainingPercent: 60,
    resetsAt: "2026-08-01T00:00:00.000Z",
    severity: "normal",
    isActive: false,
  },
);
```

Also cover `weekly_all`, `weekly_oauth_apps`, Opus/Sonnet scoped keys, rich+missing-flat merge without duplicates, order-independent scoped keys, `seven_day_oauth_apps`, clamp at 0/100, and rejection of NaN/Infinity/non-number rows.

- [ ] **Step 2: Run the focused tests**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/format.test.ts lib/providers/openai.test.ts lib/providers/anthropic-adapter.test.ts
```

Expected: FAIL because the old shape has `percent`, unstable indexed keys, and English labels.

- [ ] **Step 3: Implement canonical normalization**

Normalize once:

```ts
function normalizeUsed(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}
```

Use keys `session`, `weekly_all`, `weekly_oauth_apps`, and `weekly_scoped:<encoded stable scope>`. Merge rich rows first and only fill absent canonical identities from flat buckets. Ensure `usedPercent + remainingPercent === 100`.

- [ ] **Step 4: Adapt hosted cron without changing its semantics**

```ts
const reading: LimitReading = {
  key: bar.key,
  label: bar.label,
  percent: bar.usedPercent,
  resetsAt: bar.resetsAt,
};
```

- [ ] **Step 5: Run focused and hosted notification tests**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/format.test.ts lib/providers/openai.test.ts lib/providers/anthropic-adapter.test.ts lib/notify-detect.test.ts lib/notify-cycle.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add -- lib/format.ts lib/format.test.ts app/api/cron/check/route.ts lib/providers/openai.test.ts lib/providers/anthropic-adapter.test.ts
git diff --cached --check
git commit -m "feat: normalize remaining usage limits"
```

---

### Task 2: Implement the pure local detector

**Files:**

- Create: `lib/local-notify-detect.ts`
- Create: `lib/local-notify-detect.test.ts`

**Interfaces:**

```ts
export const REMAINING_BOUNDARIES = [50, 40, 30, 20, 15, 10, 5, 0] as const;
export type RemainingBoundary = (typeof REMAINING_BOUNDARIES)[number];

export interface LocalNotifyRules {
  remainingWarnings: boolean;
  resetNotifications: boolean;
}

export interface LocalLimitReading {
  limitKey: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
}

export interface LocalLimitState {
  lastResetAt: string | null;
  nextBoundaryIndex: number;
  lastObservedUtilization: number;
}

export type LocalLimitEvent =
  | { type: "threshold"; boundary: RemainingBoundary }
  | { type: "reset" };

export type LocalLimitDiff =
  | { kind: "ignore"; nextState: null; event: null }
  | { kind: "seed" | "advance"; nextState: LocalLimitState; event: null }
  | { kind: "event"; nextState: LocalLimitState; event: LocalLimitEvent };

export function diffLocalLimit(
  previous: LocalLimitState | undefined,
  reading: LocalLimitReading,
  rules: LocalNotifyRules,
): LocalLimitDiff;

export function formatLocalLimitNotification(
  event: LocalLimitEvent,
  accountLabel: string,
  limitLabel: string,
): { title: "How Much AI"; body: string };
```

- [ ] **Step 1: Write the full failing boundary matrix**

For each exact boundary, seed one point above, cross it, assert one event, repeat the same reading, assert none. Add explicit cases: no event at 51; 49→9 emits only 10; first sighting at 5 is silent; 0 says `limit bitti`; later timestamp emits one reset containing `limit sıfırlandı`; reset+threshold emits reset only; a null timestamp can still advance thresholds but never resets; the first valid timestamp after null is adopted silently; invalid/equal/older timestamps do not reset; utilization drop without reset does not re-arm; toggles advance silently; four account/limit state machines remain independent.

- [ ] **Step 2: Run and observe module absence**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/local-notify-detect.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement the cursor algorithm**

```ts
function crossedBoundaryIndex(remaining: number): number {
  let crossed = -1;
  for (let index = 0; index < REMAINING_BOUNDARIES.length; index += 1) {
    if (remaining <= REMAINING_BOUNDARIES[index]) crossed = index;
  }
  return crossed;
}
```

Seed with `crossed + 1`. Never move the cursor backward. A null timestamp permits threshold tracking but cannot trigger reset. Adopt the first later valid timestamp after null without emitting reset. When two concrete timestamps exist and the new one is strictly later, seed the fresh cursor and emit reset only. On a jump, emit `REMAINING_BOUNDARIES[crossed]` only and advance to `crossed + 1`.

Use exact copy:

```ts
if (event.type === "reset") return { title: "How Much AI", body: accountLabel + " • " + limitLabel + ": limit sıfırlandı." };
if (event.boundary === 0) return { title: "How Much AI", body: accountLabel + " • " + limitLabel + ": limit bitti." };
return { title: "How Much AI", body: accountLabel + " • " + limitLabel + ": %" + event.boundary + " kaldı." };
```

- [ ] **Step 4: Run detector tests**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/local-notify-detect.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add -- lib/local-notify-detect.ts lib/local-notify-detect.test.ts
git diff --cached --check
git commit -m "feat: detect local limit milestones"
```

---

### Task 3: Implement the bounded privacy-safe local store

**Files:**

- Create: `lib/local-notify-store.ts`
- Create: `lib/local-notify-store.test.ts`

**Interfaces:**

```ts
export const LOCAL_NOTIFY_STATE_VERSION = 1;
export const MAX_LOCAL_NOTIFY_STATE_BYTES = 64 * 1024;
export const MAX_LOCAL_NOTIFY_RECORDS = 512;

export interface LocalNotifyRecord extends LocalLimitState {
  accountHash: string;
  limitKey: string;
}

export interface LocalNotifyDocument {
  version: 1;
  records: LocalNotifyRecord[];
}

export function parseLocalNotifyDocument(raw: string | null):
  | { ok: true; document: LocalNotifyDocument }
  | { ok: false; document: LocalNotifyDocument; error: "corrupt" | "oversized" | "future_version" };

export function loadLocalNotifyDocument(storage: Storage):
  | { ok: true; document: LocalNotifyDocument }
  | { ok: false; document: LocalNotifyDocument; error: "unavailable" | "corrupt" | "oversized" | "future_version" };

export function saveLocalNotifyDocument(
  storage: Storage,
  document: LocalNotifyDocument,
): { ok: true } | { ok: false; error: "unavailable" | "oversized" };

export async function hashLocalAccountId(accountId: string): Promise<string>;
export async function localNotificationTag(accountHash: string, limitKey: string): Promise<string>;
```

- [ ] **Step 1: Write failing codec/privacy tests**

Cover exact own-property schema, V1 only, max bytes/records, lowercase 64-hex hash, safe limit key up to 160 chars, null or valid ISO timestamp up to 40 chars, cursor 0-8, utilization 0-100, no duplicate `(accountHash, limitKey)`, canonical sort/serialization, storage exceptions, and fail-closed empty document.

Assert fixture email, account ID, access token, refresh token, label, and full name never occur in serialized state or opaque tag.

- [ ] **Step 2: Run and observe module absence**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/local-notify-store.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement strict codec and hashes**

Use `TextEncoder().encode(raw).byteLength` before JSON parse, reject inherited/extra fields, and return a wholly empty document on any invalid record. Hash account IDs with browser Web Crypto SHA-256 and hash `accountHash + "\0" + limitKey` again for an Action Center tag such as `hma:<first 32 hex>`; never expose the raw key in the tag.

- [ ] **Step 4: Run store and secret-oriented tests**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/local-notify-store.test.ts lib/safe-secret-scan.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add -- lib/local-notify-store.ts lib/local-notify-store.test.ts
git diff --cached --check
git commit -m "feat: persist private local alert state"
```

---

### Task 4: Add the validated service-worker delivery protocol

**Files:**

- Create: `lib/local-notify-delivery.ts`
- Create: `lib/local-notify-delivery.test.ts`
- Modify: `public/sw.js`
- Create: `lib/service-worker-notification.test.ts`

**Interfaces:**

```ts
export const LOCAL_NOTIFICATION_MESSAGE = "hma-local-limit-v1";
export const LOCAL_NOTIFICATION_ACK = "hma-local-limit-result-v1";

export interface LocalWorkerNotification {
  title: "How Much AI";
  body: string;
  tag: string;
}

export type LocalDeliveryResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "denied" | "worker" | "timeout"; message: string };

export function localNotificationPermission(): NotificationPermission | "unsupported";
export async function requestLocalNotificationPermission(): Promise<LocalDeliveryResult>;
export async function deliverLocalNotification(payload: LocalWorkerNotification): Promise<LocalDeliveryResult>;
```

- [ ] **Step 1: Write failing client and VM worker tests**

Client tests prove permission is requested only by the explicit function, `/sw.js` is registered, no PushManager subscription or `/api/notify/subscribe` call occurs, ack request IDs match, 10-second timeout fails generically, denied/unsupported fail without prompt loops, and errors never echo body/tag.

VM worker tests prove only exact own fields, title `How Much AI`, body 1-240 chars without controls, tag `^hma:[a-f0-9]{32}$`, same-origin source, valid MessagePort, and no extra fields reach `showNotification`. External/encoded click URLs must focus/open `/` only.

- [ ] **Step 2: Run and observe failures**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/local-notify-delivery.test.ts lib/service-worker-notification.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement worker message validation and ack**

Add a `message` handler while retaining hosted `push`. Call:

```js
self.registration.showNotification("How Much AI", {
  body: data.body,
  tag: data.tag,
  renotify: true,
  icon: "/icon.svg",
  badge: "/icon.svg",
  data: { url: "/" },
});
```

Post `{ type: "hma-local-limit-result-v1", requestId, ok: true }` only after the promise resolves; post only generic false on failure. Constrain every notification click to same-origin `/`.

- [ ] **Step 4: Implement permission/delivery client**

Require `Notification`, `serviceWorker`, `MessageChannel`, and `navigator.locks`; local delivery does not require PushManager. Register `/sw.js`, wait for ready, send through `MessageChannel`, validate exact ack, and apply a bounded timeout.

- [ ] **Step 5: Run local and hosted delivery tests**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/local-notify-delivery.test.ts lib/service-worker-notification.test.ts lib/notify-client.test.ts lib/notify-safety.test.ts lib/strict-local-notification.test.ts
```

Expected: all pass; strict-local server dispatch remains inert.

- [ ] **Step 6: Commit**

```powershell
git add -- lib/local-notify-delivery.ts lib/local-notify-delivery.test.ts public/sw.js lib/service-worker-notification.test.ts
git diff --cached --check
git commit -m "feat: deliver validated local alerts"
```

---

### Task 5: Serialize detection and delivery across tabs

**Files:**

- Create: `lib/local-notify-coordinator.ts`
- Create: `lib/local-notify-coordinator.test.ts`

**Interfaces:**

```ts
export interface LocalSnapshotInput {
  accountId: string;
  accountLabel: string;
  bars: readonly NormalizedUsageBar[];
  activeAccountIds: readonly string[];
  rules: LocalNotifyRules;
  stale: boolean;
}

export type LocalNotifyRuntimeStatus =
  | "idle" | "delivered" | "denied" | "unsupported"
  | "worker_error" | "storage_error" | "lock_unavailable";

export async function processLocalNotificationSnapshot(
  input: LocalSnapshotInput,
  dependencies?: LocalNotifyCoordinatorDependencies,
): Promise<{ status: LocalNotifyRuntimeStatus; delivered: number }>;
```

- [ ] **Step 1: Write failing orchestration tests**

Prove: stale returns idle without storage/hash/delivery; first snapshot seeds; events persist only after `{ok:true}`; denied/throw keeps the previous eventful row retryable; eventless rows still advance; one jump retries only the tightest boundary; reset retries exact copy; successful account snapshot prunes vanished limit keys; active-account pruning removes deleted accounts but retains failed/stale accounts; four Claude accounts isolate; two parallel calls enter one lock at a time; lock unavailable performs no read/write.

- [ ] **Step 2: Run and observe module absence**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/local-notify-coordinator.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement one exclusive transaction**

Use:

```ts
navigator.locks.request(
  "hma-local-notifications-v1",
  { mode: "exclusive", ifAvailable: true },
  async (lock) => lock ? runTransaction() : undefined,
);
```

Do not use an unlocked fallback. Read, validate, diff all bars, deliver events, apply accepted/silent states, prune, and write one canonical document inside the lock. Keep `accountLabel` ephemeral.

- [ ] **Step 4: Run coordinator/core/store tests**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/local-notify-coordinator.test.ts lib/local-notify-detect.test.ts lib/local-notify-store.test.ts lib/local-notify-delivery.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add -- lib/local-notify-coordinator.ts lib/local-notify-coordinator.test.ts
git diff --cached --check
git commit -m "feat: coordinate local alert delivery"
```

---

### Task 6: Add strict-local settings and fresh-only dashboard wiring

**Files:**

- Modify: `lib/storage.ts`
- Modify: `lib/storage.test.ts`
- Modify: `components/NotificationsPanel.tsx`
- Modify: `components/Dashboard.tsx`
- Create: `lib/local-notification-dashboard.test.ts`

**Interfaces:**

```ts
export interface LocalNotificationSettings {
  remainingWarnings: boolean;
  resetNotifications: boolean;
}

export interface Settings {
  autoRefresh: boolean;
  localNotifications: LocalNotificationSettings;
}

export function localAccountLabel(
  account: Pick<BrowserAccount, "label" | "provider">,
  providerOrdinal: number,
): string;

interface NotificationsPanelProps {
  open: boolean;
  onClose: () => void;
  strictLocal: boolean;
  autoRefresh: boolean;
  localStatus: LocalNotifyRuntimeStatus;
}
```

- [ ] **Step 1: Write failing settings/privacy tests**

Default settings are:

```ts
{
  autoRefresh: true,
  localNotifications: { remainingWarnings: true, resetNotifications: true },
}
```

Test backward compatibility with old `{autoRefresh}`, exact booleans only, canonical save, corrupt/oversized fallback, and storage failure. `localAccountLabel` uses a trimmed 1-40 character nickname only when it contains no control or `@`; otherwise returns `Claude N` or `ChatGPT N` without reading email/fullName/id.

- [ ] **Step 2: Write failing panel/dashboard integration tests**

Using the repository's SSR/source test pattern, prove strict-local panel shows `Kalan limit uyarıları`, `Limit sıfırlanınca bildir`, `50 · 40 · 30 · 20 · 15 · 10 · 5 · bitti`, explicit permission button, and auto-refresh warning without calling hosted APIs. Ordinary mode retains Convex/VAPID behavior.

Prove `Dashboard.refreshAccount()` calls the coordinator only for strict-local, successful, non-stale usage; reauth/loading/error/missing/stale responses do not; manual and automatic refresh share the path; notification failure cannot turn usage status into error; four Claude accounts receive ordinals 1-4.

- [ ] **Step 3: Run and observe missing behavior**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/storage.test.ts lib/local-notification-dashboard.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement settings and strict-local panel branch**

Keep hosted API calls confined to `strictLocal === false`. Local mode reads device settings, displays permission without prompting on mount, requests only on button click, toggles the two rules, shows denied/unsupported/storage/worker status, and explains `Otomatik yenileme kapalı; canlı bildirimler duraklatıldı.`

- [ ] **Step 5: Wire fresh snapshots non-blockingly**

After successful UI state update, process normalized bars only when `strictLocal && !data.stale`. Swallow only the generic notification result at the UI boundary; never log payload or account data. Pass active account IDs and provider ordinal.

- [ ] **Step 6: Run focused regressions**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/storage.test.ts lib/local-notification-dashboard.test.ts lib/local-notify-coordinator.test.ts lib/refresh-all.test.ts lib/browser-boundary.test.ts lib/notify-client.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```powershell
git add -- lib/storage.ts lib/storage.test.ts components/NotificationsPanel.tsx components/Dashboard.tsx lib/local-notification-dashboard.test.ts
git diff --cached --check
git commit -m "feat: configure local limit alerts"
```

---

### Task 7: Make every remaining limit visually inspectable

**Files:**

- Modify: `components/UsageBar.tsx`
- Modify: `components/AccountCard.tsx`
- Modify: `components/Dashboard.tsx`
- Modify: `app/globals.css`
- Create: `lib/usage-dashboard-ui.test.ts`

**Interfaces:**

```ts
interface UsageBarProps {
  bar: NormalizedUsageBar;
  now: number;
  stale: boolean;
  freshnessDescriptionId?: string;
}
```

- [ ] **Step 1: Write failing SSR/accessibility tests**

A Claude session at 85% used must visibly render:

```text
5 saatlik limit
%15 kaldı
Kullanılan: %85
```

Assert progressbar `aria-valuenow=15`, aria text includes remaining, used, reset, and stale status; reset uses `<time dateTime=...>` with countdown and exact Turkish time; 0 says `Limit bitti`; 50/30/15/0 have text states in addition to color; four Claude cards show `Claude 1` through `Claude 4` with unique headings and stable DOM order; loading/error with old bars is visibly stale.

- [ ] **Step 2: Run and observe used-only UI failure**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/usage-dashboard-ui.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement remaining-first bars**

Remove the initial animation that displays a false zero. Render remaining as primary, used as secondary, and make fill/aria represent remaining. Use textual states `Az kaldı`, `Kritik`, `Limit bitti`; preserve reduced motion. Add forced-colors CSS using `Canvas`, `CanvasText`, and `Highlight`.

- [ ] **Step 4: Make account freshness explicit**

Treat `snapshot.stale` or error-with-old-bars as old data. Keep last bars visible with a status banner and `data-stale=true`; move `aria-live` to status text so 30-second countdown ticks do not re-read the full card. Compute provider ordinals separately and use an ordered account list without CSS reordering.

- [ ] **Step 5: Run UI/type/build checks**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/usage-dashboard-ui.test.ts lib/format.test.ts lib/bootstrap-ui.test.ts lib/local-notification-dashboard.test.ts
npm run typecheck
npm run build
```

Expected: tests, typecheck, and build pass.

- [ ] **Step 6: Commit**

```powershell
git add -- components/UsageBar.tsx components/AccountCard.tsx components/Dashboard.tsx app/globals.css lib/usage-dashboard-ui.test.ts
git diff --cached --check
git commit -m "feat: show remaining limits visually"
```

---

### Task 8: Install a hash-bound Start-menu launcher

**Files:**

- Create: `scripts/windows/launch-secure-local.ps1`
- Modify: `scripts/windows/SecureLocalIntegrity.psm1`
- Modify: `scripts/windows/SecureLocalRuntime.psm1`
- Modify: `scripts/windows/install-secure-local.ps1`
- Modify: `scripts/windows/verify-final-local-state.ps1`
- Modify: `scripts/audit/create-runtime-manifest.mjs`
- Modify: `lib/runtime-manifest.test.ts`
- Modify: `lib/windows-startup-integrity.test.ts`
- Modify: `lib/windows-secure-launcher.test.ts`
- Modify: `lib/windows-secure-connector.test.ts`
- Modify: `lib/windows-final-local-state.test.ts`
- Create: `lib/windows-start-menu-launcher.test.ts`
- Modify: `docs/WINDOWS_SECURE_LOCAL.md`
- Modify: `README.md`

**Interfaces:**

- `bootstrapHashes.launcher` maps to `launch-secure-local.ps1`.
- `New-HmaStartMenuLauncherPlan` returns exact `Path`, `TargetPath`, `Arguments`, `WorkingDirectory`, `Description`, `IconLocation`, `WindowStyle`, and `Hotkey`.
- `Test-HmaStartMenuLauncherPlan` compares every field ordinally and validates private ACL/reparse boundaries.

- [ ] **Step 1: Write failing launcher/manifest tests**

Require bootstrap count 10 and exact launcher path. Shortcut path is current-user `SpecialFolder.Programs\How Much AI.lnk`; target is exact Windows PowerShell 5.1; arguments use `-NoProfile -NonInteractive`, verify installed launcher SHA-256 before execution, and pass only state root plus public integrity/launcher hashes. Assert no URL, password, ticket, account, or secret name/value appears.

Test service `Ready` starts Service then Window; `Running` starts Window only; missing/foreign/mutated task produces zero starts; other service states fail closed; only reserved task names are accepted; errors are generic.

- [ ] **Step 2: Write failing installer/verifier tests**

Exact existing shortcut is idempotent. Mismatched target/arguments/ACL/hotkey/window style/reparse is refused, never overwritten. Installer creates a temporary link, round-trip verifies, applies private ACL, then atomically moves. Rollback removes only a link created by that run. Final verifier checks both exact task plans and shortcut, scans it for secret values, and preserves fail-safe task/Edge shutdown.

- [ ] **Step 3: Run Windows tests and observe missing launcher**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/runtime-manifest.test.ts lib/windows-start-menu-launcher.test.ts lib/windows-startup-integrity.test.ts lib/windows-secure-launcher.test.ts lib/windows-final-local-state.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement the tenth hash-bound bootstrap file**

Add `launcher` to integrity maps, installer maps, runtime manifest expected paths, fixtures, and exact property/count checks. `launch-secure-local.ps1` imports hash-verified integrity/runtime modules, validates both registered task plans, starts only the valid service/window tasks, and emits only `Secure local launcher failed.` on failure.

- [ ] **Step 5: Implement deterministic shortcut creation and verification**

Use `WScript.Shell.CreateShortcut()` on a candidate inside private staging, reopen and compare all fields, apply private ACL, then move to an absent destination. If destination exists, accept only an exact plan/ACL; refuse mismatch. Track creation for precise rollback. Extend final verifier and uninstall docs.

- [ ] **Step 6: Run Windows and PowerShell parser gates**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/runtime-manifest.test.ts lib/windows-start-menu-launcher.test.ts lib/windows-startup-integrity.test.ts lib/windows-secure-launcher.test.ts lib/windows-secure-connector.test.ts lib/windows-final-local-state.test.ts lib/windows-acl-reparse.test.ts lib/windows-dpapi-secrets.test.ts
```

Parse every `scripts/windows/*.ps1`, `scripts/windows/*.psm1`, and `scripts/audit/invoke-trusted-node.ps1` with the Windows PowerShell 5.1 parser. Expected: tests pass and parser errors = 0.

- [ ] **Step 7: Commit**

```powershell
git add -- scripts/windows/launch-secure-local.ps1 scripts/windows/SecureLocalIntegrity.psm1 scripts/windows/SecureLocalRuntime.psm1 scripts/windows/install-secure-local.ps1 scripts/windows/verify-final-local-state.ps1 scripts/audit/create-runtime-manifest.mjs lib/runtime-manifest.test.ts lib/windows-startup-integrity.test.ts lib/windows-secure-launcher.test.ts lib/windows-secure-connector.test.ts lib/windows-final-local-state.test.ts lib/windows-start-menu-launcher.test.ts docs/WINDOWS_SECURE_LOCAL.md README.md
git diff --cached --check
git commit -m "feat: add a verified dashboard launcher"
```

---

### Task 9: Complete docs, security reviews, and release gates

**Files:**

- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/SELF_HOSTING.md`
- Modify: `docs/WINDOWS_SECURE_LOCAL.md`
- Modify: `lib/strict-local-notification.test.ts`
- Update ignored evidence: `audit/final/*`

**Interfaces:**

- Consumes: Tasks 0-8.
- Produces: a reviewed final commit ready for retained-anchor installation and five-account connection.

- [ ] **Step 1: Add final strict-local privacy assertions**

Prove server dispatch still performs zero Convex/remote fetch/Telegram/webhook/Web Push work in strict local. Scan local notification state and payload fixtures for email, full name, account ID, access/refresh token, raw reset URL, and raw provider fields. Assert only localStorage, Web Locks, same-origin worker, and credential-free browser DTOs participate.

- [ ] **Step 2: Update exact user/operator docs**

Document visual remaining limits, Claude five-hour rows, boundaries `50, 40, 30, 20, 15, 10, 5, bitti`, exact `limit sıfırlandı`, permission/auto-refresh, open/minimized limitation, no external local notification service, Start-menu reopening, hosted separation, and required ordinary-development `APP_PASSWORD`.

- [ ] **Step 3: Run focused feature tests**

```powershell
& 'C:\Program Files\nodejs\node.exe' --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/format.test.ts lib/local-notify-detect.test.ts lib/local-notify-store.test.ts lib/local-notify-delivery.test.ts lib/local-notify-coordinator.test.ts lib/service-worker-notification.test.ts lib/local-notification-dashboard.test.ts lib/usage-dashboard-ui.test.ts lib/strict-local-notification.test.ts lib/windows-start-menu-launcher.test.ts lib/windows-secure-launcher.test.ts lib/windows-final-local-state.test.ts lib/safe-secret-scan.test.ts
```

Expected: all pass.

- [ ] **Step 4: Run full trusted validation and scans**

Through the retained launcher, require:

```json
{"LaunchOk":true,"ExitCode":0,"CommandsPassed":3}
```

Run source secret scan with `FindingCount: 0`, PowerShell parser with zero errors, pinned `npm ls`, and `npm audit` with zero vulnerabilities.

- [ ] **Step 5: Rerun static and independent security review**

Run approved Semgrep security/secrets/OWASP/CWE and TypeScript/JavaScript/React/Node/Next.js rules with `--metrics=off`, plus previously validated third-party files. Require zero unresolved exploitable finding.

Request fresh code, differential, and adversarial reviews covering new files, localStorage/SW message boundary, reset/stale logic, payload privacy, UI consistency, launcher COM/ACL/task boundary, rollback, and auth closure. Fix all Critical/Important/High/Medium findings.

- [ ] **Step 6: Commit docs and review fixes**

```powershell
git add -- README.md .env.example docs/SELF_HOSTING.md docs/WINDOWS_SECURE_LOCAL.md lib/strict-local-notification.test.ts
git diff --cached --check
git commit -m "docs: document secure local alerts"
```

Stage any review-fix source paths explicitly in a separate `security: address final notification review` commit.

- [ ] **Step 7: Validate a fresh checkout and install**

Create a fresh local clone/worktree from final HEAD with committed `.gitattributes` and system `core.autocrlf=true`; require clean porcelain status. From that source:

1. run trusted `npm ci`, `npm ls`, `npm audit`, full tests/typecheck/build;
2. generate final commit, runtime manifest, and manifest hash;
3. run manifest-bound secret scan and two-start immutability proof;
4. run retained signed Microsoft Defender with read leases;
5. install manifest-bound files only;
6. verify loopback listener, DPAPI, ACLs, exact two tasks, exact shortcut, and no plaintext secrets;
7. connect four Claude accounts and one same-machine ChatGPT/Codex account;
8. visually confirm every Claude card includes its five-hour limit;
9. exercise local synthetic detector fixtures for all eight thresholds and reset copy without provider traffic.

Expected: clean scans, immutable runtime, exact local boundary, five visible accounts, and verified notification behavior.

---

## Execution and Review Gates

1. Task 0 commits the reviewed security baseline.
2. Tasks 1-2 establish shared semantics and receive specification then code review.
3. Tasks 3-5 establish privacy/storage/delivery boundaries and receive security review.
4. Tasks 6-7 integrate UI and receive specification, accessibility, and code review.
5. Task 8 changes the Windows trust boundary and receives dedicated adversarial review.
6. Task 9 is mandatory before installation or credential connection.

Execution uses fresh subagents per task with two-stage review. The primary agent independently reruns every claimed test before accepting a task.
