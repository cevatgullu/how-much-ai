import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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

test("validation rejects ignored Next env files and project npm configuration", async () => {
  const { assertSafeProjectConfiguration } = (await import(moduleUrl)) as {
    assertSafeProjectConfiguration: (projectRoot: string) => void;
  };
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-validation-root-"));

  try {
    const envPath = path.join(fixture, ".env.production.local");
    await writeFile(envPath, "NEXT_PUBLIC_CANARY=must-not-load\n", "utf8");
    assert.throws(
      () => assertSafeProjectConfiguration(fixture),
      /forbidden-project-configuration/u,
    );
    await rm(envPath);

    await writeFile(
      path.join(fixture, ".npmrc"),
      "node-options=--require=attacker-preload.js\n",
      "utf8",
    );
    assert.throws(
      () => assertSafeProjectConfiguration(fixture),
      /forbidden-project-configuration/u,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test(
  "actual npm configuration is isolated from a hostile source profile",
  { skip: process.platform !== "win32" },
  async () => {
    const {
      createIsolatedNpmEnvironment,
      verifyNpmConfiguration,
    } = (await import(moduleUrl)) as {
      createIsolatedNpmEnvironment: (
        sourceEnvironment: NodeJS.ProcessEnv,
      ) => {
        env: Record<string, string>;
        root: string;
        expected: {
          userConfig: string;
          globalConfig: string;
          cache: string;
        };
        cleanup: () => void;
      };
      verifyNpmConfiguration: (
        npmPath: string,
        env: Record<string, string>,
        expected: {
          userConfig: string;
          globalConfig: string;
          cache: string;
        },
        projectRoot: string,
      ) => void;
    };
    const attackerProfile = await mkdtemp(
      path.join(os.tmpdir(), "hma-hostile-profile-"),
    );
    await writeFile(
      path.join(attackerProfile, ".npmrc"),
      [
        "node-options=--require=attacker-preload.js",
        "script-shell=C:\\attacker\\shell.cmd",
        "proxy=http://attacker.invalid",
      ].join("\n"),
      "utf8",
    );
    const npmPath = path.join(path.dirname(process.execPath), "npm.cmd");
    const isolated = createIsolatedNpmEnvironment({
      ...process.env,
      USERPROFILE: attackerProfile,
      APPDATA: path.join(attackerProfile, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(attackerProfile, "AppData", "Local"),
      NODE_OPTIONS: "--require=attacker-preload.js",
      NPM_CONFIG_SCRIPT_SHELL: "C:\\attacker\\shell.cmd",
    });

    try {
      assert.notEqual(
        isolated.env.USERPROFILE.toLowerCase(),
        attackerProfile.toLowerCase(),
      );
      assert.equal(
        Object.values(isolated.env).some((value) =>
          value.includes("attacker-preload"),
        ),
        false,
      );
      verifyNpmConfiguration(
        npmPath,
        isolated.env,
        isolated.expected,
        process.cwd(),
      );
    } finally {
      isolated.cleanup();
      await rm(attackerProfile, { recursive: true, force: true });
    }
  },
);

test(
  "validation stops before a later command can consume project configuration created by an earlier command",
  { skip: process.platform !== "win32" },
  async () => {
    const { runSanitizedValidation } = (await import(moduleUrl)) as {
      runSanitizedValidation: (options: {
        npmPath: string;
        projectRoot: string;
      }) => void;
    };
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-validation-sequence-"),
    );
    const packageJson = {
      private: true,
      scripts: {
        test:
          "node -e \"require('node:fs').writeFileSync('.env.production.local','NEXT_PUBLIC_CANARY=must-not-load\\\\n')\"",
        typecheck: "node -e \"process.exit(0)\"",
        build: "node -e \"process.exit(0)\"",
      },
    };
    await writeFile(
      path.join(fixture, "package.json"),
      `${JSON.stringify(packageJson)}\n`,
      "utf8",
    );

    try {
      assert.throws(
        () =>
          runSanitizedValidation({
            npmPath: path.join(path.dirname(process.execPath), "npm.cmd"),
            projectRoot: fixture,
          }),
        /forbidden-project-configuration/u,
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "validation rechecks the isolated npm configuration after every command",
  { skip: process.platform !== "win32" },
  async () => {
    const { runSanitizedValidation } = (await import(moduleUrl)) as {
      runSanitizedValidation: (options: {
        npmPath: string;
        projectRoot: string;
      }) => void;
    };
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-validation-npm-sequence-"),
    );
    const packageJson = {
      private: true,
      scripts: {
        test:
          "node -e \"require('node:fs').writeFileSync(process.env.NPM_CONFIG_USERCONFIG,'script-shell=C:\\\\\\\\unreviewed\\\\\\\\shell.cmd\\\\n')\"",
        typecheck: "node -e \"process.exit(0)\"",
        build: "node -e \"process.exit(0)\"",
      },
    };
    await writeFile(
      path.join(fixture, "package.json"),
      `${JSON.stringify(packageJson)}\n`,
      "utf8",
    );

    try {
      assert.throws(
        () =>
          runSanitizedValidation({
            npmPath: path.join(path.dirname(process.execPath), "npm.cmd"),
            projectRoot: fixture,
          }),
        /unsafe-npm-configuration/u,
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
