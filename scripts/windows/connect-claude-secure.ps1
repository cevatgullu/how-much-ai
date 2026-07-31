[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$StateRoot,
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$ExpectedConnectorHash
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-HmaOrdinalEqual {
    [CmdletBinding()]
    param(
        [AllowNull()][string]$Left,
        [AllowNull()][string]$Right,
        [switch]$IgnoreCase
    )

    $comparison = if ($IgnoreCase) {
        [StringComparison]::OrdinalIgnoreCase
    } else {
        [StringComparison]::Ordinal
    }
    return [string]::Equals($Left, $Right, $comparison)
}

function Assert-HmaExactProperties {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$InputObject,
        [Parameter(Mandatory)][string[]]$Expected
    )

    if ($null -eq $InputObject -or $InputObject -is [Collections.IDictionary]) {
        throw 'The object schema is invalid.'
    }
    $actual = @($InputObject.PSObject.Properties | ForEach-Object { $_.Name })
    if ([bool](Compare-Object `
            -ReferenceObject @($Expected | Sort-Object) `
            -DifferenceObject @($actual | Sort-Object) `
            -CaseSensitive)) {
        throw 'The object schema is invalid.'
    }
}

function Assert-HmaSafeAbsolutePathText {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value) -or
        $Value.IndexOfAny([char[]]@("'", '"')) -ge 0 -or
        -not [IO.Path]::IsPathRooted($Value)) {
        throw 'The path is invalid.'
    }
    foreach ($character in $Value.ToCharArray()) {
        if ([char]::IsControl($character)) {
            throw 'The path is invalid.'
        }
    }
}

function Get-HmaNonReparseExistingPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [switch]$Directory,
        [switch]$File
    )

    Assert-HmaSafeAbsolutePathText -Value $LiteralPath
    $fullPath = [IO.Path]::GetFullPath($LiteralPath)
    $rootPath = [IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrWhiteSpace($rootPath) -or
        $rootPath -notmatch '^[A-Za-z]:\\$') {
        throw 'The path is invalid.'
    }

    $segments = @(
        $fullPath.Substring($rootPath.Length).Split(
            [char[]]@(
                [IO.Path]::DirectorySeparatorChar,
                [IO.Path]::AltDirectorySeparatorChar
            ),
            [StringSplitOptions]::RemoveEmptyEntries
        )
    )
    $currentPath = $rootPath
    for ($index = -1; $index -lt $segments.Count; $index += 1) {
        if ($index -ge 0) {
            $currentPath = [IO.Path]::Combine(
                $currentPath,
                [string]$segments[$index]
            )
        }
        $item = Get-Item `
            -LiteralPath $currentPath `
            -Force `
            -ErrorAction Stop
        $isLeaf = $index -eq ($segments.Count - 1)
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            (-not $isLeaf -and -not $item.PSIsContainer) -or
            ($isLeaf -and $Directory -and -not $item.PSIsContainer) -or
            ($isLeaf -and $File -and $item.PSIsContainer) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([IO.Path]::GetFullPath([string]$item.FullName)) `
                -Right ([IO.Path]::GetFullPath($currentPath)) `
                -IgnoreCase)) {
            throw 'The path is invalid.'
        }
    }
    return $fullPath
}

function Get-HmaStrictUtf8Text {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [Parameter(Mandatory)][int]$MaximumBytes
    )

    $bytes = [IO.File]::ReadAllBytes($LiteralPath)
    try {
        if ($bytes.Length -le 0 -or $bytes.Length -gt $MaximumBytes) {
            throw 'The file is invalid.'
        }
        return (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes)
    } finally {
        if ($null -ne $bytes) {
            [Array]::Clear($bytes, 0, $bytes.Length)
        }
    }
}

function Get-HmaExpectedIntegrityHash {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$State)

    $installPath = Get-HmaNonReparseExistingPath `
        -LiteralPath (Join-Path $State 'install.json') `
        -File
    $installText = Get-HmaStrictUtf8Text `
        -LiteralPath $installPath `
        -MaximumBytes 65536
    try {
        $install = ConvertFrom-Json -InputObject $installText -ErrorAction Stop
        Assert-HmaExactProperties `
            -InputObject $install `
            -Expected @(
                'version',
                'appRoot',
                'stateRoot',
                'nodePath',
                'port',
                'upstreamBase',
                'commit',
                'manifestSha256',
                'bootstrapHashes'
            )
        Assert-HmaExactProperties `
            -InputObject $install.bootstrapHashes `
            -Expected @(
                'start',
                'open',
                'connector',
                'launcher',
                'integrity',
                'runtime',
                'secrets',
                'finalVerifier',
                'extensionManifest',
                'extensionCallback'
            )
        if ($install.bootstrapHashes.integrity -isnot [string] -or
            [string]$install.bootstrapHashes.integrity -cnotmatch '^[a-fA-F0-9]{64}$') {
            throw 'The integrity hash is invalid.'
        }
        return ([string]$install.bootstrapHashes.integrity).ToLowerInvariant()
    } finally {
        $install = $null
        $installText = $null
    }
}

function Get-HmaStableMicrosoftEdge {
    [CmdletBinding()]
    param()

    $candidates = New-Object 'Collections.Generic.List[string]'
    foreach ($base in @(
            [Environment]::GetFolderPath(
                [Environment+SpecialFolder]::ProgramFiles
            ),
            [Environment]::GetFolderPath(
                [Environment+SpecialFolder]::ProgramFilesX86
            )
        )) {
        if (-not [string]::IsNullOrWhiteSpace($base)) {
            [void]$candidates.Add(
                (Join-Path $base 'Microsoft\Edge\Application\msedge.exe')
            )
        }
    }

    foreach ($candidate in @($candidates | Select-Object -Unique)) {
        try {
            $edgePath = Get-HmaNonReparseExistingPath `
                -LiteralPath $candidate `
                -File
            $signature = Get-AuthenticodeSignature `
                -LiteralPath $edgePath `
                -ErrorAction Stop
            if ([string]$signature.Status -cne 'Valid' -or
                $null -eq $signature.SignerCertificate -or
                [string]$signature.SignerCertificate.Subject -notmatch (
                    '(?:^|,\s*)O=Microsoft Corporation(?:,|$)'
                )) {
                continue
            }
            return $edgePath
        } catch {
        }
    }
    throw 'Microsoft Edge validation failed.'
}

function Get-HmaVerifiedServiceListenerPid {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Plan)

    $listeners = @(
        Get-NetTCPConnection `
            -State Listen `
            -ErrorAction Stop
    )
    $listeners = @(
        $listeners | Where-Object {
            [int]$_.LocalPort -eq 37645
        }
    )
    if ($listeners.Count -ne 1 -or
        [string]$listeners[0].LocalAddress -cne '127.0.0.1' -or
        [int]$listeners[0].LocalPort -ne 37645 -or
        [string]$listeners[0].State -cne 'Listen') {
        throw 'The listener is invalid.'
    }
    $listenerPid = [int]$listeners[0].OwningProcess
    if ($listenerPid -le 0) {
        throw 'The listener is invalid.'
    }

    $processes = @(
        Get-CimInstance `
            -ClassName Win32_Process `
            -Filter ('ProcessId = ' + [string]$listenerPid) `
            -ErrorAction Stop
    )
    if ($processes.Count -ne 1 -or
        -not (Test-HmaLiveServiceProcess `
            -Process $processes[0] `
            -Plan $Plan `
            -ListenerPid $listenerPid)) {
        throw 'The listener is invalid.'
    }
    return $listenerPid
}

function Invoke-HmaVerifiedPasswordPost {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$BodyJson
    )

    $response = $null
    $requestFailed = $false
    try {
        $beforePid = Get-HmaVerifiedServiceListenerPid -Plan $Plan
        try {
            $response = Invoke-WebRequest `
                -Uri $Uri `
                -Method Post `
                -ContentType 'application/json' `
                -Body $BodyJson `
                -UseBasicParsing `
                -MaximumRedirection 0 `
                -TimeoutSec 10 `
                -ErrorAction Stop
        } catch {
            $requestFailed = $true
        }
        $afterPid = Get-HmaVerifiedServiceListenerPid -Plan $Plan
        if ($afterPid -ne $beforePid) {
            throw 'The listener changed.'
        }
        if ($requestFailed) {
            throw 'The request failed.'
        }
        return $response
    } finally {
        $requestFailed = $false
        $afterPid = $null
        $beforePid = $null
        $response = $null
    }
}

function Get-HmaJsonResponsePayload {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Response,
        [Parameter(Mandatory)][string[]]$ExpectedProperties
    )

    if ([int]$Response.StatusCode -ne 200 -or
        $Response.Content -isnot [string] -or
        [string]::IsNullOrWhiteSpace([string]$Response.Content) -or
        ([string]$Response.Content).Length -gt 4096) {
        throw 'The response is invalid.'
    }
    $payload = ConvertFrom-Json `
        -InputObject ([string]$Response.Content) `
        -ErrorAction Stop
    Assert-HmaExactProperties `
        -InputObject $payload `
        -Expected $ExpectedProperties
    return $payload
}

function Get-HmaStartedAttemptId {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)][string]$Password
    )

    $requestBody = $null
    $response = $null
    $payload = $null
    try {
        $requestBody = ConvertTo-Json `
            -InputObject ([ordered]@{ password = $Password }) `
            -Compress
        $response = Invoke-HmaVerifiedPasswordPost `
            -Plan $Plan `
            -Uri 'http://127.0.0.1:37645/api/connect/oauth/attempt/start' `
            -BodyJson $requestBody
        $payload = Get-HmaJsonResponsePayload `
            -Response $response `
            -ExpectedProperties @('attemptId')
        if ($payload.attemptId -isnot [string] -or
            [string]$payload.attemptId -cnotmatch '^[A-Za-z0-9_-]{43}$') {
            throw 'The attempt response is invalid.'
        }
        return [string]$payload.attemptId
    } finally {
        $payload = $null
        $response = $null
        $requestBody = $null
    }
}

function Get-HmaAttemptStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)][string]$Password,
        [Parameter(Mandatory)][string]$AttemptId
    )

    $requestBody = $null
    $response = $null
    $payload = $null
    try {
        $requestBody = ConvertTo-Json `
            -InputObject ([ordered]@{
                password = $Password
                attemptId = $AttemptId
            }) `
            -Compress
        $response = Invoke-HmaVerifiedPasswordPost `
            -Plan $Plan `
            -Uri 'http://127.0.0.1:37645/api/connect/oauth/attempt/status' `
            -BodyJson $requestBody
        $payload = Get-HmaJsonResponsePayload `
            -Response $response `
            -ExpectedProperties @('status', 'provider', 'displayLabel')
        if ($payload.status -isnot [string] -or
            [string]$payload.status -cnotin @(
                'pending',
                'processing',
                'done',
                'failed',
                'expired'
            ) -or
            $payload.provider -isnot [string] -or
            [string]$payload.provider -cne 'anthropic' -or
            $payload.displayLabel -isnot [string] -or
            [string]::IsNullOrWhiteSpace([string]$payload.displayLabel) -or
            ([string]$payload.displayLabel).Length -gt 128) {
            throw 'The status response is invalid.'
        }
        foreach ($character in ([string]$payload.displayLabel).ToCharArray()) {
            if ([char]::IsControl($character)) {
                throw 'The status response is invalid.'
            }
        }
        return [string]$payload.status
    } finally {
        $payload = $null
        $response = $null
        $requestBody = $null
    }
}

function Assert-HmaPrivateEmptyOauthRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$State,
        [Parameter(Mandatory)][string]$OauthRoot
    )

    $expected = Join-Path $State 'oauth-temp'
    $verified = Get-HmaNonReparseExistingPath `
        -LiteralPath $OauthRoot `
        -Directory
    if (-not (Test-HmaOrdinalEqual `
            -Left $verified `
            -Right ([IO.Path]::GetFullPath($expected)) `
            -IgnoreCase) -or
        -not (Test-HmaPrivateAcl -LiteralPath $verified -Recurse) -or
        @(Get-ChildItem -LiteralPath $verified -Force -ErrorAction Stop).Count -ne 0) {
        throw 'The OAuth temporary root is invalid.'
    }
}

function Assert-HmaNoReparseTree {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Root)

    $verifiedRoot = Get-HmaNonReparseExistingPath -LiteralPath $Root -Directory
    $queue = New-Object 'Collections.Generic.Queue[string]'
    $queue.Enqueue($verifiedRoot)
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        foreach ($child in @(
                Get-ChildItem -LiteralPath $parent -Force -ErrorAction Stop
            )) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'A reparse point is not permitted.'
            }
            if ($child.PSIsContainer) {
                $queue.Enqueue([string]$child.FullName)
            }
        }
    }
}

function New-HmaTemporaryProfile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$State,
        [Parameter(Mandatory)][string]$OauthRoot,
        [Parameter(Mandatory)][string]$AttemptId
    )

    if ($AttemptId -cnotmatch '^[A-Za-z0-9_-]{43}$') {
        throw 'The attempt id is invalid.'
    }
    Assert-HmaPrivateEmptyOauthRoot -State $State -OauthRoot $OauthRoot
    $profile = Join-Path $OauthRoot ('attempt-' + $AttemptId)
    if ([IO.File]::Exists($profile) -or [IO.Directory]::Exists($profile)) {
        throw 'The temporary profile already exists.'
    }
    [void][IO.Directory]::CreateDirectory($profile)
    Set-HmaPrivateAcl -LiteralPath $profile
    $verified = Get-HmaNonReparseExistingPath -LiteralPath $profile -Directory
    if (-not (Test-HmaOrdinalEqual `
            -Left $verified `
            -Right ([IO.Path]::GetFullPath($profile)) `
            -IgnoreCase) -or
        -not (Test-HmaPrivateAcl -LiteralPath $verified -Recurse)) {
        throw 'The temporary profile is invalid.'
    }
    Assert-HmaNoReparseTree -Root $verified
    return $verified
}

function ConvertTo-HmaWindowsCommandLineArgument {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    foreach ($character in $Value.ToCharArray()) {
        if ([char]::IsControl($character)) {
            throw 'The child argument is invalid.'
        }
    }
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }

    $builder = New-Object Text.StringBuilder
    [void]$builder.Append([char]34)
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char]92) {
            $backslashes += 1
            continue
        }
        if ($character -eq [char]34) {
            [void]$builder.Append([char]92, ($backslashes * 2) + 1)
            [void]$builder.Append([char]34)
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append([char]92, $backslashes)
            $backslashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) {
        [void]$builder.Append([char]92, $backslashes * 2)
    }
    [void]$builder.Append([char]34)
    return $builder.ToString()
}

function Get-HmaExactProfileProcesses {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$EdgePath,
        [Parameter(Mandatory)][string]$ProfilePath
    )

    $profileArgument = '--user-data-dir=' + $ProfilePath
    $rows = @(
        Get-CimInstance `
            -ClassName Win32_Process `
            -Filter "Name = 'msedge.exe'" `
            -ErrorAction Stop
    )
    $matches = New-Object 'Collections.Generic.List[object]'
    $seen = @{}
    foreach ($row in $rows) {
        $executableProperty = $row.PSObject.Properties['ExecutablePath']
        $commandProperty = $row.PSObject.Properties['CommandLine']
        $idProperty = $row.PSObject.Properties['ProcessId']
        if ($null -eq $executableProperty -or
            $null -eq $commandProperty -or
            $null -eq $idProperty -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$executableProperty.Value) `
                -Right $EdgePath `
                -IgnoreCase)) {
            continue
        }
        $arguments = @(
            [Hma.NativeCommandLine]::Split([string]$commandProperty.Value)
        )
        if ($arguments.Count -lt 2 -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$arguments[0]) `
                -Right $EdgePath `
                -IgnoreCase)) {
            continue
        }
        $profileArguments = @($arguments | Where-Object {
                ([string]$_).StartsWith(
                    '--user-data-dir=',
                    [StringComparison]::Ordinal
                )
            })
        if ($profileArguments.Count -ne 1 -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$profileArguments[0]) `
                -Right $profileArgument `
                -IgnoreCase)) {
            continue
        }
        $processId = [int]$idProperty.Value
        if ($processId -le 0 -or $seen.ContainsKey($processId)) {
            continue
        }
        $seen[$processId] = $true
        [void]$matches.Add($row)
    }
    return $matches.ToArray()
}

function Close-HmaExactProfileProcesses {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$EdgePath,
        [Parameter(Mandatory)][string]$ProfilePath
    )

    foreach ($row in @(
            Get-HmaExactProfileProcesses `
                -EdgePath $EdgePath `
                -ProfilePath $ProfilePath
        )) {
        $processId = [int]$row.ProcessId
        try {
            Stop-Process -Id $processId -Force -ErrorAction Stop
            Wait-Process -Id $processId -Timeout 30 -ErrorAction Stop
        } catch {
            $remaining = @(
                Get-HmaExactProfileProcesses `
                    -EdgePath $EdgePath `
                    -ProfilePath $ProfilePath |
                    Where-Object { [int]$_.ProcessId -eq $processId }
            )
            if ($remaining.Count -ne 0) {
                throw 'The temporary Edge process did not close.'
            }
        }
    }
    if (@(
            Get-HmaExactProfileProcesses `
                -EdgePath $EdgePath `
                -ProfilePath $ProfilePath
        ).Count -ne 0) {
        throw 'The temporary Edge process did not close.'
    }
}

function Wait-HmaExactProfileClosed {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$EdgePath,
        [Parameter(Mandatory)][string]$ProfilePath
    )

    while (@(
            Get-HmaExactProfileProcesses `
                -EdgePath $EdgePath `
                -ProfilePath $ProfilePath
        ).Count -ne 0) {
        Start-Sleep -Milliseconds 500
    }
}

function Remove-HmaTemporaryProfile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$OauthRoot,
        [Parameter(Mandatory)][string]$ProfilePath
    )

    $verifiedOauthRoot = Get-HmaNonReparseExistingPath `
        -LiteralPath $OauthRoot `
        -Directory
    $verifiedProfile = Get-HmaNonReparseExistingPath `
        -LiteralPath $ProfilePath `
        -Directory
    $expectedParent = [IO.Path]::GetFullPath($verifiedOauthRoot).TrimEnd('\') + '\'
    if (-not $verifiedProfile.StartsWith(
            $expectedParent,
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        [IO.Path]::GetDirectoryName($verifiedProfile) -cne (
            [IO.Path]::GetFullPath($verifiedOauthRoot).TrimEnd('\')
        ) -or
        [IO.Path]::GetFileName($verifiedProfile) -cnotmatch (
            '^attempt-[A-Za-z0-9_-]{43}$'
        )) {
        throw 'The temporary profile path is invalid.'
    }
    Assert-HmaNoReparseTree -Root $verifiedProfile
    [IO.Directory]::Delete($verifiedProfile, $true)
    if ([IO.Directory]::Exists($verifiedProfile) -or
        [IO.File]::Exists($verifiedProfile) -or
        @(Get-ChildItem -LiteralPath $verifiedOauthRoot -Force -ErrorAction Stop).Count -ne 0) {
        throw 'The temporary profile was not deleted.'
    }
}

$bundle = $null
$password = $null
$attemptId = $null
$profilePath = $null
$servicePlan = $null
$status = $null
$startBody = $null
$statusBody = $null
$edgePath = $null
$oauthRoot = $null
$operationFailed = $false
try {
    if ($PSVersionTable.PSEdition -cne 'Desktop' -or
        $PSVersionTable.PSVersion.Major -ne 5 -or
        $PSVersionTable.PSVersion.Minor -lt 1) {
        throw 'Windows PowerShell 5.1 is required.'
    }

    $state = Get-HmaNonReparseExistingPath -LiteralPath $StateRoot -Directory
    $bootstrap = Join-Path $state 'bootstrap'
    $expectedConnectorPath = Join-Path $bootstrap 'connect-claude-secure.ps1'
    $connectorPath = Get-HmaNonReparseExistingPath `
        -LiteralPath $PSCommandPath `
        -File
    if (-not (Test-HmaOrdinalEqual `
            -Left $connectorPath `
            -Right ([IO.Path]::GetFullPath($expectedConnectorPath)) `
            -IgnoreCase) -or
        -not (Test-HmaOrdinalEqual `
            -Left (Get-FileHash `
                -Algorithm SHA256 `
                -LiteralPath $connectorPath `
                -ErrorAction Stop).Hash `
            -Right $ExpectedConnectorHash `
            -IgnoreCase)) {
        throw 'The connector is invalid.'
    }

    $expectedIntegrityHash = Get-HmaExpectedIntegrityHash -State $state
    $integrityModule = Get-HmaNonReparseExistingPath `
        -LiteralPath (Join-Path $bootstrap 'SecureLocalIntegrity.psm1') `
        -File
    if (-not (Test-HmaOrdinalEqual `
            -Left (Get-FileHash `
                -Algorithm SHA256 `
                -LiteralPath $integrityModule `
                -ErrorAction Stop).Hash `
            -Right $expectedIntegrityHash `
            -IgnoreCase)) {
        throw 'The integrity module is invalid.'
    }

    Import-Module $integrityModule -Force -ErrorAction Stop
    $config = Assert-HmaStartupIntegrity -StateRoot $state
    if (-not (Test-HmaOrdinalEqual `
            -Left ([string]$config.bootstrapHashes.connector) `
            -Right $ExpectedConnectorHash `
            -IgnoreCase)) {
        throw 'The connector hash is invalid.'
    }
    Import-Module (Join-Path $bootstrap 'SecureLocalRuntime.psm1') `
        -Force `
        -ErrorAction Stop

    $edgePath = Get-HmaStableMicrosoftEdge
    $extensionRoot = Get-HmaNonReparseExistingPath `
        -LiteralPath (Join-Path $bootstrap 'oauth-handoff-extension') `
        -Directory
    $oauthRoot = Get-HmaNonReparseExistingPath `
        -LiteralPath (Join-Path $state 'oauth-temp') `
        -Directory

    Import-Module (Join-Path $bootstrap 'SecureLocalSecrets.psm1') `
        -Force `
        -ErrorAction Stop
    Assert-HmaPrivateEmptyOauthRoot -State $state -OauthRoot $oauthRoot
    $bundle = Unprotect-HmaSecretBundle -Path (Join-Path $state 'secrets.dpapi')
    $password = [string]$bundle.appPassword
    $servicePlan = New-HmaServiceLaunchPlan `
        -Config $config `
        -StateRoot $state `
        -Bundle $bundle

    $attemptId = Get-HmaStartedAttemptId `
        -Plan $servicePlan `
        -Password $password
    $profilePath = New-HmaTemporaryProfile `
        -State $state `
        -OauthRoot $oauthRoot `
        -AttemptId $attemptId

    $launchUri = (
        'http://127.0.0.1:37645/api/connect/oauth/attempt/launch/' +
        $attemptId
    )
    if ($launchUri -cnotmatch (
            '^http://127\.0\.0\.1:37645/' +
            'api/connect/oauth/attempt/launch/[A-Za-z0-9_-]{43}$'
        )) {
        throw 'The launch URI is invalid.'
    }
    $edgeArguments = @(
        '--user-data-dir=' + $profilePath
        '--load-extension=' + $extensionRoot
        '--disable-extensions-except=' + $extensionRoot
        '--no-first-run'
        '--disable-sync'
        '--disable-background-mode'
        $launchUri
    ) | ForEach-Object {
        ConvertTo-HmaWindowsCommandLineArgument -Value ([string]$_)
    }
    $edgeEnvironment = New-HmaMinimalChildEnvironment
    Set-HmaExactProcessEnvironment -Environment $edgeEnvironment
    Start-Process `
        -FilePath $edgePath `
        -ArgumentList $edgeArguments `
        -WindowStyle Normal | Out-Null

    while ($true) {
        $status = Get-HmaAttemptStatus `
            -Plan $servicePlan `
            -Password $password `
            -AttemptId $attemptId
        if ($status -ceq 'done') {
            Write-Host (
                'Connection completed. In this private Edge window, open ' +
                'Claude Settings -> Usage, complete the documented visual ' +
                'comparison, then close the window.'
            )
            Wait-HmaExactProfileClosed `
                -EdgePath $edgePath `
                -ProfilePath $profilePath
            break
        }
        if ($status -cin @('failed', 'expired')) {
            throw 'The OAuth attempt ended.'
        }
        Start-Sleep -Milliseconds 1000
    }
} catch {
    $operationFailed = $true
} finally {
    try {
        if ($null -ne $profilePath -and
            [IO.Directory]::Exists([string]$profilePath)) {
            if ($null -eq $edgePath) {
                throw 'The Edge path is unavailable for cleanup.'
            }
            Close-HmaExactProfileProcesses `
                -EdgePath $edgePath `
                -ProfilePath $profilePath
            Remove-HmaTemporaryProfile `
                -OauthRoot $oauthRoot `
                -ProfilePath $profilePath
        }
    } catch {
        $operationFailed = $true
    }
    $edgeEnvironment = $null
    $edgeArguments = $null
    $launchUri = $null
    $statusBody = $null
    $startBody = $null
    $status = $null
    $servicePlan = $null
    $profilePath = $null
    $attemptId = $null
    $password = $null
    $bundle = $null
}

if ($operationFailed) {
    throw 'Secure Claude connection failed.'
}
