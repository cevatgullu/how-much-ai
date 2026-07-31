import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const moduleUrl = pathToFileURL(
  path.resolve("scripts/audit/run-sanitized-validation.mjs"),
).href;

test("sanitized build environment is an exact case-insensitive allowlist", async () => {
  const { createSanitizedBuildEnvironment } = (await import(moduleUrl)) as {
    createSanitizedBuildEnvironment: (
      source: NodeJS.ProcessEnv,
    ) => Record<string, string>;
  };
  const canaries = {
    NEXT_PUBLIC_REMOTE_URL: "CANARY_PUBLIC",
    ANTHROPIC_API_KEY: "CANARY_PROVIDER",
    HtTp_PrOxY: "CANARY_PROXY",
    NODE_OPTIONS: "--require CANARY_PRELOAD",
    node_path: "CANARY_NODE_PATH",
    APP_PASSWORD: "CANARY_PASSWORD",
    AUTH_SECRET: "CANARY_AUTH",
    VAULT_ENCRYPTION_SECRET: "CANARY_VAULT",
    SSL_CERT_FILE: "CANARY_TLS",
  };
  const source: NodeJS.ProcessEnv = {
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    Path: "C:\\Program Files\\nodejs",
    TEMP: "C:\\Temp",
    tmp: "C:\\Temp",
    LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local",
    APPDATA: "C:\\Users\\Example\\AppData\\Roaming",
    USERPROFILE: "C:\\Users\\Example",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\Example",
    NUMBER_OF_PROCESSORS: "8",
    PROCESSOR_ARCHITECTURE: "AMD64",
    PROCESSOR_IDENTIFIER: "Synthetic CPU",
    OS: "Windows_NT",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ...canaries,
  };

  const result = createSanitizedBuildEnvironment(source);
  const lowerKeys = Object.keys(result).map((key) => key.toLowerCase());

  for (const forbidden of Object.keys(canaries)) {
    assert.equal(lowerKeys.includes(forbidden.toLowerCase()), false);
  }
  assert.equal(result.SystemRoot, "C:\\Windows");
  assert.equal(result.WINDIR, "C:\\Windows");
  assert.equal(result.PATH, "C:\\Program Files\\nodejs");
  assert.equal(result.TEMP, "C:\\Temp");
  assert.equal(result.TMP, "C:\\Temp");
  assert.equal(result.NEXT_TELEMETRY_DISABLED, "1");
  assert.equal(result.NODE_ENV, "production");
  assert.equal(result.NPM_CONFIG_AUDIT, "false");
  assert.equal(result.NPM_CONFIG_FUND, "false");

  const expectedKeys = [
    "APPDATA",
    "ComSpec",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "NEXT_TELEMETRY_DISABLED",
    "NODE_ENV",
    "NPM_CONFIG_AUDIT",
    "NPM_CONFIG_FUND",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATHEXT",
    "PATH",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ].sort();
  assert.deepEqual(Object.keys(result).sort(), expectedKeys);
});

test("a child receives no forbidden canary and reports booleans only", async () => {
  const { createSanitizedBuildEnvironment } = (await import(moduleUrl)) as {
    createSanitizedBuildEnvironment: (
      source: NodeJS.ProcessEnv,
    ) => Record<string, string>;
  };
  const forbiddenCanaries = [
    "CANARY_PUBLIC_CHILD",
    "CANARY_PROXY_CHILD",
    "CANARY_SECRET_CHILD",
  ];
  const env = createSanitizedBuildEnvironment({
    ...process.env,
    NEXT_PUBLIC_CANARY: forbiddenCanaries[0],
    hTtPs_PrOxY: forbiddenCanaries[1],
    AUTH_SECRET: forbiddenCanaries[2],
  });
  const script = [
    "const keys=Object.keys(process.env).map(k=>k.toLowerCase());",
    "const forbidden=keys.some(k=>k.startsWith('next_public_')||k.includes('proxy')||k==='auth_secret'||k==='node_options'||k==='node_path');",
    "process.stdout.write(JSON.stringify({forbidden,production:process.env.NODE_ENV==='production'}));",
  ].join("");
  const result = await execFileAsync(process.execPath, ["-e", script], {
    env,
    encoding: "utf8",
    windowsHide: true,
  });

  assert.deepEqual(JSON.parse(result.stdout), {
    forbidden: false,
    production: true,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  for (const canary of forbiddenCanaries) {
    assert.equal(combined.includes(canary), false);
  }
});

test("case-fold duplicate environment keys fail closed", async () => {
  const { createSanitizedBuildEnvironment } = (await import(moduleUrl)) as {
    createSanitizedBuildEnvironment: (
      source: NodeJS.ProcessEnv,
    ) => Record<string, string>;
  };

  assert.throws(
    () =>
      createSanitizedBuildEnvironment({
        PATH: "C:\\Reviewed",
        Path: "C:\\Different",
      }),
    /ambiguous-environment/u,
  );
});
