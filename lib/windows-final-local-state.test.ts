import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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
const reviewedVerifierHash =
  "a3dcfd5d0dfa093fc82130bbdafed9f9254882d0ce5f74edc6558cd4e0ee776a";
const reviewedManifestSha256 =
  "9435a7a1564e5deb1075e83629172fe7682cd2ab651e6d6422d81dc5b8ee688a";
const reviewedManifest =
  `{"commit":"${"d".repeat(40)}","nodeSha256":"${"e".repeat(64)}",` +
  '"runtimeFiles":[],"bootstrapFiles":[' +
  `{"path":"scripts/windows/SecureLocalIntegrity.psm1","size":1,"sha256":"${integrityHash}"},` +
  `{"path":"scripts/windows/SecureLocalRuntime.psm1","size":1,"sha256":"${runtimeHash}"},` +
  `{"path":"scripts/windows/SecureLocalSecrets.psm1","size":1,"sha256":"${secretsHash}"},` +
  `{"path":"scripts/windows/verify-final-local-state.ps1","size":34590,"sha256":"${reviewedVerifierHash}"}` +
  "]}";

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
  "      if ($script:failure -in @('before-integrity','early-wildcard') -and $leaf -ceq 'SecureLocalIntegrity.psm1') { return ('f' * 64) }",
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
  "      if ($script:failure -ceq 'wildcard') {",
  "        return @([pscustomobject]@{ LocalAddress = '0.0.0.0'; LocalPort = 37645; State = 'Listen'; OwningProcess = 101 })",
  "      }",
  "      if ($script:failure -ceq 'additional') {",
  "        return @(",
  `          [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 37645; State = 'Listen'; OwningProcess = ${listenerPidCanary} },`,
  "          [pscustomobject]@{ LocalAddress = '::1'; LocalPort = 37645; State = 'Listen'; OwningProcess = 101 }",
  "        )",
  "      }",
  "      return @(",
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
  "    WaitExactListenerExit = {",
  "      Add-TestEvent 'wait-exact-listener'",
  "      return $true",
  "    }",
  "    WaitPortListenersExit = {",
  "      Add-TestEvent 'wait-port-listeners'",
  "      return ($script:failure -cnotin @('wildcard','additional','replacement','early-wildcard'))",
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
  "  $lastListenerWait = [Math]::Max($script:events.LastIndexOf('wait-listener'), [Math]::Max($script:events.LastIndexOf('wait-exact-listener'), $script:events.LastIndexOf('wait-port-listeners')))",
  "  $lastShutdown = [Math]::Max($lastTaskWait, $lastListenerWait)",
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
  "    waitExactListenerCount = @($script:events | Where-Object { $_ -ceq 'wait-exact-listener' }).Count",
  "    waitPortListenerCount = @($script:events | Where-Object { $_ -ceq 'wait-port-listeners' }).Count",
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
  "the reviewed call site trusts an external manifest anchor before PS5.1 loads the verifier",
  windowsOnly,
  async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-final-callsite-"));
    const manifestPath = path.join(fixture, "runtime-manifest.json");
    const reviewedVerifier = path.join(fixture, "reviewed-verifier.ps1");
    const tamperedVerifier = path.join(fixture, "verify-final-local-state.ps1");
    const verifierText = await readFile(verifierPath, "utf8");
    await writeFile(manifestPath, reviewedManifest, "utf8");
    await writeFile(
      reviewedVerifier,
      verifierText.replace(/\r?\n/gu, "\r\n"),
      "utf8",
    );
    await writeFile(tamperedVerifier, "throw 'tampered verifier loaded'\r\n", "utf8");

    try {
      const { stdout, stderr } = await runPowerShell([
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        `$verifier = ${psLiteral(reviewedVerifier)}`,
        `$tamperedVerifier = ${psLiteral(tamperedVerifier)}`,
        `$manifestPath = ${psLiteral(manifestPath)}`,
        `$trustedManifestHash = ${psLiteral(reviewedManifestSha256)}`,
        "function Get-ReviewedBootstrapHashes([string]$Manifest, [string]$ExpectedManifestHash) {",
        "  try {",
        "    $observedManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Manifest -ErrorAction Stop).Hash",
        "    if (-not [string]::Equals($observedManifestHash, $ExpectedManifestHash, [StringComparison]::OrdinalIgnoreCase)) { return $null }",
        "    $bytes = [IO.File]::ReadAllBytes($Manifest)",
        "    try {",
        "      if ($bytes.Length -le 0 -or $bytes.Length -gt 67108864) { return $null }",
        "      $text = (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes)",
        "      $manifestObject = ConvertFrom-Json -InputObject $text -ErrorAction Stop",
        "      $required = [ordered]@{",
        "        runtime = 'scripts/windows/SecureLocalRuntime.psm1'",
        "        integrity = 'scripts/windows/SecureLocalIntegrity.psm1'",
        "        secrets = 'scripts/windows/SecureLocalSecrets.psm1'",
        "        verifier = 'scripts/windows/verify-final-local-state.ps1'",
        "      }",
        "      $reviewed = [ordered]@{}",
        "      foreach ($name in $required.Keys) {",
        "        $entries = @($manifestObject.bootstrapFiles | Where-Object { [string]$_.path -ceq [string]$required[$name] })",
        "        if ($entries.Count -ne 1 -or $entries[0].sha256 -isnot [string] -or [string]$entries[0].sha256 -cnotmatch '^[a-fA-F0-9]{64}$') { return $null }",
        "        $reviewed[$name] = ([string]$entries[0].sha256).ToLowerInvariant()",
        "      }",
        "      return [pscustomobject]$reviewed",
        "    } finally {",
        "      if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }",
        "    }",
        "  } catch { return $null }",
        "}",
        "function Invoke-ManifestGatedVerifier([string]$Candidate, [string]$Manifest, [string]$ManifestTrustAnchor) {",
        "  $reviewed = Get-ReviewedBootstrapHashes -Manifest $Manifest -ExpectedManifestHash $ManifestTrustAnchor",
        "  if ($null -eq $reviewed) { return $false }",
        "  $observedVerifierHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Candidate -ErrorAction Stop).Hash",
        "  if (-not [string]::Equals($observedVerifierHash, [string]$reviewed.verifier, [StringComparison]::OrdinalIgnoreCase)) { return $false }",
        `  . $Candidate -StateRoot ${psLiteral(stateCanary)} -ExpectedRuntimeHash ([string]$reviewed.runtime) -ExpectedIntegrityHash ([string]$reviewed.integrity) -ExpectedSecretsHash ([string]$reviewed.secrets)`,
        "  return ($null -ne (Get-Command Invoke-HmaFinalLocalStateCore -CommandType Function -ErrorAction SilentlyContinue))",
        "}",
        "$wrongAnchorLoaded = Invoke-ManifestGatedVerifier -Candidate $verifier -Manifest $manifestPath -ManifestTrustAnchor ('0' * 64)",
        "$tamperedLoaded = Invoke-ManifestGatedVerifier -Candidate $tamperedVerifier -Manifest $manifestPath -ManifestTrustAnchor $trustedManifestHash",
        "$reviewedLoaded = Invoke-ManifestGatedVerifier -Candidate $verifier -Manifest $manifestPath -ManifestTrustAnchor $trustedManifestHash",
        "[pscustomobject]@{ wrongAnchorBlocked = (-not $wrongAnchorLoaded); tamperedVerifierBlocked = (-not $tamperedLoaded); reviewedLoaded = $reviewedLoaded; coreAvailable = $reviewedLoaded; desktop51 = ($PSVersionTable.PSEdition -ceq 'Desktop' -and $PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1) } | ConvertTo-Json -Compress",
      ]);

      assert.deepEqual(parseSafeJson(stdout), {
        wrongAnchorBlocked: true,
        tamperedVerifierBlocked: true,
        reviewedLoaded: true,
        coreAvailable: true,
        desktop51: true,
      });
      assert.equal(stderr.length, 0);
      assertNoSensitiveOutput(stdout, stderr);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "the real Windows wildcard probe detects the listener or fails closed",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      ...dotSourceVerifier,
      "$listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Any, 37645)",
      "$wildcardSeen = $false",
      "$probeFailedClosed = $false",
      "try {",
      "  $listener.Start()",
      "  Start-Sleep -Milliseconds 250",
      "  try {",
      "    $rows = @(Get-HmaFinalPortListeners)",
      "    $wildcardSeen = (@($rows | Where-Object { [string]$_.LocalAddress -ceq '0.0.0.0' -and [int]$_.LocalPort -eq 37645 -and [string]$_.State -ceq 'Listen' }).Count -eq 1)",
      "  } catch {",
      "    $probeFailedClosed = $true",
      "  }",
      "} finally {",
      "  $listener.Stop()",
      "}",
      "[pscustomobject]@{",
      "  safeOutcome = ($wildcardSeen -or $probeFailedClosed)",
      "  silentMiss = (-not $wildcardSeen -and -not $probeFailedClosed)",
      "  desktop51 = ($PSVersionTable.PSEdition -ceq 'Desktop' -and $PSVersionTable.PSVersion.Major -eq 5)",
      "} | ConvertTo-Json -Compress",
    ]);

    assert.deepEqual(parseSafeJson(stdout), {
      safeOutcome: true,
      silentMiss: false,
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
        waitExactListenerCount: number;
        waitPortListenerCount: number;
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
      waitExactListenerCount: 0,
      waitPortListenerCount: 1,
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
  "the core rejects a single wildcard listener and keeps cleanup fail-closed",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      ...dotSourceVerifier,
      ...syntheticHarness,
      "$record = Invoke-TestScenario -Failure 'wildcard' -Fallback $false",
      "$record | ConvertTo-Json -Compress",
    ]);

    const record = parseSafeJson<{
      failed: boolean;
      sanitized: boolean;
      ok: boolean;
      listenersReached: boolean;
      processesReached: boolean;
      waitExactListenerCount: number;
      waitPortListenerCount: number;
      terminateCount: number;
    }>(stdout);
    assert.deepEqual(record, {
      ...record,
      failed: true,
      sanitized: true,
      ok: false,
      listenersReached: true,
      processesReached: false,
      waitExactListenerCount: 0,
      waitPortListenerCount: 1,
      terminateCount: 0,
    });
    assert.equal(stderr.length, 0);
    assertNoSensitiveOutput(stdout, stderr);
  },
);

test(
  "the core rejects an exact listener when an additional address is listening",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      ...dotSourceVerifier,
      ...syntheticHarness,
      "$record = Invoke-TestScenario -Failure 'additional' -Fallback $false",
      "$record | ConvertTo-Json -Compress",
    ]);

    const record = parseSafeJson<{
      failed: boolean;
      sanitized: boolean;
      ok: boolean;
      listenersReached: boolean;
      processesReached: boolean;
      processValidationReached: boolean;
      waitPortListenerCount: number;
      terminateCount: number;
    }>(stdout);
    assert.deepEqual(record, {
      ...record,
      failed: true,
      sanitized: true,
      ok: false,
      listenersReached: true,
      processesReached: false,
      processValidationReached: false,
      waitPortListenerCount: 1,
      terminateCount: 0,
    });
    assert.equal(stderr.length, 0);
    assertNoSensitiveOutput(stdout, stderr);
  },
);

test(
  "validated shutdown fails when a wildcard listener replaces the stopped child",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      ...dotSourceVerifier,
      ...syntheticHarness,
      "$script:events.Clear()",
      "$script:failure = 'replacement'",
      `$shutdown = Invoke-HmaFinalFailSafeShutdown -StateRoot ${psLiteral(stateCanary)} -Operations (New-TestOperations) -ValidatedListenerPid ${listenerPidCanary} -ServicePlan ([pscustomobject]@{}) -SecretValues @($script:appSecret,$script:authSecret,$script:vaultSecret)`,
      "$listenerWait = $script:events.IndexOf('wait-listener')",
      "$portWait = $script:events.IndexOf('wait-port-listeners')",
      "[pscustomobject]@{",
      "  listenerStopped = [bool]$shutdown.listenerStopped",
      "  waitListenerCount = @($script:events | Where-Object { $_ -ceq 'wait-listener' }).Count",
      "  portWaitCount = @($script:events | Where-Object { $_ -ceq 'wait-port-listeners' }).Count",
      "  portWaitAfterListener = ($portWait -gt $listenerWait -and $listenerWait -ge 0)",
      "  terminateCount = @($script:events | Where-Object { $_ -ceq 'terminate-listener' }).Count",
      "} | ConvertTo-Json -Compress",
    ]);

    assert.deepEqual(parseSafeJson(stdout), {
      listenerStopped: false,
      waitListenerCount: 1,
      portWaitCount: 1,
      portWaitAfterListener: true,
      terminateCount: 0,
    });
    assert.equal(stderr.length, 0);
    assertNoSensitiveOutput(stdout, stderr);
  },
);

test(
  "early validation failure detects a remaining wildcard without terminating its unknown PID",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      ...dotSourceVerifier,
      ...syntheticHarness,
      "$record = Invoke-TestScenario -Failure 'early-wildcard' -Fallback $false",
      "$record | ConvertTo-Json -Compress",
    ]);

    const record = parseSafeJson<{
      failed: boolean;
      sanitized: boolean;
      importCount: number;
      listenersReached: boolean;
      waitExactListenerCount: number;
      waitPortListenerCount: number;
      terminateCount: number;
    }>(stdout);
    assert.deepEqual(record, {
      ...record,
      failed: true,
      sanitized: true,
      importCount: 0,
      listenersReached: false,
      waitExactListenerCount: 0,
      waitPortListenerCount: 1,
      terminateCount: 0,
    });
    assert.equal(stderr.length, 0);
    assertNoSensitiveOutput(stdout, stderr);
  },
);

test(
  "fail-safe shutdown requires all-address port emptiness without terminating an unvalidated wildcard listener",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      ...dotSourceVerifier,
      ...syntheticHarness,
      "$script:events.Clear()",
      "$script:failure = 'wildcard'",
      `$shutdown = Invoke-HmaFinalFailSafeShutdown -StateRoot ${psLiteral(stateCanary)} -Operations (New-TestOperations) -ValidatedListenerPid $null -ServicePlan $null -SecretValues $null`,
      "$lastTaskWait = [Math]::Max($script:events.IndexOf('wait-task-HowMuchAI-Window'), $script:events.IndexOf('wait-task-HowMuchAI-Service'))",
      "$portWait = $script:events.IndexOf('wait-port-listeners')",
      "[pscustomobject]@{",
      "  listenerStopped = [bool]$shutdown.listenerStopped",
      "  stopAttemptCount = @($script:events | Where-Object { $_ -like 'stop-task-*' }).Count",
      "  waitTaskCount = @($script:events | Where-Object { $_ -like 'wait-task-*' }).Count",
      "  exactWaitCount = @($script:events | Where-Object { $_ -ceq 'wait-exact-listener' }).Count",
      "  portWaitCount = @($script:events | Where-Object { $_ -ceq 'wait-port-listeners' }).Count",
      "  portWaitAfterTasks = ($portWait -gt $lastTaskWait -and $lastTaskWait -ge 0)",
      "  terminateCount = @($script:events | Where-Object { $_ -ceq 'terminate-listener' }).Count",
      "} | ConvertTo-Json -Compress",
    ]);

    assert.deepEqual(parseSafeJson(stdout), {
      listenerStopped: false,
      stopAttemptCount: 2,
      waitTaskCount: 2,
      exactWaitCount: 0,
      portWaitCount: 1,
      portWaitAfterTasks: true,
      terminateCount: 0,
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
        waitExactListenerCount: number;
        waitPortListenerCount: number;
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
        waitExactListenerCount: record.waitExactListenerCount,
        waitPortListenerCount: record.waitPortListenerCount,
        scanCount: record.scanCount,
        importCount: record.importCount,
      })),
      [
        {
          waitListenerCount: 0,
          waitExactListenerCount: 0,
          waitPortListenerCount: 1,
          scanCount: 0,
          importCount: 0,
        },
        {
          waitListenerCount: 0,
          waitExactListenerCount: 0,
          waitPortListenerCount: 1,
          scanCount: 0,
          importCount: 3,
        },
        {
          waitListenerCount: 0,
          waitExactListenerCount: 0,
          waitPortListenerCount: 1,
          scanCount: 0,
          importCount: 3,
        },
        {
          waitListenerCount: 0,
          waitExactListenerCount: 0,
          waitPortListenerCount: 1,
          scanCount: 0,
          importCount: 3,
        },
        {
          waitListenerCount: 1,
          waitExactListenerCount: 0,
          waitPortListenerCount: 1,
          scanCount: 2,
          importCount: 3,
        },
        {
          waitListenerCount: 1,
          waitExactListenerCount: 0,
          waitPortListenerCount: 1,
          scanCount: 0,
          importCount: 3,
        },
      ],
    );
    assert.equal(stderr.length, 0);
    assertNoSensitiveOutput(stdout, stderr);
  },
);
