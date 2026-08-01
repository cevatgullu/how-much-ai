import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  copyFile,
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
import { setTimeout as delay } from "node:timers/promises";

const windowsOnly = { skip: process.platform !== "win32" };
const launcherPath = path.resolve("scripts/audit/invoke-trusted-node.ps1");
const sanitizedValidationPath = path.resolve(
  "scripts/audit/run-sanitized-validation.mjs",
);
const powerShell51 = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function withoutCaseInsensitiveKeys(
  source: NodeJS.ProcessEnv,
  forbidden: string[],
): NodeJS.ProcessEnv {
  const folded = new Set(forbidden.map((name) => name.toLowerCase()));
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name]) => !folded.has(name.toLowerCase()),
    ),
  );
}

function runLauncher(options: {
  nodePath: string;
  expectedNodeSha256: string;
  scriptPath: string;
  expectedScriptSha256: string;
  scriptArguments?: string[];
  encodedScriptArguments?: string;
  env?: NodeJS.ProcessEnv;
  passThruResult?: boolean;
  timeoutMs?: number;
}) {
  const scriptArguments = options.scriptArguments ?? [];
  const encodedScriptArguments =
    options.encodedScriptArguments ??
    Buffer.from(
      JSON.stringify({ version: 1, arguments: scriptArguments }),
      "utf8",
    ).toString("base64url");
  const invocation = [
    `& ${psLiteral(launcherPath)}`,
    `-NodePath ${psLiteral(options.nodePath)}`,
    `-ExpectedNodeSha256 ${psLiteral(options.expectedNodeSha256)}`,
    `-ScriptPath ${psLiteral(options.scriptPath)}`,
    `-ExpectedScriptSha256 ${psLiteral(options.expectedScriptSha256)}`,
    `-EncodedScriptArguments ${psLiteral(encodedScriptArguments)}`,
    options.passThruResult ? "-PassThruResult" : "",
  ].filter(Boolean).join(" ");
  const command = options.passThruResult
    ? `${invocation} | ConvertTo-Json -Compress -Depth 3`
    : invocation;
  return spawnSync(
    powerShell51,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
    {
      encoding: "utf8",
      env: options.env,
      timeout: options.timeoutMs ?? 30_000,
      windowsHide: true,
    },
  );
}

function runLauncherFileBoundary(options: {
  nodePath: string;
  expectedNodeSha256: string;
  scriptPath: string;
  expectedScriptSha256: string;
  scriptArguments?: string[];
  env?: NodeJS.ProcessEnv;
}) {
  const encodedScriptArguments = Buffer.from(
    JSON.stringify({
      version: 1,
      arguments: options.scriptArguments ?? [],
    }),
    "utf8",
  ).toString("base64url");
  return spawnSync(
    powerShell51,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
      "-NodePath",
      options.nodePath,
      "-ExpectedNodeSha256",
      options.expectedNodeSha256,
      "-ScriptPath",
      options.scriptPath,
      "-ExpectedScriptSha256",
      options.expectedScriptSha256,
      "-EncodedScriptArguments",
      encodedScriptArguments,
    ],
    {
      encoding: "utf8",
      env: options.env,
      timeout: 180_000,
      windowsHide: true,
    },
  );
}

async function fileSha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
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
      const relativePath = `${relativeDirectory}/${name}`;
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

test(
  "an exact reviewed script runs while ambient Node preload and PATH shadowing are absent",
  windowsOnly,
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-trusted-node-"),
    );
    const auditDirectory = path.join(fixture, "scripts", "audit");
    const fixtureScript = path.join(
      auditDirectory,
      "reviewed-fixture.mjs",
    );
    const preloadScript = path.join(fixture, "hostile-preload.cjs");
    const preloadMarker = path.join(fixture, "preload-ran.txt");
    const reviewedMarker = path.join(fixture, "reviewed-ran.txt");
    const shadowDirectory = path.join(fixture, "shadow-bin");
    const shadowMarker = path.join(fixture, "shadow-ran.txt");
    const argumentValues = [
      reviewedMarker,
      "value with spaces",
      'quote"value',
      "trailing\\",
    ];

    await mkdir(auditDirectory, { recursive: true });
    await mkdir(shadowDirectory);
    await writeFile(
      preloadScript,
      `require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "preload");\n`,
      "utf8",
    );
    await writeFile(
      path.join(shadowDirectory, "node.cmd"),
      `@echo off\r\n>${JSON.stringify(shadowMarker)} echo shadow\r\nexit /b 91\r\n`,
      "utf8",
    );
    await writeFile(
      fixtureScript,
      [
        'import { writeFileSync } from "node:fs";',
        "const args = process.argv.slice(2);",
        'writeFileSync(args[0], "reviewed");',
        "const keys = Object.keys(process.env).map((key) => key.toLowerCase()).sort();",
        "const forbidden = keys.some((key) => key.startsWith('node_') || key.startsWith('npm_') || key.includes('proxy') || key.includes('secret'));",
        "process.stdout.write(JSON.stringify({ args, forbidden, keys, path: process.env.PATH }));",
        "",
      ].join("\n"),
      "utf8",
    );

    const hostileEnvironment = {
      ...withoutCaseInsensitiveKeys(process.env, [
        "PATH",
        "NODE_OPTIONS",
        "NODE_PATH",
      ]),
      PATH: shadowDirectory,
      NODE_OPTIONS: `--require="${preloadScript}"`,
      NODE_PATH: path.join(fixture, "hostile-node-modules"),
      NODE_REPL_EXTERNAL_MODULE: preloadScript,
      NPM_CONFIG_NODE_OPTIONS: `--require="${preloadScript}"`,
      HTTPS_PROXY: "http://HOSTILE-PROXY-CANARY.invalid",
      AUTH_SECRET: ["HOSTILE", "SECRET", "CANARY"].join("-"),
    };

    try {
      const result = runLauncherFileBoundary({
        nodePath: process.execPath,
        expectedNodeSha256: await fileSha256(process.execPath),
        scriptPath: fixtureScript,
        expectedScriptSha256: await fileSha256(fixtureScript),
        scriptArguments: argumentValues,
        env: hostileEnvironment,
      });

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), {
        args: argumentValues,
        forbidden: false,
        keys: [
          "comspec",
          "path",
          "pathext",
          "systemroot",
          "temp",
          "tmp",
          "windir",
        ],
        path: path.dirname(process.execPath),
      });
      assert.equal(await readFile(reviewedMarker, "utf8"), "reviewed");
      await assert.rejects(readFile(preloadMarker), { code: "ENOENT" });
      await assert.rejects(readFile(shadowMarker), { code: "ENOENT" });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test("the secure Windows guide binds audit entrypoints and the installer never executes ambient Git", async () => {
  const guide = await readFile(
    path.resolve("docs/WINDOWS_SECURE_LOCAL.md"),
    "utf8",
  );
  const launcher = await readFile(launcherPath, "utf8");
  const installer = await readFile(
    path.resolve("scripts/windows/install-secure-local.ps1"),
    "utf8",
  );

  assert.doesNotMatch(guide, /^node(?:\.exe)?\s/gmu);
  assert.doesNotMatch(guide, /\bnode(?:\.exe)?\s+scripts[\\/]audit[\\/]/giu);
  for (const name of [
    "run-sanitized-validation.mjs",
    "create-runtime-manifest.mjs",
    "safe-secret-scan.mjs",
    "prove-runtime-immutability.mjs",
  ]) {
    assert.match(
      guide,
      new RegExp(`Invoke-HmaTrustedAudit[\\s\\S]*?-Name '${name.replace(".", "\\.")}'`, "u"),
    );
  }
  assert.match(guide, /-EncodedScriptArguments\s+\$encodedArguments/u);
  assert.doesNotMatch(guide, /-ScriptArguments\b/u);
  assert.doesNotMatch(
    guide,
    /-File\s+scripts[\\/]windows[\\/]install-secure-local\.ps1/iu,
  );
  assert.match(guide, /\$manifest\.installerSha256/u);
  assert.match(guide, /--expected-package-json-sha256/u);
  assert.match(guide, /--expected-lockfile-sha256/u);
  assert.match(guide, /CycloneDX/u);
  assert.match(
    guide,
    /\[ValidateSet\('ci', 'ls', 'audit', 'sbom'\)\]/u,
  );
  assert.match(
    guide,
    /'sbom'\s*\{[\s\S]*?npm-sbom\.cdx\.json/u,
  );
  assert.match(
    guide,
    /Invoke-HmaPinnedNpmCommand -Operation 'sbom'/u,
  );
  assert.match(guide, /GIT_CONFIG_NOSYSTEM/u);
  assert.match(guide, /--no-ext-diff/u);
  assert.match(guide, /--no-textconv/u);
  assert.match(guide, /--porcelain=v1/u);
  assert.match(guide, /\$gitStatusLines\.Count\s+-ne\s+0/u);
  assert.match(guide, /--exit-code/u);
  assert.match(guide, /--quiet/u);
  assert.match(guide, /\[IO\.FileShare\]::Read/u);
  assert.match(guide, /\[ScriptBlock\]::Create/u);
  assert.doesNotMatch(guide, /-File\s+\$trustedAuditLauncher\b/u);
  assert.doesNotMatch(
    guide,
    /\$ps51\s*=\s*Join-Path\s+\$env:SystemRoot/iu,
  );
  assert.match(guide, /\$finalPs51Stream\s*=\s*\[IO\.File\]::Open/u);
  assert.match(
    guide,
    /Get-HmaLockedFileSha256\s+-Stream\s+\$finalPs51Stream[\s\S]*?\$trustedPs51Sha256/u,
  );
  const defenderLeaseIndex = guide.indexOf("$defenderManifestStream = $null");
  const defenderUtf8Index = guide.indexOf(
    "$strictUtf8 = New-Object Text.UTF8Encoding($false, $true)",
    defenderLeaseIndex,
  );
  const defenderDecodeIndex = guide.indexOf(
    "$strictUtf8.GetString($defenderManifestBytes)",
    defenderLeaseIndex,
  );
  const defenderToolNullIndex = guide.indexOf(
    "$mpCmdRunStream = $null",
    defenderLeaseIndex,
  );
  const defenderToolTryIndex = guide.indexOf("try {", defenderToolNullIndex);
  const defenderToolOpenIndex = guide.indexOf(
    "$mpCmdRunStream = [IO.File]::Open(",
    defenderToolNullIndex,
  );
  assert.ok(defenderLeaseIndex >= 0);
  assert.ok(defenderUtf8Index > defenderLeaseIndex);
  assert.ok(defenderDecodeIndex > defenderUtf8Index);
  assert.ok(defenderToolNullIndex > defenderDecodeIndex);
  assert.ok(defenderToolTryIndex > defenderToolNullIndex);
  assert.ok(defenderToolOpenIndex > defenderToolTryIndex);
  assert.doesNotMatch(installer, /(?:^|[;&|]\s*)git(?:\.exe)?\b/gimu);
  assert.doesNotMatch(installer, /Get-Command\s+git(?:\.exe)?\b/gimu);

  const nativeStart = launcher.slice(
    launcher.indexOf(
      "public static TrustedNativeProcess StartSuspendedAssigned",
    ),
  );
  const createSuspendedIndex = nativeStart.indexOf(
    "CreateSuspended |",
  );
  const createProcessIndex = nativeStart.indexOf(
    "if (!CreateProcessW(",
  );
  const assignIndex = nativeStart.indexOf(
    "if (!AssignProcessToJobObject(",
  );
  const resumeIndex = nativeStart.indexOf(
    "if (ResumeThread(",
  );
  assert.ok(createSuspendedIndex >= 0);
  assert.ok(createProcessIndex >= 0);
  assert.ok(assignIndex > createProcessIndex);
  assert.ok(resumeIndex > assignIndex);
  assert.match(
    nativeStart,
    /WaitForSingleObject\(job,\s*WaitInfinite\)/u,
  );
});

test(
  "pass-through mode returns one exact result object without exiting its host",
  windowsOnly,
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-trusted-node-result-"),
    );
    const auditDirectory = path.join(fixture, "scripts", "audit");
    const fixtureScript = path.join(
      auditDirectory,
      "reviewed-result.mjs",
    );
    await mkdir(auditDirectory, { recursive: true });
    await writeFile(
      fixtureScript,
      'process.stdout.write("reviewed-output");\n',
      "utf8",
    );

    try {
      const result = runLauncher({
        nodePath: process.execPath,
        expectedNodeSha256: await fileSha256(process.execPath),
        scriptPath: fixtureScript,
        expectedScriptSha256: await fileSha256(fixtureScript),
        passThruResult: true,
      });

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), {
        version: 1,
        ok: true,
        exitCode: 0,
        stdout: "reviewed-output",
        stderr: "",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "the launcher kills detached descendants before releasing trusted resources",
  windowsOnly,
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-trusted-node-job-"),
    );
    const auditDirectory = path.join(fixture, "scripts", "audit");
    const fixtureScript = path.join(
      auditDirectory,
      "reviewed-detached-child.mjs",
    );
    const marker = path.join(fixture, "detached-child-survived.txt");
    await mkdir(auditDirectory, { recursive: true });
    await writeFile(
      fixtureScript,
      [
        'import { spawn } from "node:child_process";',
        "const [marker] = process.argv.slice(2);",
        "const childSource = [",
        '  "const { writeFileSync } = require(\'node:fs\');",',
        '  "setTimeout(() => writeFileSync(process.argv[1], \'survived\'), 1400);",',
        '].join("\\n");',
        "const child = spawn(process.execPath, ['-e', childSource, marker], {",
        "  detached: true,",
        "  stdio: 'ignore',",
        "});",
        "child.unref();",
        'process.stdout.write("parent-complete");',
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      const result = runLauncher({
        nodePath: process.execPath,
        expectedNodeSha256: await fileSha256(process.execPath),
        scriptPath: fixtureScript,
        expectedScriptSha256: await fileSha256(fixtureScript),
        scriptArguments: [marker],
        passThruResult: true,
      });

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        version: 1,
        ok: true,
        exitCode: 0,
        stdout: "parent-complete",
        stderr: "",
      });
      await delay(2_200);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "an interrupted launcher host cannot leave its detached process tree alive",
  windowsOnly,
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-trusted-node-interrupt-"),
    );
    const auditDirectory = path.join(fixture, "scripts", "audit");
    const fixtureScript = path.join(
      auditDirectory,
      "reviewed-interrupted-child.mjs",
    );
    const marker = path.join(
      fixture,
      "interrupted-child-survived.txt",
    );
    await mkdir(auditDirectory, { recursive: true });
    await writeFile(
      fixtureScript,
      [
        'import { spawn } from "node:child_process";',
        "const [marker] = process.argv.slice(2);",
        "const childSource = [",
        '  "const { writeFileSync } = require(\'node:fs\');",',
        '  "setTimeout(() => writeFileSync(process.argv[1], \'survived\'), 2600);",',
        '].join("\\n");',
        "const child = spawn(process.execPath, ['-e', childSource, marker], {",
        "  detached: true,",
        "  stdio: 'ignore',",
        "});",
        "child.unref();",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      const result = runLauncher({
        nodePath: process.execPath,
        expectedNodeSha256: await fileSha256(process.execPath),
        scriptPath: fixtureScript,
        expectedScriptSha256: await fileSha256(fixtureScript),
        scriptArguments: [marker],
        timeoutMs: 1_200,
      });

      assert.equal(result.error?.code, "ETIMEDOUT");
      assert.equal(result.status, null);
      await delay(3_400);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "a reviewed child failure preserves only its exit code and a constant diagnostic",
  windowsOnly,
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-trusted-node-failure-"),
    );
    const auditDirectory = path.join(fixture, "scripts", "audit");
    const fixtureScript = path.join(
      auditDirectory,
      "failing-fixture.mjs",
    );
    const secretCanary = "TRUSTED-NODE-SECRET-CANARY";

    await mkdir(auditDirectory, { recursive: true });
    await writeFile(
      fixtureScript,
      [
        `process.stdout.write(${JSON.stringify(`${secretCanary}:${fixtureScript}`)});`,
        `process.stderr.write(${JSON.stringify(`${secretCanary}:${fixture}`)});`,
        "process.exitCode = 37;",
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      const result = runLauncher({
        nodePath: process.execPath,
        expectedNodeSha256: await fileSha256(process.execPath),
        scriptPath: fixtureScript,
        expectedScriptSha256: await fileSha256(fixtureScript),
      });
      const combined = `${result.stdout}\n${result.stderr}`;

      assert.equal(result.error, undefined);
      assert.equal(result.status, 37);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "Trusted Node launch failed.\r\n");
      for (const forbidden of [
        secretCanary,
        fixture,
        fixtureScript,
        process.execPath,
      ]) {
        assert.equal(combined.includes(forbidden), false);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "oversized reviewed child output is drained but exposed only as a bounded generic failure",
  windowsOnly,
  async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-trusted-node-oversized-"));
    const auditDirectory = path.join(fixture, "scripts", "audit");
    const fixtureScript = path.join(auditDirectory, "oversized-output.mjs");
    const secretCanary = "TRUSTED-NODE-OVERSIZED-PRIVATE";
    await mkdir(auditDirectory, { recursive: true });
    await writeFile(
      fixtureScript,
      [
        "const [stream] = process.argv.slice(2);",
        `const output = ${JSON.stringify(secretCanary + ":")} + "\\u0800".repeat(400_000);`,
        "if (stream === 'both') {",
        "  process.stdout.write(output);",
        "  process.stderr.write(output);",
        "} else {",
        "  process[stream].write(output);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      for (const stream of ["stdout", "stderr", "both"]) {
        const result = runLauncher({
          nodePath: process.execPath,
          expectedNodeSha256: await fileSha256(process.execPath),
          scriptPath: fixtureScript,
          expectedScriptSha256: await fileSha256(fixtureScript),
          scriptArguments: [stream],
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /^Trusted Node launch failed\.\r?\n$/u);
        assert.equal(result.stderr.length < 64, true);
        assert.equal(`${result.stdout}${result.stderr}`.includes(secretCanary), false);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "invalid UTF-8 cannot stop pipe draining or expose reviewed child output",
  windowsOnly,
  async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-trusted-node-invalid-utf8-"));
    const auditDirectory = path.join(fixture, "scripts", "audit");
    const fixtureScript = path.join(auditDirectory, "invalid-utf8-output.mjs");
    const secretCanary = "TRUSTED-NODE-INVALID-UTF8-PRIVATE";
    await mkdir(auditDirectory, { recursive: true });
    await writeFile(
      fixtureScript,
      [
        `const output = Buffer.concat([Buffer.from([0xff]), Buffer.from(${JSON.stringify(secretCanary + ":")} + "x".repeat(300_000))]);`,
        "process.stdout.write(output);",
        "process.stderr.write(output);",
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      const result = runLauncher({
        nodePath: process.execPath,
        expectedNodeSha256: await fileSha256(process.execPath),
        scriptPath: fixtureScript,
        expectedScriptSha256: await fileSha256(fixtureScript),
        timeoutMs: 5_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^Trusted Node launch failed\.\r?\n$/u);
      assert.equal(`${result.stdout}${result.stderr}`.includes(secretCanary), false);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "the trusted launcher runs the reviewed validator with exact Windows command shims",
  windowsOnly,
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-trusted-validation-"),
    );
    const auditDirectory = path.join(fixture, "scripts", "audit");
    const validatorPath = path.join(
      auditDirectory,
      "run-sanitized-validation.mjs",
    );
    const binDirectory = path.join(fixture, "node_modules", ".bin");

    await mkdir(auditDirectory, { recursive: true });
    await mkdir(binDirectory, { recursive: true });
    await copyFile(sanitizedValidationPath, validatorPath);
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
      const npmPath = path.join(
        path.dirname(process.execPath),
        "npm.cmd",
      );
      const npmRoot = path.join(
        path.dirname(process.execPath),
        "node_modules",
        "npm",
      );
      const npmCliPath = path.join(
        npmRoot,
        "bin",
        "npm-cli.js",
      );
      const packageJsonPath = path.join(fixture, "package.json");
      const result = runLauncherFileBoundary({
        nodePath: process.execPath,
        expectedNodeSha256: await fileSha256(process.execPath),
        scriptPath: validatorPath,
        expectedScriptSha256: await fileSha256(validatorPath),
        scriptArguments: [
          "--npm",
          npmPath,
          "--expected-npm-cli-sha256",
          await fileSha256(npmCliPath),
          "--expected-npm-tree-sha256",
          npmTreeSha256(npmRoot, npmPath),
          "--package-json",
          packageJsonPath,
          "--expected-package-json-sha256",
          await fileSha256(packageJsonPath),
        ],
        env: {
          ...process.env,
          NODE_OPTIONS: "--require=must-not-run.cjs",
          PATHEXT: ".EXE",
        },
      });

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /"ok":true,"commandsPassed":3/u);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "the trusted launcher holds the protected npm lease for a pinned operation",
  windowsOnly,
  async () => {
    const npmPath = path.join(
      path.dirname(process.execPath),
      "npm.cmd",
    );
    const npmRoot = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
    );
    const npmCliPath = path.join(npmRoot, "bin", "npm-cli.js");
    const packageJsonPath = path.resolve("package.json");
    const packageLockPath = path.resolve("package-lock.json");
    const result = runLauncherFileBoundary({
      nodePath: process.execPath,
      expectedNodeSha256: await fileSha256(process.execPath),
      scriptPath: sanitizedValidationPath,
      expectedScriptSha256: await fileSha256(
        sanitizedValidationPath,
      ),
      scriptArguments: [
        "--run-pinned-npm",
        "ls",
        "--npm",
        npmPath,
        "--expected-npm-cli-sha256",
        await fileSha256(npmCliPath),
        "--expected-npm-tree-sha256",
        npmTreeSha256(npmRoot, npmPath),
        "--package-json",
        packageJsonPath,
        "--expected-package-json-sha256",
        await fileSha256(packageJsonPath),
        "--package-lock",
        packageLockPath,
        "--expected-lockfile-sha256",
        await fileSha256(packageLockPath),
      ],
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.operation, "ls");
    assert.equal(typeof payload.output, "string");
    assert.match(payload.output, /how-much-ai/u);
  },
);

test(
  "the trusted launcher accepts only the exact pinned sbom operation shape",
  windowsOnly,
  async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-trusted-sbom-"));
    const auditDirectory = path.join(fixture, "scripts", "audit");
    const validatorPath = path.join(auditDirectory, "run-sanitized-validation.mjs");
    const marker = path.join(fixture, "validator-arguments.json");
    const npmPath = path.join(path.dirname(process.execPath), "npm.cmd");
    const npmRoot = path.join(path.dirname(process.execPath), "node_modules", "npm");
    const npmCliPath = path.join(npmRoot, "bin", "npm-cli.js");
    const packageJsonPath = path.join(fixture, "package.json");
    const packageLockPath = path.join(fixture, "package-lock.json");
    await mkdir(auditDirectory, { recursive: true });
    await writeFile(packageJsonPath, '{"name":"launcher-sbom-fixture","private":true}\n', "utf8");
    await writeFile(packageLockPath, '{"name":"launcher-sbom-fixture","lockfileVersion":3,"packages":{}}\n', "utf8");
    await writeFile(
      validatorPath,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`,
        'process.stdout.write("accepted\\n");',
        "",
      ].join("\n"),
      "utf8",
    );
    const exactArguments = [
      "--run-pinned-npm",
      "sbom",
      "--npm",
      npmPath,
      "--expected-npm-cli-sha256",
      await fileSha256(npmCliPath),
      "--expected-npm-tree-sha256",
      npmTreeSha256(npmRoot, npmPath),
      "--package-json",
      packageJsonPath,
      "--expected-package-json-sha256",
      await fileSha256(packageJsonPath),
      "--package-lock",
      packageLockPath,
      "--expected-lockfile-sha256",
      await fileSha256(packageLockPath),
    ];

    try {
      const accepted = runLauncherFileBoundary({
        nodePath: process.execPath,
        expectedNodeSha256: await fileSha256(process.execPath),
        scriptPath: validatorPath,
        expectedScriptSha256: await fileSha256(validatorPath),
        scriptArguments: exactArguments,
      });
      assert.equal(accepted.error, undefined);
      assert.equal(accepted.status, 0);
      assert.equal(accepted.stderr, "");
      assert.equal(accepted.stdout, "accepted\n");
      assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), exactArguments);

      const replaceArgument = (index: number, value: string) => {
        const mutated = [...exactArguments];
        mutated[index] = value;
        return mutated;
      };
      for (const rejectedArguments of [
        replaceArgument(1, "SBOM"),
        replaceArgument(1, "status"),
        replaceArgument(0, "--RUN-PINNED-NPM"),
        replaceArgument(2, "--NPM"),
        replaceArgument(4, "--expected-npm-cli-SHA256"),
        [...exactArguments, "--json"],
      ]) {
        await rm(marker, { force: true });
        const rejected = runLauncherFileBoundary({
          nodePath: process.execPath,
          expectedNodeSha256: await fileSha256(process.execPath),
          scriptPath: validatorPath,
          expectedScriptSha256: await fileSha256(validatorPath),
          scriptArguments: rejectedArguments,
        });
        assert.equal(rejected.status, 1);
        assert.equal(rejected.stdout, "");
        assert.match(rejected.stderr, /^Trusted Node launch failed\.\r?\n$/u);
        await assert.rejects(readFile(marker), { code: "ENOENT" });
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "the launcher npm lease blocks a good-to-bad-to-good transitive file race",
  windowsOnly,
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-trusted-npm-lock-"),
    );
    const npmPath = path.join(fixture, "npm.cmd");
    const npmRoot = path.join(fixture, "node_modules", "npm");
    const npmCliPath = path.join(npmRoot, "bin", "npm-cli.js");
    const npmLibPath = path.join(npmRoot, "lib", "cli.js");
    const goodLibrary = "export const reviewed = true;\n";
    const badLibrary = "export const reviewed = false;\n";

    await mkdir(path.dirname(npmCliPath), { recursive: true });
    await mkdir(path.dirname(npmLibPath), { recursive: true });
    await writeFile(npmPath, "@exit /b 0\r\n", "utf8");
    await writeFile(npmCliPath, 'import "../lib/cli.js";\n', "utf8");
    await writeFile(npmLibPath, goodLibrary, "utf8");
    const expectedTreeHash = npmTreeSha256(npmRoot, npmPath);

    try {
      const lines = [
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        `$launcher = ${psLiteral(launcherPath)}`,
        `$npmPath = ${psLiteral(npmPath)}`,
        `$npmRoot = ${psLiteral(npmRoot)}`,
        `$npmLib = ${psLiteral(npmLibPath)}`,
        `$good = ${psLiteral(goodLibrary)}`,
        `$bad = ${psLiteral(badLibrary)}`,
        `$expected = ${psLiteral(expectedTreeHash)}`,
        "$tokens = $null",
        "$errors = $null",
        "$ast = [Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$tokens, [ref]$errors)",
        "if (@($errors).Count -ne 0) { throw 'parse' }",
        "$functionAsts = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false) | Sort-Object { $_.Extent.StartOffset })",
        "foreach ($functionAst in $functionAsts) { . ([ScriptBlock]::Create($functionAst.Extent.Text)) }",
        "$lease = Enter-HmaNpmTreeLease -NpmPath $npmPath -NpmRoot $npmRoot -ExpectedSha256 $expected",
        "try {",
        "  $mutation = @(",
        "    '$ErrorActionPreference = ''Stop'''",
        "    ('$path = ' + (\"'\" + $npmLib.Replace(\"'\", \"''\") + \"'\"))",
        "    ('$bad = ' + (\"'\" + $bad.Replace(\"'\", \"''\") + \"'\"))",
        "    ('$good = ' + (\"'\" + $good.Replace(\"'\", \"''\") + \"'\"))",
        "    '$badBlocked = $false'",
        "    '$goodBlocked = $false'",
        "    'try { [IO.File]::WriteAllText($path, $bad) } catch { $badBlocked = $true }'",
        "    'try { [IO.File]::WriteAllText($path, $good) } catch { $goodBlocked = $true }'",
        "    '[pscustomobject]@{ badBlocked = $badBlocked; goodBlocked = $goodBlocked } | ConvertTo-Json -Compress'",
        "    'if (-not $badBlocked -or -not $goodBlocked) { exit 41 }'",
        "  ) -join ';'",
        `  $mutator = & ${psLiteral(powerShell51)} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $mutation`,
        "  $mutatorExit = $LASTEXITCODE",
        "  $mutationResult = $mutator | ConvertFrom-Json",
        "  $postValid = Assert-HmaNpmTreeLease -Lease $lease -ExpectedSha256 $expected",
        "  $contentUnchanged = ([IO.File]::ReadAllText($npmLib) -ceq $good)",
        "  [pscustomobject]@{",
        "    mutatorExit = $mutatorExit",
        "    badBlocked = [bool]$mutationResult.badBlocked",
        "    goodBlocked = [bool]$mutationResult.goodBlocked",
        "    postValid = [bool]$postValid",
        "    contentUnchanged = $contentUnchanged",
        "  } | ConvertTo-Json -Compress",
        "} finally {",
        "  Exit-HmaNpmTreeLease -Lease $lease",
        "}",
      ];
      const result = spawnSync(
        powerShell51,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          lines.join("\r\n"),
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        },
      );

      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), {
        mutatorExit: 0,
        badBlocked: true,
        goodBlocked: true,
        postValid: true,
        contentUnchanged: true,
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "a user-writable npm tree is rejected before a transient shadow module can run",
  windowsOnly,
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-writable-npm-tree-"),
    );
    const npmPath = path.join(fixture, "npm.cmd");
    const npmRoot = path.join(fixture, "node_modules", "npm");
    const npmCliPath = path.join(npmRoot, "bin", "npm-cli.js");
    const marker = path.join(fixture, "shadow-ran.txt");
    await mkdir(path.dirname(npmCliPath), { recursive: true });
    await writeFile(npmPath, "@exit /b 0\r\n", "utf8");
    await writeFile(npmCliPath, "export {};\n", "utf8");

    try {
      const lines = [
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        `$launcher = ${psLiteral(launcherPath)}`,
        `$npmPath = ${psLiteral(npmPath)}`,
        `$npmRoot = ${psLiteral(npmRoot)}`,
        `$nodeDirectory = ${psLiteral(fixture)}`,
        `$expected = ${psLiteral(npmTreeSha256(npmRoot, npmPath))}`,
        "$tokens = $null",
        "$errors = $null",
        "$ast = [Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$tokens, [ref]$errors)",
        "$functionAsts = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false) | Sort-Object { $_.Extent.StartOffset })",
        "foreach ($functionAst in $functionAsts) { . ([ScriptBlock]::Create($functionAst.Extent.Text)) }",
        "$aclRejected = $false",
        "try { $null = Assert-HmaProtectedDirectoryAcl -DirectoryPath $npmRoot } catch { $aclRejected = $true }",
        "$fileAclRejected = $false",
        `try { $null = Assert-HmaProtectedFileAcl -FilePath ${psLiteral(npmCliPath)} } catch { $fileAclRejected = $true }`,
        "$lease = Enter-HmaNpmTreeLease -NpmPath $npmPath -NpmRoot $npmRoot -ExpectedSha256 $expected",
        "$leaseRejected = $false",
        "try {",
        "  try { $null = Assert-HmaProtectedNpmLeaseAcl -Lease $lease -NodeDirectory $nodeDirectory } catch { $leaseRejected = $true }",
        `  if (-not $aclRejected -or -not $fileAclRejected -or -not $leaseRejected) { [IO.File]::WriteAllText(${psLiteral(marker)}, 'ran') }`,
        "  [pscustomobject]@{ aclRejected = $aclRejected; fileAclRejected = $fileAclRejected; leaseRejected = $leaseRejected } | ConvertTo-Json -Compress",
        "} finally {",
        "  Exit-HmaNpmTreeLease -Lease $lease",
        "}",
      ];
      const result = spawnSync(
        powerShell51,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          lines.join("\r\n"),
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        },
      );

      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), {
        aclRejected: true,
        fileAclRejected: true,
        leaseRejected: true,
      });
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "relative, reparse-point, misplaced, and preload-shaped inputs fail closed",
  windowsOnly,
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "hma-trusted-node-invalid-"),
    );
    const auditDirectory = path.join(fixture, "scripts", "audit");
    const fixtureScript = path.join(
      auditDirectory,
      "reviewed-fixture.mjs",
    );
    const reviewedMarker = path.join(fixture, "must-not-run.txt");
    const nodeJunction = path.join(fixture, "node-junction");
    const junctionProject = path.join(fixture, "junction-project");
    const auditJunction = path.join(
      junctionProject,
      "scripts",
      "audit",
    );
    const misplacedScript = path.join(fixture, "misplaced-fixture.mjs");
    const copiedNode = path.join(fixture, "node.exe");

    await mkdir(auditDirectory, { recursive: true });
    await mkdir(path.dirname(auditJunction), { recursive: true });
    await writeFile(
      fixtureScript,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(reviewedMarker)}, "ran");\n`,
      "utf8",
    );
    await writeFile(
      misplacedScript,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(reviewedMarker)}, "ran");\n`,
      "utf8",
    );
    await copyFile(process.execPath, copiedNode);
    await symlink(path.dirname(process.execPath), nodeJunction, "junction");
    await symlink(auditDirectory, auditJunction, "junction");
    const expectedNodeSha256 = await fileSha256(process.execPath);
    const expectedScriptSha256 = await fileSha256(fixtureScript);

    const scenarios = [
      {
        nodePath: "node.exe",
        expectedNodeSha256,
        scriptPath: fixtureScript,
        expectedScriptSha256,
        scriptArguments: [],
      },
      {
        nodePath: path.join(nodeJunction, "node.exe"),
        expectedNodeSha256,
        scriptPath: fixtureScript,
        expectedScriptSha256,
        scriptArguments: [],
      },
      {
        nodePath: copiedNode,
        expectedNodeSha256: await fileSha256(copiedNode),
        scriptPath: fixtureScript,
        expectedScriptSha256,
        scriptArguments: [],
      },
      {
        nodePath: process.execPath,
        expectedNodeSha256,
        scriptPath: path.relative(process.cwd(), fixtureScript),
        expectedScriptSha256,
        scriptArguments: [],
      },
      {
        nodePath: process.execPath,
        expectedNodeSha256,
        scriptPath: misplacedScript,
        expectedScriptSha256,
        scriptArguments: [],
      },
      {
        nodePath: process.execPath,
        expectedNodeSha256,
        scriptPath: path.join(auditJunction, path.basename(fixtureScript)),
        expectedScriptSha256,
        scriptArguments: [],
      },
      {
        nodePath: process.execPath,
        expectedNodeSha256,
        scriptPath: fixtureScript,
        expectedScriptSha256,
        scriptArguments: ["--require=hostile-preload.cjs"],
      },
      {
        nodePath: process.execPath,
        expectedNodeSha256,
        scriptPath: fixtureScript,
        expectedScriptSha256,
        scriptArguments: ["unsafe\r\nargument"],
      },
      {
        nodePath: process.execPath,
        expectedNodeSha256,
        scriptPath: fixtureScript,
        expectedScriptSha256,
        scriptArguments: ["x".repeat(8193)],
      },
      {
        nodePath: process.execPath,
        expectedNodeSha256: "0".repeat(64),
        scriptPath: fixtureScript,
        expectedScriptSha256,
        scriptArguments: [],
      },
      {
        nodePath: process.execPath,
        expectedNodeSha256,
        scriptPath: fixtureScript,
        expectedScriptSha256: "0".repeat(64),
        scriptArguments: [],
      },
      {
        nodePath: process.execPath,
        expectedNodeSha256,
        scriptPath: fixtureScript,
        expectedScriptSha256,
        scriptArguments: [],
        encodedScriptArguments: "A",
      },
    ];

    try {
      for (const scenario of scenarios) {
        await rm(reviewedMarker, { force: true });
        const result = runLauncher(scenario);
        const combined = `${result.stdout}\n${result.stderr}`;

        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "Trusted Node launch failed.\r\n");
        for (const forbidden of [
          fixture,
          fixtureScript,
          misplacedScript,
          process.execPath,
          "hostile-preload",
          "unsafe",
        ]) {
          assert.equal(combined.includes(forbidden), false);
        }
        await assert.rejects(readFile(reviewedMarker), { code: "ENOENT" });
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
