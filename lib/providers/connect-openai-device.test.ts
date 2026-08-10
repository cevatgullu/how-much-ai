import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { promises as fs, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StoredAccount } from "../types.ts";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) {
      return nextResolve(pathToFileURL(path.join(projectRoot, `${specifier.slice(2)}.ts`)).href, context);
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

const usageFixture = JSON.parse(readFileSync(new URL("./fixtures/wham-usage.json", import.meta.url), "utf8"));
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hmc-openai-device-route-"));

for (const key of [
  "CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "VAULT_ACCESS_SECRET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
]) {
  delete process.env[key];
}
process.env.VAULT_DATA_DIR = dataDir;
process.env.VAULT_ENCRYPTION_SECRET = "openai-device-route-vault-secret";
process.env.APP_PASSWORD = "openai-device-route-password";
process.env.AUTH_SECRET = "openai-device-route-auth-secret";

const { createOpenAIDeviceAttemptStore, openAIDeviceAttemptStore } =
  await import("../openai-device-attempt-store.ts");
const { POST: startPost } = await import("../../app/api/connect/openai/device/start/route.ts");
const { POST: statusPost } = await import("../../app/api/connect/openai/device/status/route.ts");
const { createSession, SESSION_COOKIE } = await import("../session.ts");
const { loadAccounts, saveAccounts } = await import("../vault.ts");
const sessionCookie = `${SESSION_COOKIE}=${await createSession()}`;

const DEVICE_AUTH_ID = "fixture-device-auth-id";
const USER_CODE = "FIXTURE-CODE";
const AUTHORIZATION_CODE = "fixture-authorization-code";
const CODE_VERIFIER = "fixture-code-verifier";
const REFRESH_TOKEN = "fixture-refresh-token";
let now = Date.now();

function jwt(payload: Record<string, unknown>): string {
  const segment = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${segment}.signature`;
}

const ACCESS_TOKEN = jwt({
  email: "device@example.com",
  "https://api.openai.com/auth": { chatgpt_account_id: "acc-device", chatgpt_plan_type: "pro" },
  exp: 1_900_000_000,
});

function resetAttemptStore(): void {
  let nextByte = 1;
  const replacement = createOpenAIDeviceAttemptStore({
    now: () => now,
    randomBytes: (size) => new Uint8Array(size).fill(nextByte++),
  });
  Object.assign(openAIDeviceAttemptStore, replacement);
}

function request(
  pathname: "/api/connect/openai/device/start" | "/api/connect/openai/device/status",
  body: unknown,
  options: { authenticated?: boolean; origin?: string; contentType?: string } = {},
): Request {
  const headers = new Headers({
    "Content-Type": options.contentType ?? "application/json",
    "Sec-Fetch-Site": "same-origin",
  });
  if (options.authenticated !== false) headers.set("Cookie", sessionCookie);
  if (options.origin) headers.set("Origin", options.origin);
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function start(expectedAccountId?: string): Promise<Record<string, unknown>> {
  const response = await startPost(
    request("/api/connect/openai/device/start", expectedAccountId ? { expectedAccountId } : {}),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()) as Record<string, unknown>;
}

function startUpstreamResponse(): Response {
  return Response.json({
    device_auth_id: DEVICE_AUTH_ID,
    user_code: USER_CODE,
    interval: "1",
  });
}

function forbiddenSecrets(): string[] {
  return [DEVICE_AUTH_ID, USER_CODE, AUTHORIZATION_CODE, CODE_VERIFIER, ACCESS_TOKEN, REFRESH_TOKEN];
}

function heartbeatRecorder(): {
  tick: () => void;
  activeCount: () => number;
  clearedCount: () => number;
  restore: () => void;
} {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const active = new Map<object, () => void>();
  let cleared = 0;
  globalThis.setInterval = ((callback: () => void) => {
    const handle = {};
    active.set(handle, callback);
    return handle;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle: object) => {
    if (active.delete(handle)) cleared += 1;
  }) as unknown as typeof clearInterval;
  return {
    tick: () => {
      for (const callback of [...active.values()]) callback();
    },
    activeCount: () => active.size,
    clearedCount: () => cleared,
    restore: () => {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

beforeEach(async () => {
  now = Date.now();
  resetAttemptStore();
  await saveAccounts("default", []);
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`unexpected upstream boundary: ${new URL(String(input)).pathname}`);
  }) as unknown as typeof fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  await fs.rm(dataDir, { recursive: true, force: true });
  moduleHooks.deregister();
});

test("device start returns only the public code and verification metadata", async () => {
  globalThis.fetch = (async () => startUpstreamResponse()) as unknown as typeof fetch;

  const body = await start();

  assert.deepEqual(Object.keys(body).sort(), ["attemptId", "expiresAt", "pollAfterMs", "userCode", "verificationUrl"]);
  assert.equal(body.userCode, USER_CODE);
  assert.equal(body.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(body.pollAfterMs, 1_000);
  assert.equal(body.expiresAt, now + 15 * 60_000);
  assert.match(String(body.attemptId), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(body).includes(DEVICE_AUTH_ID), false);
  assert.equal(JSON.stringify(body).includes("device_auth_id"), false);
});

test("device status maps upstream 404 to pending at the retained interval", async () => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/accounts/deviceauth/usercode")) return startUpstreamResponse();
    if (url.endsWith("/api/accounts/deviceauth/token")) return new Response(null, { status: 404 });
    throw new Error(`unexpected fetch ${new URL(url).pathname}`);
  }) as unknown as typeof fetch;
  const started = await start();
  now += 1_000;

  const heartbeat = heartbeatRecorder();
  try {
    const response = await statusPost(
      request("/api/connect/openai/device/status", { attemptId: started.attemptId }),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(body, { status: "pending", pollAfterMs: 1_000, expiresAt: started.expiresAt });
    assert.equal(JSON.stringify(body).includes(USER_CODE), false);
    assert.equal(heartbeat.activeCount(), 0);
    assert.equal(heartbeat.clearedCount(), 1);
  } finally {
    heartbeat.restore();
  }
});

test("authorized status verifies identity, saves managed, and replays completion without another exchange", async () => {
  const previous: StoredAccount = {
    id: "openai-acc-device",
    email: "old@example.com",
    label: "Primary",
    plan: "ChatGPT Plus",
    addedAt: 1_000,
    credentialKind: "rotating",
    provider: "openai",
    tokens: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1 },
  };
  await saveAccounts("default", [previous]);
  let polls = 0;
  let exchanges = 0;
  let releasePoll: ((response: Response) => void) | undefined;
  const heldPoll = new Promise<Response>((resolve) => {
    releasePoll = resolve;
  });
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/accounts/deviceauth/usercode")) return startUpstreamResponse();
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      polls += 1;
      return heldPoll;
    }
    if (url.endsWith("/oauth/token")) {
      exchanges += 1;
      return Response.json({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN });
    }
    if (url.includes("/wham/usage")) return Response.json({ ...usageFixture, email: "device@example.com" });
    throw new Error(`unexpected fetch ${new URL(url).pathname}`);
  }) as unknown as typeof fetch;
  const started = await start(previous.id);
  now += 1_000;
  const heartbeat = heartbeatRecorder();
  try {
    const firstResponsePromise = statusPost(
      request("/api/connect/openai/device/status", { attemptId: started.attemptId }),
    );
    await waitFor(() => polls === 1 && heartbeat.activeCount() === 1);
    for (let renewal = 0; renewal < 3; renewal += 1) {
      now += 10_000;
      heartbeat.tick();
    }
    now += 1_000;

    const concurrentResponse = await statusPost(
      request("/api/connect/openai/device/status", { attemptId: started.attemptId }),
    );
    const concurrent = await concurrentResponse.json();
    assert.equal(concurrent.status, "processing");
    assert.equal(polls, 1);
    assert.equal(exchanges, 0);

    releasePoll?.(Response.json({ authorization_code: AUTHORIZATION_CODE, code_verifier: CODE_VERIFIER }));
    const firstResponse = await firstResponsePromise;
    const first = await firstResponse.json();
    const replayResponse = await statusPost(
      request("/api/connect/openai/device/status", { attemptId: started.attemptId }),
    );
    const replay = await replayResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.deepEqual(replay, first);
    assert.equal(polls, 1);
    assert.equal(exchanges, 1);
    assert.equal(heartbeat.activeCount(), 0);
    assert.equal(heartbeat.clearedCount(), 1);
    assert.deepEqual(first, {
      status: "done",
      account: {
        id: "openai-acc-device",
        email: "device@example.com",
        plan: "ChatGPT Pro",
        label: "device@example.com",
        alreadyConnected: true,
      },
    });
    const [saved] = await loadAccounts("default");
    assert.equal(saved.credentialKind, "managed");
    assert.equal(saved.label, "Primary");
    assert.equal(saved.addedAt, 1_000);
    assert.deepEqual(saved.tokens, { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, expiresAt: 1_900_000_000_000 });
    const serialized = JSON.stringify({ first, replay });
    for (const forbidden of forbiddenSecrets()) assert.equal(serialized.includes(forbidden), false);
  } finally {
    heartbeat.restore();
  }
});

test("wrong expected account fails terminally with no vault write", async () => {
  const baseline: StoredAccount[] = [
    {
      id: "openai-acc-intended",
      email: "intended@example.com",
      plan: "ChatGPT Plus",
      addedAt: 2_000,
      credentialKind: "managed",
      provider: "openai",
      tokens: { accessToken: "intended-access", refreshToken: "intended-refresh", expiresAt: 2_000 },
    },
  ];
  await saveAccounts("default", baseline);
  let exchanges = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/accounts/deviceauth/usercode")) return startUpstreamResponse();
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      return Response.json({ authorization_code: AUTHORIZATION_CODE, code_verifier: CODE_VERIFIER });
    }
    if (url.endsWith("/oauth/token")) {
      exchanges += 1;
      return Response.json({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN });
    }
    if (url.includes("/wham/usage")) return Response.json(usageFixture);
    throw new Error(`unexpected fetch ${new URL(url).pathname}`);
  }) as unknown as typeof fetch;
  const started = await start("openai-acc-intended");
  now += 1_000;
  const heartbeat = heartbeatRecorder();
  try {
    const response = await statusPost(
      request("/api/connect/openai/device/status", { attemptId: started.attemptId }),
    );
    const body = await response.json();
    const replayResponse = await statusPost(
      request("/api/connect/openai/device/status", { attemptId: started.attemptId }),
    );
    const replay = await replayResponse.json();

    assert.equal(response.status, 409);
    assert.equal(exchanges, 1);
    assert.equal(heartbeat.activeCount(), 0);
    assert.equal(heartbeat.clearedCount(), 1);
    assert.deepEqual(await loadAccounts("default"), baseline);
    assert.deepEqual(replay, {
      status: "failed",
      error: "OpenAI device login failed. Start a new login and try again.",
    });
    assert.equal(JSON.stringify({ body, replay }).includes("openai-acc-device"), false);
  } finally {
    heartbeat.restore();
  }
});

test("route bodies, fields, sessions, sizes, and capabilities fail closed", async () => {
  const cases: Array<[string, Promise<Response>, number]> = [
    [
      "start extra field",
      startPost(request("/api/connect/openai/device/start", { unexpected: true })),
      400,
    ],
    [
      "status extra field",
      statusPost(request("/api/connect/openai/device/status", { attemptId: "invalid", unexpected: true })),
      400,
    ],
    [
      "start missing session",
      startPost(request("/api/connect/openai/device/start", {}, { authenticated: false })),
      401,
    ],
    [
      "status missing session",
      statusPost(request("/api/connect/openai/device/status", { attemptId: "invalid" }, { authenticated: false })),
      401,
    ],
    [
      "start oversized",
      startPost(request("/api/connect/openai/device/start", { expectedAccountId: "x".repeat(5_000) })),
      413,
    ],
    [
      "status oversized",
      statusPost(request("/api/connect/openai/device/status", { attemptId: "x".repeat(5_000) })),
      413,
    ],
    [
      "invalid capability",
      statusPost(request("/api/connect/openai/device/status", { attemptId: "not-a-capability" })),
      404,
    ],
    [
      "start malformed JSON",
      startPost(request("/api/connect/openai/device/start", "{")),
      400,
    ],
    [
      "status malformed JSON",
      statusPost(request("/api/connect/openai/device/status", "{")),
      400,
    ],
  ];

  for (const [label, responsePromise, expectedStatus] of cases) {
    const response = await responsePromise;
    assert.equal(response.status, expectedStatus, label);
    assert.equal(response.headers.get("cache-control"), "no-store", label);
  }
});

test("a transient pre-code poll failure restores pending state without exposing diagnostics", async () => {
  const diagnosticSecret = "fixture-diagnostic-secret";
  let polls = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/accounts/deviceauth/usercode")) return startUpstreamResponse();
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      polls += 1;
      throw new Error([...forbiddenSecrets(), diagnosticSecret].join(":"));
    }
    throw new Error(`unexpected fetch ${new URL(url).pathname}`);
  }) as unknown as typeof fetch;
  const started = await start();
  now += 1_000;
  const captured: unknown[][] = [];
  const originalError = console.error;
  const heartbeat = heartbeatRecorder();
  console.error = (...args: unknown[]) => captured.push(args);
  try {
    const response = await statusPost(
      request("/api/connect/openai/device/status", { attemptId: started.attemptId }),
    );
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(openAIDeviceAttemptStore.status(started.attemptId, "default")?.status, "pending");
    assert.equal(polls, 1);
    assert.equal(heartbeat.activeCount(), 0);
    assert.equal(heartbeat.clearedCount(), 1);
    const serialized = JSON.stringify({ body, captured });
    for (const forbidden of [...forbiddenSecrets(), diagnosticSecret]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    console.error = originalError;
    heartbeat.restore();
  }
});

test("an ambiguous code exchange fails terminally and is never retried", async () => {
  const diagnosticSecret = "fixture-ambiguous-exchange-secret";
  let polls = 0;
  let exchanges = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/accounts/deviceauth/usercode")) return startUpstreamResponse();
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      polls += 1;
      return Response.json({ authorization_code: AUTHORIZATION_CODE, code_verifier: CODE_VERIFIER });
    }
    if (url.endsWith("/oauth/token")) {
      exchanges += 1;
      throw new Error(diagnosticSecret);
    }
    throw new Error(`unexpected fetch ${new URL(url).pathname}`);
  }) as unknown as typeof fetch;
  const started = await start();
  now += 1_000;
  const captured: unknown[][] = [];
  const originalError = console.error;
  const heartbeat = heartbeatRecorder();
  console.error = (...args: unknown[]) => captured.push(args);
  try {
    const firstResponse = await statusPost(
      request("/api/connect/openai/device/status", { attemptId: started.attemptId }),
    );
    const first = await firstResponse.json();
    const replayResponse = await statusPost(
      request("/api/connect/openai/device/status", { attemptId: started.attemptId }),
    );
    const replay = await replayResponse.json();

    assert.equal(firstResponse.status, 502);
    assert.equal(replayResponse.status, 200);
    assert.equal(polls, 1);
    assert.equal(exchanges, 1);
    assert.equal(heartbeat.activeCount(), 0);
    assert.equal(heartbeat.clearedCount(), 1);
    assert.deepEqual(replay, {
      status: "failed",
      error: "OpenAI device login failed. Start a new login and try again.",
    });
    const serialized = JSON.stringify({ first, replay, captured });
    for (const forbidden of [...forbiddenSecrets(), diagnosticSecret]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    console.error = originalError;
    heartbeat.restore();
  }
});

test("a vault save failure clears the poll heartbeat and terminally removes attempt secrets", async () => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/accounts/deviceauth/usercode")) return startUpstreamResponse();
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      return Response.json({ authorization_code: AUTHORIZATION_CODE, code_verifier: CODE_VERIFIER });
    }
    if (url.endsWith("/oauth/token")) {
      return Response.json({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN });
    }
    if (url.includes("/wham/usage")) return Response.json(usageFixture);
    throw new Error(`unexpected fetch ${new URL(url).pathname}`);
  }) as unknown as typeof fetch;
  const started = await start();
  now += 1_000;

  const originalRename = fs.rename;
  fs.rename = (async () => {
    throw Object.assign(new Error("synthetic route persistence failure"), { code: "EIO" });
  }) as typeof fs.rename;
  const heartbeat = heartbeatRecorder();
  const captured: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => captured.push(args);
  try {
    const response = await statusPost(
      request("/api/connect/openai/device/status", { attemptId: started.attemptId }),
    );
    const body = await response.json();
    const terminal = openAIDeviceAttemptStore.status(started.attemptId, "default");

    assert.equal(response.status, 500);
    assert.equal(heartbeat.activeCount(), 0);
    assert.equal(heartbeat.clearedCount(), 1);
    assert.deepEqual(terminal, {
      status: "failed",
      error: "OpenAI device login failed. Start a new login and try again.",
    });
    const serialized = JSON.stringify({ body, terminal, captured });
    for (const forbidden of forbiddenSecrets()) assert.equal(serialized.includes(forbidden), false);
  } finally {
    console.error = originalError;
    heartbeat.restore();
    fs.rename = originalRename;
  }
});
