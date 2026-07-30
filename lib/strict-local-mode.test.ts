import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  assertStrictLocalEnvironment,
  sessionCookiePolicy,
  strictLocalEnvironmentErrors,
  strictLocalHostAllowed,
  strictLocalModeEnabled,
  type StrictLocalEnvironment,
} from "./strict-local-mode.ts";

function valid(overrides: StrictLocalEnvironment = {}): StrictLocalEnvironment {
  return {
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
    VAULT_DATA_DIR: path.resolve(".strict-local-test-vault"),
    NEXT_TELEMETRY_DISABLED: "1",
    ...overrides,
  };
}

test("strict mode accepts only the reviewed local production shape", () => {
  assert.equal(strictLocalModeEnabled(valid()), true);
  assert.deepEqual(strictLocalEnvironmentErrors(valid()), []);
  assert.doesNotThrow(() => assertStrictLocalEnvironment(valid()));
});

test("strict mode fails closed when a secret is absent, short, or reused", () => {
  for (const env of [
    valid({ APP_PASSWORD: undefined }),
    valid({ AUTH_SECRET: "short" }),
    valid({ VAULT_ENCRYPTION_SECRET: "a".repeat(64) }),
  ]) {
    assert.ok(strictLocalEnvironmentErrors(env).length > 0);
    assert.throws(() => assertStrictLocalEnvironment(env), /refused to start/i);
  }
});

test("strict mode rejects non-loopback, development, proxy trust, and remote services", () => {
  for (const env of [
    valid({ HMC_LISTEN_HOST: "0.0.0.0" }),
    valid({ NODE_ENV: "development" }),
    valid({ TRUST_PROXY_IP_HEADERS: "1" }),
    valid({ TRUST_PROXY_IP_HEADERS: "true" }),
    valid({ TRUST_PROXY_IP_HEADERS: undefined }),
    valid({ PORT: "3000" }),
    valid({ ENABLE_LOCAL_CONNECT: "0" }),
    valid({ VAULT_DATA_DIR: "relative-vault" }),
    valid({ NEXT_TELEMETRY_DISABLED: undefined }),
    valid({ NODE_OPTIONS: "--require attacker.js" }),
    valid({ HTTPS_PROXY: "http://proxy.invalid" }),
    valid({ CONVEX_URL: "https://example.convex.cloud" }),
    valid({ WEBHOOK_URL: "https://receiver.example" }),
  ]) {
    assert.ok(strictLocalEnvironmentErrors(env).length > 0);
  }
});

test("loopback HTTP uses a host-only strict cookie policy", () => {
  assert.deepEqual(sessionCookiePolicy(valid()), { secure: false, sameSite: "strict" });
  assert.deepEqual(sessionCookiePolicy({ NODE_ENV: "production" }), { secure: true, sameSite: "lax" });
});

test("strict mode accepts only the exact loopback Host header", () => {
  assert.equal(strictLocalHostAllowed("127.0.0.1:37645", valid()), true);
  for (const host of [null, "", "127.0.0.1", "localhost:37645", "[::1]:37645", "127.0.0.1:3000", "evil.example"]) {
    assert.equal(strictLocalHostAllowed(host, valid()), false);
  }
  assert.equal(strictLocalHostAllowed("evil.example", { NODE_ENV: "production" }), true);
});
