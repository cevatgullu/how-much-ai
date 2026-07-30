import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  "DPAPI protects a unique strict-local bundle for the current Windows user",
  windowsOnly,
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hma-dpapi-"));
    const blob = path.join(root, "secrets.dpapi");
    const duplicateBlob = path.join(root, "duplicate.dpapi");
    const shortBlob = path.join(root, "short.dpapi");
    const marker = `hma-marker-${randomUUID()}`;

    try {
      const { stdout, stderr } = await runPowerShell(
        [
          "if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -lt 1) { throw 'Windows PowerShell 5.1 is required.' }",
          `Import-Module ${psLiteral(modulePath)} -Force`,
          `[IO.File]::WriteAllText(${psLiteral(path.join(root, "nested.txt"))}, 'fixture')`,
          `& "$env:SystemRoot\\System32\\icacls.exe" ${psLiteral(root)} '/grant' '*S-1-1-0:(OI)(CI)F' | Out-Null`,
          "if ($LASTEXITCODE -ne 0) { throw 'Could not create the ACL fixture.' }",
          `Set-HmaPrivateAcl -LiteralPath ${psLiteral(root)}`,
          "$bundle = @{ version = 1; appPassword = $env:HMA_TEST_MARKER; authSecret = ('b' * 64); vaultEncryptionSecret = ('c' * 64) }",
          `Protect-HmaSecretBundle -Bundle $bundle -Path ${psLiteral(blob)}`,
          `if (-not (Test-HmaPrivateAcl -LiteralPath ${psLiteral(blob)})) { throw 'The protected fixture ACL was not private.' }`,
          `if (-not (Test-HmaPrivateAcl -LiteralPath ${psLiteral(root)} -Recurse)) { throw 'The recursive fixture ACL was not private.' }`,
          ` $roundTrip = Unprotect-HmaSecretBundle -Path ${psLiteral(blob)}`,
          "$duplicateRejected = $false",
          `try { Protect-HmaSecretBundle -Bundle @{ version = 1; appPassword = ('d' * 64); authSecret = ('d' * 64); vaultEncryptionSecret = ('e' * 64) } -Path ${psLiteral(duplicateBlob)} } catch { $duplicateRejected = $true }`,
          "$shortRejected = $false",
          `try { Protect-HmaSecretBundle -Bundle @{ version = 1; appPassword = ('f' * 31); authSecret = ('g' * 64); vaultEncryptionSecret = ('h' * 64) } -Path ${psLiteral(shortBlob)} } catch { $shortRejected = $true }`,
          "$overwriteRejected = $false",
          `try { Protect-HmaSecretBundle -Bundle @{ version = 1; appPassword = ('i' * 64); authSecret = ('j' * 64); vaultEncryptionSecret = ('k' * 64) } -Path ${psLiteral(blob)} } catch { $overwriteRejected = $true }`,
          ` $preserved = (Unprotect-HmaSecretBundle -Path ${psLiteral(blob)}).appPassword -ceq $env:HMA_TEST_MARKER`,
          "$generatedOne = New-HmaRandomSecret",
          "$generatedTwo = New-HmaRandomSecret",
          "$generated = ($generatedOne.Length -ge 64 -and $generatedTwo.Length -ge 64 -and -not [string]::Equals($generatedOne, $generatedTwo, [StringComparison]::Ordinal))",
          `[pscustomobject]@{ matches = ($roundTrip.appPassword -ceq $env:HMA_TEST_MARKER); acl = (Test-HmaPrivateAcl -LiteralPath ${psLiteral(root)} -Recurse); duplicateRejected = ($duplicateRejected -and -not [IO.File]::Exists(${psLiteral(duplicateBlob)})); shortRejected = ($shortRejected -and -not [IO.File]::Exists(${psLiteral(shortBlob)})); overwriteRejected = $overwriteRejected; preserved = $preserved; generated = $generated } | ConvertTo-Json -Compress`,
        ],
        { HMA_TEST_MARKER: marker },
      );

      const result = parseSafeRecord<{
        matches: boolean;
        acl: boolean;
        duplicateRejected: boolean;
        shortRejected: boolean;
        overwriteRejected: boolean;
        preserved: boolean;
        generated: boolean;
      }>(stdout);
      assert.deepEqual(result, {
        matches: true,
        acl: true,
        duplicateRejected: true,
        shortRejected: true,
        overwriteRejected: true,
        preserved: true,
        generated: true,
      });
      assert.equal(stderr.length, 0);
      assert.equal(stdout.includes(marker), false);

      const blobBytes = await readFile(blob);
      assert.equal(blobBytes.includes(Buffer.from(marker, "utf8")), false);
      assert.equal(blobBytes.includes(Buffer.from(marker, "utf16le")), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "DPAPI unprotect rejects synthetic duplicate, short, and oversized payloads",
  windowsOnly,
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hma-dpapi-invalid-"));
    const duplicateBlob = path.join(root, "duplicate.dpapi");
    const shortBlob = path.join(root, "short.dpapi");
    const oversizedBlob = path.join(root, "oversized.dpapi");

    try {
      const { stdout, stderr } = await runPowerShell([
        "if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -lt 1) { throw 'Windows PowerShell 5.1 is required.' }",
        `Import-Module ${psLiteral(modulePath)} -Force`,
        `Set-HmaPrivateAcl -LiteralPath ${psLiteral(root)}`,
        "$entropy = [Text.Encoding]::UTF8.GetBytes('HowMuchAI:strict-local:dpapi:v1')",
        "function Write-SyntheticProtectedBundle { param([hashtable]$Bundle, [string]$LiteralPath) $jsonBytes = [Text.Encoding]::UTF8.GetBytes(($Bundle | ConvertTo-Json -Compress)); $protectedBytes = $null; try { $protectedBytes = [Security.Cryptography.ProtectedData]::Protect($jsonBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllText($LiteralPath, [Convert]::ToBase64String($protectedBytes), (New-Object Text.UTF8Encoding($false))); Set-HmaPrivateAcl -LiteralPath $LiteralPath } finally { [Array]::Clear($jsonBytes, 0, $jsonBytes.Length); if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) } } }",
        `Write-SyntheticProtectedBundle -Bundle @{ version = 1; appPassword = ('m' * 64); authSecret = ('m' * 64); vaultEncryptionSecret = ('n' * 64) } -LiteralPath ${psLiteral(duplicateBlob)}`,
        `Write-SyntheticProtectedBundle -Bundle @{ version = 1; appPassword = ('p' * 31); authSecret = ('q' * 64); vaultEncryptionSecret = ('r' * 64) } -LiteralPath ${psLiteral(shortBlob)}`,
        ` [IO.File]::WriteAllBytes(${psLiteral(oversizedBlob)}, (New-Object byte[] 65537))`,
        `Set-HmaPrivateAcl -LiteralPath ${psLiteral(oversizedBlob)}`,
        "$duplicateRejected = $false",
        `try { $null = Unprotect-HmaSecretBundle -Path ${psLiteral(duplicateBlob)} } catch { $duplicateRejected = $true }`,
        "$shortRejected = $false",
        `try { $null = Unprotect-HmaSecretBundle -Path ${psLiteral(shortBlob)} } catch { $shortRejected = $true }`,
        "$oversizedRejected = $false",
        `try { $null = Unprotect-HmaSecretBundle -Path ${psLiteral(oversizedBlob)} } catch { $oversizedRejected = $true }`,
        "[bool[]]$safe = @($duplicateRejected, $shortRejected, $oversizedRejected)",
        "ConvertTo-Json -InputObject $safe -Compress",
      ]);

      const result = parseSafeRecord<boolean[]>(stdout);
      assert.deepEqual(result, [true, true, true]);
      assert.equal(stderr.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
