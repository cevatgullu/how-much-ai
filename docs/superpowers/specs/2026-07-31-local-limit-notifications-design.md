# Secure local limit notifications

Date: 2026-07-31
Status: user-approved design

## Goal

Add privacy-preserving notifications to the secure local desktop dashboard for every connected account and every usage limit reported by its provider. Claude's rolling five-hour limit is explicitly required, alongside its weekly and model-scoped limits. ChatGPT/Codex limits are included whenever the provider response exposes them.

The notification language is Turkish. A reset notification must contain the exact phrase `limit sıfırlandı`.

## User-visible behavior

For each account and limit, notify when the remaining allowance crosses one of these boundaries:

- 50%
- 40%
- 30%
- 20%
- 15%
- 10%
- 5%
- 0% (`limit bitti`)

The detector derives remaining allowance as `100 - utilization`, clamps the provider value to 0-100, and triggers when a previously higher remaining value becomes equal to or lower than a boundary. A boundary is announced at most once in a reset window.

Examples:

- `Claude 1 • 5 saatlik limit: %40 kaldı.`
- `Claude 3 • haftalık limit: %5 kaldı.`
- `ChatGPT • 5 saatlik limit: limit bitti.`
- `Claude 2 • 5 saatlik limit: limit sıfırlandı.`

If one refresh jumps across several boundaries, emit only the tightest newly crossed boundary. Mark all skipped boundaries as passed so a later refresh cannot produce delayed notification spam. If several accounts or limits change during the same refresh, each account/limit retains its own deduplication state; the presentation layer may compact simultaneous messages without hiding the affected account, limit, and current boundary.

The first successful observation seeds state silently. Enabling notifications or adding an already-partly-used account must not generate a burst of historical alerts.

## Always-available visual dashboard

Notifications supplement the dashboard; they do not replace it. Opening **How Much AI** must show the current state of every connected account at a glance.

Each account card displays every provider-reported limit, including Claude's five-hour limit, as a distinct row with:

- a clear Turkish limit name such as `5 saatlik limit` or `haftalık limit`;
- the exact remaining percentage as the primary number;
- the used percentage as secondary context;
- a color-coded progress bar that becomes more urgent at the notification boundaries;
- the next reset countdown and exact reset time when available;
- the freshness of the reading and an unmistakable stale/error state.

The card order and account nickname make four Claude identities easy to distinguish. The visual state must use the same normalized readings and remaining-percentage calculation as the notification detector, so the dashboard and an alert cannot disagree.

The secure Windows installer creates a verified **How Much AI** Start-menu launcher. It starts the existing hash-bound service task when necessary and opens or focuses the dedicated Edge app window through the reviewed window task. The shortcut contains no secret and delegates execution to the already verified scheduled-task boundary. The user can therefore close the window and reopen the visual dashboard on demand without a terminal.

## Reset detection

A reset is recognized only when the provider's concrete `resets_at` timestamp moves strictly later than the last accepted timestamp. A utilization decrease, missing timestamp, older timestamp, stale cached response, failed refresh, or clock skew does not by itself count as a reset.

On a confirmed reset:

1. emit one notification containing `limit sıfırlandı`;
2. clear the boundary deduplication state for that account and limit;
3. seed the new window from the fresh utilization value so already-crossed boundaries are not replayed.

## Limits and account names

The detector consumes the same normalized bars the dashboard renders. This includes:

- Claude rolling five-hour/current-session limit;
- Claude weekly all-model limit;
- Claude weekly Opus, Sonnet, connected-app, or other scoped limits when returned;
- ChatGPT/Codex five-hour and weekly limits when returned;
- future provider limits that pass the existing normalization and validation boundary.

Notification text uses a user-supplied nickname when present. Otherwise it uses a provider name plus a local ordinal such as `Claude 2`; it must not expose an email address, provider account identifier, token, reset URL, credential expiry, or other protected value on the Windows lock screen.

## Architecture

The secure-local path uses the existing dashboard refresh stream and browser service worker:

1. `Dashboard` receives a successful, non-stale normalized usage snapshot.
2. A pure local detector compares each bar with its previous per-account/per-limit state.
3. A small client-side coordinator persists only privacy-minimized detector state in the dedicated Edge profile.
4. The coordinator asks the existing service worker to show a Windows/browser notification.
5. Clicking a notification opens or focuses the local dashboard.

This path does not require Convex, Telegram, a webhook, VAPID keys, a new package, a new executable, or another scheduled task. It works while the installed dashboard window is open or minimized. Closing the dashboard window stops real-time local notifications; the autostart task opens it again at the next sign-in.

The existing hosted Convex/Web Push path remains separate and behavior-compatible. Local notification state is not uploaded or reused by hosted notification storage.

## Local state and privacy

Persist a versioned, size-bounded record containing only:

- a one-way local hash of the account identifier;
- the normalized limit key;
- the last accepted reset timestamp;
- the lowest remaining boundary already passed in the current window;
- the last observed utilization needed for crossing detection.

Do not persist display names, email addresses, provider identifiers, raw usage payloads, credentials, notification bodies, or a notification history. Reject malformed, oversized, future-version, or non-finite state and re-seed silently. Limit the total record count and prune entries for accounts and limits no longer present.

The dedicated Edge profile and installed state already have private ACLs, but notification state is minimized as defense in depth.

## Settings and permission behavior

The notification panel gains a secure-local mode instead of displaying “Convex required.” It provides two enabled-by-default rules:

- `Kalan limit uyarıları` for the fixed boundaries above;
- `Limit sıfırlanınca bildir` for reset notifications.

The browser notification permission is requested only from an explicit user gesture. Denied, unavailable, or revoked permission fails closed: no repeated permission prompts, no state advance for an undelivered event, and a clear local status in the panel. After permission is restored, the next genuine transition may be delivered; historical boundaries are not replayed in bulk.

Automatic refresh must be enabled for live notifications. The panel explains this dependency. Manual refreshes use the same detector and deduplication rules.

## Delivery and deduplication

Use a stable, non-sensitive notification tag derived from the locally hashed account key and normalized limit key. A newer notification for the same account/limit replaces its older Action Center entry while still producing the new toast.

Detector state advances only after the service worker accepts the notification request. A delivery exception leaves the event retryable. Repeated refreshes at the same percentage, stale responses, concurrent React renders, multiple tabs, and page reloads must not create duplicates. A short local lease or equivalent single-leader mechanism serializes detector updates across tabs.

## Error handling

- Missing or failed provider data: retain prior detector state and emit nothing.
- Stale cached data: display it in the dashboard but do not generate notification transitions.
- Malformed percentages or timestamps: reject that reading and emit nothing.
- Storage unavailable/corrupt/oversized: fail closed, reset to an empty seed, and surface a local settings error without including sensitive data.
- Service worker unavailable or permission denied: retain retryable state and surface a concise status.
- Reset and threshold crossed in the same fresh reading: emit only the reset message, then seed the new window silently.

## Test plan

Unit tests cover:

- every exact boundary: 50, 40, 30, 20, 15, 10, 5, and 0;
- no alert above 50% remaining;
- a multi-boundary jump emits only the tightest boundary;
- no duplicate within one window;
- a confirmed reset emits the exact text `limit sıfırlandı` and re-arms boundaries;
- utilization decreases without a later reset timestamp do not reset state;
- null, invalid, earlier, stale, and failed readings emit nothing;
- first observation is silent;
- account/limit isolation, including four Claude accounts;
- Claude five-hour and weekly bars;
- privacy-safe fallback labels never contain account email or IDs;
- corrupt/oversized persisted state fails closed;
- permission denied, worker failure, retry, and multi-tab serialization;
- a reset plus threshold crossing emits only the reset notification.

Integration checks cover the notification panel in strict local mode, service-worker message validation, click-to-open navigation restricted to the local origin, and unchanged hosted notification behavior. The complete trusted test, type-check, production build, secret scan, static-analysis, runtime-manifest, immutability, and clean-install verification gates run again after implementation.

Visual and Windows integration checks additionally cover:

- remaining and used values agree for every bar and boundary;
- Claude's five-hour limit is visibly labeled and not merged with weekly limits;
- stale readings cannot look live or trigger alerts;
- four Claude account cards remain distinguishable at narrow and wide layouts;
- keyboard, screen-reader, reduced-motion, and high-contrast behavior;
- the Start-menu launcher contains no secret, targets only the reserved reviewed tasks, starts a stopped service, and opens the exact loopback dashboard;
- installer idempotence, shortcut replacement refusal, ACLs, uninstall cleanup, and final-state verification.

## Alternatives considered

1. **Selected: local dashboard plus existing service worker.** No external notification service or added executable; lowest change and attack surface. Requires the dashboard window to stay open or minimized.
2. **Separate Windows background notifier.** Continues after the window closes, but adds another long-lived task, a native-toast execution boundary, more DPAPI material, and substantially more installer/verifier complexity.
3. **Remote Web Push, Telegram, or webhook.** Continues across devices, but sends account-usage metadata outside the machine and contradicts the secure-local default.

The selected design matches the user's security priority and the existing autostarted desktop-window model.
