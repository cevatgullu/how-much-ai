import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const windowsOnly = { skip: process.platform !== "win32" };
const verifierPath = path.resolve("scripts/windows/verify-final-local-state.ps1");
const powerShell51 = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const runtimeHash = "a".repeat(64);
const integrityHash = "b".repeat(64);
const secretsHash = "c".repeat(64);
const stateCanary = "C:\\FINAL-STATE-PATH-CANARY";
const appSecretCanary = `APP-VALUE-CANARY-${"a".repeat(32)}`;
const authSecretCanary = `AUTH-VALUE-CANARY-${"b".repeat(32)}`;
const vaultSecretCanary = `VAULT-VALUE-CANARY-${"c".repeat(32)}`;
const processMetadataCanary = "PROCESS-METADATA-CANARY";
const listenerPidCanary = "424242";

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
    throw new Error("The final-state PowerShell fixture failed.");
  }
}

function parseSafeJson<T>(stdout: string): T {
  try {
    return JSON.parse(stdout.trim()) as T;
  } catch {
    throw new Error("The final-state fixture returned an invalid sanitized result.");
  }
}

function assertNoSensitiveOutput(stdout: string, stderr: string): void {
  const combined = `${stdout}\n${stderr}`;
  for (const forbidden of [
    stateCanary,
    appSecretCanary,
    authSecretCanary,
    vaultSecretCanary,
    processMetadataCanary,
    listenerPidCanary,
    "APP_PASSWORD",
    "AUTH_SECRET",
    "VAULT_ENCRYPTION_SECRET",
  ]) {
    assert.equal(combined.includes(forbidden), false);
  }
}

const dotSourceVerifier = [
  `. ${psLiteral(verifierPath)} -StateRoot ${psLiteral(stateCanary)} ` +
    `-ExpectedRuntimeHash ${psLiteral(runtimeHash)} ` +
    `-ExpectedIntegrityHash ${psLiteral(integrityHash)} ` +
    `-ExpectedSecretsHash ${psLiteral(secretsHash)}`,
];

const syntheticHarness = [
  "$script:events = New-Object 'Collections.Generic.List[string]'",
  "$script:failure = ''",
  "$script:fallback = $false",
  "$script:listenerWaitCalls = 0",
  "$script:targetSelected = $false",
  `$script:appSecret = ${psLiteral(appSecretCanary)}`,
  `$script:authSecret = ${psLiteral(authSecretCanary)}`,
  `$script:vaultSecret = ${psLiteral(vaultSecretCanary)}`,
  "function Add-TestEvent([string]$Name) { [void]$script:events.Add($Name) }",
  "function New-TestOperations {",
  "  return @{",
  "    GetFileHash = {",
  "      param($LiteralPath)",
  "      $leaf = [IO.Path]::GetFileName([string]$LiteralPath)",
  "      Add-TestEvent ('hash-' + $leaf)",
  "      if ($script:failure -ceq 'before-integrity' -and $leaf -ceq 'SecureLocalIntegrity.psm1') { return ('f' * 64) }",
  "      if ($leaf -ceq 'SecureLocalRuntime.psm1') { return ('a' * 64) }",
  "      if ($leaf -ceq 'SecureLocalIntegrity.psm1') { return ('b' * 64) }",
  "      if ($leaf -ceq 'SecureLocalSecrets.psm1') { return ('c' * 64) }",
  "      throw 'unexpected public file'",
  "    }",
  "    ImportRuntime = { param($LiteralPath) Add-TestEvent 'import-runtime'; return $true }",
  "    ImportIntegrity = { param($LiteralPath) Add-TestEvent 'import-integrity'; return $true }",
  "    AssertStartupIntegrity = {",
  "      param($StateRoot)",
  "      Add-TestEvent 'startup-integrity'",
  "      return [pscustomobject]@{ appRoot = 'C:\\Reviewed\\runtime'; nodePath = 'C:\\Reviewed\\node.exe'; port = 37645 }",
  "    }",
  "    ImportSecrets = { param($LiteralPath) Add-TestEvent 'import-secrets'; return $true }",
  "    DecryptBundle = {",
  "      param($LiteralPath)",
  "      Add-TestEvent 'decrypt'",
  "      if ($script:failure -ceq 'decrypt') { throw $script:appSecret }",
  "      return [pscustomobject]@{",
  "        version = 1",
  "        appPassword = $script:appSecret",
  "        authSecret = $script:authSecret",
  "        vaultEncryptionSecret = $script:vaultSecret",
  "      }",
  "    }",
  "    BuildServicePlan = {",
  "      param($Config, $StateRoot, $Bundle)",
  "      Add-TestEvent 'build-plan'",
  "      return [pscustomobject]@{",
  "        FilePath = 'C:\\Reviewed\\node.exe'",
  "        ArgumentList = @('C:\\Reviewed\\next', 'start', '--hostname', '127.0.0.1', '--port', '37645')",
  "      }",
  "    }",
  "    GetListeners = {",
  "      Add-TestEvent 'listeners'",
  "      return @(",
  "        [pscustomobject]@{ LocalAddress = '0.0.0.0'; LocalPort = 37645; State = 'Listen'; OwningProcess = 101 },",
  "        [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 37646; State = 'Listen'; OwningProcess = 202 },",
  "        [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 37645; State = 'Bound'; OwningProcess = 303 },",
  `        [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 37645; State = 'Listen'; OwningProcess = ${listenerPidCanary} }`,
  "      )",
  "    }",
  "    GetProcesses = {",
  "      param($ListenerPid)",
  "      Add-TestEvent 'processes'",
  "      return @(",
  "        [pscustomobject]@{ ProcessId = 999999; ExecutablePath = 'C:\\Unrelated\\node.exe'; CommandLine = 'unrelated next start' },",
  `        [pscustomobject]@{ ProcessId = ${listenerPidCanary}; ExecutablePath = 'C:\\Reviewed\\node.exe'; CommandLine = $(if ($script:failure -ceq 'secret-argument') { $script:appSecret } else { ${psLiteral(processMetadataCanary)} }); Label = 'target' }`,
  "      )",
  "    }",
  "    TestLiveServiceProcess = {",
  "      param($Process, $Plan, $ListenerPid)",
  "      Add-TestEvent 'validate-process'",
  "      $script:targetSelected = ([string]$Process.Label -ceq 'target' -and [int]$Process.ProcessId -eq [int]$ListenerPid)",
  "      return ($script:failure -cne 'process' -and $script:targetSelected)",
  "    }",
  "    CloseDedicatedEdge = {",
  "      param($StateRoot)",
  "      Add-TestEvent 'close-edge'",
  "      if ($script:failure -ceq 'cleanup') { throw 'edge cleanup failure' }",
  "      return $true",
  "    }",
  "    StopTask = {",
  "      param($TaskName)",
  "      Add-TestEvent ('stop-task-' + [string]$TaskName)",
  "      if ($script:failure -ceq 'cleanup' -and [string]$TaskName -ceq 'HowMuchAI-Window') { throw 'task cleanup failure' }",
  "      return $true",
  "    }",
  "    WaitTaskStopped = { param($TaskName) Add-TestEvent ('wait-task-' + [string]$TaskName); return $true }",
  "    WaitListenerExit = {",
  "      param($ListenerPid)",
  "      Add-TestEvent 'wait-listener'",
  "      $script:listenerWaitCalls += 1",
  "      if ($script:fallback -and $script:listenerWaitCalls -eq 1) { return $false }",
  "      return $true",
  "    }",
  "    TerminateValidatedListener = {",
  "      param($ListenerPid, $Plan, $Values)",
  "      Add-TestEvent 'terminate-listener'",
  `      return ([int]$ListenerPid -eq ${listenerPidCanary} -and $null -ne $Plan -and @($Values).Count -eq 3)`,
  "    }",
  "    TestPrivateState = {",
  "      param($StateRoot)",
  "      Add-TestEvent 'acl-scan'",
  "      return $true",
  "    }",
  "    TestNoExactValuesAtRest = {",
  "      param($StateRoot, $Values)",
  "      Add-TestEvent 'exact-value-scan'",
  "      if ($script:failure -ceq 'scan') { throw $script:vaultSecret }",
  "      return (@($Values).Count -eq 3)",
  "    }",
  "  }",
  "}",
  "function Invoke-TestScenario([string]$Failure, [bool]$Fallback) {",
  "  $script:events.Clear()",
  "  $script:failure = $Failure",
  "  $script:fallback = $Fallback",
  "  $script:listenerWaitCalls = 0",
  "  $script:targetSelected = $false",
  "  $failed = $false",
  "  $sanitized = $false",
  "  $summary = $null",
  "  try {",
  `    $summary = Invoke-HmaFinalLocalStateCore -StateRoot ${psLiteral(stateCanary)} -ExpectedRuntimeHash ('a' * 64) -ExpectedIntegrityHash ('b' * 64) -ExpectedSecretsHash ('c' * 64) -Operations (New-TestOperations)`,
  "  } catch {",
  "    $failed = $true",
  "    $sanitized = ($_.Exception.Message -ceq 'Final local state verification failed.')",
  "  }",
  "  $firstImport = $script:events.IndexOf('import-runtime')",
  "  $lastHash = $script:events.IndexOf('hash-SecureLocalSecrets.psm1')",
  "  $firstScan = $script:events.IndexOf('acl-scan')",
  "  $lastTaskWait = [Math]::Max($script:events.IndexOf('wait-task-HowMuchAI-Window'), $script:events.IndexOf('wait-task-HowMuchAI-Service'))",
  "  $lastShutdown = [Math]::Max($lastTaskWait, $script:events.LastIndexOf('wait-listener'))",
  "  return [pscustomobject]@{",
  "    failed = $failed",
  "    sanitized = $sanitized",
  "    ok = ($null -ne $summary -and [bool]$summary.ok)",
  "    safeSummaryShape = ($null -eq $summary -or @($summary.PSObject.Properties.Name | Where-Object { $_ -cnotin @('ok','moduleHashesValid','startupIntegrityValid','listenerCount','listenerOwnerValid','secretArgumentsAbsent','edgeClosed','taskStopCount','listenerStopped','aclValid','exactValuesAbsent') }).Count -eq 0)",
  "    listenerCount = if ($null -eq $summary) { 0 } else { [int]$summary.listenerCount }",
  "    taskStopCount = if ($null -eq $summary) { 0 } else { [int]$summary.taskStopCount }",
  "    closeCount = @($script:events | Where-Object { $_ -ceq 'close-edge' }).Count",
  "    stopAttemptCount = @($script:events | Where-Object { $_ -like 'stop-task-*' }).Count",
  "    waitTaskCount = @($script:events | Where-Object { $_ -like 'wait-task-*' }).Count",
  "    waitListenerCount = @($script:events | Where-Object { $_ -ceq 'wait-listener' }).Count",
  "    terminateCount = @($script:events | Where-Object { $_ -ceq 'terminate-listener' }).Count",
  "    scanCount = @($script:events | Where-Object { $_ -in @('acl-scan','exact-value-scan') }).Count",
  "    importCount = @($script:events | Where-Object { $_ -like 'import-*' }).Count",
  "    planReached = ($script:events.IndexOf('build-plan') -ge 0)",
  "    listenersReached = ($script:events.IndexOf('listeners') -ge 0)",
  "    processesReached = ($script:events.IndexOf('processes') -ge 0)",
  "    processValidationReached = ($script:events.IndexOf('validate-process') -ge 0)",
  "    targetSelected = $script:targetSelected",
  "    hashesBeforeImport = ($firstImport -gt $lastHash -and $lastHash -ge 0)",
  "    cleanupBeforeScan = ($firstScan -lt 0 -or $lastShutdown -lt $firstScan)",
  "  }",
  "}",
];

test(
  "the reviewed call site checks the verifier hash before PS5.1 loads its injectable core",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      `$verifier = ${psLiteral(verifierPath)}`,
      "$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $verifier).Hash",
      "function Invoke-HashGatedVerifier([string]$ExpectedHash) {",
      "  $observed = (Get-FileHash -Algorithm SHA256 -LiteralPath $verifier).Hash",
      "  if (-not [string]::Equals($observed, $ExpectedHash, [StringComparison]::OrdinalIgnoreCase)) { return $false }",
      ...dotSourceVerifier.map((line) => `  ${line}`),
      "  return ($null -ne (Get-Command Invoke-HmaFinalLocalStateCore -CommandType Function -ErrorAction SilentlyContinue))",
      "}",
      "$wrongInvoked = Invoke-HashGatedVerifier -ExpectedHash ('0' * 64)",
      "$reviewedLoaded = Invoke-HashGatedVerifier -ExpectedHash $actual",
      "[pscustomobject]@{ wrongBlocked = (-not $wrongInvoked); reviewedLoaded = $reviewedLoaded; coreAvailable = $reviewedLoaded; desktop51 = ($PSVersionTable.PSEdition -ceq 'Desktop' -and $PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1) } | ConvertTo-Json -Compress",
    ]);

    assert.deepEqual(parseSafeJson(stdout), {
      wrongBlocked: true,
      reviewedLoaded: true,
      coreAvailable: true,
      desktop51: true,
    });
    assert.equal(stderr.length, 0);
    assertNoSensitiveOutput(stdout, stderr);
  },
);

test(
  "the core selects only the exact listener owner and returns a sanitized stopped-state summary",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      ...dotSourceVerifier,
      ...syntheticHarness,
      "$records = @((Invoke-TestScenario -Failure '' -Fallback $false), (Invoke-TestScenario -Failure '' -Fallback $true))",
      "$records | ConvertTo-Json -Compress",
    ]);
    const records = parseSafeJson<
      Array<{
        failed: boolean;
        sanitized: boolean;
        ok: boolean;
        safeSummaryShape: boolean;
        listenerCount: number;
        taskStopCount: number;
        closeCount: number;
        stopAttemptCount: number;
        waitTaskCount: number;
        waitListenerCount: number;
        terminateCount: number;
        scanCount: number;
        importCount: number;
        planReached: boolean;
        listenersReached: boolean;
        processesReached: boolean;
        processValidationReached: boolean;
        targetSelected: boolean;
        hashesBeforeImport: boolean;
        cleanupBeforeScan: boolean;
      }>
    >(stdout);

    assert.equal(records.length, 2);
    assert.deepEqual(records[0], {
      failed: false,
      sanitized: false,
      ok: true,
      safeSummaryShape: true,
      listenerCount: 1,
      taskStopCount: 2,
      closeCount: 1,
      stopAttemptCount: 2,
      waitTaskCount: 2,
      waitListenerCount: 1,
      terminateCount: 0,
      scanCount: 2,
      importCount: 3,
      planReached: true,
      listenersReached: true,
      processesReached: true,
      processValidationReached: true,
      targetSelected: true,
      hashesBeforeImport: true,
      cleanupBeforeScan: true,
    });
    assert.deepEqual(records[1], {
      ...records[0],
      waitListenerCount: 2,
      terminateCount: 1,
    });
    assert.equal(stderr.length, 0);
    assertNoSensitiveOutput(stdout, stderr);
  },
);

test(
  "every validation and stopped-state failure performs fail-safe cleanup without leaking details",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      ...dotSourceVerifier,
      ...syntheticHarness,
      "$records = @(",
      "  (Invoke-TestScenario -Failure 'before-integrity' -Fallback $false),",
      "  (Invoke-TestScenario -Failure 'decrypt' -Fallback $false),",
      "  (Invoke-TestScenario -Failure 'process' -Fallback $false),",
      "  (Invoke-TestScenario -Failure 'secret-argument' -Fallback $false),",
      "  (Invoke-TestScenario -Failure 'scan' -Fallback $false),",
      "  (Invoke-TestScenario -Failure 'cleanup' -Fallback $false)",
      ")",
      "$records | ConvertTo-Json -Compress",
    ]);
    const records = parseSafeJson<
      Array<{
        failed: boolean;
        sanitized: boolean;
        ok: boolean;
        closeCount: number;
        stopAttemptCount: number;
        waitTaskCount: number;
        waitListenerCount: number;
        terminateCount: number;
        scanCount: number;
        importCount: number;
        cleanupBeforeScan: boolean;
      }>
    >(stdout);

    assert.equal(records.length, 6);
    for (const record of records) {
      assert.equal(record.failed, true);
      assert.equal(record.sanitized, true);
      assert.equal(record.ok, false);
      assert.equal(record.closeCount, 1);
      assert.equal(record.stopAttemptCount, 2);
      assert.equal(record.waitTaskCount, 2);
      assert.equal(record.terminateCount, 0);
      assert.equal(record.cleanupBeforeScan, true);
    }
    assert.deepEqual(
      records.map((record) => ({
        waitListenerCount: record.waitListenerCount,
        scanCount: record.scanCount,
        importCount: record.importCount,
      })),
      [
        { waitListenerCount: 0, scanCount: 0, importCount: 0 },
        { waitListenerCount: 0, scanCount: 0, importCount: 3 },
        { waitListenerCount: 0, scanCount: 0, importCount: 3 },
        { waitListenerCount: 0, scanCount: 0, importCount: 3 },
        { waitListenerCount: 1, scanCount: 2, importCount: 3 },
        { waitListenerCount: 1, scanCount: 0, importCount: 3 },
      ],
    );
    assert.equal(stderr.length, 0);
    assertNoSensitiveOutput(stdout, stderr);
  },
);
