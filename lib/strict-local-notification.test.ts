import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, test } from "node:test";
import "./providers/_resolve-ts.mjs";

const [{ dispatch }, { assertStrictLocalEnvironment }] = await Promise.all([
  import("./notify.ts"),
  import("./strict-local-mode.ts"),
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
});

test("notifications make no network, storage, or Web Push attempt in the valid strict-local shape", async () => {
  setValidStrictEnvironment();
  assert.doesNotThrow(() => assertStrictLocalEnvironment());

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
