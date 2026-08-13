# Strict-local Claude Add Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore an actionable private Claude login form in the installed strict-local dashboard and make valid browser/connector requests survive Next's internal request URL rewriting.

**Architecture:** Reuse the existing browser PKCE form and authenticated `/api/connect/oauth` transaction. Teach the shared browser guard that strict-local's only valid external origin is `http://127.0.0.1:37645`, while leaving ordinary deployments unchanged; independently remove only the internal-origin dependency from the secure connector routes.

**Tech Stack:** Next.js 16 route handlers, React, Node test runner, TypeScript, Windows secure-local installer.

## Global Constraints

- Keep exact strict-local Host/Origin and Fetch Metadata boundaries.
- Keep authorization-code, verifier, access token, refresh token, and account identifiers out of public responses and logs.
- The user performs provider authentication; automation must not enter credentials.
- Do not alter ChatGPT's device-login flow.
- Every production change must follow a witnessed RED then GREEN test cycle.

---

### Task 1: Strict-local Claude form and browser origin

**Files:**
- Modify: `lib/request-body.test.ts`
- Modify: `lib/oauth-connect.test.ts`
- Modify: `lib/bootstrap-ui.test.ts`
- Modify: `lib/request-body.ts`
- Modify: `app/api/connect/oauth/route.ts`
- Modify: `components/AddAccountModal.tsx`

**Interfaces:**
- Consumes: `browserMutationFailure(req: Request)` and the existing PKCE form in `AddAccountModal`.
- Produces: strict-local browser mutations accepted only for `http://127.0.0.1:37645`; authenticated Claude OAuth enabled in strict-local mode.

- [ ] **Step 1: Write failing boundary tests**

Add a request-body test where `req.url` uses `http://next-internal.invalid:3000`, while `Host`, `Origin`, and `Sec-Fetch-Site` contain the exact strict-local values; expect `null`. Assert a foreign Origin still returns 403.

- [ ] **Step 2: Write failing route and UI tests**

In `oauth-connect.test.ts`, create a strict-local session and submit the valid PKCE payload using the internal URL plus exact external headers; expect a token-free 200 and one managed vault record. In `bootstrap-ui.test.ts`, require the strict Claude pane to contain `Open secure Claude sign-in`, `Claude authorization code`, and no instruction-only launcher dead end.

- [ ] **Step 3: Run RED**

Run:

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/request-body.test.ts lib/oauth-connect.test.ts lib/bootstrap-ui.test.ts
```

Expected: failures caused by the internal-origin comparison, strict-local OAuth 404, and missing form controls.

- [ ] **Step 4: Implement the minimum behavior**

Make `browserMutationFailure` use `http://127.0.0.1:37645` only when `strictLocalModeEnabled()` is true, otherwise retain `new URL(req.url).origin`. Remove the strict-local 404 from `/api/connect/oauth`. Render the existing Claude PKCE form for both ordinary and strict-local modes; remove the unreachable prose-only connector block.

- [ ] **Step 5: Run GREEN and commit**

Re-run the exact RED command, then commit only Task 1 files.

### Task 2: Secure connector internal-URL compatibility

**Files:**
- Modify: `lib/oauth-secure-handoff.test.ts`
- Modify: `app/api/connect/oauth/attempt/launch/[attemptId]/route.ts`
- Modify: `app/api/connect/oauth/attempt/callback/route.ts`

**Interfaces:**
- Consumes: exact external Host/Origin headers and attempt ids created by `oauthAttemptStore`.
- Produces: launch and callback requests remain exact/replay-safe even when Next presents an internal `req.url` origin.

- [ ] **Step 1: Write failing launch and callback tests**

Use `http://next-internal.invalid:3000` for `req.url`, keep the exact route pathname and external Host/Origin headers, and assert launch redirects once and callback completes once without reflecting secrets.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/oauth-secure-handoff.test.ts
```

Expected: launch returns 421 and callback returns 403.

- [ ] **Step 3: Implement the minimum route changes**

For launch, retain exact Host, pathname, query, parameter, and replay checks but stop comparing `requestUrl.origin`. For callback, retain exact Host, external Origin, same-origin Fetch Metadata, bounded schema, and one-use claim, but remove the redundant internal `req.url` origin comparison.

- [ ] **Step 4: Run GREEN and commit**

Re-run the exact RED command, then commit only Task 2 files.

### Task 3: Verification, secure update, and user handoff

**Files:**
- Verify all changed source/test/docs files.
- Generate and install a new manifest-bound runtime; do not mutate vault contents manually.

**Interfaces:**
- Consumes: both committed Task 1 and Task 2 changes.
- Produces: the installed Edge app opens `Connect an account` with functional Claude and ChatGPT choices and zero stale accounts.

- [ ] **Step 1: Run focused and adjacent tests**

Run the Task 1 and Task 2 commands together plus the OpenAI device-login and bootstrap route suites.

- [ ] **Step 2: Run static/build verification**

Run `npm run typecheck`, `npm run build`, and `git diff --check` with zero failures.

- [ ] **Step 3: Generate and install the manifest-bound runtime**

Use the documented hash-verified update path with the currently installed manifest as the compare-and-swap anchor. Preserve `secrets.dpapi`, `vault`, and `edge-profile`; never stop Codex.

- [ ] **Step 4: Verify installed UI**

Open only the exact `How Much AI` Edge window, confirm account count remains zero, open Add Account, select Claude, and verify the authorization link and code field are enabled. Leave the form empty for the user.
