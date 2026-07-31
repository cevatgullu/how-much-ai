import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { promises as fs } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) {
      const target = specifier.slice(2);
      return nextResolve(
        pathToFileURL(path.join(projectRoot, path.extname(target) ? target : `${target}.ts`)).href,
        context,
      );
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith(pathToFileURL(projectRoot).href) &&
      !context.parentURL.includes("/node_modules/") &&
      path.extname(new URL(specifier, context.parentURL).pathname) === ""
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hmc-oauth-handoff-"));
const password = "password-canary-".padEnd(64, "p");
const accessToken = "access-token-canary";
const refreshToken = "refresh-token-canary";

function strictEnvironment(): NodeJS.ProcessEnv {
  return {
    HMC_STRICT_LOCAL_MODE: "1",
    HMC_LISTEN_HOST: "127.0.0.1",
    HMC_LISTEN_PORT: "37645",
    PORT: "37645",
    NODE_ENV: "production",
    APP_PASSWORD: password,
    AUTH_SECRET: "s".repeat(64),
    VAULT_ENCRYPTION_SECRET: "v".repeat(64),
    TRUST_PROXY_IP_HEADERS: "0",
    ENABLE_LOCAL_CONNECT: "1",
    VAULT_DATA_DIR: dataDir,
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

process.env = strictEnvironment();

const { NextRequest } = await import("next/server.js");
const { default: proxy } = await import("../proxy.ts");
const { POST: startPost } = await import(
  "../app/api/connect/oauth/attempt/start/route.ts"
);
const { GET: launchGet } = await import(
  "../app/api/connect/oauth/attempt/launch/[attemptId]/route.ts"
);
const { POST: callbackPost } = await import(
  "../app/api/connect/oauth/attempt/callback/route.ts"
);
const { POST: statusPost } = await import(
  "../app/api/connect/oauth/attempt/status/route.ts"
);
const { POST: legacyPost } = await import("../app/api/connect/oauth/route.ts");
const { CLAUDE_SUBSCRIPTION_OAUTH } = await import("./anthropic.ts");
const { loadAccounts, saveAccounts } = await import("./vault.ts");

type FetchMode = "success" | "token_500";
let fetchMode: FetchMode = "success";
let profileAccountId = "acct-secure";
let providerCalls: Array<{ url: string; init?: RequestInit }> = [];
let tokenEntered: (() => void) | null = null;
let tokenGate: Promise<void> | null = null;
let diagnosticCalls: unknown[][] = [];

before(() => {
  console.error = (...args: unknown[]) => diagnosticCalls.push(args);
  console.log = (...args: unknown[]) => diagnosticCalls.push(args);
  console.warn = (...args: unknown[]) => diagnosticCalls.push(args);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    providerCalls.push({ url, init });
    if (url.endsWith("/v1/oauth/token")) {
      tokenEntered?.();
      if (tokenGate) await tokenGate;
      if (fetchMode === "token_500") {
        return Response.json({ error: "server_error" }, { status: 500 });
      }
      return Response.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 3600,
        scope: CLAUDE_SUBSCRIPTION_OAUTH.scopes,
      });
    }
    if (url.endsWith("/api/oauth/usage")) {
      return Response.json({ five_hour: { utilization: 12, resets_at: null } });
    }
    if (url.endsWith("/api/oauth/profile")) {
      return Response.json({
        account: {
          uuid: profileAccountId,
          email: "secure@example.com",
          full_name: "Secure Account",
        },
        organization: { organization_type: "claude_pro" },
      });
    }
    throw new Error("unexpected provider request");
  };
});

beforeEach(async () => {
  process.env = strictEnvironment();
  fetchMode = "success";
  profileAccountId = "acct-secure";
  providerCalls = [];
  tokenEntered = null;
  tokenGate = null;
  diagnosticCalls = [];
  await saveAccounts("default", []);
});

afterEach(() => {
  assert.deepEqual(diagnosticCalls, []);
});

after(async () => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  process.env = originalEnv;
  await fs.rm(dataDir, { recursive: true, force: true });
  moduleHooks.deregister();
});

function jsonRequest(
  pathname: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://127.0.0.1:37645${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "127.0.0.1:37645",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function startAttempt(expectedAccountId?: string): Promise<string> {
  const response = await startPost(
    jsonRequest("/api/connect/oauth/attempt/start", {
      password,
      ...(expectedAccountId ? { expectedAccountId } : {}),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["attemptId"]);
  assert.match(body.attemptId, /^[A-Za-z0-9_-]{43}$/);
  return body.attemptId as string;
}

async function launchAttempt(
  attemptId: string,
): Promise<{ state: string; challenge: string }> {
  const response = await launchGet(
    new Request(
      `http://127.0.0.1:37645/api/connect/oauth/attempt/launch/${attemptId}`,
      { headers: { Host: "127.0.0.1:37645" } },
    ),
    { params: Promise.resolve({ attemptId }) },
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.origin, "https://claude.com");
  assert.equal(location.pathname, "/cai/oauth/authorize");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.match(location.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(location.searchParams.get("state"), /^[A-Za-z0-9_-]{43}$/);
  return {
    state: location.searchParams.get("state")!,
    challenge: location.searchParams.get("code_challenge")!,
  };
}

function callbackRequest(code: string, state: string): Request {
  return jsonRequest(
    "/api/connect/oauth/attempt/callback",
    { code, state },
    {
      Origin: "http://127.0.0.1:37645",
      "Sec-Fetch-Site": "same-origin",
    },
  );
}

async function attemptStatus(attemptId: string): Promise<Response> {
  return statusPost(
    jsonRequest("/api/connect/oauth/attempt/status", { password, attemptId }),
  );
}

test("only the exact handoff paths reach their own checks before a session", async () => {
  for (const pathname of [
    "/oauth/callback",
    "/api/connect/oauth/attempt/start",
    "/api/connect/oauth/attempt/callback",
    "/api/connect/oauth/attempt/status",
    `/api/connect/oauth/attempt/launch/${"A".repeat(43)}`,
  ]) {
    const response = await proxy(
      new NextRequest(`http://127.0.0.1:37645${pathname}`, {
        headers: { Host: "127.0.0.1:37645" },
      }),
    );
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get("x-middleware-next"), "1", pathname);
  }

  for (const pathname of [
    "/api/connect/oauth",
    "/api/connect/oauth/attempt/",
    "/api/connect/oauth/attempt/start/",
    `/api/connect/oauth/attempt/launch/${"A".repeat(42)}`,
    `/api/connect/oauth/attempt/launch/${"A".repeat(43)}/extra`,
  ]) {
    const response = await proxy(
      new NextRequest(`http://127.0.0.1:37645${pathname}`, {
        headers: { Host: "127.0.0.1:37645" },
      }),
    );
    assert.notEqual(
      response.headers.get("x-middleware-next"),
      "1",
      pathname,
    );
  }
});

test("strict handoff launches once, exchanges once, persists, and exposes only generic state", async () => {
  const code = "authorization-code-canary";
  const attemptId = await startAttempt();

  let response = await attemptStatus(attemptId);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "pending",
    provider: "anthropic",
    displayLabel: "Claude account",
  });

  const { state, challenge } = await launchAttempt(attemptId);
  const replayLaunch = await launchGet(
    new Request(
      `http://127.0.0.1:37645/api/connect/oauth/attempt/launch/${attemptId}`,
      { headers: { Host: "127.0.0.1:37645" } },
    ),
    { params: Promise.resolve({ attemptId }) },
  );
  assert.notEqual(replayLaunch.status, 302);

  response = await callbackPost(callbackRequest(code, state));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "done" });
  assert.equal(
    providerCalls.filter((call) => call.url.endsWith("/v1/oauth/token")).length,
    1,
  );

  const tokenBody = JSON.parse(
    String(
      providerCalls.find((call) => call.url.endsWith("/v1/oauth/token"))?.init
        ?.body,
    ),
  );
  assert.equal(tokenBody.code, code);
  assert.equal(tokenBody.state, state);
  assert.equal(typeof tokenBody.code_verifier, "string");
  assert.notEqual(tokenBody.code_verifier, challenge);

  const stored = await loadAccounts("default");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, profileAccountId);
  assert.equal(stored[0].credentialKind, "managed");

  response = await attemptStatus(attemptId);
  assert.equal(response.status, 200);
  const statusBody = await response.json();
  assert.deepEqual(statusBody, {
    status: "done",
    provider: "anthropic",
    displayLabel: "Claude account",
  });

  const publicResponses = JSON.stringify({
    callback: { status: "done" },
    status: statusBody,
  });
  for (const canary of [
    code,
    state,
    tokenBody.code_verifier,
    password,
    accessToken,
    refreshToken,
    profileAccountId,
  ]) {
    assert.equal(publicResponses.includes(canary), false, canary);
  }
});

test("concurrent callbacks claim synchronously and permit one token exchange", async () => {
  const attemptId = await startAttempt();
  const { state } = await launchAttempt(attemptId);
  let releaseToken!: () => void;
  tokenGate = new Promise<void>((resolve) => {
    releaseToken = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    tokenEntered = resolve;
  });

  const first = callbackPost(callbackRequest("concurrent-code", state));
  await entered;
  const second = await callbackPost(callbackRequest("concurrent-code", state));
  assert.notEqual(second.status, 200);
  const deniedBody = await second.text();
  for (const canary of ["concurrent-code", state, attemptId]) {
    assert.equal(deniedBody.includes(canary), false, canary);
  }
  releaseToken();
  const winner = await first;
  assert.equal(winner.status, 200);
  assert.equal(
    providerCalls.filter((call) => call.url.endsWith("/v1/oauth/token")).length,
    1,
  );
});

test("an ambiguous exchange failure is terminal and replay cannot exchange again", async () => {
  fetchMode = "token_500";
  const attemptId = await startAttempt();
  const { state } = await launchAttempt(attemptId);
  const code = "ambiguous-code-canary";

  const failed = await callbackPost(callbackRequest(code, state));
  assert.notEqual(failed.status, 200);
  const failedBody = await failed.json();
  assert.deepEqual(failedBody, { status: "failed" });
  const serializedFailure = JSON.stringify(failedBody);
  for (const canary of [
    code,
    state,
    attemptId,
    accessToken,
    refreshToken,
    profileAccountId,
  ]) {
    assert.equal(serializedFailure.includes(canary), false, canary);
  }
  assert.equal(
    providerCalls.filter((call) => call.url.endsWith("/v1/oauth/token")).length,
    1,
  );

  fetchMode = "success";
  const replay = await callbackPost(callbackRequest(code, state));
  assert.notEqual(replay.status, 200);
  const replayBody = await replay.text();
  for (const canary of [code, state, attemptId]) {
    assert.equal(replayBody.includes(canary), false, canary);
  }
  assert.equal(
    providerCalls.filter((call) => call.url.endsWith("/v1/oauth/token")).length,
    1,
  );
  const status = await attemptStatus(attemptId);
  assert.deepEqual(await status.json(), {
    status: "failed",
    provider: "anthropic",
    displayLabel: "Claude account",
  });
  assert.deepEqual(await loadAccounts("default"), []);
});

test("a targeted identity mismatch is terminal and cannot alter the selected account", async () => {
  const existing = {
    id: "acct-selected",
    email: "selected@example.com",
    label: "Selected",
    plan: "Pro",
    addedAt: 1_700_000_000_000,
    credentialKind: "rotating" as const,
    tokens: {
      accessToken: "selected-old-access",
      refreshToken: "selected-old-refresh",
      expiresAt: 1_800_000_000_000,
    },
  };
  await saveAccounts("default", [existing]);
  profileAccountId = "acct-different";
  const attemptId = await startAttempt(existing.id);
  const { state } = await launchAttempt(attemptId);

  const response = await callbackPost(callbackRequest("mismatch-code", state));
  assert.notEqual(response.status, 200);
  const serialized = await response.text();
  for (const canary of [
    "mismatch-code",
    state,
    attemptId,
    existing.id,
    profileAccountId,
    accessToken,
    refreshToken,
  ]) {
    assert.equal(serialized.includes(canary), false, canary);
  }
  assert.deepEqual(await loadAccounts("default"), [existing]);
  const status = await attemptStatus(attemptId);
  assert.equal((await status.json()).status, "failed");
});

test("every public route enforces strict mode, exact host/origin, password, and fields", async () => {
  let response = await startPost(
    jsonRequest(
      "/api/connect/oauth/attempt/start",
      { password },
      { Host: "localhost:37645" },
    ),
  );
  assert.equal(response.status, 421);

  response = await startPost(
    jsonRequest(
      "/api/connect/oauth/attempt/start",
      { password },
      { Origin: "http://127.0.0.1:37645" },
    ),
  );
  assert.equal(response.status, 403);
  response = await startPost(
    jsonRequest("/api/connect/oauth/attempt/start", {
      password: `${password}-wrong`,
    }),
  );
  assert.equal(response.status, 401);
  assert.equal((await response.text()).includes(password), false);

  response = await startPost(
    jsonRequest("/api/connect/oauth/attempt/start", {
      password,
      unexpected: "field",
    }),
  );
  assert.equal(response.status, 400);

  const attemptId = await startAttempt();
  response = await statusPost(
    jsonRequest(
      "/api/connect/oauth/attempt/status",
      { password, attemptId },
      { Origin: "null" },
    ),
  );
  assert.equal(response.status, 403);
  const deniedStatusBody = await response.text();
  for (const canary of [password, attemptId]) {
    assert.equal(deniedStatusBody.includes(canary), false, canary);
  }

  const missingAttemptId = "Z".repeat(43);
  response = await statusPost(
    jsonRequest("/api/connect/oauth/attempt/status", {
      password,
      attemptId: missingAttemptId,
    }),
  );
  assert.equal(response.status, 404);
  const missingStatusBody = await response.text();
  for (const canary of [password, missingAttemptId]) {
    assert.equal(missingStatusBody.includes(canary), false, canary);
  }

  const { state } = await launchAttempt(attemptId);
  const wrongState = "Y".repeat(43);
  response = await callbackPost(callbackRequest("wrong-state-code", wrongState));
  assert.equal(response.status, 409);
  const wrongStateBody = await response.text();
  for (const canary of [
    "wrong-state-code",
    wrongState,
    state,
    password,
    attemptId,
  ]) {
    assert.equal(wrongStateBody.includes(canary), false, canary);
  }
  assert.equal(providerCalls.length, 0);

  for (const headers of [
    { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    { Origin: "http://127.0.0.1:37645" },
    {
      Host: "localhost:37645",
      Origin: "http://127.0.0.1:37645",
      "Sec-Fetch-Site": "same-origin",
    },
  ]) {
    response = await callbackPost(
      jsonRequest(
        "/api/connect/oauth/attempt/callback",
        { code: "guard-code", state },
        headers,
      ),
    );
    assert.notEqual(response.status, 200);
    const body = await response.text();
    for (const canary of ["guard-code", state, password, attemptId]) {
      assert.equal(body.includes(canary), false, canary);
    }
  }
  response = await callbackPost(
    jsonRequest(
      "/api/connect/oauth/attempt/callback",
      { code: "guard-code", state, unexpected: true },
      {
        Origin: "http://127.0.0.1:37645",
        "Sec-Fetch-Site": "same-origin",
      },
    ),
  );
  assert.equal(response.status, 400);
  const invalidCallbackBody = await response.text();
  for (const canary of ["guard-code", state, password, attemptId]) {
    assert.equal(invalidCallbackBody.includes(canary), false, canary);
  }
  assert.equal(providerCalls.length, 0);

  process.env = { NODE_ENV: "production", APP_PASSWORD: password };
  response = await startPost(
    jsonRequest("/api/connect/oauth/attempt/start", { password }),
  );
  assert.equal(response.status, 404);
  process.env = strictEnvironment();

  const legacy = await legacyPost(
    jsonRequest(
      "/api/connect/oauth",
      {
        code: "legacy-code",
        state: "legacy-state",
        verifier: "v".repeat(43),
      },
      {
        Origin: "http://127.0.0.1:37645",
        "Sec-Fetch-Site": "same-origin",
      },
    ),
  );
  assert.equal(legacy.status, 404);
  assert.equal(providerCalls.length, 0);
});
