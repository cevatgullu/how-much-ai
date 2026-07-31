import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const windowsOnly = { skip: process.platform !== "win32" };
const runtimeModulePath = path.resolve("scripts/windows/SecureLocalRuntime.psm1");
const secretsModulePath = path.resolve("scripts/windows/SecureLocalSecrets.psm1");
const launcherScriptPath = path.resolve("scripts/windows/launch-secure-local.ps1");
const installerScriptPath = path.resolve("scripts/windows/install-secure-local.ps1");
const verifierScriptPath = path.resolve("scripts/windows/verify-final-local-state.ps1");
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

async function runPowerShell(lines: string[]): Promise<{ stdout: string; stderr: string }> {
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
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    },
  );
}

function parseSafeJson<T>(stdout: string): T {
  return JSON.parse(stdout.trim()) as T;
}

test(
  "launcher plan contains only the exact public hash-bound shortcut contract",
  windowsOnly,
  async () => {
    const state = "C:\\private-state";
    const integrityHash = "a".repeat(64);
    const launcherHash = "b".repeat(64);
    const { stdout, stderr } = await runPowerShell([
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      `Import-Module ${psLiteral(runtimeModulePath)} -Force`,
      `$plan = New-HmaStartMenuLauncherPlan -StateRoot ${psLiteral(state)} -PowerShellPath ${psLiteral(powerShell51)} -IntegrityHash ${psLiteral(integrityHash)} -LauncherHash ${psLiteral(launcherHash)}`,
      "$plan | ConvertTo-Json -Compress",
    ]);
    const plan = parseSafeJson<Record<string, unknown>>(stdout);
    const programs = await runPowerShell([
      "[Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)",
    ]);

    assert.deepEqual(Object.keys(plan), [
      "Path",
      "TargetPath",
      "Arguments",
      "WorkingDirectory",
      "Description",
      "IconLocation",
      "WindowStyle",
      "Hotkey",
    ]);
    assert.equal(plan.Path, path.join(programs.stdout.trim(), "How Much AI.lnk"));
    const canonicalPowerShell51 = await realpath(powerShell51);
    assert.equal(plan.TargetPath, canonicalPowerShell51);
    assert.equal(plan.WorkingDirectory, path.join(state, "bootstrap"));
    assert.equal(plan.Description, "Open the secure local How Much AI dashboard.");
    assert.equal(plan.IconLocation, `${canonicalPowerShell51},0`);
    assert.equal(plan.WindowStyle, 7);
    assert.equal(plan.Hotkey, "");
    const launcherPath = path.join(state, "bootstrap", "launch-secure-local.ps1");
    const expectedCommand = "& { try { " +
      "$ErrorActionPreference = 'Stop'; " +
      `$launcherPath = '${launcherPath}'; ` +
      `if ((Get-FileHash -Algorithm SHA256 -LiteralPath $launcherPath -ErrorAction Stop).Hash.ToLowerInvariant() -cne '${launcherHash}') { throw 'Bootstrap verification failed.' }; ` +
      `& $launcherPath -StateRoot '${state}' -IntegrityModuleHash '${integrityHash}' -LauncherHash '${launcherHash}' ` +
      "} catch { $Error.Clear(); [Console]::Error.WriteLine('Secure local launcher failed.'); exit 1 } }";
    assert.equal(
      plan.Arguments,
      `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${expectedCommand}"`,
    );
    for (const forbidden of [
      "http://",
      "https://",
      "password",
      "secret",
      "ticket",
      "account",
      "provider",
      "synthetic-sensitive-value",
    ]) {
      assert.equal(JSON.stringify(plan).toLowerCase().includes(forbidden), false);
    }
    assert.equal(stderr, "");
  },
);

test(
  "shortcut verification round-trips all fields and rejects mutations, ACL drift, and reparse boundaries",
  windowsOnly,
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hma-start-menu-"));
    const programs = path.join(root, "Programs");
    const shortcutPath = path.join(programs, "How Much AI.lnk");
    const junction = path.join(root, "ProgramsJunction");
    const leafJunction = path.join(programs, "Reparse.lnk");
    await mkdir(programs, { recursive: true });
    try {
      const { stdout, stderr } = await runPowerShell([
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        `Import-Module ${psLiteral(runtimeModulePath)} -Force`,
        `Import-Module ${psLiteral(secretsModulePath)} -Force`,
        `$base = New-HmaStartMenuLauncherPlan -StateRoot 'C:\\private-state' -PowerShellPath ${psLiteral(powerShell51)} -IntegrityHash ${psLiteral("a".repeat(64))} -LauncherHash ${psLiteral("b".repeat(64))}`,
        `$plan = [pscustomobject][ordered]@{ Path = ${psLiteral(shortcutPath)}; TargetPath = $base.TargetPath; Arguments = $base.Arguments; WorkingDirectory = $base.WorkingDirectory; Description = $base.Description; IconLocation = $base.IconLocation; WindowStyle = $base.WindowStyle; Hotkey = $base.Hotkey }`,
        "$shell = New-Object -ComObject WScript.Shell",
        "$shortcut = $shell.CreateShortcut($plan.Path)",
        "foreach ($name in @('TargetPath','Arguments','WorkingDirectory','Description','IconLocation','WindowStyle','Hotkey')) { $shortcut.$name = $plan.$name }",
        "$shortcut.Save()",
        "[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)",
        "[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)",
        "$shortcut = $null; $shell = $null; [GC]::Collect(); [GC]::WaitForPendingFinalizers()",
        `Set-HmaPrivateAcl -LiteralPath ${psLiteral(root)}`,
        "$exact = Test-HmaStartMenuLauncherPlan -Plan $plan",
        "$mutations = [ordered]@{ TargetPath = 'C:\\wrong.exe'; Arguments = 'wrong'; WorkingDirectory = 'C:\\wrong'; Description = 'wrong'; IconLocation = 'C:\\wrong.exe,1'; WindowStyle = 1; Hotkey = 'Ctrl+Alt+H' }",
        "$rejected = 0",
        "foreach ($entry in $mutations.GetEnumerator()) { $copy = [pscustomobject][ordered]@{ Path = $plan.Path; TargetPath = $plan.TargetPath; Arguments = $plan.Arguments; WorkingDirectory = $plan.WorkingDirectory; Description = $plan.Description; IconLocation = $plan.IconLocation; WindowStyle = $plan.WindowStyle; Hotkey = $plan.Hotkey }; $copy.($entry.Key) = $entry.Value; if (-not (Test-HmaStartMenuLauncherPlan -Plan $copy)) { $rejected += 1 } }",
        "$pathMutation = [pscustomobject][ordered]@{ Path = (Join-Path ([IO.Path]::GetDirectoryName($plan.Path)) 'Missing.lnk'); TargetPath = $plan.TargetPath; Arguments = $plan.Arguments; WorkingDirectory = $plan.WorkingDirectory; Description = $plan.Description; IconLocation = $plan.IconLocation; WindowStyle = $plan.WindowStyle; Hotkey = $plan.Hotkey }",
        "if (-not (Test-HmaStartMenuLauncherPlan -Plan $pathMutation)) { $rejected += 1 }",
        "$acl = New-Object Security.AccessControl.FileSecurity",
        "$acl.SetAccessRuleProtection($true, $false)",
        "$current = [Security.Principal.WindowsIdentity]::GetCurrent().User",
        "$acl.SetOwner($current)",
        "$users = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')",
        "$rule = New-Object Security.AccessControl.FileSystemAccessRule($users, 'Read', 'Allow')",
        "[void]$acl.AddAccessRule($rule); [IO.File]::SetAccessControl($plan.Path, $acl)",
        "$aclRejected = -not (Test-HmaStartMenuLauncherPlan -Plan $plan)",
        "Set-HmaPrivateAcl -LiteralPath $plan.Path",
        `New-Item -ItemType Junction -Path ${psLiteral(junction)} -Target ${psLiteral(programs)} | Out-Null`,
        `$junctionPlan = [pscustomobject][ordered]@{ Path = (Join-Path ${psLiteral(junction)} 'How Much AI.lnk'); TargetPath = $plan.TargetPath; Arguments = $plan.Arguments; WorkingDirectory = $plan.WorkingDirectory; Description = $plan.Description; IconLocation = $plan.IconLocation; WindowStyle = $plan.WindowStyle; Hotkey = $plan.Hotkey }`,
        "$ancestorRejected = -not (Test-HmaStartMenuLauncherPlan -Plan $junctionPlan)",
        `New-Item -ItemType Junction -Path ${psLiteral(leafJunction)} -Target ${psLiteral(programs)} | Out-Null`,
        `$leafReparsePlan = [pscustomobject][ordered]@{ Path = ${psLiteral(leafJunction)}; TargetPath = $plan.TargetPath; Arguments = $plan.Arguments; WorkingDirectory = $plan.WorkingDirectory; Description = $plan.Description; IconLocation = $plan.IconLocation; WindowStyle = $plan.WindowStyle; Hotkey = $plan.Hotkey }`,
        "$leafReparseRejected = -not (Test-HmaStartMenuLauncherPlan -Plan $leafReparsePlan)",
        `$directoryLeaf = Join-Path ${psLiteral(programs)} 'Directory.lnk'`,
        "[void][IO.Directory]::CreateDirectory($directoryLeaf)",
        "$directoryPlan = [pscustomobject][ordered]@{ Path = $directoryLeaf; TargetPath = $plan.TargetPath; Arguments = $plan.Arguments; WorkingDirectory = $plan.WorkingDirectory; Description = $plan.Description; IconLocation = $plan.IconLocation; WindowStyle = $plan.WindowStyle; Hotkey = $plan.Hotkey }",
        "$ordinaryFileRequired = -not (Test-HmaStartMenuLauncherPlan -Plan $directoryPlan)",
        "[pscustomobject]@{ exact = $exact; rejected = $rejected; aclRejected = $aclRejected; ancestorRejected = $ancestorRejected; leafReparseRejected = $leafReparseRejected; ordinaryFileRequired = $ordinaryFileRequired } | ConvertTo-Json -Compress",
      ]);
      assert.deepEqual(parseSafeJson(stdout), {
        exact: true,
        rejected: 8,
        aclRejected: true,
        ancestorRejected: true,
        leafReparseRejected: true,
        ordinaryFileRequired: true,
      });
      assert.equal(stderr, "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "launcher validates both reserved tasks before following the exact Ready and Running state table",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      `. ${psLiteral(launcherScriptPath)} -StateRoot 'C:\\private-state' -IntegrityModuleHash ${psLiteral("b".repeat(64))} -LauncherHash ${psLiteral("a".repeat(64))}`,
      "function Invoke-Scenario { param([string]$ServiceState,[bool]$Missing,[bool]$Foreign,[bool]$Mutated,[bool]$WrongExecutingPath)",
      "  $script:starts = New-Object 'Collections.Generic.List[string]'",
      "  $script:gets = New-Object 'Collections.Generic.List[string]'",
      "  $config = [pscustomobject]@{ bootstrapHashes = [pscustomobject]@{ launcher = ('a' * 64); integrity = ('b' * 64); runtime = ('c' * 64) } }",
      "  $operations = @{",
      "    GetExecutingPath = { if ($WrongExecutingPath) { 'C:\\foreign\\launch-secure-local.ps1' } else { 'C:\\private-state\\bootstrap\\launch-secure-local.ps1' } };",
      "    GetCanonicalPath = { param($Path) [IO.Path]::GetFullPath([string]$Path) };",
      "    GetFileHash = { param($Path) if ([string]$Path -like '*launch-secure-local.ps1') { 'a' * 64 } elseif ([string]$Path -like '*SecureLocalIntegrity.psm1') { 'b' * 64 } else { 'c' * 64 } };",
      "    ImportIntegrity = { param($Path) $true }; ImportRuntime = { param($Path) $true };",
      "    AssertStartupIntegrity = { param($State) $config };",
      "    GetTask = { param($Name) [void]$script:gets.Add([string]$Name); if ($Missing -and $Name -ceq 'HowMuchAI-Window') { return $null }; $actualName = if ($Foreign -and $Name -ceq 'HowMuchAI-Window') { 'Foreign-Window' } else { $Name }; [pscustomobject]@{ TaskName = $actualName; State = if ($Name -ceq 'HowMuchAI-Service') { $ServiceState } else { 'Ready' }; Mutated = $Mutated } };",
      "    TestTask = { param($Task,$Config,$State) return (-not [bool]$Task.Mutated -and [string]$Task.TaskName -cin @('HowMuchAI-Service','HowMuchAI-Window')) };",
      "    StartTask = { param($Name) [void]$script:starts.Add([string]$Name); return $true }",
      "  }",
      "  $failed = $false; try { $null = Invoke-HmaSecureLocalLauncherCore -StateRoot 'C:\\private-state' -IntegrityModuleHash ('b' * 64) -LauncherHash ('a' * 64) -Operations $operations } catch { $failed = $true }",
      "  [pscustomobject]@{ state = $ServiceState; missing = $Missing; foreign = $Foreign; mutated = $Mutated; wrongExecutingPath = $WrongExecutingPath; failed = $failed; gets = @($script:gets); starts = @($script:starts) }",
      "}",
      "$records = @((Invoke-Scenario 'Ready' $false $false $false $false),(Invoke-Scenario 'Running' $false $false $false $false),(Invoke-Scenario 'Disabled' $false $false $false $false),(Invoke-Scenario 'Ready' $true $false $false $false),(Invoke-Scenario 'Ready' $false $true $false $false),(Invoke-Scenario 'Ready' $false $false $true $false),(Invoke-Scenario 'Ready' $false $false $false $true))",
      "$records | ConvertTo-Json -Compress -Depth 4",
    ]);
    const records = parseSafeJson<Array<{ failed: boolean; gets: string[]; starts: string[] }>>(stdout);
    assert.deepEqual(records[0], {
      state: "Ready", missing: false, foreign: false, mutated: false, wrongExecutingPath: false, failed: false,
      gets: ["HowMuchAI-Service", "HowMuchAI-Window"],
      starts: ["HowMuchAI-Service", "HowMuchAI-Window"],
    });
    assert.deepEqual(records[1].starts, ["HowMuchAI-Window"]);
    for (const record of records.slice(2)) {
      assert.equal(record.failed, true);
      assert.deepEqual(record.starts, []);
    }
    assert.equal(stderr, "");
  },
);

test(
  "standalone launcher failures emit exactly one generic line",
  windowsOnly,
  async () => {
    const child = spawn(
      powerShell51,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `& ${psLiteral(launcherScriptPath)} -StateRoot 'C:\\missing-secure-state' -IntegrityModuleHash ${psLiteral("a".repeat(64))} -LauncherHash ${psLiteral("b".repeat(64))}`,
      ],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.notEqual(exitCode, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /^Secure local launcher failed\.\r?\n$/u);
  },
);

test(
  "shortcut preflight and malformed direct invocations emit only the generic launcher error",
  windowsOnly,
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hma-launch-errors-"));
    const state = path.join(root, "state");
    const bootstrap = path.join(state, "bootstrap");
    await mkdir(bootstrap, { recursive: true });
    try {
      const integrityHash = "a".repeat(64);
      const launcherHash = "b".repeat(64);
      const { stdout, stderr } = await runPowerShell([
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        `Import-Module ${psLiteral(runtimeModulePath)} -Force`,
        `$plan = New-HmaStartMenuLauncherPlan -StateRoot ${psLiteral(state)} -PowerShellPath ${psLiteral(powerShell51)} -IntegrityHash ${psLiteral(integrityHash)} -LauncherHash ${psLiteral(launcherHash)}`,
        `$stderrPath = Join-Path ${psLiteral(root)} 'outer-stderr.txt'`,
        `$stdoutPath = Join-Path ${psLiteral(root)} 'outer-stdout.txt'`,
        "$records = New-Object 'Collections.Generic.List[object]'",
        "foreach ($mode in @('missing','tampered')) {",
        "  if ($mode -ceq 'missing') { [IO.File]::Delete((Join-Path $plan.WorkingDirectory 'launch-secure-local.ps1')) } else { [IO.File]::WriteAllText((Join-Path $plan.WorkingDirectory 'launch-secure-local.ps1'), 'tampered') }",
        "  [IO.File]::WriteAllText($stderrPath, ''); [IO.File]::WriteAllText($stdoutPath, '')",
        "  $process = Start-Process -FilePath $plan.TargetPath -ArgumentList $plan.Arguments -Wait -PassThru -WindowStyle Hidden -RedirectStandardError $stderrPath -RedirectStandardOutput $stdoutPath",
        "  [void]$records.Add([pscustomobject]@{ mode = $mode; exitCode = [int]$process.ExitCode; stdout = [IO.File]::ReadAllText($stdoutPath); stderr = [IO.File]::ReadAllText($stderrPath) })",
        "}",
        "$records | ConvertTo-Json -Compress",
      ]);
      const records = parseSafeJson<Array<{ exitCode: number; stdout: string; stderr: string }>>(stdout);
      for (const record of records) {
        assert.notEqual(record.exitCode, 0, JSON.stringify(record));
        assert.equal(record.stdout, "");
        assert.match(record.stderr, /^Secure local launcher failed\.\r?\n$/u);
      }
      assert.equal(stderr, "");

      for (const args of [
        ["-StateRoot", state, "-IntegrityModuleHash", "bad", "-LauncherHash", launcherHash],
        ["-StateRoot", state],
        ["-StateRoot", state, "-IntegrityModuleHash", integrityHash, "-LauncherHash", launcherHash, "-Unknown", "value"],
        ["-StateRoot", state, "-IntegrityModuleHash", integrityHash, "-LauncherHash", launcherHash, "-StateRoot", state],
      ]) {
        const child = spawn(
          powerShell51,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcherScriptPath, ...args],
          { windowsHide: true },
        );
        let directStdout = "";
        let directStderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { directStdout += chunk; });
        child.stderr.on("data", (chunk) => { directStderr += chunk; });
        const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
        assert.notEqual(exitCode, 0);
        assert.equal(directStdout, "");
        assert.match(directStderr, /^Secure local launcher failed\.\r?\n$/u);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "launcher plan rejects a single quote in an otherwise absolute state path",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      `Import-Module ${psLiteral(runtimeModulePath)} -Force`,
      "$rejected = $false",
      `try { $null = New-HmaStartMenuLauncherPlan -StateRoot "C:\\state'quote" -PowerShellPath ${psLiteral(powerShell51)} -IntegrityHash ${psLiteral("a".repeat(64))} -LauncherHash ${psLiteral("b".repeat(64))} } catch { $rejected = $true }`,
      "$rejected | ConvertTo-Json -Compress",
    ]);
    assert.equal(parseSafeJson(stdout), true);
    assert.equal(stderr, "");
  },
);

test("installer and final verifier expose candidate-first rollback-safe shortcut operations", async () => {
  const [installer, verifier] = await Promise.all([
    readFile(installerScriptPath, "utf8"),
    readFile(verifierScriptPath, "utf8"),
  ]);
  const candidate = installer.indexOf("CreateShortcut");
  const reopen = installer.indexOf("Test-HmaStartMenuLauncherFields", candidate);
  const acl = installer.indexOf("Set-HmaPrivateAcl", reopen);
  const move = installer.indexOf("[IO.File]::Move", acl);
  assert.ok(candidate >= 0 && reopen > candidate && acl > reopen && move > acl);
  assert.match(installer, /launcherCreatedByThisRun/u);
  assert.match(installer, /Test-HmaStartMenuLauncherPlan/u);
  assert.match(verifier, /Test-HmaRegisteredTaskPlan/u);
  assert.match(verifier, /Test-HmaStartMenuLauncherPlan/u);
  assert.match(verifier, /TestNoExactValuesInLauncher/u);
});
