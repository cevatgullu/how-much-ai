# OpenAI Private Device Login Design

**Date:** 2026-08-11

## Goal

Let each ChatGPT/Codex account own an independent How Much AI refresh chain so three connected accounts can remain active at the same time. Keep the existing shared Codex CLI import as a clearly marked legacy fallback until the new flow has been verified with the user's accounts.

## Root cause

The OpenAI connect paths currently import `~/.codex/auth.json` or a pasted copy and save every credential with `credentialKind: "rotating"`. The dashboard and Codex CLI then share one single-use refresh chain. A later CLI rotation can invalidate the dashboard's saved refresh token, which makes older account cards require reauthentication. OpenAI accounts have no app-owned login path today; Claude accounts already distinguish app-owned `managed` credentials from shared CLI credentials.

## Selected approach

Implement the same ChatGPT device authorization protocol exposed by the installed Codex CLI, directly in the How Much AI server. The server requests a one-time user code from `https://auth.openai.com`, the browser shows that code and opens the exact verification page, and the server polls for authorization. After authorization, the server exchanges the one-use code once, verifies the returned subscription identity against the usage endpoint, and writes the access/refresh pair directly to the encrypted vault as `credentialKind: "managed"`.

This approach does not invoke the Codex CLI, does not read or replace `~/.codex/auth.json`, does not create a plaintext credential file, and does not require a callback listener or a fixed browser redirect port.

## Protocol and server boundaries

`lib/providers/openai-device-auth.ts` owns the upstream protocol:

- `POST /api/accounts/deviceauth/usercode` with the existing public Codex client id.
- Display `https://auth.openai.com/codex/device` plus the returned one-time user code.
- `POST /api/accounts/deviceauth/token` with only `device_auth_id` and `user_code`.
- Treat HTTP 404 as authorization still pending.
- On success, accept only bounded `authorization_code` and `code_verifier` strings.
- Exchange the authorization code exactly once at `/oauth/token`, using `https://auth.openai.com/deviceauth/callback` as the redirect URI.
- Require both a valid access token and a non-empty refresh token. Derive expiry from the access-token JWT as the existing provider does.
- Never retry an ambiguous authorization-code exchange because the code is single-use.

All upstream requests use short explicit timeouts, `cache: "no-store"`, and the existing strict-local outbound allowlist for the exact `https://auth.openai.com` origin.

## Attempt lifecycle

`lib/openai-device-attempt-store.ts` keeps pending device state only in bounded process memory:

- A random 32-byte base64url `attemptId` is the browser capability.
- At most eight records exist; expired/completed records are reclaimed first.
- Pending attempts expire after 15 minutes.
- Records are bound to the authenticated `userId` and optional `expectedAccountId`.
- Only one status request can own an upstream poll at a time. A short owner fence allows recovery if a request crashes.
- The upstream `device_auth_id` and user code are deleted immediately after completion or failure.
- Completed records retain only credential-free display metadata for 60 seconds so a lost HTTP response can be replayed safely.
- Restarting the app loses pending attempts and requires starting a new login; no credential material is persisted outside the encrypted vault.

Two authenticated, same-origin route handlers expose the flow:

- `POST /api/connect/openai/device/start` accepts only optional `expectedAccountId` and returns `attemptId`, `userCode`, `verificationUrl`, `expiresAt`, and `pollAfterMs`.
- `POST /api/connect/openai/device/status` accepts only `attemptId`. It returns `pending`, `processing`, `done`, `failed`, or `expired`. A `done` response contains only the same browser-safe account metadata returned by other connect routes.

Both routes use `browserMutationFailure`, `requireUser`, bounded JSON bodies, strict field allowlists, `Cache-Control: no-store`, and generic diagnostics. Tokens, authorization codes, verifiers, device ids, upstream response bodies, and account ids never enter logs or error responses.

## Connection and migration behavior

After token exchange, the status route resolves the OpenAI identity through the existing provider and checks `expectedAccountId` before any vault write. A mismatch returns 409 and deletes the pending secrets.

`saveProviderAccount` gains an optional credential-kind override. Device login passes `"managed"`; local file and paste imports retain their current inferred `"rotating"` behavior. Connecting the same verified account id replaces its shared credential with the managed credential while preserving its nickname and original `addedAt` value. Existing accounts are not silently converted and no stored credential is deleted before a successful replacement.

The refresh service keeps the current owner-fenced rotation journal and cache coordination. Provider-specific error copy is used so a managed OpenAI login says ChatGPT rejected the replacement token rather than Claude.

## User interface

The ChatGPT section makes device login the primary action:

- Button: `Connect private ChatGPT login` or `Reconnect private login`.
- After start, show the one-time code, a copy action, the exact OpenAI verification link, expiry information, and a warning to continue only because the user initiated the flow in How Much AI.
- Poll according to the server-provided interval and stop on modal close, completion, expiry, or failure.
- On success, use the existing dashboard reload/close behavior.

The current local-file and paste methods remain below a `Legacy shared CLI login` disclosure. Their copy explicitly warns that Codex CLI rotation can disconnect the dashboard. Strict-local mode keeps credential paste disabled but retains the same-machine legacy reader as fallback.

Account cards already render `managed` as `private app login · auto-renews`. Provider-specific explanatory and reauthentication text will be corrected for ChatGPT while preserving Claude behavior.

## Failure handling

- Pending authorization: keep polling without surfacing an error.
- Slow or duplicate browser polls: return `processing` or an exact retry delay; never issue concurrent upstream polls.
- Expired/denied/invalid device attempt: erase secrets and require a fresh start.
- Temporary start/poll network failure: return a generic retryable message without upstream bodies.
- Ambiguous authorization-code exchange: fail the attempt and require a fresh login; never replay the code.
- Wrong account selected: return 409, save nothing, and ask the user to restart with the intended account.
- Vault persistence failure: return an opaque server error reference and retain no pending OAuth secrets.

## Verification

Tests must cover:

- Exact device-start, 404-pending, authorization-code exchange, timeout, schema validation, and no-retry behavior.
- Attempt capability validation, TTL, capacity, user binding, single-flight polling, crash-fence recovery, replay-safe completion, and secret clearing.
- Same-origin/session/request-size guards on both routes and absence of credentials from every response.
- Wrong-account rejection and `managed` persistence replacing a prior `rotating` account without losing label or `addedAt`.
- Three managed OpenAI accounts refreshing independently through the existing owner-fenced coordination.
- Primary private-login UI, legacy fallback copy, strict-local paste exclusion, polling cleanup, and provider-specific account-card copy.
- `npm test`, `npm run typecheck`, and `npm run build` in that order. The three fixed-port runtime-immutability tests require port 37645 to be free, so the final full run occurs during the controlled How Much AI service restart. Codex desktop/CLI processes are never stopped.

## Rollout

Build and validate a new secure-local runtime from the isolated feature branch. Use the existing manifest-driven Windows installer so rollback and integrity checks remain intact. Restart only the How Much AI service, verify the dashboard health endpoint and private-login UI, then have the user connect the first ChatGPT account. The legacy shared method remains available until all three real accounts have been reconnected and observed refreshing independently.

