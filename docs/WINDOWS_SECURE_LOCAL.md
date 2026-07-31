# Secure Windows local mode

This guide covers the reviewed Windows strict-local installation of How Much AI.
It is separate from the general development and self-hosting modes described in
the README and in `docs/SELF_HOSTING.md`.

Do not connect a real provider account until the complete source, dependency,
static-analysis, build, Microsoft Defender, installation, listener, ACL, task,
and browser-boundary gates below have passed. If a gate fails, stop. Do not
weaken the gate to make the installation start.

## Threat model

The strict-local installation is designed to reduce these risks:

- access to the dashboard from the LAN or another network interface;
- access to saved state by another Windows user;
- accidentally starting the application in its unauthenticated open mode;
- storing the dashboard secrets or provider credentials in plaintext at rest;
- accidentally running source or dependencies that differ from the reviewed
  manifest;
- writing credentials into persistent logs, task definitions, audit artifacts,
  browser storage, the clipboard, or command-line arguments; and
- unintended destinations reached through the application's Fetch API.

This is a bounded hardening design, not a guarantee of absolute security. It
does not protect against an administrator, debugger, malware, or EDR product
that can inspect or act as the same Windows user. It also does not confine a
malicious reviewed dependency that opens a raw socket or uses another
direct-network primitive instead of application Fetch. The Windows pagefile,
hibernation file, crash dumps, managed-runtime copies, and provider-side
systems are outside this boundary.

## Pinned source

The reviewed upstream base is
`1238189b7017601d21e3579d041480ce3773e191`. The installed source is that base
plus the exact reviewed local hardening commit stored in
`audit/final/final-commit.txt`.

`audit/final/runtime-manifest.json` binds the final commit, the reviewed Node
executable hash, every installed runtime file, and every bootstrap file. Its
SHA-256 is published beside it in `audit/final/runtime-manifest.sha256` and is
also retained as an in-memory trust anchor in the same PowerShell session. The
installer refuses a dirty source tree, the wrong ancestry, a manifest mismatch,
an added or missing installable file, and a changed file hash or size.

Never run `git pull` in the reviewed source or installed runtime. Never install
from an unreviewed archive, binary, branch tip, or rebuilt dependency tree.

## Runtime

The installer creates a private, versioned production runtime under
`%LOCALAPPDATA%\HowMuchAI\runtime`. Its child directory is named by the full
commit recorded in `audit/final/final-commit.txt`. The installed runtime is an
exact manifest-verified file set and has no mutable runtime exception;
`.next\cache` is neither copied nor recreated.

The Next.js production server runs only at `http://127.0.0.1:37645` with:

- `HMC_STRICT_LOCAL_MODE=1`;
- `HMC_LISTEN_HOST=127.0.0.1`;
- `HMC_LISTEN_PORT=37645`;
- `PORT=37645`;
- `NODE_ENV=production`;
- `TRUST_PROXY_IP_HEADERS=0`;
- `NEXT_TELEMETRY_DISABLED=1`; and
- remote vaults, remote notifications, analytics, and deployment-platform
  configuration absent.

Strict mode validates the environment before startup and requires the exact
request Host `127.0.0.1:37645`. A mismatch fails closed.

The current application Fetch policy permits exactly these HTTPS origins:

- `https://api.anthropic.com`
- `https://platform.claude.com`
- `https://auth.openai.com`
- `https://chatgpt.com`

The guard rejects userinfo, cleartext HTTP, alternate ports, lookalike hosts,
and any other origin, and forces redirect handling to `manual`. The allowlist
permits every path and HTTP method on those four origins. It is an
application-level `globalThis.fetch` guard, not an OS firewall, network filter,
container, process sandbox, DNS pin, or raw-socket control.

The application is unofficial and reads provider usage only. Provider endpoint
or response-format changes can make a connection or refresh fail and require a
new reviewed revision.

## Child environments

The service and Edge launchers replace the entire inherited process
environment after integrity, module, path, and signer checks. They do not merge
the launch plan with arbitrary ambient values.

The reviewed minimal Windows base contains a nonempty value only for these
names:

`APPDATA`, `COMSPEC`, `HOMEDRIVE`, `HOMEPATH`, `LOCALAPPDATA`,
`NUMBER_OF_PROCESSORS`, `OS`, `PATHEXT`, `PROCESSOR_ARCHITECTURE`,
`PROCESSOR_IDENTIFIER`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `TMP`,
`USERPROFILE`, and `WINDIR`.

Node receives only that base plus these exact service keys:

`APP_PASSWORD`, `AUTH_SECRET`, `ENABLE_LOCAL_CONNECT`, `HMC_LISTEN_HOST`,
`HMC_LISTEN_PORT`, `HMC_STRICT_LOCAL_MODE`, `NEXT_TELEMETRY_DISABLED`,
`NODE_ENV`, `PORT`, `TRUST_PROXY_IP_HEADERS`, `VAULT_DATA_DIR`, and
`VAULT_ENCRYPTION_SECRET`.

Edge receives only the minimal Windows base. It receives no dashboard password,
authentication secret, vault secret, provider token, proxy or TLS override,
Node preload value, `PATH`, `PSModulePath`, `NODE_OPTIONS`, `NODE_PATH`, or
arbitrary ambient variable.

## Secrets

The installer generates three independent cryptographically random values for
`APP_PASSWORD`, `AUTH_SECRET`, and `VAULT_ENCRYPTION_SECRET`. It stores them
only in the Windows CurrentUser DPAPI bundle:

`%LOCALAPPDATA%\HowMuchAI\secrets.dpapi`

There is no `.env.local`, plaintext recovery file, or `vault.key`. Provider
credentials and refresh-recovery state remain encrypted under:

`%LOCALAPPDATA%\HowMuchAI\vault`

DPAPI supplies at-rest protection bound to the same Windows user profile on the
same Windows installation. It is not protection from code already able to act
as that user or from an administrator with equivalent inspection capability.

## Runtime plaintext boundary

While `HowMuchAI-Service` runs, the three strict-local values necessarily exist
in the Node child environment and managed memory. OAuth codes, state, provider
tokens, session material, and decrypted vault records can exist transiently in
Node or Edge memory while their operations run.

Clearing PowerShell and JavaScript references reduces useful lifetime but
cannot reliably erase immutable strings, garbage-collector copies, environment
blocks, pagefile or hibernation content, crash dumps, or EDR captures. Never
create a memory dump to try to prove secrecy. Do not enable a persistent
PowerShell transcript or redirect the launchers' output to a persistent log.

## ACL

The state root, bootstrap files, versioned runtime, DPAPI bundle, encrypted
vault, recovery journal, and OAuth temporary-profile container use a protected
ACL with access for only:

- the current Windows SID, with explicit Full Control; and
- `SYSTEM`, with explicit Full Control.

Inherited, extra, deny, weakened, and missing access entries fail validation.
Reparse points in control, bootstrap, runtime, vault, or closed-profile state
also fail validation. ACLs prevent access by other ordinary Windows users; they
do not form a same-user malware boundary.

## Autostart

The installer registers exactly two current-user Task Scheduler tasks:

- `HowMuchAI-Service` runs the hash-verified private
  `start-secure-local.ps1`.
- `HowMuchAI-Window` runs the hash-verified private
  `open-secure-local.ps1`.

Both tasks use Windows PowerShell 5.1, an interactive current-user principal,
and `Limited` run level. Their reviewed settings use a current-user logon
trigger, `IgnoreNew`, `StartWhenAvailable`, no execution time limit, and three
one-minute restart attempts. Task actions contain only fixed flags, protected
paths, and public hashes; they contain no secret name, secret value, bootstrap
ticket, provider identifier, or raw task XML.

The service launcher runs `Assert-HmaStartupIntegrity` before importing the
DPAPI module or decrypting `secrets.dpapi`. The Edge launcher repeats integrity
and exact listener-owner checks before sending the DPAPI-held password to the
loopback bootstrap endpoint.

## Browser bootstrap

`open-secure-local.ps1` obtains a cryptographically random bootstrap ticket
from the already verified service. The server retains only the ticket's
SHA-256, permits at most one live ticket, and makes it redeemable for at most
20 seconds and one use.

The ticket enters Edge only in
`/bootstrap#bootstrap=`. The bootstrap page synchronously removes the fragment
from the visible URL and current history entry before awaiting the same-origin
consume request. Successful consumption creates only the existing host-only,
HttpOnly, `SameSite=Strict` session cookie.

Strict mode has no dashboard-password field and uses no `SendKeys`, keyboard
injection, focus automation, clipboard, browser storage, or auxiliary listener.
The ticket is not a password, session cookie, or provider credential and is
never placed in a scheduled task. It becomes unusable immediately after
redemption or expiry, although its inert bytes can remain in protected Edge
process metadata or profile/history artifacts until the process or profile is
removed.

## Temporary OAuth profile

Claude connections use the private `connect-claude-secure.ps1` connector, a
server-side attempt store, and the reviewed extension under
`scripts\windows\oauth-handoff-extension`.

An attempt lasts exactly five minutes and the server retains at most eight
attempts. The connector receives only a 43-character opaque attempt id. The
PKCE verifier remains server-side. Raw OAuth state exists only until the
one-use launch redirect is created; after launch the store retains its
SHA-256. A callback atomically claims the pending attempt before network I/O,
so concurrent or replayed callbacks cannot perform a second exchange. An
ambiguous timeout, transport error, or upstream 5xx is terminal and is not
automatically retried.

The narrow handoff uses exact `/api/connect/oauth/attempt/start`,
`/api/connect/oauth/attempt/callback`, and
`/api/connect/oauth/attempt/status` routes. The one-use launch route begins
with `/api/connect/oauth/attempt/launch/` and admits only one exact
43-character base64url attempt-id path segment. The browser callback is exact
`/oauth/callback`; broader prefixes and lookalike paths remain
session-protected.

The Manifest V3 extension has exactly one content-script match:

`https://platform.claude.com/oauth/code/callback*`

It has no permissions, optional permissions, background worker, storage,
clipboard, tabs, scripting, `webRequest`, broad host permission, logging,
fetch, or messaging. Its static `callback.js` accepts only the bounded callback
representations reviewed by the application parser and immediately replaces
the provider callback with the local `/oauth/callback` fragment handoff. A
provider-format change stops the connection instead of widening page access.

`%LOCALAPPDATA%\HowMuchAI\oauth-temp` is a private-ACL, reparse-free mutable
container. It is empty outside a connector run and contains exactly one
strictly named `attempt-` profile during a run. The connector starts only the
local attempt URL and never puts OAuth state, challenge, code, or a password in
a PowerShell argument or log.

If the provider presents a password, passkey, CAPTCHA, hardware-key prompt, or
two-factor approval, the user completes that protected interaction directly
in Edge. The connector and application do not capture or automate it. On
success, keep the profile open only long enough to perform the synchronized
official **Settings -> Usage** comparison. Closing that exact Edge profile is
the completion signal. The connector then closes any remaining process using
that exact profile, verifies the path is a canonical child of `oauth-temp`,
deletes it, and refuses another account if deletion fails.

An authorization code necessarily exists transiently on the provider callback
page, and OAuth state necessarily reaches Anthropic. Local lifetime controls
do not erase provider-side logs, pagefile content, crash dumps, EDR captures,
or memory visible to an administrator or same-user malware.

## Persistent Edge profile

The installed dashboard uses
`%LOCALAPPDATA%\HowMuchAI\edge-profile`. At startup,
`Assert-HmaStartupIntegrity` validates that exact root as a non-reparse
directory with the protected current-user/`SYSTEM` ACL. It deliberately does
not enumerate live Chromium contents, which avoids racing a running browser.

Full recursive ACL and reparse inspection occurs only after
`Stop-HmaDedicatedEdgeProfile` has closed the exact processes using that
profile. The protected root is the cross-user boundary. It is not a claim that
profile contents are hidden from code running as the same user.

## Installation

Use Windows PowerShell 5.1 from a clean, separately cloned source tree. Node.js
must be `22.18.0` or newer. The reviewed machine uses Node.js `24.14.0`.
Microsoft Edge, Task Scheduler, and Microsoft Defender must be available.

First record the toolchain and source state:

```powershell
node --version
npm.cmd --version
git status --porcelain
git log --oneline --decorate -6
```

Enumerate dependency lifecycle scripts, review each result, then install
without running them:

```powershell
New-Item -ItemType Directory -Force 'audit\final' | Out-Null
node -e "const l=require('./package-lock.json'); const rows=Object.entries(l.packages).filter(([,v])=>v&&v.hasInstallScript).map(([p,v])=>({path:p,name:v.name||p,version:v.version})); process.stdout.write(JSON.stringify(rows,null,2))" | Set-Content -Encoding utf8 'audit\final\npm-install-scripts.json'
npm.cmd ci --ignore-scripts --audit=false --fund=false
npm.cmd ls --all | Set-Content -Encoding utf8 'audit\final\npm-ls.txt'
npm.cmd audit --json | Set-Content -Encoding utf8 'audit\final\npm-audit.json'
git diff -- package.json package-lock.json
```

Review the realized dependency tree with the supply-chain risk audit. Run the
comprehensive local Semgrep scan and the insecure-defaults review described by
the security gate. Do not continue with an unexplained install script,
maintainer-takeover signal, unpinned executable download, high-risk package, or
unresolved production high/critical finding.

Run the repository validation through the reviewed minimal-environment
launcher:

```powershell
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
node scripts/audit/run-sanitized-validation.mjs --npm $npm
```

After the audit tooling is committed and the final source/static gate passes,
create and scan the installable manifest and prove that two production starts
do not mutate the staged runtime:

```powershell
git rev-parse HEAD | Set-Content -Encoding ascii 'audit\final\final-commit.txt'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$git = (Get-Command git.exe -ErrorAction Stop).Source
node scripts/audit/create-runtime-manifest.mjs --root . --commit (Get-Content -Raw 'audit\final\final-commit.txt').Trim() --node $node --git $git --output audit/final/runtime-manifest.json --sha256-output audit/final/runtime-manifest.sha256
if ($LASTEXITCODE -ne 0) { throw 'Runtime manifest generation failed.' }
$trustedManifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath 'audit\final\runtime-manifest.json').Hash.ToLowerInvariant()
$publishedManifestSha256 = (Get-Content -Raw -LiteralPath 'audit\final\runtime-manifest.sha256').Trim().ToLowerInvariant()
if ($trustedManifestSha256 -notmatch '^[a-f0-9]{64}$' -or
    $publishedManifestSha256 -cne $trustedManifestSha256) {
    throw 'Runtime manifest trust anchor mismatch.'
}
node scripts/audit/safe-secret-scan.mjs --json audit/final/secret-scan.json --manifest audit/final/runtime-manifest.json
node scripts/audit/prove-runtime-immutability.mjs --root . --manifest audit/final/runtime-manifest.json
```

Keep this PowerShell session open through installation and final-state
verification. Do not reconstruct `$trustedManifestSha256` from the adjacent
hash file later.

Locate Microsoft Defender's installed platform `MpCmdRun.exe`, bind
`$mpCmdRun` to that resolved executable, and scan the reviewed source and
production build without remediation:

```powershell
& $mpCmdRun -Scan -ScanType 3 -File (Resolve-Path '.').Path -DisableRemediation
$exitCode = $LASTEXITCODE
"DefenderExitCode=$exitCode" | Set-Content -Encoding ascii 'audit\final\defender.txt'
if ($exitCode -ne 0) { throw "Defender did not return a clean scan result." }
```

Install only after every pre-credential gate is green:

```powershell
$ps51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if ($trustedManifestSha256 -notmatch '^[a-f0-9]{64}$') { throw 'The manifest trust anchor is unavailable.' }
& $ps51 -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\windows\install-secure-local.ps1 -SourceRoot (Resolve-Path '.').Path -ExpectedManifestSha256 $trustedManifestSha256
```

The idempotent installer creates and verifies
`%LOCALAPPDATA%\HowMuchAI`, copies only the manifest file sets, creates the
DPAPI bundle only when absent, writes only the non-secret `install.json`,
checks any existing listener and task ownership, and registers the two limited
tasks. It refuses to overwrite a mismatched runtime, unrelated task, invalid
state root, or unverified DPAPI state.

Start the reviewed service, wait for its exact loopback listener and reviewed
Node executable, and then open the reviewed Edge window:

```powershell
Start-ScheduledTask -TaskName 'HowMuchAI-Service'
$deadline = [DateTime]::UtcNow.AddSeconds(60)
do {
    Start-Sleep -Milliseconds 500
    try { $health = Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 'http://127.0.0.1:37645/login' -ErrorAction Stop } catch { $health = $_.Exception.Response }
} until ($null -ne $health -or [DateTime]::UtcNow -ge $deadline)
if ($null -eq $health) { throw 'The local dashboard did not become ready.' }
$serviceTask = Get-ScheduledTask -TaskName 'HowMuchAI-Service'
$listener = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort 37645
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
$config = Get-Content -Raw -LiteralPath (Join-Path $env:LOCALAPPDATA 'HowMuchAI\install.json') | ConvertFrom-Json
if ($serviceTask.State -ne 'Running' -or $process.ExecutablePath -ne $config.nodePath) {
    throw 'The registered service task did not start the reviewed Node executable.'
}
Start-ScheduledTask -TaskName 'HowMuchAI-Window'
```

For each Claude identity, hash-verify and run the installed
`connect-claude-secure.ps1` from the private bootstrap with only `StateRoot`
and `ExpectedConnectorHash`. Complete only provider-protected prompts in the
temporary Edge profile. Connect one identity at a time and require deletion of
the previous profile before starting another. Connect ChatGPT/Codex from the
dashboard's **connect from this machine** route. Never paste a credential,
callback value, cookie, account identifier, or protected authentication value
into a shell, file, clipboard, log, audit artifact, or chat.

## Verification commands

The commands below are the reviewed Task 9, Task 10, and Task 12 command
surfaces. Run them from the clean reviewed source root in Windows PowerShell
unless the text says otherwise. Stop on the first nonzero result or failed
invariant.

### Source and build gate

Re-run the sanitized test, typecheck, and production-build sequence:

```powershell
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
node scripts/audit/run-sanitized-validation.mjs --npm $npm
```

Re-run the safe scanner and immutable-runtime proof against the exact final
manifest:

```powershell
node scripts/audit/safe-secret-scan.mjs --json audit/final/secret-scan.json --manifest audit/final/runtime-manifest.json
node scripts/audit/prove-runtime-immutability.mjs --root . --manifest audit/final/runtime-manifest.json
```

Re-run the comprehensive local Semgrep and insecure-defaults reviews on the
same final commit. The security gate defines no substitute executable path for
those reviews; use the reviewed local analysis configuration and retain only
sanitized evidence under `audit\final`.

### Installed Windows boundary

Verify that port `37645` has exactly one loopback listener:

```powershell
$listeners = Get-NetTCPConnection -State Listen -LocalPort 37645
$listeners | Format-Table -AutoSize | Out-String | Set-Content -Encoding utf8 'audit\final\listener.txt'
if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') {
    throw 'The dashboard listener is not exclusively bound to 127.0.0.1.'
}
$lanAddresses = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.AddressState -eq 'Preferred' }
foreach ($address in $lanAddresses) {
    if (Test-NetConnection -ComputerName $address.IPAddress -Port 37645 -InformationLevel Quiet) {
        throw 'The dashboard unexpectedly accepted a non-loopback connection.'
    }
}
```

Hash-verify `SecureLocalIntegrity.psm1`, import it from the installed private
bootstrap, and run:

```powershell
$state = Join-Path $env:LOCALAPPDATA 'HowMuchAI'
$config = Get-Content -Raw -LiteralPath (Join-Path $state 'install.json') | ConvertFrom-Json
$integrityModule = Join-Path $state 'bootstrap\SecureLocalIntegrity.psm1'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $integrityModule).Hash -ne $config.bootstrapHashes.integrity) {
    throw 'Post-install integrity module verification failed.'
}
Import-Module $integrityModule -Force -ErrorAction Stop
$null = Assert-HmaStartupIntegrity -StateRoot $state
```

Verify both registered tasks in memory with
`Test-HmaRegisteredTaskPlan`. Record only each task name and the booleans
`secretFree` and `planValid`; never emit raw actions, XML, SID, command lines,
environment blocks, or decrypted values.

```powershell
$state = Join-Path $env:LOCALAPPDATA 'HowMuchAI'
$config = Get-Content -Raw -LiteralPath (Join-Path $state 'install.json') | ConvertFrom-Json
$bootstrap = Join-Path $state 'bootstrap'
$integrityModule = Join-Path $bootstrap 'SecureLocalIntegrity.psm1'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $integrityModule).Hash -ne $config.bootstrapHashes.integrity) {
    throw 'Post-install integrity module verification failed.'
}
Import-Module $integrityModule -Force -ErrorAction Stop
$config = Assert-HmaStartupIntegrity -StateRoot $state
Import-Module (Join-Path $bootstrap 'SecureLocalSecrets.psm1') -Force -ErrorAction Stop
Import-Module (Join-Path $bootstrap 'SecureLocalRuntime.psm1') -Force -ErrorAction Stop
$bundle = Unprotect-HmaSecretBundle -Path (Join-Path $state 'secrets.dpapi')
$secretValues = @([string]$bundle.appPassword, [string]$bundle.authSecret, [string]$bundle.vaultEncryptionSecret)
$summaries = foreach ($name in 'HowMuchAI-Service','HowMuchAI-Window') {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
    $xml = Export-ScheduledTask -TaskName $name
    $actionText = @($task.Actions | ForEach-Object { "$($_.Execute)`n$($_.Arguments)`n$($_.WorkingDirectory)" }) -join "`n"
    $containsSecretValue = [bool]($secretValues | Where-Object { $actionText.Contains($_) -or $xml.Contains($_) })
    $containsSecretName = [bool](($actionText + $xml) -match '(?i)(APP_PASSWORD|AUTH_SECRET|VAULT_ENCRYPTION_SECRET|accessToken|refreshToken)')
    [pscustomobject]@{
        task = $name
        secretFree = (-not $containsSecretValue -and -not $containsSecretName)
        planValid = (Test-HmaRegisteredTaskPlan -Task $task -Config $config -StateRoot $state)
    }
}
$bundle = $null
$secretValues = $null
if ($summaries | Where-Object { -not $_.secretFree -or -not $_.planValid }) {
    throw 'Scheduled-task verification failed.'
}
$summaries | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 'audit\final\tasks.json'
```

Exercise both Task Scheduler actions twice. Confirm listener recovery,
successful `HowMuchAI-Window` task results, startup-integrity success on both
service starts, an unchanged installed runtime, and a clean second Edge
bootstrap with no fragment left in the visible URL. This manual exercise does
not prove that a natural Windows logon trigger fired.

### Five-account and final-state checks

Prove deterministic partial-failure isolation without revoking a real
credential:

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/refresh-all.test.ts lib/usage-cache-core.test.ts lib/providers/usage-service-openai.test.ts lib/browser-boundary.test.ts lib/oauth-secure-handoff.test.ts
```

Prove the five-minute production cache boundary:

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-name-pattern="one-minute polls of five accounts|entry within TTL|exactly at TTL boundary" lib/local-usage-coordinator.test.ts lib/usage-cache-core.test.ts
```

For each Claude card, compare the same named usage windows with the official
**Settings -> Usage** view within 60 seconds of a newly advanced `fetchedAt`.
For the ChatGPT/Codex card, compare with **Codex Settings -> Usage Dashboard**
under the same timing rule. Percentages pass when equal after whole-number
rounding or at most one point apart; reset timestamps pass within 60 seconds.
Retain only a boolean per non-secret label.

After accounts exist, do not submit or manually scan mutable credential state
with Defender. Use the exact reviewed bootstrap paths and public hashes from
the manifest to run the fail-safe final-state verifier:

```powershell
$state = Join-Path $env:LOCALAPPDATA 'HowMuchAI'
$manifestPath = 'audit\final\runtime-manifest.json'
$manifestHashPath = 'audit\final\runtime-manifest.sha256'
if ($trustedManifestSha256 -notmatch '^[a-f0-9]{64}$' -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash -ne $trustedManifestSha256 -or
    (Get-Content -Raw -LiteralPath $manifestHashPath).Trim() -ne $trustedManifestSha256) {
    throw 'The runtime manifest no longer matches the in-memory trust anchor.'
}
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
function Get-ReviewedBootstrapHash([string]$suffix) {
    $entry = @($manifest.bootstrapFiles | Where-Object { ([string]$_.path).Replace('\','/') -eq $suffix })
    if ($entry.Count -ne 1 -or ([string]$entry[0].sha256) -notmatch '^[a-fA-F0-9]{64}$') {
        throw 'Reviewed bootstrap manifest is incomplete.'
    }
    return [string]$entry[0].sha256
}
$verifierHash = Get-ReviewedBootstrapHash 'scripts/windows/verify-final-local-state.ps1'
$runtimeHash = Get-ReviewedBootstrapHash 'scripts/windows/SecureLocalRuntime.psm1'
$integrityHash = Get-ReviewedBootstrapHash 'scripts/windows/SecureLocalIntegrity.psm1'
$secretsHash = Get-ReviewedBootstrapHash 'scripts/windows/SecureLocalSecrets.psm1'
$runtimeModule = Join-Path $state 'bootstrap\SecureLocalRuntime.psm1'
$verifier = Join-Path $state 'bootstrap\verify-final-local-state.ps1'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $runtimeModule).Hash -ne $runtimeHash) {
    Stop-ScheduledTask -TaskName 'HowMuchAI-Window' -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName 'HowMuchAI-Service' -ErrorAction SilentlyContinue
    throw 'Runtime verifier integrity failed; service tasks were stopped.'
}
Import-Module $runtimeModule -Force -ErrorAction Stop
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $verifier).Hash -ne $verifierHash) {
    $null = Stop-HmaDedicatedEdgeProfile -StateRoot $state
    Stop-ScheduledTask -TaskName 'HowMuchAI-Window' -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName 'HowMuchAI-Service' -ErrorAction SilentlyContinue
    throw 'Final verifier integrity failed; local processes were stopped.'
}
$ps51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$stateSummaryJson = & $ps51 -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $verifier -StateRoot $state -ExpectedRuntimeHash $runtimeHash -ExpectedIntegrityHash $integrityHash -ExpectedSecretsHash $secretsHash
if ($LASTEXITCODE -ne 0) { throw 'Fail-safe state verification failed; service remains stopped.' }
$stateSummary = $stateSummaryJson | ConvertFrom-Json
$stateSummary | ConvertTo-Json -Compress | Set-Content -Encoding utf8 'audit\final\state-summary.json'

node scripts/audit/safe-secret-scan.mjs --json audit/final/state-secret-scan.json --root (Join-Path $state 'install.json') --root (Join-Path $state 'integrity.json') --root (Join-Path $state 'secrets.dpapi') --root (Join-Path $state 'vault')
if ($LASTEXITCODE -ne 0) { throw 'State secret scan found a forbidden plaintext pattern; service remains stopped.' }
```

The verifier must leave both tasks stopped even on failure and emit only
sanitized booleans and counts. Re-run `run-sanitized-validation.mjs`, Semgrep,
and Defender on only the reviewed repository and immutable installed
runtime/bootstrap while the tasks remain stopped. Start
`HowMuchAI-Service` and `HowMuchAI-Window` again only after every stopped-state
gate passes. Any live-verification failure must close the exact dedicated Edge
profile and leave both tasks stopped.

The safe format/exact-value scans are supporting evidence. They are not a
mathematical proof that every unknown OAuth byte is absent.

## Recovery

Stop `HowMuchAI-Window` and `HowMuchAI-Service`, wait for the dedicated Edge
processes and the exact loopback listener to exit, and then back up the whole
`%LOCALAPPDATA%\HowMuchAI` directory as one unit. Do not copy only
`secrets.dpapi` or only `vault`.

The destination must be local, not cloud-synced, and protected for only the
same current Windows SID and `SYSTEM`. Do not place the backup in OneDrive, a
shared folder, email, chat, source control, or an automated backup system that
can upload samples or content without a separate review.

Restore only while both tasks are stopped. Restore the whole state directory,
normalize its protected ACL recursively, reject every reparse point, verify
the installed manifest and bootstrap hashes with
`Assert-HmaStartupIntegrity`, and verify the tasks again before starting the
service. The DPAPI blob can be decrypted only by the same Windows user profile
on the same Windows installation. A copied state directory is not a portable
credential recovery mechanism.

## Updates

Treat every update as a new installation candidate:

1. Clone the new revision into a separate directory.
2. Pin and record the new upstream and local hardening commits.
3. Review the full diff, dependency lifecycle scripts, realized dependency
   tree, direct-network surfaces, authentication boundaries, launchers, and
   vault behavior.
4. Re-run all Task 9 source, dependency, static-analysis, secret-scan, build,
   manifest, and runtime-immutability gates.
5. Re-run Defender before any credential state is introduced into the new
   runtime.
6. Stop the existing tasks, install the newly reviewed manifest, and repeat
   every Task 10 and Task 12 boundary check before reconnecting or resuming
   normal operation.

Never run `git pull`, an automatic updater, `npm update`, or an unreviewed
installer against the running installation. A changed provider endpoint or
browser callback format requires a new review; it is not a reason to broaden
the four-origin Fetch policy or extension permissions in place.

## Removal

First hash-verify the installed runtime/integrity modules and require every
existing named task to pass `Test-HmaRegisteredTaskPlan` for this exact state
root. If either ownership check fails, do not run the block below. After both
checks pass, stop and unregister only the two exact task names:

```powershell
Stop-ScheduledTask -TaskName 'HowMuchAI-Window' -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName 'HowMuchAI-Service' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'HowMuchAI-Window' -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'HowMuchAI-Service' -Confirm:$false -ErrorAction SilentlyContinue
```

Confirm that no process using the exact dedicated Edge profile remains and
that port `37645` no longer has a listener. Preserve
`%LOCALAPPDATA%\HowMuchAI` by default: it contains the DPAPI bundle, encrypted
provider vault, recovery journal, and browser profile.

Deleting that directory intentionally destroys the installed runtime and the
local copies of saved credentials. Perform that separate destructive step only
after the user explicitly chooses credential destruction and confirms that no
recovery copy is needed. Do not unregister or overwrite any similarly named
task that fails the reviewed ownership check.

## Verification limitation

Starting, stopping, and reopening both registered tasks twice proves that Task
Scheduler executed the registered actions under the observed configuration.
It does not prove that the at-logon trigger will fire during a natural Windows
sign-in. This procedure deliberately does not force a reboot or sign-out.
