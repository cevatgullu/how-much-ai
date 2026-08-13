# Local Responsive Quota Instrument Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the installed strict-local How Much AI dashboard into the approved Turkish quota instrument, with stable source/weekly-usage/weekly-reset ordering and purpose-built 27-inch 4K and iPhone 17 Pro Max layouts, without changing background refresh or device-local notifications.

**Architecture:** Existing `BrowserAccount` and `AccountSnapshot` objects remain the dashboard inputs. A pure adapter derives weekly metrics through the existing `extractBars` and `parseResetTimestamp` functions, a reducer applies ordering only after refresh results settle, and `Dashboard` composes the ruler, readings, desktop cards, and mobile ledger without mutating vault order. The secure Windows runtime is updated only after tests, typecheck, and production build pass.

**Tech Stack:** Next.js 16.2.11 App Router, React 19.2.7, TypeScript 6.0.3, Tailwind CSS 4.3.2, Node.js 22 test runner, `next/font`, existing `ModalShell`, existing DPAPI-protected Windows strict-local runtime.

## Global Constraints

- Visible product name is exactly `How Much AI`; never add `Özel PWA`, `V2`, hosted, cloud, or first-run installation-note branding.
- The only sort modes are `Kayıt sırası`, `En çok haftalık kullanım`, and `En yakın haftalık yenilenme`.
- Weekly candidates are exactly normalized bars whose `kind` is `weekly_all`, `weekly_oauth_apps`, or `weekly_scoped`.
- Derive metrics only from `AccountSnapshot` through existing `extractBars(usage)` and `parseResetTimestamp(value)`; do not create hosted projection or aggregate types.
- GPT-5.3-Codex-Spark is already excluded at provider normalization. Do not add any downstream Spark name/model/feature/substring filter.
- Sorting is presentation-only: never mutate or persist encrypted vault order and never renumber `accountProviderOrdinals(accounts)`.
- Preserve strict-local refresh: while enabled, `refreshAll()` continues every 60 seconds when the tab/window is hidden, backgrounded, or minimized. Do not add `document.hidden`, `visibilityState`, `visibilitychange`, focus-only polling, or a visibility lease.
- Preserve strict-local notifications exactly: fresh automatic/manual refreshes still enter the nonblocking `LocalNotificationTaskQueue`; stale/error readings remain suppressed; thresholds, reset detection, Web Lock, service worker, privacy-minimized state, and device-only delivery do not change.
- Do not add Vercel, Convex, aggregate snapshots, hosted schedulers, hosted renewal states, cloud push, PWA metadata/worker changes, or hosted browser-evidence modes.
- Visual direction is “Kota Cetveli / The Measure”: matte surfaces and semantic color only; no decorative gradient, glass/backdrop blur, glow, card lift, carousel, or continuous decorative motion.
- Tokens: canvas `#111614`, panel `#19201D`, strong rule `#697770`, primary text `#F1F4EF`, secondary text `#A5B1AA`, calibration blue `#78A7BF`, Claude coral `#D97757`, amber `#D9A557`, danger `#E05B5B`, and `rule-soft: color-mix(in srgb, #697770 42%, transparent)`.
- Fonts: Barlow Condensed headings, Atkinson Hyperlegible Next body/controls, Atkinson Hyperlegible Mono data; use `latin-ext` through `next/font`, no runtime font request, and no new npm dependency.
- Support `440×956`, `956×440`, `390×844`, `768×1024`, `1366×768`, `1440×900`, `1920×1080`, `2560×1440`, and `3840×2160`, plus `959/960`, `1919/1920`, `2879/2880`, and landscape `899/900 × 500/501` boundaries.
- Use `100dvh` with `100vh` fallback, `viewport-fit=cover`, and all `env(safe-area-inset-*)`; never hard-code a notch or 956px height.
- Touch targets are at least 44×44 CSS px and bottom commands at least 48px high. Preserve keyboard access, visible focus, VoiceOver/Narrator DOM order, 200% zoom, forced colors, reduced motion, and no mobile page overflow.
- Follow RED-GREEN TDD. Final repository validation order is exactly `npm.cmd test`, `npm.cmd run typecheck`, then `npm.cmd run build`.

## File structure

- `lib/quota-metrics.ts`: local weekly derivation, sorting, and summary.
- `lib/dashboard-order-state.ts`: refresh settlement and focus/pointer reorder fence, with no React/DOM references.
- `lib/quota-ruler-layout.ts`: deterministic marker lanes and clusters.
- `components/QuotaRuler.tsx` and `components/QuotaReadings.tsx`: semantic overview.
- `components/AccountCard.tsx`: one shared derivation, desktop card, and mobile ledger row.
- `components/DashboardHeader.tsx`, `components/DashboardSheets.tsx`, and `components/MobileCommandBar.tsx`: responsive local controls only.
- `components/Dashboard.tsx`: vault, refresh, local notification, and composition boundary.
- `app/layout.tsx` and `app/globals.css`: language, viewport, fonts, tokens, breakpoints, and safe areas.
- Secure installation is an operational final gate; never edit installer/runtime checks to make an update pass.

---

### Task 1: Local weekly metrics and three sort modes

**Files:**
- Create: `lib/quota-metrics.ts`
- Create: `lib/quota-metrics.test.ts`
- Read unchanged: `lib/types.ts`
- Read unchanged: `lib/format.ts`
- Verify unchanged: `lib/providers/openai.test.ts`

**Interfaces:**

```ts
export type QuotaSortMode = "source" | "weekly-usage" | "weekly-reset";

export interface WeeklyAccountMetric {
  accountId: string;
  sourceIndex: number;
  highestWeeklyUsedPercent: number | null;
  highestWeeklyLimitKey: string | null;
  highestWeeklyLimitLabel: string | null;
  nearestWeeklyResetAt: string | null;
  nearestWeeklyResetKey: string | null;
  nearestWeeklyResetLabel: string | null;
  hasFreshReading: boolean;
}

export interface WeeklyAccountSummary {
  accountCount: number;
  highestUsage: WeeklyAccountMetric | null;
  nearestReset: WeeklyAccountMetric | null;
}

export function deriveWeeklyAccountMetric(
  account: BrowserAccount,
  snapshot: AccountSnapshot | undefined,
  sourceIndex: number,
  acceptedAt: number,
): WeeklyAccountMetric;

export function deriveWeeklyAccountMetrics(
  accounts: readonly BrowserAccount[],
  snapshots: Readonly<Record<string, AccountSnapshot>>,
  acceptedAt: number,
): WeeklyAccountMetric[];

export function sortWeeklyAccountMetrics(
  metrics: readonly WeeklyAccountMetric[],
  mode: QuotaSortMode,
): WeeklyAccountMetric[];

export function summarizeWeeklyAccountMetrics(
  metrics: readonly WeeklyAccountMetric[],
): WeeklyAccountSummary;
```

- [ ] **Step 1: Write failing derivation and sorting tests**

Use `acceptedAt = Date.parse("2026-08-12T09:00:00.000Z")` and real `UsageData`. Assert overall 61%, OAuth 72%, and Opus 88% chooses Opus for usage while an earlier future overall reset chooses `weekly_all` for reset:

```ts
assert.deepEqual(deriveWeeklyAccountMetric(account, snapshot, 3, acceptedAt), {
  accountId: "account-a",
  sourceIndex: 3,
  highestWeeklyUsedPercent: 88,
  highestWeeklyLimitKey: "weekly_scoped:opus",
  highestWeeklyLimitLabel: "Opus haftalık limiti",
  nearestWeeklyResetAt: "2026-08-12T10:00:00.000Z",
  nearestWeeklyResetKey: "weekly_all",
  nearestWeeklyResetLabel: "Haftalık limit",
  hasFreshReading: true,
});
```

Cover candidate inclusion/exclusion; maximum ties ordered `weekly_all`, `weekly_oauth_apps`, then lexical `weekly_scoped`; future reset choice including inactive/0%-used rows; malformed/impossible/past resets through real `parseResetTimestamp`; stale/loading/error last-good metrics marked not fresh; missing data as `null`, never 0%; all three sorts; missing metric last; source-index then account-id tie; summary winners; and no input mutation. Do not import or implement a Spark matcher; rely on the existing provider test.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/quota-metrics.test.ts lib/format.test.ts lib/providers/openai.test.ts
```

Expected: FAIL because `lib/quota-metrics.ts` does not exist.

- [ ] **Step 3: Implement the pure adapter**

Call `extractBars(snapshot.usage)` once. Filter only by the three exact `kind` values, keep normalized labels/percentages, and call `parseResetTimestamp`. `hasFreshReading` is true only for `status === "ready" && stale !== true`; old bars remain usable but stale. Never inspect provider/model display names.

- [ ] **Step 4: Run Step 2 and verify GREEN**

Expected: metric, format, and upstream Spark-normalization tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- lib/quota-metrics.ts lib/quota-metrics.test.ts
git commit -m "feat: derive local weekly quota metrics"
```

---

### Task 2: Persist sorting without disturbing local settings

**Files:**
- Modify: `lib/storage.ts`
- Modify: `lib/storage.test.ts`

**Interfaces:**

```ts
export interface Settings {
  autoRefresh: boolean;
  sortMode: QuotaSortMode;
  localNotifications: LocalNotificationSettings;
}
```

- [ ] **Step 1: Write failing migration and storage tests**

Keep key `usage.settings.v1`. Add `sortMode:"source"` to every default. Cover three valid modes, missing legacy field, invalid/future strings, malformed/oversized JSON, read/write exceptions, and preservation of notification booleans. Require canonical order `autoRefresh`, `sortMode`, `localNotifications` and prove no account id, email, snapshot, or history is stored.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/storage.test.ts lib/local-notification-dashboard.test.ts
```

Expected: FAIL because `Settings.sortMode` does not exist.

- [ ] **Step 3: Extend the bounded parser/writer**

Keep the 4 KiB `TextEncoder` cap and existing key. Accept only the three literals; default only an invalid sort field to `source`. Preserve legacy migration and return `false` on write failure. Do not create another store.

- [ ] **Step 4: Run Step 2 and verify GREEN**

- [ ] **Step 5: Commit**

```powershell
git add -- lib/storage.ts lib/storage.test.ts
git commit -m "feat: remember local quota sorting"
```

---

### Task 3: Refresh-settled ordering and interaction fence

**Files:**
- Create: `lib/dashboard-order-state.ts`
- Create: `lib/dashboard-order-state.test.ts`

**Interfaces:**

```ts
export type InteractionChannel = "focus" | "pointer";
export type DashboardOrderEvent =
  | { type: "batch_started"; accountIds: readonly string[] }
  | { type: "account_settled"; accountId: string }
  | { type: "candidate_order"; accountIds: readonly string[]; acceptedEpoch: number }
  | { type: "sort_changed"; mode: QuotaSortMode; accountIds: readonly string[] }
  | { type: "accounts_changed"; accountIds: readonly string[] }
  | { type: "interaction_enter"; accountId: string; channel: InteractionChannel }
  | { type: "interaction_leave"; accountId: string; channel: InteractionChannel };

export interface DashboardOrderState {
  mode: QuotaSortMode;
  visibleAccountIds: readonly string[];
  pendingAccountIds: readonly string[] | null;
  unsettledAccountIds: readonly string[];
  focusAccountIds: readonly string[];
  pointerAccountIds: readonly string[];
  acceptedEpoch: number;
}

export function initialDashboardOrderState(
  accountIds: readonly string[],
  mode: QuotaSortMode,
): DashboardOrderState;
export function dashboardOrderReducer(
  state: DashboardOrderState,
  event: DashboardOrderEvent,
): DashboardOrderState;
export function resolvedDashboardOrder(
  metrics: readonly WeeklyAccountMetric[],
  mode: QuotaSortMode,
): string[];
```

- [ ] **Step 1: Write failing transition tests**

Drive initial vault order, partial/final batch, refresh-all, one-account refresh, sort change, add/remove, focus, and pointer transitions. Partial results cannot reorder; final settlement accepts one candidate; pending order waits for the last interaction fence. Prove there is no clock event and expanded ids remain stable through reorder.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/dashboard-order-state.test.ts lib/quota-metrics.test.ts
```

Expected: FAIL because the reducer does not exist.

- [ ] **Step 3: Implement the immutable reducer**

Keep separate focus/pointer sets. Accept `candidate_order` only with no unsettled ids; park it while either interaction set is nonempty. `accounts_changed` removes deleted ids and appends new ids in vault order without touching source accounts.

- [ ] **Step 4: Run Step 2 and verify GREEN**

- [ ] **Step 5: Commit**

```powershell
git add -- lib/dashboard-order-state.ts lib/dashboard-order-state.test.ts
git commit -m "feat: settle local quota ordering"
```

---

### Task 4: Deterministic ruler placement and semantic ruler UI

**Files:**
- Create: `lib/quota-ruler-layout.ts`
- Create: `lib/quota-ruler-layout.test.ts`

**Interfaces:**

```ts
export interface RulerMarkerInput {
  accountId: string;
  sourceIndex: number;
  usedPercent: number;
  labelWidth: number;
}
export interface RulerMarkerPlacement extends RulerMarkerInput {
  centerX: number;
  left: number;
  lane: 0 | 1 | 2;
}
export interface RulerCluster {
  id: string;
  centerX: number;
  members: readonly RulerMarkerInput[];
}
export function stableRulerClusterId(members: readonly RulerMarkerInput[]): string;
export function placeQuotaRulerMarkers(
  markers: readonly RulerMarkerInput[],
  rulerWidth: number,
  minimumGap?: number,
): { placements: RulerMarkerPlacement[]; clusters: RulerCluster[] };
```

- [ ] **Step 1: Write failing lane/cluster tests**

Cover 7/12 markers, equal percentages, long Turkish labels, 0/50/85/100, 8px gap, three-lane maximum, deterministic output, input immutability, and stable `+N` clusters ordered by percentage then source/account id.

- [ ] **Step 2: Run focused test and verify RED**

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/quota-ruler-layout.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement pixel-space placement**

Clamp 0–100, calculate pixel center, keep label boxes inside the track, and choose the first nonoverlapping lane. Hash only ordered opaque account ids/source indices with browser-safe TypeScript; return `ruler-cluster-[a-z0-9]+` and import no Node crypto.

- [ ] **Step 4: Run Step 2 and verify GREEN**

Expected: every placement and cluster assertion passes before UI wiring begins.

#### Ruler component boundary

**Files:**
- Create: `components/QuotaRuler.tsx`
- Create: `components/QuotaReadings.tsx`
- Create: `lib/quota-instrument-ui.test.ts`
- Modify: `components/Icons.tsx`

**Interfaces:**

```ts
export interface QuotaRulerProps {
  metrics: readonly WeeklyAccountMetric[];
  accountsById: ReadonlyMap<string, BrowserAccount>;
  providerOrdinals: ReadonlyMap<string, number>;
}
export interface QuotaReadingsProps {
  summary: WeeklyAccountSummary;
  accountsById: ReadonlyMap<string, BrowserAccount>;
  providerOrdinals: ReadonlyMap<string, number>;
}
```

- [ ] **Step 5: Write failing rendered-structure tests**

Assert primary ticks `0/50/85/100`, secondary ticks `25/75`, an `aria-hidden` visual track, and a named semantic `<ol>` with every account, percentage, winning limit label, and `son veri`. No-data accounts belong to `İlk veri bekleniyor`, never 0%. A `+N` cluster is a real named button. Readings are `Hesap`, `En yüksek haftalık kullanım`, and `En yakın haftalık yenilenme`, with account and winning-label identity. Export and unit-test a pure `quotaRulerPopupReducer` for open/close/Enter/Escape.

- [ ] **Step 6: Run rendered-structure tests and verify RED**

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/quota-instrument-ui.test.ts lib/quota-ruler-layout.test.ts
```

Expected: FAIL because the ruler components do not exist.

- [ ] **Step 7: Implement the ruler and readings**

Use `ResizeObserver` only for track/label measurements. Keep the complete semantic list in server markup. Desktop permits three lanes; mobile uses a 104px track with every account as a short tick, labels only the highest directly, and adds `En yoğun`. Cluster content is keyboard accessible, closes with Escape, and restores focus.

- [ ] **Step 8: Run Step 6 and verify GREEN**

- [ ] **Step 9: Commit the ruler algorithm and UI together**

```powershell
git add -- lib/quota-ruler-layout.ts lib/quota-ruler-layout.test.ts components/QuotaRuler.tsx components/QuotaReadings.tsx components/Icons.tsx lib/quota-instrument-ui.test.ts
git commit -m "feat: render the local quota instrument"
```

---

### Task 5: Desktop card and iPhone quota ledger

**Files:**
- Modify: `components/AccountCard.tsx`
- Modify: `components/UsageBar.tsx`
- Modify: `lib/usage-dashboard-ui.test.ts`

**Interfaces:**

```ts
export function deriveFiveHourPeak(
  bars: readonly NormalizedUsageBar[],
): number | null;

interface AccountCardProps {
  account: BrowserAccount;
  snapshot: AccountSnapshot | undefined;
  metric: WeeklyAccountMetric;
  fiveHourPeak: number | null;
  now: number;
  providerOrdinal: number;
  mobileExpanded: boolean;
  onMobileExpandedChange: (expanded: boolean) => void;
  onInteractionFenceChange: (channel: InteractionChannel, active: boolean) => void;
  onRefresh: () => void;
  onRemove: () => void;
  onReconnect?: () => void;
  onRename: (label: string | undefined) => void;
}
```

- [ ] **Step 1: Write failing card/ledger tests**

Render existing local states `idle`, `loading`, `ready`, ready+stale, `error` with last-good data, and `reauth`. Require stable `Claude 2`/`ChatGPT 1`, nickname-first identity, secondary/truncated email, full desktop rows, and mobile five-hour peak, weekly peak, nearest reset, and state. Missing is `—`, never 0%. The expand button owns `aria-expanded`/`aria-controls`; the stable-id panel uses `hidden`; refresh/rename/remove/reconnect are outside the button. Prove two controlled rows stay open and open ids survive reorder.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/usage-dashboard-ui.test.ts lib/quota-metrics.test.ts
```

Expected: new props and ledger assertions fail.

- [ ] **Step 3: Implement two responsive presentations from one derivation**

Call `extractBars` once. Desktop shows every real row. Below 960px, the closed ledger shows identity, plan, five-hour/weekly peaks, nearest renewal, and stale/error/reauth state; the controlled panel holds all bars/actions. `deriveFiveHourPeak` selects only highest `kind === "session"`. Remove index rise/card lift, use tabular numerals, wrapping, `min-width:0`, and no carousel. Preserve current stale bars, one freshness live region, confirmations, and Codex session label.

- [ ] **Step 4: Run Step 2 and verify GREEN**

- [ ] **Step 5: Commit**

```powershell
git add -- components/AccountCard.tsx components/UsageBar.tsx lib/usage-dashboard-ui.test.ts
git commit -m "feat: add the mobile quota ledger"
```

---

### Task 6: Local controls, settled Dashboard integration, and background refresh

**Files:**
- Create: `components/DashboardHeader.tsx`
- Create: `components/DashboardSheets.tsx`
- Create: `components/MobileCommandBar.tsx`
- Modify: `components/Dashboard.tsx`
- Modify: `components/ModalShell.tsx`
- Modify: `lib/quota-instrument-ui.test.ts`
- Modify: `lib/usage-dashboard-ui.test.ts`
- Modify: `lib/modal-background-isolation.test.ts`
- Modify: `lib/local-notification-dashboard.test.ts`

**Interfaces:**
- `DashboardHeader`: `How Much AI`, health, automatic-refresh state, and desktop actions.
- `DashboardSheets`: exactly one of `sort`, `menu`, or `null` through `ModalShell`.
- `MobileCommandBar`: `Yenile`, `Hesap`, `Uyarılar`, `Menü`, in that order.
- `ModalShell`: add `placement?: "center" | "sheet"` while preserving modal stack, inert background, Escape, and focus return.

- [ ] **Step 1: Write failing controls and integration tests**

Require three native radio choices with exact Turkish labels, selected sort in the compact strip, `Hesap ekle` accessible name, and menu-only automatic refresh plus sign-out/security information. Assert no live-view/server-monitor/PWA/cloud control.

Replace the current Dashboard source-shape test with behavior: render an `<ol>` from resolved ids and observe DOM order, stable keys, source-derived provider ordinals, and expanded-id preservation. Cover initial source order, one reorder after every initial/batch result settles, no partial jump, one-account settlement, sort persistence, no-metric source fallback with `Sıralamak için kullanılabilir haftalık veri yok`, expired frozen reset copy `yenilenme verisi bekleniyor` without clock reorder, focus/pointer deferral, and `scrollIntoView({ block:"nearest" })` after release.

Extend local notification tests to require the 60-second interval whenever ready+enabled, with no visibility condition, and the same nonblocking `refreshAccount → LocalNotificationTaskQueue` path for automatic/manual refresh. Reject `document.hidden`, `document.visibilityState`, and `visibilitychange` in scheduling.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/dashboard-order-state.test.ts lib/quota-instrument-ui.test.ts lib/usage-dashboard-ui.test.ts lib/modal-background-isolation.test.ts lib/local-notification-dashboard.test.ts
```

Expected: controls, integration, and refresh-preservation assertions fail.

- [ ] **Step 3: Wire atomic snapshots and settled ordering**

Create `commitSnapshot(accountId, updater)` that updates `snapshotsRef.current` and state from the same object. Dispatch `batch_started`, `account_settled` in each refresh `finally`, then one `candidate_order` after `refreshAllAccounts` resolves using a frozen `acceptedAt`. Single refresh recomputes once. `useNow` changes countdown text only. Derive provider ordinals from unsorted accounts, map visible ids back to source accounts, and key expanded state by account id.

- [ ] **Step 4: Preserve the runtime contract while composing controls**

Keep this behavior semantically unchanged and add no visibility listener:

```ts
useEffect(() => {
  if (vaultState !== "ready" || !autoRefresh) return;
  const timer = setInterval(() => void refreshAll(), 60_000);
  return () => clearInterval(timer);
}, [vaultState, autoRefresh, refreshAll]);
```

Keep fresh strict-local responses enqueued with `void localNotifyQueueRef.current.enqueue(...)`, never `await`. Keep `NotificationsPanel` mounted with `strictLocal`, `autoRefresh`, and `localStatus`.

- [ ] **Step 5: Run Step 2 and verify GREEN**

- [ ] **Step 6: Commit**

```powershell
git add -- components/DashboardHeader.tsx components/DashboardSheets.tsx components/MobileCommandBar.tsx components/Dashboard.tsx components/ModalShell.tsx lib/quota-instrument-ui.test.ts lib/usage-dashboard-ui.test.ts lib/modal-background-isolation.test.ts lib/local-notification-dashboard.test.ts
git commit -m "feat: integrate the local quota dashboard"
```

---

### Task 7: Visual system, Turkish local UI, 4K, and safe areas

**Files:**
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`
- Modify: `components/PasswordLogin.tsx`
- Modify: `components/AddAccountModal.tsx`
- Modify: `components/AccountCard.tsx`
- Modify: `components/BootstrapSession.tsx`
- Modify: `components/Dashboard.tsx`
- Modify: `components/DashboardHeader.tsx`
- Modify: `components/DashboardSheets.tsx`
- Modify: `components/MobileCommandBar.tsx`
- Modify: `components/ModalShell.tsx`
- Modify: `components/NotificationsPanel.tsx` only for its strict-local branch/shared visual primitive
- Modify: `components/OAuthCallbackSession.tsx`
- Modify: `components/OpenAIDeviceLogin.tsx`
- Modify: `components/SignOutButton.tsx`
- Modify: `components/providers-ui.tsx`
- Modify: `lib/format.ts`
- Modify: `lib/format.test.ts`
- Modify: `lib/bootstrap-ui.test.ts`
- Modify: `lib/quota-instrument-ui.test.ts`
- Modify: `lib/usage-dashboard-ui.test.ts`
- Modify: `lib/local-notification-dashboard.test.ts`

**Interfaces:**
- `app/layout.tsx` exports Turkish metadata plus a Next.js `Viewport` with `viewportFit:"cover"`; no manifest, Apple PWA, worker, or hosted metadata.
- Applies approved tokens, typography, breakpoints, safe areas, and Turkish copy to strict-local visible states.

- [ ] **Step 1: Write failing Turkish/render contracts**

Render strict-local launcher guidance, bootstrap, OAuth callback, OpenAI device login, dashboard, add/reconnect, cards, empty/error/stale/reauth, local notifications, modal, and sign-out. Assert `html lang="tr"`, title/application name exactly `How Much AI`, and explicit Turkish visible/ARIA names. Keep proper/protocol names unchanged. Update format tests for `tr-TR`, device time zone, and Turkish relative/reset copy without changing ISO values. Verify `strictLocal:true` never loads hosted push.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/bootstrap-ui.test.ts lib/format.test.ts lib/quota-instrument-ui.test.ts lib/usage-dashboard-ui.test.ts lib/local-notification-dashboard.test.ts
```

Expected: English local copy/document language and old visual contracts fail.

- [ ] **Step 3: Install fonts and semantic tokens**

Use `Barlow_Condensed`, `Atkinson_Hyperlegible_Next`, and `Atkinson_Hyperlegible_Mono` from `next/font/google` with `latin-ext`, CSS variables, and `display:"swap"`. Generated assets are local runtime files; add no runtime Google link or package. Install the exact global color tokens. Remove radial gradients, backdrop blur, glow, card lift, index rise, shimmer, and infinite decorative animation. Preserve focus, forced-color progress boundaries, and reduced-motion zero transition.

- [ ] **Step 4: Implement the exact responsive CSS**

```css
@media (min-width: 2880px) { .instrument-shell { width: min(3264px, 90vw); } }
@media (min-width: 1920px) and (max-width: 2879px) { .instrument-shell { width: min(3264px, 90vw); } }
@media (min-width: 960px) and (max-width: 1919px) { .instrument-shell { width: calc(100% - 2 * clamp(24px, 4vw, 64px)); } }
@media (max-width: 959px) { .instrument-shell { width: auto; margin-inline: calc(16px + env(safe-area-inset-left)) calc(16px + env(safe-area-inset-right)); } }
```

Require `>=2880` four columns/24px gap/min 600px/ruler 196px; `1920–2879` three/24/min 560/ruler 176; `960–1919` two/20/min 420/ruler 176; `<960` one ledger/16/ruler 104. `orientation:landscape and (min-width:900px) and (max-height:500px)` is exactly two compact ledgers; 899px or 501px returns to normal. At `>=3200`, body/secondary/account/main values are at least 18/14/20/24px. Use `100vh` then `100dvh`; apply safe areas to header, sheets, shell, command bar, and main bottom clearance.

- [ ] **Step 5: Localize strict-local copy**

Translate launcher/bootstrap/OAuth, device login, dashboard actions/sort/vault states, editing/removal/reconnect, freshness/reset, local notification permission/rules/status, footer, modal, and ARIA names. Keep raw errors behind generic/reference-code boundaries. Exact key copy:

```text
How Much AI
Kota cetveli
Kayıt sırası
En çok haftalık kullanım
En yakın haftalık yenilenme
Yenile
Hesap
Uyarılar
Menü
Otomatik yenileme
Sıralamak için kullanılabilir haftalık veri yok
yenilenme verisi bekleniyor
```

Keep the local notification promise visible: works while the dedicated window is open/minimized, uses automatic/manual readings, and sends no account data to a notification service. Do not restructure/localize the out-of-scope hosted notification panel beyond shared styling.

- [ ] **Step 6: Run Step 2 and verify GREEN**

- [ ] **Step 7: Commit**

```powershell
git add -- app/layout.tsx app/globals.css components/PasswordLogin.tsx components/AddAccountModal.tsx components/AccountCard.tsx components/BootstrapSession.tsx components/Dashboard.tsx components/DashboardHeader.tsx components/DashboardSheets.tsx components/MobileCommandBar.tsx components/ModalShell.tsx components/NotificationsPanel.tsx components/OAuthCallbackSession.tsx components/OpenAIDeviceLogin.tsx components/SignOutButton.tsx components/providers-ui.tsx lib/format.ts lib/format.test.ts lib/bootstrap-ui.test.ts lib/quota-instrument-ui.test.ts lib/usage-dashboard-ui.test.ts lib/local-notification-dashboard.test.ts
git commit -m "feat: apply the local quota instrument design"
```

---

### Task 8: Validation, visual matrix, and gated secure-runtime update

**Files:**
- No source modification.
- Read/execute unchanged: `docs/WINDOWS_SECURE_LOCAL.md`
- Read/execute unchanged: `scripts/windows/install-secure-local.ps1`
- Read/execute unchanged: `scripts/windows/verify-final-local-state.ps1`

**Interfaces:**
- Consumes clean Tasks 1–7 and installed `%LOCALAPPDATA%\HowMuchAI`.
- Produces a verified immutable update preserving `secrets.dpapi`, encrypted vault, Edge profile, two exact tasks, and loopback-only port 37645.

- [ ] **Step 1: Run focused suites**

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/quota-metrics.test.ts lib/storage.test.ts lib/dashboard-order-state.test.ts lib/quota-ruler-layout.test.ts lib/quota-instrument-ui.test.ts lib/usage-dashboard-ui.test.ts lib/modal-background-isolation.test.ts lib/local-notification-dashboard.test.ts lib/bootstrap-ui.test.ts lib/format.test.ts lib/providers/openai.test.ts
```

Expected: all pass, including background refresh, local notifications, and provider Spark exclusion.

- [ ] **Step 2: Run repository validation in mandatory order**

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
git diff --check
git status --short
```

Expected: first four exit 0, vault-trace assertion passes, and status is empty. Stop on failure; do not touch the running installation.

- [ ] **Step 3: Execute the reviewed secure update only after Step 2**

In one clean non-elevated `-NoProfile` Windows PowerShell 5.1 child, execute `docs/WINDOWS_SECURE_LOCAL.md` **Installation** retained-anchor workflow through sanitized validation, final manifest, secret scan, runtime-immutability, static analysis, and Defender. Do not recompute a failed anchor or read/log secrets. Bind the old compare-and-swap anchor:

```powershell
$hmaState = Join-Path $env:LOCALAPPDATA 'HowMuchAI'
$hmaInstalled = Get-Content -Raw -LiteralPath (Join-Path $hmaState 'install.json') | ConvertFrom-Json -ErrorAction Stop
$trustedInstalledManifestSha256 = ([string]$hmaInstalled.manifestSha256).ToLowerInvariant()
if ($trustedInstalledManifestSha256 -notmatch '^[a-f0-9]{64}$') { throw 'The installed manifest anchor is invalid.' }
```

After the documented verified task/profile shutdown proves both tasks `Ready`, no dedicated Edge process, and no port-37645 listener, invoke the retained reviewed installer variables established by that workflow:

```powershell
& $installerScript `
  -SourceRoot $sourceRoot `
  -ExpectedManifestSha256 $trustedManifestSha256 `
  -NodePath $node `
  -ExpectedNodeSha256 $trustedNodeSha256 `
  -Ps51Path $ps51 `
  -ExpectedPs51Sha256 $trustedPs51Sha256 `
  -ExpectedInstalledManifestSha256 $trustedInstalledManifestSha256
if ($LASTEXITCODE -ne 0) { throw 'The secure local update failed.' }
```

Never bypass installer invariants. A failed update stays stopped until documented rollback/recovery proves safety.

- [ ] **Step 4: Verify installed boundary and launch**

Run the installed integrity, task-plan, immutable-runtime, and final-state checks exactly under `docs/WINDOWS_SECURE_LOCAL.md` **Verification commands**, then start through the reviewed launcher. Require exactly one loopback listener and successful local HTTP:

```powershell
$hmaListeners = @(Get-NetTCPConnection -State Listen -LocalPort 37645)
if ($hmaListeners.Count -ne 1 -or $hmaListeners[0].LocalAddress -cne '127.0.0.1') { throw 'How Much AI is not exclusively loopback-bound.' }
$hmaStatus = & curl.exe -sS -o NUL -w '%{http_code}' 'http://127.0.0.1:37645/'
if ($hmaStatus -notin @('200','302','303','307','308')) { throw ('How Much AI returned HTTP ' + $hmaStatus) }
```

- [ ] **Step 5: Inspect live visual/accessibility matrix**

Inspect exact unique viewports `440×956`, `956×440`, `390×844`, `768×1024`, `1366×768`, `1440×900`, `1920×1080`, `2560×1440`, `3840×2160`, `959×900`, `960×900`, `1919×1080`, `2879×1440`, `2880×1440`, `899×500`, `900×500`, `1440×500`, and `1440×501`. Verify columns/gaps/min card/ruler height, long Turkish labels, seven-plus accounts, missing/scoped/stale/error/reauth states, open ruler cluster, safe areas, and command-bar clearance. On mobile require `scrollWidth <= clientWidth`.

Exercise Enter/Escape on clusters, both sheets, Tab/Shift+Tab trap, caller focus return, independent ledgers, reorder focus fence, 200% zoom, reduced motion, and forced colors. Computed representative surfaces must have no backdrop filter, decorative gradient, hover translation, or infinite decorative animation.

- [ ] **Step 6: Verify background notification-critical behavior live**

With auto refresh enabled and permission granted through the UI, minimize/background the dedicated window for over 60 seconds without closing it. Return and require a refresh attempt/last-refresh time from the background interval, local notification status still device-local, and no visibility-pause message. Do not alter provider/account data to manufacture a notification.

- [ ] **Step 7: Record sanitized completion evidence**

Record commit, installed manifest hash, final verifier result, loopback result, viewport checklist, and background-refresh observation. Never include emails, account ids, tokens, secrets, task command lines, decrypted DPAPI contents, or screenshots with private identifiers.
