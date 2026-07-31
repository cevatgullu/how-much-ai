import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
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
  "task plans reject unsafe inputs and registered-task verification requires the exact SID, trigger, action, settings, and XML",
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
      "$escapedCommand = [Security.SecurityElement]::Escape([string]$expected.FilePath)",
      "$escapedArguments = [Security.SecurityElement]::Escape([string]$expected.ActionArguments)",
      "$xml = '<Task xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"><Triggers><LogonTrigger><UserId>' + $sid + '</UserId></LogonTrigger></Triggers><Principals><Principal><UserId>' + $sid + '</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions><Exec><Command>' + $escapedCommand + '</Command><Arguments>' + $escapedArguments + '</Arguments></Exec></Actions></Task>'",
      "$task = [pscustomobject]@{ TaskName = $expected.Name; Principal = [pscustomobject]@{ UserId = $sid; LogonType = 'InteractiveToken'; RunLevel = 'Limited' }; Actions = @([pscustomobject]@{ Execute = $expected.FilePath; Arguments = $expected.ActionArguments }); Triggers = @([pscustomobject]@{ UserId = $sid; TriggerType = 'Logon' }); Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew'; StartWhenAvailable = $true; ExecutionTimeLimit = 'PT0S'; RestartCount = 3; RestartInterval = 'PT1M' }; Xml = $xml }",
      "$configForTask = [pscustomobject]@{ bootstrapHashes = $hashes }",
      "$valid = Test-HmaRegisteredTaskPlan -Task $task -Config $configForTask -StateRoot 'C:\\private-state'",
      "$wrongSidTask = $task.PSObject.Copy(); $wrongSidTask.Principal = [pscustomobject]@{ UserId = 'S-1-5-18'; LogonType = 'InteractiveToken'; RunLevel = 'Limited' }",
      "$wrongTriggerTask = $task.PSObject.Copy(); $wrongTriggerTask.Triggers = @([pscustomobject]@{ UserId = $sid; TriggerType = 'Daily' })",
      "$wrongSettingsTask = $task.PSObject.Copy(); $wrongSettingsTask.Settings = [pscustomobject]@{ MultipleInstances = 'Parallel'; StartWhenAvailable = $true; ExecutionTimeLimit = 'PT0S'; RestartCount = 3; RestartInterval = 'PT1M' }",
      "$wrongXmlTask = $task.PSObject.Copy(); $wrongXmlTask.Xml = $xml.Replace('<Count>3</Count>', '<Count>2</Count>')",
      "$wrongActionTask = $task.PSObject.Copy(); $wrongActionTask.Actions = @([pscustomobject]@{ Execute = $expected.FilePath; Arguments = ($expected.ActionArguments + ' extra') })",
      "$checks = @($valid, (-not (Test-HmaRegisteredTaskPlan -Task $wrongSidTask -Config $configForTask -StateRoot 'C:\\private-state')), (-not (Test-HmaRegisteredTaskPlan -Task $wrongTriggerTask -Config $configForTask -StateRoot 'C:\\private-state')), (-not (Test-HmaRegisteredTaskPlan -Task $wrongSettingsTask -Config $configForTask -StateRoot 'C:\\private-state')), (-not (Test-HmaRegisteredTaskPlan -Task $wrongXmlTask -Config $configForTask -StateRoot 'C:\\private-state')), (-not (Test-HmaRegisteredTaskPlan -Task $wrongActionTask -Config $configForTask -StateRoot 'C:\\private-state')))",
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
      checks: [true, true, true, true, true, true],
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
  "the Edge launcher sends a password and starts Edge only while one exact service process owns the listener",
  windowsOnly,
  async () => {
    const root = path.join(os.tmpdir(), `hma-open-launcher-${process.pid}`);
    const ticket = "Z".repeat(43);
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
      "  (New-ManifestEntry -Root $bootstrap -Relative 'oauth-handoff-extension\\callback.js' -ManifestPath 'scripts/windows/oauth-handoff-extension/callback.js'),",
      "  (New-ManifestEntry -Root $bootstrap -Relative 'oauth-handoff-extension\\manifest.json' -ManifestPath 'scripts/windows/oauth-handoff-extension/manifest.json'),",
      "  (New-ManifestEntry -Root $bootstrap -Relative 'open-secure-local.ps1' -ManifestPath 'scripts/windows/open-secure-local.ps1'),",
      "  (New-ManifestEntry -Root $bootstrap -Relative 'start-secure-local.ps1' -ManifestPath 'scripts/windows/start-secure-local.ps1')",
      ")",
      "$manifest = [ordered]@{ commit = $commit; nodeSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodePath).Hash.ToLowerInvariant(); runtimeFiles = $runtimeFiles; bootstrapFiles = $bootstrapFiles }",
      "$integrityPath = Join-Path $state 'integrity.json'",
      "[IO.File]::WriteAllText($integrityPath, ($manifest | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))",
      "$byName = @{}; foreach ($entry in $bootstrapFiles) { $byName[[IO.Path]::GetFileName([string]$entry.path)] = [string]$entry.sha256 }",
      "$install = [ordered]@{ version = 1; appRoot = $appRoot; stateRoot = $state; nodePath = $nodePath; port = 37645; upstreamBase = '1238189b7017601d21e3579d041480ce3773e191'; commit = $commit; manifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $integrityPath).Hash.ToLowerInvariant(); bootstrapHashes = [ordered]@{ start = $byName['start-secure-local.ps1']; open = $byName['open-secure-local.ps1']; connector = $byName['connect-claude-secure.ps1']; integrity = $byName['SecureLocalIntegrity.psm1']; runtime = $byName['SecureLocalRuntime.psm1']; secrets = $byName['SecureLocalSecrets.psm1']; extensionManifest = $byName['manifest.json']; extensionCallback = $byName['callback.js'] } }",
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
      "$script:readinessCalls = 0; $script:passwordPosts = 0; $script:edgeStarts = 0; $script:poisonCandidateUses = 0; $script:listenerTerminations = 0; $script:listenerAddressPrefilters = 0; $script:listenerPortPrefilters = 0",
      "function Test-Path { [CmdletBinding()] param([Parameter(Position=0)][string]$LiteralPath,[string]$PathType) if ($LiteralPath -match 'Microsoft\\\\Edge\\\\Application\\\\msedge\\.exe$') { if ($LiteralPath.StartsWith($poisonProgramFiles, [StringComparison]::OrdinalIgnoreCase) -or $LiteralPath.StartsWith($poisonProgramFilesX86, [StringComparison]::OrdinalIgnoreCase)) { $script:poisonCandidateUses += 1 }; return $true }; Microsoft.PowerShell.Management\\Test-Path @PSBoundParameters }",
      "function Get-Item { [CmdletBinding()] param([Parameter(Position=0)][string]$LiteralPath,[switch]$Force) foreach ($base in $script:edgeBases) { $candidate = Join-Path $base 'Microsoft\\Edge\\Application\\msedge.exe'; if ([string]::Equals($candidate, $LiteralPath, [StringComparison]::OrdinalIgnoreCase) -or $candidate.StartsWith($LiteralPath.TrimEnd('\\') + '\\', [StringComparison]::OrdinalIgnoreCase)) { if ($LiteralPath.StartsWith($poisonProgramFiles, [StringComparison]::OrdinalIgnoreCase) -or $LiteralPath.StartsWith($poisonProgramFilesX86, [StringComparison]::OrdinalIgnoreCase)) { $script:poisonCandidateUses += 1 }; $isLeaf = [string]::Equals($candidate, $LiteralPath, [StringComparison]::OrdinalIgnoreCase); $attributes = if (-not $isLeaf -and $env:HMA_EDGE_ANCESTOR_REPARSE -ceq '1' -and $LiteralPath.TrimEnd('\\').EndsWith('\\Microsoft', [StringComparison]::OrdinalIgnoreCase) -and ($LiteralPath.StartsWith($stableProgramFiles, [StringComparison]::OrdinalIgnoreCase) -or (-not [string]::IsNullOrWhiteSpace($stableProgramFilesX86) -and $LiteralPath.StartsWith($stableProgramFilesX86, [StringComparison]::OrdinalIgnoreCase)))) { [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint } elseif ($isLeaf) { [IO.FileAttributes]::Normal } else { [IO.FileAttributes]::Directory }; return [pscustomobject]@{ FullName = $LiteralPath; PSIsContainer = (-not $isLeaf); Attributes = $attributes } } }; Microsoft.PowerShell.Management\\Get-Item @PSBoundParameters }",
      "function Get-AuthenticodeSignature { [CmdletBinding()] param([string]$LiteralPath) if ($LiteralPath.StartsWith($poisonProgramFiles, [StringComparison]::OrdinalIgnoreCase) -or $LiteralPath.StartsWith($poisonProgramFilesX86, [StringComparison]::OrdinalIgnoreCase)) { $script:poisonCandidateUses += 1 }; [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US' } } }",
      "$exactListener = [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 37645; State = 'Listen'; OwningProcess = 42 }",
      "$unknownListener = [pscustomobject]@{ LocalAddress = '0.0.0.0'; LocalPort = 37645; State = 'Listen'; OwningProcess = 84 }",
      "$irrelevantListener = [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 3000; State = 'Listen'; OwningProcess = 21 }",
      "function Get-NetTCPConnection { [CmdletBinding()] param([string]$LocalAddress,[int]$LocalPort,[string]$State) $rows = if ($env:HMA_OPEN_LISTENERS -ceq 'extra') { @($exactListener, $unknownListener, $irrelevantListener) } elseif ($env:HMA_OPEN_LISTENERS -ceq 'wildcard') { @($unknownListener, $irrelevantListener) } else { @($exactListener, $irrelevantListener) }; if ($PSBoundParameters.ContainsKey('LocalAddress')) { $script:listenerAddressPrefilters += 1; $rows = @($rows | Where-Object { [string]$_.LocalAddress -ceq $LocalAddress }) }; if ($PSBoundParameters.ContainsKey('LocalPort')) { $script:listenerPortPrefilters += 1; $rows = @($rows | Where-Object { [int]$_.LocalPort -eq $LocalPort }) }; @($rows) }",
      "$exactCommand = '\"' + $nodePath + '\" \"' + (Join-Path $appRoot 'node_modules\\next\\dist\\bin\\next') + '\" start --hostname 127.0.0.1 --port 37645'",
      "function Get-CimInstance { [CmdletBinding()] param([string]$ClassName,[string]$Filter) $command = if ($env:HMA_OPEN_MATCH -ceq '1') { $exactCommand } else { $exactCommand + ' --inspect' }; [pscustomobject]@{ ProcessId = 42; ExecutablePath = $nodePath; CommandLine = $command } }",
      "function Invoke-WebRequest { [CmdletBinding()] param([string]$Uri,[string]$Method = 'Get',[string]$ContentType,[string]$Body,[switch]$UseBasicParsing,[int]$MaximumRedirection,[int]$TimeoutSec) if ($Method -ceq 'Post') { $script:passwordPosts += 1; return [pscustomobject]@{ StatusCode = 200; Content = ('{\"ticket\":\"' + $env:HMA_OPEN_TICKET + '\",\"expiresInMs\":20000}'); Headers = @{} } }; $script:readinessCalls += 1; [pscustomobject]@{ StatusCode = 200; Content = ''; Headers = @{} } }",
      "function Start-Sleep { param([int]$Milliseconds) throw 'Readiness unexpectedly waited.' }",
      "function Start-Process { [CmdletBinding()] param([string]$FilePath,[object[]]$ArgumentList,[string]$WindowStyle) $script:edgeStarts += 1 }",
      "function Stop-Process { [CmdletBinding()] param([int]$Id,[switch]$Force) $script:listenerTerminations += 1 }",
      "$failed = $false; $failureMessage = ''",
      "try { . (Join-Path $bootstrap 'open-secure-local.ps1') -StateRoot $state -IntegrityModuleHash $install.bootstrapHashes.integrity } catch { $failed = $true; $failureMessage = [string]$_.Exception.Message }",
      "[pscustomobject]@{ failed = $failed; sanitizedError = ((-not $failed -and $failureMessage -ceq '') -or ($failed -and $failureMessage -ceq 'Secure local window launch failed.')); unfilteredQuery = ($script:listenerAddressPrefilters -eq 0 -and $script:listenerPortPrefilters -eq 0); readinessCalls = $script:readinessCalls; passwordPosts = $script:passwordPosts; edgeStarts = $script:edgeStarts; listenerTerminations = $script:listenerTerminations; poisonCandidateUsed = ($script:poisonCandidateUses -gt 0) } | ConvertTo-Json -Compress",
    ];

    try {
      const matching = await runPowerShell(fixtureSetup, {
        HMA_OPEN_ROOT: root,
        HMA_OPEN_MATCH: "1",
        HMA_OPEN_TICKET: ticket,
      });
      assert.deepEqual(parseSafeRecord(matching.stdout), {
        failed: false,
        sanitizedError: true,
        unfilteredQuery: true,
        readinessCalls: 1,
        passwordPosts: 1,
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
      });
      assert.deepEqual(parseSafeRecord(extraListener.stdout), {
        failed: true,
        sanitizedError: true,
        unfilteredQuery: true,
        readinessCalls: 0,
        passwordPosts: 0,
        edgeStarts: 0,
        listenerTerminations: 0,
        poisonCandidateUsed: false,
      });
      assert.equal(extraListener.stderr.length, 0);
      assert.equal(extraListener.stdout.includes(ticket), false);
      assert.equal(extraListener.stdout.includes("a".repeat(64)), false);
      await rm(extraListenerRoot, { recursive: true, force: true });

      const mismatchedRoot = `${root}-mismatch`;
      const mismatched = await runPowerShell(fixtureSetup, {
        HMA_OPEN_ROOT: mismatchedRoot,
        HMA_OPEN_MATCH: "0",
        HMA_OPEN_TICKET: ticket,
      });
      assert.deepEqual(parseSafeRecord(mismatched.stdout), {
        failed: true,
        sanitizedError: true,
        unfilteredQuery: true,
        readinessCalls: 0,
        passwordPosts: 0,
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
        HMA_EDGE_ANCESTOR_REPARSE: "1",
      });
      assert.deepEqual(parseSafeRecord(reparse.stdout), {
        failed: true,
        sanitizedError: true,
        unfilteredQuery: true,
        readinessCalls: 0,
        passwordPosts: 0,
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
  "the manifest-driven installer is idempotent and refuses unmanifested input or tasks owned by another state root",
  windowsOnly,
  async () => {
    const root = path.join(os.tmpdir(), `hma-installer-${process.pid}`);
    const source = path.join(root, "source");
    const state = path.join(root, "state");
    const unmanifestedState = path.join(root, "unmanifested-state");
    const foreignState = path.join(root, "foreign-state");
    const commit = "d".repeat(40);
    const { stdout, stderr } = await runPowerShell(
      [
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        "$source = $env:HMA_INSTALL_SOURCE",
        "$state = $env:HMA_INSTALL_STATE",
        "$null = New-Item -ItemType Directory -Path (Join-Path $source 'audit\\final') -Force",
        "$null = New-Item -ItemType Directory -Path (Join-Path $source 'scripts\\windows') -Force",
        "$null = New-Item -ItemType Directory -Path (Join-Path $source 'scripts\\windows\\oauth-handoff-extension') -Force",
        "[IO.File]::WriteAllText((Join-Path $source 'package.json'), '{\"private\":true}')",
        `Copy-Item -LiteralPath ${psLiteral(integrityModulePath)} -Destination (Join-Path $source 'scripts\\windows\\SecureLocalIntegrity.psm1')`,
        `Copy-Item -LiteralPath ${psLiteral(modulePath)} -Destination (Join-Path $source 'scripts\\windows\\SecureLocalRuntime.psm1')`,
        `Copy-Item -LiteralPath ${psLiteral(secretsModulePath)} -Destination (Join-Path $source 'scripts\\windows\\SecureLocalSecrets.psm1')`,
        `Copy-Item -LiteralPath ${psLiteral(openScriptPath)} -Destination (Join-Path $source 'scripts\\windows\\open-secure-local.ps1')`,
        `Copy-Item -LiteralPath ${psLiteral(startScriptPath)} -Destination (Join-Path $source 'scripts\\windows\\start-secure-local.ps1')`,
        "[IO.File]::WriteAllText((Join-Path $source 'scripts\\windows\\connect-claude-secure.ps1'), '# reviewed connector')",
        "[IO.File]::WriteAllText((Join-Path $source 'scripts\\windows\\oauth-handoff-extension\\manifest.json'), '{\"manifest_version\":3}')",
        "[IO.File]::WriteAllText((Join-Path $source 'scripts\\windows\\oauth-handoff-extension\\callback.js'), '\"use strict\";')",
        "$nodePath = (Get-Command node.exe -ErrorAction Stop).Source",
        "function New-SourceEntry { param([string]$Relative) $full = Join-Path $source $Relative; $file = Microsoft.PowerShell.Management\\Get-Item -LiteralPath $full -Force; [pscustomobject]@{ path = $Relative.Replace('\\','/'); size = [int]$file.Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $full).Hash.ToLowerInvariant() } }",
        "$runtimeFiles = @(New-SourceEntry 'package.json')",
        "$bootstrapFiles = @((New-SourceEntry 'scripts\\windows\\SecureLocalIntegrity.psm1'), (New-SourceEntry 'scripts\\windows\\SecureLocalRuntime.psm1'), (New-SourceEntry 'scripts\\windows\\SecureLocalSecrets.psm1'), (New-SourceEntry 'scripts\\windows\\connect-claude-secure.ps1'), (New-SourceEntry 'scripts\\windows\\oauth-handoff-extension\\callback.js'), (New-SourceEntry 'scripts\\windows\\oauth-handoff-extension\\manifest.json'), (New-SourceEntry 'scripts\\windows\\open-secure-local.ps1'), (New-SourceEntry 'scripts\\windows\\start-secure-local.ps1'))",
        "$manifest = [ordered]@{ commit = $env:HMA_INSTALL_COMMIT; nodeSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodePath).Hash.ToLowerInvariant(); runtimeFiles = $runtimeFiles; bootstrapFiles = $bootstrapFiles }",
        "$manifestPath = Join-Path $source 'audit\\final\\runtime-manifest.json'",
        "[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))",
        "$manifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant()",
        "[IO.File]::WriteAllText((Join-Path $source 'audit\\final\\runtime-manifest.sha256'), $manifestHash, (New-Object Text.UTF8Encoding($false)))",
        "[IO.File]::WriteAllText((Join-Path $source 'audit\\final\\final-commit.txt'), $env:HMA_INSTALL_COMMIT, (New-Object Text.UTF8Encoding($false)))",
        "$script:gitDirty = $false",
        "function git { param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments) $global:LASTEXITCODE = 0; $joined = $Arguments -join ' '; if ($joined -match 'rev-parse HEAD') { $env:HMA_INSTALL_COMMIT } elseif ($joined -match 'status --porcelain' -and $script:gitDirty) { ' M package.json' } }",
        "$script:taskStore = @{}; $script:registrationCount = 0; $script:listenerMode = 'none'; $script:listenerTerminations = 0; $script:listenerAddressPrefilters = 0; $script:listenerPortPrefilters = 0; $script:serviceCommand = ''",
        "function New-ScheduledTaskAction { [CmdletBinding()] param([string]$Execute,[string]$Argument) [pscustomobject]@{ Execute = $Execute; Arguments = $Argument } }",
        "function New-ScheduledTaskTrigger { [CmdletBinding()] param([switch]$AtLogOn,[string]$User) [pscustomobject]@{ UserId = $User; TriggerType = 'Logon' } }",
        "function New-ScheduledTaskPrincipal { [CmdletBinding()] param([string]$UserId,[string]$LogonType,[string]$RunLevel) [pscustomobject]@{ UserId = $UserId; LogonType = 'InteractiveToken'; RunLevel = $RunLevel } }",
        "function New-ScheduledTaskSettingsSet { [CmdletBinding()] param([string]$MultipleInstances,[switch]$StartWhenAvailable,[TimeSpan]$ExecutionTimeLimit,[int]$RestartCount,[TimeSpan]$RestartInterval) [pscustomobject]@{ MultipleInstances = $MultipleInstances; StartWhenAvailable = [bool]$StartWhenAvailable; ExecutionTimeLimit = 'PT0S'; RestartCount = $RestartCount; RestartInterval = 'PT1M' } }",
        "function Register-ScheduledTask { [CmdletBinding()] param([string]$TaskName,$Action,$Trigger,$Principal,$Settings,[switch]$Force) $task = [pscustomobject]@{ TaskName = $TaskName; Actions = @($Action); Triggers = @($Trigger); Principal = $Principal; Settings = $Settings }; $script:taskStore[$TaskName] = $task; $script:registrationCount += 1; return $task }",
        "function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName) if ($script:taskStore.ContainsKey($TaskName)) { return $script:taskStore[$TaskName] } }",
        "function Export-ScheduledTask { [CmdletBinding()] param([string]$TaskName) $task = $script:taskStore[$TaskName]; $command = [Security.SecurityElement]::Escape([string]$task.Actions[0].Execute); $arguments = [Security.SecurityElement]::Escape([string]$task.Actions[0].Arguments); $sid = [Security.SecurityElement]::Escape([string]$task.Principal.UserId); '<Task xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"><Triggers><LogonTrigger><UserId>' + $sid + '</UserId></LogonTrigger></Triggers><Principals><Principal><UserId>' + $sid + '</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions><Exec><Command>' + $command + '</Command><Arguments>' + $arguments + '</Arguments></Exec></Actions></Task>' }",
        "function Unregister-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[switch]$Confirm) $script:taskStore.Remove($TaskName) | Out-Null }",
        "function Get-NetTCPConnection { [CmdletBinding()] param([string]$LocalAddress,[int]$LocalPort,[string]$State) $exact = [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 37645; State = 'Listen'; OwningProcess = 42 }; $unknown = [pscustomobject]@{ LocalAddress = '0.0.0.0'; LocalPort = 37645; State = 'Listen'; OwningProcess = 84 }; $otherPort = [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 3000; State = 'Listen'; OwningProcess = 21 }; $rows = if ($script:listenerMode -ceq 'exact') { @($exact, $otherPort) } elseif ($script:listenerMode -ceq 'wildcard') { @($unknown, $otherPort) } elseif ($script:listenerMode -ceq 'multiple') { @($exact, $unknown, $otherPort) } elseif ($script:listenerMode -ceq 'other-port') { @($otherPort) } else { @() }; if ($PSBoundParameters.ContainsKey('LocalAddress')) { $script:listenerAddressPrefilters += 1; $rows = @($rows | Where-Object { [string]$_.LocalAddress -ceq $LocalAddress }) }; if ($PSBoundParameters.ContainsKey('LocalPort')) { $script:listenerPortPrefilters += 1; $rows = @($rows | Where-Object { [int]$_.LocalPort -eq $LocalPort }); if ($script:listenerMode -ceq 'other-port' -and $rows.Count -eq 0) { Write-Error 'No matching MSFT_NetTCPConnection objects found.'; return } }; @($rows) }",
        "function Get-CimInstance { [CmdletBinding()] param([string]$ClassName,[string]$Filter) [pscustomobject]@{ ProcessId = 42; ExecutablePath = $nodePath; CommandLine = $script:serviceCommand } }",
        "function Stop-Process { [CmdletBinding()] param([int]$Id,[switch]$Force) $script:listenerTerminations += 1 }",
        "$firstFailed = $false; try { . " + psLiteral(installerScriptPath) + " -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $firstFailed = $true }",
        "$secretsPath = Join-Path $state 'secrets.dpapi'",
        "$firstSecretHash = if ([IO.File]::Exists($secretsPath)) { (Get-FileHash -Algorithm SHA256 -LiteralPath $secretsPath).Hash } else { '' }",
        "$secondFailed = $false; try { . " + psLiteral(installerScriptPath) + " -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $secondFailed = $true }",
        "$secondSecretHash = if ([IO.File]::Exists($secretsPath)) { (Get-FileHash -Algorithm SHA256 -LiteralPath $secretsPath).Hash } else { '' }",
        "$installedHashCount = if ([IO.File]::Exists((Join-Path $state 'install.json'))) { $installedConfig = ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $state 'install.json'))); @($installedConfig.bootstrapHashes.PSObject.Properties).Count } else { 0 }",
        "$integrityPass = $false; if (-not $secondFailed) { Import-Module (Join-Path $state 'bootstrap\\SecureLocalIntegrity.psm1') -Force; $integrityPass = ($null -ne (Assert-HmaStartupIntegrity -StateRoot $state)) }",
        "$installedAppRoot = Join-Path (Join-Path $state 'runtime') $env:HMA_INSTALL_COMMIT",
        "$script:serviceCommand = '\"' + $nodePath + '\" \"' + (Join-Path $installedAppRoot 'node_modules\\next\\dist\\bin\\next') + '\" start --hostname 127.0.0.1 --port 37645'",
        "$script:listenerMode = 'other-port'",
        "$beforeOtherPortListener = $script:registrationCount",
        "$otherPortListenerFailed = $false; try { . " + psLiteral(installerScriptPath) + " -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $otherPortListenerFailed = $true }",
        "$otherPortListenerAccepted = (-not $otherPortListenerFailed -and $script:registrationCount -eq ($beforeOtherPortListener + 2))",
        "$script:listenerMode = 'exact'",
        "$beforeExactListener = $script:registrationCount",
        "$exactListenerFailed = $false; try { . " + psLiteral(installerScriptPath) + " -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $exactListenerFailed = $true }",
        "$exactListenerAccepted = (-not $exactListenerFailed -and $script:registrationCount -eq ($beforeExactListener + 2))",
        "$script:listenerMode = 'wildcard'",
        "$beforeWildcardListener = $script:registrationCount",
        "$wildcardError = ''; try { . " + psLiteral(installerScriptPath) + " -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $wildcardError = [string]$_.Exception.Message }",
        "$wildcardListenerRejected = ($wildcardError -ceq 'Secure local installation failed.' -and $script:registrationCount -eq $beforeWildcardListener)",
        "$script:listenerMode = 'multiple'",
        "$beforeMultipleListeners = $script:registrationCount",
        "$multipleError = ''; try { . " + psLiteral(installerScriptPath) + " -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $multipleError = [string]$_.Exception.Message }",
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
        "$invalidExistingFailed = $false; try { . " + psLiteral(installerScriptPath) + " -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $state } catch { $invalidExistingFailed = $true }",
        "$markerSddlAfter = [IO.File]::GetAccessControl($mutationMarker).Sddl",
        "$invalidExistingUntouched = ($invalidExistingFailed -and [IO.File]::Exists($mutationMarker) -and [IO.File]::ReadAllText($mutationMarker) -ceq 'must remain untouched' -and $markerSddlBefore -ceq $markerSddlAfter -and $script:registrationCount -eq $beforeInvalidExisting)",
        "Set-HmaPrivateAcl -LiteralPath $mutationMarker",
        "[IO.File]::Delete($mutationMarker)",
        "[IO.File]::WriteAllText((Join-Path $source 'scripts\\windows\\unmanifested.ps1'), '# extra')",
        "$beforeRefusal = $script:registrationCount",
        "$unmanifestedFailed = $false; try { . " + psLiteral(installerScriptPath) + " -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $env:HMA_UNMANIFESTED_STATE } catch { $unmanifestedFailed = $true }",
        "[IO.File]::Delete((Join-Path $source 'scripts\\windows\\unmanifested.ps1'))",
        "$foreignFailed = $false; try { . " + psLiteral(installerScriptPath) + " -SourceRoot $source -ExpectedManifestSha256 $manifestHash -StateRoot $env:HMA_FOREIGN_STATE } catch { $foreignFailed = $true }",
        "[pscustomobject]@{ first = (-not $firstFailed); second = (-not $secondFailed); secretsPreserved = ($firstSecretHash.Length -eq 64 -and $firstSecretHash -ceq $secondSecretHash); integrity = $integrityPass; bootstrapHashCount = $installedHashCount; unfilteredQuery = ($script:listenerAddressPrefilters -eq 0 -and $script:listenerPortPrefilters -eq 0); otherPortListenerAccepted = $otherPortListenerAccepted; exactListenerAccepted = $exactListenerAccepted; wildcardListenerRejected = $wildcardListenerRejected; multipleListenersRejected = $multipleListenersRejected; unknownListenerUntouched = ($script:listenerTerminations -eq 0); invalidExistingUntouched = $invalidExistingUntouched; taskCount = $script:taskStore.Count; registrations = $script:registrationCount; unmanifestedRejected = ($unmanifestedFailed -and -not [IO.Directory]::Exists($env:HMA_UNMANIFESTED_STATE) -and $script:registrationCount -eq $beforeRefusal); foreignTaskRejected = ($foreignFailed -and $script:registrationCount -eq $beforeRefusal) } | ConvertTo-Json -Compress",
      ],
      {
        HMA_INSTALL_SOURCE: source,
        HMA_INSTALL_STATE: state,
        HMA_UNMANIFESTED_STATE: unmanifestedState,
        HMA_FOREIGN_STATE: foreignState,
        HMA_INSTALL_COMMIT: commit,
      },
    );

    try {
      assert.deepEqual(parseSafeRecord(stdout), {
        first: true,
        second: true,
        secretsPreserved: true,
        integrity: true,
        bootstrapHashCount: 8,
        unfilteredQuery: true,
        otherPortListenerAccepted: true,
        exactListenerAccepted: true,
        wildcardListenerRejected: true,
        multipleListenersRejected: true,
        unknownListenerUntouched: true,
        invalidExistingUntouched: true,
        taskCount: 2,
        registrations: 8,
        unmanifestedRejected: true,
        foreignTaskRejected: true,
      });
      assert.equal(stderr.length, 0);
      assert.equal(stdout.includes(root), false);
      assert.equal(/S-1-|APP_PASSWORD|AUTH_SECRET|VAULT_ENCRYPTION_SECRET|<Task/i.test(stdout), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
