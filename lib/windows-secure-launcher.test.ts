import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const windowsOnly = { skip: process.platform !== "win32" };
const modulePath = path.resolve("scripts/windows/SecureLocalRuntime.psm1");
const integrityModulePath = path.resolve("scripts/windows/SecureLocalIntegrity.psm1");
const secretsModulePath = path.resolve("scripts/windows/SecureLocalSecrets.psm1");
const openScriptPath = path.resolve("scripts/windows/open-secure-local.ps1");
const startScriptPath = path.resolve("scripts/windows/start-secure-local.ps1");
const launchScriptPath = path.resolve("scripts/windows/launch-secure-local.ps1");
const finalVerifierScriptPath = path.resolve(
  "scripts/windows/verify-final-local-state.ps1",
);
const installerScriptPath = path.resolve("scripts/windows/install-secure-local.ps1");
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

function bootstrapHmac(context: string, challenge: string): string {
  return createHmac("sha256", "b".repeat(64))
    .update(context, "utf8")
    .update(Buffer.from([0]))
    .update(challenge, "utf8")
    .digest("base64url");
}

async function runPowerShell(
  lines: string[],
  extraEnv: NodeJS.ProcessEnv = {},
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
        env: { ...process.env, ...extraEnv },
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
    );
  } catch {
    throw new Error("The Windows launcher security fixture failed.");
  }
}

async function runPowerShellFile(
  lines: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  const scriptPath = path.join(
    os.tmpdir(),
    `hma-windows-fixture-${process.pid}-${Date.now()}.ps1`,
  );
  await writeFile(scriptPath, lines.join("\r\n"), "utf8");
  try {
    return await execFileAsync(
      powerShell51,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, ...extraEnv },
        maxBuffer: 1024 * 1024,
        timeout: 300_000,
        windowsHide: true,
      },
    );
  } catch {
    throw new Error("The Windows launcher security fixture failed.");
  } finally {
    await rm(scriptPath, { force: true });
  }
}

function parseSafeRecord<T>(stdout: string): T {
  try {
    return JSON.parse(stdout.trim()) as T;
  } catch {
    throw new Error("The Windows launcher fixture returned an invalid safe result.");
  }
}

const commonSetup = [
  "if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -lt 1) { throw 'Windows PowerShell 5.1 is required.' }",
  "Set-StrictMode -Version Latest",
  "$ErrorActionPreference = 'Stop'",
  `Import-Module ${psLiteral(modulePath)} -Force`,
  "$config = [pscustomobject]@{ appRoot = 'C:\\audited-app'; nodePath = 'C:\\Program Files\\nodejs\\node.exe'; port = 37645 }",
  "$bundle = [pscustomobject]@{ appPassword = ('a' * 64); authSecret = ('b' * 64); vaultEncryptionSecret = ('c' * 64) }",
];

test("the installer requires retained exact locked Node and PowerShell executables", async () => {
  const installer = await readFile(installerScriptPath, "utf8");

  for (const parameter of [
    "NodePath",
    "ExpectedNodeSha256",
    "Ps51Path",
    "ExpectedPs51Sha256",
  ]) {
    assert.match(
      installer,
      new RegExp(
        String.raw`\[Parameter\(Mandatory\)\][\s\S]{0,120}\$${parameter}\b`,
        "u",
      ),
    );
  }
  assert.doesNotMatch(installer, /Get-Command\s+node(?:\.exe)?\b/iu);
  assert.doesNotMatch(
    installer,
    /\$env:SystemRoot[\s\S]{0,120}powershell\.exe/iu,
  );
  assert.match(
    installer,
    /\[IO\.Path\]::GetPathRoot\(\[Environment\]::SystemDirectory\)[\s\S]{0,160}'Program Files'/u,
  );
  assert.match(installer, /'nodejs'[\s\S]{0,80}'node\.exe'/u);
  assert.match(installer, /Get-HmaLockedStreamSha256/u);
  assert.match(installer, /Assert-HmaTrustedExecutableAcl/u);
  assert.match(installer, /Enter-HmaSourceEntryLease/u);
  assert.match(installer, /Assert-HmaSourceEntryLease/u);
  assert.match(installer, /Exit-HmaSourceEntryLease/u);
  assert.match(installer, /\[IO\.FileShare\]::Read/u);
  const copyFunction = installer.match(
    /function Copy-HmaManifestEntries[\s\S]*?\n\}\r?\n/u,
  )?.[0];
  assert.ok(copyFunction);
  assert.doesNotMatch(copyFunction, /\bCopy-Item\b/u);
  assert.match(copyFunction, /\.CopyTo\(/u);
});

test(
  "runtime plans bind loopback, isolate Edge, and create limited secret-free task actions",
  windowsOnly,
  async () => {
    const ticket = "t".repeat(43);
    const { stdout, stderr } = await runPowerShell([
      ...commonSetup,
      "$service = New-HmaServiceLaunchPlan -Config $config -StateRoot 'C:\\private-state' -Bundle $bundle",
      `$edge = New-HmaEdgeLaunchPlan -Config $config -StateRoot 'C:\\private-state' -EdgePath 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' -LaunchUri 'http://127.0.0.1:37645/bootstrap#bootstrap=${ticket}'`,
      "$hashes = @{ start = ('1' * 64); open = ('2' * 64); integrity = ('3' * 64) }",
      ` $tasks = New-HmaTaskPlans -BootstrapRoot 'C:\\private-state\\bootstrap' -StateRoot 'C:\\private-state' -PowerShellPath ${psLiteral(powerShell51)} -BootstrapHashes $hashes`,
      "$baseNames = @('APPDATA','COMSPEC','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','NUMBER_OF_PROCESSORS','OS','PATHEXT','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','SYSTEMDRIVE','SYSTEMROOT','TEMP','TMP','USERPROFILE','WINDIR')",
      "$expectedBase = @($baseNames | Where-Object { -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($_, 'Process')) })",
      "$expectedEnvironment = @($expectedBase + @('APP_PASSWORD','AUTH_SECRET','ENABLE_LOCAL_CONNECT','HMC_LISTEN_HOST','HMC_LISTEN_PORT','HMC_STRICT_LOCAL_MODE','NEXT_TELEMETRY_DISABLED','NODE_ENV','PORT','TRUST_PROXY_IP_HEADERS','VAULT_DATA_DIR','VAULT_ENCRYPTION_SECRET')) | Sort-Object -Unique",
      "[pscustomobject]@{ serviceFile = $service.FilePath; serviceArgs = @($service.ArgumentList); hostValue = $service.Environment.HMC_LISTEN_HOST; secretKeys = @($service.Environment.Keys | Where-Object { $_ -in @('APP_PASSWORD','AUTH_SECRET','VAULT_ENCRYPTION_SECRET') } | Sort-Object); secretsMatch = (($service.Environment.APP_PASSWORD -ceq ('a' * 64)) -and ($service.Environment.AUTH_SECRET -ceq ('b' * 64)) -and ($service.Environment.VAULT_ENCRYPTION_SECRET -ceq ('c' * 64))); environmentExact = (-not [bool](Compare-Object $expectedEnvironment @($service.Environment.Keys | Sort-Object))); edgeEnvironmentExact = (-not [bool](Compare-Object ($expectedBase | Sort-Object) @($edge.Environment.Keys | Sort-Object))); edgeEnvironmentSecretFree = (-not [bool](@($edge.Environment.Keys | Where-Object { $_ -match '(?i)(PASSWORD|SECRET|TOKEN|PROXY|NODE_OPTIONS|NODE_PATH)' }).Count)); strictValuesExact = (($service.Environment.HMC_STRICT_LOCAL_MODE -ceq '1') -and ($service.Environment.HMC_LISTEN_PORT -ceq '37645') -and ($service.Environment.PORT -ceq '37645') -and ($service.Environment.TRUST_PROXY_IP_HEADERS -ceq '0') -and ($service.Environment.ENABLE_LOCAL_CONNECT -ceq '1') -and ($service.Environment.NEXT_TELEMETRY_DISABLED -ceq '1') -and ($service.Environment.VAULT_DATA_DIR -ceq 'C:\\private-state\\vault')); edgeHasExpectedBootstrap = [bool](@($edge.ArgumentList) -contains '--app=http://127.0.0.1:37645/bootstrap#bootstrap=" + ticket + "'); edgeHasIsolatedProfile = [bool](@($edge.ArgumentList) -contains '--user-data-dir=C:\\private-state\\edge-profile'); edgeWindowStyle = $edge.WindowStyle; taskNames = @($tasks.Name); taskRunLevels = @($tasks.RunLevel | Select-Object -Unique); taskActionsContainSecret = [bool]((($tasks.ActionArguments -join ' ') -match '(?i)(APP_PASSWORD|AUTH_SECRET|VAULT_ENCRYPTION_SECRET|aaaa|bbbb|cccc)') -or (($tasks.ActionArguments -join ' ').Contains('" + ticket + "'))) } | ConvertTo-Json -Depth 6 -Compress",
    ]);

    const result = parseSafeRecord<{
      serviceFile: string;
      serviceArgs: string[];
      hostValue: string;
      secretKeys: string[];
      secretsMatch: boolean;
      environmentExact: boolean;
      edgeEnvironmentExact: boolean;
      edgeEnvironmentSecretFree: boolean;
      strictValuesExact: boolean;
      edgeHasExpectedBootstrap: boolean;
      edgeHasIsolatedProfile: boolean;
      edgeWindowStyle: string;
      taskNames: string[];
      taskRunLevels: string[];
      taskActionsContainSecret: boolean;
    }>(stdout);
    assert.equal(result.serviceFile, "C:\\Program Files\\nodejs\\node.exe");
    assert.deepEqual(result.serviceArgs.slice(-5), [
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "37645",
    ]);
    assert.equal(result.hostValue, "127.0.0.1");
    assert.deepEqual(result.secretKeys, [
      "APP_PASSWORD",
      "AUTH_SECRET",
      "VAULT_ENCRYPTION_SECRET",
    ]);
    assert.equal(result.secretsMatch, true);
    assert.equal(result.environmentExact, true);
    assert.equal(result.edgeEnvironmentExact, true);
    assert.equal(result.edgeEnvironmentSecretFree, true);
    assert.equal(result.strictValuesExact, true);
    assert.equal(result.edgeHasExpectedBootstrap, true);
    assert.equal(result.edgeHasIsolatedProfile, true);
    assert.equal(result.edgeWindowStyle, "Normal");
    assert.deepEqual(result.taskNames, ["HowMuchAI-Service", "HowMuchAI-Window"]);
    assert.deepEqual(result.taskRunLevels, ["Limited"]);
    assert.equal(result.taskActionsContainSecret, false);
    assert.equal(stderr.length, 0);
    assert.equal(stdout.includes(ticket), false);
    assert.equal(stdout.includes("a".repeat(64)), false);
  },
);

test(
  "Edge launch plans accept only the exact loopback root or one exact bootstrap fragment",
  windowsOnly,
  async () => {
    const ticket = "A_-".repeat(14) + "A";
    const candidates = [
      "https://127.0.0.1:37645/",
      "http://localhost:37645/",
      "http://127.0.0.1/",
      "http://127.0.0.1:37646/",
      "http://127.0.0.1:37645.evil.example/",
      "http://127.0.0.1:37645@evil.example/",
      "http://user@127.0.0.1:37645/",
      "http://127.0.0.1:37645/bootstrap",
      "http://127.0.0.1:37645/bootstrap/",
      "http://127.0.0.1:37645/bootstrap?bootstrap=" + ticket,
      "http://127.0.0.1:37645/bootstrap#bootstrap=short",
      "http://127.0.0.1:37645/bootstrap#bootstrap=" + "x".repeat(44),
      "http://127.0.0.1:37645/bootstrap#bootstrap=" + "x".repeat(42) + "=",
      "http://127.0.0.1:37645/login#bootstrap=" + ticket,
      "http://127.0.0.1:37645/%62ootstrap#bootstrap=" + ticket,
    ];
    const { stdout, stderr } = await runPowerShell([
      ...commonSetup,
      `$acceptedRoot = New-HmaEdgeLaunchPlan -Config $config -StateRoot 'C:\\private-state' -EdgePath 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' -LaunchUri 'http://127.0.0.1:37645/'`,
      `$acceptedTicket = New-HmaEdgeLaunchPlan -Config $config -StateRoot 'C:\\private-state' -EdgePath 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' -LaunchUri 'http://127.0.0.1:37645/bootstrap#bootstrap=${ticket}'`,
      `$candidates = ConvertFrom-Json ${psLiteral(JSON.stringify(candidates))}`,
      "$rejected = 0",
      "foreach ($candidate in $candidates) { try { $null = New-HmaEdgeLaunchPlan -Config $config -StateRoot 'C:\\private-state' -EdgePath 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' -LaunchUri ([string]$candidate) } catch { $rejected += 1 } }",
      "[pscustomobject]@{ root = (@($acceptedRoot.ArgumentList)[0] -ceq '--app=http://127.0.0.1:37645/'); ticket = (@($acceptedTicket.ArgumentList)[0] -like '--app=http://127.0.0.1:37645/bootstrap#bootstrap=*'); rejected = $rejected; total = @($candidates).Count } | ConvertTo-Json -Compress",
    ]);

    const result = parseSafeRecord<{
      root: boolean;
      ticket: boolean;
      rejected: number;
      total: number;
    }>(stdout);
    assert.deepEqual(result, {
      root: true,
      ticket: true,
      rejected: candidates.length,
      total: candidates.length,
    });
    assert.equal(stderr.length, 0);
    assert.equal(stdout.includes(ticket), false);
  },
);

test(
  "Edge launch arguments survive the actual PowerShell 5.1 Start-Process argv boundary",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      ...commonSetup,
      "$stateWithSpaces = 'C:\\private state'",
      "$plan = New-HmaEdgeLaunchPlan -Config $config -StateRoot $stateWithSpaces -EdgePath 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' -LaunchUri 'http://127.0.0.1:37645/'",
      "$captureScript = Join-Path $env:TEMP ('hma-argv-' + [Guid]::NewGuid().ToString('N') + '.ps1')",
      "$captureOutput = Join-Path $env:TEMP ('hma-argv-' + [Guid]::NewGuid().ToString('N') + '.json')",
      "$captureText = \"[IO.File]::WriteAllLines(`$env:HMA_ARGV_OUTPUT, [string[]]`$args, (New-Object Text.UTF8Encoding(`$false)))\"",
      "[IO.File]::WriteAllText($captureScript, $captureText, (New-Object Text.UTF8Encoding($false)))",
      "$previousOutput = [Environment]::GetEnvironmentVariable('HMA_ARGV_OUTPUT', 'Process')",
      "try {",
      "  [Environment]::SetEnvironmentVariable('HMA_ARGV_OUTPUT', $captureOutput, 'Process')",
      "  $prefix = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$captureScript)",
      `  $child = Start-Process -FilePath ${psLiteral(powerShell51)} -ArgumentList ([string[]]@($prefix + @($plan.ArgumentList))) -WindowStyle Hidden -Wait -PassThru`,
      "  $captured = @([IO.File]::ReadAllLines($captureOutput, (New-Object Text.UTF8Encoding($false, $true))))",
      "  $expected = @('--app=http://127.0.0.1:37645/', ('--user-data-dir=' + (Join-Path $stateWithSpaces 'edge-profile')), '--no-first-run', '--disable-background-mode')",
      "  $exact = ($captured.Count -eq $expected.Count)",
      "  for ($index = 0; $exact -and $index -lt $expected.Count; $index += 1) { $exact = ([string]$captured[$index] -ceq [string]$expected[$index]) }",
      "  [pscustomobject]@{ exitCode = $child.ExitCode; count = $captured.Count; exact = $exact } | ConvertTo-Json -Compress",
      "} finally {",
      "  [Environment]::SetEnvironmentVariable('HMA_ARGV_OUTPUT', $previousOutput, 'Process')",
      "  if ([IO.File]::Exists($captureScript)) { [IO.File]::Delete($captureScript) }",
      "  if ([IO.File]::Exists($captureOutput)) { [IO.File]::Delete($captureOutput) }",
      "}",
    ]);

    assert.deepEqual(parseSafeRecord(stdout), {
      exitCode: 0,
      count: 4,
      exact: true,
    });
    assert.equal(stderr.length, 0);
  },
);

test(
  "listener ownership and dedicated Edge cleanup use exact executable and argv matches",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      ...commonSetup,
      "$plan = New-HmaServiceLaunchPlan -Config $config -StateRoot 'C:\\private-state' -Bundle $bundle",
      "$exactCommand = '\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\audited-app\\node_modules\\next\\dist\\bin\\next\" start --hostname 127.0.0.1 --port 37645'",
      "$exact = [pscustomobject]@{ ProcessId = 42; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = $exactCommand }",
      "$extra = [pscustomobject]@{ ProcessId = 42; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = ($exactCommand + ' --inspect') }",
      "$lookalike = [pscustomobject]@{ ProcessId = 42; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe.evil'; CommandLine = $exactCommand }",
      "$secretArg = [pscustomobject]@{ ProcessId = 42; ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'; CommandLine = ($exactCommand + ' APP_PASSWORD=not-allowed') }",
      "$checks = @((Test-HmaLiveServiceProcess -Process $exact -Plan $plan -ListenerPid 42), (-not (Test-HmaLiveServiceProcess -Process $exact -Plan $plan -ListenerPid 43)), (-not (Test-HmaLiveServiceProcess -Process $extra -Plan $plan -ListenerPid 42)), (-not (Test-HmaLiveServiceProcess -Process $lookalike -Plan $plan -ListenerPid 42)), (-not (Test-HmaLiveServiceProcess -Process $secretArg -Plan $plan -ListenerPid 42)))",
      "$rows = @([pscustomobject]@{ ProcessId = 10; ExecutablePath = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'; CommandLine = 'msedge.exe --user-data-dir=C:\\private-state\\edge-profile --no-first-run' }, [pscustomobject]@{ ProcessId = 11; ExecutablePath = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'; CommandLine = 'msedge.exe --user-data-dir=C:\\private-state\\edge-profile-evil --no-first-run' }, [pscustomobject]@{ ProcessId = 12; ExecutablePath = 'C:\\Temp\\msedge.exe'; CommandLine = 'msedge.exe --user-data-dir=C:\\private-state\\edge-profile --no-first-run' })",
      "$stopped = New-Object 'Collections.Generic.List[int]'",
      "$provider = { $rows }",
      "$terminator = { param($processId) [void]$stopped.Add([int]$processId); $true }",
      "$waiter = { param($processId) $true }",
      "$cleanup = Stop-HmaDedicatedEdgeProfile -StateRoot 'C:\\private-state' -ProcessProvider $provider -Terminator $terminator -Waiter $waiter",
      "$emptyCleanup = Stop-HmaDedicatedEdgeProfile -StateRoot 'C:\\private-state' -ProcessProvider { @() } -Terminator $terminator -Waiter $waiter",
      "[pscustomobject]@{ checks = [bool[]]$checks; cleanup = $cleanup; emptyCleanup = $emptyCleanup; stoppedExact = (@($stopped).Count -eq 1 -and @($stopped)[0] -eq 10) } | ConvertTo-Json -Compress",
    ]);

    const result = parseSafeRecord<{
      checks: boolean[];
      cleanup: boolean;
      emptyCleanup: boolean;
      stoppedExact: boolean;
    }>(stdout);
    assert.deepEqual(result, {
      checks: [true, true, true, true, true],
      cleanup: true,
      emptyCleanup: true,
      stoppedExact: true,
    });
    assert.equal(stderr.length, 0);
    assert.equal(/node\.exe|msedge|private-state|commandline|processid/i.test(stdout), false);
  },
);

test(
  "exact process environment replacement drops proxy, preload, provider, path, and arbitrary canaries",
  windowsOnly,
  async () => {
    const canary = "hma-environment-canary";
    const { stdout, stderr } = await runPowerShell(
      [
        ...commonSetup,
        "$plan = New-HmaServiceLaunchPlan -Config $config -StateRoot 'C:\\private-state' -Bundle $bundle",
        "Set-HmaExactProcessEnvironment -Environment $plan.Environment",
        "$actual = [Environment]::GetEnvironmentVariables('Process')",
        "$actualNames = @($actual.Keys | ForEach-Object { [string]$_ } | Sort-Object)",
        "$expectedNames = @($plan.Environment.Keys | ForEach-Object { [string]$_ } | Sort-Object)",
        "$forbidden = @('PATH','PSModulePath','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NEXT_PUBLIC_PROVIDER','HMA_ARBITRARY')",
        "$safe = [pscustomobject]@{ exact = (-not [bool](Compare-Object $expectedNames $actualNames)); forbiddenAbsent = (-not [bool](@($forbidden | Where-Object { $actual.Contains($_) }).Count)); serviceValuesPresent = (($actual.APP_PASSWORD -ceq ('a' * 64)) -and ($actual.AUTH_SECRET -ceq ('b' * 64)) -and ($actual.VAULT_ENCRYPTION_SECRET -ceq ('c' * 64))) }",
        "$safe | ConvertTo-Json -Compress",
      ],
      {
        HTTP_PROXY: canary,
        HTTPS_PROXY: canary,
        NO_PROXY: canary,
        NODE_OPTIONS: "",
        NODE_PATH: canary,
        NODE_EXTRA_CA_CERTS: canary,
        NEXT_PUBLIC_PROVIDER: canary,
        HMA_ARBITRARY: canary,
      },
    );

    const result = parseSafeRecord<{
      exact: boolean;
      forbiddenAbsent: boolean;
      serviceValuesPresent: boolean;
    }>(stdout);
    assert.deepEqual(result, {
      exact: true,
      forbiddenAbsent: true,
      serviceValuesPresent: true,
    });
    assert.equal(stderr.length, 0);
    assert.equal(stdout.includes(canary), false);
    assert.equal(stdout.includes("a".repeat(64)), false);
  },
);

test(
  "task verification accepts only current-user identity equivalents and exact limited XML",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      ...commonSetup,
      "$hashes = @{ start = ('1' * 64); open = ('2' * 64); integrity = ('3' * 64) }",
      `$ps51 = ${psLiteral(powerShell51)}`,
      "$plans = @(New-HmaTaskPlans -BootstrapRoot 'C:\\private-state\\bootstrap' -StateRoot 'C:\\private-state' -PowerShellPath $ps51 -BootstrapHashes $hashes)",
      "$unsafeRejected = 0",
      "$unsafeCases = @([pscustomobject]@{ Bootstrap = 'relative\\bootstrap'; State = 'C:\\private-state'; PowerShell = $ps51 }, [pscustomobject]@{ Bootstrap = \"C:\\bad'path\"; State = 'C:\\private-state'; PowerShell = $ps51 }, [pscustomobject]@{ Bootstrap = 'C:\\private-state\\bootstrap'; State = \"C:\\bad`nstate\"; PowerShell = $ps51 }, [pscustomobject]@{ Bootstrap = 'C:\\private-state\\bootstrap'; State = 'C:\\private-state'; PowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v2.0\\powershell.exe' })",
      "foreach ($case in $unsafeCases) { try { $null = New-HmaTaskPlans -BootstrapRoot $case.Bootstrap -StateRoot $case.State -PowerShellPath $case.PowerShell -BootstrapHashes $hashes } catch { $unsafeRejected += 1 } }",
      "$invalidEnvironmentRejected = $false",
      "try { Set-HmaExactProcessEnvironment -Environment ([ordered]@{ SYSTEMROOT = $env:SystemRoot; PATH = 'C:\\attacker' }) } catch { $invalidEnvironmentRejected = $true }",
      "$expected = $plans[0]",
      "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name",
      "$shortAccount = @($account.Split('\\'))[-1]",
      "$escapedAccount = [Security.SecurityElement]::Escape($account)",
      "$escapedCommand = [Security.SecurityElement]::Escape([string]$expected.FilePath)",
      "$escapedArguments = [Security.SecurityElement]::Escape([string]$expected.ActionArguments)",
      "$xml = '<Task xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"><Triggers><LogonTrigger><UserId>' + $sid + '</UserId></LogonTrigger></Triggers><Principals><Principal><UserId>' + $sid + '</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions><Exec><Command>' + $escapedCommand + '</Command><Arguments>' + $escapedArguments + '</Arguments></Exec></Actions></Task>'",
      "$task = [pscustomobject]@{ TaskName = $expected.Name; Principal = [pscustomobject]@{ UserId = $sid; LogonType = 'InteractiveToken'; RunLevel = 'Limited' }; Actions = @([pscustomobject]@{ Execute = $expected.FilePath; Arguments = $expected.ActionArguments }); Triggers = @([pscustomobject]@{ UserId = $sid; TriggerType = 'Logon' }); Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew'; StartWhenAvailable = $true; ExecutionTimeLimit = 'PT0S'; RestartCount = 3; RestartInterval = 'PT1M' }; Xml = $xml }",
      "$configForTask = [pscustomobject]@{ bootstrapHashes = $hashes }",
      "$valid = Test-HmaRegisteredTaskPlan -Task $task -Config $configForTask -StateRoot 'C:\\private-state'",
      "$normalizedXml = $xml.Replace('<LogonTrigger><UserId>' + $sid + '</UserId>', '<LogonTrigger><UserId>' + $escapedAccount + '</UserId>').Replace('<RunLevel>LeastPrivilege</RunLevel>', '')",
      "$normalizedTask = $task.PSObject.Copy(); $normalizedTask.Principal = [pscustomobject]@{ UserId = $shortAccount; LogonType = 'Interactive'; RunLevel = 'Limited' }; $normalizedTask.Triggers = @([pscustomobject]@{ UserId = $account; TriggerType = 'MSFT_TaskLogonTrigger' }); $normalizedTask.Xml = $normalizedXml",
      "$normalizedValid = Test-HmaRegisteredTaskPlan -Task $normalizedTask -Config $configForTask -StateRoot 'C:\\private-state'",
      "$wrongSidTask = $task.PSObject.Copy(); $wrongSidTask.Principal = [pscustomobject]@{ UserId = 'S-1-5-18'; LogonType = 'InteractiveToken'; RunLevel = 'Limited' }",
      "$wrongTriggerTask = $task.PSObject.Copy(); $wrongTriggerTask.Triggers = @([pscustomobject]@{ UserId = $sid; TriggerType = 'Daily' })",
      "$wrongSettingsTask = $task.PSObject.Copy(); $wrongSettingsTask.Settings = [pscustomobject]@{ MultipleInstances = 'Parallel'; StartWhenAvailable = $true; ExecutionTimeLimit = 'PT0S'; RestartCount = 3; RestartInterval = 'PT1M' }",
      "$wrongXmlTask = $task.PSObject.Copy(); $wrongXmlTask.Xml = $xml.Replace('<Count>3</Count>', '<Count>2</Count>')",
      "$wrongActionTask = $task.PSObject.Copy(); $wrongActionTask.Actions = @([pscustomobject]@{ Execute = $expected.FilePath; Arguments = ($expected.ActionArguments + ' extra') })",
      "$highestWithoutXmlRunLevelTask = $normalizedTask.PSObject.Copy(); $highestWithoutXmlRunLevelTask.Principal = [pscustomobject]@{ UserId = $shortAccount; LogonType = 'Interactive'; RunLevel = 'Highest' }",
      "$duplicateRunLevelTask = $task.PSObject.Copy(); $duplicateRunLevelTask.Xml = $xml.Replace('<RunLevel>LeastPrivilege</RunLevel>', '<RunLevel>LeastPrivilege</RunLevel><RunLevel>HighestAvailable</RunLevel>')",
      "$checks = @($valid, $normalizedValid, (-not (Test-HmaRegisteredTaskPlan -Task $wrongSidTask -Config $configForTask -StateRoot 'C:\\private-state')), (-not (Test-HmaRegisteredTaskPlan -Task $wrongTriggerTask -Config $configForTask -StateRoot 'C:\\private-state')), (-not (Test-HmaRegisteredTaskPlan -Task $wrongSettingsTask -Config $configForTask -StateRoot 'C:\\private-state')), (-not (Test-HmaRegisteredTaskPlan -Task $wrongXmlTask -Config $configForTask -StateRoot 'C:\\private-state')), (-not (Test-HmaRegisteredTaskPlan -Task $wrongActionTask -Config $configForTask -StateRoot 'C:\\private-state')), (-not (Test-HmaRegisteredTaskPlan -Task $highestWithoutXmlRunLevelTask -Config $configForTask -StateRoot 'C:\\private-state')), (-not (Test-HmaRegisteredTaskPlan -Task $duplicateRunLevelTask -Config $configForTask -StateRoot 'C:\\private-state')))",
      "[pscustomobject]@{ unsafeRejected = $unsafeRejected; unsafeTotal = @($unsafeCases).Count; invalidEnvironmentRejected = $invalidEnvironmentRejected; checks = [bool[]]$checks; plansExact = ($plans.Count -eq 2) } | ConvertTo-Json -Compress",
    ]);

    const result = parseSafeRecord<{
      unsafeRejected: number;
      unsafeTotal: number;
      invalidEnvironmentRejected: boolean;
      checks: boolean[];
      plansExact: boolean;
    }>(stdout);
    assert.deepEqual(result, {
      unsafeRejected: 4,
      unsafeTotal: 4,
      invalidEnvironmentRejected: true,
      checks: [true, true, true, true, true, true, true, true, true],
      plansExact: true,
    });
    assert.equal(stderr.length, 0);
    assert.equal(/S-1-|private-state|powershell|arguments|xml/i.test(stdout), false);
  },
);

test(
  "scheduled-task hash guards execute an exactly reviewed script and reject changed bytes",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      ...commonSetup,
      "$root = Join-Path ([IO.Path]::GetTempPath()) ('hma-task-guard-' + [Guid]::NewGuid().ToString('N'))",
      "$bootstrap = Join-Path $root 'bootstrap'",
      "$state = Join-Path $root 'state'",
      "$null = New-Item -ItemType Directory -Path $bootstrap -Force",
      "$null = New-Item -ItemType Directory -Path $state -Force",
      "$marker = Join-Path $state 'executed.marker'",
      "$scriptText = \"param([string]`$StateRoot,[string]`$IntegrityModuleHash)`r`n[IO.File]::WriteAllText((Join-Path `$StateRoot 'executed.marker'), 'ok')\"",
      "$startPath = Join-Path $bootstrap 'start-secure-local.ps1'",
      "$openPath = Join-Path $bootstrap 'open-secure-local.ps1'",
      "[IO.File]::WriteAllText($startPath, $scriptText, (New-Object Text.UTF8Encoding($false)))",
      "[IO.File]::WriteAllText($openPath, $scriptText, (New-Object Text.UTF8Encoding($false)))",
      "$hashes = @{ start = (Get-FileHash -Algorithm SHA256 -LiteralPath $startPath).Hash.ToLowerInvariant(); open = (Get-FileHash -Algorithm SHA256 -LiteralPath $openPath).Hash.ToLowerInvariant(); integrity = ('3' * 64) }",
      ` $plan = @(New-HmaTaskPlans -BootstrapRoot $bootstrap -StateRoot $state -PowerShellPath ${psLiteral(powerShell51)} -BootstrapHashes $hashes)[0]`,
      "$valid = Start-Process -FilePath $plan.FilePath -ArgumentList $plan.ActionArguments -WindowStyle Hidden -Wait -PassThru",
      "$validLaunched = ($valid.ExitCode -eq 0 -and [IO.File]::Exists($marker))",
      "if ([IO.File]::Exists($marker)) { [IO.File]::Delete($marker) }",
      "[IO.File]::AppendAllText($startPath, \"`r`n# changed\")",
      "$changed = Start-Process -FilePath $plan.FilePath -ArgumentList $plan.ActionArguments -WindowStyle Hidden -Wait -PassThru",
      "$changedRejected = ($changed.ExitCode -ne 0 -and -not [IO.File]::Exists($marker))",
      "Remove-Item -LiteralPath $root -Recurse -Force",
      "[bool[]]@($validLaunched, $changedRejected) | ConvertTo-Json -Compress",
    ]);

    assert.deepEqual(parseSafeRecord(stdout), [true, true]);
    assert.equal(stderr.length, 0);
  },
);

test(
  "the Edge launcher uses a challenge proof without sending long-lived secrets and requires one exact service listener",
  windowsOnly,
  async () => {
    const root = path.join(os.tmpdir(), `hma-open-launcher-${process.pid}`);
    const ticket = "Z".repeat(43);
    const challenge = Buffer.alloc(32, 67).toString("base64url");
    const serverProof = bootstrapHmac(
      "how-much-ai:local-bootstrap:server-proof:v1",
      challenge,
    );
    const clientProof = bootstrapHmac(
      "how-much-ai:local-bootstrap:client-proof:v1",
      challenge,
    );
    const fixtureSetup = [
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      "$state = Join-Path $env:HMA_OPEN_ROOT 'state'",
      "$commit = ('d' * 40)",
      "$appRoot = Join-Path (Join-Path $state 'runtime') $commit",
      "$bootstrap = Join-Path $state 'bootstrap'",
      "$null = New-Item -ItemType Directory -Path $appRoot -Force",
      "$null = New-Item -ItemType Directory -Path $bootstrap -Force",
      "$extension = Join-Path $bootstrap 'oauth-handoff-extension'",
      "$null = New-Item -ItemType Directory -Path $extension -Force",
      "foreach ($name in @('vault','edge-profile','oauth-temp')) { $null = New-Item -ItemType Directory -Path (Join-Path $state $name) -Force }",
      "$nodePath = Join-Path $env:HMA_OPEN_ROOT 'node.exe'",
      "[IO.File]::WriteAllText($nodePath, 'synthetic node')",
      "[IO.File]::WriteAllText((Join-Path $appRoot 'package.json'), '{\"private\":true}')",
      `Copy-Item -LiteralPath ${psLiteral(integrityModulePath)} -Destination (Join-Path $bootstrap 'SecureLocalIntegrity.psm1')`,
      `Copy-Item -LiteralPath ${psLiteral(modulePath)} -Destination (Join-Path $bootstrap 'SecureLocalRuntime.psm1')`,
      `Copy-Item -LiteralPath ${psLiteral(openScriptPath)} -Destination (Join-Path $bootstrap 'open-secure-local.ps1')`,
      "[IO.File]::WriteAllText((Join-Path $bootstrap 'start-secure-local.ps1'), '# reviewed start')",
      "[IO.File]::WriteAllText((Join-Path $bootstrap 'connect-claude-secure.ps1'), '# reviewed connector')",
      "[IO.File]::WriteAllText((Join-Path $bootstrap 'launch-secure-local.ps1'), '# reviewed launcher')",
      "[IO.File]::WriteAllText((Join-Path $bootstrap 'verify-final-local-state.ps1'), '# reviewed final verifier')",
      "$syntheticSecrets = \"function Unprotect-HmaSecretBundle { [pscustomobject]@{ version = 1; appPassword = ('a' * 64); authSecret = ('b' * 64); vaultEncryptionSecret = ('c' * 64) } }`r`nExport-ModuleMember -Function 'Unprotect-HmaSecretBundle'\"",
      "[IO.File]::WriteAllText((Join-Path $bootstrap 'SecureLocalSecrets.psm1'), $syntheticSecrets)",
      "[IO.File]::WriteAllText((Join-Path $extension 'manifest.json'), '{\"manifest_version\":3}')",
      "[IO.File]::WriteAllText((Join-Path $extension 'callback.js'), '\"use strict\";')",
      "[IO.File]::WriteAllText((Join-Path $state 'secrets.dpapi'), 'intentionally invalid')",
      "function New-ManifestEntry { param([string]$Root,[string]$Relative,[string]$ManifestPath) $file = Microsoft.PowerShell.Management\\Get-Item -LiteralPath (Join-Path $Root $Relative) -Force; [pscustomobject]@{ path = $ManifestPath; size = [int]$file.Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant() } }",
      "$runtimeFiles = @(New-ManifestEntry -Root $appRoot -Relative 'package.json' -ManifestPath 'package.json')",
      "$bootstrapFiles = @(",
      "  (New-ManifestEntry -Root $bootstrap -Relative 'SecureLocalIntegrity.psm1' -ManifestPath 'scripts/windows/SecureLocalIntegrity.psm1'),",
      "  (New-ManifestEntry -Root $bootstrap -Relative 'SecureLocalRuntime.psm1' -ManifestPath 'scripts/windows/SecureLocalRuntime.psm1'),",
      "  (New-ManifestEntry -Root $bootstrap -Relative 'SecureLocalSecrets.psm1' -ManifestPath 'scripts/windows/SecureLocalSecrets.psm1'),",
      "  (New-ManifestEntry -Root $bootstrap -Relative 'connect-claude-secure.ps1' -ManifestPath 'scripts/windows/connect-claude-secure.ps1'),",
      "  (New-ManifestEntry -Root $bootstrap -Relative 'launch-secure-local.ps1' -ManifestPath 'scripts/windows/launch-secure-local.ps1'),",
      "  (New-ManifestEntry -Root $bootstrap -Relative 'oauth-handoff-extension\\callback.js' -ManifestPath 'scripts/windows/oauth-handoff-extension/callback.js'),",
      "  (New-ManifestEntry -Root $bootstrap -Relative 'oauth-handoff-extension\\manifest.json' -ManifestPath 'scripts/windows/oauth-handoff-extension/manifest.json'),",
      "  (New-ManifestEntry -Root $bootstrap -Relative 'open-secure-local.ps1' -ManifestPath 'scripts/windows/open-secure-local.ps1'),",
      "  (New-ManifestEntry -Root $bootstrap -Relative 'start-secure-local.ps1' -ManifestPath 'scripts/windows/start-secure-local.ps1'),",
      "  (New-ManifestEntry -Root $bootstrap -Relative 'verify-final-local-state.ps1' -ManifestPath 'scripts/windows/verify-final-local-state.ps1')",
      ")",
      "$manifest = [ordered]@{ commit = $commit; nodeSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodePath).Hash.ToLowerInvariant(); installerSha256 = ('f' * 64); runtimeFiles = $runtimeFiles; bootstrapFiles = $bootstrapFiles }",
      "$integrityPath = Join-Path $state 'integrity.json'",
      "[IO.File]::WriteAllText($integrityPath, ($manifest | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))",
      "$byName = @{}; foreach ($entry in $bootstrapFiles) { $byName[[IO.Path]::GetFileName([string]$entry.path)] = [string]$entry.sha256 }",
      "$install = [ordered]@{ version = 1; appRoot = $appRoot; stateRoot = $state; nodePath = $nodePath; port = 37645; upstreamBase = '1238189b7017601d21e3579d041480ce3773e191'; commit = $commit; manifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $integrityPath).Hash.ToLowerInvariant(); bootstrapHashes = [ordered]@{ start = $byName['start-secure-local.ps1']; open = $byName['open-secure-local.ps1']; connector = $byName['connect-claude-secure.ps1']; launcher = $byName['launch-secure-local.ps1']; integrity = $byName['SecureLocalIntegrity.psm1']; runtime = $byName['SecureLocalRuntime.psm1']; secrets = $byName['SecureLocalSecrets.psm1']; finalVerifier = $byName['verify-final-local-state.ps1']; extensionManifest = $byName['manifest.json']; extensionCallback = $byName['callback.js'] } }",
      "[IO.File]::WriteAllText((Join-Path $state 'install.json'), ($install | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))",
      `Import-Module ${psLiteral(secretsModulePath)} -Force`,
      "Set-HmaPrivateAcl -LiteralPath $state",
      "Remove-Module SecureLocalSecrets -Force -ErrorAction SilentlyContinue",
      "$stableProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)",
      "$stableProgramFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)",
      "$poisonProgramFiles = Join-Path $env:HMA_OPEN_ROOT 'poison-program-files'",
      "$poisonProgramFilesX86 = Join-Path $env:HMA_OPEN_ROOT 'poison-program-files-x86'",
      "$script:edgeBases = @(@($stableProgramFiles, $stableProgramFilesX86, $poisonProgramFiles, $poisonProgramFilesX86) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)",
      "[Environment]::SetEnvironmentVariable('ProgramFiles', $poisonProgramFiles, 'Process')",
      "[Environment]::SetEnvironmentVariable('ProgramFiles(x86)', $poisonProgramFilesX86, 'Process')",
      "$script:readinessCalls = 0; $script:challengeGets = 0; $script:proofPosts = 0; $script:longLivedSecretSent = $false; $script:edgeStarts = 0; $script:poisonCandidateUses = 0; $script:listenerTerminations = 0; $script:listenerAddressPrefilters = 0; $script:listenerPortPrefilters = 0; $script:listenerMode = 'exact'",
      "function Test-Path { [CmdletBinding()] param([Parameter(Position=0)][string]$LiteralPath,[string]$PathType) if ($LiteralPath -match 'Microsoft\\\\Edge\\\\Application\\\\msedge\\.exe$') { if ($LiteralPath.StartsWith($poisonProgramFiles, [StringComparison]::OrdinalIgnoreCase) -or $LiteralPath.StartsWith($poisonProgramFilesX86, [StringComparison]::OrdinalIgnoreCase)) { $script:poisonCandidateUses += 1 }; return $true }; Microsoft.PowerShell.Management\\Test-Path @PSBoundParameters }",
      "function Get-Item { [CmdletBinding()] param([Parameter(Position=0)][string]$LiteralPath,[switch]$Force) foreach ($base in $script:edgeBases) { $candidate = Join-Path $base 'Microsoft\\Edge\\Application\\msedge.exe'; if ([string]::Equals($candidate, $LiteralPath, [StringComparison]::OrdinalIgnoreCase) -or $candidate.StartsWith($LiteralPath.TrimEnd('\\') + '\\', [StringComparison]::OrdinalIgnoreCase)) { if ($LiteralPath.StartsWith($poisonProgramFiles, [StringComparison]::OrdinalIgnoreCase) -or $LiteralPath.StartsWith($poisonProgramFilesX86, [StringComparison]::OrdinalIgnoreCase)) { $script:poisonCandidateUses += 1 }; $isLeaf = [string]::Equals($candidate, $LiteralPath, [StringComparison]::OrdinalIgnoreCase); $attributes = if (-not $isLeaf -and $env:HMA_EDGE_ANCESTOR_REPARSE -ceq '1' -and $LiteralPath.TrimEnd('\\').EndsWith('\\Microsoft', [StringComparison]::OrdinalIgnoreCase) -and ($LiteralPath.StartsWith($stableProgramFiles, [StringComparison]::OrdinalIgnoreCase) -or (-not [string]::IsNullOrWhiteSpace($stableProgramFilesX86) -and $LiteralPath.StartsWith($stableProgramFilesX86, [StringComparison]::OrdinalIgnoreCase)))) { [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint } elseif ($isLeaf) { [IO.FileAttributes]::Normal } else { [IO.FileAttributes]::Directory }; return [pscustomobject]@{ FullName = $LiteralPath; PSIsContainer = (-not $isLeaf); Attributes = $attributes } } }; Microsoft.PowerShell.Management\\Get-Item @PSBoundParameters }",
      "function Get-AuthenticodeSignature { [CmdletBinding()] param([string]$LiteralPath) if ($LiteralPath.StartsWith($poisonProgramFiles, [StringComparison]::OrdinalIgnoreCase) -or $LiteralPath.StartsWith($poisonProgramFilesX86, [StringComparison]::OrdinalIgnoreCase)) { $script:poisonCandidateUses += 1 }; [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US' } } }",
      "$exactListener = [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 37645; State = 'Listen'; OwningProcess = 42 }",
      "$unknownListener = [pscustomobject]@{ LocalAddress = '0.0.0.0'; LocalPort = 37645; State = 'Listen'; OwningProcess = 84 }",
      "$irrelevantListener = [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 3000; State = 'Listen'; OwningProcess = 21 }",
      "function Get-NetTCPConnection { [CmdletBinding()] param([string]$LocalAddress,[int]$LocalPort,[string]$State) $rows = if ($env:HMA_OPEN_LISTENERS -ceq 'extra') { @($exactListener, $unknownListener, $irrelevantListener) } elseif ($env:HMA_OPEN_LISTENERS -ceq 'wildcard' -or $script:listenerMode -ceq 'swapped') { @($unknownListener, $irrelevantListener) } else { @($exactListener, $irrelevantListener) }; if ($PSBoundParameters.ContainsKey('LocalAddress')) { $script:listenerAddressPrefilters += 1; $rows = @($rows | Where-Object { [string]$_.LocalAddress -ceq $LocalAddress }) }; if ($PSBoundParameters.ContainsKey('LocalPort')) { $script:listenerPortPrefilters += 1; $rows = @($rows | Where-Object { [int]$_.LocalPort -eq $LocalPort }) }; @($rows) }",
      "$exactCommand = '\"' + $nodePath + '\" \"' + (Join-Path $appRoot 'node_modules\\next\\dist\\bin\\next') + '\" start --hostname 127.0.0.1 --port 37645'",
      "function Get-CimInstance { [CmdletBinding()] param([string]$ClassName,[string]$Filter) $command = if ($env:HMA_OPEN_MATCH -ceq '1') { $exactCommand } else { $exactCommand + ' --inspect' }; [pscustomobject]@{ ProcessId = 42; ExecutablePath = $nodePath; CommandLine = $command } }",
      "function Invoke-WebRequest { [CmdletBinding()] param([string]$Uri,[string]$Method = 'Get',[string]$ContentType,[string]$Body,[hashtable]$Headers,[switch]$UseBasicParsing,[int]$MaximumRedirection,[int]$TimeoutSec) if ($Uri -ceq 'http://127.0.0.1:37645/api/auth/bootstrap/start') { if ($null -eq $Headers -or $Headers.Count -ne 1 -or [string]$Headers['X-HMA-Local-Bootstrap'] -cne 'proof-v1') { throw 'Missing bootstrap request marker.' }; if ($Method -ceq 'Post') { $script:proofPosts += 1; if ($Body.Contains(('a' * 64)) -or $Body.Contains(('b' * 64)) -or $Body.Contains(('c' * 64))) { $script:longLivedSecretSent = $true }; $proofBody = ConvertFrom-Json -InputObject $Body; $proofProperties = @($proofBody.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object); if ([bool](Compare-Object @('challenge','proof') $proofProperties -CaseSensitive) -or [string]$proofBody.challenge -cne $env:HMA_OPEN_CHALLENGE -or [string]$proofBody.proof -cne $env:HMA_OPEN_CLIENT_PROOF) { throw 'Unexpected proof request.' }; return [pscustomobject]@{ StatusCode = 200; Content = ('{\"ticket\":\"' + $env:HMA_OPEN_TICKET + '\",\"expiresInMs\":20000}'); Headers = @{} } }; $script:challengeGets += 1; return [pscustomobject]@{ StatusCode = 200; Content = ('{\"challenge\":\"' + $env:HMA_OPEN_CHALLENGE + '\",\"serverProof\":\"' + $env:HMA_OPEN_SERVER_PROOF + '\",\"expiresInMs\":10000}'); Headers = @{} } }; $script:readinessCalls += 1; if ($env:HMA_OPEN_SWAP_AFTER_READY -ceq '1') { $script:listenerMode = 'swapped' }; [pscustomobject]@{ StatusCode = 200; Content = ''; Headers = @{} } }",
      "function Start-Sleep { param([int]$Milliseconds) throw 'Readiness unexpectedly waited.' }",
      "function Start-Process { [CmdletBinding()] param([string]$FilePath,[object[]]$ArgumentList,[string]$WindowStyle) $script:edgeStarts += 1 }",
      "function Stop-Process { [CmdletBinding()] param([int]$Id,[switch]$Force) $script:listenerTerminations += 1 }",
      "$failed = $false; $failureMessage = ''",
      "try { . (Join-Path $bootstrap 'open-secure-local.ps1') -StateRoot $state -IntegrityModuleHash $install.bootstrapHashes.integrity } catch { $failed = $true; $failureMessage = [string]$_.Exception.Message }",
      "[pscustomobject]@{ failed = $failed; sanitizedError = ((-not $failed -and $failureMessage -ceq '') -or ($failed -and $failureMessage -ceq 'Secure local window launch failed.')); unfilteredQuery = ($script:listenerAddressPrefilters -eq 0 -and $script:listenerPortPrefilters -eq 0); readinessCalls = $script:readinessCalls; challengeGets = $script:challengeGets; proofPosts = $script:proofPosts; longLivedSecretSent = $script:longLivedSecretSent; edgeStarts = $script:edgeStarts; listenerTerminations = $script:listenerTerminations; poisonCandidateUsed = ($script:poisonCandidateUses -gt 0) } | ConvertTo-Json -Compress",
    ];

    try {
      const matching = await runPowerShell(fixtureSetup, {
        HMA_OPEN_ROOT: root,
        HMA_OPEN_MATCH: "1",
        HMA_OPEN_TICKET: ticket,
        HMA_OPEN_CHALLENGE: challenge,
        HMA_OPEN_SERVER_PROOF: serverProof,
        HMA_OPEN_CLIENT_PROOF: clientProof,
      });
      assert.deepEqual(parseSafeRecord(matching.stdout), {
        failed: false,
        sanitizedError: true,
        unfilteredQuery: true,
        readinessCalls: 1,
        challengeGets: 1,
        proofPosts: 1,
        longLivedSecretSent: false,
        edgeStarts: 1,
        listenerTerminations: 0,
        poisonCandidateUsed: false,
      });
      assert.equal(matching.stderr.length, 0);
      assert.equal(matching.stdout.includes(ticket), false);
      assert.equal(matching.stdout.includes("a".repeat(64)), false);

      const extraListenerRoot = `${root}-extra-listener`;
      const extraListener = await runPowerShell(fixtureSetup, {
        HMA_OPEN_ROOT: extraListenerRoot,
        HMA_OPEN_MATCH: "1",
        HMA_OPEN_LISTENERS: "extra",
        HMA_OPEN_TICKET: ticket,
        HMA_OPEN_CHALLENGE: challenge,
        HMA_OPEN_SERVER_PROOF: serverProof,
        HMA_OPEN_CLIENT_PROOF: clientProof,
      });
      assert.deepEqual(parseSafeRecord(extraListener.stdout), {
        failed: true,
        sanitizedError: true,
        unfilteredQuery: true,
        readinessCalls: 0,
        challengeGets: 0,
        proofPosts: 0,
        longLivedSecretSent: false,
        edgeStarts: 0,
        listenerTerminations: 0,
        poisonCandidateUsed: false,
      });
      assert.equal(extraListener.stderr.length, 0);
      assert.equal(extraListener.stdout.includes(ticket), false);
      assert.equal(extraListener.stdout.includes("a".repeat(64)), false);
      await rm(extraListenerRoot, { recursive: true, force: true });

      const swappedAfterReadyRoot = `${root}-swapped-after-ready`;
      const swappedAfterReady = await runPowerShell(fixtureSetup, {
        HMA_OPEN_ROOT: swappedAfterReadyRoot,
        HMA_OPEN_MATCH: "1",
        HMA_OPEN_SWAP_AFTER_READY: "1",
        HMA_OPEN_TICKET: ticket,
        HMA_OPEN_CHALLENGE: challenge,
        HMA_OPEN_SERVER_PROOF: serverProof,
        HMA_OPEN_CLIENT_PROOF: clientProof,
      });
      assert.deepEqual(parseSafeRecord(swappedAfterReady.stdout), {
        failed: true,
        sanitizedError: true,
        unfilteredQuery: true,
        readinessCalls: 1,
        challengeGets: 0,
        proofPosts: 0,
        longLivedSecretSent: false,
        edgeStarts: 0,
        listenerTerminations: 0,
        poisonCandidateUsed: false,
      });
      assert.equal(swappedAfterReady.stderr.length, 0);
      assert.equal(swappedAfterReady.stdout.includes(ticket), false);
      assert.equal(swappedAfterReady.stdout.includes("a".repeat(64)), false);
      await rm(swappedAfterReadyRoot, { recursive: true, force: true });

      const forgedServerRoot = `${root}-forged-server-proof`;
      const forgedServer = await runPowerShell(fixtureSetup, {
        HMA_OPEN_ROOT: forgedServerRoot,
        HMA_OPEN_MATCH: "1",
        HMA_OPEN_TICKET: ticket,
        HMA_OPEN_CHALLENGE: challenge,
        HMA_OPEN_SERVER_PROOF: "A".repeat(43),
        HMA_OPEN_CLIENT_PROOF: clientProof,
      });
      assert.deepEqual(parseSafeRecord(forgedServer.stdout), {
        failed: true,
        sanitizedError: true,
        unfilteredQuery: true,
        readinessCalls: 1,
        challengeGets: 1,
        proofPosts: 0,
        longLivedSecretSent: false,
        edgeStarts: 0,
        listenerTerminations: 0,
        poisonCandidateUsed: false,
      });
      assert.equal(forgedServer.stderr.length, 0);
      assert.equal(forgedServer.stdout.includes(ticket), false);
      assert.equal(forgedServer.stdout.includes("b".repeat(64)), false);
      await rm(forgedServerRoot, { recursive: true, force: true });

      const mismatchedRoot = `${root}-mismatch`;
      const mismatched = await runPowerShell(fixtureSetup, {
        HMA_OPEN_ROOT: mismatchedRoot,
        HMA_OPEN_MATCH: "0",
        HMA_OPEN_TICKET: ticket,
        HMA_OPEN_CHALLENGE: challenge,
        HMA_OPEN_SERVER_PROOF: serverProof,
        HMA_OPEN_CLIENT_PROOF: clientProof,
      });
      assert.deepEqual(parseSafeRecord(mismatched.stdout), {
        failed: true,
        sanitizedError: true,
        unfilteredQuery: true,
        readinessCalls: 0,
        challengeGets: 0,
        proofPosts: 0,
        longLivedSecretSent: false,
        edgeStarts: 0,
        listenerTerminations: 0,
        poisonCandidateUsed: false,
      });
      assert.equal(mismatched.stderr.length, 0);
      assert.equal(mismatched.stdout.includes(ticket), false);
      await rm(mismatchedRoot, { recursive: true, force: true });

      const reparseRoot = `${root}-reparse`;
      const reparse = await runPowerShell(fixtureSetup, {
        HMA_OPEN_ROOT: reparseRoot,
        HMA_OPEN_MATCH: "1",
        HMA_OPEN_TICKET: ticket,
        HMA_OPEN_CHALLENGE: challenge,
        HMA_OPEN_SERVER_PROOF: serverProof,
        HMA_OPEN_CLIENT_PROOF: clientProof,
        HMA_EDGE_ANCESTOR_REPARSE: "1",
      });
      assert.deepEqual(parseSafeRecord(reparse.stdout), {
        failed: true,
        sanitizedError: true,
        unfilteredQuery: true,
        readinessCalls: 0,
        challengeGets: 0,
        proofPosts: 0,
        longLivedSecretSent: false,
        edgeStarts: 0,
        listenerTerminations: 0,
        poisonCandidateUsed: false,
      });
      assert.equal(reparse.stderr.length, 0);
      assert.equal(reparse.stdout.includes(ticket), false);
      await rm(reparseRoot, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "the manifest-driven installer is idempotent, upgrades with CAS, and refuses unreviewed or live state",
  windowsOnly,
  async () => {
    const root = path.join(os.tmpdir(), `hma-installer-${process.pid}`);
    const source = path.join(root, "source");
    const state = path.join(root, "state");
    const manifestSwapState = path.join(root, "manifest-swap-state");
    const manifestSwapMarker = path.join(root, "manifest-swap-executed.txt");
    const sourceSwapState = path.join(root, "source-swap-state");
    const sourceSwapMarker = path.join(root, "source-swap-executed.txt");
    const unmanifestedState = path.join(root, "unmanifested-state");
    const foreignState = path.join(root, "foreign-state");
    const missingTrustState = path.join(root, "missing-trust-state");
    const wrongNodeHashState = path.join(root, "wrong-node-hash-state");
    const wrongPs51HashState = path.join(root, "wrong-ps51-hash-state");
    const hostileNodeState = path.join(root, "hostile-node-state");
    const rollbackState = path.join(root, "rollback-state");
    const replacementState = path.join(root, "replacement-state");
    const raceState = path.join(root, "race-state");
    const commit = "d".repeat(40);
    const { stdout, stderr } = await runPowerShellFile(
      [
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        "$source = $env:HMA_INSTALL_SOURCE",
        "$state = $env:HMA_INSTALL_STATE",
        "$null = New-Item -ItemType Directory -Path (Join-Path $source 'audit\\final') -Force",
        "$null = New-Item -ItemType Directory -Path (Join-Path $source 'scripts\\windows') -Force",
        "$null = New-Item -ItemType Directory -Path (Join-Path $source 'scripts\\windows\\oauth-handoff-extension') -Force",
        "$null = New-Item -ItemType Directory -Path (Join-Path $source '.next\\server\\chunks') -Force",
        "$null = New-Item -ItemType Directory -Path (Join-Path $source 'node_modules\\convex\\dist') -Force",
        "$null = New-Item -ItemType Directory -Path (Join-Path $source 'node_modules\\convex\\src\\cli\\lib') -Force",
        "$null = New-Item -ItemType Directory -Path (Join-Path $source 'node_modules\\next\\dist\\docs\\01-app\\02-guides') -Force",
        "$syntheticPrivateKeyMarker = @('-----BEGIN', 'PRIVATE KEY-----') -join ' '",
        "[IO.File]::WriteAllText((Join-Path $source 'package.json'), '{\"private\":true}')",
        "[IO.File]::WriteAllText((Join-Path $source '.env.example'), 'EXAMPLE_ONLY=1')",
        "[IO.File]::WriteAllText((Join-Path $source '.next\\server\\chunks\\synthetic.js.map'), 'refreshToken: synthetic')",
        "[IO.File]::WriteAllText((Join-Path $source 'node_modules\\convex\\dist\\cli.bundle.cjs'), $syntheticPrivateKeyMarker)",
        "[IO.File]::WriteAllText((Join-Path $source 'node_modules\\convex\\dist\\cli.bundle.cjs.map'), $syntheticPrivateKeyMarker)",
        "[IO.File]::WriteAllText((Join-Path $source 'node_modules\\convex\\src\\cli\\lib\\formatEnvValueForDotfile.test.ts'), $syntheticPrivateKeyMarker)",
        "[IO.File]::WriteAllText((Join-Path $source 'node_modules\\next\\dist\\docs\\01-app\\02-guides\\environment-variables.md'), $syntheticPrivateKeyMarker)",
        `Copy-Item -LiteralPath ${psLiteral(integrityModulePath)} -Destination (Join-Path $source 'scripts\\windows\\SecureLocalIntegrity.psm1')`,
        `Copy-Item -LiteralPath ${psLiteral(modulePath)} -Destination (Join-Path $source 'scripts\\windows\\SecureLocalRuntime.psm1')`,
        "$runtimeFixturePath = Join-Path $source 'scripts\\windows\\SecureLocalRuntime.psm1'",
        "$runtimeFixtureText = [IO.File]::ReadAllText($runtimeFixturePath)",
        "$runtimeFixtureText += \"`r`nfunction New-HmaStartMenuLauncherPlan { param([string]`$StateRoot,[string]`$PowerShellPath,[string]`$IntegrityHash,[string]`$LauncherHash) `$fso = New-Object -ComObject Scripting.FileSystemObject; `$canonicalPowerShell = [string]`$fso.GetFile(`$PowerShellPath).Path; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject(`$fso); [pscustomobject][ordered]@{ Path = (Join-Path `$env:HMA_INSTALL_PROGRAMS 'How Much AI.lnk'); TargetPath = `$canonicalPowerShell; Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command synthetic'; WorkingDirectory = (Join-Path `$StateRoot 'bootstrap'); Description = 'Open the secure local How Much AI dashboard.'; IconLocation = (`$canonicalPowerShell + ',0'); WindowStyle = 7; Hotkey = '' } }`r`n`$originalLauncherTest = `${function:Test-HmaStartMenuLauncherPlan}`r`nfunction Test-HmaStartMenuLauncherPlan { param(`$Plan) `$destination = Join-Path `$env:HMA_INSTALL_PROGRAMS 'How Much AI.lnk'; if (`$env:HMA_LAUNCH_POSTMOVE_FAIL -ceq '1' -and [string]`$Plan.Path -ceq `$destination) { if (`$env:HMA_LAUNCH_REPLACE_ON_FAIL -ceq '1') { [IO.File]::Delete(`$destination); [IO.File]::WriteAllText(`$destination, 'replacement') }; return `$false }; `$result = [bool](& `$originalLauncherTest -Plan `$Plan); `$parentName = [IO.Path]::GetFileName([IO.Path]::GetDirectoryName([string]`$Plan.Path)); if (`$result -and `$env:HMA_LAUNCH_DESTINATION_RACE -ceq '1' -and `$parentName -like '.hma-launcher-*') { [IO.File]::WriteAllText(`$destination, 'race-winner') }; return `$result }`r`nExport-ModuleMember -Function New-HmaStartMenuLauncherPlan,Test-HmaStartMenuLauncherPlan`r`n\"",
        "[IO.File]::WriteAllText($runtimeFixturePath, $runtimeFixtureText, (New-Object Text.UTF8Encoding($false)))",
        `Copy-Item -LiteralPath ${psLiteral(secretsModulePath)} -Destination (Join-Path $source 'scripts\\windows\\SecureLocalSecrets.psm1')`,
        `Copy-Item -LiteralPath ${psLiteral(openScriptPath)} -Destination (Join-Path $source 'scripts\\windows\\open-secure-local.ps1')`,
        `Copy-Item -LiteralPath ${psLiteral(startScriptPath)} -Destination (Join-Path $source 'scripts\\windows\\start-secure-local.ps1')`,
        `Copy-Item -LiteralPath ${psLiteral(launchScriptPath)} -Destination (Join-Path $source 'scripts\\windows\\launch-secure-local.ps1')`,
        `Copy-Item -LiteralPath ${psLiteral(finalVerifierScriptPath)} -Destination (Join-Path $source 'scripts\\windows\\verify-final-local-state.ps1')`,
        "[IO.File]::WriteAllText((Join-Path $source 'scripts\\windows\\connect-claude-secure.ps1'), '# reviewed connector')",
        "[IO.File]::WriteAllText((Join-Path $source 'scripts\\windows\\oauth-handoff-extension\\manifest.json'), '{\"manifest_version\":3}')",
        "[IO.File]::WriteAllText((Join-Path $source 'scripts\\windows\\oauth-handoff-extension\\callback.js'), '\"use strict\";')",
        "$nodePath = 'C:\\Program Files\\nodejs\\node.exe'",
        "$ps51Path = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\\v1.0\\powershell.exe')",
        "$nodeHash = (Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $nodePath).Hash.ToLowerInvariant()",
        "$ps51Hash = (Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $ps51Path).Hash.ToLowerInvariant()",
        "$installerTrustArguments = @{ NodePath = $nodePath; ExpectedNodeSha256 = $nodeHash; Ps51Path = $ps51Path; ExpectedPs51Sha256 = $ps51Hash }",
        "$null = New-Item -ItemType Directory -Path $env:HMA_INSTALL_PROGRAMS -Force",
        "$hostileBin = Join-Path $env:HMA_INSTALL_ROOT 'hostile-bin'",
        "$null = New-Item -ItemType Directory -Path $hostileBin -Force",
        "$hostileNodePath = Join-Path $hostileBin 'node.exe'",
        "[IO.File]::Copy($nodePath, $hostileNodePath, $false)",
        "if ((Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $hostileNodePath).Hash.ToLowerInvariant() -cne $nodeHash) { throw 'The hostile PATH fixture is invalid.' }",
        "$env:PATH = $hostileBin + ';' + $env:PATH",
        "function New-SourceEntry { param([string]$Relative) $full = Join-Path $source $Relative; $file = Microsoft.PowerShell.Management\\Get-Item -LiteralPath $full -Force; [pscustomobject]@{ path = $Relative.Replace('\\','/'); size = [int]$file.Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $full).Hash.ToLowerInvariant() } }",
        "$runtimeFiles = @(New-SourceEntry 'package.json')",
        "$bootstrapFiles = @((New-SourceEntry 'scripts\\windows\\SecureLocalIntegrity.psm1'), (New-SourceEntry 'scripts\\windows\\SecureLocalRuntime.psm1'), (New-SourceEntry 'scripts\\windows\\SecureLocalSecrets.psm1'), (New-SourceEntry 'scripts\\windows\\connect-claude-secure.ps1'), (New-SourceEntry 'scripts\\windows\\launch-secure-local.ps1'), (New-SourceEntry 'scripts\\windows\\oauth-handoff-extension\\callback.js'), (New-SourceEntry 'scripts\\windows\\oauth-handoff-extension\\manifest.json'), (New-SourceEntry 'scripts\\windows\\open-secure-local.ps1'), (New-SourceEntry 'scripts\\windows\\start-secure-local.ps1'), (New-SourceEntry 'scripts\\windows\\verify-final-local-state.ps1'))",
        "$manifest = [ordered]@{ commit = $env:HMA_INSTALL_COMMIT; nodeSha256 = $nodeHash; installerSha256 = ('f' * 64); runtimeFiles = $runtimeFiles; bootstrapFiles = $bootstrapFiles }",
        "$manifestPath = Join-Path $source 'audit\\final\\runtime-manifest.json'",
        "$trustedManifestText = $manifest | ConvertTo-Json -Depth 8 -Compress",
        "[IO.File]::WriteAllText($manifestPath, $trustedManifestText, (New-Object Text.UTF8Encoding($false)))",
        "$manifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant()",
        "[IO.File]::WriteAllText((Join-Path $source 'audit\\final\\runtime-manifest.sha256'), $manifestHash, (New-Object Text.UTF8Encoding($false)))",
        "[IO.File]::WriteAllText((Join-Path $source 'audit\\final\\final-commit.txt'), $env:HMA_INSTALL_COMMIT, (New-Object Text.UTF8Encoding($false)))",
        "$maliciousIntegrityText = \"[IO.File]::WriteAllText([Environment]::GetEnvironmentVariable('HMA_MANIFEST_SWAP_MARKER'), 'executed')\"",
        "$maliciousIntegrityBytes = (New-Object Text.UTF8Encoding($false)).GetBytes($maliciousIntegrityText)",
        "$maliciousSha = [Security.Cryptography.SHA256]::Create(); try { $maliciousIntegrityHash = ([BitConverter]::ToString($maliciousSha.ComputeHash($maliciousIntegrityBytes))).Replace('-', '').ToLowerInvariant() } finally { $maliciousSha.Dispose() }",
        "$swappedBootstrapFiles = @($bootstrapFiles | ForEach-Object { if ([string]$_.path -ceq 'scripts/windows/SecureLocalIntegrity.psm1') { [pscustomobject]@{ path = [string]$_.path; size = [int]$maliciousIntegrityBytes.Length; sha256 = $maliciousIntegrityHash } } else { $_ } })",
        "$swappedManifest = [ordered]@{ commit = $manifest.commit; nodeSha256 = $manifest.nodeSha256; installerSha256 = $manifest.installerSha256; runtimeFiles = $runtimeFiles; bootstrapFiles = $swappedBootstrapFiles }",
        "$script:swappedManifestText = $swappedManifest | ConvertTo-Json -Depth 8 -Compress",
        "$script:gitCalls = 0",
        "function git { $script:gitCalls += 1; throw 'Ambient Git must not execute.' }",
        "$script:manifestSwapArmed = $false",
        "$script:sourceSwapArmed = $false",
        "function Get-FileHash { [CmdletBinding()] param([string]$Algorithm,[string]$LiteralPath) $result = Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm $Algorithm -LiteralPath $LiteralPath -ErrorAction Stop; $target = Join-Path $source 'scripts\\windows\\SecureLocalIntegrity.psm1'; if ($script:manifestSwapArmed -and [string]::Equals([IO.Path]::GetFullPath($LiteralPath), [IO.Path]::GetFullPath($manifestPath), [StringComparison]::OrdinalIgnoreCase)) { $script:manifestSwapArmed = $false; [IO.File]::WriteAllText($manifestPath, $script:swappedManifestText, (New-Object Text.UTF8Encoding($false))); [IO.File]::WriteAllText($target, $maliciousIntegrityText, (New-Object Text.UTF8Encoding($false))) } elseif ($script:sourceSwapArmed -and [string]::Equals([IO.Path]::GetFullPath($LiteralPath), [IO.Path]::GetFullPath($target), [StringComparison]::OrdinalIgnoreCase)) { $script:sourceSwapArmed = $false; [IO.File]::WriteAllText($target, \"[IO.File]::WriteAllText([Environment]::GetEnvironmentVariable('HMA_SOURCE_SWAP_MARKER'), 'executed')\", (New-Object Text.UTF8Encoding($false))) }; return $result }",
        "$script:taskStore = @{}; $script:registrationCount = 0; $script:forceRegistrationCount = 0; $script:unregistrationCount = 0; $script:foreignTaskMutationCount = 0; $script:taskDestinationRace = ''; $script:shortcutIdentityRace = $false; $script:rollbackTaskFailure = $false; $script:rollbackProofHazard = $false; $script:rollbackStopCount = 0; $script:rollbackReadyDelay = 0; $script:journalPublications = 0; $script:journalRetirements = 0; $script:listenerMode = 'none'; $script:listenerTerminations = 0; $script:listenerAddressPrefilters = 0; $script:listenerPortPrefilters = 0; $script:serviceCommand = ''; $script:updateFault = ''; $script:edgeLive = $false",
        "function New-ScheduledTaskAction { [CmdletBinding()] param([string]$Execute,[string]$Argument) [pscustomobject]@{ Execute = $Execute; Arguments = $Argument } }",
        "function New-ScheduledTaskTrigger { [CmdletBinding()] param([switch]$AtLogOn,[string]$User) [pscustomobject]@{ UserId = $User; TriggerType = 'Logon' } }",
        "function New-ScheduledTaskPrincipal { [CmdletBinding()] param([string]$UserId,[string]$LogonType,[string]$RunLevel) [pscustomobject]@{ UserId = $UserId; LogonType = 'InteractiveToken'; RunLevel = $RunLevel } }",
        "function New-ScheduledTaskSettingsSet { [CmdletBinding()] param([string]$MultipleInstances,[switch]$StartWhenAvailable,[TimeSpan]$ExecutionTimeLimit,[int]$RestartCount,[TimeSpan]$RestartInterval) [pscustomobject]@{ MultipleInstances = $MultipleInstances; StartWhenAvailable = [bool]$StartWhenAvailable; ExecutionTimeLimit = 'PT0S'; RestartCount = $RestartCount; RestartInterval = 'PT1M' } }",
        "function Register-ScheduledTask { [CmdletBinding()] param([string]$TaskName,$Action,$Trigger,$Principal,$Settings,[switch]$Force) $raced = ($script:taskDestinationRace -ceq $TaskName); if ($raced) { $script:taskDestinationRace = ''; $script:taskStore[$TaskName] = [pscustomobject]@{ TaskName = $TaskName; Actions = @([pscustomobject]@{ Execute = 'C:\\foreign.exe'; Arguments = 'foreign-race' }); Triggers = @($Trigger); Principal = $Principal; Settings = $Settings; State = 'Ready' } }; if ($Force) { $script:forceRegistrationCount += 1; if ($script:taskStore.ContainsKey($TaskName) -and [string]$script:taskStore[$TaskName].Actions[0].Arguments -ceq 'foreign-race') { $script:foreignTaskMutationCount += 1 } } elseif ($script:taskStore.ContainsKey($TaskName)) { throw 'The scheduled task destination is occupied.' }; $task = [pscustomobject]@{ TaskName = $TaskName; Actions = @($Action); Triggers = @($Trigger); Principal = $Principal; Settings = $Settings; State = 'Ready' }; $script:taskStore[$TaskName] = $task; $script:registrationCount += 1; if ($raced) { throw 'Injected task destination race.' }; if ($script:updateFault -ceq ('task-' + $TaskName)) { $script:updateFault = ''; throw 'Injected task replacement failure.' }; return $task }",
        "function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName) if ($script:taskStore.ContainsKey($TaskName)) { $task = $script:taskStore[$TaskName]; if ($script:rollbackReadyDelay -gt 0) { $script:rollbackReadyDelay -= 1; return [pscustomobject]@{ TaskName = $task.TaskName; Actions = @($task.Actions); Triggers = @($task.Triggers); Principal = $task.Principal; Settings = $task.Settings; State = 'Running' } }; return $task } }",
        "function Export-ScheduledTask { [CmdletBinding()] param([string]$TaskName) $task = $script:taskStore[$TaskName]; $command = [Security.SecurityElement]::Escape([string]$task.Actions[0].Execute); $arguments = [Security.SecurityElement]::Escape([string]$task.Actions[0].Arguments); $sid = [Security.SecurityElement]::Escape([string]$task.Principal.UserId); '<Task xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"><Triggers><LogonTrigger><UserId>' + $sid + '</UserId></LogonTrigger></Triggers><Principals><Principal><UserId>' + $sid + '</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions><Exec><Command>' + $command + '</Command><Arguments>' + $arguments + '</Arguments></Exec></Actions></Task>' }",
        "function Unregister-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[switch]$Confirm) if ($script:taskStore.ContainsKey($TaskName) -and [string]$script:taskStore[$TaskName].Actions[0].Arguments -ceq 'foreign-race') { $script:foreignTaskMutationCount += 1 }; $script:unregistrationCount += 1; $script:taskStore.Remove($TaskName) | Out-Null }",
        "function Stop-ScheduledTask { [CmdletBinding()] param([string]$TaskName) if ($script:rollbackTaskFailure) { $script:rollbackTaskFailure = $false; throw 'Injected rollback task stop failure.' }; if ($script:rollbackProofHazard) { $script:rollbackStopCount += 1; if ($script:rollbackStopCount -ge 3) { $script:rollbackProofHazard = $false; $script:rollbackReadyDelay = 2; $script:listenerMode = 'exact'; $script:edgeLive = $true } }; if ($script:taskStore.ContainsKey($TaskName)) { if ([string]$script:taskStore[$TaskName].Actions[0].Arguments -ceq 'foreign-race') { $script:foreignTaskMutationCount += 1 }; $script:taskStore[$TaskName].State = 'Ready' } }",
        "function Get-NetTCPConnection { [CmdletBinding()] param([string]$LocalAddress,[int]$LocalPort,[string]$State) $exact = [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 37645; State = 'Listen'; OwningProcess = 42 }; $unknown = [pscustomobject]@{ LocalAddress = '0.0.0.0'; LocalPort = 37645; State = 'Listen'; OwningProcess = 84 }; $otherPort = [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 3000; State = 'Listen'; OwningProcess = 21 }; $rows = if ($script:listenerMode -ceq 'exact') { @($exact, $otherPort) } elseif ($script:listenerMode -ceq 'wildcard') { @($unknown, $otherPort) } elseif ($script:listenerMode -ceq 'multiple') { @($exact, $unknown, $otherPort) } elseif ($script:listenerMode -ceq 'other-port') { @($otherPort) } else { @() }; if ($PSBoundParameters.ContainsKey('LocalAddress')) { $script:listenerAddressPrefilters += 1; $rows = @($rows | Where-Object { [string]$_.LocalAddress -ceq $LocalAddress }) }; if ($PSBoundParameters.ContainsKey('LocalPort')) { $script:listenerPortPrefilters += 1; $rows = @($rows | Where-Object { [int]$_.LocalPort -eq $LocalPort }); if ($script:listenerMode -ceq 'other-port' -and $rows.Count -eq 0) { Write-Error 'No matching MSFT_NetTCPConnection objects found.'; return } }; @($rows) }",
        "function Get-CimInstance { [CmdletBinding()] param([string]$ClassName,[string]$Filter) if ($script:edgeLive) { return [pscustomobject]@{ ProcessId = 88; ExecutablePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'; CommandLine = ('msedge.exe --user-data-dir=' + (Join-Path $state 'edge-profile')) } }; if (-not [string]::IsNullOrWhiteSpace($Filter)) { return [pscustomobject]@{ ProcessId = 42; ExecutablePath = $nodePath; CommandLine = $script:serviceCommand } }; @() }",
        "function Stop-Process { [CmdletBinding()] param([int]$Id,[switch]$Force) $script:listenerTerminations += 1 }",
        "$racePrograms = Join-Path $env:HMA_INSTALL_ROOT 'race-programs'; $null = New-Item -ItemType Directory -Path $racePrograms -Force; $env:HMA_INSTALL_PROGRAMS = $racePrograms; $env:HMA_LAUNCH_DESTINATION_RACE = '1'",
        "$raceFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $env:HMA_RACE_STATE } catch { $raceFailed = $true }",
        "$racePreserved = ($raceFailed -and [IO.File]::Exists((Join-Path $racePrograms 'How Much AI.lnk')) -and [IO.File]::ReadAllText((Join-Path $racePrograms 'How Much AI.lnk')) -ceq 'race-winner' -and $script:registrationCount -eq 0 -and $script:unregistrationCount -eq 0)",
        "$env:HMA_LAUNCH_DESTINATION_RACE = '0'",
        "$rollbackPrograms = Join-Path $env:HMA_INSTALL_ROOT 'rollback-programs'; $null = New-Item -ItemType Directory -Path $rollbackPrograms -Force; $env:HMA_INSTALL_PROGRAMS = $rollbackPrograms; $env:HMA_LAUNCH_POSTMOVE_FAIL = '1'; $env:HMA_LAUNCH_REPLACE_ON_FAIL = '0'",
        "$rollbackFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $env:HMA_ROLLBACK_STATE } catch { $rollbackFailed = $true }",
        "$rollbackRemoved = ($rollbackFailed -and -not [IO.File]::Exists((Join-Path $rollbackPrograms 'How Much AI.lnk')) -and $script:registrationCount -eq 0)",
        "$replacementPrograms = Join-Path $env:HMA_INSTALL_ROOT 'replacement-programs'; $null = New-Item -ItemType Directory -Path $replacementPrograms -Force; $env:HMA_INSTALL_PROGRAMS = $replacementPrograms; $env:HMA_LAUNCH_REPLACE_ON_FAIL = '1'",
        "$replacementFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $env:HMA_REPLACEMENT_STATE } catch { $replacementFailed = $true }",
        "$replacementPreserved = ($replacementFailed -and [IO.File]::Exists((Join-Path $replacementPrograms 'How Much AI.lnk')) -and [IO.File]::ReadAllText((Join-Path $replacementPrograms 'How Much AI.lnk')) -ceq 'replacement' -and $script:registrationCount -eq 0)",
        "$env:HMA_INSTALL_PROGRAMS = Join-Path $env:HMA_INSTALL_ROOT 'programs'; $env:HMA_LAUNCH_POSTMOVE_FAIL = '0'; $env:HMA_LAUNCH_REPLACE_ON_FAIL = '0'",
        "$missingTrustFailed = $false; try { . " + psLiteral(installerScriptPath) + " -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $env:HMA_MISSING_TRUST_STATE } catch { $missingTrustFailed = $true }",
        "$missingTrustRejected = ($missingTrustFailed -and -not [IO.Directory]::Exists($env:HMA_MISSING_TRUST_STATE))",
        "$wrongNodeArguments = $installerTrustArguments.Clone(); $wrongNodeArguments.ExpectedNodeSha256 = ('0' * 64)",
        "$wrongNodeHashFailed = $false; try { . " + psLiteral(installerScriptPath) + " @wrongNodeArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $env:HMA_WRONG_NODE_HASH_STATE } catch { $wrongNodeHashFailed = $true }",
        "$wrongNodeHashRejected = ($wrongNodeHashFailed -and -not [IO.Directory]::Exists($env:HMA_WRONG_NODE_HASH_STATE))",
        "$wrongPs51Arguments = $installerTrustArguments.Clone(); $wrongPs51Arguments.ExpectedPs51Sha256 = ('0' * 64)",
        "$wrongPs51HashFailed = $false; try { . " + psLiteral(installerScriptPath) + " @wrongPs51Arguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $env:HMA_WRONG_PS51_HASH_STATE } catch { $wrongPs51HashFailed = $true }",
        "$wrongPs51HashRejected = ($wrongPs51HashFailed -and -not [IO.Directory]::Exists($env:HMA_WRONG_PS51_HASH_STATE))",
        "$hostileNodeArguments = $installerTrustArguments.Clone(); $hostileNodeArguments.NodePath = $hostileNodePath",
        "$hostileNodeFailed = $false; try { . " + psLiteral(installerScriptPath) + " @hostileNodeArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $env:HMA_HOSTILE_NODE_STATE } catch { $hostileNodeFailed = $true }",
        "$hostileNodeRejected = ($hostileNodeFailed -and -not [IO.Directory]::Exists($env:HMA_HOSTILE_NODE_STATE))",
        "$script:manifestSwapArmed = $true",
        "$manifestSwapFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $env:HMA_MANIFEST_SWAP_STATE } catch { $manifestSwapFailed = $true }",
        "$manifestSwapNotExecuted = -not [IO.File]::Exists($env:HMA_MANIFEST_SWAP_MARKER)",
        "[IO.File]::WriteAllText($manifestPath, $trustedManifestText, (New-Object Text.UTF8Encoding($false)))",
        `Copy-Item -LiteralPath ${psLiteral(integrityModulePath)} -Destination (Join-Path $source 'scripts\\windows\\SecureLocalIntegrity.psm1') -Force`,
        "Remove-Module SecureLocalIntegrity, SecureLocalSecrets -Force -ErrorAction SilentlyContinue",
        "$script:manifestSwapArmed = $false",
        "$script:sourceSwapArmed = $true",
        "$sourceSwapFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $env:HMA_SOURCE_SWAP_STATE } catch { $sourceSwapFailed = $true }",
        "$sourceSwapNotExecuted = -not [IO.File]::Exists($env:HMA_SOURCE_SWAP_MARKER)",
        `Copy-Item -LiteralPath ${psLiteral(integrityModulePath)} -Destination (Join-Path $source 'scripts\\windows\\SecureLocalIntegrity.psm1') -Force`,
        "Remove-Module SecureLocalIntegrity, SecureLocalSecrets -Force -ErrorAction SilentlyContinue",
        "$script:sourceSwapArmed = $false",
        "$firstFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $firstFailed = $true }; $installedState = [string]$state",
        "$secretsPath = Join-Path $state 'secrets.dpapi'",
        "$firstSecretHash = if ([IO.File]::Exists($secretsPath)) { (Get-FileHash -Algorithm SHA256 -LiteralPath $secretsPath).Hash } else { '' }",
        "$secondFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $secondFailed = $true }",
        "$secondSecretHash = if ([IO.File]::Exists($secretsPath)) { (Get-FileHash -Algorithm SHA256 -LiteralPath $secretsPath).Hash } else { '' }",
        "$mainLauncher = Join-Path $env:HMA_INSTALL_PROGRAMS 'How Much AI.lnk'; $launcherBytes = [IO.File]::ReadAllBytes($mainLauncher); $shortcutShell = New-Object -ComObject WScript.Shell; $shortcut = $shortcutShell.CreateShortcut($mainLauncher); $shortcut.Hotkey = 'Ctrl+Alt+H'; $shortcut.Save(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcutShell); Set-HmaPrivateAcl -LiteralPath $mainLauncher",
        "$mismatchHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $mainLauncher).Hash; $registrationsBeforeMismatch = $script:registrationCount; $unregistrationsBeforeMismatch = $script:unregistrationCount; $mismatchError = ''; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $mismatchError = [string]$_.Exception.Message }; $mismatchHashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $mainLauncher).Hash",
        "$mismatchRefusedUntouched = ($mismatchError -ceq 'Secure local installation failed.' -and $mismatchHashBefore -ceq $mismatchHashAfter -and $script:registrationCount -eq $registrationsBeforeMismatch -and $script:unregistrationCount -eq $unregistrationsBeforeMismatch -and $script:taskStore.Count -eq 2)",
        "[IO.File]::WriteAllBytes($mainLauncher, $launcherBytes); [Array]::Clear($launcherBytes, 0, $launcherBytes.Length); Set-HmaPrivateAcl -LiteralPath $mainLauncher",
        "$installedHashCount = if ([IO.File]::Exists((Join-Path $state 'install.json'))) { $installedConfig = ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $state 'install.json'))); @($installedConfig.bootstrapHashes.PSObject.Properties).Count } else { 0 }",
        "$integrityPass = $false; if (-not $secondFailed) { Import-Module (Join-Path $state 'bootstrap\\SecureLocalIntegrity.psm1') -Force; $integrityPass = ($null -ne (Assert-HmaStartupIntegrity -StateRoot $state)) }",
        "$retainedPathsExact = (-not $secondFailed -and [string]$installedConfig.nodePath -ceq $nodePath -and @($script:taskStore.Values | Where-Object { [string]$_.Actions[0].Execute -cne $ps51Path }).Count -eq 0)",
        "$installedAppRoot = Join-Path (Join-Path $state 'runtime') $env:HMA_INSTALL_COMMIT",
        "$excludedArtifactsAbsent = (-not [IO.File]::Exists((Join-Path $installedAppRoot '.next\\server\\chunks\\synthetic.js.map')) -and -not [IO.File]::Exists((Join-Path $installedAppRoot 'node_modules\\convex\\dist\\cli.bundle.cjs')))",
        "$script:serviceCommand = '\"' + $nodePath + '\" \"' + (Join-Path $installedAppRoot 'node_modules\\next\\dist\\bin\\next') + '\" start --hostname 127.0.0.1 --port 37645'",
        "$script:listenerMode = 'other-port'",
        "$beforeOtherPortListener = $script:registrationCount",
        "$otherPortListenerFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $otherPortListenerFailed = $true }",
        "$otherPortListenerAccepted = (-not $otherPortListenerFailed -and $script:registrationCount -eq ($beforeOtherPortListener + 2))",
        "$script:listenerMode = 'exact'",
        "$beforeExactListener = $script:registrationCount",
        "$exactListenerFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $exactListenerFailed = $true }",
        "$exactListenerAccepted = (-not $exactListenerFailed -and $script:registrationCount -eq ($beforeExactListener + 2))",
        "$script:listenerMode = 'wildcard'",
        "$beforeWildcardListener = $script:registrationCount",
        "$wildcardError = ''; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $wildcardError = [string]$_.Exception.Message }",
        "$wildcardListenerRejected = ($wildcardError -ceq 'Secure local installation failed.' -and $script:registrationCount -eq $beforeWildcardListener)",
        "$script:listenerMode = 'multiple'",
        "$beforeMultipleListeners = $script:registrationCount",
        "$multipleError = ''; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $multipleError = [string]$_.Exception.Message }",
        "$multipleListenersRejected = ($multipleError -ceq 'Secure local installation failed.' -and $script:registrationCount -eq $beforeMultipleListeners)",
        "$script:listenerMode = 'none'",
        "$mutationMarker = Join-Path $state 'mutation-marker.txt'",
        "[IO.File]::WriteAllText($mutationMarker, 'must remain untouched', (New-Object Text.UTF8Encoding($false)))",
        "$markerAcl = New-Object Security.AccessControl.FileSecurity",
        "$markerAcl.SetAccessRuleProtection($true, $false)",
        "$markerAcl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)",
        "$markerRule = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')), [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow)",
        "[void]$markerAcl.AddAccessRule($markerRule)",
        "[IO.File]::SetAccessControl($mutationMarker, $markerAcl)",
        "$markerSddlBefore = [IO.File]::GetAccessControl($mutationMarker).Sddl",
        "$beforeInvalidExisting = $script:registrationCount",
        "$invalidExistingFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $invalidExistingFailed = $true }",
        "$markerSddlAfter = [IO.File]::GetAccessControl($mutationMarker).Sddl",
        "$invalidExistingUntouched = ($invalidExistingFailed -and [IO.File]::Exists($mutationMarker) -and [IO.File]::ReadAllText($mutationMarker) -ceq 'must remain untouched' -and $markerSddlBefore -ceq $markerSddlAfter -and $script:registrationCount -eq $beforeInvalidExisting)",
        "Set-HmaPrivateAcl -LiteralPath $mutationMarker",
        "[IO.File]::Delete($mutationMarker)",
        "[IO.File]::WriteAllText((Join-Path $source '.env.local'), 'FORBIDDEN=1')",
        "$beforeForbiddenEnvironment = $script:registrationCount",
        "$forbiddenEnvironmentFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $forbiddenEnvironmentFailed = $true }",
        "[IO.File]::Delete((Join-Path $source '.env.local'))",
        "$forbiddenEnvironmentRejected = ($forbiddenEnvironmentFailed -and $script:registrationCount -eq $beforeForbiddenEnvironment)",
        "[IO.File]::WriteAllText((Join-Path $source 'scripts\\windows\\unmanifested.ps1'), '# extra')",
        "$beforeRefusal = $script:registrationCount",
        "$unmanifestedFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $env:HMA_UNMANIFESTED_STATE } catch { $unmanifestedFailed = $true }",
        "[IO.File]::Delete((Join-Path $source 'scripts\\windows\\unmanifested.ps1'))",
        "$foreignFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $env:HMA_FOREIGN_STATE } catch { $foreignFailed = $true }",
        "$state = $installedState; $preUpgradeRegistrationCount = $script:registrationCount; $releaseAHash = $manifestHash; $releaseACommit = $env:HMA_INSTALL_COMMIT; $releaseBCommit = ('e' * 40)",
        "$mainPrograms = $env:HMA_INSTALL_PROGRAMS; $mainTaskStore = @{}; foreach ($name in @($script:taskStore.Keys)) { $mainTaskStore[$name] = $script:taskStore[$name] }; $mainRegistrationCount = $script:registrationCount; $mainUnregistrationCount = $script:unregistrationCount; $mainForceRegistrationCount = $script:forceRegistrationCount",
        "$taskRaceState = Join-Path $env:HMA_INSTALL_ROOT 'update-task-race-state'; $taskRacePrograms = Join-Path $env:HMA_INSTALL_ROOT 'update-task-race-programs'; $null = New-Item -ItemType Directory -Path $taskRacePrograms -Force; $script:taskStore = @{}; $env:HMA_INSTALL_PROGRAMS = $taskRacePrograms; $taskRaceInstallFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseAHash -StateRoot $taskRaceState } catch { $taskRaceInstallFailed = $true }; $taskRaceTaskStore = @{}; foreach ($name in @($script:taskStore.Keys)) { $taskRaceTaskStore[$name] = $script:taskStore[$name] }; $script:taskStore = $mainTaskStore; $script:registrationCount = $mainRegistrationCount; $script:unregistrationCount = $mainUnregistrationCount; $script:forceRegistrationCount = $mainForceRegistrationCount; $env:HMA_INSTALL_PROGRAMS = $mainPrograms; $state = $installedState; $preUpgradeForceRegistrationCount = $script:forceRegistrationCount",
        "$controlRaceState = Join-Path $env:HMA_INSTALL_ROOT 'update-control-race-state'; $controlRacePrograms = Join-Path $env:HMA_INSTALL_ROOT 'update-control-race-programs'; $null = New-Item -ItemType Directory -Path $controlRacePrograms -Force; $script:taskStore = @{}; $env:HMA_INSTALL_PROGRAMS = $controlRacePrograms; $controlRaceInstallFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseAHash -StateRoot $controlRaceState } catch { $controlRaceInstallFailed = $true }; $controlRaceTaskStore = @{}; foreach ($name in @($script:taskStore.Keys)) { $controlRaceTaskStore[$name] = $script:taskStore[$name] }; $script:taskStore = $mainTaskStore; $script:registrationCount = $mainRegistrationCount; $script:unregistrationCount = $mainUnregistrationCount; $script:forceRegistrationCount = $mainForceRegistrationCount; $env:HMA_INSTALL_PROGRAMS = $mainPrograms; $state = $installedState",
        "$shortcutRaceState = Join-Path $env:HMA_INSTALL_ROOT 'update-shortcut-race-state'; $shortcutRacePrograms = Join-Path $env:HMA_INSTALL_ROOT 'update-shortcut-race-programs'; $null = New-Item -ItemType Directory -Path $shortcutRacePrograms -Force; $script:taskStore = @{}; $env:HMA_INSTALL_PROGRAMS = $shortcutRacePrograms; $shortcutRaceInstallFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseAHash -StateRoot $shortcutRaceState } catch { $shortcutRaceInstallFailed = $true }; $shortcutRaceTaskStore = @{}; foreach ($name in @($script:taskStore.Keys)) { $shortcutRaceTaskStore[$name] = $script:taskStore[$name] }; $script:taskStore = $mainTaskStore; $script:registrationCount = $mainRegistrationCount; $script:unregistrationCount = $mainUnregistrationCount; $script:forceRegistrationCount = $mainForceRegistrationCount; $env:HMA_INSTALL_PROGRAMS = $mainPrograms; $state = $installedState",
        "$badJournalState = Join-Path $env:HMA_INSTALL_ROOT 'bad-journal-state'; $badJournalPrograms = Join-Path $env:HMA_INSTALL_ROOT 'bad-journal-programs'; $null = New-Item -ItemType Directory -Path $badJournalPrograms -Force; $script:taskStore = @{}; $env:HMA_INSTALL_PROGRAMS = $badJournalPrograms; $badJournalInstallFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseAHash -StateRoot $badJournalState } catch { $badJournalInstallFailed = $true }; $badJournalTaskStore = @{}; foreach ($name in @($script:taskStore.Keys)) { $badJournalTaskStore[$name] = $script:taskStore[$name] }; $script:taskStore = $mainTaskStore; $script:registrationCount = $mainRegistrationCount; $script:unregistrationCount = $mainUnregistrationCount; $script:forceRegistrationCount = $mainForceRegistrationCount; $env:HMA_INSTALL_PROGRAMS = $mainPrograms; $state = $installedState; $preUpgradeForceRegistrationCount = $script:forceRegistrationCount",
        "function New-IsolatedAInstall { param([string]$Name) $isolatedState = Join-Path $env:HMA_INSTALL_ROOT ($Name + '-state'); $isolatedPrograms = Join-Path $env:HMA_INSTALL_ROOT ($Name + '-programs'); $null = New-Item -ItemType Directory -Path $isolatedPrograms -Force; $script:taskStore = @{}; $env:HMA_INSTALL_PROGRAMS = $isolatedPrograms; $installFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseAHash -StateRoot $isolatedState } catch { $installFailed = $true }; $isolatedTasks = @{}; foreach ($taskName in @($script:taskStore.Keys)) { $isolatedTasks[$taskName] = $script:taskStore[$taskName] }; return [pscustomobject]@{ State = $isolatedState; Programs = $isolatedPrograms; Tasks = $isolatedTasks; Failed = $installFailed } }",
        "$restoreTamperInstall = New-IsolatedAInstall -Name 'restore-tamper'; $reparseJournalInstall = New-IsolatedAInstall -Name 'reparse-journal'; $emptyJournalInstall = New-IsolatedAInstall -Name 'empty-journal'; $nextJournalInstall = New-IsolatedAInstall -Name 'next-journal'; $retiredJournalInstall = New-IsolatedAInstall -Name 'retired-journal'; $publishBeforeInstall = New-IsolatedAInstall -Name 'publish-before'; $publishAfterInstall = New-IsolatedAInstall -Name 'publish-after'; $childRetireInstall = New-IsolatedAInstall -Name 'child-retire'; $script:taskStore = $mainTaskStore; $script:registrationCount = $mainRegistrationCount; $script:unregistrationCount = $mainUnregistrationCount; $script:forceRegistrationCount = $mainForceRegistrationCount; $env:HMA_INSTALL_PROGRAMS = $mainPrograms; $state = $installedState",
        "$releaseBase = @{}; foreach ($relative in @('package.json','scripts\\windows\\start-secure-local.ps1','scripts\\windows\\open-secure-local.ps1','scripts\\windows\\launch-secure-local.ps1')) { $releaseBase[$relative] = [IO.File]::ReadAllText((Join-Path $source $relative)) }",
        "function Set-ReviewedRelease { param([string]$Commit,[string]$Label) foreach ($relative in @($releaseBase.Keys)) { $text = [string]$releaseBase[$relative]; if ($relative -ceq 'package.json') { $text = '{\"private\":true,\"release\":\"' + $Label + '\"}' } else { $text += \"`r`n# reviewed release `$Label`r`n\" }; [IO.File]::WriteAllText((Join-Path $source $relative), $text, (New-Object Text.UTF8Encoding($false))) }; $script:runtimeFiles = @(New-SourceEntry 'package.json'); $script:bootstrapFiles = @((New-SourceEntry 'scripts\\windows\\SecureLocalIntegrity.psm1'), (New-SourceEntry 'scripts\\windows\\SecureLocalRuntime.psm1'), (New-SourceEntry 'scripts\\windows\\SecureLocalSecrets.psm1'), (New-SourceEntry 'scripts\\windows\\connect-claude-secure.ps1'), (New-SourceEntry 'scripts\\windows\\launch-secure-local.ps1'), (New-SourceEntry 'scripts\\windows\\oauth-handoff-extension\\callback.js'), (New-SourceEntry 'scripts\\windows\\oauth-handoff-extension\\manifest.json'), (New-SourceEntry 'scripts\\windows\\open-secure-local.ps1'), (New-SourceEntry 'scripts\\windows\\start-secure-local.ps1'), (New-SourceEntry 'scripts\\windows\\verify-final-local-state.ps1')); $candidateManifest = [ordered]@{ commit = $Commit; nodeSha256 = $nodeHash; installerSha256 = ('f' * 64); runtimeFiles = $script:runtimeFiles; bootstrapFiles = $script:bootstrapFiles }; $candidateText = $candidateManifest | ConvertTo-Json -Depth 8 -Compress; [IO.File]::WriteAllText($manifestPath, $candidateText, (New-Object Text.UTF8Encoding($false))); $candidateHash = (Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant(); [IO.File]::WriteAllText((Join-Path $source 'audit\\final\\runtime-manifest.sha256'), $candidateHash, (New-Object Text.UTF8Encoding($false))); [IO.File]::WriteAllText((Join-Path $source 'audit\\final\\final-commit.txt'), $Commit, (New-Object Text.UTF8Encoding($false))); return $candidateHash }",
        "function Get-TreeDigest { param([string]$Root) $rows = @(); foreach ($item in @(Get-ChildItem -LiteralPath $Root -Force -Recurse | Sort-Object FullName)) { $relative = $item.FullName.Substring($Root.Length).TrimStart('\\'); if ($item.PSIsContainer) { $rows += ('D:' + $relative) } else { $rows += ('F:' + $relative + ':' + (Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $item.FullName).Hash.ToLowerInvariant()) } }; $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($rows -join \"`n\")); $sha = [Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { [Array]::Clear($bytes,0,$bytes.Length); $sha.Dispose() } }",
        "function Get-TaskDigest { return (@($script:taskStore.Keys | Sort-Object | ForEach-Object { $task = $script:taskStore[$_]; [string]$task.TaskName + '|' + [string]$task.Actions[0].Execute + '|' + [string]$task.Actions[0].Arguments + '|' + [string]$task.State }) -join \"`n\") }",
        "function Get-InstallObservableDigest { $stateDigest = Get-TreeDigest -Root $state; $taskDigest = Get-TaskDigest; $shortcutDigest = (Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $mainLauncher).Hash.ToLowerInvariant(); return ($stateDigest + '|' + $taskDigest + '|' + $shortcutDigest) }",
        "$vaultSentinel = Join-Path $state 'vault\\upgrade-sentinel.bin'; $edgeSentinel = Join-Path $state 'edge-profile\\upgrade-sentinel.bin'; [IO.File]::WriteAllBytes($vaultSentinel, [byte[]](1,3,3,7)); [IO.File]::WriteAllBytes($edgeSentinel, [byte[]](9,8,7,6)); Set-HmaPrivateAcl -LiteralPath $state",
        "$mutableBefore = ((Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $state 'secrets.dpapi')).Hash.ToLowerInvariant() + '|' + (Get-TreeDigest -Root (Join-Path $state 'vault')) + '|' + (Get-TreeDigest -Root (Join-Path $state 'edge-profile'))) ",
        "$sameCommitDifferentManifestHash = Set-ReviewedRelease -Commit $releaseACommit -Label 'A2'",
        "$beforeSameCommit = Get-InstallObservableDigest; $sameCommitDifferentManifestFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $sameCommitDifferentManifestHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $sameCommitDifferentManifestFailed = $true }; $sameCommitDifferentManifestUntouched = ($sameCommitDifferentManifestFailed -and (Get-InstallObservableDigest) -ceq $beforeSameCommit)",
        "$releaseBHash = Set-ReviewedRelease -Commit $releaseBCommit -Label 'B'",
        "$freshCasState = Join-Path $env:HMA_INSTALL_ROOT 'fresh-cas-state'; $freshCasFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $freshCasState } catch { $freshCasFailed = $true }; $freshCasUntouched = ($freshCasFailed -and -not [IO.Directory]::Exists($freshCasState)); $state = $installedState",
        "$beforeMissingCas = Get-InstallObservableDigest; $missingCasFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -StateRoot $state } catch { $missingCasFailed = $true }; $missingCasUntouched = ($missingCasFailed -and (Get-InstallObservableDigest) -ceq $beforeMissingCas)",
        "$beforeWrongCas = Get-InstallObservableDigest; $wrongCasFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 ('0' * 64) -StateRoot $state } catch { $wrongCasFailed = $true }; $wrongCasUntouched = ($wrongCasFailed -and (Get-InstallObservableDigest) -ceq $beforeWrongCas)",
        "$installedPackage = Join-Path (Join-Path (Join-Path $state 'runtime') $releaseACommit) 'package.json'; $installedPackageBytes = [IO.File]::ReadAllBytes($installedPackage); [IO.File]::WriteAllText($installedPackage, 'tampered'); $beforeTampered = Get-InstallObservableDigest; $tamperedOldFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $tamperedOldFailed = $true }; $tamperedOldUntouched = ($tamperedOldFailed -and (Get-InstallObservableDigest) -ceq $beforeTampered); [IO.File]::WriteAllBytes($installedPackage, $installedPackageBytes); [Array]::Clear($installedPackageBytes,0,$installedPackageBytes.Length); Set-HmaPrivateAcl -LiteralPath $installedPackage",
        "$savedServiceArguments = [string]$script:taskStore['HowMuchAI-Service'].Actions[0].Arguments; $script:taskStore['HowMuchAI-Service'].Actions[0].Arguments += ' changed'; $beforeChangedTask = Get-InstallObservableDigest; $changedTaskFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $changedTaskFailed = $true }; $changedTaskUntouched = ($changedTaskFailed -and (Get-InstallObservableDigest) -ceq $beforeChangedTask); $script:taskStore['HowMuchAI-Service'].Actions[0].Arguments = $savedServiceArguments",
        "$shortcutABytes = [IO.File]::ReadAllBytes($mainLauncher); $shortcutShell = New-Object -ComObject WScript.Shell; $shortcut = $shortcutShell.CreateShortcut($mainLauncher); $shortcut.Hotkey = 'Ctrl+Alt+U'; $shortcut.Save(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcutShell); Set-HmaPrivateAcl -LiteralPath $mainLauncher; $beforeChangedShortcut = Get-InstallObservableDigest; $changedShortcutFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $changedShortcutFailed = $true }; $changedShortcutUntouched = ($changedShortcutFailed -and (Get-InstallObservableDigest) -ceq $beforeChangedShortcut); [IO.File]::WriteAllBytes($mainLauncher,$shortcutABytes); Set-HmaPrivateAcl -LiteralPath $mainLauncher",
        "$script:listenerMode = 'exact'; $beforeLiveListener = Get-InstallObservableDigest; $liveListenerFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $liveListenerFailed = $true }; $liveListenerUntouched = ($liveListenerFailed -and (Get-InstallObservableDigest) -ceq $beforeLiveListener); $script:listenerMode = 'none'",
        "$script:taskStore['HowMuchAI-Window'].State = 'Running'; $beforeLiveTask = Get-InstallObservableDigest; $liveTaskFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $liveTaskFailed = $true }; $liveTaskUntouched = ($liveTaskFailed -and (Get-InstallObservableDigest) -ceq $beforeLiveTask); $script:taskStore['HowMuchAI-Window'].State = 'Ready'",
        "$script:edgeLive = $true; $beforeLiveEdge = Get-InstallObservableDigest; $liveEdgeFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $liveEdgeFailed = $true }; $liveEdgeUntouched = ($liveEdgeFailed -and (Get-InstallObservableDigest) -ceq $beforeLiveEdge); $script:edgeLive = $false",
        "$concurrentUpdaterRejected = $false; if ($null -ne (Get-Command Get-HmaUpdateTransactionPaths -ErrorAction SilentlyContinue)) { $paths = Get-HmaUpdateTransactionPaths -StateRoot $state; $lockParent = [IO.Path]::GetDirectoryName([string]$paths.LockPath); if (-not [IO.Directory]::Exists($lockParent)) { [void][IO.Directory]::CreateDirectory($lockParent) }; $heldLock = [IO.File]::Open([string]$paths.LockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); try { $beforeConcurrent = Get-InstallObservableDigest; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $concurrentUpdaterRejected = ((Get-InstallObservableDigest) -ceq $beforeConcurrent) } } finally { $heldLock.Dispose() } }",
        "$script:taskStore = $taskRaceTaskStore; $state = $taskRaceState; $env:HMA_INSTALL_PROGRAMS = $taskRacePrograms; $taskRaceMutableBefore = ((Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $state 'secrets.dpapi')).Hash.ToLowerInvariant() + '|' + (Get-TreeDigest -Root (Join-Path $state 'vault')) + '|' + (Get-TreeDigest -Root (Join-Path $state 'edge-profile'))); $foreignMutationsBefore = $script:foreignTaskMutationCount; $script:taskDestinationRace = 'HowMuchAI-Service'; $taskDestinationRaceFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $taskDestinationRaceFailed = $true }; $taskRacePaths = Get-HmaUpdateTransactionPaths -StateRoot $state; $taskRaceMutableAfter = ((Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $state 'secrets.dpapi')).Hash.ToLowerInvariant() + '|' + (Get-TreeDigest -Root (Join-Path $state 'vault')) + '|' + (Get-TreeDigest -Root (Join-Path $state 'edge-profile'))); $taskDestinationRacePreserved = (-not $taskRaceInstallFailed -and $taskDestinationRaceFailed -and $script:taskDestinationRace -ceq '' -and $script:taskStore.ContainsKey('HowMuchAI-Service') -and [string]$script:taskStore['HowMuchAI-Service'].Actions[0].Arguments -ceq 'foreign-race' -and $script:foreignTaskMutationCount -eq $foreignMutationsBefore -and [IO.Directory]::Exists([string]$taskRacePaths.JournalRoot) -and $taskRaceMutableBefore -ceq $taskRaceMutableAfter); $script:taskStore = $mainTaskStore; $state = $installedState; $env:HMA_INSTALL_PROGRAMS = $mainPrograms",
        "$script:updateFault = ''; $script:failRollback = $false; $script:stagedInstallRace = $false; function Move-Item { [CmdletBinding()] param([string]$LiteralPath,[string]$Destination,[switch]$Force) $sourceName = [IO.Path]::GetFileName([IO.Path]::GetFullPath($LiteralPath)); $destinationName = [IO.Path]::GetFileName([IO.Path]::GetFullPath($Destination)); $moveArgs = @{ LiteralPath = $LiteralPath; Destination = $Destination }; if ($Force) { $moveArgs.Force = $true }; Microsoft.PowerShell.Management\\Move-Item @moveArgs -ErrorAction Stop; if ($sourceName -cmatch '^\\.hma-update-[a-f0-9]{64}\\.publishing-[a-f0-9]{32}$' -and $destinationName -cmatch '^\\.hma-update-[a-f0-9]{64}$') { $script:journalPublications += 1 }; if ($sourceName -cmatch '^\\.hma-update-[a-f0-9]{64}$' -and $destinationName -cmatch '^\\.hma-update-[a-f0-9]{64}\\.retired-[a-f0-9]{32}$') { $script:journalRetirements += 1 }; if ($script:stagedInstallRace -and $destinationName -ceq 'app-original') { $script:stagedInstallRace = $false; $journalOld = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Destination)); $stagedInstallPath = Join-Path $journalOld 'install.json'; $maliciousInstall = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($stagedInstallPath)) -ErrorAction Stop; $maliciousInstall.appRoot = Join-Path $state 'vault\\rollback-target'; [IO.File]::WriteAllText($stagedInstallPath, (ConvertTo-Json -InputObject $maliciousInstall -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false))); throw 'Injected staged control race.' }; $destinationFull = [IO.Path]::GetFullPath($Destination); if ($script:failRollback -and $destinationFull -ceq [IO.Path]::GetFullPath((Join-Path (Join-Path $state 'runtime') $releaseACommit))) { $script:failRollback = $false; throw 'Injected rollback interruption.' }; $matchesFault = (($script:updateFault -ceq 'runtime' -and $destinationFull -ceq [IO.Path]::GetFullPath((Join-Path (Join-Path $state 'runtime') $releaseBCommit))) -or ($script:updateFault -ceq 'bootstrap' -and $destinationFull -ceq [IO.Path]::GetFullPath((Join-Path $state 'bootstrap'))) -or ($script:updateFault -ceq 'control' -and $destinationFull -ceq [IO.Path]::GetFullPath((Join-Path $state 'install.json'))) -or ($script:updateFault -ceq 'shortcut' -and $destinationFull -ceq [IO.Path]::GetFullPath($mainLauncher))); if ($matchesFault) { $script:updateFault = ''; throw 'Injected promotion failure.' }; $currentLauncher = Join-Path $env:HMA_INSTALL_PROGRAMS 'How Much AI.lnk'; if ($script:updateFault -ceq 'final' -and $destinationFull -ceq [IO.Path]::GetFullPath($currentLauncher)) { $script:updateFault = ''; [IO.File]::WriteAllText((Join-Path (Join-Path (Join-Path $state 'runtime') $releaseBCommit) 'package.json'),'final-verification-fault') } }",
        "$script:quarantineMoves = 0; $script:retirementCrash = $false; $script:baseInstrumentedMoveItem = ${function:Move-Item}; function Move-Item { [CmdletBinding()] param([string]$LiteralPath,[string]$Destination,[switch]$Force) & $script:baseInstrumentedMoveItem @PSBoundParameters; $destinationLeaf = [IO.Path]::GetFileName([IO.Path]::GetFullPath($Destination)); if ($destinationLeaf -cmatch '^quarantined-(?:app|bootstrap|install|integrity|launcher)-[a-f0-9]{32}(?:\\.lnk)?$') { $script:quarantineMoves += 1 }; if ($script:retirementCrash -and $destinationLeaf -cmatch '^\\.hma-update-[a-f0-9]{64}\\.retired-[a-f0-9]{32}$') { $script:retirementCrash = $false; throw 'Injected retirement interruption.' }; if ($script:shortcutIdentityRace -and $destinationLeaf -ceq 'app-original') { $script:shortcutIdentityRace = $false; $shortcutRacePath = Join-Path $env:HMA_INSTALL_PROGRAMS 'How Much AI.lnk'; [IO.File]::Delete($shortcutRacePath); [IO.File]::WriteAllText($shortcutRacePath, 'foreign-shortcut-race') } }",
        "function ConvertTo-HmaChildLiteral { param([string]$Value) $quote = [string][char]39; return $quote + $Value.Replace($quote, ($quote + $quote)) + $quote }",
        "function Invoke-HmaInstallerCrashChild { param([Parameter(Mandatory)]$Install,[Parameter(Mandatory)][ValidateSet('publish-before','publish-after','retire-after')][string]$Mode) $childId = [Guid]::NewGuid().ToString('N'); $childPath = Join-Path $env:HMA_INSTALL_ROOT ('crash-child-' + $childId + '.ps1'); $taskPath = Join-Path $env:HMA_INSTALL_ROOT ('crash-child-' + $childId + '.tasks.xml'); $Install.Tasks | Export-Clixml -LiteralPath $taskPath -Depth 8; Set-HmaPrivateAcl -LiteralPath $taskPath; $childLines = New-Object 'Collections.Generic.List[string]'; [void]$childLines.Add('Set-StrictMode -Version Latest'); [void]$childLines.Add(\"`$ErrorActionPreference = 'Stop'\"); [void]$childLines.Add('$source = ' + (ConvertTo-HmaChildLiteral $source)); [void]$childLines.Add('$state = ' + (ConvertTo-HmaChildLiteral ([string]$Install.State))); [void]$childLines.Add('$nodePath = ' + (ConvertTo-HmaChildLiteral $nodePath)); [void]$childLines.Add('$ps51Path = ' + (ConvertTo-HmaChildLiteral $ps51Path)); [void]$childLines.Add('$releaseAHash = ' + (ConvertTo-HmaChildLiteral $releaseAHash)); [void]$childLines.Add('$releaseBHash = ' + (ConvertTo-HmaChildLiteral $releaseBHash)); [void]$childLines.Add('$releaseBCommit = ' + (ConvertTo-HmaChildLiteral $releaseBCommit)); [void]$childLines.Add('$script:mode = ' + (ConvertTo-HmaChildLiteral $Mode)); [void]$childLines.Add('$script:taskStore = Import-Clixml -LiteralPath ' + (ConvertTo-HmaChildLiteral $taskPath)); [void]$childLines.Add('$env:HMA_INSTALL_PROGRAMS = ' + (ConvertTo-HmaChildLiteral ([string]$Install.Programs))); [void]$childLines.Add('$script:registrationCount = 0; $script:forceRegistrationCount = 0; $script:unregistrationCount = 0; $script:foreignTaskMutationCount = 0; $script:taskDestinationRace = ''''; $script:rollbackTaskFailure = $false; $script:rollbackProofHazard = $false; $script:rollbackStopCount = 0; $script:rollbackReadyDelay = 0; $script:listenerMode = ''none''; $script:listenerTerminations = 0; $script:listenerAddressPrefilters = 0; $script:listenerPortPrefilters = 0; $script:serviceCommand = ''''; $script:updateFault = ''''; $script:edgeLive = $false; $script:injectRuntimeFailure = ($script:mode -ceq ''retire-after'')'); foreach ($functionName in @('New-ScheduledTaskAction','New-ScheduledTaskTrigger','New-ScheduledTaskPrincipal','New-ScheduledTaskSettingsSet','Register-ScheduledTask','Get-ScheduledTask','Export-ScheduledTask','Unregister-ScheduledTask','Stop-ScheduledTask','Get-NetTCPConnection','Get-CimInstance','Stop-Process')) { $definition = (Get-Item -LiteralPath ('function:' + $functionName)).Definition; [void]$childLines.Add('function ' + $functionName + ' { ' + $definition + ' }') }",
        "$childMoveDefinition = @'",
        "function Move-Item {",
        "    [CmdletBinding()]",
        "    param([string]$LiteralPath, [string]$Destination, [switch]$Force)",
        "    $sourceFull = [IO.Path]::GetFullPath($LiteralPath)",
        "    $destinationFull = [IO.Path]::GetFullPath($Destination)",
        "    $sourceLeaf = [IO.Path]::GetFileName($sourceFull)",
        "    $destinationLeaf = [IO.Path]::GetFileName($destinationFull)",
        "    $publishing = ($sourceLeaf -cmatch '^\\.hma-update-[a-f0-9]{64}\\.publishing-[a-f0-9]{32}$' -and $destinationLeaf -cmatch '^\\.hma-update-[a-f0-9]{64}$')",
        "    if ($script:mode -ceq 'publish-before' -and $publishing) { [Diagnostics.Process]::GetCurrentProcess().Kill(); throw 'The publication termination hook returned.' }",
        "    Microsoft.PowerShell.Management\\Move-Item @PSBoundParameters -ErrorAction Stop",
        "    if ($script:mode -ceq 'publish-after' -and $publishing) { [Diagnostics.Process]::GetCurrentProcess().Kill(); throw 'The publication termination hook returned.' }",
        "    $newAppRoot = Join-Path (Join-Path $state 'runtime') $releaseBCommit",
        "    if ($script:injectRuntimeFailure -and [string]::Equals($destinationFull, [IO.Path]::GetFullPath($newAppRoot), [StringComparison]::OrdinalIgnoreCase)) { $script:injectRuntimeFailure = $false; throw 'Injected child activation failure.' }",
        "    $retiring = ($sourceLeaf -cmatch '^\\.hma-update-[a-f0-9]{64}$' -and $destinationLeaf -cmatch '^\\.hma-update-[a-f0-9]{64}\\.retired-[a-f0-9]{32}$')",
        "    if ($script:mode -ceq 'retire-after' -and $retiring) { [Diagnostics.Process]::GetCurrentProcess().Kill(); throw 'The retirement termination hook returned.' }",
        "}",
        "'@",
        "[void]$childLines.Add($childMoveDefinition); [void]$childLines.Add('$installerTrustArguments = @{ NodePath = $nodePath; ExpectedNodeSha256 = ' + (ConvertTo-HmaChildLiteral $nodeHash) + '; Ps51Path = $ps51Path; ExpectedPs51Sha256 = ' + (ConvertTo-HmaChildLiteral $ps51Hash) + ' }'); [void]$childLines.Add('. ' + (ConvertTo-HmaChildLiteral(" + psLiteral(installerScriptPath) + ")) + ' @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state'); [IO.File]::WriteAllLines($childPath, $childLines, (New-Object Text.UTF8Encoding($false))); Set-HmaPrivateAcl -LiteralPath $childPath; $quotedChildPath = [char]34 + $childPath + [char]34; $process = Start-Process -FilePath $ps51Path -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$quotedChildPath) -PassThru -WindowStyle Hidden; $parentId = [Diagnostics.Process]::GetCurrentProcess().Id; if (-not $process.WaitForExit(90000)) { $process.Kill(); throw 'The crash child did not exit.' }; $result = [pscustomobject]@{ Id = $process.Id; ParentId = $parentId; ExitCode = $process.ExitCode }; [IO.File]::Delete($childPath); [IO.File]::Delete($taskPath); return $result }",
        "function New-HmaMutableSnapshot { param([Parameter(Mandatory)][string]$State,[switch]$Initialize) $vaultSentinel = Join-Path $State 'vault\\child-crash-sentinel.bin'; $edgeSentinel = Join-Path $State 'edge-profile\\child-crash-sentinel.bin'; if ($Initialize) { [IO.File]::WriteAllBytes($vaultSentinel, [byte[]](4,2,4,2)); [IO.File]::WriteAllBytes($edgeSentinel, [byte[]](8,6,7,5)); Set-HmaPrivateAcl -LiteralPath $State }; $secret = Join-Path $State 'secrets.dpapi'; return [pscustomobject]@{ Digest = ((Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $secret).Hash.ToLowerInvariant() + '|' + (Get-TreeDigest -Root (Join-Path $State 'vault')) + '|' + (Get-TreeDigest -Root (Join-Path $State 'edge-profile'))); SecretIdentity = (Get-HmaLauncherFileIdentity -LiteralPath $secret); VaultIdentity = (Get-HmaLauncherFileIdentity -LiteralPath $vaultSentinel); EdgeIdentity = (Get-HmaLauncherFileIdentity -LiteralPath $edgeSentinel) } }",
        "function Test-HmaMutableSnapshot { param($Expected,$Actual) return ([string]$Expected.Digest -ceq [string]$Actual.Digest -and [string]$Expected.SecretIdentity -ceq [string]$Actual.SecretIdentity -and [string]$Expected.VaultIdentity -ceq [string]$Actual.VaultIdentity -and [string]$Expected.EdgeIdentity -ceq [string]$Actual.EdgeIdentity) }",
        "function Test-HmaIsolatedRelease { param([Parameter(Mandatory)]$Install,[Parameter(Mandatory)][string]$Commit,[Parameter(Mandatory)][string]$ManifestSha256) try { $isolatedState = [string]$Install.State; $env:HMA_INSTALL_PROGRAMS = [string]$Install.Programs; Import-Module (Join-Path $isolatedState 'bootstrap\\SecureLocalIntegrity.psm1') -Force -ErrorAction Stop; Import-Module (Join-Path $isolatedState 'bootstrap\\SecureLocalRuntime.psm1') -Force -ErrorAction Stop; $config = Assert-HmaStartupIntegrity -StateRoot $isolatedState; $runtimeNames = @((Get-ChildItem -LiteralPath (Join-Path $isolatedState 'runtime') -Directory -Force).Name); $launcherPlan = New-HmaStartMenuLauncherPlan -StateRoot $isolatedState -PowerShellPath $ps51Path -IntegrityHash ([string]$config.bootstrapHashes.integrity) -LauncherHash ([string]$config.bootstrapHashes.launcher); return ([string]$config.commit -ceq $Commit -and [string]$config.manifestSha256 -ceq $ManifestSha256 -and [string]$config.stateRoot -ceq $isolatedState -and [string]$config.appRoot -ceq (Join-Path (Join-Path $isolatedState 'runtime') $Commit) -and $runtimeNames.Count -eq 1 -and [string]$runtimeNames[0] -ceq $Commit -and (Test-HmaExactTasksForConfig -Config $config -StateRoot $isolatedState) -and (Test-HmaStartMenuLauncherPlan -Plan $launcherPlan)) } catch { return $false } }",
        "function Test-HmaRetainedCrashJournal { param([Parameter(Mandatory)][string]$Root,[Parameter(Mandatory)][string]$StateRoot,[Parameter(Mandatory)][ValidateSet('published','publishing','retired')][string]$Kind) try { Assert-HmaUpdateRootPath -LiteralPath $Root -StateRoot $StateRoot -Kind $Kind; $null = Assert-HmaUpdateTreeShape -LiteralPath $Root -RequireJournal; $stateFull = [IO.Path]::GetFullPath($StateRoot).TrimEnd('\\') + '\\'; $rootFull = [IO.Path]::GetFullPath($Root); $paths = Get-HmaUpdateTransactionPaths -StateRoot $StateRoot; $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName([string]$paths.JournalRoot)); $actualParent = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($rootFull)); $journal = Get-HmaUpdateJournal -JournalRoot $Root; return (-not $rootFull.StartsWith($stateFull, [StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($expectedParent, $actualParent, [StringComparison]::OrdinalIgnoreCase) -and [string]::Equals([string]$journal.stateRoot, [IO.Path]::GetFullPath($StateRoot), [StringComparison]::OrdinalIgnoreCase)) } catch { return $false } }",
        "function Invoke-HmaCrashRecoveryCase { param([Parameter(Mandatory)]$Install,[Parameter(Mandatory)][ValidateSet('publish-before','publish-after','retire-after')][string]$Mode) $fixtureInstall = $Install; $script:taskStore = $fixtureInstall.Tasks; $state = [string]$fixtureInstall.State; $env:HMA_INSTALL_PROGRAMS = [string]$fixtureInstall.Programs; $mutableExpected = New-HmaMutableSnapshot -State $state -Initialize; $child = Invoke-HmaInstallerCrashChild -Install $fixtureInstall -Mode $Mode; $paths = Get-HmaUpdateTransactionPaths -StateRoot $state; $orphans = @(Get-HmaUpdateOrphanRoots -StateRoot $state); $retainedRoot = $null; $retainedKind = ''; if ($Mode -ceq 'publish-before') { $matches = @($orphans | Where-Object { $_.Name -cmatch '\\.publishing-' }); if ($matches.Count -eq 1 -and -not [IO.Directory]::Exists([string]$paths.JournalRoot)) { $retainedRoot = [string]$matches[0].FullName; $retainedKind = 'publishing' } } elseif ($Mode -ceq 'publish-after') { if ($orphans.Count -eq 0 -and [IO.Directory]::Exists([string]$paths.JournalRoot)) { $retainedRoot = [string]$paths.JournalRoot; $retainedKind = 'published' } } else { $matches = @($orphans | Where-Object { $_.Name -cmatch '\\.retired-' }); if ($matches.Count -eq 1 -and -not [IO.Directory]::Exists([string]$paths.JournalRoot)) { $retainedRoot = [string]$matches[0].FullName; $retainedKind = 'retired' } }; $retainedValid = ($null -ne $retainedRoot -and (Test-HmaRetainedCrashJournal -Root $retainedRoot -StateRoot $state -Kind $retainedKind)); $releaseAAtCrash = Test-HmaIsolatedRelease -Install $fixtureInstall -Commit $releaseACommit -ManifestSha256 $releaseAHash; $mutableAtCrash = Test-HmaMutableSnapshot -Expected $mutableExpected -Actual (New-HmaMutableSnapshot -State $state); $recoveryFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $recoveryFailed = $true }; $releaseBAfterRecovery = Test-HmaIsolatedRelease -Install $fixtureInstall -Commit $releaseBCommit -ManifestSha256 $releaseBHash; $mutableAfterRecovery = Test-HmaMutableSnapshot -Expected $mutableExpected -Actual (New-HmaMutableSnapshot -State $state); $noJournalRoots = (-not [IO.Directory]::Exists([string]$paths.JournalRoot) -and @(Get-HmaUpdateOrphanRoots -StateRoot $state).Count -eq 0); $passed = (-not $fixtureInstall.Failed -and $child.Id -ne $child.ParentId -and $child.ExitCode -ne 0 -and $retainedValid -and $releaseAAtCrash -and $mutableAtCrash -and -not $recoveryFailed -and $releaseBAfterRecovery -and $mutableAfterRecovery -and $noJournalRoots); return [pscustomobject]@{ Passed = $passed; Mode = $Mode; ExitCode = $child.ExitCode; RetainedValid = $retainedValid; ReleaseAAtCrash = $releaseAAtCrash; MutableAtCrash = $mutableAtCrash; RecoveryFailed = $recoveryFailed; ReleaseBAfterRecovery = $releaseBAfterRecovery; MutableAfterRecovery = $mutableAfterRecovery; NoJournalRoots = $noJournalRoots } }",
        "$script:taskStore = $controlRaceTaskStore; $state = $controlRaceState; $env:HMA_INSTALL_PROGRAMS = $controlRacePrograms; $controlRaceMutableBefore = ((Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $state 'secrets.dpapi')).Hash.ToLowerInvariant() + '|' + (Get-TreeDigest -Root (Join-Path $state 'vault')) + '|' + (Get-TreeDigest -Root (Join-Path $state 'edge-profile'))); $script:stagedInstallRace = $true; $controlRaceFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $controlRaceFailed = $true }; $controlRacePaths = Get-HmaUpdateTransactionPaths -StateRoot $state; $controlRaceMutableAfter = ((Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $state 'secrets.dpapi')).Hash.ToLowerInvariant() + '|' + (Get-TreeDigest -Root (Join-Path $state 'vault')) + '|' + (Get-TreeDigest -Root (Join-Path $state 'edge-profile'))); $controlRaceRestored = $null; try { Import-Module (Join-Path $state 'bootstrap\\SecureLocalIntegrity.psm1') -Force; $controlRaceRestored = Assert-HmaStartupIntegrity -StateRoot $state } catch { }; $stagedInstallRaceContained = (-not $controlRaceInstallFailed -and $controlRaceFailed -and $script:stagedInstallRace -eq $false -and -not [IO.Directory]::Exists((Join-Path $state 'vault\\rollback-target')) -and $controlRaceMutableBefore -ceq $controlRaceMutableAfter -and $null -ne $controlRaceRestored -and [string]$controlRaceRestored.commit -ceq $releaseACommit -and -not [IO.Directory]::Exists([string]$controlRacePaths.JournalRoot)); $script:taskStore = $mainTaskStore; $state = $installedState; $env:HMA_INSTALL_PROGRAMS = $mainPrograms",
        "$script:taskStore = $controlRaceTaskStore; $state = $controlRaceState; $env:HMA_INSTALL_PROGRAMS = $controlRacePrograms; $script:rollbackProofHazard = $true; $script:rollbackStopCount = 0; $script:updateFault = 'final'; $rollbackProofFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $rollbackProofFailed = $true }; $rollbackProofPaths = Get-HmaUpdateTransactionPaths -StateRoot $state; $rollbackProofRetained = ($rollbackProofFailed -and -not $script:rollbackProofHazard -and $script:rollbackReadyDelay -eq 0 -and $script:listenerMode -ceq 'exact' -and $script:edgeLive -and [IO.Directory]::Exists([string]$rollbackProofPaths.JournalRoot)); $script:updateFault = ''; $script:rollbackProofHazard = $false; $script:rollbackReadyDelay = 0; $script:listenerMode = 'none'; $script:edgeLive = $false; $script:taskStore = $mainTaskStore; $state = $installedState; $env:HMA_INSTALL_PROGRAMS = $mainPrograms",
        "$script:taskStore = $shortcutRaceTaskStore; $state = $shortcutRaceState; $env:HMA_INSTALL_PROGRAMS = $shortcutRacePrograms; $shortcutRacePath = Join-Path $shortcutRacePrograms 'How Much AI.lnk'; $shortcutRaceHash = (Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $shortcutRacePath).Hash.ToLowerInvariant(); $script:shortcutIdentityRace = $true; $shortcutRaceFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $shortcutRaceFailed = $true }; $shortcutRacePaths = Get-HmaUpdateTransactionPaths -StateRoot $state; $shortcutRaceRestored = $null; try { Import-Module (Join-Path $state 'bootstrap\\SecureLocalIntegrity.psm1') -Force; $shortcutRaceRestored = Assert-HmaStartupIntegrity -StateRoot $state } catch { }; $shortcutIdentityRaceBlocked = (-not $shortcutRaceInstallFailed -and $shortcutRaceFailed -and -not $script:shortcutIdentityRace -and $null -ne $shortcutRaceRestored -and [string]$shortcutRaceRestored.commit -ceq $releaseACommit -and (Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $shortcutRacePath).Hash.ToLowerInvariant() -ceq $shortcutRaceHash -and -not [IO.Directory]::Exists([string]$shortcutRacePaths.JournalRoot)); $script:taskStore = $mainTaskStore; $state = $installedState; $env:HMA_INSTALL_PROGRAMS = $mainPrograms",
        "$script:taskStore = $badJournalTaskStore; $state = $badJournalState; $env:HMA_INSTALL_PROGRAMS = $badJournalPrograms; $script:updateFault = 'bootstrap'; $script:rollbackTaskFailure = $true; $badJournalInterrupted = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $badJournalInterrupted = $true }; $script:updateFault = ''; $badJournalPaths = Get-HmaUpdateTransactionPaths -StateRoot $state; $badJournalBefore = Get-TreeDigest -Root $state; $badJournalTaskBefore = Get-TaskDigest; $badJournalFile = Join-Path ([string]$badJournalPaths.JournalRoot) 'transaction.json'; $journalAcl = [IO.File]::GetAccessControl($badJournalFile, [Security.AccessControl.AccessControlSections]::Access); $worldSid = New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $journalAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($worldSid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))); [IO.File]::SetAccessControl($badJournalFile, $journalAcl); $badJournalRecoveryFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $badJournalRecoveryFailed = $true }; $badJournalAclRetained = (-not $badJournalInstallFailed -and $badJournalInterrupted -and $badJournalRecoveryFailed -and [IO.Directory]::Exists([string]$badJournalPaths.JournalRoot) -and (Get-TreeDigest -Root $state) -ceq $badJournalBefore -and (Get-TaskDigest) -ceq $badJournalTaskBefore); $script:taskStore = $mainTaskStore; $state = $installedState; $env:HMA_INSTALL_PROGRAMS = $mainPrograms",
        "$script:taskStore = $restoreTamperInstall.Tasks; $state = [string]$restoreTamperInstall.State; $env:HMA_INSTALL_PROGRAMS = [string]$restoreTamperInstall.Programs; $restoreMutableBefore = ((Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $state 'secrets.dpapi')).Hash.ToLowerInvariant() + '|' + (Get-TreeDigest -Root (Join-Path $state 'vault')) + '|' + (Get-TreeDigest -Root (Join-Path $state 'edge-profile'))); $script:updateFault = 'final'; $script:rollbackTaskFailure = $true; $restoreTamperInterrupted = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $restoreTamperInterrupted = $true }; $script:updateFault = ''; $script:rollbackTaskFailure = $false; $restoreTamperPaths = Get-HmaUpdateTransactionPaths -StateRoot $state; $restoreOld = Join-Path ([string]$restoreTamperPaths.JournalRoot) 'old'; [IO.File]::WriteAllText((Join-Path $restoreOld 'app-original\\package.json'), 'tampered-app-original'); [IO.File]::WriteAllText((Join-Path $restoreOld 'bootstrap-original\\start-secure-local.ps1'), 'tampered-bootstrap-original'); [IO.File]::WriteAllText((Join-Path $restoreOld 'How Much AI.original.lnk'), 'tampered-shortcut-original'); $quarantineBefore = $script:quarantineMoves; $restoreTamperRecoveryFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $restoreTamperRecoveryFailed = $true }; $restoreTamperConfig = $null; try { Import-Module (Join-Path $state 'bootstrap\\SecureLocalIntegrity.psm1') -Force; $restoreTamperConfig = Assert-HmaStartupIntegrity -StateRoot $state } catch { }; $restoreMutableAfter = ((Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $state 'secrets.dpapi')).Hash.ToLowerInvariant() + '|' + (Get-TreeDigest -Root (Join-Path $state 'vault')) + '|' + (Get-TreeDigest -Root (Join-Path $state 'edge-profile'))); $tamperedRestoreSourcesRecovered = (-not $restoreTamperInstall.Failed -and $restoreTamperInterrupted -and -not $restoreTamperRecoveryFailed -and $null -ne $restoreTamperConfig -and [string]$restoreTamperConfig.commit -ceq $releaseBCommit -and ($script:quarantineMoves - $quarantineBefore) -ge 3 -and $restoreMutableBefore -ceq $restoreMutableAfter -and -not [IO.Directory]::Exists([string]$restoreTamperPaths.JournalRoot))",
        "$script:taskStore = $reparseJournalInstall.Tasks; $state = [string]$reparseJournalInstall.State; $env:HMA_INSTALL_PROGRAMS = [string]$reparseJournalInstall.Programs; $script:updateFault = 'bootstrap'; $script:rollbackTaskFailure = $true; $reparseInterrupted = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $reparseInterrupted = $true }; $script:updateFault = ''; $script:rollbackTaskFailure = $false; $reparsePaths = Get-HmaUpdateTransactionPaths -StateRoot $state; $reparseOldApp = Join-Path (Join-Path ([string]$reparsePaths.JournalRoot) 'old') 'app'; $reparsePayload = Join-Path $env:HMA_INSTALL_ROOT 'reparse-journal-payload'; [IO.Directory]::Move($reparseOldApp, $reparsePayload); $null = New-Item -ItemType Junction -Path $reparseOldApp -Target $reparsePayload; $reparseBefore = Get-TreeDigest -Root $state; $reparseTaskBefore = Get-TaskDigest; $reparseShortcut = Join-Path ([string]$reparseJournalInstall.Programs) 'How Much AI.lnk'; $reparseShortcutBefore = (Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $reparseShortcut).Hash.ToLowerInvariant(); $reparseRecoveryFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $reparseRecoveryFailed = $true }; $reparseJournalRetained = (-not $reparseJournalInstall.Failed -and $reparseInterrupted -and $reparseRecoveryFailed -and [IO.Directory]::Exists([string]$reparsePaths.JournalRoot) -and ((Get-Item -LiteralPath $reparseOldApp -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -and (Get-TreeDigest -Root $state) -ceq $reparseBefore -and (Get-TaskDigest) -ceq $reparseTaskBefore -and (Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $reparseShortcut).Hash.ToLowerInvariant() -ceq $reparseShortcutBefore)",
        "$script:taskStore = $emptyJournalInstall.Tasks; $state = [string]$emptyJournalInstall.State; $env:HMA_INSTALL_PROGRAMS = [string]$emptyJournalInstall.Programs; $emptyPaths = Get-HmaUpdateTransactionPaths -StateRoot $state; [void][IO.Directory]::CreateDirectory([string]$emptyPaths.JournalRoot); Set-HmaPrivateAcl -LiteralPath ([string]$emptyPaths.JournalRoot); $emptyMutableBefore = ((Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $state 'secrets.dpapi')).Hash.ToLowerInvariant() + '|' + (Get-TreeDigest -Root (Join-Path $state 'vault')) + '|' + (Get-TreeDigest -Root (Join-Path $state 'edge-profile'))); $emptyRecoveryFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $emptyRecoveryFailed = $true }; $emptyConfig = $null; try { Import-Module (Join-Path $state 'bootstrap\\SecureLocalIntegrity.psm1') -Force; $emptyConfig = Assert-HmaStartupIntegrity -StateRoot $state } catch { }; $emptyMutableAfter = ((Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $state 'secrets.dpapi')).Hash.ToLowerInvariant() + '|' + (Get-TreeDigest -Root (Join-Path $state 'vault')) + '|' + (Get-TreeDigest -Root (Join-Path $state 'edge-profile'))); $emptyJournalRecovered = (-not $emptyJournalInstall.Failed -and -not $emptyRecoveryFailed -and $null -ne $emptyConfig -and [string]$emptyConfig.commit -ceq $releaseBCommit -and $emptyMutableBefore -ceq $emptyMutableAfter -and -not [IO.Directory]::Exists([string]$emptyPaths.JournalRoot))",
        "$script:taskStore = $nextJournalInstall.Tasks; $state = [string]$nextJournalInstall.State; $env:HMA_INSTALL_PROGRAMS = [string]$nextJournalInstall.Programs; $script:updateFault = 'bootstrap'; $script:rollbackTaskFailure = $true; $nextInterrupted = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $nextInterrupted = $true }; $script:updateFault = ''; $script:rollbackTaskFailure = $false; $nextPaths = Get-HmaUpdateTransactionPaths -StateRoot $state; [IO.File]::Move((Join-Path ([string]$nextPaths.JournalRoot) 'transaction.json'), (Join-Path ([string]$nextPaths.JournalRoot) 'transaction.next')); $nextRecoveryFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $nextRecoveryFailed = $true }; $nextConfig = $null; try { Import-Module (Join-Path $state 'bootstrap\\SecureLocalIntegrity.psm1') -Force; $nextConfig = Assert-HmaStartupIntegrity -StateRoot $state } catch { }; $nextJournalRecovered = (-not $nextJournalInstall.Failed -and $nextInterrupted -and -not $nextRecoveryFailed -and $null -ne $nextConfig -and [string]$nextConfig.commit -ceq $releaseBCommit -and -not [IO.Directory]::Exists([string]$nextPaths.JournalRoot))",
        "$script:taskStore = $retiredJournalInstall.Tasks; $state = [string]$retiredJournalInstall.State; $env:HMA_INSTALL_PROGRAMS = [string]$retiredJournalInstall.Programs; $script:updateFault = 'runtime'; $script:retirementCrash = $true; $retirementInterrupted = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $retirementInterrupted = $true }; $script:updateFault = ''; $script:retirementCrash = $false; $retiredPaths = Get-HmaUpdateTransactionPaths -StateRoot $state; $retiredRoots = @(Get-HmaUpdateOrphanRoots -StateRoot $state | Where-Object { $_.Name -cmatch '\\.retired-' }); $retiredAclValid = ($retiredRoots.Count -eq 1 -and (Test-HmaPrivateAcl -LiteralPath $retiredRoots[0].FullName -Recurse)); $retiredRecoveryFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $retiredRecoveryFailed = $true }; $retiredConfig = $null; try { Import-Module (Join-Path $state 'bootstrap\\SecureLocalIntegrity.psm1') -Force; $retiredConfig = Assert-HmaStartupIntegrity -StateRoot $state } catch { }; $retiredJournalRecovered = (-not $retiredJournalInstall.Failed -and $retirementInterrupted -and $retiredAclValid -and -not $retiredRecoveryFailed -and $null -ne $retiredConfig -and [string]$retiredConfig.commit -ceq $releaseBCommit -and @(Get-HmaUpdateOrphanRoots -StateRoot $state).Count -eq 0 -and -not [IO.Directory]::Exists([string]$retiredPaths.JournalRoot)); $script:taskStore = $mainTaskStore; $state = $installedState; $env:HMA_INSTALL_PROGRAMS = $mainPrograms",
        "$publishBeforeCrash = Invoke-HmaCrashRecoveryCase -Install $publishBeforeInstall -Mode 'publish-before'; $publishAfterCrash = Invoke-HmaCrashRecoveryCase -Install $publishAfterInstall -Mode 'publish-after'; $retireAfterCrash = Invoke-HmaCrashRecoveryCase -Install $childRetireInstall -Mode 'retire-after'; $childCrashRecoveryPassed = ($publishBeforeCrash.Passed -and $publishAfterCrash.Passed -and $retireAfterCrash.Passed); $script:taskStore = $mainTaskStore; $state = $installedState; $env:HMA_INSTALL_PROGRAMS = $mainPrograms",
        "if (-not ($tamperedRestoreSourcesRecovered -and $reparseJournalRetained -and $emptyJournalRecovered -and $nextJournalRecovered -and $retiredJournalRecovered -and $childCrashRecoveryPassed)) { throw 'The installer recovery boundary fixture failed.' }",
        "$releaseABaseline = Get-InstallObservableDigest; $releaseAStateBaseline = Get-TreeDigest -Root $state; $releaseATaskBaseline = Get-TaskDigest; $releaseAShortcutBaseline = (Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $mainLauncher).Hash.ToLowerInvariant(); $phaseRollbackResults = @(); foreach ($phase in @('runtime','bootstrap','control','task-HowMuchAI-Service','task-HowMuchAI-Window','shortcut','final')) { $script:updateFault = $phase; $phaseFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $phaseFailed = $true }; $stateExact = ((Get-TreeDigest -Root $state) -ceq $releaseAStateBaseline); $taskExact = ((Get-TaskDigest) -ceq $releaseATaskBaseline); $shortcutExact = ((Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath $mainLauncher).Hash.ToLowerInvariant() -ceq $releaseAShortcutBaseline); $phaseRollbackResults += ($phaseFailed -and $script:updateFault -ceq '' -and $stateExact -and $taskExact -and $shortcutExact -and $script:taskStore['HowMuchAI-Service'].State -ceq 'Ready' -and $script:taskStore['HowMuchAI-Window'].State -ceq 'Ready') }",
        "$script:updateFault = 'bootstrap'; $script:failRollback = $true; $interruptedFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $interruptedFailed = $true }; $script:updateFault = ''; $script:failRollback = $false; $recoveryFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -ExpectedInstalledManifestSha256 $releaseAHash -StateRoot $state } catch { $recoveryFailed = $true }",
        "$postUpgradeConfig = $null; try { Import-Module (Join-Path $state 'bootstrap\\SecureLocalIntegrity.psm1') -Force; $postUpgradeConfig = Assert-HmaStartupIntegrity -StateRoot $state } catch { }; Import-Module (Join-Path $state 'bootstrap\\SecureLocalRuntime.psm1') -Force; $postUpgradeTasksValid = $true; foreach ($name in @('HowMuchAI-Service','HowMuchAI-Window')) { $record = Get-HmaTaskVerificationRecord -TaskName $name; if ($null -eq $record -or -not (Test-HmaRegisteredTaskPlan -Task $record -Config $postUpgradeConfig -StateRoot $state)) { $postUpgradeTasksValid = $false } }; $postUpgradeLauncherPlan = New-HmaStartMenuLauncherPlan -StateRoot $state -PowerShellPath $ps51Path -IntegrityHash ([string]$postUpgradeConfig.bootstrapHashes.integrity) -LauncherHash ([string]$postUpgradeConfig.bootstrapHashes.launcher); $postUpgradeShortcutValid = Test-HmaStartMenuLauncherPlan -Plan $postUpgradeLauncherPlan",
        "$mutableAfter = ((Microsoft.PowerShell.Utility\\Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $state 'secrets.dpapi')).Hash.ToLowerInvariant() + '|' + (Get-TreeDigest -Root (Join-Path $state 'vault')) + '|' + (Get-TreeDigest -Root (Join-Path $state 'edge-profile'))); $activeRuntimeNames = @((Get-ChildItem -LiteralPath (Join-Path $state 'runtime') -Directory).Name)",
        "$updateForceRegistrationCount = $script:forceRegistrationCount - $preUpgradeForceRegistrationCount; $beforeBRerun = Get-InstallObservableDigest; $bRerunFailed = $false; try { . " + psLiteral(installerScriptPath) + " @installerTrustArguments -SourceRoot $source -ExpectedManifestSha256 $releaseBHash -StateRoot $state } catch { $bRerunFailed = $true }; $bRerunExact = (-not $bRerunFailed -and (Get-InstallObservableDigest) -ceq $beforeBRerun)",
        "[pscustomobject]@{ ambientGitUnused = ($script:gitCalls -eq 0); racePreserved = $racePreserved; rollbackRemoved = $rollbackRemoved; replacementPreserved = $replacementPreserved; mismatchRefusedUntouched = $mismatchRefusedUntouched; missingTrustRejected = $missingTrustRejected; wrongNodeHashRejected = $wrongNodeHashRejected; wrongPs51HashRejected = $wrongPs51HashRejected; hostileNodeRejected = $hostileNodeRejected; retainedPathsExact = $retainedPathsExact; manifestSwapRejected = $manifestSwapFailed; manifestSwapNotExecuted = $manifestSwapNotExecuted; sourceSwapRejected = $sourceSwapFailed; sourceSwapNotExecuted = $sourceSwapNotExecuted; first = (-not $firstFailed); second = (-not $secondFailed); secretsPreserved = ($firstSecretHash.Length -eq 64 -and $firstSecretHash -ceq $secondSecretHash); integrity = $integrityPass; excludedArtifactsAbsent = $excludedArtifactsAbsent; bootstrapHashCount = $installedHashCount; unfilteredQuery = ($script:listenerAddressPrefilters -eq 0 -and $script:listenerPortPrefilters -eq 0); otherPortListenerAccepted = $otherPortListenerAccepted; exactListenerAccepted = $exactListenerAccepted; wildcardListenerRejected = $wildcardListenerRejected; multipleListenersRejected = $multipleListenersRejected; unknownListenerUntouched = ($script:listenerTerminations -eq 0); invalidExistingUntouched = $invalidExistingUntouched; forbiddenEnvironmentRejected = $forbiddenEnvironmentRejected; taskCount = $script:taskStore.Count; registrations = $preUpgradeRegistrationCount; unmanifestedRejected = ($unmanifestedFailed -and -not [IO.Directory]::Exists($env:HMA_UNMANIFESTED_STATE) -and $preUpgradeRegistrationCount -eq $beforeRefusal); foreignTaskRejected = ($foreignFailed -and $preUpgradeRegistrationCount -eq $beforeRefusal); freshCasUntouched = $freshCasUntouched; missingCasUntouched = $missingCasUntouched; wrongCasUntouched = $wrongCasUntouched; sameCommitDifferentManifestUntouched = $sameCommitDifferentManifestUntouched; tamperedOldUntouched = $tamperedOldUntouched; changedTaskUntouched = $changedTaskUntouched; changedShortcutUntouched = $changedShortcutUntouched; liveListenerUntouched = $liveListenerUntouched; liveTaskUntouched = $liveTaskUntouched; liveEdgeUntouched = $liveEdgeUntouched; concurrentUpdaterRejected = $concurrentUpdaterRejected; taskDestinationRacePreserved = $taskDestinationRacePreserved; updateUsedCreateOnlyTasks = ($updateForceRegistrationCount -eq 0); journalPublishedAtomically = ($script:journalPublications -gt 0); journalRetiredAtomically = ($script:journalRetirements -gt 0); stagedInstallRaceContained = $stagedInstallRaceContained; badJournalAclRetained = $badJournalAclRetained; rollbackProofRetained = $rollbackProofRetained; shortcutIdentityRaceBlocked = $shortcutIdentityRaceBlocked; childCrashRecoveryPassed = $childCrashRecoveryPassed; allPhaseRollbacksExact = (-not ($phaseRollbackResults -contains $false) -and $phaseRollbackResults.Count -eq 7); interruptedJournalRecovered = ($interruptedFailed -and -not $recoveryFailed); upgradedIntegrity = ($null -ne $postUpgradeConfig -and [string]$postUpgradeConfig.commit -ceq $releaseBCommit -and [string]$postUpgradeConfig.manifestSha256 -ceq $releaseBHash); upgradedTasks = $postUpgradeTasksValid; upgradedShortcut = $postUpgradeShortcutValid; oneActiveRuntime = ($activeRuntimeNames.Count -eq 1 -and $activeRuntimeNames[0] -ceq $releaseBCommit); mutableStatePreserved = ($mutableBefore -ceq $mutableAfter); bRerunExact = $bRerunExact } | ConvertTo-Json -Compress",
      ],
      {
        HMA_INSTALL_ROOT: root,
        HMA_INSTALL_SOURCE: source,
        HMA_INSTALL_STATE: state,
        HMA_INSTALL_PROGRAMS: path.join(root, "programs"),
        HMA_ROLLBACK_STATE: rollbackState,
        HMA_REPLACEMENT_STATE: replacementState,
        HMA_RACE_STATE: raceState,
        HMA_MANIFEST_SWAP_STATE: manifestSwapState,
        HMA_MANIFEST_SWAP_MARKER: manifestSwapMarker,
        HMA_SOURCE_SWAP_STATE: sourceSwapState,
        HMA_SOURCE_SWAP_MARKER: sourceSwapMarker,
        HMA_UNMANIFESTED_STATE: unmanifestedState,
        HMA_FOREIGN_STATE: foreignState,
        HMA_MISSING_TRUST_STATE: missingTrustState,
        HMA_WRONG_NODE_HASH_STATE: wrongNodeHashState,
        HMA_WRONG_PS51_HASH_STATE: wrongPs51HashState,
        HMA_HOSTILE_NODE_STATE: hostileNodeState,
        HMA_INSTALL_COMMIT: commit,
      },
    );

    try {
      assert.deepEqual(parseSafeRecord(stdout), {
        ambientGitUnused: true,
        racePreserved: true,
        rollbackRemoved: true,
        replacementPreserved: true,
        mismatchRefusedUntouched: true,
        missingTrustRejected: true,
        wrongNodeHashRejected: true,
        wrongPs51HashRejected: true,
        hostileNodeRejected: true,
        retainedPathsExact: true,
        manifestSwapRejected: true,
        manifestSwapNotExecuted: true,
        sourceSwapRejected: true,
        sourceSwapNotExecuted: true,
        first: true,
        second: true,
        secretsPreserved: true,
        integrity: true,
        excludedArtifactsAbsent: true,
        bootstrapHashCount: 10,
        unfilteredQuery: true,
        otherPortListenerAccepted: true,
        exactListenerAccepted: true,
        wildcardListenerRejected: true,
        multipleListenersRejected: true,
        unknownListenerUntouched: true,
        invalidExistingUntouched: true,
        forbiddenEnvironmentRejected: true,
        taskCount: 2,
        registrations: 8,
        unmanifestedRejected: true,
        foreignTaskRejected: true,
        freshCasUntouched: true,
        missingCasUntouched: true,
        wrongCasUntouched: true,
        sameCommitDifferentManifestUntouched: true,
        tamperedOldUntouched: true,
        changedTaskUntouched: true,
        changedShortcutUntouched: true,
        liveListenerUntouched: true,
        liveTaskUntouched: true,
        liveEdgeUntouched: true,
        concurrentUpdaterRejected: true,
        taskDestinationRacePreserved: true,
        updateUsedCreateOnlyTasks: true,
        journalPublishedAtomically: true,
        journalRetiredAtomically: true,
        stagedInstallRaceContained: true,
        badJournalAclRetained: true,
        rollbackProofRetained: true,
        shortcutIdentityRaceBlocked: true,
        childCrashRecoveryPassed: true,
        allPhaseRollbacksExact: true,
        interruptedJournalRecovered: true,
        upgradedIntegrity: true,
        upgradedTasks: true,
        upgradedShortcut: true,
        oneActiveRuntime: true,
        mutableStatePreserved: true,
        bRerunExact: true,
      });
      assert.equal(stderr.length, 0);
      assert.equal(stdout.includes(root), false);
      assert.equal(/S-1-|APP_PASSWORD|AUTH_SECRET|VAULT_ENCRYPTION_SECRET|<Task/i.test(stdout), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
