import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertStrictLocalEnvironment,
  sessionCookiePolicy,
  strictLocalEnvironmentErrors,
  strictLocalModeEnabled,
  strictLocalRequestHostAllowed,
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

function validOrdinaryProduction(
  overrides: StrictLocalEnvironment = {},
): StrictLocalEnvironment {
  return {
    NODE_ENV: "production",
    APP_PASSWORD: "a".repeat(64),
    AUTH_SECRET: "b".repeat(64),
    VAULT_ENCRYPTION_SECRET: "c".repeat(64),
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

test("ordinary production rejects missing, trivial, whitespace, and reused security secrets", () => {
  const invalid = [
    validOrdinaryProduction({ APP_PASSWORD: undefined }),
    validOrdinaryProduction({ AUTH_SECRET: undefined }),
    validOrdinaryProduction({ VAULT_ENCRYPTION_SECRET: undefined }),
    validOrdinaryProduction({ APP_PASSWORD: "x" }),
    validOrdinaryProduction({ AUTH_SECRET: "x" }),
    validOrdinaryProduction({ VAULT_ENCRYPTION_SECRET: "x" }),
    validOrdinaryProduction({ APP_PASSWORD: " ".repeat(64) }),
    validOrdinaryProduction({ AUTH_SECRET: "\t".repeat(64) }),
    validOrdinaryProduction({ VAULT_ENCRYPTION_SECRET: "\n".repeat(64) }),
    validOrdinaryProduction({ AUTH_SECRET: "a".repeat(64) }),
    validOrdinaryProduction({ VAULT_ENCRYPTION_SECRET: "a".repeat(64) }),
    validOrdinaryProduction({ VAULT_ENCRYPTION_SECRET: "b".repeat(64) }),
  ];

  for (const env of invalid) {
    assert.throws(() => sessionCookiePolicy(env), /production configuration refused to start/i);
  }
  assert.deepEqual(sessionCookiePolicy(validOrdinaryProduction()), {
    secure: true,
    sameSite: "lax",
  });
});

test("production backend credentials cannot reuse application or cross-backend security secrets", () => {
  const appPassword = "a".repeat(64);
  const authSecret = "b".repeat(64);
  const vaultSecret = "c".repeat(64);
  const protectedValues = [appPassword, authSecret, vaultSecret];
  const backendNames = [
    "VAULT_ACCESS_SECRET",
    "KV_REST_API_TOKEN",
    "UPSTASH_REDIS_REST_TOKEN",
  ] as const;

  for (const name of backendNames) {
    assert.throws(
      () => sessionCookiePolicy(validOrdinaryProduction({ [name]: "  too-short\t" })),
      /production configuration refused to start/i,
    );
    for (const reused of protectedValues) {
      assert.throws(
        () =>
          sessionCookiePolicy(
            validOrdinaryProduction({
              [name]: `  ${reused}\t`,
            }),
          ),
        /production configuration refused to start/i,
      );
    }
  }

  const vaultAccessSecret = "d".repeat(64);
  const sharedRedisCredential = "e".repeat(64);
  for (const redisName of ["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"] as const) {
    assert.throws(
      () =>
        sessionCookiePolicy(
          validOrdinaryProduction({
            VAULT_ACCESS_SECRET: vaultAccessSecret,
            [redisName]: vaultAccessSecret,
          }),
        ),
      /production configuration refused to start/i,
    );
  }
  assert.deepEqual(
    sessionCookiePolicy(
      validOrdinaryProduction({
        VAULT_ACCESS_SECRET: vaultAccessSecret,
        KV_REST_API_TOKEN: sharedRedisCredential,
        UPSTASH_REDIS_REST_TOKEN: sharedRedisCredential,
      }),
    ),
    { secure: true, sameSite: "lax" },
  );
  assert.deepEqual(
    sessionCookiePolicy({
      NODE_ENV: "development",
      VAULT_ACCESS_SECRET: "short",
      KV_REST_API_TOKEN: "short",
      UPSTASH_REDIS_REST_TOKEN: "short",
    }),
    { secure: false, sameSite: "lax" },
  );
});

test("production CRON_SECRET is strong and independent from application and backend secrets", () => {
  const vaultAccessSecret = "d".repeat(64);
  const sharedRedisCredential = "e".repeat(64);
  const base = validOrdinaryProduction({
    VAULT_ACCESS_SECRET: vaultAccessSecret,
    KV_REST_API_TOKEN: sharedRedisCredential,
    UPSTASH_REDIS_REST_TOKEN: sharedRedisCredential,
  });
  for (const cronSecret of [
    " short ",
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
    vaultAccessSecret,
    sharedRedisCredential,
  ]) {
    assert.throws(
      () => sessionCookiePolicy({ ...base, CRON_SECRET: ` ${cronSecret.trim()}\t` }),
      /production configuration refused to start/i,
    );
  }
  assert.deepEqual(
    sessionCookiePolicy({ ...base, CRON_SECRET: "f".repeat(64) }),
    { secure: true, sameSite: "lax" },
  );
  assert.deepEqual(
    sessionCookiePolicy({ NODE_ENV: "development", CRON_SECRET: "short" }),
    { secure: false, sameSite: "lax" },
  );
});

test("production secret documentation requires three independent 32-character values", async () => {
  const example = await readFile(path.resolve(".env.example"), "utf8");
  const readme = await readFile(path.resolve("README.md"), "utf8");
  const selfHosting = await readFile(path.resolve("docs/SELF_HOSTING.md"), "utf8");
  const security = await readFile(path.resolve("SECURITY.md"), "utf8");

  assert.match(example, /Every production mode requires all three values/u);
  assert.doesNotMatch(example, /Defaults to APP_PASSWORD when blank/u);
  assert.match(
    readme,
    /Convex \| `CONVEX_URL` \+ `VAULT_ACCESS_SECRET` \+ `VAULT_ENCRYPTION_SECRET`/u,
  );
  assert.match(
    readme,
    /Encrypted file \| Production: `VAULT_ENCRYPTION_SECRET`; development: none/u,
  );
  assert.match(selfHosting, /Production requires all three values/u);
  assert.match(selfHosting, /at least 32\s+characters after trimming/u);
  assert.match(selfHosting, /Fresh Convex vaults use `VAULT_ENCRYPTION_SECRET`/u);
  assert.match(
    selfHosting,
    /Production local-file\s+storage requires `VAULT_ENCRYPTION_SECRET`/u,
  );
  assert.doesNotMatch(selfHosting, /Fresh Convex vault uses `VAULT_ACCESS_SECRET`/u);
  assert.match(security, /at least 32 characters after trimming/u);
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
  assert.deepEqual(sessionCookiePolicy(validOrdinaryProduction()), { secure: true, sameSite: "lax" });
});

test("strict mode accepts only the exact loopback Host header", () => {
  assert.equal(strictLocalRequestHostAllowed("127.0.0.1:37645", valid()), true);
  for (const host of [null, "", "127.0.0.1", "localhost:37645", "[::1]:37645", "127.0.0.1:3000", "evil.example"]) {
    assert.equal(strictLocalRequestHostAllowed(host, valid()), false);
  }
  assert.equal(strictLocalRequestHostAllowed("evil.example", { NODE_ENV: "production" }), true);
});
