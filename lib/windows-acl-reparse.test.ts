import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const windowsOnly = { skip: process.platform !== "win32" };
const modulePath = path.resolve("scripts/windows/SecureLocalSecrets.psm1");
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
    const { stdout, stderr } = await execFileAsync(
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
    return { stdout, stderr };
  } catch {
    throw new Error("The Windows PowerShell security fixture failed.");
  }
}

function parseSafeRecord<T>(stdout: string): T {
  try {
    return JSON.parse(stdout.trim()) as T;
  } catch {
    throw new Error("The Windows PowerShell fixture returned an invalid safe result.");
  }
}

test(
  "recursive ACL verification rejects every non-private ACE shape",
  windowsOnly,
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hma-acl-"));
    const extraRoot = path.join(root, "extra");
    const denyRoot = path.join(root, "deny");
    const missingRoot = path.join(root, "missing");
    const weakRoot = path.join(root, "weak");
    const extraFile = path.join(extraRoot, "nested.txt");
    const denyFile = path.join(denyRoot, "nested.txt");
    const missingFile = path.join(missingRoot, "nested.txt");
    const weakFile = path.join(weakRoot, "nested.txt");

    try {
      await Promise.all(
        [extraRoot, denyRoot, missingRoot, weakRoot].map(async (caseRoot) => {
          await mkdir(caseRoot);
          await writeFile(path.join(caseRoot, "nested.txt"), "fixture");
        }),
      );
      const { stdout, stderr } = await runPowerShell([
        "if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -lt 1) { throw 'Windows PowerShell 5.1 is required.' }",
        `Import-Module ${psLiteral(modulePath)} -Force`,
        `Set-HmaPrivateAcl -LiteralPath ${psLiteral(root)}`,
        ` $baseline = Test-HmaPrivateAcl -LiteralPath ${psLiteral(root)} -Recurse`,
        "$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
        `& "$env:SystemRoot\\System32\\icacls.exe" ${psLiteral(extraFile)} '/grant' '*S-1-5-32-545:R' | Out-Null`,
        "if ($LASTEXITCODE -ne 0) { throw 'Could not create the extra-principal fixture.' }",
        ` $extraRejected = -not (Test-HmaPrivateAcl -LiteralPath ${psLiteral(extraRoot)} -Recurse)`,
        `Set-HmaPrivateAcl -LiteralPath ${psLiteral(extraRoot)}`,
        ` $extraRepaired = Test-HmaPrivateAcl -LiteralPath ${psLiteral(extraRoot)} -Recurse`,
        `& "$env:SystemRoot\\System32\\icacls.exe" ${psLiteral(denyFile)} '/deny' '*S-1-5-18:D' | Out-Null`,
        "if ($LASTEXITCODE -ne 0) { throw 'Could not create the deny fixture.' }",
        ` $denyRejected = -not (Test-HmaPrivateAcl -LiteralPath ${psLiteral(denyRoot)} -Recurse)`,
        `& "$env:SystemRoot\\System32\\icacls.exe" ${psLiteral(missingFile)} '/remove:g' '*S-1-5-18' | Out-Null`,
        "if ($LASTEXITCODE -ne 0) { throw 'Could not create the missing-principal fixture.' }",
        ` $missingSystemRejected = -not (Test-HmaPrivateAcl -LiteralPath ${psLiteral(missingRoot)} -Recurse)`,
        "$currentGrant = '*' + $currentSid.Value + ':R'",
        `& "$env:SystemRoot\\System32\\icacls.exe" ${psLiteral(weakFile)} '/grant:r' $currentGrant | Out-Null`,
        "if ($LASTEXITCODE -ne 0) { throw 'Could not create the weakened-rights fixture.' }",
        ` $weakRejected = -not (Test-HmaPrivateAcl -LiteralPath ${psLiteral(weakRoot)} -Recurse)`,
        "$currentFullControl = '*' + $currentSid.Value + ':F'",
        `& "$env:SystemRoot\\System32\\icacls.exe" ${psLiteral(weakFile)} '/grant:r' $currentFullControl | Out-Null`,
        "if ($LASTEXITCODE -ne 0) { throw 'Could not restore the weakened-rights fixture.' }",
        "[bool[]]$safe = @($baseline, $extraRejected, $extraRepaired, $denyRejected, $missingSystemRejected, $weakRejected)",
        "ConvertTo-Json -InputObject $safe -Compress",
      ]);

      const result = parseSafeRecord<boolean[]>(stdout);
      assert.deepEqual(result, [true, true, true, true, true, true]);
      assert.equal(stderr.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "root and nested junctions fail closed without changing the external ACL",
  windowsOnly,
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hma-reparse-"));
    const external = path.join(root, "external");
    const privateRoot = path.join(root, "private");
    const rootJunction = path.join(root, "root-junction");
    const nestedJunction = path.join(privateRoot, "nested-junction");
    const externalFile = path.join(external, "outside.txt");
    const privateFile = path.join(privateRoot, "inside.txt");
    const absentMarker = `hma-absent-${randomUUID()}`;

    try {
      const { stdout, stderr } = await runPowerShell(
        [
          "if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -lt 1) { throw 'Windows PowerShell 5.1 is required.' }",
          `Import-Module ${psLiteral(modulePath)} -Force`,
          `[void][IO.Directory]::CreateDirectory(${psLiteral(external)})`,
          `[void][IO.Directory]::CreateDirectory(${psLiteral(privateRoot)})`,
          `[IO.File]::WriteAllText(${psLiteral(externalFile)}, 'external fixture')`,
          `[IO.File]::WriteAllText(${psLiteral(privateFile)}, 'private fixture')`,
          ` $externalRootBefore = (Get-Acl -LiteralPath ${psLiteral(external)} -ErrorAction Stop).Sddl`,
          ` $externalFileBefore = (Get-Acl -LiteralPath ${psLiteral(externalFile)} -ErrorAction Stop).Sddl`,
          `New-Item -ItemType Junction -Path ${psLiteral(rootJunction)} -Target ${psLiteral(external)} -ErrorAction Stop | Out-Null`,
          ` $rootTestRejected = -not (Test-HmaPrivateAcl -LiteralPath ${psLiteral(rootJunction)} -Recurse)`,
          "$rootSetRejected = $false",
          `try { Set-HmaPrivateAcl -LiteralPath ${psLiteral(rootJunction)} } catch { $rootSetRejected = $true }`,
          ` $rootScanRejected = -not (Test-HmaNoExactValuesAtRest -LiteralPath ${psLiteral(rootJunction)} -Values @($env:HMA_ABSENT_MARKER))`,
          ` $rootUnchanged = ((Get-Acl -LiteralPath ${psLiteral(external)} -ErrorAction Stop).Sddl -ceq $externalRootBefore -and (Get-Acl -LiteralPath ${psLiteral(externalFile)} -ErrorAction Stop).Sddl -ceq $externalFileBefore)`,
          `[IO.Directory]::Delete(${psLiteral(rootJunction)})`,
          `Set-HmaPrivateAcl -LiteralPath ${psLiteral(privateRoot)}`,
          `New-Item -ItemType Junction -Path ${psLiteral(nestedJunction)} -Target ${psLiteral(external)} -ErrorAction Stop | Out-Null`,
          ` $nestedTestRejected = -not (Test-HmaPrivateAcl -LiteralPath ${psLiteral(privateRoot)} -Recurse)`,
          "$nestedSetRejected = $false",
          `try { Set-HmaPrivateAcl -LiteralPath ${psLiteral(privateRoot)} } catch { $nestedSetRejected = $true }`,
          ` $nestedScanRejected = -not (Test-HmaNoExactValuesAtRest -LiteralPath ${psLiteral(privateRoot)} -Values @($env:HMA_ABSENT_MARKER))`,
          ` $nestedUnchanged = ((Get-Acl -LiteralPath ${psLiteral(external)} -ErrorAction Stop).Sddl -ceq $externalRootBefore -and (Get-Acl -LiteralPath ${psLiteral(externalFile)} -ErrorAction Stop).Sddl -ceq $externalFileBefore)`,
          "[bool[]]$safe = @($rootTestRejected, $rootSetRejected, $rootScanRejected, $rootUnchanged, $nestedTestRejected, $nestedSetRejected, $nestedScanRejected, $nestedUnchanged)",
          "ConvertTo-Json -InputObject $safe -Compress",
        ],
        { HMA_ABSENT_MARKER: absentMarker },
      );

      const result = parseSafeRecord<boolean[]>(stdout);
      assert.deepEqual(result, [true, true, true, true, true, true, true, true]);
      assert.equal(stderr.length, 0);
      assert.equal(stdout.includes(absentMarker), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a junction in the root ancestry fails closed before the external child is touched",
  windowsOnly,
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hma-reparse-ancestor-"));
    const external = path.join(root, "external");
    const externalChild = path.join(external, "ordinary-child");
    const externalFile = path.join(externalChild, "outside.txt");
    const junction = path.join(root, "ancestor-junction");
    const apparentRoot = path.join(junction, "ordinary-child");
    const absentMarker = `hma-absent-${randomUUID()}`;

    try {
      const { stdout, stderr } = await runPowerShell(
        [
          "if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -lt 1) { throw 'Windows PowerShell 5.1 is required.' }",
          `Import-Module ${psLiteral(modulePath)} -Force`,
          `[void][IO.Directory]::CreateDirectory(${psLiteral(externalChild)})`,
          `[IO.File]::WriteAllText(${psLiteral(externalFile)}, 'external fixture')`,
          ` $externalRootBefore = (Get-Acl -LiteralPath ${psLiteral(externalChild)} -ErrorAction Stop).Sddl`,
          ` $externalFileBefore = (Get-Acl -LiteralPath ${psLiteral(externalFile)} -ErrorAction Stop).Sddl`,
          `New-Item -ItemType Junction -Path ${psLiteral(junction)} -Target ${psLiteral(external)} -ErrorAction Stop | Out-Null`,
          ` $testRejected = -not (Test-HmaPrivateAcl -LiteralPath ${psLiteral(apparentRoot)} -Recurse)`,
          "$setRejected = $false",
          `try { Set-HmaPrivateAcl -LiteralPath ${psLiteral(apparentRoot)} } catch { $setRejected = $true }`,
          ` $scanRejected = -not (Test-HmaNoExactValuesAtRest -LiteralPath ${psLiteral(apparentRoot)} -Values @($env:HMA_ABSENT_MARKER))`,
          ` $unchanged = ((Get-Acl -LiteralPath ${psLiteral(externalChild)} -ErrorAction Stop).Sddl -ceq $externalRootBefore -and (Get-Acl -LiteralPath ${psLiteral(externalFile)} -ErrorAction Stop).Sddl -ceq $externalFileBefore)`,
          "[bool[]]$safe = @($testRejected, $setRejected, $scanRejected, $unchanged)",
          "ConvertTo-Json -InputObject $safe -Compress",
        ],
        { HMA_ABSENT_MARKER: absentMarker },
      );

      const result = parseSafeRecord<boolean[]>(stdout);
      assert.deepEqual(result, [true, true, true, true]);
      assert.equal(stderr.length, 0);
      assert.equal(stdout.includes(absentMarker), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "at-rest scanning finds exact multi-encoding values across buffer boundaries",
  windowsOnly,
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hma-at-rest-"));
    const matchesRoot = path.join(root, "matches");
    const cleanRoot = path.join(root, "clean");
    const first = `hma-ascii-${randomUUID()}`;
    const second = `hma-utf8-${randomUUID()}-\u03c0-\ud83e\uddea`;
    const third = `hma-wide-${randomUUID()}-\u6f22\u5b57`;

    try {
      await Promise.all([
        writeFile(
          path.join(root, "first.bin"),
          Buffer.concat([Buffer.alloc(4093, 0x78), Buffer.from(first, "ascii")]),
        ),
        writeFile(
          path.join(root, "second.bin"),
          Buffer.concat([Buffer.alloc(4095, 0x79), Buffer.from(second, "utf8")]),
        ),
        writeFile(
          path.join(root, "third.bin"),
          Buffer.concat([Buffer.alloc(4094, 0x7a), Buffer.from(third, "utf16le")]),
        ),
      ]);
      await Promise.all([
        writeFile(path.join(root, "clean.bin"), "unrelated fixture"),
      ]);

      const { stdout, stderr } = await runPowerShell(
        [
          "if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -lt 1) { throw 'Windows PowerShell 5.1 is required.' }",
          `Import-Module ${psLiteral(modulePath)} -Force`,
          `[void][IO.Directory]::CreateDirectory(${psLiteral(matchesRoot)})`,
          `[void][IO.Directory]::CreateDirectory(${psLiteral(cleanRoot)})`,
          `Move-Item -LiteralPath ${psLiteral(path.join(root, "first.bin"))} -Destination ${psLiteral(matchesRoot)} -ErrorAction Stop`,
          `Move-Item -LiteralPath ${psLiteral(path.join(root, "second.bin"))} -Destination ${psLiteral(matchesRoot)} -ErrorAction Stop`,
          `Move-Item -LiteralPath ${psLiteral(path.join(root, "third.bin"))} -Destination ${psLiteral(matchesRoot)} -ErrorAction Stop`,
          `Move-Item -LiteralPath ${psLiteral(path.join(root, "clean.bin"))} -Destination ${psLiteral(cleanRoot)} -ErrorAction Stop`,
          `Set-HmaPrivateAcl -LiteralPath ${psLiteral(matchesRoot)}`,
          `Set-HmaPrivateAcl -LiteralPath ${psLiteral(cleanRoot)}`,
          ` $firstRaw = @(Test-HmaNoExactValuesAtRest -LiteralPath ${psLiteral(matchesRoot)} -Values @($env:HMA_VALUE_ONE))`,
          ` $secondRaw = @(Test-HmaNoExactValuesAtRest -LiteralPath ${psLiteral(matchesRoot)} -Values @($env:HMA_VALUE_TWO))`,
          ` $thirdRaw = @(Test-HmaNoExactValuesAtRest -LiteralPath ${psLiteral(matchesRoot)} -Values @($env:HMA_VALUE_THREE))`,
          ` $cleanRaw = @(Test-HmaNoExactValuesAtRest -LiteralPath ${psLiteral(cleanRoot)} -Values @($env:HMA_VALUE_ONE, $env:HMA_VALUE_TWO, $env:HMA_VALUE_THREE))`,
          "$onlyBooleans = ($firstRaw.Count -eq 1 -and $firstRaw[0] -is [bool] -and $secondRaw.Count -eq 1 -and $secondRaw[0] -is [bool] -and $thirdRaw.Count -eq 1 -and $thirdRaw[0] -is [bool] -and $cleanRaw.Count -eq 1 -and $cleanRaw[0] -is [bool])",
          "[bool[]]$safe = @((-not $firstRaw[0]), (-not $secondRaw[0]), (-not $thirdRaw[0]), $cleanRaw[0], $onlyBooleans)",
          "ConvertTo-Json -InputObject $safe -Compress",
        ],
        {
          HMA_VALUE_ONE: first,
          HMA_VALUE_TWO: second,
          HMA_VALUE_THREE: third,
        },
      );

      const result = parseSafeRecord<boolean[]>(stdout);
      assert.deepEqual(result, [true, true, true, true, true]);
      assert.equal(stderr.length, 0);
      assert.equal(stdout.includes(first), false);
      assert.equal(stdout.includes(second), false);
      assert.equal(stdout.includes(third), false);
      assert.equal(/utf|ascii|unicode|offset|encoding|path/i.test(stdout), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "byte-pattern scanning keeps exact boundary behavior without a PowerShell byte-by-byte hot path",
  windowsOnly,
  async () => {
    const { stdout, stderr } = await runPowerShell([
      ` $module = Import-Module ${psLiteral(modulePath)} -Force -PassThru`,
      "& $module {",
      "  $buffer = New-Object byte[] (8 * 1024 * 1024)",
      "  $pattern = [byte[]](1..32)",
      "  $stopwatch = [Diagnostics.Stopwatch]::StartNew()",
      "  $absent = Test-HmaWindowContainsPattern -Buffer $buffer -Count $buffer.Length -Pattern $pattern",
      "  [Buffer]::BlockCopy($pattern, 0, $buffer, $buffer.Length - $pattern.Length, $pattern.Length)",
      "  $atBoundary = Test-HmaWindowContainsPattern -Buffer $buffer -Count $buffer.Length -Pattern $pattern",
      "  $stopwatch.Stop()",
      "  [pscustomobject]@{ absent = (-not $absent); boundary = $atBoundary; fast = ($stopwatch.ElapsedMilliseconds -lt 1500) } | ConvertTo-Json -Compress",
      "}",
    ]);

    assert.deepEqual(parseSafeRecord(stdout), {
      absent: true,
      boundary: true,
      fast: true,
    });
    assert.equal(stderr, "");
  },
);
