import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const instrumentationUrl = pathToFileURL(path.join(process.cwd(), "instrumentation.ts")).href;
const resolverUrl = pathToFileURL(path.join(process.cwd(), "lib", "providers", "_resolve-ts.mjs")).href;

const childSource = String.raw`
const [mode, instrumentationUrl] = process.argv.slice(2);
let upstreamCalls = 0;
const syntheticFetch = Object.assign(async () => {
  upstreamCalls += 1;
  const error = new Error("Synthetic upstream Fetch must not be called");
  error.name = "UnexpectedUpstreamFetch";
  throw error;
}, {
  __hmaOriginalFetch: () => undefined,
  _nextOriginalFetch: () => undefined,
});
globalThis.fetch = syntheticFetch;

const { register } = await import(instrumentationUrl);
if (mode === "block") {
  await register();
  try {
    await globalThis.fetch("https://attacker.invalid/");
    process.stdout.write(JSON.stringify({ blocked: false, name: "none" }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      blocked:
        error?.name === "OutboundPolicyError" &&
        upstreamCalls === 0 &&
        !Object.hasOwn(globalThis.fetch, "__hmaOriginalFetch") &&
        !Object.hasOwn(globalThis.fetch, "_nextOriginalFetch"),
      name: error?.name ?? "unknown",
    }));
  }
} else {
  try {
    await register();
    process.stdout.write(JSON.stringify({
      rejected: false,
      name: "none",
      upstreamCalls,
      fetchUnchanged: globalThis.fetch === syntheticFetch,
    }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      rejected: true,
      name: error?.name ?? "unknown",
      upstreamCalls,
      fetchUnchanged: globalThis.fetch === syntheticFetch,
    }));
  }
}
`;

function childEnvironment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const preservedNames = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "WINDIR",
    "windir",
  ] as const;
  const env = Object.fromEntries(
    preservedNames.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]),
  ) as NodeJS.ProcessEnv;
  Object.assign(env, {
    NEXT_RUNTIME: "nodejs",
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
    VAULT_DATA_DIR: path.resolve(".strict-local-child-test-vault"),
    NEXT_TELEMETRY_DISABLED: "1",
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

async function runChild(
  mode: "block" | "invalid",
  overrides: Record<string, string | undefined> = {},
): Promise<unknown> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hma-outbound-installation-"));
  const childFile = path.join(tempDir, "child.mjs");
  try {
    await writeFile(childFile, childSource, "utf8");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--import",
        resolverUrl,
        childFile,
        mode,
        instrumentationUrl,
      ],
      {
        cwd: process.cwd(),
        env: childEnvironment(overrides),
        timeout: 10_000,
        windowsHide: true,
      },
    );
    assert.equal(stderr, "");
    return JSON.parse(stdout);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("instrumentation installs the strict Fetch policy in a fresh Node process", async () => {
  assert.deepEqual(await runChild("block"), { blocked: true, name: "OutboundPolicyError" });
});

test("instrumentation rejects invalid strict environments before any Fetch call", async () => {
  for (const overrides of [
    { HTTPS_PROXY: "not-a-valid-proxy" },
    { AUTH_SECRET: undefined },
  ]) {
    assert.deepEqual(
      await runChild("invalid", overrides),
      { rejected: true, name: "Error", upstreamCalls: 0, fetchUnchanged: true },
    );
  }
});
