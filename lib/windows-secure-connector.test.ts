import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const windowsOnly = { skip: process.platform !== "win32" };
const connectorScriptPath = path.resolve(
  "scripts/windows/connect-claude-secure.ps1",
);
const integrityModulePath = path.resolve(
  "scripts/windows/SecureLocalIntegrity.psm1",
);
const runtimeModulePath = path.resolve("scripts/windows/SecureLocalRuntime.psm1");
const secretsModulePath = path.resolve("scripts/windows/SecureLocalSecrets.psm1");
const powerShell51 = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const upstreamBase = "1238189b7017601d21e3579d041480ce3773e191";
const commit = "d".repeat(40);
const attemptId = "A".repeat(43);

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runPowerShell(
  lines: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
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
      env: { ...process.env, ...extraEnv },
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    },
  );
}

function parseSafeRecord<T>(stdout: string): T {
  try {
    const lastLine = stdout.trim().split(/\r?\n/).at(-1);
    return JSON.parse(lastLine ?? "") as T;
  } catch {
    throw new Error("The Windows connector fixture returned an invalid safe result.");
  }
}

interface FileRecord {
  path: string;
  size: number;
  sha256: string;
}

interface ConnectorFixture {
  root: string;
  state: string;
  bootstrap: string;
  connector: string;
  connectorHash: string;
  importMarker: string;
}

const bootstrapHashNames: Record<string, string> = {
  "start-secure-local.ps1": "start",
  "open-secure-local.ps1": "open",
  "connect-claude-secure.ps1": "connector",
  "SecureLocalIntegrity.psm1": "integrity",
  "SecureLocalRuntime.psm1": "runtime",
  "SecureLocalSecrets.psm1": "secrets",
  "oauth-handoff-extension/manifest.json": "extensionManifest",
  "oauth-handoff-extension/callback.js": "extensionCallback",
};

async function writeTree(
  root: string,
  files: Record<string, Uint8Array | string>,
): Promise<FileRecord[]> {
  const records: FileRecord[] = [];
  for (const relative of Object.keys(files).sort()) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    const value = files[relative];
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
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

async function createFixture(): Promise<ConnectorFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hma-connector-"));
  const state = path.join(root, "state");
  const bootstrap = path.join(state, "bootstrap");
  const appRoot = path.join(state, "runtime", commit);
  const connector = path.join(bootstrap, "connect-claude-secure.ps1");
  const nodePath = path.join(root, "node.exe");
  const importMarker = path.join(root, `secret-import-${randomUUID()}`);
  await Promise.all([
    mkdir(appRoot, { recursive: true }),
    mkdir(bootstrap, { recursive: true }),
    mkdir(path.join(state, "vault"), { recursive: true }),
    mkdir(path.join(state, "edge-profile"), { recursive: true }),
    mkdir(path.join(state, "oauth-temp"), { recursive: true }),
  ]);

  const syntheticSecrets = [
    `Set-Content -LiteralPath ${psLiteral(importMarker)} -Value 'imported'`,
    "function Unprotect-HmaSecretBundle {",
    "  [pscustomobject]@{ version = 1; appPassword = ('a' * 64); authSecret = ('b' * 64); vaultEncryptionSecret = ('c' * 64) }",
    "}",
    "function Set-HmaPrivateAcl { param([Parameter(Mandatory)][string]$LiteralPath) }",
    "function Test-HmaPrivateAcl { param([Parameter(Mandatory)][string]$LiteralPath,[switch]$Recurse) return $true }",
    "Export-ModuleMember -Function @('Unprotect-HmaSecretBundle','Set-HmaPrivateAcl','Test-HmaPrivateAcl')",
  ].join("\r\n");

  const bootstrapFiles = await writeTree(bootstrap, {
    "start-secure-local.ps1": "# synthetic reviewed start",
    "open-secure-local.ps1": "# synthetic reviewed open",
    "connect-claude-secure.ps1": await readFile(connectorScriptPath),
    "SecureLocalIntegrity.psm1": await readFile(integrityModulePath),
    "SecureLocalRuntime.psm1": await readFile(runtimeModulePath),
    "SecureLocalSecrets.psm1": syntheticSecrets,
    "oauth-handoff-extension/manifest.json": '{"manifest_version":3}',
    "oauth-handoff-extension/callback.js": '"use strict";',
  });
  const runtimeFiles = await writeTree(appRoot, {
    "package.json": '{"private":true}',
  });
  await writeFile(nodePath, "synthetic reviewed node", "utf8");
  await writeFile(path.join(state, "secrets.dpapi"), "intentionally invalid", "utf8");

  const manifest = {
    commit,
    nodeSha256: sha256("synthetic reviewed node"),
    runtimeFiles,
    bootstrapFiles: bootstrapFiles.map((entry) => ({
      ...entry,
      path: `scripts/windows/${entry.path}`,
    })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const manifestPath = path.join(state, "integrity.json");
  await writeFile(manifestPath, manifestBytes);
  const bootstrapHashes = Object.fromEntries(
    bootstrapFiles.map((entry) => [
      bootstrapHashNames[entry.path],
      entry.sha256,
    ]),
  );
  const install = {
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
  await writeFile(
    path.join(state, "install.json"),
    JSON.stringify(install),
    "utf8",
  );
  await makePrivate(state);
  return {
    root,
    state,
    bootstrap,
    connector,
    connectorHash: bootstrapHashes.connector,
    importMarker,
  };
}

type Scenario =
  | "success"
  | "pre-start-mismatch"
  | "post-start-mismatch"
  | "post-status-mismatch"
  | "status-http-error"
  | "integrity-tamper";

interface ScenarioResult {
  failed: boolean;
  sanitized: boolean;
  listenerChecks: number;
  passwordPosts: number;
  edgeStarts: number;
  stopped: number;
  secretModuleSkipped: boolean;
  oauthChildren: number;
  canaryAbsentAtLaunch: boolean;
  filePath: string;
  arguments: string[];
  bodySchemas: string[];
  requestKinds: string[];
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const fixture = await createFixture();
  try {
    const lines = [
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      `$state = ${psLiteral(fixture.state)}`,
      `$connector = ${psLiteral(fixture.connector)}`,
      `$connectorHash = ${psLiteral(fixture.connectorHash)}`,
      `$importMarker = ${psLiteral(fixture.importMarker)}`,
      `$scenario = ${psLiteral(scenario)}`,
      "$appRoot = Join-Path (Join-Path $state 'runtime') ('d' * 40)",
      "$nodePath = Join-Path (Split-Path -Parent $state) 'node.exe'",
      "$stableProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)",
      "$stableProgramFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)",
      "$script:edgeBases = @(@($stableProgramFiles, $stableProgramFilesX86) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)",
      "$script:scenario = $scenario",
      "$script:listenerChecks = 0",
      "$script:passwordPosts = 0",
      "$script:edgeStarts = 0",
      "$script:stopped = 0",
      "$script:edgeRunning = $false",
      "$script:edgeQueries = 0",
      "$script:edgeFilePath = ''",
      "$script:capturedEdgeArguments = @()",
      "$script:bodySchemas = @()",
      "$script:requestKinds = @()",
      "$script:canaryAbsentAtLaunch = $false",
      "[Environment]::SetEnvironmentVariable('HMA_CONNECT_CANARY', 'must-be-removed', 'Process')",
      "if ($scenario -ceq 'integrity-tamper') { [IO.File]::WriteAllText((Join-Path $appRoot 'package.json'), 'tampered') }",
      "function Get-Item {",
      "  [CmdletBinding()] param([Parameter(Position=0)][string]$LiteralPath,[switch]$Force)",
      "  foreach ($base in $script:edgeBases) {",
      "    $candidate = Join-Path $base 'Microsoft\\Edge\\Application\\msedge.exe'",
      "    if ([string]::Equals($candidate, $LiteralPath, [StringComparison]::OrdinalIgnoreCase) -or $candidate.StartsWith($LiteralPath.TrimEnd('\\') + '\\', [StringComparison]::OrdinalIgnoreCase)) {",
      "      $isLeaf = [string]::Equals($candidate, $LiteralPath, [StringComparison]::OrdinalIgnoreCase)",
      "      return [pscustomobject]@{ FullName = $LiteralPath; PSIsContainer = (-not $isLeaf); Attributes = $(if ($isLeaf) { [IO.FileAttributes]::Normal } else { [IO.FileAttributes]::Directory }) }",
      "    }",
      "  }",
      "  Microsoft.PowerShell.Management\\Get-Item @PSBoundParameters",
      "}",
      "function Get-AuthenticodeSignature {",
      "  [CmdletBinding()] param([string]$LiteralPath)",
      "  [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US' } }",
      "}",
      "$exactServiceCommand = '\"' + $nodePath + '\" \"' + (Join-Path $appRoot 'node_modules\\next\\dist\\bin\\next') + '\" start --hostname 127.0.0.1 --port 37645'",
      "function Get-NetTCPConnection {",
      "  [CmdletBinding()] param([string]$LocalAddress,[int]$LocalPort,[string]$State)",
      "  $script:listenerChecks += 1",
      "  if (($script:scenario -ceq 'pre-start-mismatch' -and $script:listenerChecks -eq 1) -or",
      "      ($script:scenario -ceq 'post-start-mismatch' -and $script:listenerChecks -eq 2) -or",
      "      ($script:scenario -ceq 'post-status-mismatch' -and $script:listenerChecks -eq 4)) { return @() }",
      "  [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 37645; State = 'Listen'; OwningProcess = 42 }",
      "}",
      "function Get-CimInstance {",
      "  [CmdletBinding()] param([string]$ClassName,[string]$Filter)",
      "  if ($Filter -match 'ProcessId\\s*=\\s*42') { return [pscustomobject]@{ ProcessId = 42; ExecutablePath = $nodePath; CommandLine = $exactServiceCommand } }",
      "  if ($script:edgeRunning) {",
      "    $script:edgeQueries += 1",
      "    if ($script:scenario -ceq 'success' -and $script:edgeQueries -ge 2) { $script:edgeRunning = $false; return @() }",
      "    return [pscustomobject]@{ ProcessId = 84; ExecutablePath = $script:edgeFilePath; CommandLine = ('\"' + $script:edgeFilePath + '\" ' + ($script:capturedEdgeArguments -join ' ')) }",
      "  }",
      "  return @()",
      "}",
      "function Invoke-WebRequest {",
      "  [CmdletBinding()] param([string]$Uri,[string]$Method,[string]$ContentType,[string]$Body,[switch]$UseBasicParsing,[int]$MaximumRedirection,[int]$TimeoutSec)",
      "  $script:passwordPosts += 1",
      "  $payload = ConvertFrom-Json -InputObject $Body",
      "  $script:bodySchemas += ((@($payload.PSObject.Properties.Name) | Sort-Object) -join ',')",
      "  if ($Uri.EndsWith('/start', [StringComparison]::Ordinal)) {",
      "    $script:requestKinds += 'start'",
      `    return [pscustomobject]@{ StatusCode = 200; Content = '{"attemptId":"${attemptId}"}'; Headers = @{} }`,
      "  }",
      "  $script:requestKinds += 'status'",
      "  if ($script:scenario -ceq 'status-http-error') { throw 'Synthetic HTTP failure.' }",
      "  return [pscustomobject]@{ StatusCode = 200; Content = '{\"status\":\"done\",\"provider\":\"anthropic\",\"displayLabel\":\"Claude account\"}'; Headers = @{} }",
      "}",
      "function Start-Process {",
      "  [CmdletBinding()] param([string]$FilePath,[object[]]$ArgumentList,[string]$WindowStyle)",
      "  $script:edgeStarts += 1",
      "  $script:edgeFilePath = $FilePath",
      "  $script:capturedEdgeArguments = @($ArgumentList)",
      "  $script:canaryAbsentAtLaunch = ([Environment]::GetEnvironmentVariable('HMA_CONNECT_CANARY', 'Process') -eq $null)",
      "  $script:edgeRunning = $true",
      "}",
      "function Stop-Process { [CmdletBinding()] param([int]$Id,[switch]$Force) $script:stopped += 1; $script:edgeRunning = $false }",
      "function Wait-Process { [CmdletBinding()] param([int]$Id,[int]$Timeout) }",
      "function Start-Sleep { [CmdletBinding()] param([int]$Milliseconds) }",
      "$failed = $false",
      "$message = ''",
      "try { . $connector -StateRoot $state -ExpectedConnectorHash $connectorHash } catch { $failed = $true; $message = $_.Exception.Message }",
      "$oauthChildren = @(Microsoft.PowerShell.Management\\Get-ChildItem -LiteralPath (Join-Path $state 'oauth-temp') -Force).Count",
      "[pscustomobject]@{",
      "  failed = $failed",
      "  sanitized = ((-not $failed) -or $message -ceq 'Secure Claude connection failed.')",
      "  listenerChecks = $script:listenerChecks",
      "  passwordPosts = $script:passwordPosts",
      "  edgeStarts = $script:edgeStarts",
      "  stopped = $script:stopped",
      "  secretModuleSkipped = (-not [IO.File]::Exists($importMarker))",
      "  oauthChildren = $oauthChildren",
      "  canaryAbsentAtLaunch = $script:canaryAbsentAtLaunch",
      "  filePath = $script:edgeFilePath",
      "  arguments = @($script:capturedEdgeArguments)",
      "  bodySchemas = @($script:bodySchemas)",
      "  requestKinds = @($script:requestKinds)",
      "} | ConvertTo-Json -Depth 5 -Compress",
    ];
    const { stdout, stderr } = await runPowerShell(lines);
    assert.equal(stderr.length, 0);
    assert.equal(stdout.includes(fixture.state), false);
    assert.equal(
      /a{64}|b{64}|c{64}|APP_PASSWORD|AUTH_SECRET|VAULT_ENCRYPTION_SECRET/.test(
        stdout,
      ),
      false,
    );
    return parseSafeRecord<ScenarioResult>(stdout);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test(
  "connector verifies every password-bearing request boundary and launches only the isolated local attempt profile",
  windowsOnly,
  async () => {
    const result = await runScenario("success");
    assert.equal(result.failed, false);
    assert.equal(result.sanitized, true);
    assert.equal(result.listenerChecks, 4);
    assert.equal(result.passwordPosts, 2);
    assert.equal(result.edgeStarts, 1);
    assert.equal(result.oauthChildren, 0);
    assert.equal(result.canaryAbsentAtLaunch, true);
    assert.deepEqual(result.requestKinds, ["start", "status"]);
    assert.deepEqual(result.bodySchemas, ["password", "attemptId,password"]);
    assert.equal(
      result.filePath.endsWith(
        "\\Microsoft\\Edge\\Application\\msedge.exe",
      ),
      true,
    );
    assert.equal(result.arguments.length, 7);
    assert.equal(
      result.arguments.filter((value) => value.startsWith("--user-data-dir="))
        .length,
      1,
    );
    assert.equal(
      result.arguments.filter((value) => value.startsWith("--load-extension="))
        .length,
      1,
    );
    assert.equal(
      result.arguments.filter((value) =>
        value.startsWith("--disable-extensions-except="),
      ).length,
      1,
    );
    assert.deepEqual(
      result.arguments.filter((value) => value.startsWith("--no-")),
      ["--no-first-run"],
    );
    assert.equal(result.arguments.includes("--disable-sync"), true);
    assert.equal(result.arguments.includes("--disable-background-mode"), true);
    assert.equal(
      result.arguments.at(-1),
      `http://127.0.0.1:37645/api/connect/oauth/attempt/launch/${attemptId}`,
    );
    assert.equal(
      result.arguments.some((value) =>
        /(?:^|[?#&])(?:state|challenge|password)=/i.test(value),
      ),
      false,
    );
  },
);

test(
  "connector sends no password before an exact listener and stops before Edge when ownership changes after start",
  windowsOnly,
  async () => {
    const before = await runScenario("pre-start-mismatch");
    assert.deepEqual(
      {
        failed: before.failed,
        sanitized: before.sanitized,
        listenerChecks: before.listenerChecks,
        passwordPosts: before.passwordPosts,
        edgeStarts: before.edgeStarts,
        oauthChildren: before.oauthChildren,
      },
      {
        failed: true,
        sanitized: true,
        listenerChecks: 1,
        passwordPosts: 0,
        edgeStarts: 0,
        oauthChildren: 0,
      },
    );

    const after = await runScenario("post-start-mismatch");
    assert.deepEqual(
      {
        failed: after.failed,
        sanitized: after.sanitized,
        listenerChecks: after.listenerChecks,
        passwordPosts: after.passwordPosts,
        edgeStarts: after.edgeStarts,
        oauthChildren: after.oauthChildren,
      },
      {
        failed: true,
        sanitized: true,
        listenerChecks: 2,
        passwordPosts: 1,
        edgeStarts: 0,
        oauthChildren: 0,
      },
    );
  },
);

test(
  "connector rechecks status responses and HTTP failures, closes only its exact profile, and restores the empty OAuth root",
  windowsOnly,
  async () => {
    const result = await runScenario("post-status-mismatch");
    assert.equal(result.failed, true);
    assert.equal(result.sanitized, true);
    assert.equal(result.listenerChecks, 4);
    assert.equal(result.passwordPosts, 2);
    assert.equal(result.edgeStarts, 1);
    assert.equal(result.stopped, 1);
    assert.equal(result.oauthChildren, 0);

    const httpError = await runScenario("status-http-error");
    assert.equal(httpError.failed, true);
    assert.equal(httpError.sanitized, true);
    assert.equal(httpError.listenerChecks, 4);
    assert.equal(httpError.passwordPosts, 2);
    assert.equal(httpError.edgeStarts, 1);
    assert.equal(httpError.stopped, 1);
    assert.equal(httpError.oauthChildren, 0);
  },
);

test(
  "connector completes startup integrity before importing secrets or reaching DPAPI",
  windowsOnly,
  async () => {
    const result = await runScenario("integrity-tamper");
    assert.equal(result.failed, true);
    assert.equal(result.sanitized, true);
    assert.equal(result.secretModuleSkipped, true);
    assert.equal(result.listenerChecks, 0);
    assert.equal(result.passwordPosts, 0);
    assert.equal(result.edgeStarts, 0);
    assert.equal(result.oauthChildren, 0);
  },
);
