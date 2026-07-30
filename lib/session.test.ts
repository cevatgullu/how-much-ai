import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, test } from "node:test";
import { authOpen, createSession, safeEqual, verifySession } from "./session.ts";

const originalPassword = process.env.APP_PASSWORD;
const originalAuthSecret = process.env.AUTH_SECRET;
const originalLegacyMode = process.env.AUTH_MODE;
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
const originalStrictEnvironment = new Map(strictEnvironmentNames.map((name) => [name, process.env[name]]));

function restore(name: "APP_PASSWORD" | "AUTH_SECRET" | "AUTH_MODE", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function setSyntheticStrictEnvironment(overrides: Record<string, string | undefined> = {}): void {
  for (const name of strictEnvironmentNames) delete process.env[name];
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
    VAULT_DATA_DIR: path.resolve(".strict-local-session-test-vault"),
    NEXT_TELEMETRY_DISABLED: "1",
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => {
  restore("APP_PASSWORD", originalPassword);
  restore("AUTH_SECRET", originalAuthSecret);
  restore("AUTH_MODE", originalLegacyMode);
  for (const name of strictEnvironmentNames) restore(name, originalStrictEnvironment.get(name));
});

test("zero configuration is open, while APP_PASSWORD enables the gate", () => {
  delete process.env.AUTH_MODE;
  delete process.env.APP_PASSWORD;
  assert.equal(authOpen(), true);

  process.env.APP_PASSWORD = "a strong local password";
  assert.equal(authOpen(), false);
});

test("an unsupported legacy auth mode fails closed after an edition change", () => {
  delete process.env.APP_PASSWORD;
  process.env.AUTH_MODE = "clerk";
  assert.equal(authOpen(), false);
});

test("strict-local mode refuses to enter open mode when APP_PASSWORD is missing", () => {
  setSyntheticStrictEnvironment({ APP_PASSWORD: undefined });
  assert.throws(() => authOpen(), /refused to start/i);
});

test("valid strict-local mode keeps the password gate enabled", () => {
  setSyntheticStrictEnvironment();
  assert.equal(authOpen(), false);
});

test("password sessions verify before expiry and reject tampering", async () => {
  process.env.APP_PASSWORD = "correct horse battery staple";
  process.env.AUTH_SECRET = "independent session secret";
  const issuedAt = 1_700_000_000_000;
  const token = await createSession(issuedAt);

  assert.equal(await verifySession(token, issuedAt + 1_000), true);
  assert.equal(await verifySession(`${token}x`, issuedAt + 1_000), false);
  assert.equal(await verifySession(token, issuedAt + 31 * 24 * 60 * 60 * 1_000), false);
});

test("password comparison handles equal, unequal, and unequal-length values", () => {
  assert.equal(safeEqual("same", "same"), true);
  assert.equal(safeEqual("same", "diff"), false);
  assert.equal(safeEqual("short", "a much longer value"), false);
});
