import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const windowsOnly = { skip: process.platform !== "win32" };
const integrityModulePath = path.resolve("scripts/windows/SecureLocalIntegrity.psm1");
const secretsModulePath = path.resolve("scripts/windows/SecureLocalSecrets.psm1");
const startScriptPath = path.resolve("scripts/windows/start-secure-local.ps1");
const powerShell51 = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const upstreamBase = "1238189b7017601d21e3579d041480ce3773e191";
const commit = "d".repeat(40);

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runPowerShell(
  lines: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(
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
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
    );
  } catch {
    throw new Error("The startup-integrity security fixture failed.");
  }
}

function parseSafeRecord<T>(stdout: string): T {
  try {
    return JSON.parse(stdout.trim()) as T;
  } catch {
    throw new Error("The startup-integrity fixture returned an invalid safe result.");
  }
}

interface FileRecord {
  path: string;
  size: number;
  sha256: string;
}

interface SyntheticFixture {
  root: string;
  state: string;
  appRoot: string;
  bootstrap: string;
  nodePath: string;
  installPath: string;
  manifestPath: string;
  manifest: {
    commit: string;
    nodeSha256: string;
    runtimeFiles: FileRecord[];
    bootstrapFiles: FileRecord[];
  };
  install: {
    version: number;
    appRoot: string;
    stateRoot: string;
    nodePath: string;
    port: number;
    upstreamBase: string;
    commit: string;
    manifestSha256: string;
    bootstrapHashes: Record<string, string>;
  };
}

const runtimeContents: Record<string, string> = {
  "package.json": '{"private":true}',
  ".next/server/app.js": "reviewed runtime",
  "node_modules/next/dist/bin/next": "reviewed next entry",
};

const defaultBootstrapContents: Record<string, string> = {
  "start-secure-local.ps1": "# synthetic reviewed start",
  "open-secure-local.ps1": "# synthetic reviewed open",
  "connect-secure-local.ps1": "# synthetic reviewed connector",
  "SecureLocalIntegrity.psm1": "# synthetic reviewed integrity",
  "SecureLocalRuntime.psm1": "# synthetic reviewed runtime",
  "SecureLocalSecrets.psm1": "# synthetic reviewed secrets",
};

const bootstrapHashNames: Record<string, string> = {
  "start-secure-local.ps1": "start",
  "open-secure-local.ps1": "open",
  "connect-secure-local.ps1": "connector",
  "SecureLocalIntegrity.psm1": "integrity",
  "SecureLocalRuntime.psm1": "runtime",
  "SecureLocalSecrets.psm1": "secrets",
};

async function writeTree(root: string, files: Record<string, string>): Promise<FileRecord[]> {
  const records: FileRecord[] = [];
  for (const relative of Object.keys(files).sort()) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    const bytes = Buffer.from(files[relative], "utf8");
    await writeFile(target, bytes);
    records.push({ path: relative, size: bytes.length, sha256: sha256(bytes) });
  }
  return records;
}

async function makePrivate(state: string): Promise<void> {
  await runPowerShell([
    "Set-StrictMode -Version Latest",
    "$ErrorActionPreference = 'Stop'",
    `Import-Module ${psLiteral(secretsModulePath)} -Force`,
    `Set-HmaPrivateAcl -LiteralPath ${psLiteral(state)}`,
    `if (-not (Test-HmaPrivateAcl -LiteralPath ${psLiteral(state)} -Recurse)) { throw 'Fixture ACL setup failed.' }`,
  ]);
}

async function createFixture(
  bootstrapOverrides: Record<string, string> = {},
  nodeContents = "synthetic reviewed node",
): Promise<SyntheticFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hma-integrity-"));
  const state = path.join(root, "state");
  const appRoot = path.join(state, "runtime", commit);
  const bootstrap = path.join(state, "bootstrap");
  const nodePath = path.join(root, "node.exe");
  await Promise.all([
    mkdir(appRoot, { recursive: true }),
    mkdir(bootstrap, { recursive: true }),
    mkdir(path.join(state, "vault"), { recursive: true }),
    mkdir(path.join(state, "edge-profile"), { recursive: true }),
    mkdir(path.join(state, "oauth-temp"), { recursive: true }),
  ]);

  const runtimeFiles = await writeTree(appRoot, runtimeContents);
  const bootstrapContents = { ...defaultBootstrapContents, ...bootstrapOverrides };
  const installedBootstrapFiles = await writeTree(bootstrap, bootstrapContents);
  await writeFile(nodePath, nodeContents, "utf8");
  await writeFile(path.join(state, "secrets.dpapi"), "intentionally invalid", "utf8");

  const bootstrapFiles = installedBootstrapFiles.map((entry) => ({
    ...entry,
    path: `scripts/windows/${entry.path}`,
  }));
  const manifest: SyntheticFixture["manifest"] = {
    commit,
    nodeSha256: sha256(nodeContents),
    runtimeFiles,
    bootstrapFiles,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const manifestPath = path.join(state, "integrity.json");
  await writeFile(manifestPath, manifestBytes);

  const bootstrapHashes = Object.fromEntries(
    installedBootstrapFiles.map((entry) => [
      bootstrapHashNames[entry.path],
      entry.sha256,
    ]),
  );
  const install: SyntheticFixture["install"] = {
    version: 1,
    appRoot,
    stateRoot: state,
    nodePath,
    port: 37645,
    upstreamBase,
    commit,
    manifestSha256: sha256(manifestBytes),
    bootstrapHashes,
  };
  const installPath = path.join(state, "install.json");
  await writeFile(installPath, JSON.stringify(install), "utf8");
  await makePrivate(state);

  return {
    root,
    state,
    appRoot,
    bootstrap,
    nodePath,
    installPath,
    manifestPath,
    manifest,
    install,
  };
}

async function rewriteInstall(
  fixture: SyntheticFixture,
  value: SyntheticFixture["install"],
): Promise<void> {
  await writeFile(fixture.installPath, JSON.stringify(value), "utf8");
}

async function expectIntegrityFailure(state: string): Promise<void> {
  const { stdout, stderr } = await runPowerShell([
    "Set-StrictMode -Version Latest",
    "$ErrorActionPreference = 'Stop'",
    `Import-Module ${psLiteral(integrityModulePath)} -Force`,
    "$failed = $false",
    "$sanitized = $false",
    `try { $null = Assert-HmaStartupIntegrity -StateRoot ${psLiteral(state)} } catch { $failed = $true; $sanitized = ($_.Exception.Message -ceq 'Startup integrity verification failed.') }`,
    "[pscustomobject]@{ failed = $failed; sanitized = $sanitized } | ConvertTo-Json -Compress",
  ]);
  assert.deepEqual(parseSafeRecord(stdout), { failed: true, sanitized: true });
  assert.equal(stderr.length, 0);
  assert.equal(stdout.includes(state), false);
}

test(
  "startup integrity accepts only the exact private reviewed runtime and returns a non-secret config",
  windowsOnly,
  async () => {
    const fixture = await createFixture();
    try {
      const { stdout, stderr } = await runPowerShell([
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        `Import-Module ${psLiteral(integrityModulePath)} -Force`,
        `$config = Assert-HmaStartupIntegrity -StateRoot ${psLiteral(fixture.state)}`,
        "[pscustomobject]@{ valid = ($config.version -eq 1 -and $config.port -eq 37645); propertyCount = @($config.PSObject.Properties).Count } | ConvertTo-Json -Compress",
      ]);
      assert.deepEqual(parseSafeRecord(stdout), { valid: true, propertyCount: 9 });
      assert.equal(stderr.length, 0);
      assert.equal(stdout.includes(fixture.state), false);
      assert.equal(stdout.includes(fixture.install.manifestSha256), false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "startup integrity rejects changed runtime or Node bytes, missing and added files, forbidden names, manifest mismatch, and schema drift",
  windowsOnly,
  async () => {
    const mutations: Array<(fixture: SyntheticFixture) => Promise<void>> = [
      async (fixture) => {
        await writeFile(path.join(fixture.appRoot, "package.json"), '{"private":false}', "utf8");
      },
      async (fixture) => {
        await writeFile(fixture.nodePath, "changed synthetic node", "utf8");
      },
      async (fixture) => {
        await rm(path.join(fixture.appRoot, ".next", "server", "app.js"));
      },
      async (fixture) => {
        await writeFile(path.join(fixture.appRoot, "unmanifested.js"), "extra", "utf8");
      },
      async (fixture) => {
        await writeFile(path.join(fixture.appRoot, ".env.local"), "forbidden", "utf8");
      },
      async (fixture) => {
        await rewriteInstall(fixture, {
          ...fixture.install,
          manifestSha256: "0".repeat(64),
        });
      },
      async (fixture) => {
        await writeFile(
          fixture.installPath,
          JSON.stringify({ ...fixture.install, unexpected: true }),
          "utf8",
        );
      },
      async (fixture) => {
        await writeFile(path.join(fixture.state, "oauth-temp", "leftover"), "not empty", "utf8");
      },
    ];

    for (const mutate of mutations) {
      const fixture = await createFixture();
      try {
        await mutate(fixture);
        await expectIntegrityFailure(fixture.state);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  },
);

test(
  "startup integrity rejects runtime and Edge-root junctions but never traverses the opaque live Edge profile",
  windowsOnly,
  async () => {
    const runtimeFixture = await createFixture();
    try {
      const external = path.join(runtimeFixture.root, "external-runtime");
      await mkdir(external);
      await writeFile(path.join(external, "app.js"), "reviewed runtime", "utf8");
      const nested = path.join(runtimeFixture.appRoot, ".next", "server");
      await rm(nested, { recursive: true, force: true });
      await symlink(external, nested, "junction");
      await expectIntegrityFailure(runtimeFixture.state);
    } finally {
      await rm(runtimeFixture.root, { recursive: true, force: true });
    }

    const edgeFixture = await createFixture();
    try {
      const external = path.join(edgeFixture.root, "live-edge-data");
      await mkdir(external);
      await writeFile(path.join(external, "locked-changing-child"), randomUUID(), "utf8");
      await symlink(
        external,
        path.join(edgeFixture.state, "edge-profile", "opaque-child"),
        "junction",
      );
      const { stdout, stderr } = await runPowerShell([
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        `Import-Module ${psLiteral(integrityModulePath)} -Force`,
        `$config = Assert-HmaStartupIntegrity -StateRoot ${psLiteral(edgeFixture.state)}`,
        "[bool]($config.port -eq 37645) | ConvertTo-Json -Compress",
      ]);
      assert.equal(parseSafeRecord(stdout), true);
      assert.equal(stderr.length, 0);
    } finally {
      await rm(edgeFixture.root, { recursive: true, force: true });
    }

    const edgeRootFixture = await createFixture();
    try {
      const external = path.join(edgeRootFixture.root, "external-edge-root");
      await mkdir(external);
      await rm(path.join(edgeRootFixture.state, "edge-profile"), {
        recursive: true,
        force: true,
      });
      await symlink(
        external,
        path.join(edgeRootFixture.state, "edge-profile"),
        "junction",
      );
      await expectIntegrityFailure(edgeRootFixture.state);
    } finally {
      await rm(edgeRootFixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "startup integrity rejects a non-private state root before trusting control files",
  windowsOnly,
  async () => {
    const fixture = await createFixture();
    try {
      await runPowerShell([
        `$null = & "$env:SystemRoot\\System32\\icacls.exe" ${psLiteral(fixture.state)} '/grant' '*S-1-1-0:(OI)(CI)R'`,
        "if ($LASTEXITCODE -ne 0) { throw 'Could not weaken the fixture ACL.' }",
      ]);
      await expectIntegrityFailure(fixture.state);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "the service launcher completes sanitized integrity checks before importing secrets, parsing DPAPI, or executing Node",
  windowsOnly,
  async () => {
    const importMarker = path.join(os.tmpdir(), `hma-dpapi-import-${randomUUID()}`);
    const nodeMarker = path.join(os.tmpdir(), `hma-node-exec-${randomUUID()}`);
    const realIntegrity = await readFile(integrityModulePath, "utf8");
    const realStart = await readFile(startScriptPath, "utf8");
    const markerSecrets = [
      `Set-Content -LiteralPath ${psLiteral(importMarker)} -Value 'imported'`,
      "function Unprotect-HmaSecretBundle { throw 'DPAPI parser reached' }",
      "Export-ModuleMember -Function 'Unprotect-HmaSecretBundle'",
    ].join("\r\n");
    const fakeNode = `@echo executed>${nodeMarker}\r\n`;
    const fixture = await createFixture(
      {
        "SecureLocalIntegrity.psm1": realIntegrity,
        "SecureLocalSecrets.psm1": markerSecrets,
        "start-secure-local.ps1": realStart,
      },
      fakeNode,
    );

    try {
      await writeFile(path.join(fixture.appRoot, "package.json"), "tampered", "utf8");
      const integrityHash = fixture.install.bootstrapHashes.integrity;
      const { stdout, stderr } = await runPowerShell([
        "$message = ''",
        `try { & ${psLiteral(path.join(fixture.bootstrap, "start-secure-local.ps1"))} -StateRoot ${psLiteral(fixture.state)} -IntegrityModuleHash ${psLiteral(integrityHash)} } catch { $message = $_.Exception.Message }`,
        `[pscustomobject]@{ integrityOnly = ($message -ceq 'Startup integrity verification failed.'); secretModuleSkipped = (-not [IO.File]::Exists(${psLiteral(importMarker)})); nodeSkipped = (-not [IO.File]::Exists(${psLiteral(nodeMarker)})); noDpapiDiagnostic = ($message -cnotmatch 'DPAPI|secret|node|path|hash|file') } | ConvertTo-Json -Compress`,
      ]);
      assert.deepEqual(parseSafeRecord(stdout), {
        integrityOnly: true,
        secretModuleSkipped: true,
        nodeSkipped: true,
        noDpapiDiagnostic: true,
      });
      assert.equal(stderr.length, 0);
      assert.equal(stdout.includes(fixture.state), false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(importMarker, { force: true });
      await rm(nodeMarker, { force: true });
    }
  },
);
