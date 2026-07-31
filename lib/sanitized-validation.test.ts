import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const modulePath = path.resolve(
  "scripts/audit/run-sanitized-validation.mjs",
);
const moduleUrl = pathToFileURL(
  modulePath,
).href;

function installedNpmPaths() {
  const npmDirectory = path.dirname(process.execPath);
  return {
    npmPath: path.join(npmDirectory, "npm.cmd"),
    npmRoot: path.join(npmDirectory, "node_modules", "npm"),
    npmCliPath: path.join(
      npmDirectory,
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  };
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function npmTreeSha256(npmRoot: string, npmPath: string): string {
  const root = path.resolve(npmRoot);
  assert.equal(realpathSync(root).toLowerCase(), root.toLowerCase());
  const npmCommand = path.resolve(npmPath);
  const npmCommandInfo = lstatSync(npmCommand);
  assert.equal(npmCommandInfo.isFile(), true);
  assert.equal(npmCommandInfo.isSymbolicLink(), false);
  assert.equal(npmCommandInfo.nlink, 1);
  const npmCommandBytes = readFileSync(npmCommand);
  const records: Array<{
    type: "D" | "F";
    relativePath: string;
    size?: number;
    sha256?: string;
  }> = [
    { type: "D", relativePath: "node_modules" },
    { type: "D", relativePath: "node_modules/npm" },
    {
      type: "F",
      relativePath: "npm.cmd",
      size: npmCommandBytes.byteLength,
      sha256: createHash("sha256")
        .update(npmCommandBytes)
        .digest("hex"),
    },
  ];

  const visit = (directory: string, relativeDirectory: string) => {
    const names = readdirSync(directory).sort();
    const folded = new Set<string>();
    for (const name of names) {
      assert.equal(name.normalize("NFC"), name);
      const lower = name.toLowerCase();
      assert.equal(folded.has(lower), false);
      folded.add(lower);
      const absolutePath = path.join(directory, name);
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${name}`
        : name;
      const info = lstatSync(absolutePath);
      assert.equal(info.isSymbolicLink(), false);
      if (info.isFile()) {
        assert.equal(info.nlink, 1);
      }
      assert.equal(
        realpathSync(absolutePath).toLowerCase(),
        absolutePath.toLowerCase(),
      );
      if (info.isDirectory()) {
        records.push({ type: "D", relativePath });
        visit(absolutePath, relativePath);
      } else {
        assert.equal(info.isFile(), true);
        const bytes = readFileSync(absolutePath);
        records.push({
          type: "F",
          relativePath,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  };
  visit(root, "node_modules/npm");
  records.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0,
  );

  const aggregate = createHash("sha256");
  aggregate.update("HMA-NPM-TREE-V1\0", "utf8");
  for (const record of records) {
    aggregate.update(`${record.type}\0${record.relativePath}\0`, "utf8");
    if (record.type === "F") {
      aggregate.update(
        `${record.size}\0${record.sha256}\0`,
        "utf8",
      );
    }
  }
  return aggregate.digest("hex");
}

let installedNpmTreeHash: string | undefined;

function installedNpmTreeSha256(): string {
  const installed = installedNpmPaths();
  installedNpmTreeHash ??= npmTreeSha256(
    installed.npmRoot,
    installed.npmPath,
  );
  return installedNpmTreeHash;
}

function withEnvironmentOverrides(
  source: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
) {
  const replaced = new Set(
    Object.keys(overrides).map((name) => name.toLowerCase()),
  );
  return Object.fromEntries([
    ...Object.entries(source).filter(
      ([name]) => !replaced.has(name.toLowerCase()),
    ),
    ...Object.entries(overrides),
  ]);
}

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
  if (process.platform === "win32") {
    assert.equal("ComSpec" in result, false);
    assert.equal("PATH" in result, false);
  } else {
    assert.equal(result.ComSpec, "C:\\Windows\\System32\\cmd.exe");
    assert.equal(result.PATH, "C:\\Program Files\\nodejs");
  }
  assert.equal(result.TEMP, "C:\\Temp");
  assert.equal(result.TMP, "C:\\Temp");
  assert.equal(result.NEXT_TELEMETRY_DISABLED, "1");
  assert.equal(result.NODE_ENV, "production");
  assert.equal(result.NPM_CONFIG_AUDIT, "false");
  assert.equal(result.NPM_CONFIG_FUND, "false");

  const expectedKeys = [
    "APPDATA",
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
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ].sort();
  if (process.platform !== "win32") {
    expectedKeys.push("ComSpec", "PATH");
    expectedKeys.sort();
  }
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
        expectedNpmCliSha256: string,
        expectedNpmTreeSha256: string,
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
    const { npmPath, npmCliPath } = installedNpmPaths();
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
        sha256File(npmCliPath),
        installedNpmTreeSha256(),
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
        expectedNpmCliSha256: string;
        expectedNpmTreeSha256: string;
        packageJsonPath: string;
        expectedPackageJsonSha256: string;
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
            expectedNpmCliSha256: sha256File(
              installedNpmPaths().npmCliPath,
            ),
            expectedNpmTreeSha256: installedNpmTreeSha256(),
            packageJsonPath: path.join(fixture, "package.json"),
            expectedPackageJsonSha256: sha256File(
              path.join(fixture, "package.json"),
            ),
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
        expectedNpmCliSha256: string;
        expectedNpmTreeSha256: string;
        packageJsonPath: string;
        expectedPackageJsonSha256: string;
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
            expectedNpmCliSha256: sha256File(
              installedNpmPaths().npmCliPath,
            ),
            expectedNpmTreeSha256: installedNpmTreeSha256(),
            packageJsonPath: path.join(fixture, "package.json"),
            expectedPackageJsonSha256: sha256File(
              path.join(fixture, "package.json"),
            ),
            projectRoot: fixture,
          }),
        /unsafe-npm-configuration/u,
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "a mismatched npm CLI hash is rejected before a project command runs",
  { skip: process.platform !== "win32" },
  async () => {
    const { runSanitizedValidation } = (await import(moduleUrl)) as {
      runSanitizedValidation: (options: {
        npmPath: string;
        expectedNpmCliSha256: string;
        expectedNpmTreeSha256: string;
        packageJsonPath: string;
        expectedPackageJsonSha256: string;
        projectRoot: string;
      }) => void;
    };
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-validation-npm-integrity-"),
    );
    const commandMarker = path.join(fixture, "command-ran.txt");
    await writeFile(
      path.join(fixture, "probe.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(commandMarker)}, "ran");`,
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(fixture, "package.json"),
      `${JSON.stringify({
        private: true,
        scripts: {
          test: "node probe.mjs",
          typecheck: "node probe.mjs",
          build: "node probe.mjs",
        },
      })}\n`,
      "utf8",
    );

    try {
      assert.throws(
        () =>
          runSanitizedValidation({
            npmPath: installedNpmPaths().npmPath,
            expectedNpmCliSha256: "0".repeat(64),
            expectedNpmTreeSha256: installedNpmTreeSha256(),
            packageJsonPath: path.join(fixture, "package.json"),
            expectedPackageJsonSha256: sha256File(
              path.join(fixture, "package.json"),
            ),
            projectRoot: fixture,
          }),
        /invalid-npm-cli-integrity/u,
      );
      await assert.rejects(readFile(commandMarker), { code: "ENOENT" });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "the CLI runs only fixed pinned npm operations",
  { skip: process.platform !== "win32" },
  async () => {
    const installed = installedNpmPaths();
    const packageJsonPath = path.resolve("package.json");
    const packageLockPath = path.resolve("package-lock.json");
    const baseArguments = [
      "--npm",
      installed.npmPath,
      "--expected-npm-cli-sha256",
      sha256File(installed.npmCliPath),
      "--expected-npm-tree-sha256",
      installedNpmTreeSha256(),
      "--package-json",
      packageJsonPath,
      "--expected-package-json-sha256",
      sha256File(packageJsonPath),
      "--package-lock",
      packageLockPath,
      "--expected-lockfile-sha256",
      sha256File(packageLockPath),
    ];
    const run = (operation: string) =>
      spawnSync(
        process.execPath,
        [
          modulePath,
          "--run-pinned-npm",
          operation,
          ...baseArguments,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: process.env,
          timeout: 30_000,
          windowsHide: true,
        },
      );

    const accepted = run("ls");
    assert.equal(accepted.error, undefined);
    assert.equal(accepted.status, 0);
    assert.equal(accepted.stderr, "");
    const payload = JSON.parse(accepted.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.operation, "ls");
    assert.equal(typeof payload.output, "string");
    assert.match(payload.output, /how-much-ai/u);

    const rejected = run("exec");
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "");
    assert.match(
      rejected.stderr,
      /\{"ok":false,"error":"sanitized-validation-failed"\}\r?\n$/u,
    );
  },
);

test(
  "the CLI inventories dependency install scripts without PowerShell JSON parsing",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-install-script-inventory-"),
    );
    const lockPath = path.join(fixture, "package-lock.json");
    await writeFile(
      lockPath,
      `${JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "fixture" },
          "node_modules/reviewed-package": {
            version: "1.2.3",
            hasInstallScript: true,
          },
          "node_modules/no-script": {
            version: "4.5.6",
          },
        },
      })}\n`,
      "utf8",
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          modulePath,
          "--inventory-install-scripts",
          lockPath,
          "--expected-lockfile-sha256",
          sha256File(lockPath),
        ],
        {
          cwd: fixture,
          encoding: "utf8",
          env: process.env,
          timeout: 30_000,
          windowsHide: true,
        },
      );

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: true,
        installScripts: [
          {
            path: "node_modules/reviewed-package",
            name: "node_modules/reviewed-package",
            version: "1.2.3",
          },
        ],
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "the CLI measures the retained npm tree without executing npm",
  { skip: process.platform !== "win32" },
  async () => {
    const installed = installedNpmPaths();
    const result = spawnSync(
      process.execPath,
      [
        modulePath,
        "--measure-npm-tree",
        installed.npmPath,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
        timeout: 30_000,
        windowsHide: true,
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      npmTreeSha256: installedNpmTreeSha256(),
    });
  },
);

test(
  "the CLI requires expected npm CLI and transitive tree hashes before execution",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-validation-cli-integrity-"),
    );
    const fakeNode = path.join(fixture, "node.exe");
    const fakeNpm = path.join(fixture, "npm.cmd");
    const fakeNpmCli = path.join(
      fixture,
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    const packageJsonPath = path.join(fixture, "package.json");
    const executionMarker = path.join(fixture, "npm-cli-ran.txt");

    await mkdir(path.dirname(fakeNpmCli), { recursive: true });
    await copyFile(process.execPath, fakeNode);
    await writeFile(fakeNpm, "@exit /b 0\r\n", "utf8");
    await writeFile(packageJsonPath, '{"private":true}\n', "utf8");
    await writeFile(
      fakeNpmCli,
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(executionMarker)}, "x");`,
        "if (process.argv[2] === 'config') {",
        "  process.stdout.write(JSON.stringify({",
        "    userconfig: process.env.NPM_CONFIG_USERCONFIG,",
        "    globalconfig: process.env.NPM_CONFIG_GLOBALCONFIG,",
        "    cache: process.env.NPM_CONFIG_CACHE,",
        "    audit: false,",
        "    fund: false,",
        "    'ignore-scripts': true,",
        "    offline: true,",
        "    'strict-ssl': true,",
        "  }));",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const runCli = (extraArguments: string[]) =>
      spawnSync(
        fakeNode,
        [modulePath, "--npm", fakeNpm, ...extraArguments],
        {
          cwd: fixture,
          encoding: "utf8",
          env: process.env,
          timeout: 30_000,
          windowsHide: true,
        },
      );
    const expectedCliHash = sha256File(fakeNpmCli);
    const metadataArguments = [
      "--package-json",
      packageJsonPath,
      "--expected-package-json-sha256",
      sha256File(packageJsonPath),
    ];
    const expectedTreeHash = npmTreeSha256(
      path.join(fixture, "node_modules", "npm"),
      fakeNpm,
    );

    try {
      const missing = runCli([]);
      assert.equal(missing.status, 1);
      assert.match(
        missing.stderr,
        /\{"ok":false,"error":"sanitized-validation-failed"\}\r?\n$/u,
      );
      await assert.rejects(readFile(executionMarker), { code: "ENOENT" });

      const missingTree = runCli([
        "--expected-npm-cli-sha256",
        expectedCliHash,
      ]);
      assert.equal(missingTree.status, 1);
      await assert.rejects(readFile(executionMarker), { code: "ENOENT" });

      const mismatched = runCli([
        "--expected-npm-cli-sha256",
        "0".repeat(64),
        "--expected-npm-tree-sha256",
        expectedTreeHash,
      ]);
      assert.equal(mismatched.status, 1);
      assert.match(
        mismatched.stderr,
        /\{"ok":false,"error":"sanitized-validation-failed"\}\r?\n$/u,
      );
      await assert.rejects(readFile(executionMarker), { code: "ENOENT" });

      const mismatchedTree = runCli([
        "--expected-npm-cli-sha256",
        expectedCliHash,
        "--expected-npm-tree-sha256",
        "0".repeat(64),
      ]);
      assert.equal(mismatchedTree.status, 1);
      await assert.rejects(readFile(executionMarker), { code: "ENOENT" });

      const mismatchedPackageJson = runCli([
        "--expected-npm-cli-sha256",
        expectedCliHash,
        "--expected-npm-tree-sha256",
        expectedTreeHash,
        "--package-json",
        packageJsonPath,
        "--expected-package-json-sha256",
        "0".repeat(64),
      ]);
      assert.equal(mismatchedPackageJson.status, 1);
      await assert.rejects(readFile(executionMarker), { code: "ENOENT" });

      const accepted = runCli([
        "--expected-npm-cli-sha256",
        expectedCliHash,
        "--expected-npm-tree-sha256",
        expectedTreeHash,
        ...metadataArguments,
      ]);
      assert.equal(accepted.status, 0);
      assert.equal(accepted.stderr, "");
      assert.equal(
        accepted.stdout,
        '{"ok":true,"commandsPassed":3}\n',
      );
      assert.equal(
        await readFile(executionMarker, "utf8"),
        "x".repeat(9),
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "a changed npm lib module is rejected while npm-cli.js remains unchanged",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-validation-npm-lib-integrity-"),
    );
    const fakeNode = path.join(fixture, "node.exe");
    const fakeNpm = path.join(fixture, "npm.cmd");
    const npmRoot = path.join(fixture, "node_modules", "npm");
    const fakeNpmCli = path.join(npmRoot, "bin", "npm-cli.js");
    const fakeNpmLib = path.join(npmRoot, "lib", "cli.js");
    const packageJsonPath = path.join(fixture, "package.json");
    const executionMarker = path.join(fixture, "npm-lib-ran.txt");
    const goodLibrary = [
      "if (process.argv[2] === 'config') {",
      "  process.stdout.write(JSON.stringify({",
      "    userconfig: process.env.NPM_CONFIG_USERCONFIG,",
      "    globalconfig: process.env.NPM_CONFIG_GLOBALCONFIG,",
      "    cache: process.env.NPM_CONFIG_CACHE,",
      "    audit: false,",
      "    fund: false,",
      "    'ignore-scripts': true,",
      "    offline: true,",
      "    'strict-ssl': true,",
      "  }));",
      "}",
      "",
    ].join("\n");

    await mkdir(path.dirname(fakeNpmCli), { recursive: true });
    await mkdir(path.dirname(fakeNpmLib), { recursive: true });
    await copyFile(process.execPath, fakeNode);
    await writeFile(fakeNpm, "@exit /b 0\r\n", "utf8");
    await writeFile(fakeNpmCli, 'import "../lib/cli.js";\n', "utf8");
    await writeFile(fakeNpmLib, goodLibrary, "utf8");
    await writeFile(packageJsonPath, '{"private":true}\n', "utf8");

    const expectedCliHash = sha256File(fakeNpmCli);
    const expectedTreeHash = npmTreeSha256(npmRoot, fakeNpm);
    const runCli = () =>
      spawnSync(
        fakeNode,
        [
          modulePath,
          "--npm",
          fakeNpm,
          "--expected-npm-cli-sha256",
          expectedCliHash,
          "--expected-npm-tree-sha256",
          expectedTreeHash,
          "--package-json",
          packageJsonPath,
          "--expected-package-json-sha256",
          sha256File(packageJsonPath),
        ],
        {
          cwd: fixture,
          encoding: "utf8",
          env: process.env,
          timeout: 30_000,
          windowsHide: true,
        },
      );

    try {
      const reviewed = runCli();
      assert.equal(reviewed.status, 0);
      await assert.rejects(readFile(executionMarker), { code: "ENOENT" });

      await writeFile(
        fakeNpmLib,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(executionMarker)}, "ran");`,
          goodLibrary,
        ].join("\n"),
        "utf8",
      );
      assert.equal(sha256File(fakeNpmCli), expectedCliHash);

      const changed = runCli();
      assert.equal(changed.status, 1);
      assert.match(
        changed.stderr,
        /\{"ok":false,"error":"sanitized-validation-failed"\}\r?\n$/u,
      );
      await assert.rejects(readFile(executionMarker), { code: "ENOENT" });

      await writeFile(fakeNpmLib, goodLibrary, "utf8");
      const restored = runCli();
      assert.equal(restored.status, 0);
      await assert.rejects(readFile(executionMarker), { code: "ENOENT" });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "npm tree hashing rejects hardlinks and reparse points",
  { skip: process.platform !== "win32" },
  async () => {
    const { computeNpmTreeSha256 } = (await import(moduleUrl)) as {
      computeNpmTreeSha256: (npmPath: string) => string;
    };
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-validation-npm-tree-paths-"),
    );
    const fakeNpm = path.join(fixture, "npm.cmd");
    const npmRoot = path.join(fixture, "node_modules", "npm");
    const ordinaryFile = path.join(npmRoot, "lib", "cli.js");
    const hardlinkFile = path.join(npmRoot, "lib", "hardlink.js");
    const linkedDirectory = path.join(npmRoot, "linked-directory");
    const linkTarget = path.join(fixture, "link-target");

    await mkdir(path.dirname(ordinaryFile), { recursive: true });
    await mkdir(linkTarget);
    await writeFile(fakeNpm, "@exit /b 0\r\n", "utf8");
    await writeFile(ordinaryFile, "export const reviewed = true;\n", "utf8");

    try {
      assert.match(computeNpmTreeSha256(fakeNpm), /^[a-f0-9]{64}$/u);

      await link(ordinaryFile, hardlinkFile);
      assert.throws(
        () => computeNpmTreeSha256(fakeNpm),
        /invalid-npm-tree-integrity/u,
      );
      await rm(hardlinkFile);

      await symlink(linkTarget, linkedDirectory, "junction");
      assert.throws(
        () => computeNpmTreeSha256(fakeNpm),
        /invalid-npm-tree-integrity/u,
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "validation ignores a shadow node on the ambient PATH",
  { skip: process.platform !== "win32" },
  async () => {
    const { runSanitizedValidation } = (await import(moduleUrl)) as {
      runSanitizedValidation: (options: {
        npmPath: string;
        expectedNpmCliSha256: string;
        expectedNpmTreeSha256: string;
        packageJsonPath: string;
        expectedPackageJsonSha256: string;
        projectRoot: string;
        sourceEnvironment: NodeJS.ProcessEnv;
      }) => void;
    };
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-validation-shadow-node-"),
    );
    const attackerBin = path.join(fixture, "attacker-bin");
    await mkdir(attackerBin);
    await writeFile(
      path.join(attackerBin, "node.cmd"),
      "@echo off\r\nexit /b 0\r\n",
      "utf8",
    );
    const packageJson = {
      private: true,
      scripts: {
        test: 'node -e "process.exit(37)"',
        typecheck: 'node -e "process.exit(37)"',
        build: 'node -e "process.exit(37)"',
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
            expectedNpmCliSha256: sha256File(
              installedNpmPaths().npmCliPath,
            ),
            expectedNpmTreeSha256: installedNpmTreeSha256(),
            packageJsonPath: path.join(fixture, "package.json"),
            expectedPackageJsonSha256: sha256File(
              path.join(fixture, "package.json"),
            ),
            projectRoot: fixture,
            sourceEnvironment: withEnvironmentOverrides(process.env, {
              PATH: attackerBin,
            }),
          }),
        /validation-command-failed/u,
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "validation resolves only reviewed Windows command shims with a deterministic PATHEXT",
  { skip: process.platform !== "win32" },
  async () => {
    const { runSanitizedValidation } = (await import(moduleUrl)) as {
      runSanitizedValidation: (options: {
        npmPath: string;
        expectedNpmCliSha256: string;
        expectedNpmTreeSha256: string;
        packageJsonPath: string;
        expectedPackageJsonSha256: string;
        projectRoot: string;
        sourceEnvironment: NodeJS.ProcessEnv;
      }) => void;
    };
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-validation-pathext-"),
    );
    const binDirectory = path.join(fixture, "node_modules", ".bin");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(
      path.join(binDirectory, "reviewed-probe.cmd"),
      "@echo off\r\nexit /b 0\r\n",
      "utf8",
    );
    await writeFile(
      path.join(fixture, "package.json"),
      `${JSON.stringify({
        private: true,
        scripts: {
          test: "reviewed-probe",
          typecheck: "reviewed-probe",
          build: "reviewed-probe",
        },
      })}\n`,
      "utf8",
    );

    try {
      assert.doesNotThrow(() =>
        runSanitizedValidation({
          npmPath: path.join(path.dirname(process.execPath), "npm.cmd"),
          expectedNpmCliSha256: sha256File(
            installedNpmPaths().npmCliPath,
          ),
          expectedNpmTreeSha256: installedNpmTreeSha256(),
          packageJsonPath: path.join(fixture, "package.json"),
          expectedPackageJsonSha256: sha256File(
            path.join(fixture, "package.json"),
          ),
          projectRoot: fixture,
          sourceEnvironment: withEnvironmentOverrides(process.env, {
            PATHEXT: ".EXE",
          }),
        }),
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "validation ignores a hostile ambient ComSpec",
  { skip: process.platform !== "win32" },
  async () => {
    const { runSanitizedValidation } = (await import(moduleUrl)) as {
      runSanitizedValidation: (options: {
        npmPath: string;
        expectedNpmCliSha256: string;
        expectedNpmTreeSha256: string;
        packageJsonPath: string;
        expectedPackageJsonSha256: string;
        projectRoot: string;
        sourceEnvironment: NodeJS.ProcessEnv;
      }) => void;
    };
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-validation-hostile-comspec-"),
    );
    const attackerShell = path.join(fixture, "cmd.exe");
    const systemRoot = process.env.SystemRoot;
    assert.ok(systemRoot);
    await copyFile(
      path.join(systemRoot, "System32", "cmd.exe"),
      attackerShell,
    );
    await writeFile(
      path.join(fixture, "probe.mjs"),
      [
        `const attacker = ${JSON.stringify(attackerShell.toLowerCase())};`,
        "process.exit(process.env.ComSpec?.toLowerCase() === attacker ? 0 : 37);",
        "",
      ].join("\n"),
      "utf8",
    );
    const packageJson = {
      private: true,
      scripts: {
        test: "node probe.mjs",
        typecheck: "node probe.mjs",
        build: "node probe.mjs",
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
            expectedNpmCliSha256: sha256File(
              installedNpmPaths().npmCliPath,
            ),
            expectedNpmTreeSha256: installedNpmTreeSha256(),
            packageJsonPath: path.join(fixture, "package.json"),
            expectedPackageJsonSha256: sha256File(
              path.join(fixture, "package.json"),
            ),
            projectRoot: fixture,
            sourceEnvironment: withEnvironmentOverrides(process.env, {
              ComSpec: attackerShell,
            }),
          }),
        /validation-command-failed/u,
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "validation rejects a reparse-point Windows root before running commands",
  { skip: process.platform !== "win32" },
  async () => {
    const { runSanitizedValidation } = (await import(moduleUrl)) as {
      runSanitizedValidation: (options: {
        npmPath: string;
        expectedNpmCliSha256: string;
        expectedNpmTreeSha256: string;
        packageJsonPath: string;
        expectedPackageJsonSha256: string;
        projectRoot: string;
        sourceEnvironment: NodeJS.ProcessEnv;
      }) => void;
    };
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-validation-reparse-root-"),
    );
    const systemRoot = process.env.SystemRoot;
    assert.ok(systemRoot);
    const linkedRoot = path.join(fixture, "windows-link");
    await symlink(systemRoot, linkedRoot, "junction");
    const packageJson = {
      private: true,
      scripts: {
        test: 'node -e "process.exit(0)"',
        typecheck: 'node -e "process.exit(0)"',
        build: 'node -e "process.exit(0)"',
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
            expectedNpmCliSha256: sha256File(
              installedNpmPaths().npmCliPath,
            ),
            expectedNpmTreeSha256: installedNpmTreeSha256(),
            packageJsonPath: path.join(fixture, "package.json"),
            expectedPackageJsonSha256: sha256File(
              path.join(fixture, "package.json"),
            ),
            projectRoot: fixture,
            sourceEnvironment: withEnvironmentOverrides(process.env, {
              SystemRoot: linkedRoot,
              WINDIR: linkedRoot,
            }),
          }),
        /invalid-windows-command-environment/u,
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
