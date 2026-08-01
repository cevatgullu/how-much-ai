import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserAccount, StoredAccount } from "./types.ts";

// Production uses bundler-style extensionless imports. Teach Node's type-stripping test runner how
// to resolve local runtime dependencies before dynamically importing the production modules.
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
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
const {
  clearTokenRecovery,
  loadAccounts,
  loadTokenRecovery,
  mutateAccounts,
  parseStoredAccounts,
  saveAccounts,
  saveTokenRecovery,
  storageBackend,
  vaultRevision,
} = await import("./vault.ts");
const { toBrowserAccount } = await import("./browser-boundary.ts");
const { getAccountUsage } = await import("./usage-service.ts");
const { GET: getVault, PUT: putVault } = await import("../app/api/vault/route.ts");
const { createSession, SESSION_COOKIE } = await import("./session.ts");

const TEST_SECRET = "vault-test-secret-with-enough-entropy";
const TEST_PASSWORD = "vault-test-password";
const TEST_AUTH_SECRET = "vault-test-auth-secret";
const ENV_KEYS = [
  "APP_PASSWORD",
  "AUTH_SECRET",
  "NODE_ENV",
  "VAULT_ENCRYPTION_SECRET",
  "VAULT_DATA_DIR",
  "CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "VAULT_ACCESS_SECRET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "VERCEL",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let dataDir = "";
let sessionCookie = "";

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-vault-test-"));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NODE_ENV = "development";
  process.env.VAULT_DATA_DIR = dataDir;
  process.env.VAULT_ENCRYPTION_SECRET = TEST_SECRET;
  process.env.APP_PASSWORD = TEST_PASSWORD;
  process.env.AUTH_SECRET = TEST_AUTH_SECRET;
  sessionCookie = `${SESSION_COOKIE}=${await createSession()}`;
});

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  moduleHooks.deregister();
});

function storedAccount(id: string, accessToken = `access-${id}`): StoredAccount {
  return {
    id,
    email: `${id}@example.com`,
    fullName: `Person ${id}`,
    plan: "Pro",
    addedAt: 1_700_000_000_000,
    credentialKind: "rotating",
    tokens: { accessToken, refreshToken: `refresh-${id}`, expiresAt: 1_800_000_000_000 },
  };
}

function vaultFile(userId: string): string {
  const suffix = userId === "default" ? "" : `-${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return path.join(dataDir, `vault${suffix}.enc`);
}

// Produces the original iv:tag:ciphertext format so compatibility and decrypted JSON failures can
// be tested without exporting encryption internals from the production module.
function encryptHistoricalPayload(plaintext: string, secret = TEST_SECRET): string {
  const key = crypto.scryptSync(secret, "usage.vault.salt.v1", 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

function encryptV2Payload(plaintext: string, secret = TEST_SECRET): string {
  return `v2:${encryptHistoricalPayload(plaintext, secret)}`;
}

function proofForSecret(secret: string): string {
  return crypto.createHmac("sha256", secret).update("how-much-claude:vault-key-proof:v1").digest("hex");
}

function inMemoryRedisFetch(
  redis: Map<string, string>,
  hooks: { afterAuxiliaryRead?: () => void } = {},
): typeof fetch {
  return async (_input, init) => {
    const command = JSON.parse(String(init?.body)) as string[];
    let result: unknown;
    if (command[0] === "GET") {
      result = redis.get(command[1]) ?? null;
    } else if (command[0] === "EVAL" && command[2] === "3") {
      const key = command[3];
      const backupKey = command[4];
      const proofKey = command[5];
      const expected = command[6];
      const next = command[7];
      const proof = command[8];
      const current = redis.get(key);
      const matches =
        (expected === "__HMC_VAULT_MISSING__" && current === undefined) || current === expected;
      const storedProof = redis.get(proofKey);
      if (!matches) result = 0;
      else if (storedProof !== undefined && storedProof !== proof) result = -1;
      else {
        if (storedProof === undefined) redis.set(proofKey, proof);
        redis.set(backupKey, next);
        redis.set(key, next);
        result = 1;
      }
    } else if (command[0] === "EVAL" && command[2] === "2") {
      const key = command[3];
      const proofKey = command[4];
      const storedProof = redis.get(proofKey);
      if (command.length === 6) {
        const proof = command[5];
        result = storedProof === proof ? (redis.get(key) ?? null) : -1;
        hooks.afterAuxiliaryRead?.();
      } else {
        const expected = command[5];
        const next = command[6];
        const proof = command[7];
        const current = redis.get(key);
        const matches =
          (expected === "__HMC_VAULT_MISSING__" && current === undefined) || current === expected;
        if (storedProof !== proof) result = -1;
        else {
          if (matches) redis.set(key, next);
          result = matches ? 1 : 0;
        }
      }
    } else {
      throw new Error(`Unexpected Redis command ${command[0]} ${command[2] ?? ""}`);
    }
    return Response.json({ result });
  };
}

function restoreEnvironmentValue(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

function authenticatedRequest(input: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Cookie", sessionCookie);
  return new Request(input, { ...init, headers });
}

test("a genuinely missing vault loads as an empty account list", async () => {
  assert.deepEqual(await loadAccounts("missing-user"), []);
});

test("production vault writes refuse to fall back to the human login password", async () => {
  const userId = "production-missing-vault-secret";
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousPassword = process.env.APP_PASSWORD;
  const previousAuthSecret = process.env.AUTH_SECRET;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  process.env.NODE_ENV = "production";
  process.env.APP_PASSWORD = "a".repeat(64);
  process.env.AUTH_SECRET = "b".repeat(64);
  delete process.env.VAULT_ENCRYPTION_SECRET;

  try {
    await assert.rejects(
      () => saveAccounts(userId, [storedAccount("must-not-persist")]),
      /production configuration refused to start/i,
    );
    await assert.rejects(() => fs.stat(vaultFile(userId)), { code: "ENOENT" });
    await assert.rejects(() => fs.stat(`${vaultFile(userId)}.last-good`), { code: "ENOENT" });
  } finally {
    restoreEnvironmentValue("NODE_ENV", previousNodeEnvironment);
    restoreEnvironmentValue("APP_PASSWORD", previousPassword);
    restoreEnvironmentValue("AUTH_SECRET", previousAuthSecret);
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    await fs.rm(vaultFile(userId), { force: true });
    await fs.rm(`${vaultFile(userId)}.last-good`, { force: true });
  }
});

test("production local vault reads refuse legacy APP_PASSWORD encryption without rewriting it", async () => {
  const userId = "production-local-password-generation";
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousPassword = process.env.APP_PASSWORD;
  const previousAuthSecret = process.env.AUTH_SECRET;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const password = "a".repeat(64);
  const raw = encryptV2Payload(
    JSON.stringify([storedAccount("local-password-account", "local-password-access-canary")]),
    password,
  );
  await fs.writeFile(vaultFile(userId), raw, { mode: 0o600 });
  process.env.NODE_ENV = "production";
  process.env.APP_PASSWORD = password;
  process.env.AUTH_SECRET = "b".repeat(64);
  process.env.VAULT_ENCRYPTION_SECRET = "c".repeat(64);

  try {
    await assert.rejects(() => loadAccounts(userId), /vault key migration required/i);
    assert.equal(await fs.readFile(vaultFile(userId), "utf8"), raw);
  } finally {
    restoreEnvironmentValue("NODE_ENV", previousNodeEnvironment);
    restoreEnvironmentValue("APP_PASSWORD", previousPassword);
    restoreEnvironmentValue("AUTH_SECRET", previousAuthSecret);
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    await fs.rm(vaultFile(userId), { force: true });
  }
});

test("storage configuration fails closed for partial remotes and ephemeral hosted files", () => {
  const remoteKeys = [
    "CONVEX_URL",
    "NEXT_PUBLIC_CONVEX_URL",
    "VAULT_ACCESS_SECRET",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "VERCEL",
  ] as const;
  const clear = () => {
    for (const key of remoteKeys) delete process.env[key];
  };

  try {
    clear();
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://browser-only.convex.cloud";
    assert.equal(storageBackend(), "file");

    clear();
    process.env.CONVEX_URL = "https://partial.convex.cloud";
    assert.throws(() => storageBackend(), /partially configured/i);

    clear();
    process.env.VAULT_ACCESS_SECRET = "secret-without-url";
    assert.throws(() => storageBackend(), /partially configured/i);

    clear();
    process.env.KV_REST_API_TOKEN = "token-without-url";
    assert.throws(() => storageBackend(), /partially configured/i);

    clear();
    process.env.UPSTASH_REDIS_REST_URL = "https://partial-redis.test";
    assert.throws(() => storageBackend(), /partially configured/i);

    clear();
    process.env.VERCEL = "1";
    assert.throws(() => storageBackend(), /require durable Convex or Redis/i);

    clear();
    process.env.CONVEX_URL = "https://complete.convex.cloud";
    process.env.VAULT_ACCESS_SECRET = "complete-secret";
    process.env.KV_REST_API_TOKEN = "unused-partial-token";
    assert.equal(storageBackend(), "convex");

    clear();
    process.env.KV_REST_API_URL = "https://complete-redis.test";
    process.env.KV_REST_API_TOKEN = "complete-token";
    assert.equal(storageBackend(), "redis");

  } finally {
    clear();
  }
});

test("a new Convex tenant uses the shared access key across mixed VES rollout instances", async () => {
  const originalFetch = globalThis.fetch;
  const previousConvexUrl = process.env.CONVEX_URL;
  const previousAccessSecret = process.env.VAULT_ACCESS_SECRET;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const rows = new Map<string, string>();
  const userId = "convex-mixed-key-rollout";
  const mainKey = `accounts::${userId}`;
  const backupKey = `accounts-last-good::${userId}`;
  const proofKey = `accounts-key-proof::${userId}`;
  const existingUserId = "convex-existing-preferred-key";
  const existingMainKey = `accounts::${existingUserId}`;
  const existingBackupKey = `accounts-last-good::${existingUserId}`;
  const existingProofKey = `accounts-key-proof::${existingUserId}`;
  const sharedAccessSecret = "shared-convex-bootstrap-key";
  const firstPreferredSecret = "first-rollout-preferred-key";
  const secondPreferredSecret = "second-rollout-preferred-key";
  const account = storedAccount("convex-rollout-account");

  process.env.CONVEX_URL = "https://vault-rollout.convex.cloud";
  process.env.VAULT_ACCESS_SECRET = `  ${sharedAccessSecret}\n`;
  process.env.VAULT_ENCRYPTION_SECRET = `\t${firstPreferredSecret}  `;
  globalThis.fetch = async (input, init) => {
    const endpoint = String(input);
    const body = JSON.parse(String(init?.body)) as {
      path: string;
      args: [Record<string, unknown>];
    };
    const args = body.args[0];
    assert.equal(args.secret, sharedAccessSecret, "Convex authentication must use the normalized access secret");

    if (body.path === "vault:get") {
      assert.equal(endpoint, "https://vault-rollout.convex.cloud/api/query");
      return Response.json({ status: "success", value: rows.get(String(args.key)) ?? null });
    }
    if (body.path === "vault:compareAndSet") {
      assert.equal(endpoint, "https://vault-rollout.convex.cloud/api/mutation");
      const key = String(args.key);
      const expected = args.expected === null ? null : String(args.expected);
      if ((rows.get(key) ?? null) !== expected) {
        return Response.json({ status: "success", value: false });
      }
      const suppliedProof = String(args.keyProof);
      const storedProof = rows.get(String(args.proofKey));
      if (storedProof !== undefined && storedProof !== suppliedProof) {
        throw new Error("test Convex key-proof mismatch");
      }
      if (storedProof === undefined) rows.set(String(args.proofKey), suppliedProof);
      rows.set(String(args.backupKey), String(args.data));
      rows.set(key, String(args.data));
      return Response.json({ status: "success", value: true });
    }
    throw new Error(`Unexpected Convex function ${body.path}`);
  };

  try {
    await saveAccounts(userId, [account]);
    assert.equal(rows.get(backupKey), rows.get(mainKey));
    assert.equal(rows.get(proofKey), proofForSecret(sharedAccessSecret));

    // A concurrently draining deployment may have a different preferred VES, but every Convex app
    // instance necessarily has the shared access key used to authenticate this same backend.
    process.env.VAULT_ENCRYPTION_SECRET = ` ${secondPreferredSecret}\t`;
    assert.deepEqual(await loadAccounts(userId), [account]);

    // A tenant that already has a proved VES generation must remain on that exact key. The shared
    // access key is only the deterministic bootstrap for a truly empty, proof-less Convex tenant.
    const existingAccount = storedAccount("convex-existing-preferred-account");
    const existingCiphertext = encryptV2Payload(JSON.stringify([existingAccount]), firstPreferredSecret);
    rows.set(existingMainKey, existingCiphertext);
    rows.set(existingBackupKey, existingCiphertext);
    rows.set(existingProofKey, proofForSecret(firstPreferredSecret));
    process.env.VAULT_ENCRYPTION_SECRET = ` ${firstPreferredSecret}\n`;
    await mutateAccounts(existingUserId, (accounts) => [...accounts, storedAccount("convex-sticky-write")]);
    assert.equal(rows.get(existingProofKey), proofForSecret(firstPreferredSecret));
    assert.notEqual(rows.get(existingMainKey), existingCiphertext);
    assert.equal(rows.get(existingBackupKey), rows.get(existingMainKey));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("CONVEX_URL", previousConvexUrl);
    restoreEnvironmentValue("VAULT_ACCESS_SECRET", previousAccessSecret);
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
  }
});

test("read, decrypt, JSON, and stored-schema failures never masquerade as an empty vault", async () => {
  const readFailure = vaultFile("read-failure");
  await fs.mkdir(readFailure, { recursive: true });
  await assert.rejects(() => loadAccounts("read-failure"));

  const malformed = vaultFile("malformed-ciphertext");
  await fs.writeFile(malformed, "not-an-encrypted-vault", { mode: 0o600 });
  await assert.rejects(() => loadAccounts("malformed-ciphertext"), /vault is corrupt/i);

  const invalidJson = vaultFile("invalid-json");
  await fs.writeFile(invalidJson, encryptHistoricalPayload("{ definitely not json"), { mode: 0o600 });
  await assert.rejects(() => loadAccounts("invalid-json"), /vault is corrupt/i);

  const invalidSchema = vaultFile("invalid-schema");
  await fs.writeFile(invalidSchema, encryptHistoricalPayload(JSON.stringify([{ id: "partial" }])), { mode: 0o600 });
  await assert.rejects(() => loadAccounts("invalid-schema"), /tokens must be an object/i);
});

test("historical AES-GCM vault blobs remain readable", async () => {
  const account = storedAccount("historical");
  await fs.writeFile(vaultFile("historical"), encryptHistoricalPayload(JSON.stringify([account])), { mode: 0o600 });
  assert.deepEqual(await loadAccounts("historical"), [account]);
});

test("vault decryption rejects a valid ciphertext with a shortened authentication tag", async () => {
  const account = storedAccount("short-authentication-tag");
  const [iv, tag, ciphertext] = encryptHistoricalPayload(JSON.stringify([account])).split(":");
  const shortenedTag = Buffer.from(tag, "base64").subarray(0, 12).toString("base64");
  await fs.writeFile(
    vaultFile("short-authentication-tag"),
    `${iv}:${shortenedTag}:${ciphertext}`,
    { mode: 0o600 },
  );

  await assert.rejects(() => loadAccounts("short-authentication-tag"), /vault is corrupt/i);
});

test("local vault secrets are normalized for new writes while exact raw legacy keys remain readable", async () => {
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const previousPassword = process.env.APP_PASSWORD;
  const normalizedSecret = "normalized-local-vault-key";
  const rawHistoricalSecret = "  historical-local-v2-key\n";
  const rawHistoricalPassword = "\t historical-local-v1-password  ";
  const normalizedAccount = storedAccount("local-normalized-secret");
  const historicalV2Account = storedAccount("local-raw-v2-secret");
  const historicalV1Account = storedAccount("local-raw-v1-secret");

  try {
    process.env.VAULT_ENCRYPTION_SECRET = `  ${normalizedSecret}\n`;
    delete process.env.APP_PASSWORD;
    await saveAccounts("local-normalized-secret", [normalizedAccount]);
    process.env.VAULT_ENCRYPTION_SECRET = normalizedSecret;
    assert.deepEqual(await loadAccounts("local-normalized-secret"), [normalizedAccount]);

    process.env.VAULT_ENCRYPTION_SECRET = rawHistoricalSecret;
    await fs.writeFile(
      vaultFile("local-raw-v2-secret"),
      encryptV2Payload(JSON.stringify([historicalV2Account]), rawHistoricalSecret),
      { mode: 0o600 },
    );
    assert.deepEqual(await loadAccounts("local-raw-v2-secret"), [historicalV2Account]);

    process.env.APP_PASSWORD = rawHistoricalPassword;
    await fs.writeFile(
      vaultFile("local-raw-v1-secret"),
      encryptHistoricalPayload(JSON.stringify([historicalV1Account]), rawHistoricalPassword),
      { mode: 0o600 },
    );
    assert.deepEqual(await loadAccounts("local-raw-v1-secret"), [historicalV1Account]);
  } finally {
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    restoreEnvironmentValue("APP_PASSWORD", previousPassword);
  }
});

test("new vault blobs are versioned and a dedicated encryption secret survives password changes", async () => {
  const userId = "stable-encryption-key";
  process.env.APP_PASSWORD = "old-login-password";
  process.env.VAULT_ENCRYPTION_SECRET = TEST_SECRET;
  await saveAccounts(userId, [storedAccount("stable")]);
  assert.match(await fs.readFile(vaultFile(userId), "utf8"), /^v2:/);

  process.env.APP_PASSWORD = "new-login-password";
  assert.deepEqual(await loadAccounts(userId), [storedAccount("stable")]);
  delete process.env.APP_PASSWORD;
});

test("legacy password-encrypted blobs remain readable after adding a stable encryption secret", async () => {
  const userId = "legacy-password-migration";
  const account = storedAccount("legacy-password");
  const oldPassword = "historical-login-password";
  process.env.APP_PASSWORD = oldPassword;
  process.env.VAULT_ENCRYPTION_SECRET = TEST_SECRET;
  await fs.writeFile(
    vaultFile(userId),
    encryptHistoricalPayload(JSON.stringify([account]), oldPassword),
    { mode: 0o600 },
  );

  assert.deepEqual(await loadAccounts(userId), [account]);
  await mutateAccounts(userId, (accounts) => [...accounts, storedAccount("migrated")]);
  assert.match(await fs.readFile(vaultFile(userId), "utf8"), /^v2:/);
  process.env.APP_PASSWORD = "changed-after-migration";
  assert.equal((await loadAccounts(userId)).length, 2);
  delete process.env.APP_PASSWORD;
});

test("a stable encryption secret can be added after a v2 local-fallback vault already exists", async () => {
  const userId = "late-stable-key";
  delete process.env.VAULT_ENCRYPTION_SECRET;
  delete process.env.APP_PASSWORD;
  try {
    await saveAccounts(userId, [storedAccount("before-key")]);
    process.env.VAULT_ENCRYPTION_SECRET = TEST_SECRET;
    assert.deepEqual(await loadAccounts(userId), [storedAccount("before-key")]);
    await mutateAccounts(userId, (accounts) => accounts.map((account) => ({ ...account, label: "migrated" })));
    assert.equal((await loadAccounts(userId))[0].label, "migrated");
  } finally {
    process.env.VAULT_ENCRYPTION_SECRET = TEST_SECRET;
  }
});

test("StoredAccount validation requires the full safe schema and strips unknown fields", () => {
  for (const invalid of [undefined, null, {}, "accounts"]) {
    assert.throws(() => parseStoredAccounts(invalid), /accounts must be an array/);
  }

  const valid = storedAccount("valid") as StoredAccount & { ignored?: unknown };
  valid.ignored = { unsafe: true };
  const parsed = parseStoredAccounts([valid]);
  assert.deepEqual(parsed, [storedAccount("valid")]);
  assert.equal("ignored" in parsed[0], false);

  const managed = { ...storedAccount("managed"), credentialKind: "managed" as const };
  assert.deepEqual(parseStoredAccounts([managed]), [managed]);

  const invalidAccounts: unknown[] = [
    null,
    { ...storedAccount("x"), id: " " },
    { ...storedAccount("x"), email: null },
    { ...storedAccount("x"), plan: null },
    { ...storedAccount("x"), addedAt: -1 },
    { ...storedAccount("x"), fullName: 1 },
    { ...storedAccount("x"), label: false },
    { ...storedAccount("x"), tokens: null },
    { ...storedAccount("x"), tokens: { ...storedAccount("x").tokens, accessToken: null } },
    { ...storedAccount("x"), tokens: { ...storedAccount("x").tokens, refreshToken: undefined } },
    { ...storedAccount("x"), tokens: { ...storedAccount("x").tokens, accessToken: "" } },
    { ...storedAccount("x"), tokens: { ...storedAccount("x").tokens, refreshToken: " " } },
    { ...storedAccount("x"), tokens: { ...storedAccount("x").tokens, accessToken: "x".repeat(16 * 1024 + 1) } },
    { ...storedAccount("x"), tokens: { ...storedAccount("x").tokens, expiresAt: -1 } },
    { ...storedAccount("x"), credentialKind: "unknown" },
    { ...storedAccount("x"), credentialKind: "long_lived" },
    {
      ...storedAccount("x"),
      credentialKind: "managed",
      tokens: { ...storedAccount("x").tokens, refreshToken: null },
    },
  ];
  for (const invalid of invalidAccounts) assert.throws(() => parseStoredAccounts([invalid]));

  assert.throws(
    () => parseStoredAccounts([storedAccount("duplicate"), storedAccount("duplicate")]),
    /duplicates another saved account/i,
  );
  assert.throws(
    () => parseStoredAccounts(Array.from({ length: 501 }, (_, index) => storedAccount(`many-${index}`))),
    /at most 500 entries/i,
  );
});

test("vault GET and PUT expose only redacted account DTOs", async () => {
  const original = storedAccount("put-original");
  await saveAccounts("default", [original]);

  const getResponse = await getVault(authenticatedRequest("http://localhost/api/vault"));
  assert.equal(getResponse.status, 200);
  const getPayload = (await getResponse.json()) as { accounts: BrowserAccount[]; revision: string };
  assert.deepEqual(getPayload, {
    accounts: [toBrowserAccount(original)],
    revision: vaultRevision([original]),
  });
  assert.equal(JSON.stringify(getPayload).includes(original.tokens.accessToken), false);
  assert.equal(JSON.stringify(getPayload).includes(original.tokens.refreshToken!), false);

  const revision = getPayload.revision;
  const response = await putVault(
    authenticatedRequest("http://localhost/api/vault", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [{ op: "rename", accountId: original.id, label: "Primary" }],
        revision,
      }),
    }),
  );
  assert.equal(response.status, 200);
  const renamed = { ...original, label: "Primary" };
  const persistedRenamed = await loadAccounts("default");
  assert.deepEqual(persistedRenamed, [renamed]);
  assert.deepEqual(await response.json(), {
    ok: true,
    accounts: [toBrowserAccount(renamed)],
    revision: vaultRevision(persistedRenamed),
  });
});

test("vault metadata and removal mutations preserve server-owned credentials", async () => {
  const first = storedAccount("semantic-first", "access-semantic-first");
  const second = storedAccount("semantic-second", "access-semantic-second");
  await saveAccounts("default", [first, second]);
  const revision = vaultRevision([first, second]);

  const response = await putVault(
    authenticatedRequest("http://localhost/api/vault", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          {
            op: "update_metadata",
            accountId: first.id,
            email: "updated@example.com",
            fullName: null,
            plan: "Max 5×",
          },
          { op: "remove", accountId: second.id },
        ],
        revision,
      }),
    }),
  );

  assert.equal(response.status, 200);
  const expected = { ...first, email: "updated@example.com", plan: "Max 5×" };
  delete expected.fullName;
  assert.deepEqual(await loadAccounts("default"), [expected]);
  assert.deepEqual(expected.tokens, first.tokens);
  const payload = await response.json();
  assert.deepEqual(payload, {
    ok: true,
    accounts: [toBrowserAccount(expected)],
    revision: vaultRevision([expected]),
  });
  assert.equal(JSON.stringify(payload).includes(first.tokens.accessToken), false);
  assert.equal(JSON.stringify(payload).includes(first.tokens.refreshToken!), false);
});

test("vault removal clears only the removed account's production usage cache", async () => {
  const retained = storedAccount("cache-removal-retained");
  const removed = storedAccount("cache-removal-removed");
  const expiresAt = Date.now() + 86_400_000;
  retained.tokens.expiresAt = expiresAt;
  removed.tokens.expiresAt = expiresAt;
  await saveAccounts("default", [retained, removed]);
  const originalFetch = globalThis.fetch;
  let usageCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/oauth/usage")) {
      usageCalls += 1;
      return new Response(JSON.stringify({ sample: `usage-${usageCalls}` }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/api/oauth/profile")) {
      return new Response(JSON.stringify({ account: { uuid: "profile-id" } }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const retainedBefore = await getAccountUsage("default", retained);
    const removedBefore = await getAccountUsage("default", removed);
    assert.equal(retainedBefore.status, "ready");
    assert.equal(removedBefore.status, "ready");
    assert.equal(usageCalls, 2);

    const response = await putVault(
      authenticatedRequest("http://localhost/api/vault", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mutations: [{ op: "remove", accountId: removed.id }],
          revision: vaultRevision([retained, removed]),
        }),
      }),
    );
    assert.equal(response.status, 200);
    await mutateAccounts("default", (accounts) => [...accounts, removed]);

    const retainedAfter = await getAccountUsage("default", retained);
    const removedAfter = await getAccountUsage("default", removed);

    assert.equal(usageCalls, 3);
    assert.deepEqual(retainedAfter.usage, retainedBefore.usage);
    assert.notDeepEqual(removedAfter.usage, removedBefore.usage);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("vault PUT rejects whole-account and malformed mutation bodies without clearing data", async () => {
  const original = storedAccount("put-invalid");
  await saveAccounts("default", [original]);
  const revision = vaultRevision([original]);

  const invalidBodies: Array<[string, number]> = [
    [JSON.stringify({}), 428],
    [JSON.stringify({ mutations: null, revision }), 400],
    [JSON.stringify({ mutations: {}, revision }), 400],
    [JSON.stringify({ mutations: [{ op: "rename", accountId: original.id }], revision }), 400],
    [JSON.stringify({ mutations: [{ op: "remove", accountId: original.id, tokens: original.tokens }], revision }), 400],
    [JSON.stringify({ accounts: [original], revision }), 400],
    ["{ malformed json", 400],
  ];
  for (const [body, expectedStatus] of invalidBodies) {
    const response = await putVault(
      authenticatedRequest("http://localhost/api/vault", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      }),
    );
    assert.equal(response.status, expectedStatus);
    assert.deepEqual(await loadAccounts("default"), [original]);
  }
});

test("vault mutations rebase from a token-free 409 without changing rotated credentials", async () => {
  const original = storedAccount("revision-guard", "access-old");
  await saveAccounts("default", [original]);

  const withoutRevision = await putVault(
    authenticatedRequest("http://localhost/api/vault", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [{ op: "rename", accountId: original.id, label: "browser nickname" }],
      }),
    }),
  );
  assert.equal(withoutRevision.status, 428);
  assert.deepEqual(await loadAccounts("default"), [original]);

  const staleRevision = vaultRevision([original]);
  const rotated = {
    ...original,
    tokens: {
      accessToken: "access-rotated",
      refreshToken: "refresh-rotated",
      expiresAt: original.tokens.expiresAt + 60_000,
    },
  };
  await mutateAccounts("default", () => [rotated]);

  const staleResponse = await putVault(
    authenticatedRequest("http://localhost/api/vault", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [{ op: "rename", accountId: original.id, label: "browser nickname" }],
        revision: staleRevision,
      }),
    }),
  );
  assert.equal(staleResponse.status, 409);
  const conflict = (await staleResponse.json()) as { accounts: BrowserAccount[]; revision: string };
  assert.deepEqual(conflict.accounts, [toBrowserAccount(rotated)]);
  assert.equal(conflict.revision, vaultRevision([rotated]));
  const conflictJson = JSON.stringify(conflict);
  assert.equal(conflictJson.includes(rotated.tokens.accessToken), false);
  assert.equal(conflictJson.includes(rotated.tokens.refreshToken!), false);
  assert.equal(conflictJson.includes("accessToken"), false);
  assert.equal(conflictJson.includes("refreshToken"), false);
  assert.deepEqual(await loadAccounts("default"), [rotated]);

  const retryResponse = await putVault(
    authenticatedRequest("http://localhost/api/vault", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [{ op: "rename", accountId: original.id, label: "browser nickname" }],
        revision: conflict.revision,
      }),
    }),
  );
  assert.equal(retryResponse.status, 200);
  const finalStored = { ...rotated, label: "browser nickname" };
  const persistedFinal = await loadAccounts("default");
  assert.deepEqual(persistedFinal, [finalStored]);
  const retryPayload = await retryResponse.json();
  assert.deepEqual(retryPayload, {
    ok: true,
    accounts: [toBrowserAccount(finalStored)],
    revision: vaultRevision(persistedFinal),
  });
  assert.equal(JSON.stringify(retryPayload).includes(rotated.tokens.accessToken), false);
});

test("vault GET returns empty only for missing storage and reports corrupted storage as 500", async () => {
  await Promise.all([
    fs.rm(vaultFile("default"), { force: true }),
    fs.rm(`${vaultFile("default")}.last-good`, { force: true }),
  ]);
  const missingResponse = await getVault(authenticatedRequest("http://localhost/api/vault"));
  assert.equal(missingResponse.status, 200);
  assert.deepEqual(await missingResponse.json(), { accounts: [], revision: vaultRevision([]) });

  await fs.writeFile(vaultFile("default"), "corrupt", { mode: 0o600 });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const corruptResponse = await getVault(authenticatedRequest("http://localhost/api/vault"));
    assert.equal(corruptResponse.status, 500);
    const body = (await corruptResponse.json()) as { error: string; errorId: string; errorCode: string };
    assert.equal(body.error, "Couldn't read saved accounts");
    assert.match(body.errorId, /^err_[a-f0-9]{12}$/);
    assert.equal(body.errorCode, "VAULT_UNREADABLE");
  } finally {
    console.error = originalConsoleError;
  }
});

test("vault route failures return an error id without logging or reflecting exception secrets", async () => {
  const secret = "fake-secret-in-private-storage-path";
  const poisonPath = path.join(dataDir, secret);
  const previousDataDir = process.env.VAULT_DATA_DIR;
  const originalConsoleError = console.error;
  const captured: unknown[][] = [];
  await fs.writeFile(poisonPath, "not a directory");
  process.env.VAULT_DATA_DIR = poisonPath;
  console.error = (...args: unknown[]) => captured.push(args);

  try {
    const response = await getVault(authenticatedRequest("http://localhost/api/vault"));
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: string; errorId: string; errorCode?: string };
    assert.equal(body.error, "Couldn't read saved accounts");
    assert.match(body.errorId, /^err_[a-f0-9]{12}$/);
    assert.equal(body.errorCode, undefined);
    assert.deepEqual(captured, [
      [
        {
          errorId: body.errorId,
          scope: "vault.read",
          errorClass: "Error",
          code: "ENOTDIR",
        },
      ],
    ]);
    const serialized = JSON.stringify({ body, captured });
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("message"), false);
    assert.equal(serialized.includes("cause"), false);
  } finally {
    console.error = originalConsoleError;
    if (previousDataDir === undefined) delete process.env.VAULT_DATA_DIR;
    else process.env.VAULT_DATA_DIR = previousDataDir;
    await fs.rm(poisonPath, { force: true });
  }
});

test("invalid saves are rejected before they can replace an existing vault", async () => {
  const userId = "preserve-on-validation-error";
  const original = storedAccount("original");
  await saveAccounts(userId, [original]);

  const invalid = [
    { ...storedAccount("bad"), tokens: { accessToken: "partial", expiresAt: 1_800_000_000_000 } },
  ] as unknown as StoredAccount[];
  await assert.rejects(() => saveAccounts(userId, invalid), /refreshToken/);
  assert.deepEqual(await loadAccounts(userId), [original]);
});

test("local saves atomically replace a private 0600 file without leftover temp files", async () => {
  const userId = "atomic";
  await saveAccounts(userId, [storedAccount("first")]);
  const file = vaultFile(userId);
  const before = await fs.stat(file);
  if (process.platform !== "win32") assert.equal(before.mode & 0o777, 0o600);
  const keyFile = path.join(dataDir, "vault.key");
  const key = (await fs.readFile(keyFile, "utf8")).trim();
  assert.ok(key.length >= 32);
  assert.notEqual(key, "usage-local-open-mode-key-v1");
  if (process.platform !== "win32") assert.equal((await fs.stat(keyFile)).mode & 0o777, 0o600);

  await saveAccounts(userId, [storedAccount("second")]);
  const after = await fs.stat(file);
  if (process.platform !== "win32") assert.equal(after.mode & 0o777, 0o600);
  // The destination is a newly-created temp inode renamed over the old one, not an in-place write.
  if (process.platform !== "win32") assert.notEqual(after.ino, before.ino);
  assert.deepEqual(await loadAccounts(userId), [storedAccount("second")]);
  assert.deepEqual((await fs.readdir(dataDir)).filter((name) => name.endsWith(".tmp")), []);
});

test("an unreadable main vault restores the latest fully committed generation", async () => {
  const userId = "last-known-good";
  const first = storedAccount("first-generation");
  const second = storedAccount("second-generation");
  await saveAccounts(userId, [first]);
  await saveAccounts(userId, [first, second]);

  const main = vaultFile(userId);
  const backup = `${main}.last-good`;
  const expectedBackup = await fs.readFile(backup, "utf8");
  await fs.writeFile(main, "well-contained-corruption", { mode: 0o600 });

  assert.deepEqual(await loadAccounts(userId), [first, second]);
  assert.equal(await fs.readFile(main, "utf8"), expectedBackup);
  assert.equal(await fs.readFile(backup, "utf8"), expectedBackup);
});

test("automatic restore never resurrects an account removed by the latest successful write", async () => {
  const userId = "no-removed-account-resurrection";
  const retained = storedAccount("retained");
  const removed = storedAccount("removed");
  await saveAccounts(userId, [retained, removed]);
  await mutateAccounts(userId, (accounts) => accounts.filter((account) => account.id !== removed.id));

  const main = vaultFile(userId);
  const backup = `${main}.last-good`;
  assert.equal(await fs.readFile(main, "utf8"), await fs.readFile(backup, "utf8"));
  await fs.writeFile(main, "corrupt-after-account-removal", { mode: 0o600 });
  assert.deepEqual(await loadAccounts(userId), [retained]);
});

test("parallel per-user mutations retain every account and token update", async () => {
  const userId = "parallel-mutations";
  const accountCount = 16;

  await Promise.all(
    Array.from({ length: accountCount }, (_, index) =>
      mutateAccounts(userId, async (current) => {
        await new Promise((resolve) => setTimeout(resolve, index % 3));
        return [...current, storedAccount(`account-${index}`)];
      }),
    ),
  );

  const added = await loadAccounts(userId);
  assert.equal(added.length, accountCount);
  assert.deepEqual(
    added.map((account) => account.id).sort(),
    Array.from({ length: accountCount }, (_, index) => `account-${index}`).sort(),
  );

  await Promise.all(
    Array.from({ length: accountCount }, (_, index) =>
      mutateAccounts(userId, async (current) => {
        await new Promise((resolve) => setTimeout(resolve, index % 2));
        return current.map((account) =>
          account.id === `account-${index}`
            ? { ...account, tokens: { ...account.tokens, accessToken: `rotated-${index}` } }
            : account,
        );
      }),
    ),
  );

  const rotated = await loadAccounts(userId);
  for (let index = 0; index < accountCount; index += 1) {
    assert.equal(rotated.find((account) => account.id === `account-${index}`)?.tokens.accessToken, `rotated-${index}`);
  }
});

test("direct saves share the queue and a failed mutation does not poison later work", async () => {
  const userId = "shared-queue";
  const directSave = saveAccounts(userId, [storedAccount("base")]);
  const append = mutateAccounts(userId, (current) => [...current, storedAccount("appended")]);
  await Promise.all([directSave, append]);
  assert.deepEqual(await loadAccounts(userId), [storedAccount("base"), storedAccount("appended")]);

  const expectedFailure = assert.rejects(
    mutateAccounts(userId, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      throw new Error("intentional mutation failure");
    }),
    /intentional mutation failure/,
  );
  const recovery = mutateAccounts(userId, (current) => [...current, storedAccount("after-failure")]);
  await Promise.all([expectedFailure, recovery]);
  assert.equal((await loadAccounts(userId)).some((account) => account.id === "after-failure"), true);
});

test("a remote vault under the public legacy key returns no accounts and installs no proof", async () => {
  const originalFetch = globalThis.fetch;
  const previousDataDir = process.env.VAULT_DATA_DIR;
  const redis = new Map<string, string>();
  const userId = "remote-with-read-only-local-artifact";
  const poisonPath = path.join(dataDir, "not-a-data-directory");
  const account = storedAccount("remote-readable");
  const legacyRemoteFallback = "usage-local-open-mode-key-v1";
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  await fs.writeFile(poisonPath, "a file makes nested vault.key access fail with ENOTDIR");
  redis.set(`usage:vault:v1::${userId}`, encryptV2Payload(JSON.stringify([account]), legacyRemoteFallback));
  const before = new Map(redis);

  process.env.VAULT_DATA_DIR = poisonPath;
  process.env.VAULT_ENCRYPTION_SECRET = "configured-independent-migration-target-key";
  process.env.KV_REST_API_URL = "https://redis-local-probe.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  globalThis.fetch = inMemoryRedisFetch(redis);

  try {
    await assert.rejects(() => loadAccounts(userId), /vault key migration required/i);
    assert.deepEqual(redis, before);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDataDir === undefined) delete process.env.VAULT_DATA_DIR;
    else process.env.VAULT_DATA_DIR = previousDataDir;
    if (previousEncryptionSecret === undefined) delete process.env.VAULT_ENCRYPTION_SECRET;
    else process.env.VAULT_ENCRYPTION_SECRET = previousEncryptionSecret;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    await fs.rm(poisonPath, { force: true });
  }
});

test("remote mutations cannot receive accounts or write while the public legacy key is authoritative", async () => {
  const originalFetch = globalThis.fetch;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const redis = new Map<string, string>();
  const userId = "public-key-mutation";
  const legacyRemoteFallback = "usage-local-open-mode-key-v1";
  const mainKey = `usage:vault:v1::${userId}`;
  const account = storedAccount("must-not-reach-mutator", "plaintext-access-canary");
  redis.set(mainKey, encryptV2Payload(JSON.stringify([account]), legacyRemoteFallback));
  redis.set(`usage:vault:key-proof:v1::${userId}`, proofForSecret(legacyRemoteFallback));
  const before = new Map(redis);
  let mutatorCalled = false;

  process.env.VAULT_ENCRYPTION_SECRET = "configured-independent-migration-target-key";
  process.env.KV_REST_API_URL = "https://redis-public-mutation.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  globalThis.fetch = inMemoryRedisFetch(redis);

  try {
    await assert.rejects(
      () =>
        mutateAccounts(userId, (accounts) => {
          mutatorCalled = true;
          assert.equal(accounts[0]?.tokens.accessToken, "plaintext-access-canary");
          return [...accounts, storedAccount("must-not-write")];
        }),
      /vault key migration required/i,
    );
    assert.equal(mutatorCalled, false);
    assert.deepEqual(redis, before);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("a public legacy proof cannot authorize creation of a new remote vault generation", async () => {
  const originalFetch = globalThis.fetch;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const redis = new Map<string, string>();
  const userId = "public-key-proof-only";
  const legacyRemoteFallback = "usage-local-open-mode-key-v1";
  redis.set(`usage:vault:key-proof:v1::${userId}`, proofForSecret(legacyRemoteFallback));
  const before = new Map(redis);

  process.env.VAULT_ENCRYPTION_SECRET = "configured-independent-migration-target-key";
  process.env.KV_REST_API_URL = "https://redis-public-proof.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  globalThis.fetch = inMemoryRedisFetch(redis);

  try {
    await assert.rejects(
      () => saveAccounts(userId, [storedAccount("must-not-create")]),
      /vault key migration required/i,
    );
    assert.deepEqual(redis, before);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("an empty production Redis vault validates every stored proof before load or mutation callbacks", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousPassword = process.env.APP_PASSWORD;
  const previousAuthSecret = process.env.AUTH_SECRET;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const previousAccessSecret = process.env.VAULT_ACCESS_SECRET;
  const password = "a".repeat(64);
  const vaultSecret = "c".repeat(64);

  process.env.NODE_ENV = "production";
  process.env.APP_PASSWORD = password;
  process.env.AUTH_SECRET = "b".repeat(64);
  process.env.VAULT_ENCRYPTION_SECRET = vaultSecret;
  delete process.env.VAULT_ACCESS_SECRET;
  process.env.KV_REST_API_URL = "https://redis-empty-proof.test";
  process.env.KV_REST_API_TOKEN = "strong-production-redis-token-0001";

  try {
    for (const proofCase of [
      {
        name: "public",
        proof: proofForSecret("usage-local-open-mode-key-v1"),
        error: /vault key migration required/i,
      },
      {
        name: "APP_PASSWORD",
        proof: proofForSecret(password),
        error: /vault key migration required/i,
      },
      {
        name: "unknown",
        proof: proofForSecret("unknown-proof-secret-that-is-not-configured"),
        error: /vault encryption key mismatch/i,
      },
    ]) {
      for (const operationName of ["load", "no-op mutation", "writing mutation"] as const) {
        await t.test(`${proofCase.name} ${operationName}`, async () => {
          const userId = `empty-proof-${proofCase.name}-${operationName.replaceAll(" ", "-")}`;
          const redis = new Map<string, string>([
            [`usage:vault:key-proof:v1::${userId}`, proofCase.proof],
          ]);
          const before = new Map(redis);
          let callbackCount = 0;
          globalThis.fetch = inMemoryRedisFetch(redis);

          const operation =
            operationName === "load"
              ? () => loadAccounts(userId)
              : () =>
                  mutateAccounts(userId, (accounts) => {
                    callbackCount += 1;
                    return operationName === "no-op mutation"
                      ? accounts
                      : [...accounts, storedAccount("must-not-reach-empty-proof-mutator")];
                  });

          await assert.rejects(operation, proofCase.error);
          assert.equal(callbackCount, 0);
          assert.deepEqual(redis, before);
        });
      }
    }

    await t.test("configured VAULT_ENCRYPTION_SECRET proof permits a genuinely empty vault", async () => {
      const userId = "empty-proof-configured-ves";
      const redis = new Map<string, string>([
        [`usage:vault:key-proof:v1::${userId}`, proofForSecret(vaultSecret)],
      ]);
      const before = new Map(redis);
      let callbackCount = 0;
      globalThis.fetch = inMemoryRedisFetch(redis);

      assert.deepEqual(await loadAccounts(userId), []);
      assert.deepEqual(
        await mutateAccounts(userId, (accounts) => {
          callbackCount += 1;
          return accounts;
        }),
        [],
      );
      assert.equal(callbackCount, 1);
      assert.deepEqual(redis, before);
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("NODE_ENV", previousNodeEnvironment);
    restoreEnvironmentValue("APP_PASSWORD", previousPassword);
    restoreEnvironmentValue("AUTH_SECRET", previousAuthSecret);
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    restoreEnvironmentValue("VAULT_ACCESS_SECRET", previousAccessSecret);
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("an empty production Convex vault rejects an access-secret proof before every mutator", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousPassword = process.env.APP_PASSWORD;
  const previousAuthSecret = process.env.AUTH_SECRET;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const previousConvexUrl = process.env.CONVEX_URL;
  const previousAccessSecret = process.env.VAULT_ACCESS_SECRET;
  const accessSecret = "d".repeat(64);
  const rows = new Map<string, string>();

  process.env.NODE_ENV = "production";
  process.env.APP_PASSWORD = "a".repeat(64);
  process.env.AUTH_SECRET = "b".repeat(64);
  process.env.VAULT_ENCRYPTION_SECRET = "c".repeat(64);
  process.env.CONVEX_URL = "https://empty-proof.convex.cloud";
  process.env.VAULT_ACCESS_SECRET = accessSecret;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      path: string;
      args: [Record<string, unknown>];
    };
    if (body.path !== "vault:get") throw new Error(`Unexpected Convex function ${body.path}`);
    return Response.json({
      status: "success",
      value: rows.get(String(body.args[0].key)) ?? null,
    });
  };

  try {
    for (const operationName of ["load", "no-op mutation", "writing mutation"] as const) {
      await t.test(operationName, async () => {
        const userId = `convex-empty-access-proof-${operationName.replaceAll(" ", "-")}`;
        rows.clear();
        rows.set(`accounts-key-proof::${userId}`, proofForSecret(accessSecret));
        const before = new Map(rows);
        let callbackCount = 0;
        const operation =
          operationName === "load"
            ? () => loadAccounts(userId)
            : () =>
                mutateAccounts(userId, (accounts) => {
                  callbackCount += 1;
                  return operationName === "no-op mutation"
                    ? accounts
                    : [...accounts, storedAccount("must-not-reach-convex-empty-proof-mutator")];
                });

        await assert.rejects(operation, /vault key migration required/i);
        assert.equal(callbackCount, 0);
        assert.deepEqual(rows, before);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("NODE_ENV", previousNodeEnvironment);
    restoreEnvironmentValue("APP_PASSWORD", previousPassword);
    restoreEnvironmentValue("AUTH_SECRET", previousAuthSecret);
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    restoreEnvironmentValue("CONVEX_URL", previousConvexUrl);
    restoreEnvironmentValue("VAULT_ACCESS_SECRET", previousAccessSecret);
  }
});

test("a configured public legacy key cannot create a fresh remote recovery journal", async () => {
  const originalFetch = globalThis.fetch;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const redis = new Map<string, string>();
  const userId = "public-key-fresh-recovery";
  const legacyRemoteFallback = "usage-local-open-mode-key-v1";
  const account = storedAccount("fresh-public-recovery");
  const recovery = {
    accountId: account.id,
    expectedRefreshToken: account.tokens.refreshToken!,
    tokens: {
      accessToken: "must-not-persist-access",
      refreshToken: "must-not-persist-refresh",
      expiresAt: account.tokens.expiresAt + 60_000,
    },
    createdAt: 1_700_000_002_000,
  };

  process.env.VAULT_ENCRYPTION_SECRET = legacyRemoteFallback;
  process.env.KV_REST_API_URL = "https://redis-public-fresh-recovery.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  globalThis.fetch = inMemoryRedisFetch(redis);

  try {
    await assert.rejects(
      () => saveTokenRecovery(recovery, userId),
      /vault key migration required/i,
    );
    assert.deepEqual(redis, new Map());
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("production remote main, backup, and recovery generations reject APP_PASSWORD encryption", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousPassword = process.env.APP_PASSWORD;
  const previousAuthSecret = process.env.AUTH_SECRET;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const password = "a".repeat(64);
  const vaultSecret = "c".repeat(64);
  const account = storedAccount("production-password-generation", "password-generation-access-canary");

  process.env.NODE_ENV = "production";
  process.env.APP_PASSWORD = password;
  process.env.AUTH_SECRET = "b".repeat(64);
  process.env.VAULT_ENCRYPTION_SECRET = vaultSecret;
  delete process.env.VAULT_ACCESS_SECRET;
  process.env.KV_REST_API_URL = "https://redis-production-key-policy.test";
  process.env.KV_REST_API_TOKEN = "strong-production-redis-token-0002";

  try {
    for (const scenario of ["main", "backup", "recovery"] as const) {
      await t.test(scenario, async () => {
        const redis = new Map<string, string>();
        const userId = `production-password-${scenario}`;
        const mainKey = `usage:vault:v1::${userId}`;
        const backupKey = `usage:vault:last-good:v1::${userId}`;
        const proofKey = `usage:vault:key-proof:v1::${userId}`;
        const recoveryKey = `usage:token-recovery:v1:${crypto.createHash("sha256").update(account.id).digest("hex")}::${userId}`;
        const recovery = {
          accountId: account.id,
          expectedRefreshToken: account.tokens.refreshToken!,
          tokens: {
            accessToken: "password-recovery-access-canary",
            refreshToken: "password-recovery-refresh-canary",
            expiresAt: account.tokens.expiresAt + 60_000,
          },
          createdAt: 1_700_000_003_000,
        };

        if (scenario === "main") {
          redis.set(mainKey, encryptV2Payload(JSON.stringify([account]), password));
          redis.set(proofKey, proofForSecret(password));
        } else if (scenario === "backup") {
          redis.set(mainKey, "corrupt-main-generation");
          redis.set(backupKey, encryptV2Payload(JSON.stringify([account]), password));
          redis.set(proofKey, proofForSecret(password));
        } else {
          redis.set(mainKey, encryptV2Payload(JSON.stringify([account]), vaultSecret));
          redis.set(proofKey, proofForSecret(vaultSecret));
          redis.set(recoveryKey, encryptV2Payload(JSON.stringify(recovery), password));
        }
        const before = new Map(redis);
        globalThis.fetch = inMemoryRedisFetch(redis);

        const operation =
          scenario === "recovery"
            ? () => loadTokenRecovery(userId, account.id)
            : () => loadAccounts(userId);
        await assert.rejects(operation, /vault key migration required/i);
        assert.deepEqual(redis, before);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("NODE_ENV", previousNodeEnvironment);
    restoreEnvironmentValue("APP_PASSWORD", previousPassword);
    restoreEnvironmentValue("AUTH_SECRET", previousAuthSecret);
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("production Convex rejects access-secret generations and creates fresh vaults with VAULT_ENCRYPTION_SECRET", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousPassword = process.env.APP_PASSWORD;
  const previousAuthSecret = process.env.AUTH_SECRET;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const previousConvexUrl = process.env.CONVEX_URL;
  const previousAccessSecret = process.env.VAULT_ACCESS_SECRET;
  const vaultSecret = "c".repeat(64);
  const accessSecret = "d".repeat(64);
  const rows = new Map<string, string>();

  process.env.NODE_ENV = "production";
  process.env.APP_PASSWORD = "a".repeat(64);
  process.env.AUTH_SECRET = "b".repeat(64);
  process.env.VAULT_ENCRYPTION_SECRET = vaultSecret;
  process.env.CONVEX_URL = "https://production-key-policy.convex.cloud";
  process.env.VAULT_ACCESS_SECRET = accessSecret;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      path: string;
      args: [Record<string, unknown>];
    };
    const args = body.args[0];
    if (body.path === "vault:get") {
      return Response.json({ status: "success", value: rows.get(String(args.key)) ?? null });
    }
    if (body.path === "vault:compareAndSet") {
      const key = String(args.key);
      const expected = args.expected === null ? null : String(args.expected);
      if ((rows.get(key) ?? null) !== expected) {
        return Response.json({ status: "success", value: false });
      }
      const proofKey = String(args.proofKey);
      const suppliedProof = String(args.keyProof);
      const storedProof = rows.get(proofKey);
      if (storedProof !== undefined && storedProof !== suppliedProof) {
        return Response.json({ status: "error", errorMessage: "Vault encryption key mismatch" });
      }
      if (storedProof === undefined) rows.set(proofKey, suppliedProof);
      rows.set(String(args.backupKey), String(args.data));
      rows.set(key, String(args.data));
      return Response.json({ status: "success", value: true });
    }
    throw new Error(`Unexpected Convex function ${body.path}`);
  };

  try {
    await t.test("legacy access-secret generation", async () => {
      const userId = "production-convex-access-generation";
      const mainKey = `accounts::${userId}`;
      const proofKey = `accounts-key-proof::${userId}`;
      rows.set(mainKey, encryptV2Payload(JSON.stringify([storedAccount("access-secret-account")]), accessSecret));
      rows.set(proofKey, proofForSecret(accessSecret));
      const before = new Map(rows);

      await assert.rejects(() => loadAccounts(userId), /vault key migration required/i);
      assert.deepEqual(rows, before);
    });

    await t.test("fresh generation", async () => {
      const userId = "production-convex-fresh-generation";
      await saveAccounts(userId, [storedAccount("fresh-ves-account")]);
      assert.equal(rows.get(`accounts-key-proof::${userId}`), proofForSecret(vaultSecret));
      assert.notEqual(rows.get(`accounts-key-proof::${userId}`), proofForSecret(accessSecret));
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("NODE_ENV", previousNodeEnvironment);
    restoreEnvironmentValue("APP_PASSWORD", previousPassword);
    restoreEnvironmentValue("AUTH_SECRET", previousAuthSecret);
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    restoreEnvironmentValue("CONVEX_URL", previousConvexUrl);
    restoreEnvironmentValue("VAULT_ACCESS_SECRET", previousAccessSecret);
  }
});

test("remote public-key recovery journals cannot be returned, reused, or cleared", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const userId = "public-key-recovery";
  const account = storedAccount("public-recovery-account");
  const strongSecret = "proved-independent-remote-vault-secret";
  const legacyRemoteFallback = "usage-local-open-mode-key-v1";
  const recovery = {
    accountId: account.id,
    expectedRefreshToken: account.tokens.refreshToken!,
    tokens: {
      accessToken: "public-recovery-access-canary",
      refreshToken: "public-recovery-refresh-canary",
      expiresAt: account.tokens.expiresAt + 60_000,
    },
    createdAt: 1_700_000_001_000,
  };
  const recoveryKey = `usage:token-recovery:v1:${crypto.createHash("sha256").update(account.id).digest("hex")}::${userId}`;
  const legacyCiphertext = encryptV2Payload(JSON.stringify(recovery), legacyRemoteFallback);

  process.env.VAULT_ENCRYPTION_SECRET = strongSecret;
  process.env.KV_REST_API_URL = "https://redis-public-recovery.test";
  process.env.KV_REST_API_TOKEN = "test-token";

  try {
    for (const [name, operation] of [
      ["load", () => loadTokenRecovery(userId, account.id)],
      ["save", () => saveTokenRecovery(recovery, userId)],
      [
        "clear",
        () =>
          clearTokenRecovery(userId, account.id, {
            record: recovery,
            ciphertext: legacyCiphertext,
          }),
      ],
    ] as const) {
      await t.test(name, async () => {
        const redis = new Map<string, string>();
        redis.set(`usage:vault:v1::${userId}`, encryptV2Payload(JSON.stringify([account]), strongSecret));
        redis.set(`usage:vault:key-proof:v1::${userId}`, proofForSecret(strongSecret));
        redis.set(recoveryKey, legacyCiphertext);
        const before = new Map(redis);
        globalThis.fetch = inMemoryRedisFetch(redis);

        await assert.rejects(operation, /vault key migration required/i);
        assert.deepEqual(redis, before);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("Redis normalizes new encryption secrets and retains exact raw-key compatibility", async () => {
  const originalFetch = globalThis.fetch;
  const previousDataDir = process.env.VAULT_DATA_DIR;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const previousPassword = process.env.APP_PASSWORD;
  const previousAccessSecret = process.env.VAULT_ACCESS_SECRET;
  const previousRedisUrl = process.env.KV_REST_API_URL;
  const previousRedisToken = process.env.KV_REST_API_TOKEN;
  const redis = new Map<string, string>();
  const normalizedSecret = "normalized-redis-vault-key";
  const configuredSecret = `  ${normalizedSecret}\n`;
  const newUserId = "redis-normalized-secret";
  const historicalUserId = "redis-raw-secret";
  const rejectedUserId = "redis-whitespace-only-secret";
  const newAccount = storedAccount("redis-normalized-account");
  const historicalAccount = storedAccount("redis-raw-account");
  const historicalRawSecret = "\tlegacy-redis-key-with-whitespace  ";

  process.env.KV_REST_API_URL = "https://redis-secret-normalization.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  process.env.VAULT_ENCRYPTION_SECRET = configuredSecret;
  delete process.env.APP_PASSWORD;
  delete process.env.VAULT_ACCESS_SECRET;
  globalThis.fetch = async (_input, init) => {
    const command = JSON.parse(String(init?.body)) as string[];
    let result: unknown = null;
    if (command[0] === "GET") {
      result = redis.get(command[1]) ?? null;
    } else if (command[0] === "EVAL") {
      const key = command[3];
      const backupKey = command[4];
      const proofKey = command[5];
      const expected = command[6];
      const next = command[7];
      const proof = command[8];
      const current = redis.get(key);
      const matches =
        (expected === "__HMC_VAULT_MISSING__" && current === undefined) || current === expected;
      const storedProof = redis.get(proofKey);
      if (!matches) result = 0;
      else if (storedProof !== undefined && storedProof !== proof) result = -1;
      else {
        if (storedProof === undefined) redis.set(proofKey, proof);
        redis.set(backupKey, next);
        redis.set(key, next);
        result = 1;
      }
    } else {
      throw new Error(`Unexpected Redis command ${command[0]}`);
    }
    return Response.json({ result });
  };

  try {
    await saveAccounts(newUserId, [newAccount]);
    assert.equal(redis.get(`usage:vault:key-proof:v1::${newUserId}`), proofForSecret(normalizedSecret));
    // Keep the surrounding whitespace in the live environment: the decryptor must try the same
    // normalized value that the new-vault writer used, not only the historical raw variant.
    assert.deepEqual(await loadAccounts(newUserId), [newAccount]);

    redis.set(
      `usage:vault:v1::${historicalUserId}`,
      encryptV2Payload(JSON.stringify([historicalAccount]), historicalRawSecret),
    );
    redis.set(`usage:vault:key-proof:v1::${historicalUserId}`, proofForSecret(historicalRawSecret));
    process.env.VAULT_ENCRYPTION_SECRET = historicalRawSecret;
    assert.deepEqual(await loadAccounts(historicalUserId), [historicalAccount]);

    process.env.VAULT_ENCRYPTION_SECRET = " \t\n ";
    await assert.rejects(
      () => saveAccounts(rejectedUserId, [storedAccount("rejected-whitespace-only")]),
      /requires VAULT_ENCRYPTION_SECRET/i,
    );
    assert.equal(redis.has(`usage:vault:v1::${rejectedUserId}`), false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("VAULT_DATA_DIR", previousDataDir);
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    restoreEnvironmentValue("APP_PASSWORD", previousPassword);
    restoreEnvironmentValue("VAULT_ACCESS_SECRET", previousAccessSecret);
    restoreEnvironmentValue("KV_REST_API_URL", previousRedisUrl);
    restoreEnvironmentValue("KV_REST_API_TOKEN", previousRedisToken);
  }
});

test("Redis CAS retries against a concurrent remote write instead of losing it", async () => {
  const originalFetch = globalThis.fetch;
  const redis = new Map<string, string>();
  const targetUser = "redis-cas-target";
  const templateUser = "redis-cas-template";
  const targetKey = `usage:vault:v1::${targetUser}`;
  const templateKey = `usage:vault:v1::${templateUser}`;
  let injectConflict = false;
  let casAttempts = 0;

  process.env.KV_REST_API_URL = "https://redis.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  globalThis.fetch = async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal, "Redis calls must carry a timeout signal");
    const command = JSON.parse(String(init?.body)) as string[];
    let result: unknown = null;
    if (command[0] === "GET") {
      result = redis.get(command[1]) ?? null;
    } else if (command[0] === "EVAL") {
      const key = command[3];
      const backupKey = command[4];
      const proofKey = command[5];
      const expected = command[6];
      const value = command[7];
      const proof = command[8];
      casAttempts++;
      if (injectConflict && key === targetKey) {
        redis.set(key, redis.get(templateKey)!);
        injectConflict = false;
      }
      const current = redis.get(key);
      const matches =
        (expected === "__HMC_VAULT_MISSING__" && current === undefined) || current === expected;
      const storedProof = redis.get(proofKey);
      if (matches && storedProof !== undefined && storedProof !== proof) {
        result = -1;
      } else if (matches) {
        if (storedProof === undefined) redis.set(proofKey, proof);
        redis.set(backupKey, value);
        redis.set(key, value);
        result = 1;
      } else {
        result = 0;
      }
    } else {
      throw new Error(`Unexpected Redis command ${command[0]}`);
    }
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const base = storedAccount("base");
    const concurrent = storedAccount("concurrent-instance");
    await saveAccounts(templateUser, [base, concurrent]);
    await saveAccounts(targetUser, [base]);
    injectConflict = true;

    await mutateAccounts(targetUser, (accounts) => [...accounts, storedAccount("this-instance")]);

    assert.ok(casAttempts >= 2, "the first CAS should conflict and force a retry");
    assert.deepEqual(
      (await loadAccounts(targetUser)).map((account) => account.id),
      ["base", "concurrent-instance", "this-instance"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("remote mutations keep the key that decrypted the current vault and mirror the committed generation", async () => {
  const originalFetch = globalThis.fetch;
  const redis = new Map<string, string>();
  const userId = "redis-key-sticky";
  const mainKey = `usage:vault:v1::${userId}`;
  const backupKey = `usage:vault:last-good:v1::${userId}`;
  const oldSecret = "historical-remote-key-with-enough-entropy";
  const oldAccount = storedAccount("before-key-change");
  const originalCiphertext = encryptHistoricalPayload(JSON.stringify([oldAccount]), oldSecret);
  redis.set(mainKey, originalCiphertext);

  process.env.KV_REST_API_URL = "https://redis-key-sticky.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  process.env.APP_PASSWORD = oldSecret;
  process.env.VAULT_ENCRYPTION_SECRET = "different-preferred-key-with-enough-entropy";
  globalThis.fetch = async (_input, init) => {
    const command = JSON.parse(String(init?.body)) as string[];
    let result: unknown = null;
    if (command[0] === "GET") {
      result = redis.get(command[1]) ?? null;
    } else if (command[0] === "EVAL") {
      const key = command[3];
      const lastGoodKey = command[4];
      const proofKey = command[5];
      const expected = command[6];
      const next = command[7];
      const proof = command[8];
      const current = redis.get(key);
      const matches =
        (expected === "__HMC_VAULT_MISSING__" && current === undefined) || current === expected;
      const storedProof = redis.get(proofKey);
      if (!matches) result = 0;
      else if (storedProof !== undefined && storedProof !== proof) result = -1;
      else {
        if (storedProof === undefined) redis.set(proofKey, proof);
        redis.set(lastGoodKey, next);
        redis.set(key, next);
        result = 1;
      }
    } else {
      throw new Error(`Unexpected Redis command ${command[0]}`);
    }
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await mutateAccounts(userId, (accounts) => [...accounts, storedAccount("after-key-change")]);
    assert.match(redis.get(mainKey) ?? "", /^v2:/);
    assert.equal(redis.get(backupKey), redis.get(mainKey));

    const stableMain = redis.get(mainKey);
    const stableBackup = redis.get(backupKey);
    redis.set(`usage:vault:key-proof:v1::${userId}`, "proof-from-a-different-instance");
    await assert.rejects(
      () => mutateAccounts(userId, (accounts) => accounts.map((account) => ({ ...account, label: "blocked" }))),
      /encryption key mismatch/i,
    );
    assert.equal(redis.get(mainKey), stableMain);
    assert.equal(redis.get(backupKey), stableBackup);

    // Removing the newly preferred key proves the rewritten generation remained on the historical
    // decrypting key rather than silently migrating to a value another instance may not share.
    redis.set(
      `usage:vault:key-proof:v1::${userId}`,
      crypto.createHmac("sha256", oldSecret).update("how-much-claude:vault-key-proof:v1").digest("hex"),
    );
    delete process.env.VAULT_ENCRYPTION_SECRET;
    assert.deepEqual(
      (await loadAccounts(userId)).map((account) => account.id),
      ["before-key-change", "after-key-change"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env.VAULT_ENCRYPTION_SECRET = TEST_SECRET;
    delete process.env.APP_PASSWORD;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("remote key proofs are tenant-scoped so readable legacy key generations can converge safely", async () => {
  const originalFetch = globalThis.fetch;
  const redis = new Map<string, string>();
  const firstUser = "legacy-key-one";
  const secondUser = "legacy-key-two";
  const firstSecret = "legacy-tenant-key-one-with-enough-entropy";
  const secondSecret = "legacy-tenant-key-two-with-enough-entropy";
  const proofFor = (secret: string) =>
    crypto.createHmac("sha256", secret).update("how-much-claude:vault-key-proof:v1").digest("hex");

  redis.set(
    `usage:vault:v1::${firstUser}`,
    encryptHistoricalPayload(JSON.stringify([storedAccount("first-legacy")]), firstSecret),
  );
  redis.set(
    `usage:vault:v1::${secondUser}`,
    encryptHistoricalPayload(JSON.stringify([storedAccount("second-legacy")]), secondSecret),
  );
  redis.set(`usage:vault:key-proof:v1::${firstUser}`, proofFor(firstSecret));
  redis.set(`usage:vault:key-proof:v1::${secondUser}`, proofFor(secondSecret));
  process.env.KV_REST_API_URL = "https://redis-tenant-proofs.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  process.env.VAULT_ENCRYPTION_SECRET = firstSecret;
  process.env.APP_PASSWORD = secondSecret;
  globalThis.fetch = async (_input, init) => {
    const command = JSON.parse(String(init?.body)) as string[];
    let result: unknown = null;
    if (command[0] === "GET") {
      result = redis.get(command[1]) ?? null;
    } else if (command[0] === "EVAL") {
      const key = command[3];
      const backupKey = command[4];
      const proofKey = command[5];
      const expected = command[6];
      const next = command[7];
      const proof = command[8];
      const current = redis.get(key);
      const matches =
        (expected === "__HMC_VAULT_MISSING__" && current === undefined) || current === expected;
      const storedProof = redis.get(proofKey);
      if (!matches) result = 0;
      else if (storedProof !== undefined && storedProof !== proof) result = -1;
      else {
        if (storedProof === undefined) redis.set(proofKey, proof);
        redis.set(backupKey, next);
        redis.set(key, next);
        result = 1;
      }
    } else {
      throw new Error(`Unexpected Redis command ${command[0]}`);
    }
    return Response.json({ result });
  };

  try {
    await mutateAccounts(firstUser, (accounts) => accounts.map((account) => ({ ...account, label: "first" })));
    await mutateAccounts(secondUser, (accounts) => accounts.map((account) => ({ ...account, label: "second" })));
    assert.equal((await loadAccounts(firstUser))[0].label, "first");
    assert.equal((await loadAccounts(secondUser))[0].label, "second");
    assert.equal(redis.get(`usage:vault:last-good:v1::${firstUser}`), redis.get(`usage:vault:v1::${firstUser}`));
    assert.equal(redis.get(`usage:vault:last-good:v1::${secondUser}`), redis.get(`usage:vault:v1::${secondUser}`));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.VAULT_ENCRYPTION_SECRET = TEST_SECRET;
    delete process.env.APP_PASSWORD;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("remote refresh-token recovery records and tombstones stay on the proved vault key", async () => {
  const originalFetch = globalThis.fetch;
  const redis = new Map<string, string>();
  const userId = "redis-recovery-key-sticky";
  const account = storedAccount("rotating-account");
  const stableSecret = "proved-remote-key-with-enough-entropy";
  const divergentPreferredSecret = "divergent-preferred-key-with-enough-entropy";
  const proof = crypto
    .createHmac("sha256", stableSecret)
    .update("how-much-claude:vault-key-proof:v1")
    .digest("hex");
  const recovery = {
    accountId: account.id,
    expectedRefreshToken: account.tokens.refreshToken!,
    tokens: {
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
      expiresAt: account.tokens.expiresAt + 60_000,
    },
    createdAt: 1_700_000_001_000,
  };

  redis.set(`usage:vault:v1::${userId}`, encryptHistoricalPayload(JSON.stringify([account]), stableSecret));
  redis.set(`usage:vault:key-proof:v1::${userId}`, proof);
  process.env.KV_REST_API_URL = "https://redis-recovery-key-sticky.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  process.env.APP_PASSWORD = stableSecret;
  process.env.VAULT_ENCRYPTION_SECRET = divergentPreferredSecret;
  globalThis.fetch = inMemoryRedisFetch(redis);

  try {
    await saveTokenRecovery(recovery, userId);
    delete process.env.VAULT_ENCRYPTION_SECRET;
    const loaded = await loadTokenRecovery(userId, account.id);
    assert.deepEqual(loaded?.record, recovery);

    process.env.VAULT_ENCRYPTION_SECRET = divergentPreferredSecret;
    assert.equal(await clearTokenRecovery(userId, account.id, loaded!), true);
    delete process.env.VAULT_ENCRYPTION_SECRET;
    assert.equal(await loadTokenRecovery(userId, account.id), null);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.VAULT_ENCRYPTION_SECRET = TEST_SECRET;
    delete process.env.APP_PASSWORD;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("remote recovery journals reject every credential operation under a non-authoritative key", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const previousPassword = process.env.APP_PASSWORD;
  const authoritativeSecret = "authoritative-recovery-tenant-key-with-enough-entropy";
  const journalSecret = "divergent-recovery-journal-key-with-enough-entropy";
  const userId = "redis-recovery-exact-key";
  const account = storedAccount("redis-recovery-exact-key-account");
  const recovery = {
    accountId: account.id,
    expectedRefreshToken: account.tokens.refreshToken!,
    tokens: {
      accessToken: "must-never-return-divergent-access",
      refreshToken: "must-never-return-divergent-refresh",
      expiresAt: account.tokens.expiresAt + 60_000,
    },
    createdAt: 1_700_000_020_000,
  };
  const mainKey = `usage:vault:v1::${userId}`;
  const proofKey = `usage:vault:key-proof:v1::${userId}`;
  const recoveryKey = `usage:token-recovery:v1:${crypto.createHash("sha256").update(account.id).digest("hex")}::${userId}`;
  const divergentCiphertext = encryptV2Payload(JSON.stringify(recovery), journalSecret);

  process.env.KV_REST_API_URL = "https://redis-recovery-exact-key.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  process.env.VAULT_ENCRYPTION_SECRET = journalSecret;
  process.env.APP_PASSWORD = authoritativeSecret;

  try {
    for (const [name, operation] of [
      ["load", () => loadTokenRecovery(userId, account.id)],
      ["save", () => saveTokenRecovery(recovery, userId)],
      [
        "clear",
        () =>
          clearTokenRecovery(userId, account.id, {
            record: recovery,
            ciphertext: divergentCiphertext,
          }),
      ],
    ] as const) {
      await t.test(name, async () => {
        const redis = new Map<string, string>([
          [mainKey, encryptV2Payload(JSON.stringify([account]), authoritativeSecret)],
          [proofKey, proofForSecret(authoritativeSecret)],
          [recoveryKey, divergentCiphertext],
        ]);
        const before = new Map(redis);
        globalThis.fetch = inMemoryRedisFetch(redis);

        await assert.rejects(operation, /wrong encryption secret|vault encryption key mismatch/i);
        assert.deepEqual(redis, before);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    restoreEnvironmentValue("APP_PASSWORD", previousPassword);
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("remote recovery operations cannot initialize a missing tenant proof", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const secret = "orphan-recovery-record-key-with-enough-entropy";
  const userId = "redis-orphan-recovery-proof";
  const account = storedAccount("redis-orphan-recovery-proof-account");
  const recovery = {
    accountId: account.id,
    expectedRefreshToken: account.tokens.refreshToken!,
    tokens: {
      accessToken: "orphan-recovery-access",
      refreshToken: "orphan-recovery-refresh",
      expiresAt: account.tokens.expiresAt + 60_000,
    },
    createdAt: 1_700_000_020_500,
  };
  const ciphertext = encryptV2Payload(JSON.stringify(recovery), secret);
  const recoveryKey = `usage:token-recovery:v1:${crypto.createHash("sha256").update(account.id).digest("hex")}::${userId}`;

  process.env.KV_REST_API_URL = "https://redis-orphan-recovery-proof.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  process.env.VAULT_ENCRYPTION_SECRET = secret;
  try {
    for (const [name, operation] of [
      ["load", () => loadTokenRecovery(userId, account.id)],
      ["save", () => saveTokenRecovery(recovery, userId)],
      [
        "clear",
        () => clearTokenRecovery(userId, account.id, { record: recovery, ciphertext }),
      ],
    ] as const) {
      await t.test(name, async () => {
        // The credential row exists, but no main, backup, or authoritative proof may be bootstrapped
        // from it. Auxiliary operations are proof consumers only.
        const redis = new Map<string, string>([[recoveryKey, ciphertext]]);
        const before = new Map(redis);
        globalThis.fetch = inMemoryRedisFetch(redis);
        await assert.rejects(operation, /vault encryption key mismatch/i);
        assert.deepEqual(redis, before);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("guarded Redis recovery load and clear fail if the proof changes after authoritative preflight", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const secret = "redis-recovery-preflight-key-with-enough-entropy";
  const divergentSecret = "redis-recovery-post-preflight-key-with-enough-entropy";
  const userId = "redis-recovery-preflight-race";
  const account = storedAccount("redis-recovery-preflight-race-account");
  const recovery = {
    accountId: account.id,
    expectedRefreshToken: account.tokens.refreshToken!,
    tokens: {
      accessToken: "must-not-return-after-proof-race",
      refreshToken: "must-not-clear-after-proof-race",
      expiresAt: account.tokens.expiresAt + 60_000,
    },
    createdAt: 1_700_000_020_750,
  };
  const mainKey = `usage:vault:v1::${userId}`;
  const proofKey = `usage:vault:key-proof:v1::${userId}`;
  const recoveryKey = `usage:token-recovery:v1:${crypto.createHash("sha256").update(account.id).digest("hex")}::${userId}`;
  const ciphertext = encryptV2Payload(JSON.stringify(recovery), secret);

  process.env.KV_REST_API_URL = "https://redis-recovery-preflight-race.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  process.env.VAULT_ENCRYPTION_SECRET = secret;
  try {
    for (const [name, operation] of [
      ["load", () => loadTokenRecovery(userId, account.id)],
      [
        "clear",
        () => clearTokenRecovery(userId, account.id, { record: recovery, ciphertext }),
      ],
    ] as const) {
      await t.test(name, async () => {
        const redis = new Map<string, string>([
          [mainKey, encryptV2Payload(JSON.stringify([account]), secret)],
          [proofKey, proofForSecret(secret)],
          [recoveryKey, ciphertext],
        ]);
        let proofReads = 0;
        globalThis.fetch = async (_input, init) => {
          const command = JSON.parse(String(init?.body)) as string[];
          let result: unknown;
          if (command[0] === "GET") {
            result = redis.get(command[1]) ?? null;
            if (command[1] === proofKey && ++proofReads === 2) {
              redis.set(proofKey, proofForSecret(divergentSecret));
            }
          } else if (command[0] === "EVAL" && command[2] === "2") {
            assert.equal(command[3], recoveryKey);
            assert.equal(command[4], proofKey);
            const storedProof = redis.get(command[4]);
            const suppliedProof = command.at(-1)!;
            if (storedProof !== suppliedProof) result = -1;
            else if (command.length === 6) result = redis.get(command[3]) ?? null;
            else {
              const current = redis.get(command[3]);
              const matches = current === command[5];
              if (matches) redis.set(command[3], command[6]);
              result = matches ? 1 : 0;
            }
          } else {
            throw new Error(`Unexpected Redis command ${command[0]} ${command[2] ?? ""}`);
          }
          return Response.json({ result });
        };

        await assert.rejects(operation, /vault encryption key mismatch/i);
        assert.equal(proofReads, 2);
        assert.equal(redis.get(recoveryKey), ciphertext);
        assert.equal(redis.get(proofKey), proofForSecret(divergentSecret));
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("Redis recovery CAS fails without writing when the proof disappears after guarded read", async () => {
  const originalFetch = globalThis.fetch;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const secret = "redis-deleted-recovery-proof-key-with-enough-entropy";
  const userId = "redis-deleted-recovery-proof";
  const account = storedAccount("redis-deleted-recovery-proof-account");
  const recovery = {
    accountId: account.id,
    expectedRefreshToken: account.tokens.refreshToken!,
    tokens: {
      accessToken: "must-not-write-with-deleted-proof",
      refreshToken: "must-not-write-with-deleted-proof-refresh",
      expiresAt: account.tokens.expiresAt + 60_000,
    },
    createdAt: 1_700_000_020_875,
  };
  const mainKey = `usage:vault:v1::${userId}`;
  const proofKey = `usage:vault:key-proof:v1::${userId}`;
  const recoveryKey = `usage:token-recovery:v1:${crypto.createHash("sha256").update(account.id).digest("hex")}::${userId}`;
  const mainRaw = encryptV2Payload(JSON.stringify([account]), secret);
  const redis = new Map<string, string>([
    [mainKey, mainRaw],
    [proofKey, proofForSecret(secret)],
  ]);

  process.env.KV_REST_API_URL = "https://redis-deleted-recovery-proof.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  process.env.VAULT_ENCRYPTION_SECRET = secret;
  globalThis.fetch = inMemoryRedisFetch(redis, {
    afterAuxiliaryRead: () => redis.delete(proofKey),
  });
  try {
    await assert.rejects(() => saveTokenRecovery(recovery, userId), /vault encryption key mismatch/i);
    assert.equal(redis.get(mainKey), mainRaw);
    assert.equal(redis.has(proofKey), false);
    assert.equal(redis.has(recoveryKey), false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("Redis recovery CAS atomically fences an authoritative proof that changes after the read", async () => {
  const originalFetch = globalThis.fetch;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const previousPassword = process.env.APP_PASSWORD;
  const authoritativeSecret = "redis-atomic-recovery-proof-key-with-enough-entropy";
  const divergentSecret = "redis-raced-recovery-proof-key-with-enough-entropy";
  const userId = "redis-recovery-proof-race";
  const account = storedAccount("redis-recovery-proof-race-account");
  const recovery = {
    accountId: account.id,
    expectedRefreshToken: account.tokens.refreshToken!,
    tokens: {
      accessToken: "must-not-win-raced-recovery-access",
      refreshToken: "must-not-win-raced-recovery-refresh",
      expiresAt: account.tokens.expiresAt + 60_000,
    },
    createdAt: 1_700_000_021_000,
  };
  const mainKey = `usage:vault:v1::${userId}`;
  const proofKey = `usage:vault:key-proof:v1::${userId}`;
  const recoveryKey = `usage:token-recovery:v1:${crypto.createHash("sha256").update(account.id).digest("hex")}::${userId}`;
  const redis = new Map<string, string>([
    [mainKey, encryptV2Payload(JSON.stringify([account]), authoritativeSecret)],
    [proofKey, proofForSecret(authoritativeSecret)],
  ]);
  let proofRaced = false;

  process.env.KV_REST_API_URL = "https://redis-recovery-proof-race.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  process.env.VAULT_ENCRYPTION_SECRET = authoritativeSecret;
  delete process.env.APP_PASSWORD;
  globalThis.fetch = async (_input, init) => {
    const command = JSON.parse(String(init?.body)) as string[];
    let result: unknown;
    if (command[0] === "GET") {
      result = redis.get(command[1]) ?? null;
      if (command[1] === recoveryKey) {
        redis.set(proofKey, proofForSecret(divergentSecret));
        proofRaced = true;
      }
    } else if (command[0] === "EVAL" && command[2] === "1") {
      const current = redis.get(command[3]);
      const matches =
        (command[4] === "__HMC_VAULT_MISSING__" && current === undefined) || current === command[4];
      if (matches) redis.set(command[3], command[5]);
      result = matches ? 1 : 0;
    } else if (command[0] === "EVAL" && command[2] === "2") {
      const storedProof = redis.get(command[4]);
      const suppliedProof = command.at(-1)!;
      if (command.length === 6) {
        result = storedProof === suppliedProof ? (redis.get(command[3]) ?? null) : -1;
        redis.set(proofKey, proofForSecret(divergentSecret));
        proofRaced = true;
      } else if (storedProof !== suppliedProof) {
        result = -1;
      } else {
        const current = redis.get(command[3]);
        const matches =
          (command[5] === "__HMC_VAULT_MISSING__" && current === undefined) ||
          current === command[5];
        if (matches) redis.set(command[3], command[6]);
        result = matches ? 1 : 0;
      }
    } else {
      throw new Error(`Unexpected Redis command ${command[0]} ${command[2] ?? ""}`);
    }
    return Response.json({ result });
  };

  try {
    await assert.rejects(() => saveTokenRecovery(recovery, userId), /vault encryption key mismatch/i);
    assert.equal(proofRaced, true);
    assert.equal(redis.has(recoveryKey), false);
    assert.equal(redis.get(proofKey), proofForSecret(divergentSecret));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
    restoreEnvironmentValue("APP_PASSWORD", previousPassword);
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

test("Convex recovery reads and writes carry the exact tenant proof", async () => {
  const originalFetch = globalThis.fetch;
  const previousConvexUrl = process.env.CONVEX_URL;
  const previousAccessSecret = process.env.VAULT_ACCESS_SECRET;
  const previousEncryptionSecret = process.env.VAULT_ENCRYPTION_SECRET;
  const authoritativeSecret = "convex-recovery-proof-key-with-enough-entropy";
  const userId = "convex-recovery-proof-bound";
  const account = storedAccount("convex-recovery-proof-bound-account");
  const recovery = {
    accountId: account.id,
    expectedRefreshToken: account.tokens.refreshToken!,
    tokens: {
      accessToken: "convex-proof-bound-access",
      refreshToken: "convex-proof-bound-refresh",
      expiresAt: account.tokens.expiresAt + 60_000,
    },
    createdAt: 1_700_000_022_000,
  };
  const mainKey = `accounts::${userId}`;
  const proofKey = `accounts-key-proof::${userId}`;
  const recoveryKey = `token-recovery:${crypto.createHash("sha256").update(account.id).digest("hex")}::${userId}`;
  const rows = new Map<string, string>([
    [mainKey, encryptV2Payload(JSON.stringify([account]), authoritativeSecret)],
    [proofKey, proofForSecret(authoritativeSecret)],
    [recoveryKey, encryptV2Payload(JSON.stringify(recovery), authoritativeSecret)],
  ]);
  let guardedReads = 0;
  let guardedWrites = 0;

  process.env.CONVEX_URL = "https://recovery-proof-bound.convex.cloud";
  process.env.VAULT_ACCESS_SECRET = "convex-backend-access-secret";
  process.env.VAULT_ENCRYPTION_SECRET = authoritativeSecret;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      path: string;
      args: [Record<string, unknown>];
    };
    const args = body.args[0];
    if (body.path === "vault:get") {
      return Response.json({ status: "success", value: rows.get(String(args.key)) ?? null });
    }
    if (body.path === "vault:getAuxiliary") {
      assert.equal(args.key, recoveryKey);
      assert.equal(args.proofKey, proofKey);
      assert.equal(args.keyProof, proofForSecret(authoritativeSecret));
      guardedReads += 1;
      return Response.json({ status: "success", value: rows.get(recoveryKey) ?? null });
    }
    if (body.path === "vault:compareAndSetAuxiliary") {
      assert.equal(args.key, recoveryKey);
      assert.equal(args.proofKey, proofKey);
      assert.equal(args.keyProof, proofForSecret(authoritativeSecret));
      guardedWrites += 1;
      const expected = args.expected === null ? null : String(args.expected);
      if ((rows.get(recoveryKey) ?? null) !== expected) {
        return Response.json({ status: "success", value: false });
      }
      rows.set(recoveryKey, String(args.data));
      return Response.json({ status: "success", value: true });
    }
    throw new Error(`Unexpected Convex function ${body.path}`);
  };

  try {
    const loaded = await loadTokenRecovery(userId, account.id);
    assert.deepEqual(loaded?.record, recovery);
    assert.equal(await clearTokenRecovery(userId, account.id, loaded!), true);
    assert.equal(await loadTokenRecovery(userId, account.id), null);
    await saveTokenRecovery(recovery, userId);
    assert.deepEqual((await loadTokenRecovery(userId, account.id))?.record, recovery);
    assert.equal(guardedReads, 4);
    assert.equal(guardedWrites, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentValue("CONVEX_URL", previousConvexUrl);
    restoreEnvironmentValue("VAULT_ACCESS_SECRET", previousAccessSecret);
    restoreEnvironmentValue("VAULT_ENCRYPTION_SECRET", previousEncryptionSecret);
  }
});

test("Convex recovery handlers require matching existing tenant proof before any ciphertext write", async () => {
  const source = await fs.readFile(path.join(projectRoot, "convex", "vault.ts"), "utf8");
  const guardedReadStart = source.indexOf("export const getAuxiliary = query(");
  const guardedWriteStart = source.indexOf("export const compareAndSetAuxiliary = mutation(");
  const primaryWriteStart = source.indexOf("export const compareAndSet = mutation(");
  assert.ok(guardedReadStart >= 0 && guardedWriteStart > guardedReadStart);
  assert.ok(primaryWriteStart > guardedWriteStart);

  const pairingGuard = source.slice(
    source.indexOf("function assertRecoveryProofKey"),
    source.indexOf("async function assertLegacyWriterNotFenced"),
  );
  assert.match(pairingGuard, /proofKeyForRecoveryKey\(key\)/u);
  assert.match(pairingGuard, /proofKey !== expectedProofKey/u);

  for (const handler of [
    source.slice(guardedReadStart, guardedWriteStart),
    source.slice(guardedWriteStart, primaryWriteStart),
  ]) {
    assert.match(handler, /proofKey:\s*v\.string\(\)/u);
    assert.match(handler, /keyProof:\s*v\.string\(\)/u);
    assert.match(handler, /assertRecoveryProofKey\(key, proofKey\)/u);
    assert.match(handler, /!proof\s*\|\|\s*proof\.data\s*!==\s*keyProof/u);
  }

  const guardedWrite = source.slice(guardedWriteStart, primaryWriteStart);
  const exactProofCheck = guardedWrite.indexOf("!proof || proof.data !== keyProof");
  const ciphertextPatch = guardedWrite.indexOf("ctx.db.patch");
  const ciphertextInsert = guardedWrite.indexOf("ctx.db.insert");
  assert.ok(exactProofCheck >= 0);
  assert.ok(ciphertextPatch > exactProofCheck);
  assert.ok(ciphertextInsert > exactProofCheck);
  assert.doesNotMatch(
    guardedWrite.slice(0, Math.min(ciphertextPatch, ciphertextInsert)),
    /insert\("vault",\s*\{\s*key:\s*proofKey/u,
  );
});

test("Convex generic get refuses recovery ciphertext while retaining ordinary vault reads", async () => {
  const source = await fs.readFile(path.join(projectRoot, "convex", "vault.ts"), "utf8");
  const genericGetStart = source.indexOf("export const get = query(");
  const guardedGetStart = source.indexOf("export const getAuxiliary = query(");
  assert.ok(genericGetStart >= 0 && guardedGetStart > genericGetStart);
  const genericGet = source.slice(genericGetStart, guardedGetStart);
  assert.match(genericGet, /proofKeyForRecoveryKey\(key\)\s*!==\s*null/u);
  assert.match(genericGet, /recovery.*guarded query/is);
  assert.match(genericGet, /q\.eq\("key", key\)/u);
  assert.doesNotMatch(genericGet, /isPrimaryAccountKey\(key\)|isAccountBackupKey\(key\)|isAccountProofKey\(key\)/u);
});

test("Convex primary mutations reject proof, backup, recovery, and other non-primary keys before writes", async () => {
  const source = await fs.readFile(path.join(projectRoot, "convex", "vault.ts"), "utf8");
  const casStart = source.indexOf("export const compareAndSet = mutation(");
  const restoreStart = source.indexOf("export const restoreBackup = mutation(");
  const restoreEnd = source.indexOf("// Primary account-vault keys only.");
  assert.ok(casStart >= 0 && restoreStart > casStart && restoreEnd > restoreStart);

  const cas = source.slice(casStart, restoreStart);
  const restore = source.slice(restoreStart, restoreEnd);
  for (const handler of [cas, restore]) {
    const suffix = handler.indexOf("const suffix = accountKeySuffix(key)");
    const reject = handler.indexOf("suffix === null");
    const firstRowRead = handler.indexOf("rowForKey(ctx, key)");
    const firstWrite = Math.min(
      ...[handler.indexOf("ctx.db.patch"), handler.indexOf("ctx.db.insert"), handler.indexOf("upsertData")]
        .filter((index) => index >= 0),
    );
    assert.ok(suffix >= 0 && reject > suffix);
    assert.ok(firstRowRead > reject);
    assert.ok(firstWrite > reject);
  }
  assert.match(cas, /backupKey !== undefined && backupKey !== `\$\{ACCOUNT_BACKUP_KEY\}\$\{suffix\}`/u);
  assert.match(restore, /backupKey !== `\$\{ACCOUNT_BACKUP_KEY\}\$\{suffix\}`/u);
});

test("Convex legacy generic recovery set honors the default tenant global proof only", async () => {
  const source = await fs.readFile(path.join(projectRoot, "convex", "vault.ts"), "utf8");
  const setStart = source.indexOf("export const set = mutation(");
  const auxiliaryStart = source.indexOf("export const compareAndSetAuxiliary = mutation(");
  const setHandler = source.slice(setStart, auxiliaryStart);
  assert.match(
    setHandler,
    /assertLegacyWriterNotFenced\([\s\S]*recoveryProofKey\s*===\s*ACCOUNT_PROOF_KEY[\s\S]*\)/u,
  );
});

test("Convex backend authentication rejects short configured access secrets", async () => {
  for (const [file, endMarker] of [
    ["vault.ts", "async function rowForKey"],
    ["usageCache.ts", "const REFRESH_LOCK_MS"],
    ["notify.ts", "// Defaults mirror"],
    ["pairings.ts", "const PAIRING_CODE_PATTERN"],
  ] as const) {
    const source = await fs.readFile(path.join(projectRoot, "convex", file), "utf8");
    const auth = source.slice(source.indexOf("function assertSecret"), source.indexOf(endMarker));
    assert.match(auth, /process\.env\.VAULT_ACCESS_SECRET\?\.trim\(\)/u, file);
    assert.match(auth, /expected\.length\s*<\s*32/u, file);
    assert.match(auth, /const supplied = secret\.trim\(\)/u, file);
    assert.match(auth, /supplied !== expected/u, file);
  }
});

test("a stale recovery owner cannot clear a newer refresh-token generation", async () => {
  const userId = "fenced-recovery-clear";
  const account = storedAccount("fenced-recovery-account");
  await saveAccounts(userId, [account]);
  const firstRecord = {
    accountId: account.id,
    expectedRefreshToken: account.tokens.refreshToken!,
    tokens: {
      accessToken: "fenced-access-r1",
      refreshToken: "fenced-refresh-r1",
      expiresAt: account.tokens.expiresAt + 60_000,
    },
    createdAt: 1_700_000_010_000,
  };
  const secondRecord = {
    accountId: account.id,
    expectedRefreshToken: firstRecord.tokens.refreshToken,
    tokens: {
      accessToken: "fenced-access-r2",
      refreshToken: "fenced-refresh-r2",
      expiresAt: firstRecord.tokens.expiresAt + 60_000,
    },
    createdAt: firstRecord.createdAt + 1,
  };

  const first = await saveTokenRecovery(firstRecord, userId);
  const second = await saveTokenRecovery(secondRecord, userId);
  assert.equal(await clearTokenRecovery(userId, account.id, first), false);
  assert.deepEqual((await loadTokenRecovery(userId, account.id))?.record, secondRecord);
  assert.equal(await clearTokenRecovery(userId, account.id, second), true);
  assert.equal(await loadTokenRecovery(userId, account.id), null);
});

test("a new Redis vault refuses an unproved per-instance bootstrap key", async () => {
  const originalFetch = globalThis.fetch;
  const redis = new Map<string, string>();
  const previousSecret = process.env.VAULT_ENCRYPTION_SECRET;
  process.env.KV_REST_API_URL = "https://redis-bootstrap-key.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  delete process.env.VAULT_ENCRYPTION_SECRET;
  delete process.env.APP_PASSWORD;
  globalThis.fetch = async (_input, init) => {
    const command = JSON.parse(String(init?.body)) as string[];
    if (command[0] !== "GET") throw new Error(`Unexpected Redis command ${command[0]}`);
    return new Response(JSON.stringify({ result: redis.get(command[1]) ?? null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await assert.rejects(
      () => saveAccounts("new-redis-tenant", [storedAccount("new-redis-account")]),
      /requires VAULT_ENCRYPTION_SECRET/i,
    );
    assert.equal(redis.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousSecret === undefined) delete process.env.VAULT_ENCRYPTION_SECRET;
    else process.env.VAULT_ENCRYPTION_SECRET = previousSecret;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});
