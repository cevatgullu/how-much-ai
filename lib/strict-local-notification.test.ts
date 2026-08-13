import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, test } from "node:test";
import "./providers/_resolve-ts.mjs";

const [
  { dispatch },
  { assertStrictLocalEnvironment },
  { REMAINING_BOUNDARIES, diffLocalLimit, formatLocalLimitNotification },
  { processLocalNotificationSnapshot },
  { LOCAL_NOTIFICATION_ACK, localNotificationPermission },
] = await Promise.all([
  import("./notify.ts"),
  import("./strict-local-mode.ts"),
  import("./local-notify-detect.ts"),
  import("./local-notify-coordinator.ts"),
  import("./local-notify-delivery.ts"),
]);

const strictEnvironmentNames = [
  "HMC_STRICT_LOCAL_MODE",
  "HMC_LISTEN_HOST",
  "HMC_LISTEN_PORT",
  "PORT",
  "NODE_ENV",
  "APP_PASSWORD",
  "AUTH_SECRET",
  "VAULT_ENCRYPTION_SECRET",
  "TRUST_PROXY_IP_HEADERS",
  "ENABLE_LOCAL_CONNECT",
  "VAULT_DATA_DIR",
  "NEXT_TELEMETRY_DISABLED",
  "CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "VAULT_ACCESS_SECRET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "APP_URL",
  "HMC_URL",
  "HOW_MUCH_AI_URL",
  "AUTH_MODE",
  "VERCEL",
  "CF_PAGES",
  "FLY_APP_NAME",
  "CRON_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "WEBHOOK_URL",
  "VAPID_PUBLIC",
  "VAPID_PRIVATE",
  "VAPID_SUBJECT",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "OPENSSL_CONF",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;
const originalEnvironment = new Map(strictEnvironmentNames.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const browserGlobalNames = ["Notification", "navigator", "MessageChannel", "PushManager"] as const;
const originalBrowserGlobals = new Map(
  browserGlobalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);

class RuntimeStorage implements Storage {
  readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class RuntimePort {
  peer?: RuntimePort;
  readonly listeners = new Set<(event: MessageEvent) => void>();
  addEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }
  start(): void {}
  close(): void {}
  postMessage(data: unknown): void {
    queueMicrotask(() => {
      for (const listener of this.peer?.listeners ?? []) listener({ data } as MessageEvent);
    });
  }
}

class RuntimeMessageChannel {
  readonly port1 = new RuntimePort();
  readonly port2 = new RuntimePort();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

const events = [{
  accountLabel: "Claude 1",
  accountId: "synthetic-anthropic-1",
  event: {
    type: "warning" as const,
    limitKey: "session",
    limitLabel: "Current session",
    percent: 91,
    peakPct: 91,
    resetsAt: "2026-08-01T00:00:00.000Z",
  },
}];

function restoreEnvironment(): void {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function clearReviewedEnvironment(): void {
  for (const name of strictEnvironmentNames) delete process.env[name];
}

function setValidStrictEnvironment(): void {
  clearReviewedEnvironment();
  Object.assign(process.env, {
    HMC_STRICT_LOCAL_MODE: "1",
    HMC_LISTEN_HOST: "127.0.0.1",
    HMC_LISTEN_PORT: "37645",
    PORT: "37645",
    NODE_ENV: "production",
    APP_PASSWORD: "a".repeat(64),
    AUTH_SECRET: "b".repeat(64),
    VAULT_ENCRYPTION_SECRET: "c".repeat(64),
    TRUST_PROXY_IP_HEADERS: "0",
    ENABLE_LOCAL_CONNECT: "1",
    VAULT_DATA_DIR: path.resolve(".strict-local-notification-test-vault"),
    NEXT_TELEMETRY_DISABLED: "1",
  });
}

afterEach(() => {
  restoreEnvironment();
  globalThis.fetch = originalFetch;
  for (const name of browserGlobalNames) {
    const descriptor = originalBrowserGlobals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

test("the strict-local contract is exact, runs only in the active local browser, suppresses stale data, and never uses hosted channels", async () => {
  setValidStrictEnvironment();
  assert.doesNotThrow(() => assertStrictLocalEnvironment());
  assert.deepEqual(REMAINING_BOUNDARIES, [50, 40, 30, 20, 15, 10, 5, 0]);

  const first = diffLocalLimit(undefined, {
    limitKey: "session",
    usedPercent: 49,
    remainingPercent: 51,
    resetsAt: "2026-08-01T00:00:00.000Z",
  }, { remainingWarnings: true, resetNotifications: true });
  assert.equal(first.kind, "seed");
  assert.equal(first.event, null);
  assert.notEqual(first.nextState, null);

  const expectedThresholds = [
    [50, "Claude 1 • 5 saatlik limit: %50 kaldı."],
    [40, "Claude 1 • 5 saatlik limit: %40 kaldı."],
    [30, "Claude 1 • 5 saatlik limit: %30 kaldı."],
    [20, "Claude 1 • 5 saatlik limit: %20 kaldı."],
    [15, "Claude 1 • 5 saatlik limit: %15 kaldı."],
    [10, "Claude 1 • 5 saatlik limit: %10 kaldı."],
    [5, "Claude 1 • 5 saatlik limit: %5 kaldı."],
    [0, "Claude 1 • 5 saatlik limit: limit bitti."],
  ] as const;
  let state = first.nextState!;
  for (const [boundary, expectedBody] of expectedThresholds) {
    const diff = diffLocalLimit(state, {
      limitKey: "session",
      usedPercent: 100 - boundary,
      remainingPercent: boundary,
      resetsAt: "2026-08-01T00:00:00.000Z",
    }, { remainingWarnings: true, resetNotifications: true });
    assert.equal(diff.kind, "event");
    assert.deepEqual(diff.event, { type: "threshold", boundary });
    assert.deepEqual(formatLocalLimitNotification(diff.event!, "Claude 1", "5 saatlik limit"), {
      title: "How Much AI",
      body: expectedBody,
    });
    state = diff.nextState!;
  }

  const firstAtFive = diffLocalLimit(undefined, {
    limitKey: "weekly_all",
    usedPercent: 95,
    remainingPercent: 5,
    resetsAt: "2026-08-01T00:00:00.000Z",
  }, { remainingWarnings: true, resetNotifications: true });
  assert.equal(firstAtFive.kind, "seed");
  assert.equal(firstAtFive.event, null);

  // A window that was never touched has nothing to announce when it rolls over. Without this
  // gate an idle account emits "limit sıfırlandı" on every single rollover, forever.
  const idleSeed = diffLocalLimit(undefined, {
    limitKey: "weekly_all",
    usedPercent: 0,
    remainingPercent: 100,
    resetsAt: "2026-08-01T00:00:00.000Z",
  }, { remainingWarnings: true, resetNotifications: true });
  assert.equal(idleSeed.kind, "seed");
  const idleRollover = diffLocalLimit(idleSeed.nextState!, {
    limitKey: "weekly_all",
    usedPercent: 0,
    remainingPercent: 100,
    resetsAt: "2026-08-08T00:00:00.000Z",
  }, { remainingWarnings: true, resetNotifications: true });
  assert.equal(idleRollover.kind, "advance");
  assert.equal(idleRollover.event, null);
  // The rollover must still be recorded, otherwise the same stamp keeps looking new.
  assert.equal(idleRollover.nextState!.lastResetAt, "2026-08-08T00:00:00.000Z");

  const reset = diffLocalLimit(state, {
    limitKey: "session",
    usedPercent: 0,
    remainingPercent: 100,
    resetsAt: "2026-08-02T00:00:00.000Z",
  }, { remainingWarnings: true, resetNotifications: true });
  assert.deepEqual(reset.event, { type: "reset" });
  assert.deepEqual(formatLocalLimitNotification(reset.event!, "Claude 1", "5 saatlik limit"), {
    title: "How Much AI",
    body: "Claude 1 • 5 saatlik limit: limit sıfırlandı.",
  });

  const storage = new RuntimeStorage();
  const lockCalls: Array<{ name: string; options: unknown }> = [];
  const registrations: string[] = [];
  const workerRequests: Array<Record<string, unknown>> = [];
  let localFetchCalls = 0;
  const worker = {
    postMessage(data: unknown, ports: readonly RuntimePort[]) {
      const request = data as Record<string, unknown>;
      workerRequests.push(request);
      ports[0]?.postMessage({
        type: LOCAL_NOTIFICATION_ACK,
        requestId: request.requestId,
        ok: true,
      });
    },
  };
  const registration = { active: worker };
  const browserLocks = { request: async () => undefined };
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: { permission: "granted", requestPermission: async () => "granted" },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: browserLocks,
      serviceWorker: {
        controller: null,
        register: async (url: string) => { registrations.push(url); return registration; },
        ready: Promise.resolve(registration),
      },
    },
  });
  Object.defineProperty(globalThis, "MessageChannel", {
    configurable: true,
    value: RuntimeMessageChannel,
  });
  Object.defineProperty(globalThis, "PushManager", {
    configurable: true,
    get: () => { throw new Error("Strict-local delivery must not inspect PushManager"); },
  });
  globalThis.fetch = (async () => {
    localFetchCalls += 1;
    throw new Error("Strict-local delivery must remain on-device");
  }) as typeof fetch;
  assert.equal(localNotificationPermission(), "granted");
  const localDependencies = {
    locks: {
      request: async (
        name: string,
        options: { mode: "exclusive"; ifAvailable: true },
        callback: (lock: unknown) => Promise<unknown>,
      ) => {
        lockCalls.push({ name, options });
        return await callback({ name });
      },
    },
    storage,
    hashAccountId: async () => "a".repeat(64),
    notificationTag: async () => "hma:" + "b".repeat(32),
  };
  const localSnapshot = (remainingPercent: number) => ({
    accountId: "private-account",
    accountLabel: "Claude 1",
    bars: [{
      key: "session",
      kind: "session",
      label: "5 saatlik limit",
      usedPercent: 100 - remainingPercent,
      remainingPercent,
      resetsAt: "2026-08-01T00:00:00.000Z",
      severity: "normal",
      isActive: false,
    }],
    activeAccountIds: ["private-account"],
    rules: { remainingWarnings: true, resetNotifications: true },
    stale: false,
  });

  assert.deepEqual(
    await processLocalNotificationSnapshot(localSnapshot(51), localDependencies),
    { status: "idle", delivered: 0 },
  );
  assert.deepEqual(
    await processLocalNotificationSnapshot(localSnapshot(50), localDependencies),
    { status: "delivered", delivered: 1 },
  );
  assert.deepEqual(lockCalls, [
    { name: "hma-local-notifications-v1", options: { mode: "exclusive", ifAvailable: true } },
    { name: "hma-local-notifications-v1", options: { mode: "exclusive", ifAvailable: true } },
  ]);
  assert.deepEqual(registrations, ["/sw.js"]);
  assert.equal(workerRequests.length, 1);
  assert.deepEqual({
    type: workerRequests[0]?.type,
    title: workerRequests[0]?.title,
    body: workerRequests[0]?.body,
    tag: workerRequests[0]?.tag,
  }, {
    type: "hma-local-limit-v1",
    title: "How Much AI",
    body: "Claude 1 • 5 saatlik limit: %50 kaldı.",
    tag: "hma:" + "b".repeat(32),
  });
  assert.match(String(workerRequests[0]?.requestId), /^[a-f0-9]{32}$/u);
  assert.equal(
    storage.values.get("hma:local-notify-state:v1"),
    `{"version":1,"records":[{"accountHash":"${"a".repeat(64)}","limitKey":"session",` +
      '"lastResetAt":"2026-08-01T00:00:00.000Z","nextBoundaryIndex":1,"lastObservedUtilization":50}]}',
  );
  assert.equal(localFetchCalls, 0);
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: undefined });
  assert.equal(localNotificationPermission(), "unsupported");

  const staleCalls: string[] = [];
  assert.deepEqual(await processLocalNotificationSnapshot({
    accountId: "private-account",
    accountLabel: "Claude 1",
    bars: [],
    activeAccountIds: ["private-account"],
    rules: { remainingWarnings: true, resetNotifications: true },
    stale: true,
  }, {
    locks: { request: async () => { staleCalls.push("lock"); return undefined; } },
    storage: null,
    hashAccountId: async () => { staleCalls.push("hash"); return "a".repeat(64); },
    notificationTag: async () => { staleCalls.push("tag"); return "hma:" + "a".repeat(32); },
    deliver: async () => { staleCalls.push("deliver"); return { ok: true }; },
  }), { status: "idle", delivered: 0 });
  assert.deepEqual(staleCalls, []);

  let fetchCalls = 0;
  let subscriptionLoads = 0;
  let webPushLoads = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("Fetch must remain inert");
  }) as typeof fetch;

  const result = await dispatch("default", events, {
    loadSubscriptions: async () => {
      subscriptionLoads += 1;
      throw new Error("Subscription storage must remain inert");
    },
    loadWebPush: async () => {
      webPushLoads += 1;
      throw new Error("Web Push must remain inert");
    },
  });

  assert.equal(fetchCalls, 0);
  assert.equal(subscriptionLoads, 0);
  assert.equal(webPushLoads, 0);
  assert.deepEqual(result.channels, []);
  assert.deepEqual(result.attempted, []);
  assert.deepEqual(result.push, { sent: 0, removed: 0, failed: 0 });
  assert.equal(result.delivered, false);
  assert.deepEqual(result.failures, [{
    channel: "notifications",
    error: "No notification destination is configured for this tenant.",
  }]);
});

test("the dispatcher uses the narrow injected subscription and Web Push loaders", async () => {
  clearReviewedEnvironment();
  process.env.VAPID_PUBLIC = "synthetic-public-key";
  process.env.VAPID_PRIVATE = "synthetic-private-key";
  process.env.VAPID_SUBJECT = "mailto:synthetic@example.test";

  let fetchCalls = 0;
  let subscriptionLoads = 0;
  let webPushLoads = 0;
  let sends = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("Fetch is not part of Web Push delivery");
  }) as typeof fetch;

  const result = await dispatch("default", events, {
    loadSubscriptions: async () => {
      subscriptionLoads += 1;
      return [{
        endpoint: "https://push.example.org/subscription",
        p256dh: "synthetic-p256dh",
        auth: "synthetic-auth",
      }];
    },
    loadWebPush: async () => {
      webPushLoads += 1;
      return {
        setVapidDetails: () => undefined,
        sendNotification: async () => {
          sends += 1;
          return { statusCode: 201, body: "", headers: {} };
        },
      };
    },
  });

  assert.equal(fetchCalls, 0);
  assert.equal(subscriptionLoads, 1);
  assert.equal(webPushLoads, 1);
  assert.equal(sends, 1);
  assert.deepEqual(result.channels, ["push"]);
  assert.deepEqual(result.attempted, ["push"]);
  assert.deepEqual(result.push, { sent: 1, removed: 0, failed: 0 });
  assert.equal(result.delivered, true);
  assert.deepEqual(result.failures, []);
});
