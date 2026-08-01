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
- accidentally starting the application without its authenticated session gate;
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
trusted manifest-generation pre-gate refuses a dirty source tree or the wrong
ancestry. The installer then authenticates and retains the manifest-bound files
and refuses a manifest mismatch, an added or missing installable file, or a
changed file hash or size.

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

## Visual dashboard and device notifications

The dashboard remains available independently of notification configuration.
It renders each provider-returned limit as a separate row. Claude responses can
include the five-hour row, the overall weekly row, connected-app usage, and
model-scoped weekly rows such as Opus or Sonnet. OpenAI rows appear only when
OpenAI returns them; a returned session row is labeled
**Codex · 5 saatlik limit**. This is not a claim that ChatGPT accounts have a
universal five-hour limit.

Each row treats the provider-native **used** percentage as primary. The visual
fill grows from 0% to 100% used. Remaining is secondary, and remaining alone
drives urgency badges/colors and the device-notification thresholds. Reset
countdown/exact time and freshness are displayed when available; stale/error
readings stay visibly marked.

Strict-local notifications are a separate on-device path. They use only the
fresh dashboard refresh stream, privacy-minimized local browser state, an
exclusive Web Lock, and the same-origin service worker. They require no new
environment variable and never import or call Convex, VAPID, Telegram,
webhook, or another hosted notification path. The hosted Convex scheduler and
its Web Push, Telegram, and webhook channels remain a distinct topology and
are absent from this installation.

Permission is requested only after an explicit press of the notification
permission button. Denied, unavailable, or revoked permission fails closed,
does not advance an undelivered event, and is surfaced without repeated
prompts. Automatic refresh must remain enabled for live alerts; manual refresh
uses the same detector. The first successful observation seeds state silently,
and stale or failed readings are suppressed. Each account and limit is tracked
independently at exactly 50%, 40%, 30%, 20%, 15%, 10%, 5%, and 0% remaining. A
confirmed later reset timestamp produces copy containing exactly
`limit sıfırlandı`; crossing several thresholds in one refresh emits only the
tightest newly crossed threshold.

This delivery path runs only while the reviewed local Edge app/browser process
is open or minimized. Closing it stops live device notifications. The two-task
autostart model opens the app again at the next sign-in; there is no background
notifier and no third scheduled task.

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

## Autostart and Start-menu launcher

The installer registers exactly two current-user Task Scheduler tasks:

- `HowMuchAI-Service` runs the hash-verified private
  `start-secure-local.ps1`.
- `HowMuchAI-Window` runs the hash-verified private
  `open-secure-local.ps1`.

There is no notification task or third scheduled task. `install.json` records
exactly ten bootstrap hashes: `start-secure-local.ps1`,
`open-secure-local.ps1`, `connect-claude-secure.ps1`,
`launch-secure-local.ps1`, `SecureLocalIntegrity.psm1`,
`SecureLocalRuntime.psm1`, `SecureLocalSecrets.psm1`,
`verify-final-local-state.ps1`, `oauth-handoff-extension/manifest.json`, and
`oauth-handoff-extension/callback.js`. Startup and final verification reject a
missing, extra, malformed, or mismatched bootstrap-hash entry.

Both tasks use Windows PowerShell 5.1, an interactive current-user principal,
and `Limited` run level. Their reviewed settings use a current-user logon
trigger, `IgnoreNew`, `StartWhenAvailable`, no execution time limit, and three
one-minute restart attempts. Task actions contain only fixed flags, protected
paths, and public hashes; they contain no secret name, secret value, bootstrap
ticket, provider identifier, or raw task XML.

The service launcher runs `Assert-HmaStartupIntegrity` before importing the
DPAPI module or decrypting `secrets.dpapi`. The Edge launcher repeats integrity
and exact listener-owner checks, then proves possession of the DPAPI-held
`AUTH_SECRET` with the bootstrap HMAC exchange. It never transmits
`APP_PASSWORD` or `AUTH_SECRET` to the service or browser.

The installer also creates the current user's
`Programs\How Much AI.lnk`. The shortcut targets the exact retained Windows
PowerShell 5.1 executable and runs the installed, hash-verified
`launch-secure-local.ps1` from the private bootstrap directory. Its fixed
arguments contain only the state root plus the public expected launcher and
integrity-module SHA-256 hashes. They contain no URL, password or secret name
or value, bootstrap ticket, account or provider identity, or credential.

Before starting anything, the Start-menu launcher verifies its own installed
hash, the integrity and runtime anchors, and both exact registered task plans.
If `HowMuchAI-Service` is `Ready`, it starts `HowMuchAI-Service` and then
`HowMuchAI-Window`. If the service is already `Running`, it starts only
`HowMuchAI-Window`. A missing, foreign, or mutated task, or any other service
state, starts neither task and reports only `Secure local launcher failed.`

The installer reopens the shortcut through the Windows Shell COM interface and
verifies every reviewed field, its private current-user/`SYSTEM` ACL, and its
ordinary non-reparse leaf and ancestors. An exact existing shortcut is accepted
idempotently. Any mismatch is refused: the installer does not overwrite,
repair, delete, or weaken an existing shortcut. New creation is candidate-first:
the installer performs the COM field round trip, ACL and reparse checks before
the atomic move, then verifies the destination again. Rollback removes it only
when the same shortcut identity was created by that installer run; a raced-in
or replaced file is preserved. The fail-safe final verifier repeats the exact
task and shortcut checks, rejects secret names or values in their arguments,
and is followed by the bounded installed-state secret scan.

## Browser bootstrap

`open-secure-local.ps1` requests a challenge and server proof from the already
verified service. Using separate domain-separated HMAC contexts, the launcher
verifies the server proof with the DPAPI-held `AUTH_SECRET`, then returns a
client proof. Only after that mutual proof succeeds does the service issue a
cryptographically random bootstrap ticket. Neither the password nor
`AUTH_SECRET` crosses the process boundary. The server retains only the
ticket's SHA-256, permits at most one live ticket, and makes it redeemable for
at most 20 seconds and one use.

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

Use Windows PowerShell 5.1 from a clean, separately cloned source tree. Start
the entire retained-anchor workflow in a new exact `-NoProfile` child first;
do not run the later blocks in the ambient/profile-loaded parent:

```powershell
$cleanPs51 = [IO.Path]::Combine(
    [Environment]::SystemDirectory,
    'WindowsPowerShell\v1.0\powershell.exe'
)
& $cleanPs51 -NoLogo -NoProfile -ExecutionPolicy Bypass
```

Run every remaining block in that child session. Node.js must be `22.18.0` or
newer. The reviewed machine uses Node.js `24.14.0`. Microsoft Edge, Task
Scheduler, and Microsoft Defender must be available.

First bind the exact signed toolchain. Keep this PowerShell session open; the
retained hashes below are trust anchors and must not be recomputed after a
failed check:

```powershell
$ps51 = [IO.Path]::Combine(
    [Environment]::SystemDirectory,
    'WindowsPowerShell\v1.0\powershell.exe'
)
$currentPowerShell = (Microsoft.PowerShell.Management\Get-Process -Id $PID).Path
if (-not [string]::Equals(
        $currentPowerShell,
        $ps51,
        [StringComparison]::OrdinalIgnoreCase
    ) -or
    $PSVersionTable.PSVersion.Major -ne 5) {
    throw 'The workflow is not running in the exact Windows PowerShell 5.1 child.'
}
$windowsIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$windowsPrincipal = New-Object Security.Principal.WindowsPrincipal($windowsIdentity)
if ($windowsPrincipal.IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator
    )) {
    throw 'The retained-anchor workflow must not run elevated.'
}
function Test-HmaToolchainEnvironmentName {
    param([string]$Name)

    if ([string]::IsNullOrEmpty($Name)) {
        return $false
    }
    foreach ($prefix in @('NODE_', 'NPM_CONFIG_', 'GIT_')) {
        if ($Name.StartsWith(
                $prefix,
                [StringComparison]::OrdinalIgnoreCase
            )) {
            return $true
        }
    }
    return $false
}
foreach ($environmentNameValue in @(
        [Environment]::GetEnvironmentVariables(
            [EnvironmentVariableTarget]::Process
        ).Keys
    )) {
    $environmentName = [string]$environmentNameValue
    if (Test-HmaToolchainEnvironmentName -Name $environmentName) {
        [Environment]::SetEnvironmentVariable(
            $environmentName,
            $null,
            [EnvironmentVariableTarget]::Process
        )
    }
}
foreach ($environmentNameValue in @(
        [Environment]::GetEnvironmentVariables(
            [EnvironmentVariableTarget]::Process
        ).Keys
    )) {
    if (Test-HmaToolchainEnvironmentName -Name ([string]$environmentNameValue)) {
        throw 'A toolchain-affecting environment variable remains.'
    }
}
$systemModuleRoot = [IO.Path]::Combine(
    [Environment]::SystemDirectory,
    'WindowsPowerShell\v1.0\Modules'
)
$env:PSModulePath = $systemModuleRoot
foreach ($moduleManifest in @(
        'CimCmdlets\CimCmdlets.psd1',
        'NetTCPIP\NetTCPIP.psd1',
        'ScheduledTasks\ScheduledTasks.psd1'
    )) {
    Microsoft.PowerShell.Core\Import-Module `
        -Name (Join-Path $systemModuleRoot $moduleManifest) `
        -Force `
        -ErrorAction Stop
}
$requiredCommandSources = [ordered]@{
    'Get-AuthenticodeSignature' = 'Microsoft.PowerShell.Security'
    'Get-FileHash' = 'Microsoft.PowerShell.Utility'
    'Get-Item' = 'Microsoft.PowerShell.Management'
    'Get-ChildItem' = 'Microsoft.PowerShell.Management'
    'Copy-Item' = 'Microsoft.PowerShell.Management'
    'Import-Module' = 'Microsoft.PowerShell.Core'
    'Get-CimInstance' = 'CimCmdlets'
    'Get-NetTCPConnection' = 'NetTCPIP'
    'Get-ScheduledTask' = 'ScheduledTasks'
    'Register-ScheduledTask' = 'ScheduledTasks'
    'Start-ScheduledTask' = 'ScheduledTasks'
}
foreach ($commandName in $requiredCommandSources.Keys) {
    $resolvedCommand = Microsoft.PowerShell.Core\Get-Command `
        -Name $commandName `
        -ErrorAction Stop
    if (-not [string]::Equals(
            [string]$resolvedCommand.Source,
            [string]$requiredCommandSources[$commandName],
            [StringComparison]::Ordinal
        )) {
        throw 'A security-critical PowerShell command is shadowed.'
    }
}
$systemDriveRoot = [IO.Path]::GetPathRoot([Environment]::SystemDirectory)
$node = [IO.Path]::Combine(
    $systemDriveRoot,
    'Program Files',
    'nodejs',
    'node.exe'
)
$git = [IO.Path]::Combine(
    $systemDriveRoot,
    'Program Files',
    'Git',
    'mingw64',
    'bin',
    'git.exe'
)
$defenderRegistryKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(
    'SOFTWARE\Microsoft\Windows Defender',
    $false
)
if ($null -eq $defenderRegistryKey) {
    throw 'The installed Microsoft Defender platform is unavailable.'
}
try {
    $defenderInstallLocation = [string]$defenderRegistryKey.GetValue(
        'InstallLocation',
        $null,
        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    )
} finally {
    $defenderRegistryKey.Dispose()
}
if ([string]::IsNullOrWhiteSpace($defenderInstallLocation)) {
    throw 'The installed Microsoft Defender platform is unavailable.'
}
$defenderPlatformRoot = [IO.Path]::GetFullPath(
    [IO.Path]::Combine(
        [Environment]::GetFolderPath(
            [Environment+SpecialFolder]::CommonApplicationData
        ),
        'Microsoft',
        'Windows Defender',
        'Platform'
    )
)
$defenderPlatformDirectory = [IO.Path]::GetFullPath(
    $defenderInstallLocation.TrimEnd([char[]]@('\', '/'))
)
$defenderPlatformParent = [IO.Directory]::GetParent(
    $defenderPlatformDirectory
)
if ($null -eq $defenderPlatformParent -or
    -not [string]::Equals(
        $defenderPlatformParent.FullName,
        $defenderPlatformRoot,
        [StringComparison]::OrdinalIgnoreCase
    )) {
    throw 'The installed Microsoft Defender platform path is invalid.'
}
$mpCmdRun = [IO.Path]::Combine(
    $defenderPlatformDirectory,
    'MpCmdRun.exe'
)
$ps51Signature = Get-AuthenticodeSignature -LiteralPath $ps51
$nodeSignature = Get-AuthenticodeSignature -LiteralPath $node
$gitSignature = Get-AuthenticodeSignature -LiteralPath $git
$mpCmdRunSignature = Get-AuthenticodeSignature -LiteralPath $mpCmdRun
if ($ps51Signature.Status -ne 'Valid' -or
    $ps51Signature.SignerCertificate.Subject -notmatch '(?:^|, )O=Microsoft Corporation(?:,|$)' -or
    $nodeSignature.Status -ne 'Valid' -or
    $nodeSignature.SignerCertificate.Subject -notmatch '(?:^|, )O=OpenJS Foundation(?:,|$)' -or
    $gitSignature.Status -ne 'Valid' -or
    $gitSignature.SignerCertificate.Subject -notmatch '(?:^|, )O=Johannes Schindelin(?:,|$)' -or
    $mpCmdRunSignature.Status -ne 'Valid' -or
    $mpCmdRunSignature.SignerCertificate.Subject -notmatch '(?:^|, )O=Microsoft Corporation(?:,|$)') {
    throw 'The reviewed Node, Git, or Microsoft Defender signature is unavailable.'
}
$trustedPs51Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $ps51).Hash.ToLowerInvariant()
$trustedNodeSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $node).Hash.ToLowerInvariant()
$trustedGitSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $git).Hash.ToLowerInvariant()
$trustedMpCmdRunSha256 = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $mpCmdRun
).Hash.ToLowerInvariant()
$nodeDirectory = [IO.Path]::GetDirectoryName($node)
$npm = Join-Path $nodeDirectory 'npm.cmd'
$npmCli = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
$npmPrefix = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-prefix.js'
foreach ($toolDirectoryPath in @(
        $defenderPlatformRoot,
        $defenderPlatformDirectory
    )) {
    $directoryItem = Get-Item `
        -LiteralPath $toolDirectoryPath `
        -Force `
        -ErrorAction Stop
    if (-not $directoryItem.PSIsContainer -or
        ($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The reviewed toolchain contains a non-ordinary directory.'
    }
}
foreach ($toolPath in @(
        $ps51,
        $node,
        $git,
        $npm,
        $npmCli,
        $npmPrefix,
        $mpCmdRun
    )) {
    $item = Get-Item -LiteralPath $toolPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The reviewed toolchain contains a non-ordinary path.'
    }
}
$trustedNpmHashes = [ordered]@{
    command = (Get-FileHash -Algorithm SHA256 -LiteralPath $npm).Hash.ToLowerInvariant()
    cli = (Get-FileHash -Algorithm SHA256 -LiteralPath $npmCli).Hash.ToLowerInvariant()
    prefix = (Get-FileHash -Algorithm SHA256 -LiteralPath $npmPrefix).Hash.ToLowerInvariant()
}
$packageJsonPath = (Resolve-Path 'package.json').Path
$packageLockPath = (Resolve-Path 'package-lock.json').Path
$trustedPackageJsonSha256 = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $packageJsonPath
).Hash.ToLowerInvariant()
$trustedPackageLockSha256 = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $packageLockPath
).Hash.ToLowerInvariant()
function Assert-HmaTrustedNpmToolchain {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $node).Hash.ToLowerInvariant() -cne
            $trustedNodeSha256 -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $npm).Hash.ToLowerInvariant() -cne
            $trustedNpmHashes.command -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $npmCli).Hash.ToLowerInvariant() -cne
            $trustedNpmHashes.cli -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $npmPrefix).Hash.ToLowerInvariant() -cne
            $trustedNpmHashes.prefix) {
        throw 'The retained Node/npm toolchain changed.'
    }
}
[Environment]::SetEnvironmentVariable(
    'GIT_CONFIG_NOSYSTEM',
    '1',
    [EnvironmentVariableTarget]::Process
)
[Environment]::SetEnvironmentVariable(
    'GIT_CONFIG_SYSTEM',
    'NUL',
    [EnvironmentVariableTarget]::Process
)
[Environment]::SetEnvironmentVariable(
    'GIT_CONFIG_GLOBAL',
    'NUL',
    [EnvironmentVariableTarget]::Process
)
$gitStatusLines = @(
    & $git `
        --no-pager `
        -c core.fsmonitor=false `
        -c core.untrackedCache=false `
        status `
        --porcelain=v1 `
        --untracked-files=all `
        --ignore-submodules=none
)
$gitStatusExitCode = $LASTEXITCODE
if ($gitStatusExitCode -ne 0 -or $gitStatusLines.Count -ne 0) {
    throw 'The reviewed source tree is not clean.'
}
```

Establish the trusted launcher below before parsing the npm lockfile or
executing `ci`, `ls`, `audit`, or the CycloneDX `sbom` operation. Windows PowerShell 5.1 cannot safely
materialize every valid npm lockfile as a case-insensitive object, so the
reviewed Node entrypoint creates the lifecycle-script inventory instead.

Run the repository validation through the reviewed minimal-environment
launcher:

```powershell
$trustedAuditLauncher = (Resolve-Path 'scripts\audit\invoke-trusted-node.ps1').Path
$trustedAuditLauncherSha256 = (
    Get-FileHash -Algorithm SHA256 -LiteralPath $trustedAuditLauncher
).Hash.ToLowerInvariant()
$trustedAuditScripts = @{}
foreach ($name in @(
        'run-sanitized-validation.mjs',
        'create-runtime-manifest.mjs',
        'safe-secret-scan.mjs',
        'prove-runtime-immutability.mjs'
    )) {
    $scriptPath = (Resolve-Path (Join-Path 'scripts\audit' $name)).Path
    $trustedAuditScripts[$name] = [pscustomobject]@{
        path = $scriptPath
        sha256 = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $scriptPath
        ).Hash.ToLowerInvariant()
    }
}
function Invoke-HmaTrustedAudit {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet(
            'run-sanitized-validation.mjs',
            'create-runtime-manifest.mjs',
            'safe-secret-scan.mjs',
            'prove-runtime-immutability.mjs'
        )]
        [string]$Name,
        [string[]]$Arguments = @()
    )

    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $node).Hash.ToLowerInvariant() -cne
            $trustedNodeSha256) {
        throw 'A retained audit trust anchor changed.'
    }
    $entry = $trustedAuditScripts[$Name]
    if ($null -eq $entry -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.path).Hash.ToLowerInvariant() -cne
            $entry.sha256) {
        throw 'A retained audit script changed.'
    }
    $argumentBytes = [Text.Encoding]::UTF8.GetBytes(
        (ConvertTo-Json -Compress -Depth 3 -InputObject ([ordered]@{
                    version = 1
                    arguments = @($Arguments)
                }))
    )
    try {
        $encodedArguments = [Convert]::ToBase64String($argumentBytes)
        $encodedArguments = $encodedArguments.TrimEnd('=').Replace('+', '-').Replace('/', '_')

        $launcherStream = [IO.File]::Open(
            $trustedAuditLauncher,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read
        )
        $launcherMemory = New-Object IO.MemoryStream
        $launcherBytes = $null
        try {
            $launcherStream.CopyTo($launcherMemory)
            $launcherBytes = $launcherMemory.ToArray()
            $sha256 = [Security.Cryptography.SHA256]::Create()
            try {
                $launcherSha256 = [BitConverter]::ToString(
                    $sha256.ComputeHash($launcherBytes)
                )
                $launcherSha256 = $launcherSha256.Replace('-', '').ToLowerInvariant()
            } finally {
                $sha256.Dispose()
            }
            if ($launcherSha256 -cne $trustedAuditLauncherSha256) {
                throw 'A retained audit trust anchor changed.'
            }
            $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
            $launcherScript = [ScriptBlock]::Create(
                $strictUtf8.GetString($launcherBytes)
            )
            $result = & $launcherScript `
                -NodePath $node `
                -ExpectedNodeSha256 $trustedNodeSha256 `
                -ScriptPath $entry.path `
                -ExpectedScriptSha256 $entry.sha256 `
                -EncodedScriptArguments $encodedArguments `
                -PassThruResult
        } finally {
            if ($null -ne $launcherBytes) {
                [Array]::Clear($launcherBytes, 0, $launcherBytes.Length)
            }
            $launcherScript = $null
            $launcherMemory.Dispose()
            $launcherStream.Dispose()
        }
        if ($null -eq $result -or $result -is [Array]) {
            throw "Trusted audit failed: $Name"
        }
        $resultProperties = @(
            $result.PSObject.Properties |
                ForEach-Object { $_.Name } |
                Sort-Object
        )
        if ([bool](Compare-Object `
                -ReferenceObject @(
                    'exitCode',
                    'ok',
                    'stderr',
                    'stdout',
                    'version'
                ) `
                -DifferenceObject $resultProperties `
                -CaseSensitive) -or
            $result.version -isnot [int] -or
            [int]$result.version -ne 1 -or
            $result.ok -isnot [bool] -or
            $result.exitCode -isnot [int] -or
            $result.stdout -isnot [string] -or
            $result.stderr -isnot [string]) {
            throw "Trusted audit failed: $Name"
        }
        if (-not [bool]$result.ok -or [int]$result.exitCode -ne 0) {
            throw "Trusted audit failed: $Name"
        }
        if ([string]$result.stderr -ne '') {
            [Console]::Error.Write([string]$result.stderr)
        }
        Write-Output -NoEnumerate ([string]$result.stdout)
    } finally {
        [Array]::Clear($argumentBytes, 0, $argumentBytes.Length)
        $encodedArguments = $null
    }
}

New-Item -ItemType Directory -Force 'audit\final' | Out-Null
$inventoryLines = @(
    Invoke-HmaTrustedAudit `
        -Name 'run-sanitized-validation.mjs' `
        -Arguments @(
            '--inventory-install-scripts', $packageLockPath,
            '--expected-lockfile-sha256', $trustedPackageLockSha256
        )
)
if ($inventoryLines.Count -ne 1 -or
    $inventoryLines[0] -isnot [string] -or
    $inventoryLines[0].Length -gt 16777216) {
    throw 'The install-script inventory is invalid.'
}
try {
    $inventory = ConvertFrom-Json `
        -InputObject $inventoryLines[0] `
        -ErrorAction Stop
    $inventoryProperties = @(
        $inventory.PSObject.Properties |
            ForEach-Object { $_.Name } |
            Sort-Object
    )
    if ([bool](Compare-Object `
            -ReferenceObject @('installScripts', 'ok') `
            -DifferenceObject $inventoryProperties `
            -CaseSensitive) -or
        $inventory.ok -isnot [bool] -or
        -not [bool]$inventory.ok -or
        @($inventory.installScripts).Count -gt 10000) {
        throw 'The install-script inventory is invalid.'
    }
    foreach ($installScript in @($inventory.installScripts)) {
        $properties = @(
            $installScript.PSObject.Properties |
                ForEach-Object { $_.Name } |
                Sort-Object
        )
        if ([bool](Compare-Object `
                -ReferenceObject @('name', 'path', 'version') `
                -DifferenceObject $properties `
                -CaseSensitive) -or
            $installScript.name -isnot [string] -or
            $installScript.path -isnot [string] -or
            $installScript.version -isnot [string]) {
            throw 'The install-script inventory is invalid.'
        }
    }
    [IO.File]::WriteAllText(
        (Join-Path (Resolve-Path 'audit\final').Path 'npm-install-scripts.json'),
        $inventoryLines[0],
        (New-Object Text.UTF8Encoding($false))
    )
} catch {
    throw 'The install-script inventory is invalid.'
}

function Get-HmaRetainedNpmTreeSha256 {
    $measureLines = @(
        Invoke-HmaTrustedAudit `
            -Name 'run-sanitized-validation.mjs' `
            -Arguments @('--measure-npm-tree', $npm)
    )
    if ($measureLines.Count -ne 1 -or
        $measureLines[0] -isnot [string] -or
        $measureLines[0].Length -gt 1024) {
        throw 'The retained npm tree measurement is invalid.'
    }
    try {
        $measurement = ConvertFrom-Json `
            -InputObject $measureLines[0] `
            -ErrorAction Stop
        $measurementProperties = @(
            $measurement.PSObject.Properties |
                ForEach-Object { $_.Name } |
                Sort-Object
        )
        if ([bool](Compare-Object `
                -ReferenceObject @('npmTreeSha256', 'ok') `
                -DifferenceObject $measurementProperties `
                -CaseSensitive) -or
            $measurement.ok -isnot [bool] -or
            -not [bool]$measurement.ok -or
            $measurement.npmTreeSha256 -isnot [string] -or
            [string]$measurement.npmTreeSha256 -cnotmatch '^[a-f0-9]{64}$') {
            throw 'The retained npm tree measurement is invalid.'
        }
        return [string]$measurement.npmTreeSha256
    } catch {
        throw 'The retained npm tree measurement is invalid.'
    }
}

$trustedNpmTreeSha256 = Get-HmaRetainedNpmTreeSha256
function Invoke-HmaPinnedNpmCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('ci', 'ls', 'audit', 'sbom')]
        [string]$Operation
    )

    $operationLines = @(
        Invoke-HmaTrustedAudit `
            -Name 'run-sanitized-validation.mjs' `
            -Arguments @(
                '--run-pinned-npm', $Operation,
                '--npm', $npm,
                '--expected-npm-cli-sha256', $trustedNpmHashes.cli,
                '--expected-npm-tree-sha256', $trustedNpmTreeSha256,
                '--package-json', $packageJsonPath,
                '--expected-package-json-sha256', $trustedPackageJsonSha256,
                '--package-lock', $packageLockPath,
                '--expected-lockfile-sha256', $trustedPackageLockSha256
            )
    )
    if ($operationLines.Count -ne 1 -or
        $operationLines[0] -isnot [string] -or
        $operationLines[0].Length -gt 16777216) {
        throw "Pinned npm operation failed: $Operation"
    }
    try {
        $operationResult = ConvertFrom-Json `
            -InputObject $operationLines[0] `
            -ErrorAction Stop
        $operationProperties = @(
            $operationResult.PSObject.Properties |
                ForEach-Object { $_.Name } |
                Sort-Object
        )
        if ([bool](Compare-Object `
                -ReferenceObject @('ok', 'operation', 'output') `
                -DifferenceObject $operationProperties `
                -CaseSensitive) -or
            $operationResult.ok -isnot [bool] -or
            -not [bool]$operationResult.ok -or
            $operationResult.operation -isnot [string] -or
            [string]$operationResult.operation -cne $Operation -or
            $operationResult.output -isnot [string]) {
            throw "Pinned npm operation failed: $Operation"
        }
        $operationOutput = [string]$operationResult.output
    } catch {
        throw "Pinned npm operation failed: $Operation"
    }
    switch ($Operation) {
        'ci' {
            [Console]::Out.Write($operationOutput)
        }
        'ls' {
            [IO.File]::WriteAllText(
                (Join-Path (Resolve-Path 'audit\final').Path 'npm-ls.txt'),
                $operationOutput,
                (New-Object Text.UTF8Encoding($false))
            )
        }
        'audit' {
            [IO.File]::WriteAllText(
                (Join-Path (Resolve-Path 'audit\final').Path 'npm-audit.json'),
                $operationOutput,
                (New-Object Text.UTF8Encoding($false))
            )
        }
        'sbom' {
            [IO.File]::WriteAllText(
                (Join-Path (Resolve-Path 'audit\final').Path 'npm-sbom.cdx.json'),
                $operationOutput,
                (New-Object Text.UTF8Encoding($false))
            )
        }
    }
}

Invoke-HmaPinnedNpmCommand -Operation 'ci'
Invoke-HmaPinnedNpmCommand -Operation 'ls'
Invoke-HmaPinnedNpmCommand -Operation 'audit'
Invoke-HmaPinnedNpmCommand -Operation 'sbom'
& $git `
    --no-pager `
    -c core.fsmonitor=false `
    -c core.untrackedCache=false `
    diff `
    --no-ext-diff `
    --no-textconv `
    --exit-code `
    --quiet `
    -- `
    package.json `
    package-lock.json
$gitDiffExitCode = $LASTEXITCODE
if ($gitDiffExitCode -ne 0) { throw 'Lockfile comparison failed.' }

Invoke-HmaTrustedAudit `
    -Name 'run-sanitized-validation.mjs' `
    -Arguments @(
        '--npm', $npm,
        '--expected-npm-cli-sha256', $trustedNpmHashes.cli,
        '--expected-npm-tree-sha256', $trustedNpmTreeSha256,
        '--package-json', $packageJsonPath,
        '--expected-package-json-sha256', $trustedPackageJsonSha256
    )
```

Review the realized dependency tree with the supply-chain risk audit. Run the
comprehensive local Semgrep scan and the insecure-defaults review described by
the security gate. Do not continue with an unexplained install script,
maintainer-takeover signal, unpinned executable download, high-risk package, or
unresolved production high/critical finding.

After the audit tooling is committed and the final source/static gate passes,
create and scan the installable manifest and prove that two production starts
do not mutate the staged runtime:

```powershell
$upstreamBase = '1238189b7017601d21e3579d041480ce3773e191'
$finalCommit = (& $git rev-parse --verify 'HEAD^{commit}').Trim()
if ($LASTEXITCODE -ne 0 -or $finalCommit -cnotmatch '^[a-f0-9]{40}$') {
    throw 'Final commit resolution failed.'
}
[IO.File]::WriteAllText(
    (Join-Path (Resolve-Path 'audit\final').Path 'final-commit.txt'),
    $finalCommit,
    (New-Object Text.UTF8Encoding($false))
)
$manifestResultLines = @(
    Invoke-HmaTrustedAudit `
        -Name 'create-runtime-manifest.mjs' `
        -Arguments @(
            '--root', (Resolve-Path '.').Path,
            '--commit', $finalCommit,
            '--node', $node,
            '--git', $git,
            '--expected-git-sha256', $trustedGitSha256,
            '--upstream-base', $upstreamBase,
            '--output', (Join-Path (Resolve-Path 'audit\final').Path 'runtime-manifest.json'),
            '--sha256-output', (Join-Path (Resolve-Path 'audit\final').Path 'runtime-manifest.sha256')
        )
)
if ($manifestResultLines.Count -ne 1 -or
    $manifestResultLines[0] -isnot [string] -or
    $manifestResultLines[0].Length -gt 1024) {
    throw 'Runtime manifest result is invalid.'
}
try {
    $manifestResult = ConvertFrom-Json `
        -InputObject $manifestResultLines[0] `
        -ErrorAction Stop
    $manifestResultProperties = @(
        $manifestResult.PSObject.Properties |
            ForEach-Object { $_.Name } |
            Sort-Object
    )
    if ([bool](Compare-Object `
            -ReferenceObject @(
                'bootstrapFiles',
                'manifestSha256',
                'ok',
                'runtimeFiles'
            ) `
            -DifferenceObject $manifestResultProperties `
            -CaseSensitive) -or
        $manifestResult.ok -isnot [bool] -or
        -not [bool]$manifestResult.ok -or
        $manifestResult.runtimeFiles -isnot [int] -or
        [int]$manifestResult.runtimeFiles -le 0 -or
        $manifestResult.bootstrapFiles -isnot [int] -or
        [int]$manifestResult.bootstrapFiles -le 0 -or
        $manifestResult.manifestSha256 -isnot [string] -or
        [string]$manifestResult.manifestSha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Runtime manifest result is invalid.'
    }
    $trustedManifestSha256 = [string]$manifestResult.manifestSha256
} catch {
    throw 'Runtime manifest result is invalid.'
}
$publishedManifestSha256 = [IO.File]::ReadAllText(
    (Resolve-Path 'audit\final\runtime-manifest.sha256').Path
)
if ((Get-FileHash -Algorithm SHA256 -LiteralPath 'audit\final\runtime-manifest.json').Hash.ToLowerInvariant() -cne
        $trustedManifestSha256 -or
    $publishedManifestSha256 -cne $trustedManifestSha256) {
    throw 'Runtime manifest trust anchor mismatch.'
}
Invoke-HmaTrustedAudit `
    -Name 'safe-secret-scan.mjs' `
    -Arguments @(
        '--json', (Join-Path (Resolve-Path 'audit\final').Path 'secret-scan.json'),
        '--manifest', (Join-Path (Resolve-Path 'audit\final').Path 'runtime-manifest.json'),
        '--expected-manifest-sha256', $trustedManifestSha256
    )
Invoke-HmaTrustedAudit `
    -Name 'prove-runtime-immutability.mjs' `
    -Arguments @(
        '--root', (Resolve-Path '.').Path,
        '--manifest', (Join-Path (Resolve-Path 'audit\final').Path 'runtime-manifest.json'),
        '--expected-manifest-sha256', $trustedManifestSha256
    )
```

Keep this PowerShell session open through installation and final-state
verification. Do not reconstruct `$trustedManifestSha256` from the adjacent
hash file later.

Use the exact Microsoft-signed Defender platform executable and retained hash
bound above. Keep that executable read-locked through the scan, verify its
locked bytes before and after execution, and scan the reviewed source and
production build without remediation:

```powershell
function Get-HmaLockedFileSha256 {
    param([Parameter(Mandatory)][IO.FileStream]$Stream)

    $position = $Stream.Position
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $Stream.Position = 0
        return ([BitConverter]::ToString(
                $sha256.ComputeHash($Stream)
            )).Replace('-', '').ToLowerInvariant()
    } finally {
        $Stream.Position = $position
        $sha256.Dispose()
    }
}

$defenderScanRoot = (Resolve-Path '.').Path
$defenderManifestPath = (
    Resolve-Path 'audit\final\runtime-manifest.json'
).Path
$defenderManifestStream = $null
$defenderSourceLeases = New-Object 'Collections.Generic.List[object]'
$strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
try {
    $defenderManifestStream = [IO.File]::Open(
        $defenderManifestPath,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )
    if ((Get-HmaLockedFileSha256 -Stream $defenderManifestStream) -cne
        $trustedManifestSha256) {
        throw 'The Defender manifest lease is invalid.'
    }
    $defenderManifestBytes = [IO.File]::ReadAllBytes(
        $defenderManifestPath
    )
    try {
        $defenderManifest = ConvertFrom-Json `
            -InputObject $strictUtf8.GetString($defenderManifestBytes) `
            -ErrorAction Stop
    } finally {
        [Array]::Clear(
            $defenderManifestBytes,
            0,
            $defenderManifestBytes.Length
        )
    }
    $installerLeasePath = 'scripts/windows/install-secure-local.ps1'
    $installerLeaseItem = Get-Item `
        -LiteralPath $installerLeasePath `
        -Force `
        -ErrorAction Stop
    $defenderEntries = @($defenderManifest.runtimeFiles) +
        @($defenderManifest.bootstrapFiles) +
        @([pscustomobject]@{
                path = $installerLeasePath
                size = [long]$installerLeaseItem.Length
                sha256 = [string]$defenderManifest.installerSha256
            })
    $defenderSeenPaths = @{}
    $defenderRootPrefix = $defenderScanRoot.TrimEnd('\') + '\'
    foreach ($entry in $defenderEntries) {
        $relativePath = [string]$entry.path
        if ($relativePath -cnotmatch '^[^\\/:]+(?:/[^\\/:]+)*$' -or
            $relativePath.Contains('//') -or
            @($relativePath.Split('/') | Where-Object {
                    $_ -ceq '.' -or $_ -ceq '..' -or
                    $_.EndsWith('.') -or $_.EndsWith(' ')
                }).Count -ne 0 -or
            [string]$entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            [long]$entry.size -lt 0) {
            throw 'A Defender manifest entry is invalid.'
        }
        $foldedPath = $relativePath.ToLowerInvariant()
        if ($defenderSeenPaths.ContainsKey($foldedPath)) {
            throw 'A Defender manifest entry is duplicated.'
        }
        $defenderSeenPaths[$foldedPath] = $true
        $absolutePath = [IO.Path]::GetFullPath(
            [IO.Path]::Combine(
                $defenderScanRoot,
                $relativePath.Replace('/', '\')
            )
        )
        if (-not $absolutePath.StartsWith(
                $defenderRootPrefix,
                [StringComparison]::OrdinalIgnoreCase
            )) {
            throw 'A Defender manifest path escaped the source root.'
        }
        $item = Get-Item -LiteralPath $absolutePath -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'A Defender manifest file is not ordinary.'
        }
        $stream = [IO.File]::Open(
            $absolutePath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read
        )
        [void]$defenderSourceLeases.Add([pscustomobject]@{
                Stream = $stream
                Size = [long]$entry.size
                Sha256 = [string]$entry.sha256
            })
        if ($stream.Length -ne [long]$entry.size -or
            (Get-HmaLockedFileSha256 -Stream $stream) -cne
                [string]$entry.sha256) {
            throw 'A Defender manifest file changed.'
        }
    }
} catch {
    foreach ($lease in $defenderSourceLeases) {
        $lease.Stream.Dispose()
    }
    if ($null -ne $defenderManifestStream) {
        $defenderManifestStream.Dispose()
    }
    throw
}

$mpCmdRunStream = $null
$mpCmdRunProcess = $null
$defenderExitCode = -1
try {
    $mpCmdRunStream = [IO.File]::Open(
        $mpCmdRun,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )
    if ($mpCmdRunStream.Length -le 0 -or
        $mpCmdRunStream.Length -gt 134217728) {
        throw 'The retained Microsoft Defender executable is invalid.'
    }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $mpCmdRunStream.Position = 0
        $mpCmdRunHashBefore = [BitConverter]::ToString(
            $sha256.ComputeHash($mpCmdRunStream)
        )
        $mpCmdRunHashBefore = $mpCmdRunHashBefore.Replace(
            '-',
            ''
        ).ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
    if ($mpCmdRunHashBefore -cne $trustedMpCmdRunSha256) {
        throw 'The retained Microsoft Defender executable changed.'
    }

    if ($defenderScanRoot.IndexOf('"') -ge 0 -or
        $defenderScanRoot.EndsWith('\')) {
        throw 'The Defender scan root is invalid.'
    }
    foreach ($character in $defenderScanRoot.ToCharArray()) {
        if ([char]::IsControl($character)) {
            throw 'The Defender scan root is invalid.'
        }
    }
    $mpCmdRunStartInfo = New-Object Diagnostics.ProcessStartInfo
    $mpCmdRunStartInfo.FileName = $mpCmdRun
    $mpCmdRunStartInfo.Arguments = (
        '-Scan -ScanType 3 -File "' +
        $defenderScanRoot +
        '" -DisableRemediation'
    )
    $mpCmdRunStartInfo.WorkingDirectory = $defenderScanRoot
    $mpCmdRunStartInfo.UseShellExecute = $false
    $mpCmdRunStartInfo.CreateNoWindow = $true
    $mpCmdRunProcess = New-Object Diagnostics.Process
    $mpCmdRunProcess.StartInfo = $mpCmdRunStartInfo
    if (-not $mpCmdRunProcess.Start()) {
        throw 'Microsoft Defender did not start.'
    }
    $mpCmdRunProcess.WaitForExit()
    $defenderExitCode = [int]$mpCmdRunProcess.ExitCode

    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $mpCmdRunStream.Position = 0
        $mpCmdRunHashAfter = [BitConverter]::ToString(
            $sha256.ComputeHash($mpCmdRunStream)
        )
        $mpCmdRunHashAfter = $mpCmdRunHashAfter.Replace(
            '-',
            ''
        ).ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
    if ($mpCmdRunHashAfter -cne $trustedMpCmdRunSha256) {
        throw 'The retained Microsoft Defender executable changed.'
    }
    if ((Get-HmaLockedFileSha256 -Stream $defenderManifestStream) -cne
        $trustedManifestSha256) {
        throw 'The Defender manifest lease changed during the scan.'
    }
    foreach ($lease in $defenderSourceLeases) {
        if ($lease.Stream.Length -ne $lease.Size -or
            (Get-HmaLockedFileSha256 -Stream $lease.Stream) -cne
                $lease.Sha256) {
            throw 'A manifest-bound Defender source file changed during the scan.'
        }
    }
} finally {
    if ($null -ne $mpCmdRunProcess) {
        $mpCmdRunProcess.Dispose()
    }
    if ($null -ne $mpCmdRunStream) {
        $mpCmdRunStream.Dispose()
    }
    foreach ($lease in $defenderSourceLeases) {
        $lease.Stream.Dispose()
    }
    if ($null -ne $defenderManifestStream) {
        $defenderManifestStream.Dispose()
    }
}
[IO.File]::WriteAllText(
    (Join-Path (Resolve-Path 'audit\final').Path 'defender.txt'),
    ('DefenderExitCode=' + [string]$defenderExitCode),
    [Text.Encoding]::ASCII
)
if ($defenderExitCode -ne 0) {
    throw 'Microsoft Defender did not return a clean scan result.'
}
```

The scan keeps the reviewed manifest and every manifest-bound source file open
with a retained read lease, then re-hashes the same handles before releasing
them. A concurrent replace, truncate, or write therefore fails closed instead
of letting Defender scan different bytes from the ones later installed.

Install only after every pre-credential gate is green:

```powershell
if ($trustedManifestSha256 -notmatch '^[a-f0-9]{64}$') { throw 'The manifest trust anchor is unavailable.' }
$sourceRoot = (Resolve-Path '.').Path
$manifestPath = (Resolve-Path 'audit\final\runtime-manifest.json').Path
$manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $manifestHash = [BitConverter]::ToString(
            $sha256.ComputeHash($manifestBytes)
        )
        $manifestHash = $manifestHash.Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
    if ($manifestHash -cne $trustedManifestSha256) {
        throw 'The reviewed manifest changed.'
    }
    $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
    $manifest = ConvertFrom-Json `
        -InputObject ($strictUtf8.GetString($manifestBytes)) `
        -ErrorAction Stop
    $manifestProperties = @(
        $manifest.PSObject.Properties |
            ForEach-Object { $_.Name } |
            Sort-Object
    )
    if ([bool](Compare-Object `
            -ReferenceObject @(
                'bootstrapFiles',
                'commit',
                'installerSha256',
                'nodeSha256',
                'runtimeFiles'
            ) `
            -DifferenceObject $manifestProperties `
            -CaseSensitive) -or
        $manifest.installerSha256 -isnot [string] -or
        [string]$manifest.installerSha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'The reviewed installer hash is invalid.'
    }
    $expectedInstallerSha256 = [string]$manifest.installerSha256
} finally {
    [Array]::Clear($manifestBytes, 0, $manifestBytes.Length)
}

$installerPath = (Resolve-Path 'scripts\windows\install-secure-local.ps1').Path
$installerStream = [IO.File]::Open(
    $installerPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
)
$installerMemory = New-Object IO.MemoryStream
$installerBytes = $null
try {
    if ($installerStream.Length -le 0 -or $installerStream.Length -gt 1048576) {
        throw 'The reviewed installer size is invalid.'
    }
    $installerStream.CopyTo($installerMemory)
    $installerBytes = $installerMemory.ToArray()
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $installerHash = [BitConverter]::ToString(
            $sha256.ComputeHash($installerBytes)
        )
        $installerHash = $installerHash.Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
    if ($installerHash -cne $expectedInstallerSha256) {
        throw 'The reviewed installer changed.'
    }
    $installerScript = [ScriptBlock]::Create(
        $strictUtf8.GetString($installerBytes)
    )
    & $installerScript `
        -SourceRoot $sourceRoot `
        -ExpectedManifestSha256 $trustedManifestSha256 `
        -NodePath $node `
        -ExpectedNodeSha256 $trustedNodeSha256 `
        -Ps51Path $ps51 `
        -ExpectedPs51Sha256 $trustedPs51Sha256
} finally {
    if ($null -ne $installerBytes) {
        [Array]::Clear($installerBytes, 0, $installerBytes.Length)
    }
    $installerMemory.Dispose()
    $installerStream.Dispose()
    $installerScript = $null
}
```

The idempotent installer creates and verifies
`%LOCALAPPDATA%\HowMuchAI`, copies only the manifest file sets, creates the
DPAPI bundle only when absent, writes only the non-secret `install.json`,
checks any existing listener and task ownership, and registers the two limited
tasks. It also creates the verified current-user **How Much AI** Start-menu
shortcut described above. It refuses to overwrite a mismatched runtime,
unrelated task or shortcut, invalid state root, or unverified DPAPI state.

Start the reviewed service, wait for its exact loopback listener and reviewed
Node executable, and then open the reviewed Edge window:

```powershell
Start-ScheduledTask -TaskName 'HowMuchAI-Service'
$deadline = [DateTime]::UtcNow.AddSeconds(60)
$dashboardReady = $false
do {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-WebRequest `
            -UseBasicParsing `
            -MaximumRedirection 0 `
            'http://127.0.0.1:37645/login' `
            -ErrorAction Stop
        $dashboardReady = ([int]$health.StatusCode -eq 200)
    } catch {
        $dashboardReady = $false
    }
} until ($dashboardReady -or [DateTime]::UtcNow -ge $deadline)
if (-not $dashboardReady) {
    throw 'The local dashboard did not return HTTP 200.'
}
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
Invoke-HmaTrustedAudit `
    -Name 'run-sanitized-validation.mjs' `
    -Arguments @(
        '--npm', $npm,
        '--expected-npm-cli-sha256', $trustedNpmHashes.cli,
        '--expected-npm-tree-sha256', $trustedNpmTreeSha256,
        '--package-json', $packageJsonPath,
        '--expected-package-json-sha256', $trustedPackageJsonSha256
    )
```

Re-run the safe scanner and immutable-runtime proof against the exact final
manifest:

```powershell
Invoke-HmaTrustedAudit `
    -Name 'safe-secret-scan.mjs' `
    -Arguments @(
        '--json', (Join-Path (Resolve-Path 'audit\final').Path 'secret-scan.json'),
        '--manifest', (Join-Path (Resolve-Path 'audit\final').Path 'runtime-manifest.json'),
        '--expected-manifest-sha256', $trustedManifestSha256
    )
Invoke-HmaTrustedAudit `
    -Name 'prove-runtime-immutability.mjs' `
    -Arguments @(
        '--root', (Resolve-Path '.').Path,
        '--manifest', (Join-Path (Resolve-Path 'audit\final').Path 'runtime-manifest.json'),
        '--expected-manifest-sha256', $trustedManifestSha256
    )
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

The trusted sanitized validation above includes the deterministic
partial-failure isolation, browser-boundary, OAuth handoff, and exact
five-minute cache-boundary tests. Do not rerun selected tests through an
ambient `node`; retain the corresponding passing test names from the trusted
validation output.

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
$finalPs51Stream = [IO.File]::Open(
    $ps51,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
)
try {
    if ((Get-HmaLockedFileSha256 -Stream $finalPs51Stream) -cne
        $trustedPs51Sha256) {
        throw 'The retained Windows PowerShell executable changed.'
    }
    $stateSummaryJson = & $ps51 -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $verifier -StateRoot $state -ExpectedRuntimeHash $runtimeHash -ExpectedIntegrityHash $integrityHash -ExpectedSecretsHash $secretsHash
    if ($LASTEXITCODE -ne 0) { throw 'Fail-safe state verification failed; service remains stopped.' }
    if ((Get-HmaLockedFileSha256 -Stream $finalPs51Stream) -cne
        $trustedPs51Sha256) {
        throw 'The retained Windows PowerShell executable changed.'
    }
} finally {
    $finalPs51Stream.Dispose()
}
$stateSummary = $stateSummaryJson | ConvertFrom-Json
$stateSummary | ConvertTo-Json -Compress | Set-Content -Encoding utf8 'audit\final\state-summary.json'

Invoke-HmaTrustedAudit `
    -Name 'safe-secret-scan.mjs' `
    -Arguments @(
        '--json', (Join-Path (Resolve-Path 'audit\final').Path 'state-secret-scan.json'),
        '--root', (Join-Path $state 'install.json'),
        '--root', (Join-Path $state 'integrity.json'),
        '--root', (Join-Path $state 'secrets.dpapi'),
        '--root', (Join-Path $state 'vault')
    )
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

First hash-verify the installed runtime/integrity modules, require every
existing named task to pass `Test-HmaRegisteredTaskPlan` for this exact state
root, and require the current-user `Programs\How Much AI.lnk` to match its exact
reviewed shortcut plan and private ACL. If any ownership check fails, do not
run the block below and do not delete the shortcut. After all checks pass, stop
and unregister only the two exact task names:

```powershell
Stop-ScheduledTask -TaskName 'HowMuchAI-Window' -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName 'HowMuchAI-Service' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'HowMuchAI-Window' -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'HowMuchAI-Service' -Confirm:$false -ErrorAction SilentlyContinue
```

Remove the verified current-user
`[Environment]::GetFolderPath('Programs')\How Much AI.lnk` as part of the same
uninstall. Do not remove, overwrite, or repair a mismatched shortcut, and do
not inspect or mutate another user's Programs directory.

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
