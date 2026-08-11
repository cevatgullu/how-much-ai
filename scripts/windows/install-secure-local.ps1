[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$ExpectedManifestSha256,
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$ExpectedInstalledManifestSha256,
    [Parameter(Mandatory)][string]$NodePath,
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$ExpectedNodeSha256,
    [Parameter(Mandatory)][string]$Ps51Path,
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$ExpectedPs51Sha256,
    [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'HowMuchAI'),
    [ValidateSet(37645)][int]$Port = 37645
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$upstreamBase = '1238189b7017601d21e3579d041480ce3773e191'
$registrationAttempted = $false
$launcherCreatedByThisRun = $false
$launcherCreatedIdentity = $null
$launcherPlan = $null
$launcherStagingRoot = $null
$launcherProgramsRoot = $null
$registeredTaskNames = @('HowMuchAI-Service', 'HowMuchAI-Window')
$bundle = $null
$manifestBytes = $null
$installBytes = $null
$nodeLock = $null
$ps51Lock = $null
$sourceEntryLocks = New-Object 'Collections.Generic.List[IO.FileStream]'
$updateLock = $null
$updateTransaction = $null
$updateActivationStarted = $false
$updateRollbackAttempted = $false
$updateNewInstall = $null
$updateNewConfig = $null
$updateNewLauncherPlan = $null
$updateFileLeases = New-Object 'Collections.Generic.List[IDisposable]'
$bootstrapHashFiles = [ordered]@{
    start = 'start-secure-local.ps1'
    open = 'open-secure-local.ps1'
    connector = 'connect-claude-secure.ps1'
    launcher = 'launch-secure-local.ps1'
    integrity = 'SecureLocalIntegrity.psm1'
    runtime = 'SecureLocalRuntime.psm1'
    secrets = 'SecureLocalSecrets.psm1'
    finalVerifier = 'verify-final-local-state.ps1'
    extensionManifest = 'oauth-handoff-extension/manifest.json'
    extensionCallback = 'oauth-handoff-extension/callback.js'
}

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

function Assert-HmaSafePathText {
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

function Get-HmaVerifiedExistingPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [switch]$Directory,
        [switch]$File
    )

    try {
        Assert-HmaSafePathText -Value $LiteralPath
        $fullPath = [IO.Path]::GetFullPath($LiteralPath)
        $rootPath = [IO.Path]::GetPathRoot($fullPath)
        if ([string]::IsNullOrWhiteSpace($rootPath) -or
            $rootPath -notmatch '^[A-Za-z]:\\$' -or
            (Test-HmaOrdinalEqual -Left $fullPath -Right $rootPath -IgnoreCase)) {
            throw 'The path is invalid.'
        }

        $currentPath = $rootPath
        $rootItem = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
        if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'The path is invalid.'
        }
        $separators = [char[]]@(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        )
        foreach ($segment in $fullPath.Substring($rootPath.Length).Split(
                $separators,
                [StringSplitOptions]::RemoveEmptyEntries
            )) {
            $currentPath = [IO.Path]::Combine($currentPath, $segment)
            $item = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'The path is invalid.'
            }
        }
        $leaf = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
        if (($Directory -and -not $leaf.PSIsContainer) -or
            ($File -and $leaf.PSIsContainer)) {
            throw 'The path is invalid.'
        }
        return $fullPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
    } catch {
        throw 'The path is invalid.'
    }
}

function Get-HmaVerifiedStatePath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)

    Assert-HmaSafePathText -Value $LiteralPath
    $fullPath = [IO.Path]::GetFullPath($LiteralPath).TrimEnd(
        [IO.Path]::DirectorySeparatorChar
    )
    if ([IO.Directory]::Exists($fullPath) -or [IO.File]::Exists($fullPath)) {
        return Get-HmaVerifiedExistingPath -LiteralPath $fullPath -Directory
    }
    $parent = [IO.Path]::GetDirectoryName($fullPath)
    if ([string]::IsNullOrWhiteSpace($parent) -or
        -not [IO.Directory]::Exists($parent)) {
        throw 'The state path is invalid.'
    }
    $null = Get-HmaVerifiedExistingPath -LiteralPath $parent -Directory
    return $fullPath
}

function Assert-HmaExactProperties {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$InputObject,
        [Parameter(Mandatory)][string[]]$Expected
    )

    if ($null -eq $InputObject -or $InputObject -is [Collections.IDictionary]) {
        throw 'The JSON schema is invalid.'
    }
    $actual = @($InputObject.PSObject.Properties | ForEach-Object { $_.Name })
    if ([bool](Compare-Object `
            -ReferenceObject @($Expected | Sort-Object) `
            -DifferenceObject @($actual | Sort-Object) `
            -CaseSensitive)) {
        throw 'The JSON schema is invalid.'
    }
}

function Assert-HmaSha256 {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Value)

    if ($Value -isnot [string] -or [string]$Value -cnotmatch '^[a-fA-F0-9]{64}$') {
        throw 'The SHA-256 value is invalid.'
    }
}

function Get-HmaSha256 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)

    return (Get-FileHash `
            -Algorithm SHA256 `
            -LiteralPath $LiteralPath `
            -ErrorAction Stop).Hash.ToLowerInvariant()
}

function Get-HmaBytesSha256 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][byte[]]$Bytes)

    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($Bytes))).Replace(
            '-',
            ''
        ).ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

function Get-HmaLockedStreamSha256 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][IO.FileStream]$Stream)

    $originalPosition = $Stream.Position
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $Stream.Position = 0
        return ([BitConverter]::ToString(
                $sha256.ComputeHash($Stream)
            )).Replace('-', '').ToLowerInvariant()
    } finally {
        $Stream.Position = $originalPosition
        $sha256.Dispose()
    }
}

function Assert-HmaTrustedAclDescriptor {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Security)

    if (-not $Security.AreAccessRulesCanonical) {
        throw 'A trusted executable ACL is invalid.'
    }
    $trustedInstallerSid = (
        'S-1-5-80-956008885-3418522649-1831038044-' +
        '1853292631-2271478464'
    )
    $safeWriters = @{
        'S-1-5-18' = $true
        'S-1-5-32-544' = $true
        $trustedInstallerSid = $true
    }
    $owner = $Security.GetOwner(
        [Security.Principal.SecurityIdentifier]
    ).Value
    if (-not $safeWriters.ContainsKey($owner)) {
        throw 'A trusted executable ACL is invalid.'
    }

    $dangerousRights = [Int64](
        [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::CreateFiles -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::CreateDirectories -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    )
    $dangerousRights = $dangerousRights -bor 268435456 -bor 1073741824
    $rules = $Security.GetAccessRules(
        $true,
        $true,
        [Security.Principal.SecurityIdentifier]
    )
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -ne
            [Security.AccessControl.AccessControlType]::Allow) {
            continue
        }
        $rights = ([Int64]$rule.FileSystemRights) -band 4294967295
        if (($rights -band $dangerousRights) -eq 0) {
            continue
        }
        $sid = $rule.IdentityReference.Value
        $creatorOwnerOnly = (
            $sid -ceq 'S-1-3-0' -and
            ($rule.PropagationFlags -band
                [Security.AccessControl.PropagationFlags]::InheritOnly)
        )
        if (-not $safeWriters.ContainsKey($sid) -and
            -not $creatorOwnerOnly) {
            throw 'A trusted executable ACL is invalid.'
        }
    }
}

function Assert-HmaTrustedExecutableAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string]$TrustedRoot
    )

    $trustedFile = Get-HmaVerifiedExistingPath -LiteralPath $FilePath -File
    $trustedRootPath = Get-HmaVerifiedExistingPath `
        -LiteralPath $TrustedRoot `
        -Directory
    if (-not $trustedFile.StartsWith(
            $trustedRootPath + '\',
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'A trusted executable ACL is invalid.'
    }
    $sections = (
        [Security.AccessControl.AccessControlSections]::Access -bor
        [Security.AccessControl.AccessControlSections]::Owner
    )
    Assert-HmaTrustedAclDescriptor -Security (
        [IO.File]::GetAccessControl($trustedFile, $sections)
    )

    $current = [IO.Path]::GetDirectoryName($trustedFile)
    while ($true) {
        $current = Get-HmaVerifiedExistingPath `
            -LiteralPath $current `
            -Directory
        Assert-HmaTrustedAclDescriptor -Security (
            [IO.Directory]::GetAccessControl($current, $sections)
        )
        if (Test-HmaOrdinalEqual `
                -Left $current `
                -Right $trustedRootPath `
                -IgnoreCase) {
            break
        }
        if (-not $current.StartsWith(
                $trustedRootPath + '\',
                [StringComparison]::OrdinalIgnoreCase
            )) {
            throw 'A trusted executable ACL is invalid.'
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Enter-HmaSourceEntryLease {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)]$Entries
    )

    $streams = New-Object 'Collections.Generic.List[IO.FileStream]'
    try {
        foreach ($entry in @($Entries)) {
            $sourcePath = Join-Path $Source (
                [string]$entry.ManifestPath
            ).Replace('/', [IO.Path]::DirectorySeparatorChar)
            $verified = Get-HmaVerifiedExistingPath `
                -LiteralPath $sourcePath `
                -File
            $stream = [IO.File]::Open(
                $verified,
                [IO.FileMode]::Open,
                [IO.FileAccess]::Read,
                [IO.FileShare]::Read
            )
            [void]$streams.Add($stream)
            if ($stream.Length -ne [long]$entry.Size -or
                -not (Test-HmaOrdinalEqual `
                    -Left (Get-HmaLockedStreamSha256 -Stream $stream) `
                    -Right ([string]$entry.Sha256) `
                    -IgnoreCase)) {
                throw 'A source file lease is invalid.'
            }
        }
        return $streams
    } catch {
        foreach ($stream in $streams) {
            $stream.Dispose()
        }
        throw 'A source file lease is invalid.'
    }
}

function Exit-HmaSourceEntryLease {
    [CmdletBinding()]
    param([AllowNull()]$Streams)

    foreach ($stream in @($Streams)) {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }
}

function Assert-HmaSourceEntryLease {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Entries,
        [Parameter(Mandatory)]$Streams
    )

    if (@($Entries).Count -ne @($Streams).Count) {
        throw 'A source file lease changed.'
    }
    for ($index = 0; $index -lt @($Entries).Count; $index += 1) {
        $entry = @($Entries)[$index]
        $stream = @($Streams)[$index]
        if ($stream.Length -ne [long]$entry.Size -or
            -not (Test-HmaOrdinalEqual `
                -Left (Get-HmaLockedStreamSha256 -Stream $stream) `
                -Right ([string]$entry.Sha256) `
                -IgnoreCase)) {
            throw 'A source file lease changed.'
        }
    }
}

function Test-HmaExactStringSet {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Expected,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Actual
    )

    $expectedSorted = @($Expected | Sort-Object)
    $actualSorted = @($Actual | Sort-Object)
    if ($expectedSorted.Count -ne $actualSorted.Count) {
        return $false
    }
    for ($index = 0; $index -lt $expectedSorted.Count; $index += 1) {
        if (-not (Test-HmaOrdinalEqual `
                -Left $expectedSorted[$index] `
                -Right $actualSorted[$index])) {
            return $false
        }
    }
    return $true
}

function Assert-HmaManifestRelativePath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][AllowEmptyString()][string]$RequiredPrefix
    )

    if ($Value -isnot [string]) {
        throw 'The manifest path is invalid.'
    }
    $relative = [string]$Value
    if ([string]::IsNullOrWhiteSpace($relative) -or
        $relative.StartsWith('/') -or
        $relative.EndsWith('/') -or
        $relative.Contains('\') -or
        $relative.Contains(':') -or
        $relative.IndexOfAny([char[]]@("'", '"')) -ge 0 -or
        -not $relative.StartsWith($RequiredPrefix, [StringComparison]::Ordinal)) {
        throw 'The manifest path is invalid.'
    }
    foreach ($character in $relative.ToCharArray()) {
        if ([char]::IsControl($character)) {
            throw 'The manifest path is invalid.'
        }
    }
    $segments = @($relative.Split('/'))
    if (@($segments | Where-Object { $_ -ceq '' -or $_ -ceq '.' -or $_ -ceq '..' }).Count -gt 0) {
        throw 'The manifest path is invalid.'
    }
    foreach ($segment in $segments) {
        if ($segment.StartsWith('.env', [StringComparison]::OrdinalIgnoreCase) -or
            $segment.Equals('vault.key', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The manifest path is invalid.'
        }
    }
    for ($index = 0; $index -lt ($segments.Count - 1); $index += 1) {
        if ($segments[$index].Equals('.next', [StringComparison]::OrdinalIgnoreCase) -and
            $segments[$index + 1].Equals('cache', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The manifest path is invalid.'
        }
    }
    return $relative
}

function Get-HmaValidatedManifestEntries {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Entries,
        [Parameter(Mandatory)][ValidateSet('runtime', 'bootstrap')][string]$Kind
    )

    if ($null -eq $Entries -or $Entries -is [string] -or
        $Entries -isnot [Collections.IEnumerable]) {
        throw 'The manifest list is invalid.'
    }
    $inputEntries = @($Entries)
    if ($inputEntries.Count -eq 0) {
        throw 'The manifest list is invalid.'
    }

    $seen = @{}
    $validated = New-Object 'Collections.Generic.List[object]'
    $previousPath = $null
    foreach ($entry in $inputEntries) {
        Assert-HmaExactProperties `
            -InputObject $entry `
            -Expected @('path', 'size', 'sha256')
        $prefix = if ($Kind -ceq 'bootstrap') { 'scripts/windows/' } else { '' }
        $manifestPath = Assert-HmaManifestRelativePath `
            -Value $entry.path `
            -RequiredPrefix $prefix
        if ($null -ne $previousPath -and
            [string]::CompareOrdinal($previousPath, $manifestPath) -ge 0) {
            throw 'The manifest list is invalid.'
        }
        $previousPath = $manifestPath
        $folded = $manifestPath.ToLowerInvariant()
        if ($seen.ContainsKey($folded)) {
            throw 'The manifest list is invalid.'
        }
        $seen[$folded] = $true
        if (($entry.size -isnot [int] -and $entry.size -isnot [long]) -or
            [long]$entry.size -lt 0) {
            throw 'The manifest size is invalid.'
        }
        Assert-HmaSha256 -Value $entry.sha256

        if ($Kind -ceq 'runtime') {
            $runtimeAllowed = (
                $manifestPath -cin @('package.json', 'package-lock.json', 'next.config.ts') -or
                $manifestPath -cmatch '^(?:public|node_modules|\.next)/'
            )
            if (-not $runtimeAllowed -or
                (Test-HmaExcludedNonRuntimeArtifact -RelativePath $manifestPath)) {
                throw 'The runtime manifest path is invalid.'
            }
        }
        [void]$validated.Add([pscustomobject]@{
                ManifestPath = $manifestPath
                InstalledPath = if ($Kind -ceq 'bootstrap') {
                    $manifestPath.Substring('scripts/windows/'.Length)
                } else {
                    $manifestPath
                }
                Size = [long]$entry.size
                Sha256 = ([string]$entry.sha256).ToLowerInvariant()
            })
    }
    return $validated.ToArray()
}

function Test-HmaExcludedNonRuntimeArtifact {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RelativePath)

    if ($RelativePath.StartsWith('.next/', [StringComparison]::OrdinalIgnoreCase) -and
        $RelativePath.EndsWith('.map', [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    foreach ($excluded in @(
            'node_modules/convex/dist/cli.bundle.cjs',
            'node_modules/convex/dist/cli.bundle.cjs.map',
            'node_modules/convex/src/cli/lib/formatEnvValueForDotfile.test.ts',
            'node_modules/next/dist/docs/01-app/02-guides/environment-variables.md'
        )) {
        if ($RelativePath.Equals($excluded, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Get-HmaNoFollowTree {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Root)

    $verifiedRoot = Get-HmaVerifiedExistingPath -LiteralPath $Root -Directory
    $results = New-Object 'Collections.Generic.List[object]'
    $queue = New-Object 'Collections.Generic.Queue[string]'
    $queue.Enqueue($verifiedRoot)
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        foreach ($child in @(Get-ChildItem -LiteralPath $parent -Force -ErrorAction Stop)) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'A reparse point is not permitted.'
            }
            $relative = $child.FullName.Substring($verifiedRoot.Length).TrimStart(
                [IO.Path]::DirectorySeparatorChar
            ).Replace('\', '/')
            [void]$results.Add([pscustomobject]@{
                    FullName = $child.FullName
                    Relative = $relative
                    IsDirectory = [bool]$child.PSIsContainer
                    Length = if ($child.PSIsContainer) { [long]0 } else { [long]$child.Length }
                })
            if ($child.PSIsContainer) {
                $queue.Enqueue($child.FullName)
            }
        }
    }
    return $results.ToArray()
}

function Assert-HmaSourceEntries {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)]$RuntimeEntries,
        [Parameter(Mandatory)]$BootstrapEntries
    )

    foreach ($entry in @($RuntimeEntries) + @($BootstrapEntries)) {
        $sourcePath = Join-Path $Source ([string]$entry.ManifestPath).Replace(
            '/',
            [IO.Path]::DirectorySeparatorChar
        )
        $verified = Get-HmaVerifiedExistingPath -LiteralPath $sourcePath -File
        $item = Get-Item -LiteralPath $verified -Force -ErrorAction Stop
        if ([long]$item.Length -ne [long]$entry.Size -or
            -not (Test-HmaOrdinalEqual `
                -Left (Get-HmaSha256 -LiteralPath $verified) `
                -Right ([string]$entry.Sha256) `
                -IgnoreCase)) {
            throw 'A source file is invalid.'
        }
    }

    $actualRuntime = New-Object 'Collections.Generic.List[string]'
    foreach ($fileName in @('package.json', 'package-lock.json', 'next.config.ts')) {
        $candidate = Join-Path $Source $fileName
        if ([IO.File]::Exists($candidate)) {
            $null = Get-HmaVerifiedExistingPath -LiteralPath $candidate -File
            [void]$actualRuntime.Add($fileName)
        }
    }
    foreach ($rootName in @('public', 'node_modules', '.next')) {
        $candidate = Join-Path $Source $rootName
        if ([IO.Directory]::Exists($candidate)) {
            foreach ($item in @(Get-HmaNoFollowTree -Root $candidate)) {
                if (-not $item.IsDirectory) {
                    $relative = $rootName + '/' + $item.Relative
                    if ($relative -cnotmatch '^\.next/cache(?:/|$)' -and
                        -not (Test-HmaExcludedNonRuntimeArtifact `
                            -RelativePath $relative)) {
                        [void]$actualRuntime.Add($relative)
                    }
                }
            }
        }
    }
    $expectedRuntime = @($RuntimeEntries | ForEach-Object { [string]$_.ManifestPath })
    if (-not (Test-HmaExactStringSet -Expected $expectedRuntime -Actual $actualRuntime.ToArray())) {
        throw 'The source runtime file set is invalid.'
    }

    $windowsRoot = Join-Path $Source 'scripts\windows'
    $actualBootstrap = @(
        Get-HmaNoFollowTree -Root $windowsRoot |
            Where-Object { -not $_.IsDirectory } |
            ForEach-Object { 'scripts/windows/' + $_.Relative }
    )
    $actualBootstrap = @($actualBootstrap | Where-Object {
            $_ -cne 'scripts/windows/install-secure-local.ps1'
        })
    $expectedBootstrap = @(
        $BootstrapEntries | ForEach-Object { [string]$_.ManifestPath }
    )
    if (-not (Test-HmaExactStringSet `
            -Expected $expectedBootstrap `
            -Actual $actualBootstrap)) {
        throw 'The source bootstrap file set is invalid.'
    }

    $environmentEntries = @(
        Get-ChildItem -LiteralPath $Source -Force -ErrorAction Stop |
            Where-Object { $_.Name.StartsWith('.env', [StringComparison]::OrdinalIgnoreCase) }
    )
    $exampleEntries = @($environmentEntries | Where-Object {
            $_.Name -ceq '.env.example'
        })
    $forbiddenEnvironmentEntries = @($environmentEntries | Where-Object {
            $_.Name -cne '.env.example'
        })
    if ($forbiddenEnvironmentEntries.Count -gt 0 -or
        $exampleEntries.Count -gt 1 -or
        [IO.File]::Exists((Join-Path $Source '.data\vault.key'))) {
        throw 'A forbidden source file is present.'
    }
    if ($exampleEntries.Count -eq 1) {
        $null = Get-HmaVerifiedExistingPath `
            -LiteralPath ([string]$exampleEntries[0].FullName) `
            -File
    }
}

function Get-HmaExpectedDirectories {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Entries)

    $directories = @{}
    foreach ($entry in @($Entries)) {
        $segments = @(([string]$entry.InstalledPath).Split('/'))
        for ($count = 1; $count -lt $segments.Count; $count += 1) {
            $relative = [string]::Join('/', $segments[0..($count - 1)])
            $directories[$relative.ToLowerInvariant()] = $relative
        }
    }
    return @($directories.Values | Sort-Object)
}

function Assert-HmaInstalledEntries {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)]$Entries
    )

    $tree = @(Get-HmaNoFollowTree -Root $Root)
    $files = @($tree | Where-Object { -not $_.IsDirectory })
    $directories = @($tree | Where-Object { $_.IsDirectory })
    $expectedFiles = @($Entries | ForEach-Object { [string]$_.InstalledPath })
    $expectedDirectories = @(Get-HmaExpectedDirectories -Entries $Entries)
    $actualFiles = @($files | ForEach-Object { [string]$_.Relative })
    $actualDirectories = @($directories | ForEach-Object { [string]$_.Relative })
    if (-not (Test-HmaExactStringSet -Expected $expectedFiles -Actual $actualFiles) -or
        -not (Test-HmaExactStringSet `
            -Expected $expectedDirectories `
            -Actual $actualDirectories)) {
        throw 'The installed file set is invalid.'
    }

    $byPath = @{}
    foreach ($file in $files) {
        $byPath[$file.Relative.ToLowerInvariant()] = $file
    }
    foreach ($entry in @($Entries)) {
        $file = $byPath[$entry.InstalledPath.ToLowerInvariant()]
        if ($null -eq $file -or
            [long]$file.Length -ne [long]$entry.Size -or
            -not (Test-HmaOrdinalEqual `
                -Left (Get-HmaSha256 -LiteralPath $file.FullName) `
                -Right ([string]$entry.Sha256) `
                -IgnoreCase)) {
            throw 'An installed file is invalid.'
        }
    }
}

function Copy-HmaManifestEntries {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)]$Entries,
        [Parameter(Mandatory)]$Streams
    )

    $entryList = @($Entries)
    $streamList = @($Streams)
    if ($entryList.Count -ne $streamList.Count) {
        throw 'A source file lease is invalid.'
    }
    for ($index = 0; $index -lt $entryList.Count; $index += 1) {
        $entry = $entryList[$index]
        $sourceStream = $streamList[$index]
        if ($sourceStream -isnot [IO.FileStream] -or
            -not $sourceStream.CanRead) {
            throw 'A source file lease is invalid.'
        }
        $destinationPath = Join-Path $Destination ([string]$entry.InstalledPath).Replace(
            '/',
            [IO.Path]::DirectorySeparatorChar
        )
        $parent = [IO.Path]::GetDirectoryName($destinationPath)
        if (-not [IO.Directory]::Exists($parent)) {
            [void][IO.Directory]::CreateDirectory($parent)
        }
        if ([IO.File]::Exists($destinationPath)) {
            $existing = Get-Item -LiteralPath $destinationPath -Force -ErrorAction Stop
            if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                [long]$existing.Length -ne [long]$entry.Size -or
                -not (Test-HmaOrdinalEqual `
                    -Left (Get-HmaSha256 -LiteralPath $destinationPath) `
                    -Right ([string]$entry.Sha256) `
                    -IgnoreCase)) {
                throw 'An installed file conflicts with the reviewed file.'
            }
        } elseif ([IO.Directory]::Exists($destinationPath)) {
            throw 'An installed path conflicts with the reviewed file.'
        } else {
            $destinationStream = $null
            $originalPosition = $sourceStream.Position
            try {
                $destinationStream = [IO.File]::Open(
                    $destinationPath,
                    [IO.FileMode]::CreateNew,
                    [IO.FileAccess]::Write,
                    [IO.FileShare]::None
                )
                $sourceStream.Position = 0
                $sourceStream.CopyTo($destinationStream)
                $destinationStream.Flush($true)
            } finally {
                $sourceStream.Position = $originalPosition
                if ($null -ne $destinationStream) {
                    $destinationStream.Dispose()
                }
            }
        }
    }
}

function Test-HmaBytesEqual {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][byte[]]$Left,
        [Parameter(Mandatory)][byte[]]$Right
    )

    if ($Left.Length -ne $Right.Length) {
        return $false
    }
    for ($index = 0; $index -lt $Left.Length; $index += 1) {
        if ($Left[$index] -ne $Right[$index]) {
            return $false
        }
    }
    return $true
}

function Write-HmaAtomicExactBytes {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][byte[]]$Bytes
    )

    if ([IO.File]::Exists($Destination)) {
        $existing = [IO.File]::ReadAllBytes($Destination)
        try {
            if (-not (Test-HmaBytesEqual -Left $existing -Right $Bytes)) {
                throw 'An existing control file differs.'
            }
            return
        } finally {
            [Array]::Clear($existing, 0, $existing.Length)
        }
    }
    if ([IO.Directory]::Exists($Destination)) {
        throw 'A control path is invalid.'
    }

    $parent = [IO.Path]::GetDirectoryName($Destination)
    $temporary = Join-Path $parent ('.hma-install-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllBytes($temporary, $Bytes)
        Set-HmaPrivateAcl -LiteralPath $temporary
        [IO.File]::Move($temporary, $Destination)
        $temporary = $null
    } finally {
        if ($null -ne $temporary -and [IO.File]::Exists($temporary)) {
            [IO.File]::Delete($temporary)
        }
    }
}

function Get-HmaUpdateTransactionPaths {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$StateRoot)

    $state = [IO.Path]::GetFullPath($StateRoot).TrimEnd(
        [IO.Path]::DirectorySeparatorChar
    )
    $parent = [IO.Path]::GetDirectoryName($state)
    $stateBytes = (New-Object Text.UTF8Encoding($false)).GetBytes(
        $state.ToLowerInvariant()
    )
    try {
        $key = Get-HmaBytesSha256 -Bytes $stateBytes
    } finally {
        [Array]::Clear($stateBytes, 0, $stateBytes.Length)
    }
    return [pscustomobject]@{
        LockPath = Join-Path $parent ('.hma-update-' + $key + '.lock')
        JournalRoot = Join-Path $parent ('.hma-update-' + $key)
    }
}

function Enter-HmaUpdateLock {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)

    $parent = Get-HmaVerifiedExistingPath `
        -LiteralPath ([IO.Path]::GetDirectoryName($LiteralPath)) `
        -Directory
    if (-not (Test-HmaOrdinalEqual `
            -Left $parent `
            -Right ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LiteralPath))) `
            -IgnoreCase)) {
        throw 'The update lock path is invalid.'
    }
    $created = -not [IO.File]::Exists($LiteralPath)
    $stream = $null
    try {
        $stream = [IO.File]::Open(
            $LiteralPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
        if ($created) {
            Set-HmaPrivateAcl -LiteralPath $LiteralPath
        } elseif (-not (Test-HmaPrivateAcl -LiteralPath $LiteralPath)) {
            $stream.Dispose()
            $stream = $null
            throw 'The update lock ACL is invalid.'
        }
        return $stream
    } catch {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        throw 'Another secure local update is active.'
    }
}

function Assert-HmaUpdateRootPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [Parameter(Mandatory)][string]$StateRoot,
        [ValidateSet('published', 'publishing', 'retired')][string]$Kind = 'published'
    )

    $expected = (Get-HmaUpdateTransactionPaths -StateRoot $StateRoot).JournalRoot
    $fullPath = [IO.Path]::GetFullPath($LiteralPath)
    $expectedFull = [IO.Path]::GetFullPath([string]$expected)
    $valid = if ($Kind -ceq 'published') {
        Test-HmaOrdinalEqual -Left $fullPath -Right $expectedFull -IgnoreCase
    } elseif ($Kind -ceq 'publishing') {
        $fullPath -cmatch ('^' + [regex]::Escape($expectedFull) +
            '\.publishing-[a-f0-9]{32}$')
    } else {
        $fullPath -cmatch ('^' + [regex]::Escape($expectedFull) +
            '\.retired-[a-f0-9]{32}$')
    }
    if (-not $valid) {
        throw 'The update journal path is invalid.'
    }
}

function Assert-HmaUpdateTreeShape {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [switch]$RequireJournal
    )

    $root = Get-HmaVerifiedExistingPath -LiteralPath $LiteralPath -Directory
    $tree = @(Get-HmaNoFollowTree -Root $root)
    if (-not (Test-HmaPrivateAcl -LiteralPath $root -Recurse)) {
        throw 'The update journal ACL is invalid.'
    }
    foreach ($entry in $tree) {
        $relative = ([string]$entry.Relative).Replace('\', '/')
        $allowed = (
            $relative -cin @(
                'transaction.json',
                'transaction.next',
                'transaction.previous',
                'old',
                'candidate'
            ) -or
            $relative -cmatch '^old/(?:app|bootstrap|app-original|bootstrap-original)(?:/|$)' -or
            $relative -cmatch '^old/(?:failed-app|failed-bootstrap)-[a-f0-9]{32}(?:/|$)' -or
            $relative -cmatch '^old/(?:install\.json|integrity\.json)(?:\.original|\.failed-[a-f0-9]{32})?$' -or
            $relative -cin @(
                'old/How Much AI.lnk',
                'old/How Much AI.original.lnk',
                'old/HowMuchAI-Service.xml',
                'old/HowMuchAI-Window.xml'
            ) -or
            $relative -cmatch '^old/(?:failed|quarantined)-launcher-[a-f0-9]{32}\.lnk$' -or
            $relative -cmatch '^old/quarantined-(?:app|bootstrap|install|integrity)-[a-f0-9]{32}(?:/|$)' -or
            $relative -cmatch '^candidate/(?:app|bootstrap)(?:/|$)' -or
            $relative -cin @(
                'candidate/install.json',
                'candidate/integrity.json',
                'candidate/tasks.json',
                'candidate/How Much AI.lnk'
            )
        )
        if (-not $allowed) {
            throw 'The update journal tree is invalid.'
        }
    }
    if ($RequireJournal) {
        $journalPath = Join-Path $root 'transaction.json'
        if (-not [IO.File]::Exists($journalPath) -or
            [IO.Directory]::Exists($journalPath)) {
            throw 'The update journal is invalid.'
        }
    }
    return $root
}

function Get-HmaUpdateOrphanRoots {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$StateRoot)

    $paths = Get-HmaUpdateTransactionPaths -StateRoot $StateRoot
    $parent = Get-HmaVerifiedExistingPath `
        -LiteralPath ([IO.Path]::GetDirectoryName([string]$paths.JournalRoot)) `
        -Directory
    $baseName = [IO.Path]::GetFileName([string]$paths.JournalRoot)
    return @(Get-ChildItem -LiteralPath $parent -Force -ErrorAction Stop |
        Where-Object {
            $_.Name -cmatch ('^' + [regex]::Escape($baseName) +
                '\.(?:publishing|retired)-[a-f0-9]{32}$')
        })
}

function Remove-HmaUpdateOrphanRoots {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$StateRoot)

    foreach ($item in @(Get-HmaUpdateOrphanRoots -StateRoot $StateRoot)) {
        if (-not $item.PSIsContainer -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'An update journal retirement path is invalid.'
        }
        $kind = if ($item.Name -cmatch '\.publishing-') {
            'publishing'
        } else {
            'retired'
        }
        Assert-HmaUpdateRootPath `
            -LiteralPath $item.FullName `
            -StateRoot $StateRoot `
            -Kind $kind
        $null = Assert-HmaUpdateTreeShape -LiteralPath $item.FullName
        [IO.Directory]::Delete($item.FullName, $true)
    }
}

function Remove-HmaUpdateRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [Parameter(Mandatory)][string]$StateRoot
    )

    Assert-HmaUpdateRootPath -LiteralPath $LiteralPath -StateRoot $StateRoot
    if (-not [IO.Directory]::Exists($LiteralPath)) {
        return
    }
    $null = Assert-HmaUpdateTreeShape `
        -LiteralPath $LiteralPath `
        -RequireJournal
    $retired = $LiteralPath + '.retired-' + [Guid]::NewGuid().ToString('N')
    Assert-HmaUpdateRootPath `
        -LiteralPath $retired `
        -StateRoot $StateRoot `
        -Kind retired
    Move-Item -LiteralPath $LiteralPath -Destination $retired
    $null = Assert-HmaUpdateTreeShape -LiteralPath $retired
    [IO.Directory]::Delete($retired, $true)
}

function Remove-HmaUnpublishedUpdateRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [Parameter(Mandatory)][string]$StateRoot
    )

    Assert-HmaUpdateRootPath -LiteralPath $LiteralPath -StateRoot $StateRoot
    if (-not [IO.Directory]::Exists($LiteralPath)) { return }
    $null = Assert-HmaUpdateTreeShape -LiteralPath $LiteralPath
    if (@(Get-HmaNoFollowTree -Root $LiteralPath).Count -ne 0) {
        throw 'The unpublished update journal is invalid.'
    }
    $retired = $LiteralPath + '.retired-' + [Guid]::NewGuid().ToString('N')
    Assert-HmaUpdateRootPath `
        -LiteralPath $retired `
        -StateRoot $StateRoot `
        -Kind retired
    Move-Item -LiteralPath $LiteralPath -Destination $retired
    $null = Assert-HmaUpdateTreeShape -LiteralPath $retired
    [IO.Directory]::Delete($retired, $true)
}

function Copy-HmaExactTree {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    if ([IO.File]::Exists($Destination) -or [IO.Directory]::Exists($Destination)) {
        throw 'An update staging path is occupied.'
    }
    [void][IO.Directory]::CreateDirectory($Destination)
    foreach ($entry in @(Get-HmaNoFollowTree -Root $Source)) {
        $target = Join-Path $Destination $entry.Relative.Replace(
            '/',
            [IO.Path]::DirectorySeparatorChar
        )
        if ($entry.IsDirectory) {
            [void][IO.Directory]::CreateDirectory($target)
            continue
        }
        $parent = [IO.Path]::GetDirectoryName($target)
        if (-not [IO.Directory]::Exists($parent)) {
            [void][IO.Directory]::CreateDirectory($parent)
        }
        $sourceStream = $null
        $destinationStream = $null
        try {
            $sourceStream = [IO.File]::Open(
                $entry.FullName,
                [IO.FileMode]::Open,
                [IO.FileAccess]::Read,
                [IO.FileShare]::Read
            )
            $destinationStream = [IO.File]::Open(
                $target,
                [IO.FileMode]::CreateNew,
                [IO.FileAccess]::Write,
                [IO.FileShare]::None
            )
            $sourceStream.CopyTo($destinationStream)
            $destinationStream.Flush($true)
        } finally {
            if ($null -ne $destinationStream) { $destinationStream.Dispose() }
            if ($null -ne $sourceStream) { $sourceStream.Dispose() }
        }
    }
    Set-HmaPrivateAcl -LiteralPath $Destination
}

function Copy-HmaExactFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    $bytes = [IO.File]::ReadAllBytes(
        (Get-HmaVerifiedExistingPath -LiteralPath $Source -File)
    )
    try {
        if ([IO.File]::Exists($Destination) -or [IO.Directory]::Exists($Destination)) {
            throw 'An update staging path is occupied.'
        }
        [IO.File]::WriteAllBytes($Destination, $bytes)
        Set-HmaPrivateAcl -LiteralPath $Destination
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Write-HmaUpdateJournal {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$JournalRoot,
        [Parameter(Mandatory)]$Record
    )

    $destination = Join-Path $JournalRoot 'transaction.json'
    $temporary = Join-Path $JournalRoot 'transaction.next'
    $previous = Join-Path $JournalRoot 'transaction.previous'
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(
        (ConvertTo-Json -InputObject $Record -Depth 8 -Compress)
    )
    try {
        $stream = $null
        try {
            $stream = [IO.File]::Open(
                $temporary,
                [IO.FileMode]::Create,
                [IO.FileAccess]::Write,
                [IO.FileShare]::None
            )
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally {
            if ($null -ne $stream) { $stream.Dispose() }
        }
        Set-HmaPrivateAcl -LiteralPath $temporary
        if ([IO.File]::Exists($destination)) {
            [IO.File]::Replace($temporary, $destination, $previous, $true)
            if ([IO.File]::Exists($previous)) {
                [IO.File]::Delete($previous)
            }
        } else {
            [IO.File]::Move($temporary, $destination)
        }
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Get-HmaUpdateJournal {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$JournalRoot,
        [ValidateSet('transaction.json', 'transaction.next')]
        [string]$FileName = 'transaction.json'
    )

    if ($FileName -ceq 'transaction.json') {
        $null = Assert-HmaUpdateTreeShape `
            -LiteralPath $JournalRoot `
            -RequireJournal
    } else {
        $null = Assert-HmaUpdateTreeShape -LiteralPath $JournalRoot
    }
    $path = Get-HmaVerifiedExistingPath `
        -LiteralPath (Join-Path $JournalRoot $FileName) `
        -File
    $text = [IO.File]::ReadAllText($path)
    $record = ConvertFrom-Json -InputObject $text -ErrorAction Stop
    Assert-HmaExactProperties `
        -InputObject $record `
        -Expected @(
            'version',
            'stateRoot',
            'oldCommit',
            'oldManifestSha256',
            'oldInstallSha256',
            'oldVersion',
            'oldAppRoot',
            'oldNodePath',
            'oldPort',
            'oldUpstreamBase',
            'oldBootstrapHashes',
            'oldLauncherSha256',
            'oldTaskFingerprints',
            'newCommit',
            'newManifestSha256',
            'newInstallSha256',
            'newLauncherSha256',
            'phase'
        )
    if ($record.version -isnot [int] -or [int]$record.version -ne 2 -or
        $record.stateRoot -isnot [string] -or
        $record.oldCommit -isnot [string] -or
        [string]$record.oldCommit -cnotmatch '^[a-fA-F0-9]{40}$' -or
        $record.newCommit -isnot [string] -or
        [string]$record.newCommit -cnotmatch '^[a-fA-F0-9]{40}$' -or
        $record.phase -isnot [string] -or
        [string]$record.phase -cnotin @(
            'staging',
            'staged',
            'runtime-promoted',
            'bootstrap-promoted',
            'control-promoted',
            'task-1-promoted',
            'task-2-promoted',
            'shortcut-promoted',
            'verified',
            'rolled-back'
        )) {
        throw 'The update journal is invalid.'
    }
    Assert-HmaSha256 -Value $record.oldManifestSha256
    Assert-HmaSha256 -Value $record.oldInstallSha256
    Assert-HmaSha256 -Value $record.oldLauncherSha256
    Assert-HmaSha256 -Value $record.newManifestSha256
    Assert-HmaSha256 -Value $record.newInstallSha256
    if ([string]$record.phase -cne 'staging') {
        Assert-HmaSha256 -Value $record.newLauncherSha256
    } elseif ($record.newLauncherSha256 -isnot [string] -or
        [string]$record.newLauncherSha256 -cnotin @('', ('0' * 64))) {
        throw 'The update journal is invalid.'
    }
    if ($record.oldVersion -isnot [int] -or [int]$record.oldVersion -ne 1 -or
        $record.oldAppRoot -isnot [string] -or
        $record.oldNodePath -isnot [string] -or
        $record.oldPort -isnot [int] -or
        [int]$record.oldPort -ne 37645 -or
        $record.oldUpstreamBase -isnot [string]) {
        throw 'The update journal is invalid.'
    }
    Assert-HmaExactProperties `
        -InputObject $record.oldBootstrapHashes `
        -Expected @($script:bootstrapHashFiles.Keys)
    foreach ($name in $script:bootstrapHashFiles.Keys) {
        Assert-HmaSha256 -Value $record.oldBootstrapHashes.$name
    }
    $taskFingerprints = @($record.oldTaskFingerprints)
    if ($taskFingerprints.Count -ne $script:registeredTaskNames.Count) {
        throw 'The update journal is invalid.'
    }
    $seenTaskNames = @{}
    foreach ($taskFingerprint in $taskFingerprints) {
        Assert-HmaExactProperties `
            -InputObject $taskFingerprint `
            -Expected @('name', 'sha256')
        $taskName = [string]$taskFingerprint.name
        if ($taskName -cnotin $script:registeredTaskNames -or
            $seenTaskNames.ContainsKey($taskName)) {
            throw 'The update journal is invalid.'
        }
        $seenTaskNames[$taskName] = $true
        Assert-HmaSha256 -Value $taskFingerprint.sha256
    }
    return $record
}

function Repair-HmaPublishedUpdateJournal {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$JournalRoot,
        [Parameter(Mandatory)][string]$StateRoot
    )

    Assert-HmaUpdateRootPath -LiteralPath $JournalRoot -StateRoot $StateRoot
    $null = Assert-HmaUpdateTreeShape -LiteralPath $JournalRoot
    $current = Join-Path $JournalRoot 'transaction.json'
    $next = Join-Path $JournalRoot 'transaction.next'
    if ([IO.File]::Exists($current)) {
        $null = Get-HmaUpdateJournal -JournalRoot $JournalRoot
        return $true
    }
    if ([IO.File]::Exists($next)) {
        $null = Get-HmaUpdateJournal `
            -JournalRoot $JournalRoot `
            -FileName 'transaction.next'
        [IO.File]::Move($next, $current)
        $null = Assert-HmaUpdateTreeShape `
            -LiteralPath $JournalRoot `
            -RequireJournal
        return $true
    }
    if (@(Get-HmaNoFollowTree -Root $JournalRoot).Count -eq 0) {
        Remove-HmaUnpublishedUpdateRoot `
            -LiteralPath $JournalRoot `
            -StateRoot $StateRoot
        return $false
    }
    throw 'The update journal is invalid.'
}

function Get-HmaPropertyString {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$InputObject,
        [Parameter(Mandatory)][string]$Name
    )

    if ($InputObject -is [Collections.IDictionary]) {
        if (-not $InputObject.Contains($Name) -or
            $null -eq $InputObject[$Name]) {
            return ''
        }
        return [string]$InputObject[$Name]
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return ''
    }
    return [string]$property.Value
}

function Get-HmaBootstrapHash {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Entries,
        [Parameter(Mandatory)][string]$FileName
    )

    $matches = @($Entries | Where-Object {
            [string]$_.InstalledPath -ceq $FileName
        })
    if ($matches.Count -ne 1) {
        throw 'A required bootstrap file is missing.'
    }
    return [string]$matches[0].Sha256
}

function Import-HmaReviewedSourceModule {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)]$Entries,
        [Parameter(Mandatory)][string]$FileName
    )

    $matches = @($Entries | Where-Object {
            [string]$_.InstalledPath -ceq $FileName
        })
    if ($matches.Count -ne 1) {
        throw 'A required bootstrap file is missing.'
    }
    $entry = $matches[0]
    $sourcePath = Join-Path $Source ([string]$entry.ManifestPath).Replace(
        '/',
        [IO.Path]::DirectorySeparatorChar
    )
    $verified = Get-HmaVerifiedExistingPath -LiteralPath $sourcePath -File
    $bytes = [IO.File]::ReadAllBytes($verified)
    try {
        if ([long]$bytes.Length -ne [long]$entry.Size -or
            -not (Test-HmaOrdinalEqual `
                -Left (Get-HmaBytesSha256 -Bytes $bytes) `
                -Right ([string]$entry.Sha256) `
                -IgnoreCase)) {
            throw 'A reviewed source module is invalid.'
        }
        $utf8 = New-Object Text.UTF8Encoding($false, $true)
        $moduleText = $utf8.GetString($bytes)
        $moduleScript = [ScriptBlock]::Create($moduleText)
        $moduleName = 'HmaReviewedSource_' + [Guid]::NewGuid().ToString('N')
        $reviewedModule = New-Module `
            -Name $moduleName `
            -ScriptBlock $moduleScript `
            -ErrorAction Stop
        Import-Module `
            -ModuleInfo $reviewedModule `
            -Force `
            -ErrorAction Stop
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Get-HmaTaskVerificationRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$TaskName)

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        return $null
    }
    $xml = Export-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $xmlBytes = (New-Object Text.UTF8Encoding($false)).GetBytes([string]$xml)
    try {
        $fingerprint = Get-HmaBytesSha256 -Bytes $xmlBytes
    } finally {
        [Array]::Clear($xmlBytes, 0, $xmlBytes.Length)
    }
    return [pscustomobject]@{
        TaskName = [string]$task.TaskName
        Principal = $task.Principal
        Actions = @($task.Actions)
        Triggers = @($task.Triggers)
        Settings = $task.Settings
        State = Get-HmaPropertyString -InputObject $task -Name 'State'
        Xml = [string]$xml
        Fingerprint = $fingerprint
    }
}

function Assert-HmaTaskFingerprintUnchanged {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$ExpectedTask)

    $current = Get-HmaTaskVerificationRecord `
        -TaskName ([string]$ExpectedTask.TaskName)
    if ($null -eq $current -or
        -not (Test-HmaOrdinalEqual `
            -Left ([string]$current.TaskName) `
            -Right ([string]$ExpectedTask.TaskName)) -or
        -not (Test-HmaOrdinalEqual `
            -Left ([string]$current.Fingerprint) `
            -Right ([string]$ExpectedTask.Fingerprint) `
            -IgnoreCase)) {
        throw 'A scheduled task changed before mutation.'
    }
    return $current
}

function Get-HmaLauncherFileIdentity {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)

    try {
        $verified = Get-HmaVerifiedExistingPath -LiteralPath $LiteralPath -File
        return [HmaInstaller.FileIdentity]::Get($verified)
    } catch {
        throw 'The launcher identity is invalid.'
    }
}

function Enter-HmaUpdateFileLease {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [Parameter(Mandatory)][string]$ExpectedSha256
    )

    $lease = $null
    try {
        $path = Get-HmaVerifiedExistingPath -LiteralPath $LiteralPath -File
        $lease = [HmaInstaller.FileLease]::Open($path)
        if (-not (Test-HmaOrdinalEqual `
                -Left $lease.Sha256() `
                -Right $ExpectedSha256 `
                -IgnoreCase)) {
            throw 'A retained update file changed.'
        }
        return $lease
    } catch {
        if ($null -ne $lease) { $lease.Dispose() }
        throw 'A retained update file lease is invalid.'
    }
}

function Exit-HmaUpdateFileLeases {
    [CmdletBinding()]
    param([AllowNull()]$Leases)

    foreach ($lease in @($Leases)) {
        if ($null -ne $lease) { $lease.Dispose() }
    }
    if ($null -ne $Leases -and $null -ne $Leases.PSObject.Methods['Clear']) {
        $Leases.Clear()
    }
}

function New-HmaStartMenuShortcutCandidate {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Plan)

    $shell = $null
    $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut([string]$Plan.Path)
        foreach ($name in @(
                'TargetPath',
                'Arguments',
                'WorkingDirectory',
                'Description',
                'IconLocation',
                'WindowStyle',
                'Hotkey'
            )) {
            $shortcut.$name = $Plan.$name
        }
        $shortcut.Save()
    } finally {
        if ($null -ne $shortcut) {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
        }
        if ($null -ne $shell) {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
        }
        $shortcut = $null
        $shell = $null
    }
}

function Remove-HmaValidatedLauncherStagingRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [Parameter(Mandatory)][string]$ExpectedParent
    )

    $staging = Get-HmaVerifiedExistingPath -LiteralPath $LiteralPath -Directory
    $parent = Get-HmaVerifiedExistingPath `
        -LiteralPath ([IO.Path]::GetDirectoryName($staging)) `
        -Directory
    if (-not (Test-HmaOrdinalEqual `
            -Left $parent `
            -Right $ExpectedParent `
            -IgnoreCase) -or
        [IO.Path]::GetFileName($staging) -cnotmatch '^\.hma-launcher-[a-f0-9]{32}$') {
        throw 'The launcher staging path is invalid.'
    }
    $queue = New-Object 'Collections.Generic.Queue[string]'
    $queue.Enqueue($staging)
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        foreach ($item in @(Get-ChildItem `
                -LiteralPath $current `
                -Force `
                -ErrorAction Stop)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'The launcher staging path is invalid.'
            }
            if ($item.PSIsContainer) {
                $queue.Enqueue($item.FullName)
            }
        }
    }
    [IO.Directory]::Delete($staging, $true)
}

function Install-HmaStartMenuLauncher {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Plan)

    $destination = [string]$Plan.Path
    if ([IO.File]::Exists($destination) -or
        [IO.Directory]::Exists($destination)) {
        if (-not [IO.File]::Exists($destination) -or
            -not (Test-HmaStartMenuLauncherPlan -Plan $Plan)) {
            throw 'The existing Start-menu launcher differs.'
        }
        return
    }

    $programs = Get-HmaVerifiedExistingPath `
        -LiteralPath ([IO.Path]::GetDirectoryName($destination)) `
        -Directory
    $script:launcherProgramsRoot = $programs
    $staging = Join-Path $programs (
        '.hma-launcher-' + [Guid]::NewGuid().ToString('N')
    )
    if ([IO.File]::Exists($staging) -or [IO.Directory]::Exists($staging)) {
        throw 'The launcher staging path is invalid.'
    }
    [void][IO.Directory]::CreateDirectory($staging)
    $script:launcherStagingRoot = $staging
    try {
        Set-HmaPrivateAcl -LiteralPath $staging
        $candidatePlan = [pscustomobject][ordered]@{
            Path = Join-Path $staging 'How Much AI.lnk'
            TargetPath = [string]$Plan.TargetPath
            Arguments = [string]$Plan.Arguments
            WorkingDirectory = [string]$Plan.WorkingDirectory
            Description = [string]$Plan.Description
            IconLocation = [string]$Plan.IconLocation
            WindowStyle = [int]$Plan.WindowStyle
            Hotkey = [string]$Plan.Hotkey
        }
        New-HmaStartMenuShortcutCandidate -Plan $candidatePlan
        if (-not (Test-HmaStartMenuLauncherFields -Plan $candidatePlan)) {
            throw 'The Start-menu launcher did not round-trip exactly.'
        }
        Set-HmaPrivateAcl -LiteralPath $candidatePlan.Path
        if (-not (Test-HmaStartMenuLauncherPlan -Plan $candidatePlan)) {
            throw 'The Start-menu launcher is invalid.'
        }
        if ([IO.File]::Exists($destination) -or
            [IO.Directory]::Exists($destination)) {
            throw 'The Start-menu launcher destination is occupied.'
        }
        $candidateIdentity = Get-HmaLauncherFileIdentity `
            -LiteralPath ([string]$candidatePlan.Path)
        [IO.File]::Move([string]$candidatePlan.Path, $destination)
        $script:launcherCreatedIdentity = $candidateIdentity
        $script:launcherCreatedByThisRun = $true
        if (-not (Test-HmaStartMenuLauncherPlan -Plan $Plan)) {
            throw 'The installed Start-menu launcher is invalid.'
        }
        $currentIdentity = Get-HmaLauncherFileIdentity `
            -LiteralPath $destination
        if (-not (Test-HmaOrdinalEqual `
                -Left ([string]$currentIdentity) `
                -Right ([string]$candidateIdentity))) {
            throw 'The installed Start-menu launcher is invalid.'
        }
    } finally {
        if ($null -ne $script:launcherStagingRoot -and
            [IO.Directory]::Exists([string]$script:launcherStagingRoot)) {
            Remove-HmaValidatedLauncherStagingRoot `
                -LiteralPath ([string]$script:launcherStagingRoot) `
                -ExpectedParent $programs
        }
        $script:launcherStagingRoot = $null
    }
}

function Assert-HmaOfflineUpdateQuiescent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)]$LauncherPlan,
        [AllowNull()]$LauncherLease,
        [AllowEmptyString()][string]$ExpectedLauncherSha256 = ''
    )

    foreach ($taskName in $script:registeredTaskNames) {
        $record = Get-HmaTaskVerificationRecord -TaskName $taskName
        if ($null -eq $record -or
            -not (Test-HmaRegisteredTaskPlan `
                -Task $record `
                -Config $Config `
                -StateRoot $StateRoot) -or
            -not (Test-HmaOrdinalEqual -Left ([string]$record.State) -Right 'Ready')) {
            throw 'The installed scheduled tasks are not quiescent.'
        }
    }
    if ($null -ne $LauncherLease) {
        if (-not (Test-HmaOrdinalEqual `
                -Left ([string]$LauncherLease.CurrentPath) `
                -Right ([string]$LauncherPlan.Path) `
                -IgnoreCase) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$LauncherLease.Sha256()) `
                -Right $ExpectedLauncherSha256 `
                -IgnoreCase)) {
            throw 'The retained Start-menu launcher changed.'
        }
    } elseif (-not (Test-HmaStartMenuLauncherPlan -Plan $LauncherPlan)) {
        throw 'The installed Start-menu launcher differs.'
    }
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
    if (@($listeners | Where-Object { [int]$_.LocalPort -eq 37645 }).Count -ne 0) {
        throw 'The secure local listener is not quiescent.'
    }
    $edgeProfile = Join-Path $StateRoot 'edge-profile'
    foreach ($process in @(Get-CimInstance `
            -ClassName Win32_Process `
            -ErrorAction Stop)) {
        $commandLine = Get-HmaPropertyString -InputObject $process -Name 'CommandLine'
        if (-not [string]::IsNullOrWhiteSpace($commandLine) -and
            $commandLine.IndexOf($edgeProfile, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw 'The dedicated Edge profile is not quiescent.'
        }
    }
}

function Assert-HmaStableOfflineUpdateQuiescent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)]$LauncherPlan
    )

    $stableReadySamples = 0
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        $allReady = $true
        foreach ($taskName in $script:registeredTaskNames) {
            $record = Get-HmaTaskVerificationRecord -TaskName $taskName
            if ($null -eq $record -or
                -not (Test-HmaRegisteredTaskPlan `
                    -Task $record `
                    -Config $Config `
                    -StateRoot $StateRoot) -or
                -not (Test-HmaOrdinalEqual `
                    -Left ([string]$record.State) `
                    -Right 'Ready')) {
                $allReady = $false
            }
        }
        if ($allReady) {
            $stableReadySamples += 1
            if ($stableReadySamples -ge 3) { break }
        } else {
            $stableReadySamples = 0
        }
        Start-Sleep -Milliseconds 25
    }
    if ($stableReadySamples -lt 3) {
        throw 'The rolled-back scheduled tasks are not stably Ready.'
    }
    for ($sample = 0; $sample -lt 2; $sample += 1) {
        Assert-HmaOfflineUpdateQuiescent `
            -Config $Config `
            -StateRoot $StateRoot `
            -LauncherPlan $LauncherPlan
        if ($sample -eq 0) { Start-Sleep -Milliseconds 25 }
    }
}

function Register-HmaExactTaskPlans {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Plans)

    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
    $principal = New-ScheduledTaskPrincipal `
        -UserId $sid `
        -LogonType Interactive `
        -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -MultipleInstances IgnoreNew `
        -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)
    foreach ($plan in @($Plans)) {
        if ($null -ne (Get-HmaTaskVerificationRecord -TaskName $plan.Name)) {
            throw 'A scheduled task destination is occupied.'
        }
        $action = New-ScheduledTaskAction `
            -Execute $plan.FilePath `
            -Argument $plan.ActionArguments
        Register-ScheduledTask `
            -TaskName $plan.Name `
            -Action $action `
            -Trigger $trigger `
            -Principal $principal `
            -Settings $settings `
            -ErrorAction Stop | Out-Null
    }
}

function Test-HmaExactTasksForConfig {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][string]$StateRoot
    )

    foreach ($taskName in $script:registeredTaskNames) {
        $record = Get-HmaTaskVerificationRecord -TaskName $taskName
        if ($null -eq $record -or
            -not (Test-HmaRegisteredTaskPlan `
                -Task $record `
                -Config $Config `
                -StateRoot $StateRoot)) {
            return $false
        }
    }
    return $true
}

function New-HmaLauncherPlanAtPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)][string]$Path
    )

    return [pscustomobject][ordered]@{
        Path = $Path
        TargetPath = [string]$Plan.TargetPath
        Arguments = [string]$Plan.Arguments
        WorkingDirectory = [string]$Plan.WorkingDirectory
        Description = [string]$Plan.Description
        IconLocation = [string]$Plan.IconLocation
        WindowStyle = [int]$Plan.WindowStyle
        Hotkey = [string]$Plan.Hotkey
    }
}

function Start-HmaUpdateTransaction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$JournalRoot,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)]$OldConfig,
        [Parameter(Mandatory)]$OldTaskRecords,
        [Parameter(Mandatory)]$OldLauncherPlan,
        [Parameter(Mandatory)]$OldFileLeases,
        [Parameter(Mandatory)]$NewInstall,
        [Parameter(Mandatory)][byte[]]$NewInstallBytes,
        [Parameter(Mandatory)][byte[]]$NewManifestBytes,
        [Parameter(Mandatory)]$RuntimeEntries,
        [Parameter(Mandatory)]$RuntimeStreams,
        [Parameter(Mandatory)]$BootstrapEntries,
        [Parameter(Mandatory)]$BootstrapStreams,
        [Parameter(Mandatory)]$NewTaskPlans,
        [Parameter(Mandatory)]$NewLauncherPlan
    )

    Assert-HmaUpdateRootPath -LiteralPath $JournalRoot -StateRoot $StateRoot
    if ([IO.File]::Exists($JournalRoot) -or [IO.Directory]::Exists($JournalRoot)) {
        throw 'An update journal already exists.'
    }
    $publishingRoot = $JournalRoot + '.publishing-' + [Guid]::NewGuid().ToString('N')
    Assert-HmaUpdateRootPath `
        -LiteralPath $publishingRoot `
        -StateRoot $StateRoot `
        -Kind publishing
    if ([IO.File]::Exists($publishingRoot) -or
        [IO.Directory]::Exists($publishingRoot)) {
        throw 'An update journal publication path is occupied.'
    }
    $oldInstallPath = Get-HmaVerifiedExistingPath `
        -LiteralPath (Join-Path $StateRoot 'install.json') `
        -File
    $oldIntegrityPath = Get-HmaVerifiedExistingPath `
        -LiteralPath (Join-Path $StateRoot 'integrity.json') `
        -File
    if (-not (Test-HmaOrdinalEqual `
            -Left ([string]$OldFileLeases.Integrity.Sha256()) `
            -Right ([string]$OldConfig.manifestSha256) `
            -IgnoreCase)) {
        throw 'The retained rollback manifest lease is invalid.'
    }
    $expectedOldAppRoot = Join-Path `
        (Join-Path $StateRoot 'runtime') `
        ([string]$OldConfig.commit)
    if (-not (Test-HmaOrdinalEqual `
            -Left ([string]$OldConfig.appRoot) `
            -Right $expectedOldAppRoot `
            -IgnoreCase) -or
        -not (Test-HmaOrdinalEqual `
            -Left ([string]$OldConfig.stateRoot) `
            -Right $StateRoot `
            -IgnoreCase)) {
        throw 'The retained rollback destinations are invalid.'
    }
    $oldBootstrapHashes = [ordered]@{}
    foreach ($name in $script:bootstrapHashFiles.Keys) {
        $value = Get-HmaPropertyString `
            -InputObject $OldConfig.bootstrapHashes `
            -Name $name
        Assert-HmaSha256 -Value $value
        $oldBootstrapHashes[$name] = $value.ToLowerInvariant()
    }
    $oldTaskFingerprints = @($OldTaskRecords | ForEach-Object {
            Assert-HmaSha256 -Value $_.Fingerprint
            [ordered]@{
                name = [string]$_.TaskName
                sha256 = ([string]$_.Fingerprint).ToLowerInvariant()
            }
        })
    if ($oldTaskFingerprints.Count -ne $script:registeredTaskNames.Count) {
        throw 'The retained task fingerprints are invalid.'
    }
    $record = [ordered]@{
        version = 2
        stateRoot = $StateRoot
        oldCommit = [string]$OldConfig.commit
        oldManifestSha256 = [string]$OldConfig.manifestSha256
        oldInstallSha256 = [string]$OldFileLeases.Install.Sha256()
        oldVersion = [int]$OldConfig.version
        oldAppRoot = $expectedOldAppRoot
        oldNodePath = [string]$OldConfig.nodePath
        oldPort = [int]$OldConfig.port
        oldUpstreamBase = [string]$OldConfig.upstreamBase
        oldBootstrapHashes = $oldBootstrapHashes
        oldLauncherSha256 = [string]$OldFileLeases.Launcher.Sha256()
        oldTaskFingerprints = $oldTaskFingerprints
        newCommit = [string]$NewInstall.commit
        newManifestSha256 = [string]$NewInstall.manifestSha256
        newInstallSha256 = Get-HmaBytesSha256 -Bytes $NewInstallBytes
        newLauncherSha256 = ''
        phase = 'staging'
    }
    $journalPublished = $false
    try {
        [void][IO.Directory]::CreateDirectory($publishingRoot)
        Set-HmaPrivateAcl -LiteralPath $publishingRoot
        Write-HmaUpdateJournal -JournalRoot $publishingRoot -Record $record
        Set-HmaPrivateAcl -LiteralPath $publishingRoot
        $null = Assert-HmaUpdateTreeShape `
            -LiteralPath $publishingRoot `
            -RequireJournal
        Move-Item -LiteralPath $publishingRoot -Destination $JournalRoot
        $journalPublished = $true
    } finally {
        if (-not $journalPublished -and
            [IO.Directory]::Exists($publishingRoot)) {
            $null = Assert-HmaUpdateTreeShape -LiteralPath $publishingRoot
            [IO.Directory]::Delete($publishingRoot, $true)
        }
    }

    $oldRoot = Join-Path $JournalRoot 'old'
    $candidateRoot = Join-Path $JournalRoot 'candidate'
    [void][IO.Directory]::CreateDirectory($oldRoot)
    [void][IO.Directory]::CreateDirectory($candidateRoot)
    $oldAppBackup = Join-Path $oldRoot 'app'
    $oldBootstrapBackup = Join-Path $oldRoot 'bootstrap'
    Copy-HmaExactTree -Source ([string]$OldConfig.appRoot) -Destination $oldAppBackup
    Copy-HmaExactTree `
        -Source (Join-Path $StateRoot 'bootstrap') `
        -Destination $oldBootstrapBackup
    $oldInstallBackup = Join-Path $oldRoot 'install.json'
    $OldFileLeases.Install.CopyTo($oldInstallBackup)
    Set-HmaPrivateAcl -LiteralPath $oldInstallBackup
    $oldIntegrityBackup = Join-Path $oldRoot 'integrity.json'
    $OldFileLeases.Integrity.CopyTo($oldIntegrityBackup)
    Set-HmaPrivateAcl -LiteralPath $oldIntegrityBackup
    $oldManifest = ConvertFrom-Json `
        -InputObject ([IO.File]::ReadAllText((Join-Path $oldRoot 'integrity.json'))) `
        -ErrorAction Stop
    Assert-HmaExactProperties `
        -InputObject $oldManifest `
        -Expected @(
            'commit',
            'nodeSha256',
            'installerSha256',
            'runtimeFiles',
            'bootstrapFiles'
        )
    if (-not (Test-HmaOrdinalEqual `
            -Left ([string]$oldManifest.commit) `
            -Right ([string]$OldConfig.commit))) {
        throw 'The staged rollback manifest is invalid.'
    }
    $oldRuntimeEntries = @(
        Get-HmaValidatedManifestEntries -Entries $oldManifest.runtimeFiles -Kind runtime
    )
    $oldBootstrapEntries = @(
        Get-HmaValidatedManifestEntries -Entries $oldManifest.bootstrapFiles -Kind bootstrap
    )
    Assert-HmaInstalledEntries -Root $oldAppBackup -Entries $oldRuntimeEntries
    Assert-HmaInstalledEntries `
        -Root $oldBootstrapBackup `
        -Entries $oldBootstrapEntries
    $oldLauncherBackup = Join-Path $oldRoot 'How Much AI.lnk'
    $OldFileLeases.Launcher.CopyTo($oldLauncherBackup)
    Set-HmaPrivateAcl -LiteralPath $oldLauncherBackup
    foreach ($recordedTask in @($OldTaskRecords)) {
        $taskPath = Join-Path $oldRoot ([string]$recordedTask.TaskName + '.xml')
        [IO.File]::WriteAllText(
            $taskPath,
            [string]$recordedTask.Xml,
            (New-Object Text.UTF8Encoding($false))
        )
        Set-HmaPrivateAcl -LiteralPath $taskPath
    }

    $candidateApp = Join-Path $candidateRoot 'app'
    $candidateBootstrap = Join-Path $candidateRoot 'bootstrap'
    [void][IO.Directory]::CreateDirectory($candidateApp)
    [void][IO.Directory]::CreateDirectory($candidateBootstrap)
    Copy-HmaManifestEntries `
        -Destination $candidateApp `
        -Entries $RuntimeEntries `
        -Streams $RuntimeStreams
    Copy-HmaManifestEntries `
        -Destination $candidateBootstrap `
        -Entries $BootstrapEntries `
        -Streams $BootstrapStreams
    Assert-HmaInstalledEntries -Root $candidateApp -Entries $RuntimeEntries
    Assert-HmaInstalledEntries -Root $candidateBootstrap -Entries $BootstrapEntries
    [IO.File]::WriteAllBytes((Join-Path $candidateRoot 'install.json'), $NewInstallBytes)
    [IO.File]::WriteAllBytes((Join-Path $candidateRoot 'integrity.json'), $NewManifestBytes)
    $taskBytes = (New-Object Text.UTF8Encoding($false)).GetBytes(
        (ConvertTo-Json -InputObject @($NewTaskPlans) -Depth 6 -Compress)
    )
    try {
        [IO.File]::WriteAllBytes((Join-Path $candidateRoot 'tasks.json'), $taskBytes)
    } finally {
        [Array]::Clear($taskBytes, 0, $taskBytes.Length)
    }
    $candidateLauncherPlan = New-HmaLauncherPlanAtPath `
        -Plan $NewLauncherPlan `
        -Path (Join-Path $candidateRoot 'How Much AI.lnk')
    New-HmaStartMenuShortcutCandidate -Plan $candidateLauncherPlan
    Set-HmaPrivateAcl -LiteralPath $JournalRoot
    if (-not (Test-HmaStartMenuLauncherPlan -Plan $candidateLauncherPlan)) {
        throw 'The staged Start-menu launcher is invalid.'
    }
    if (-not (Test-HmaPrivateAcl -LiteralPath $JournalRoot -Recurse)) {
        throw 'The update journal ACL is invalid.'
    }
    $record.newLauncherSha256 = Get-HmaSha256 `
        -LiteralPath ([string]$candidateLauncherPlan.Path)
    $record.phase = 'staged'
    Write-HmaUpdateJournal -JournalRoot $JournalRoot -Record $record
    return [pscustomobject]@{
        Record = $record
        OldRoot = $oldRoot
        CandidateRoot = $candidateRoot
        OldTaskRecords = @($OldTaskRecords)
        OldFileLeases = $OldFileLeases
        OldInstall = $OldConfig
        OldManifest = $oldManifest
        OldRuntimeEntries = @($oldRuntimeEntries)
        OldBootstrapEntries = @($oldBootstrapEntries)
    }
}

function Set-HmaUpdatePhase {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Transaction,
        [Parameter(Mandatory)][string]$Phase
    )

    $Transaction.Record.phase = $Phase
    Write-HmaUpdateJournal `
        -JournalRoot ([IO.Path]::GetDirectoryName([string]$Transaction.OldRoot)) `
        -Record $Transaction.Record
}

function Invoke-HmaUpdateActivation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Transaction,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)]$NewInstall,
        [Parameter(Mandatory)]$NewTaskPlans,
        [Parameter(Mandatory)]$NewLauncherPlan
    )

    $oldRoot = [string]$Transaction.OldRoot
    $candidateRoot = [string]$Transaction.CandidateRoot
    $runtimeParent = Join-Path $StateRoot 'runtime'
    $oldAppRoot = Join-Path $runtimeParent ([string]$Transaction.Record.oldCommit)
    $newAppRoot = [string]$NewInstall.appRoot
    Move-Item `
        -LiteralPath $oldAppRoot `
        -Destination (Join-Path $oldRoot 'app-original')
    Move-Item `
        -LiteralPath (Join-Path $candidateRoot 'app') `
        -Destination $newAppRoot
    Set-HmaUpdatePhase -Transaction $Transaction -Phase 'runtime-promoted'

    Move-Item `
        -LiteralPath (Join-Path $StateRoot 'bootstrap') `
        -Destination (Join-Path $oldRoot 'bootstrap-original')
    Move-Item `
        -LiteralPath (Join-Path $candidateRoot 'bootstrap') `
        -Destination (Join-Path $StateRoot 'bootstrap')
    Set-HmaUpdatePhase -Transaction $Transaction -Phase 'bootstrap-promoted'

    foreach ($name in @('integrity.json', 'install.json')) {
        $lease = if ($name -ceq 'integrity.json') {
            $Transaction.OldFileLeases.Integrity
        } else {
            $Transaction.OldFileLeases.Install
        }
        $expectedHash = if ($name -ceq 'integrity.json') {
            [string]$Transaction.Record.oldManifestSha256
        } else {
            [string]$Transaction.Record.oldInstallSha256
        }
        $livePath = Join-Path $StateRoot $name
        if ($null -eq $lease -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$lease.CurrentPath) `
                -Right $livePath `
                -IgnoreCase) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$lease.Sha256()) `
                -Right $expectedHash `
                -IgnoreCase)) {
            throw 'A retained control-file lease changed.'
        }
        $lease.MoveTo((Join-Path $oldRoot ($name + '.original')))
        Move-Item `
            -LiteralPath (Join-Path $candidateRoot $name) `
            -Destination (Join-Path $StateRoot $name)
    }
    Set-HmaPrivateAcl -LiteralPath $StateRoot
    Set-HmaUpdatePhase -Transaction $Transaction -Phase 'control-promoted'

    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
    $principal = New-ScheduledTaskPrincipal `
        -UserId $sid `
        -LogonType Interactive `
        -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -MultipleInstances IgnoreNew `
        -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)
    for ($index = 0; $index -lt @($NewTaskPlans).Count; $index += 1) {
        $plan = @($NewTaskPlans)[$index]
        $oldMatches = @($Transaction.OldTaskRecords | Where-Object {
                Test-HmaOrdinalEqual `
                    -Left ([string]$_.TaskName) `
                    -Right ([string]$plan.Name)
            })
        if ($oldMatches.Count -ne 1) {
            throw 'The retained scheduled-task identity is invalid.'
        }
        $null = Assert-HmaTaskFingerprintUnchanged `
            -ExpectedTask $oldMatches[0]
        Unregister-ScheduledTask `
            -TaskName ([string]$plan.Name) `
            -Confirm:$false `
            -ErrorAction Stop
        if ($null -ne (Get-HmaTaskVerificationRecord -TaskName $plan.Name)) {
            throw 'A scheduled task destination is occupied.'
        }
        Register-HmaExactTaskPlans -Plans @($plan)
        $registered = Get-HmaTaskVerificationRecord -TaskName $plan.Name
        if ($null -eq $registered -or
            -not (Test-HmaRegisteredTaskPlan `
                -Task $registered `
                -Config $NewInstall `
                -StateRoot $StateRoot)) {
            throw 'An updated scheduled task did not round-trip exactly.'
        }
        Set-HmaUpdatePhase `
            -Transaction $Transaction `
            -Phase ('task-' + [string]($index + 1) + '-promoted')
    }

    $launcherPath = [string]$NewLauncherPlan.Path
    $launcherLease = $Transaction.OldFileLeases.Launcher
    if ($null -eq $launcherLease -or
        -not (Test-HmaOrdinalEqual `
            -Left ([string]$launcherLease.CurrentPath) `
            -Right $launcherPath `
            -IgnoreCase) -or
        -not (Test-HmaOrdinalEqual `
            -Left ([string]$launcherLease.Sha256()) `
            -Right ([string]$Transaction.Record.oldLauncherSha256) `
            -IgnoreCase)) {
        throw 'The retained launcher lease changed.'
    }
    $launcherLease.MoveTo((Join-Path $oldRoot 'How Much AI.original.lnk'))
    Move-Item `
        -LiteralPath (Join-Path $candidateRoot 'How Much AI.lnk') `
        -Destination $launcherPath
    Set-HmaUpdatePhase -Transaction $Transaction -Phase 'shortcut-promoted'

    $config = Assert-HmaStartupIntegrity -StateRoot $StateRoot
    if (-not (Test-HmaOrdinalEqual `
            -Left ([string]$config.manifestSha256) `
            -Right ([string]$NewInstall.manifestSha256) `
            -IgnoreCase) -or
        -not (Test-HmaExactTasksForConfig -Config $config -StateRoot $StateRoot) -or
        -not (Test-HmaStartMenuLauncherPlan -Plan $NewLauncherPlan)) {
        throw 'The updated installation did not verify exactly.'
    }
    Set-HmaUpdatePhase -Transaction $Transaction -Phase 'verified'
    return $config
}

function Assert-HmaRollbackInstallConfiguration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Install,
        [Parameter(Mandatory)]$Record,
        [Parameter(Mandatory)][string]$StateRoot
    )

    Assert-HmaExactProperties `
        -InputObject $Install `
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
    $expectedAppRoot = Join-Path `
        (Join-Path $StateRoot 'runtime') `
        ([string]$Record.oldCommit)
    if ([int]$Install.version -ne 1 -or
        [int]$Install.version -ne [int]$Record.oldVersion -or
        -not (Test-HmaOrdinalEqual `
            -Left ([string]$Install.stateRoot) `
            -Right $StateRoot `
            -IgnoreCase) -or
        -not (Test-HmaOrdinalEqual `
            -Left ([string]$Record.stateRoot) `
            -Right $StateRoot `
            -IgnoreCase) -or
        -not (Test-HmaOrdinalEqual `
            -Left ([string]$Install.appRoot) `
            -Right $expectedAppRoot `
            -IgnoreCase) -or
        -not (Test-HmaOrdinalEqual `
            -Left ([string]$Record.oldAppRoot) `
            -Right $expectedAppRoot `
            -IgnoreCase) -or
        -not (Test-HmaOrdinalEqual `
            -Left ([string]$Install.nodePath) `
            -Right ([string]$Record.oldNodePath) `
            -IgnoreCase) -or
        [int]$Install.port -ne [int]$Record.oldPort -or
        -not (Test-HmaOrdinalEqual `
            -Left ([string]$Install.upstreamBase) `
            -Right ([string]$Record.oldUpstreamBase) `
            ) -or
        -not (Test-HmaOrdinalEqual `
            -Left ([string]$Install.commit) `
            -Right ([string]$Record.oldCommit)) -or
        -not (Test-HmaOrdinalEqual `
            -Left ([string]$Install.manifestSha256) `
            -Right ([string]$Record.oldManifestSha256) `
            -IgnoreCase)) {
        throw 'The rollback configuration is invalid.'
    }
    Assert-HmaExactProperties `
        -InputObject $Install.bootstrapHashes `
        -Expected @($script:bootstrapHashFiles.Keys)
    foreach ($name in $script:bootstrapHashFiles.Keys) {
        $actual = Get-HmaPropertyString `
            -InputObject $Install.bootstrapHashes `
            -Name $name
        $expected = Get-HmaPropertyString `
            -InputObject $Record.oldBootstrapHashes `
            -Name $name
        if (-not (Test-HmaOrdinalEqual `
                -Left $actual `
                -Right $expected `
                -IgnoreCase)) {
            throw 'The rollback bootstrap hashes are invalid.'
        }
    }
}

function Add-HmaInvalidRollbackSourceCandidate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [Parameter(Mandatory)][string]$OldRoot,
        [Parameter(Mandatory)]$Destination
    )

    if (-not [IO.File]::Exists($LiteralPath) -and
        -not [IO.Directory]::Exists($LiteralPath)) {
        return
    }
    $candidateFull = [IO.Path]::GetFullPath($LiteralPath)
    if (Test-HmaOrdinalEqual `
            -Left ([IO.Path]::GetDirectoryName($candidateFull)) `
            -Right ([IO.Path]::GetFullPath($OldRoot)) `
            -IgnoreCase) {
        [void]$Destination.Add($candidateFull)
    }
}

function Get-HmaAuthenticatedRollbackInstall {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]]$Candidates,
        [Parameter(Mandatory)]$Record,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$OldRoot
    )

    $invalid = New-Object 'Collections.Generic.List[string]'
    foreach ($candidate in $Candidates) {
        try {
            if (-not [IO.File]::Exists($candidate)) { continue }
            $path = Get-HmaVerifiedExistingPath -LiteralPath $candidate -File
            if (-not (Test-HmaOrdinalEqual `
                    -Left (Get-HmaSha256 -LiteralPath $path) `
                    -Right ([string]$Record.oldInstallSha256) `
                    -IgnoreCase)) {
                Add-HmaInvalidRollbackSourceCandidate `
                    -LiteralPath $candidate `
                    -OldRoot $OldRoot `
                    -Destination $invalid
                continue
            }
            $install = ConvertFrom-Json `
                -InputObject ([IO.File]::ReadAllText($path)) `
                -ErrorAction Stop
            Assert-HmaRollbackInstallConfiguration `
                -Install $install `
                -Record $Record `
                -StateRoot $StateRoot
            return [pscustomobject]@{
                Path = $path
                Value = $install
                InvalidPaths = $invalid.ToArray()
            }
        } catch {
            Add-HmaInvalidRollbackSourceCandidate `
                -LiteralPath $candidate `
                -OldRoot $OldRoot `
                -Destination $invalid
        }
    }
    throw 'No authenticated rollback configuration is available.'
}

function Get-HmaAuthenticatedRollbackManifest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]]$Candidates,
        [Parameter(Mandatory)]$Record,
        [Parameter(Mandatory)][string]$OldRoot
    )

    $invalid = New-Object 'Collections.Generic.List[string]'
    foreach ($candidate in $Candidates) {
        try {
            if (-not [IO.File]::Exists($candidate)) { continue }
            $path = Get-HmaVerifiedExistingPath -LiteralPath $candidate -File
            if (-not (Test-HmaOrdinalEqual `
                    -Left (Get-HmaSha256 -LiteralPath $path) `
                    -Right ([string]$Record.oldManifestSha256) `
                    -IgnoreCase)) {
                Add-HmaInvalidRollbackSourceCandidate `
                    -LiteralPath $candidate `
                    -OldRoot $OldRoot `
                    -Destination $invalid
                continue
            }
            $manifest = ConvertFrom-Json `
                -InputObject ([IO.File]::ReadAllText($path)) `
                -ErrorAction Stop
            Assert-HmaExactProperties `
                -InputObject $manifest `
                -Expected @(
                    'commit',
                    'nodeSha256',
                    'installerSha256',
                    'runtimeFiles',
                    'bootstrapFiles'
                )
            if (-not (Test-HmaOrdinalEqual `
                    -Left ([string]$manifest.commit) `
                    -Right ([string]$Record.oldCommit))) {
                Add-HmaInvalidRollbackSourceCandidate `
                    -LiteralPath $candidate `
                    -OldRoot $OldRoot `
                    -Destination $invalid
                continue
            }
            return [pscustomobject]@{
                Path = $path
                Value = $manifest
                InvalidPaths = $invalid.ToArray()
            }
        } catch {
            Add-HmaInvalidRollbackSourceCandidate `
                -LiteralPath $candidate `
                -OldRoot $OldRoot `
                -Destination $invalid
        }
    }
    throw 'No authenticated rollback manifest is available.'
}

function Get-HmaAuthenticatedRollbackTree {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]]$Candidates,
        [Parameter(Mandatory)]$Entries,
        [Parameter(Mandatory)][string]$OldRoot
    )

    $invalid = New-Object 'Collections.Generic.List[string]'
    foreach ($candidate in $Candidates) {
        try {
            if (-not [IO.Directory]::Exists($candidate)) { continue }
            Assert-HmaInstalledEntries -Root $candidate -Entries $Entries
            return [pscustomobject]@{
                Path = Get-HmaVerifiedExistingPath -LiteralPath $candidate -Directory
                InvalidPaths = $invalid.ToArray()
            }
        } catch {
            Add-HmaInvalidRollbackSourceCandidate `
                -LiteralPath $candidate `
                -OldRoot $OldRoot `
                -Destination $invalid
        }
    }
    throw 'No authenticated rollback tree is available.'
}

function Get-HmaAuthenticatedRollbackLauncher {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]]$Candidates,
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)][string]$ExpectedSha256,
        [Parameter(Mandatory)][string]$OldRoot
    )

    $invalid = New-Object 'Collections.Generic.List[string]'
    foreach ($candidate in $Candidates) {
        try {
            if (-not [IO.File]::Exists($candidate)) { continue }
            $path = Get-HmaVerifiedExistingPath -LiteralPath $candidate -File
            if (-not (Test-HmaOrdinalEqual `
                    -Left (Get-HmaSha256 -LiteralPath $path) `
                    -Right $ExpectedSha256 `
                    -IgnoreCase)) {
                Add-HmaInvalidRollbackSourceCandidate `
                    -LiteralPath $candidate `
                    -OldRoot $OldRoot `
                    -Destination $invalid
                continue
            }
            $candidatePlan = New-HmaLauncherPlanAtPath -Plan $Plan -Path $path
            if (-not (Test-HmaStartMenuLauncherPlan -Plan $candidatePlan)) {
                Add-HmaInvalidRollbackSourceCandidate `
                    -LiteralPath $candidate `
                    -OldRoot $OldRoot `
                    -Destination $invalid
                continue
            }
            return [pscustomobject]@{
                Path = $path
                InvalidPaths = $invalid.ToArray()
            }
        } catch {
            Add-HmaInvalidRollbackSourceCandidate `
                -LiteralPath $candidate `
                -OldRoot $OldRoot `
                -Destination $invalid
        }
    }
    throw 'No authenticated rollback launcher is available.'
}

function Move-HmaInvalidRollbackSources {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$LiteralPaths,
        [Parameter(Mandatory)][string]$OldRoot
    )

    $root = Get-HmaVerifiedExistingPath -LiteralPath $OldRoot -Directory
    $seen = @{}
    foreach ($literalPath in $LiteralPaths) {
        $fullPath = [IO.Path]::GetFullPath($literalPath)
        if ($seen.ContainsKey($fullPath)) { continue }
        $seen[$fullPath] = $true
        if (-not (Test-HmaOrdinalEqual `
                -Left ([IO.Path]::GetDirectoryName($fullPath)) `
                -Right $root `
                -IgnoreCase)) {
            throw 'A rollback quarantine path is invalid.'
        }
        $leaf = [IO.Path]::GetFileName($fullPath)
        $kind = switch -CaseSensitive ($leaf) {
            'app-original' { 'app'; break }
            'bootstrap-original' { 'bootstrap'; break }
            'install.json.original' { 'install'; break }
            'integrity.json.original' { 'integrity'; break }
            'How Much AI.original.lnk' { 'launcher'; break }
            default { throw 'A rollback quarantine path is invalid.' }
        }
        $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'A rollback quarantine source is invalid.'
        }
        $suffix = [Guid]::NewGuid().ToString('N')
        $destination = if ($kind -ceq 'launcher') {
            Join-Path $root ('quarantined-launcher-' + $suffix + '.lnk')
        } else {
            Join-Path $root ('quarantined-' + $kind + '-' + $suffix)
        }
        Move-Item -LiteralPath $fullPath -Destination $destination
    }
}

function Restore-HmaUpdateTransaction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Transaction,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)]$NewInstall,
        [Parameter(Mandatory)]$NewConfig,
        [Parameter(Mandatory)]$NewLauncherPlan,
        [Parameter(Mandatory)][string]$PowerShellPath
    )

    $oldRoot = [string]$Transaction.OldRoot
    $invalidRollbackSources = New-Object 'Collections.Generic.List[string]'
    $leaseProperty = $Transaction.PSObject.Properties['OldFileLeases']
    $liveOldFileLeases = if ($null -ne $leaseProperty) {
        $leaseProperty.Value
    } else {
        $null
    }
    if ($null -ne $liveOldFileLeases) {
        $oldInstall = $Transaction.OldInstall
        $oldManifest = $Transaction.OldManifest
        Assert-HmaRollbackInstallConfiguration `
            -Install $oldInstall `
            -Record $Transaction.Record `
            -StateRoot $StateRoot
        if (-not (Test-HmaOrdinalEqual `
                -Left ([string]$liveOldFileLeases.Install.Sha256()) `
                -Right ([string]$Transaction.Record.oldInstallSha256) `
                -IgnoreCase) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$liveOldFileLeases.Integrity.Sha256()) `
                -Right ([string]$Transaction.Record.oldManifestSha256) `
                -IgnoreCase)) {
            throw 'A retained rollback control file changed.'
        }
        $oldInstallPath = [string]$liveOldFileLeases.Install.CurrentPath
        $oldIntegrityPath = [string]$liveOldFileLeases.Integrity.CurrentPath
    } else {
        $installSource = Get-HmaAuthenticatedRollbackInstall `
            -Candidates @(
                (Join-Path $oldRoot 'install.json.original'),
                (Join-Path $oldRoot 'install.json'),
                (Join-Path $StateRoot 'install.json')
            ) `
            -Record $Transaction.Record `
            -StateRoot $StateRoot `
            -OldRoot $oldRoot
        $manifestSource = Get-HmaAuthenticatedRollbackManifest `
            -Candidates @(
                (Join-Path $oldRoot 'integrity.json.original'),
                (Join-Path $oldRoot 'integrity.json'),
                (Join-Path $StateRoot 'integrity.json')
            ) `
            -Record $Transaction.Record `
            -OldRoot $oldRoot
        foreach ($invalidPath in @($installSource.InvalidPaths) +
            @($manifestSource.InvalidPaths)) {
            [void]$invalidRollbackSources.Add([string]$invalidPath)
        }
        $oldInstallPath = [string]$installSource.Path
        $oldIntegrityPath = [string]$manifestSource.Path
        $oldInstall = $installSource.Value
        $oldManifest = $manifestSource.Value
    }
    $oldRuntimeEntries = @(
        Get-HmaValidatedManifestEntries -Entries $oldManifest.runtimeFiles -Kind runtime
    )
    $oldBootstrapEntries = @(
        Get-HmaValidatedManifestEntries -Entries $oldManifest.bootstrapFiles -Kind bootstrap
    )
    $oldAppRoot = Join-Path `
        (Join-Path $StateRoot 'runtime') `
        ([string]$Transaction.Record.oldCommit)
    $bootstrapRoot = Join-Path $StateRoot 'bootstrap'
    $oldAppSelection = Get-HmaAuthenticatedRollbackTree `
        -Candidates @(
            $oldAppRoot,
            (Join-Path $oldRoot 'app-original'),
            (Join-Path $oldRoot 'app')
        ) `
        -Entries $oldRuntimeEntries `
        -OldRoot $oldRoot
    $oldBootstrapSelection = Get-HmaAuthenticatedRollbackTree `
        -Candidates @(
            $bootstrapRoot,
            (Join-Path $oldRoot 'bootstrap-original'),
            (Join-Path $oldRoot 'bootstrap')
        ) `
        -Entries $oldBootstrapEntries `
        -OldRoot $oldRoot
    foreach ($invalidPath in @($oldAppSelection.InvalidPaths) +
        @($oldBootstrapSelection.InvalidPaths)) {
        [void]$invalidRollbackSources.Add([string]$invalidPath)
    }
    $oldAppSource = [string]$oldAppSelection.Path
    $oldBootstrapSource = [string]$oldBootstrapSelection.Path

    $currentTaskRecords = @{}
    $currentTasksMatchNew = @{}
    foreach ($taskName in $script:registeredTaskNames) {
        $current = Get-HmaTaskVerificationRecord -TaskName $taskName
        $currentTaskRecords[$taskName] = $current
        $currentTasksMatchNew[$taskName] = (
            $null -ne $current -and
            (Test-HmaRegisteredTaskPlan `
                -Task $current `
                -Config $NewConfig `
                -StateRoot $StateRoot)
        )
    }
    $launcherLeaseAtLive = (
        $null -ne $liveOldFileLeases -and
        (Test-HmaOrdinalEqual `
            -Left ([string]$liveOldFileLeases.Launcher.CurrentPath) `
            -Right ([string]$NewLauncherPlan.Path) `
            -IgnoreCase)
    )
    $currentLauncherMatchesNew = (
        -not $launcherLeaseAtLive -and
        [IO.File]::Exists([string]$NewLauncherPlan.Path) -and
        (Test-HmaStartMenuLauncherPlan -Plan $NewLauncherPlan)
    )

    Import-Module `
        (Join-Path $oldBootstrapSource 'SecureLocalRuntime.psm1') `
        -Force `
        -ErrorAction Stop
    $oldTaskPlans = @(
        New-HmaTaskPlans `
            -BootstrapRoot (Join-Path $StateRoot 'bootstrap') `
            -StateRoot $StateRoot `
            -PowerShellPath $PowerShellPath `
            -BootstrapHashes $oldInstall.bootstrapHashes
    )
    if ($oldTaskPlans.Count -ne 2) {
        throw 'The rollback task plans are invalid.'
    }
    $oldLauncherPlan = New-HmaStartMenuLauncherPlan `
        -StateRoot $StateRoot `
        -PowerShellPath $PowerShellPath `
        -IntegrityHash ([string]$oldInstall.bootstrapHashes.integrity) `
        -LauncherHash ([string]$oldInstall.bootstrapHashes.launcher)
    $oldLauncherSource = if ($null -ne $liveOldFileLeases) {
        if (-not (Test-HmaOrdinalEqual `
                -Left ([string]$liveOldFileLeases.Launcher.Sha256()) `
                -Right ([string]$Transaction.Record.oldLauncherSha256) `
                -IgnoreCase)) {
            throw 'The retained rollback launcher changed.'
        }
        $liveOldFileLeases.Launcher
    } else {
        $launcherSelection = Get-HmaAuthenticatedRollbackLauncher `
            -Candidates @(
                (Join-Path $oldRoot 'How Much AI.original.lnk'),
                (Join-Path $oldRoot 'How Much AI.lnk'),
                ([string]$oldLauncherPlan.Path)
            ) `
            -Plan $oldLauncherPlan `
            -ExpectedSha256 ([string]$Transaction.Record.oldLauncherSha256) `
            -OldRoot $oldRoot
        foreach ($invalidPath in @($launcherSelection.InvalidPaths)) {
            [void]$invalidRollbackSources.Add([string]$invalidPath)
        }
        [string]$launcherSelection.Path
    }
    Move-HmaInvalidRollbackSources `
        -LiteralPaths @($invalidRollbackSources) `
        -OldRoot $oldRoot
    foreach ($taskName in $script:registeredTaskNames) {
        $current = $currentTaskRecords[$taskName]
        $matchesOld = (
            $null -ne $current -and
            (Test-HmaRegisteredTaskPlan `
                -Task $current `
                -Config $oldInstall `
                -StateRoot $StateRoot)
        )
        if ($null -ne $current -and
            -not $matchesOld -and
            -not [bool]$currentTasksMatchNew[$taskName]) {
            throw 'A scheduled task changed during rollback.'
        }
        if ($null -ne $current) {
            $null = Assert-HmaTaskFingerprintUnchanged -ExpectedTask $current
            Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
        }
    }
    $launcherPath = [string]$NewLauncherPlan.Path
    $currentLauncherMatchesOld = (
        $launcherLeaseAtLive -or
        ([IO.File]::Exists($launcherPath) -and
        (Test-HmaStartMenuLauncherPlan -Plan $oldLauncherPlan)
        )
    )
    if ([IO.File]::Exists($launcherPath) -and
        -not $currentLauncherMatchesOld -and
        -not $currentLauncherMatchesNew) {
        throw 'The Start-menu launcher changed during rollback.'
    }

    $newAppRoot = [string]$NewInstall.appRoot
    if ([IO.Directory]::Exists($newAppRoot)) {
        $null = Get-HmaNoFollowTree -Root $newAppRoot
        Move-Item `
            -LiteralPath $newAppRoot `
            -Destination (Join-Path $oldRoot ('failed-app-' + [Guid]::NewGuid().ToString('N')))
    } elseif ([IO.File]::Exists($newAppRoot)) {
        throw 'The updated runtime path is invalid.'
    }
    if (-not [IO.Directory]::Exists($oldAppRoot)) {
        Copy-HmaExactTree -Source $oldAppSource -Destination $oldAppRoot
    }
    Assert-HmaInstalledEntries -Root $oldAppRoot -Entries $oldRuntimeEntries

    if ([IO.Directory]::Exists($bootstrapRoot)) {
        $bootstrapIsOld = $true
        try {
            Assert-HmaInstalledEntries -Root $bootstrapRoot -Entries $oldBootstrapEntries
        } catch {
            $bootstrapIsOld = $false
        }
        if (-not $bootstrapIsOld) {
            $null = Get-HmaNoFollowTree -Root $bootstrapRoot
            Move-Item `
                -LiteralPath $bootstrapRoot `
                -Destination (Join-Path $oldRoot ('failed-bootstrap-' + [Guid]::NewGuid().ToString('N')))
        }
    } elseif ([IO.File]::Exists($bootstrapRoot)) {
        throw 'The bootstrap rollback path is invalid.'
    }
    if (-not [IO.Directory]::Exists($bootstrapRoot)) {
        Copy-HmaExactTree -Source $oldBootstrapSource -Destination $bootstrapRoot
    }
    Assert-HmaInstalledEntries -Root $bootstrapRoot -Entries $oldBootstrapEntries

    foreach ($name in @('integrity.json', 'install.json')) {
        $destination = Join-Path $StateRoot $name
        $oldFile = if ($name -ceq 'install.json') {
            $oldInstallPath
        } else {
            $oldIntegrityPath
        }
        $oldHash = if ($name -ceq 'install.json') {
            [string]$Transaction.Record.oldInstallSha256
        } else {
            [string]$Transaction.Record.oldManifestSha256
        }
        $oldLease = if ($null -eq $liveOldFileLeases) {
            $null
        } elseif ($name -ceq 'install.json') {
            $liveOldFileLeases.Install
        } else {
            $liveOldFileLeases.Integrity
        }
        $currentHash = if ([IO.File]::Exists($destination)) {
            if ($null -ne $oldLease -and
                (Test-HmaOrdinalEqual `
                    -Left ([string]$oldLease.CurrentPath) `
                    -Right $destination `
                    -IgnoreCase)) {
                [string]$oldLease.Sha256()
            } else {
                Get-HmaSha256 -LiteralPath $destination
            }
        } else {
            ''
        }
        $newFile = Join-Path ([string]$Transaction.CandidateRoot) $name
        $newHash = if ([IO.File]::Exists($newFile)) {
            Get-HmaSha256 -LiteralPath $newFile
        } elseif ($name -ceq 'integrity.json') {
            [string]$NewInstall.manifestSha256
        } elseif ($name -ceq 'install.json') {
            $newInstallBytes = (New-Object Text.UTF8Encoding($false)).GetBytes(
                (ConvertTo-Json -InputObject $NewInstall -Depth 8 -Compress)
            )
            try {
                Get-HmaBytesSha256 -Bytes $newInstallBytes
            } finally {
                [Array]::Clear($newInstallBytes, 0, $newInstallBytes.Length)
            }
        } else {
            ''
        }
        if ($currentHash -ne '' -and
            -not (Test-HmaOrdinalEqual -Left $currentHash -Right $oldHash -IgnoreCase) -and
            ($newHash -eq '' -or
                -not (Test-HmaOrdinalEqual -Left $currentHash -Right $newHash -IgnoreCase))) {
            throw 'A control file changed during rollback.'
        }
        if (-not (Test-HmaOrdinalEqual -Left $currentHash -Right $oldHash -IgnoreCase)) {
            if ([IO.File]::Exists($destination)) {
                Move-Item `
                    -LiteralPath $destination `
                    -Destination (Join-Path $oldRoot ($name + '.failed-' + [Guid]::NewGuid().ToString('N')))
            }
            if ($null -ne $oldLease) {
                $oldLease.CopyTo($destination)
                Set-HmaPrivateAcl -LiteralPath $destination
            } else {
                Copy-HmaExactFile -Source $oldFile -Destination $destination
            }
        }
    }

    if ($currentLauncherMatchesNew) {
        Move-Item `
            -LiteralPath $launcherPath `
            -Destination (Join-Path $oldRoot ('failed-launcher-' + [Guid]::NewGuid().ToString('N') + '.lnk'))
    }
    if (-not [IO.File]::Exists($launcherPath)) {
        if ($null -ne $liveOldFileLeases) {
            $oldLauncherSource.CopyTo($launcherPath)
        } else {
            Copy-HmaExactFile `
                -Source $oldLauncherSource `
                -Destination $launcherPath
        }
    }
    Set-HmaPrivateAcl -LiteralPath $launcherPath
    foreach ($oldPlan in @($oldTaskPlans)) {
        $taskName = [string]$oldPlan.Name
        $current = Get-HmaTaskVerificationRecord -TaskName $taskName
        $matchesOld = (
            $null -ne $current -and
            (Test-HmaRegisteredTaskPlan `
                -Task $current `
                -Config $oldInstall `
                -StateRoot $StateRoot)
        )
        $matchesNew = (
            $null -ne $current -and
            (Test-HmaRegisteredTaskPlan `
                -Task $current `
                -Config $NewConfig `
                -StateRoot $StateRoot)
        )
        if ($null -ne $current -and -not $matchesOld -and -not $matchesNew) {
            throw 'A scheduled task changed during rollback.'
        }
        if ($matchesNew) {
            $null = Assert-HmaTaskFingerprintUnchanged -ExpectedTask $current
            Unregister-ScheduledTask `
                -TaskName $taskName `
                -Confirm:$false `
                -ErrorAction Stop
            if ($null -ne (Get-HmaTaskVerificationRecord -TaskName $taskName)) {
                throw 'A scheduled task destination is occupied.'
            }
            $current = $null
        }
        if ($null -eq $current) {
            Register-HmaExactTaskPlans -Plans @($oldPlan)
        }
        $restoredTask = Get-HmaTaskVerificationRecord -TaskName $taskName
        if ($null -eq $restoredTask -or
            -not (Test-HmaRegisteredTaskPlan `
                -Task $restoredTask `
                -Config $oldInstall `
                -StateRoot $StateRoot)) {
            throw 'A rolled-back scheduled task did not round-trip exactly.'
        }
    }
    foreach ($taskName in $script:registeredTaskNames) {
        $current = Get-HmaTaskVerificationRecord -TaskName $taskName
        if ($null -eq $current -or
            -not (Test-HmaRegisteredTaskPlan `
                -Task $current `
                -Config $oldInstall `
                -StateRoot $StateRoot)) {
            throw 'A scheduled task changed during rollback.'
        }
        $null = Assert-HmaTaskFingerprintUnchanged -ExpectedTask $current
        Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    }
    if ($null -ne $liveOldFileLeases) {
        Exit-HmaUpdateFileLeases -Leases @(
            $liveOldFileLeases.Install,
            $liveOldFileLeases.Integrity,
            $liveOldFileLeases.Launcher
        )
    }
    Import-Module `
        (Join-Path $bootstrapRoot 'SecureLocalIntegrity.psm1') `
        -Force `
        -ErrorAction Stop
    $restored = Assert-HmaStartupIntegrity -StateRoot $StateRoot
    Assert-HmaStableOfflineUpdateQuiescent `
        -Config $restored `
        -StateRoot $StateRoot `
        -LauncherPlan $oldLauncherPlan
    Set-HmaUpdatePhase -Transaction $Transaction -Phase 'rolled-back'
    return $restored
}

try {
    if ($null -eq ('HmaInstaller.FileIdentity' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace HmaInstaller
{
    public static class FileIdentity
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public uint CreationTimeLow;
            public uint CreationTimeHigh;
            public uint LastAccessTimeLow;
            public uint LastAccessTimeHigh;
            public uint LastWriteTimeLow;
            public uint LastWriteTimeHigh;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            IntPtr fileHandle,
            out ByHandleFileInformation information);

        public static string Get(string path)
        {
            using (FileStream stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete))
            {
                ByHandleFileInformation information;
                if (!GetFileInformationByHandle(
                    stream.SafeFileHandle.DangerousGetHandle(),
                    out information))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                return String.Format(
                    "{0:x8}:{1:x8}:{2:x8}",
                    information.VolumeSerialNumber,
                    information.FileIndexHigh,
                    information.FileIndexLow);
            }
        }
    }

    public sealed class FileLease : IDisposable
    {
        private const uint GenericRead = 0x80000000;
        private const uint Delete = 0x00010000;
        private const uint FileShareRead = 0x00000001;
        private const uint OpenExisting = 3;
        private const uint FileAttributeNormal = 0x00000080;
        private const uint OpenReparsePoint = 0x00200000;
        private const uint ReparsePointAttribute = 0x00000400;
        private const int FileRenameInfo = 3;

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public uint CreationTimeLow;
            public uint CreationTimeHigh;
            public uint LastAccessTimeLow;
            public uint LastAccessTimeHigh;
            public uint LastWriteTimeLow;
            public uint LastWriteTimeHigh;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle fileHandle,
            out ByHandleFileInformation information);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(
            SafeFileHandle fileHandle,
            int fileInformationClass,
            IntPtr fileInformation,
            uint bufferSize);

        private SafeFileHandle handle;
        private FileStream stream;
        private string currentPath;
        private readonly string identity;

        private FileLease(string path)
        {
            handle = CreateFile(
                path,
                GenericRead | Delete,
                FileShareRead,
                IntPtr.Zero,
                OpenExisting,
                FileAttributeNormal | OpenReparsePoint,
                IntPtr.Zero);
            if (handle.IsInvalid)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            ByHandleFileInformation information;
            if (!GetFileInformationByHandle(handle, out information))
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error);
            }
            if ((information.FileAttributes & ReparsePointAttribute) != 0)
            {
                handle.Dispose();
                throw new InvalidOperationException("Reparse points are not permitted.");
            }
            identity = String.Format(
                "{0:x8}:{1:x8}:{2:x8}",
                information.VolumeSerialNumber,
                information.FileIndexHigh,
                information.FileIndexLow);
            stream = new FileStream(handle, FileAccess.Read);
            currentPath = path;
        }

        public static FileLease Open(string path)
        {
            return new FileLease(path);
        }

        public string CurrentPath { get { return currentPath; } }
        public string Identity { get { return identity; } }

        public string Sha256()
        {
            long originalPosition = stream.Position;
            try
            {
                stream.Position = 0;
                using (SHA256 algorithm = SHA256.Create())
                {
                    byte[] hash = algorithm.ComputeHash(stream);
                    return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
                }
            }
            finally
            {
                stream.Position = originalPosition;
            }
        }

        public void MoveTo(string destination)
        {
            if (String.IsNullOrWhiteSpace(destination) || !Path.IsPathRooted(destination))
            {
                throw new ArgumentException("The destination path is invalid.");
            }
            byte[] nameBytes = System.Text.Encoding.Unicode.GetBytes(destination);
            int rootOffset = IntPtr.Size == 8 ? 8 : 4;
            int lengthOffset = rootOffset + IntPtr.Size;
            int nameOffset = lengthOffset + 4;
            int bufferLength = nameOffset + nameBytes.Length + 2;
            IntPtr buffer = Marshal.AllocHGlobal(bufferLength);
            try
            {
                for (int index = 0; index < bufferLength; index += 1)
                {
                    Marshal.WriteByte(buffer, index, 0);
                }
                Marshal.WriteByte(buffer, 0, 0);
                Marshal.WriteIntPtr(buffer, rootOffset, IntPtr.Zero);
                Marshal.WriteInt32(buffer, lengthOffset, nameBytes.Length);
                Marshal.Copy(nameBytes, 0, IntPtr.Add(buffer, nameOffset), nameBytes.Length);
                if (!SetFileInformationByHandle(
                    handle,
                    FileRenameInfo,
                    buffer,
                    (uint)bufferLength))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                currentPath = destination;
            }
            finally
            {
                Array.Clear(nameBytes, 0, nameBytes.Length);
                Marshal.FreeHGlobal(buffer);
            }
        }

        public void CopyTo(string destination)
        {
            long originalPosition = stream.Position;
            try
            {
                stream.Position = 0;
                using (FileStream destinationStream = new FileStream(
                    destination,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None))
                {
                    stream.CopyTo(destinationStream);
                    destinationStream.Flush(true);
                }
            }
            finally
            {
                stream.Position = originalPosition;
            }
        }

        public void Dispose()
        {
            if (stream != null)
            {
                stream.Dispose();
                stream = null;
                handle = null;
            }
        }
    }
}
'@ -ErrorAction Stop
    }
    if ($PSVersionTable.PSEdition -cne 'Desktop' -or
        $PSVersionTable.PSVersion.Major -ne 5 -or
        $PSVersionTable.PSVersion.Minor -lt 1) {
        throw 'Windows PowerShell 5.1 is required.'
    }
    $source = Get-HmaVerifiedExistingPath -LiteralPath $SourceRoot -Directory
    $state = Get-HmaVerifiedStatePath -LiteralPath $StateRoot
    if ($state.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $source.StartsWith($state + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The source and state paths overlap.'
    }

    $nodePath = Get-HmaVerifiedExistingPath -LiteralPath $NodePath -File
    $powerShellPath = Get-HmaVerifiedExistingPath -LiteralPath $Ps51Path -File
    $programFilesRoot = [IO.Path]::Combine(
        [IO.Path]::GetPathRoot([Environment]::SystemDirectory),
        'Program Files'
    )
    $windowsRoot = [IO.Directory]::GetParent(
        [Environment]::SystemDirectory
    ).FullName
    $expectedNodePath = [IO.Path]::Combine(
        $programFilesRoot,
        'nodejs',
        'node.exe'
    )
    $expectedPowerShellPath = [IO.Path]::Combine(
        [Environment]::SystemDirectory,
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
    )
    if (-not (Test-HmaOrdinalEqual `
            -Left $nodePath `
            -Right $expectedNodePath `
            -IgnoreCase) -or
        -not (Test-HmaOrdinalEqual `
            -Left $powerShellPath `
            -Right $expectedPowerShellPath `
            -IgnoreCase)) {
        throw 'A retained executable path is invalid.'
    }
    Assert-HmaTrustedExecutableAcl `
        -FilePath $nodePath `
        -TrustedRoot $programFilesRoot
    Assert-HmaTrustedExecutableAcl `
        -FilePath $powerShellPath `
        -TrustedRoot $windowsRoot
    $nodeLock = [IO.File]::Open(
        $nodePath,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )
    $ps51Lock = [IO.File]::Open(
        $powerShellPath,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )
    if (-not (Test-HmaOrdinalEqual `
            -Left (Get-HmaLockedStreamSha256 -Stream $nodeLock) `
            -Right $ExpectedNodeSha256 `
            -IgnoreCase) -or
        -not (Test-HmaOrdinalEqual `
            -Left (Get-HmaLockedStreamSha256 -Stream $ps51Lock) `
            -Right $ExpectedPs51Sha256 `
            -IgnoreCase)) {
        throw 'A retained executable changed.'
    }

    $auditRoot = Join-Path $source 'audit\final'
    $commitPath = Get-HmaVerifiedExistingPath `
        -LiteralPath (Join-Path $auditRoot 'final-commit.txt') `
        -File
    $reviewedCommit = [IO.File]::ReadAllText($commitPath).Trim()
    if ($reviewedCommit -cnotmatch '^[a-fA-F0-9]{40}$') {
        throw 'The reviewed commit is invalid.'
    }
    $head = $reviewedCommit

    $manifestHashPath = Get-HmaVerifiedExistingPath `
        -LiteralPath (Join-Path $auditRoot 'runtime-manifest.sha256') `
        -File
    $rawExpectedHash = [IO.File]::ReadAllText($manifestHashPath)
    if ($rawExpectedHash.Length -ne 64 -or
        -not (Test-HmaOrdinalEqual `
            -Left $rawExpectedHash `
            -Right $ExpectedManifestSha256 `
            -IgnoreCase)) {
        throw 'The reviewed manifest hash is invalid.'
    }
    $manifestPath = Get-HmaVerifiedExistingPath `
        -LiteralPath (Join-Path $auditRoot 'runtime-manifest.json') `
        -File
    if (-not (Test-HmaOrdinalEqual `
            -Left (Get-HmaSha256 -LiteralPath $manifestPath) `
            -Right $ExpectedManifestSha256 `
            -IgnoreCase)) {
        throw 'The reviewed manifest is invalid.'
    }
    $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
    try {
        if ($manifestBytes.Length -le 0 -or
            $manifestBytes.Length -gt 67108864 -or
            -not (Test-HmaOrdinalEqual `
                -Left (Get-HmaBytesSha256 -Bytes $manifestBytes) `
                -Right $ExpectedManifestSha256 `
                -IgnoreCase)) {
            throw 'The reviewed manifest is invalid.'
        }
        $utf8 = New-Object Text.UTF8Encoding($false, $true)
        $manifestText = $utf8.GetString($manifestBytes)
        $manifest = ConvertFrom-Json -InputObject $manifestText -ErrorAction Stop
    } catch {
        throw 'The reviewed manifest is invalid.'
    }
    Assert-HmaExactProperties `
        -InputObject $manifest `
        -Expected @(
            'commit',
            'nodeSha256',
            'installerSha256',
            'runtimeFiles',
            'bootstrapFiles'
        )
    if ($manifest.commit -isnot [string] -or
        -not (Test-HmaOrdinalEqual -Left ([string]$manifest.commit) -Right $head)) {
        throw 'The reviewed manifest revision is invalid.'
    }
    Assert-HmaSha256 -Value $manifest.nodeSha256
    Assert-HmaSha256 -Value $manifest.installerSha256
    if (-not (Test-HmaOrdinalEqual `
            -Left (Get-HmaLockedStreamSha256 -Stream $nodeLock) `
            -Right ([string]$manifest.nodeSha256) `
            -IgnoreCase)) {
        throw 'The Node executable is invalid.'
    }
    $runtimeEntries = @(
        Get-HmaValidatedManifestEntries -Entries $manifest.runtimeFiles -Kind runtime
    )
    $bootstrapEntries = @(
        Get-HmaValidatedManifestEntries -Entries $manifest.bootstrapFiles -Kind bootstrap
    )
    if (-not (Test-HmaExactStringSet `
            -Expected @($bootstrapHashFiles.Values) `
            -Actual @($bootstrapEntries | ForEach-Object {
                    [string]$_.InstalledPath
                }))) {
        throw 'The bootstrap manifest file set is invalid.'
    }
    $allSourceEntries = @($runtimeEntries) + @($bootstrapEntries)
    $sourceEntryLocks = Enter-HmaSourceEntryLease `
        -Source $source `
        -Entries $allSourceEntries
    Assert-HmaSourceEntries `
        -Source $source `
        -RuntimeEntries $runtimeEntries `
        -BootstrapEntries $bootstrapEntries

    $runtimeParent = Join-Path $state 'runtime'
    $appRoot = Join-Path $runtimeParent $head
    $bootstrapRoot = Join-Path $state 'bootstrap'
    $bootstrapHashes = [ordered]@{}
    foreach ($hashName in $bootstrapHashFiles.Keys) {
        $bootstrapHashes[$hashName] = Get-HmaBootstrapHash `
            -Entries $bootstrapEntries `
            -FileName ([string]$bootstrapHashFiles[$hashName])
    }
    $install = [ordered]@{
        version = 1
        appRoot = $appRoot
        stateRoot = $state
        nodePath = $nodePath
        port = 37645
        upstreamBase = $upstreamBase
        commit = $head
        manifestSha256 = $ExpectedManifestSha256.ToLowerInvariant()
        bootstrapHashes = $bootstrapHashes
    }
    $installText = ConvertTo-Json -InputObject $install -Depth 8 -Compress
    $installBytes = (New-Object Text.UTF8Encoding($false)).GetBytes($installText)

    Import-HmaReviewedSourceModule `
        -Source $source `
        -Entries $bootstrapEntries `
        -FileName 'SecureLocalIntegrity.psm1'
    Import-HmaReviewedSourceModule `
        -Source $source `
        -Entries $bootstrapEntries `
        -FileName 'SecureLocalSecrets.psm1'
    $secretsPath = Join-Path $state 'secrets.dpapi'
    $updatePaths = Get-HmaUpdateTransactionPaths -StateRoot $state
    $stateExists = [IO.Directory]::Exists($state)
    if (-not $stateExists -and
        $PSBoundParameters.ContainsKey('ExpectedInstalledManifestSha256')) {
        throw 'An installed manifest cannot be expected for a fresh state.'
    }

    $updateOrphans = @(Get-HmaUpdateOrphanRoots -StateRoot $state)
    if ($stateExists -and
        ($updateOrphans.Count -gt 0 -or
            [IO.File]::Exists([string]$updatePaths.JournalRoot))) {
        if ($null -eq $updateLock) {
            $updateLock = Enter-HmaUpdateLock -LiteralPath ([string]$updatePaths.LockPath)
        }
        Remove-HmaUpdateOrphanRoots -StateRoot $state
        if ([IO.File]::Exists([string]$updatePaths.JournalRoot)) {
            throw 'The update journal path is invalid.'
        }
    }

    $publishedJournalReady = $false
    if ($stateExists -and [IO.Directory]::Exists([string]$updatePaths.JournalRoot)) {
        if (-not $PSBoundParameters.ContainsKey('ExpectedInstalledManifestSha256')) {
            throw 'The interrupted update requires its installed manifest anchor.'
        }
        if ($null -eq $updateLock) {
            $updateLock = Enter-HmaUpdateLock -LiteralPath ([string]$updatePaths.LockPath)
        }
        Remove-HmaUpdateOrphanRoots -StateRoot $state
        $publishedJournalReady = Repair-HmaPublishedUpdateJournal `
            -JournalRoot ([string]$updatePaths.JournalRoot) `
            -StateRoot $state
    }
    if ($publishedJournalReady) {
        $journal = Get-HmaUpdateJournal -JournalRoot ([string]$updatePaths.JournalRoot)
        if (-not (Test-HmaOrdinalEqual `
                -Left ([string]$journal.stateRoot) `
                -Right $state `
                -IgnoreCase) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$journal.oldManifestSha256) `
                -Right $ExpectedInstalledManifestSha256 `
                -IgnoreCase) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$journal.newManifestSha256) `
                -Right $ExpectedManifestSha256 `
                -IgnoreCase) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$journal.newCommit) `
                -Right $head)) {
            throw 'The interrupted update anchors differ.'
        }
        if ([string]$journal.phase -ceq 'staging') {
            Remove-HmaUpdateRoot `
                -LiteralPath ([string]$updatePaths.JournalRoot) `
                -StateRoot $state
        } else {
            Import-HmaReviewedSourceModule `
                -Source $source `
                -Entries $bootstrapEntries `
                -FileName 'SecureLocalRuntime.psm1'
            $recoveryConfig = ConvertFrom-Json -InputObject $installText -ErrorAction Stop
            $recoveryTaskPlans = @(
                New-HmaTaskPlans `
                    -BootstrapRoot $bootstrapRoot `
                    -StateRoot $state `
                    -PowerShellPath $powerShellPath `
                    -BootstrapHashes $recoveryConfig.bootstrapHashes
            )
            $recoveryLauncherPlan = New-HmaStartMenuLauncherPlan `
                -StateRoot $state `
                -PowerShellPath $powerShellPath `
                -IntegrityHash ([string]$recoveryConfig.bootstrapHashes.integrity) `
                -LauncherHash ([string]$recoveryConfig.bootstrapHashes.launcher)
            $updateTransaction = [pscustomobject]@{
                Record = $journal
                OldRoot = Join-Path ([string]$updatePaths.JournalRoot) 'old'
                CandidateRoot = Join-Path ([string]$updatePaths.JournalRoot) 'candidate'
            }
            $updateNewInstall = $install
            $updateNewConfig = $recoveryConfig
            $updateNewLauncherPlan = $recoveryLauncherPlan
            $updateActivationStarted = $true
            $updateRollbackAttempted = $true
            $null = Restore-HmaUpdateTransaction `
                -Transaction $updateTransaction `
                -StateRoot $state `
                -NewInstall $install `
                -NewConfig $recoveryConfig `
                -NewLauncherPlan $recoveryLauncherPlan `
                -PowerShellPath $powerShellPath
            Remove-HmaUpdateRoot `
                -LiteralPath ([string]$updatePaths.JournalRoot) `
                -StateRoot $state
            $updateActivationStarted = $false
            $updateTransaction = $null
            Import-HmaReviewedSourceModule `
                -Source $source `
                -Entries $bootstrapEntries `
                -FileName 'SecureLocalIntegrity.psm1'
            Import-HmaReviewedSourceModule `
                -Source $source `
                -Entries $bootstrapEntries `
                -FileName 'SecureLocalSecrets.psm1'
        }
    }

    $isUpdate = $false
    $oldConfig = $null
    if ($stateExists) {
        $preliminaryInstall = ConvertFrom-Json `
            -InputObject ([IO.File]::ReadAllText((Join-Path $state 'install.json'))) `
            -ErrorAction Stop
        Assert-HmaExactProperties `
            -InputObject $preliminaryInstall `
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
        Assert-HmaSha256 -Value $preliminaryInstall.manifestSha256
        if (-not (Test-HmaOrdinalEqual `
                -Left ([string]$preliminaryInstall.manifestSha256) `
                -Right $ExpectedManifestSha256 `
                -IgnoreCase)) {
            if (Test-HmaOrdinalEqual `
                    -Left ([string]$preliminaryInstall.commit) `
                    -Right $head) {
                throw 'A same-revision manifest replacement is not permitted.'
            }
            if (-not $PSBoundParameters.ContainsKey('ExpectedInstalledManifestSha256') -or
                -not (Test-HmaOrdinalEqual `
                    -Left ([string]$preliminaryInstall.manifestSha256) `
                    -Right $ExpectedInstalledManifestSha256 `
                    -IgnoreCase)) {
                throw 'The installed manifest compare-and-swap check failed.'
            }
            if ($null -eq $updateLock) {
                $updateLock = Enter-HmaUpdateLock `
                    -LiteralPath ([string]$updatePaths.LockPath)
            }
            Remove-HmaUpdateOrphanRoots -StateRoot $state
            $isUpdate = $true
        }
    }

    if ($isUpdate) {
        $oldConfig = Assert-HmaStartupIntegrity -StateRoot $state
        if (-not (Test-HmaOrdinalEqual `
                -Left ([string]$oldConfig.manifestSha256) `
                -Right $ExpectedInstalledManifestSha256 `
                -IgnoreCase) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$oldConfig.stateRoot) `
                -Right $state `
                -IgnoreCase) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$oldConfig.nodePath) `
                -Right $nodePath `
                -IgnoreCase) -or
            [int]$oldConfig.port -ne 37645 -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$oldConfig.upstreamBase) `
                -Right $upstreamBase) -or
            [int]$oldConfig.version -ne 1) {
            throw 'The installed release is incompatible with the candidate.'
        }
        $bundle = Unprotect-HmaSecretBundle -Path $secretsPath
        Import-Module `
            (Join-Path $state 'bootstrap\SecureLocalRuntime.psm1') `
            -Force `
            -ErrorAction Stop
        $oldTaskRecords = @()
        foreach ($taskName in $registeredTaskNames) {
            $oldTaskRecords += Get-HmaTaskVerificationRecord -TaskName $taskName
        }
        $oldLauncherPlan = New-HmaStartMenuLauncherPlan `
            -StateRoot $state `
            -PowerShellPath $powerShellPath `
            -IntegrityHash ([string]$oldConfig.bootstrapHashes.integrity) `
            -LauncherHash ([string]$oldConfig.bootstrapHashes.launcher)
        Assert-HmaOfflineUpdateQuiescent `
            -Config $oldConfig `
            -StateRoot $state `
            -LauncherPlan $oldLauncherPlan

        $oldInstallLease = Enter-HmaUpdateFileLease `
            -LiteralPath (Join-Path $state 'install.json') `
            -ExpectedSha256 (Get-HmaSha256 -LiteralPath (Join-Path $state 'install.json'))
        [void]$updateFileLeases.Add($oldInstallLease)
        $oldIntegrityLease = Enter-HmaUpdateFileLease `
            -LiteralPath (Join-Path $state 'integrity.json') `
            -ExpectedSha256 ([string]$oldConfig.manifestSha256)
        [void]$updateFileLeases.Add($oldIntegrityLease)
        $oldLauncherLease = Enter-HmaUpdateFileLease `
            -LiteralPath ([string]$oldLauncherPlan.Path) `
            -ExpectedSha256 (Get-HmaSha256 -LiteralPath ([string]$oldLauncherPlan.Path))
        [void]$updateFileLeases.Add($oldLauncherLease)
        $oldFileLeases = [pscustomobject]@{
            Install = $oldInstallLease
            Integrity = $oldIntegrityLease
            Launcher = $oldLauncherLease
        }

        Import-HmaReviewedSourceModule `
            -Source $source `
            -Entries $bootstrapEntries `
            -FileName 'SecureLocalRuntime.psm1'
        $newConfig = ConvertFrom-Json -InputObject $installText -ErrorAction Stop
        $newTaskPlans = @(
            New-HmaTaskPlans `
                -BootstrapRoot $bootstrapRoot `
                -StateRoot $state `
                -PowerShellPath $powerShellPath `
                -BootstrapHashes $newConfig.bootstrapHashes
        )
        if ($newTaskPlans.Count -ne 2) {
            throw 'The candidate scheduled-task plans are invalid.'
        }
        $newLauncherPlan = New-HmaStartMenuLauncherPlan `
            -StateRoot $state `
            -PowerShellPath $powerShellPath `
            -IntegrityHash ([string]$newConfig.bootstrapHashes.integrity) `
            -LauncherHash ([string]$newConfig.bootstrapHashes.launcher)

        $allLockedStreams = @($sourceEntryLocks)
        $runtimeLockedStreams = New-Object 'Collections.Generic.List[IO.FileStream]'
        for ($index = 0; $index -lt $runtimeEntries.Count; $index += 1) {
            [void]$runtimeLockedStreams.Add($allLockedStreams[$index])
        }
        $bootstrapLockedStreams = New-Object 'Collections.Generic.List[IO.FileStream]'
        for ($index = 0; $index -lt $bootstrapEntries.Count; $index += 1) {
            [void]$bootstrapLockedStreams.Add(
                $allLockedStreams[$runtimeEntries.Count + $index]
            )
        }
        $updateTransaction = Start-HmaUpdateTransaction `
            -JournalRoot ([string]$updatePaths.JournalRoot) `
            -StateRoot $state `
            -OldConfig $oldConfig `
            -OldTaskRecords $oldTaskRecords `
            -OldLauncherPlan $oldLauncherPlan `
            -OldFileLeases $oldFileLeases `
            -NewInstall $install `
            -NewInstallBytes $installBytes `
            -NewManifestBytes $manifestBytes `
            -RuntimeEntries $runtimeEntries `
            -RuntimeStreams $runtimeLockedStreams `
            -BootstrapEntries $bootstrapEntries `
            -BootstrapStreams $bootstrapLockedStreams `
            -NewTaskPlans $newTaskPlans `
            -NewLauncherPlan $newLauncherPlan
        $updateNewInstall = $install
        $updateNewConfig = $newConfig
        $updateNewLauncherPlan = $newLauncherPlan
        $stagedOldConfig = $oldConfig
        if (-not (Test-HmaOrdinalEqual `
                -Left ([string]$oldInstallLease.Sha256()) `
                -Right ([string]$updateTransaction.Record.oldInstallSha256) `
                -IgnoreCase) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$oldIntegrityLease.Sha256()) `
                -Right $ExpectedInstalledManifestSha256 `
                -IgnoreCase)) {
            throw 'The installed release changed during staging.'
        }
        Assert-HmaInstalledEntries `
            -Root ([string]$oldConfig.appRoot) `
            -Entries $updateTransaction.OldRuntimeEntries
        Assert-HmaInstalledEntries `
            -Root (Join-Path $state 'bootstrap') `
            -Entries $updateTransaction.OldBootstrapEntries
        Import-Module `
            (Join-Path $state 'bootstrap\SecureLocalRuntime.psm1') `
            -Force `
            -ErrorAction Stop
        Assert-HmaOfflineUpdateQuiescent `
            -Config $stagedOldConfig `
            -StateRoot $state `
            -LauncherPlan $oldLauncherPlan `
            -LauncherLease $oldLauncherLease `
            -ExpectedLauncherSha256 ([string]$updateTransaction.Record.oldLauncherSha256)
        Import-HmaReviewedSourceModule `
            -Source $source `
            -Entries $bootstrapEntries `
            -FileName 'SecureLocalRuntime.psm1'
        $updateActivationStarted = $true
        $null = Invoke-HmaUpdateActivation `
            -Transaction $updateTransaction `
            -StateRoot $state `
            -NewInstall $install `
            -NewTaskPlans $newTaskPlans `
            -NewLauncherPlan $newLauncherPlan
        Assert-HmaSourceEntryLease `
            -Entries $allSourceEntries `
            -Streams $sourceEntryLocks
        Exit-HmaUpdateFileLeases -Leases $updateFileLeases
        Remove-HmaUpdateRoot `
            -LiteralPath ([string]$updatePaths.JournalRoot) `
            -StateRoot $state
        $updateActivationStarted = $false
        $updateTransaction = $null
        return
    }

    if ([IO.Directory]::Exists($state)) {
        $existingConfig = Assert-HmaStartupIntegrity -StateRoot $state
        $existingInstallBytes = [IO.File]::ReadAllBytes((Join-Path $state 'install.json'))
        try {
            if (-not (Test-HmaBytesEqual `
                    -Left $existingInstallBytes `
                    -Right $installBytes)) {
                throw 'The existing install configuration differs.'
            }
        } finally {
            [Array]::Clear($existingInstallBytes, 0, $existingInstallBytes.Length)
        }
        if (-not (Test-HmaOrdinalEqual `
                -Left ([string]$existingConfig.appRoot) `
                -Right $appRoot `
                -IgnoreCase) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$existingConfig.stateRoot) `
                -Right $state `
                -IgnoreCase) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$existingConfig.nodePath) `
                -Right $nodePath `
                -IgnoreCase) -or
            [int]$existingConfig.port -ne 37645 -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$existingConfig.upstreamBase) `
                -Right $upstreamBase) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$existingConfig.commit) `
                -Right $head) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$existingConfig.manifestSha256) `
                -Right $ExpectedManifestSha256 `
                -IgnoreCase)) {
            throw 'The existing install configuration differs.'
        }
        foreach ($hashName in $bootstrapHashFiles.Keys) {
            if (-not (Test-HmaOrdinalEqual `
                    -Left ([string]$existingConfig.bootstrapHashes.$hashName) `
                    -Right ([string]$bootstrapHashes[$hashName]) `
                    -IgnoreCase)) {
                throw 'The existing install configuration differs.'
            }
        }
        $bundle = Unprotect-HmaSecretBundle -Path $secretsPath
    } else {
        [void][IO.Directory]::CreateDirectory($state)
    }
    Set-HmaPrivateAcl -LiteralPath $state
    if (-not (Test-HmaPrivateAcl -LiteralPath $state -Recurse)) {
        throw 'The state ACL is invalid.'
    }

    foreach ($directory in @($runtimeParent, $appRoot, $bootstrapRoot)) {
        if (-not [IO.Directory]::Exists($directory)) {
            [void][IO.Directory]::CreateDirectory($directory)
        }
    }
    $allLockedStreams = @($sourceEntryLocks)
    if ($allLockedStreams.Count -ne $allSourceEntries.Count) {
        throw 'A source file lease is invalid.'
    }
    $runtimeLockedStreams = New-Object 'Collections.Generic.List[IO.FileStream]'
    for ($index = 0; $index -lt $runtimeEntries.Count; $index += 1) {
        [void]$runtimeLockedStreams.Add($allLockedStreams[$index])
    }
    $bootstrapLockedStreams = New-Object 'Collections.Generic.List[IO.FileStream]'
    for ($index = 0; $index -lt $bootstrapEntries.Count; $index += 1) {
        [void]$bootstrapLockedStreams.Add(
            $allLockedStreams[$runtimeEntries.Count + $index]
        )
    }
    Copy-HmaManifestEntries `
        -Destination $appRoot `
        -Entries $runtimeEntries `
        -Streams $runtimeLockedStreams
    Copy-HmaManifestEntries `
        -Destination $bootstrapRoot `
        -Entries $bootstrapEntries `
        -Streams $bootstrapLockedStreams
    Set-HmaPrivateAcl -LiteralPath $state
    Assert-HmaInstalledEntries -Root $appRoot -Entries $runtimeEntries
    Assert-HmaInstalledEntries -Root $bootstrapRoot -Entries $bootstrapEntries
    if ([IO.Directory]::Exists((Join-Path $appRoot '.next\cache'))) {
        throw 'A mutable runtime cache is not permitted.'
    }

    $integrityPath = Join-Path $state 'integrity.json'
    Write-HmaAtomicExactBytes -Destination $integrityPath -Bytes $manifestBytes
    foreach ($directoryName in @('vault', 'edge-profile', 'oauth-temp')) {
        $directory = Join-Path $state $directoryName
        if (-not [IO.Directory]::Exists($directory)) {
            [void][IO.Directory]::CreateDirectory($directory)
        }
    }
    if (@(Get-ChildItem -LiteralPath (Join-Path $state 'oauth-temp') -Force).Count -ne 0) {
        throw 'The OAuth temporary directory is not empty.'
    }
    Set-HmaPrivateAcl -LiteralPath $state

    try {
        Write-HmaAtomicExactBytes `
            -Destination (Join-Path $state 'install.json') `
            -Bytes $installBytes
    } finally {
        [Array]::Clear($installBytes, 0, $installBytes.Length)
    }
    Set-HmaPrivateAcl -LiteralPath $state

    $installedIntegrityModule = Join-Path $bootstrapRoot 'SecureLocalIntegrity.psm1'
    Import-Module $installedIntegrityModule -Force -ErrorAction Stop
    if ($null -eq $bundle) {
        if ([IO.File]::Exists($secretsPath)) {
            throw 'An unexpected secret bundle exists.'
        }
        $bundle = [ordered]@{
            version = 1
            appPassword = New-HmaRandomSecret -ByteCount 32
            authSecret = New-HmaRandomSecret -ByteCount 32
            vaultEncryptionSecret = New-HmaRandomSecret -ByteCount 32
        }
        if ($bundle.appPassword -ceq $bundle.authSecret -or
            $bundle.appPassword -ceq $bundle.vaultEncryptionSecret -or
            $bundle.authSecret -ceq $bundle.vaultEncryptionSecret) {
            throw 'The generated bundle is invalid.'
        }
        Protect-HmaSecretBundle -Bundle $bundle -Path $secretsPath
    } elseif (-not [IO.File]::Exists($secretsPath)) {
        throw 'The existing secret bundle is missing.'
    }
    Set-HmaPrivateAcl -LiteralPath $state
    $config = Assert-HmaStartupIntegrity -StateRoot $state

    Import-Module (Join-Path $bootstrapRoot 'SecureLocalRuntime.psm1') `
        -Force `
        -ErrorAction Stop
    $taskPlans = @(
        New-HmaTaskPlans `
            -BootstrapRoot $bootstrapRoot `
            -StateRoot $state `
            -PowerShellPath $powerShellPath `
            -BootstrapHashes $config.bootstrapHashes
    )
    if ($taskPlans.Count -ne 2) {
        throw 'The scheduled-task plans are invalid.'
    }
    $launcherPlan = New-HmaStartMenuLauncherPlan `
        -StateRoot $state `
        -PowerShellPath $powerShellPath `
        -IntegrityHash ([string]$config.bootstrapHashes.integrity) `
        -LauncherHash ([string]$config.bootstrapHashes.launcher)
    Install-HmaStartMenuLauncher -Plan $launcherPlan

    $listeners = @(
        Get-NetTCPConnection `
            -State Listen `
            -ErrorAction Stop
    )
    $listeners = @($listeners | Where-Object {
            [int]$_.LocalPort -eq 37645
        })
    if ($listeners.Count -gt 0) {
        if ($listeners.Count -ne 1 -or
            [string]$listeners[0].LocalAddress -cne '127.0.0.1' -or
            [int]$listeners[0].LocalPort -ne 37645 -or
            [string]$listeners[0].State -cne 'Listen' -or
            [int]$listeners[0].OwningProcess -le 0) {
            throw 'The configured listener is already occupied.'
        }
        $existingServiceTask = Get-HmaTaskVerificationRecord `
            -TaskName 'HowMuchAI-Service'
        if ($null -eq $existingServiceTask -or
            -not (Test-HmaRegisteredTaskPlan `
                -Task $existingServiceTask `
                -Config $config `
                -StateRoot $state)) {
            throw 'The configured listener is already occupied.'
        }
        $listenerPid = [int]$listeners[0].OwningProcess
        $processes = @(
            Get-CimInstance `
                -ClassName Win32_Process `
                -Filter ('ProcessId = ' + [string]$listenerPid) `
                -ErrorAction Stop
        )
        $servicePlan = New-HmaServiceLaunchPlan `
            -Config $config `
            -StateRoot $state `
            -Bundle $bundle
        if ($processes.Count -ne 1 -or
            -not (Test-HmaLiveServiceProcess `
                -Process $processes[0] `
                -Plan $servicePlan `
                -ListenerPid $listenerPid)) {
            throw 'The configured listener is already occupied.'
        }
    }

    foreach ($plan in $taskPlans) {
        $existing = Get-HmaTaskVerificationRecord -TaskName $plan.Name
        if ($null -ne $existing -and
            -not (Test-HmaRegisteredTaskPlan `
                -Task $existing `
                -Config $config `
                -StateRoot $state)) {
            throw 'An unrelated scheduled task already uses a reserved name.'
        }
    }

    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
    $principal = New-ScheduledTaskPrincipal `
        -UserId $sid `
        -LogonType Interactive `
        -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -MultipleInstances IgnoreNew `
        -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)

    $registrationAttempted = $true
    foreach ($plan in $taskPlans) {
        $action = New-ScheduledTaskAction `
            -Execute $plan.FilePath `
            -Argument $plan.ActionArguments
        Register-ScheduledTask `
            -TaskName $plan.Name `
            -Action $action `
            -Trigger $trigger `
            -Principal $principal `
            -Settings $settings `
            -Force | Out-Null
    }
    foreach ($plan in $taskPlans) {
        $registered = Get-HmaTaskVerificationRecord -TaskName $plan.Name
        if ($null -eq $registered -or
            -not (Test-HmaRegisteredTaskPlan `
                -Task $registered `
                -Config $config `
                -StateRoot $state)) {
            throw 'A registered task did not round-trip exactly.'
        }
    }
    Assert-HmaSourceEntryLease `
        -Entries $allSourceEntries `
        -Streams $sourceEntryLocks
    if (-not (Test-HmaOrdinalEqual `
            -Left (Get-HmaLockedStreamSha256 -Stream $nodeLock) `
            -Right $ExpectedNodeSha256 `
            -IgnoreCase) -or
        -not (Test-HmaOrdinalEqual `
            -Left (Get-HmaLockedStreamSha256 -Stream $ps51Lock) `
            -Right $ExpectedPs51Sha256 `
            -IgnoreCase)) {
        throw 'A retained executable changed.'
    }
} catch {
    if ($updateActivationStarted -and
        $null -ne $updateTransaction -and
        -not $updateRollbackAttempted) {
        $updateRollbackAttempted = $true
        try {
            $null = Restore-HmaUpdateTransaction `
                -Transaction $updateTransaction `
                -StateRoot $state `
                -NewInstall $updateNewInstall `
                -NewConfig $updateNewConfig `
                -NewLauncherPlan $updateNewLauncherPlan `
                -PowerShellPath $powerShellPath
            Exit-HmaUpdateFileLeases -Leases $updateFileLeases
            Remove-HmaUpdateRoot `
                -LiteralPath ([IO.Path]::GetDirectoryName([string]$updateTransaction.OldRoot)) `
                -StateRoot $state
        } catch {
        }
    } elseif ($null -ne $updateTransaction -and -not $updateActivationStarted) {
        try {
            Remove-HmaUpdateRoot `
                -LiteralPath ([IO.Path]::GetDirectoryName([string]$updateTransaction.OldRoot)) `
                -StateRoot $state
        } catch {
        }
    }
    if ($null -eq $updateTransaction -and
        $launcherCreatedByThisRun -and
        $null -ne $launcherCreatedIdentity -and
        $null -ne $launcherPlan -and
        [IO.File]::Exists([string]$launcherPlan.Path)) {
        try {
            $currentIdentity = Get-HmaLauncherFileIdentity `
                -LiteralPath ([string]$launcherPlan.Path)
            if (Test-HmaOrdinalEqual `
                    -Left ([string]$currentIdentity) `
                    -Right ([string]$launcherCreatedIdentity)) {
                [IO.File]::Delete([string]$launcherPlan.Path)
            }
        } catch {
        }
    }
    if ($null -ne $launcherStagingRoot -and
        [IO.Directory]::Exists([string]$launcherStagingRoot)) {
        try {
            if ($null -eq $launcherProgramsRoot) {
                throw 'The launcher staging parent is invalid.'
            }
            Remove-HmaValidatedLauncherStagingRoot `
                -LiteralPath ([string]$launcherStagingRoot) `
                -ExpectedParent ([string]$launcherProgramsRoot)
        } catch {
        }
    }
    if ($null -eq $updateTransaction -and $registrationAttempted) {
        foreach ($taskName in $registeredTaskNames) {
            try {
                Unregister-ScheduledTask `
                    -TaskName $taskName `
                    -Confirm:$false `
                    -ErrorAction SilentlyContinue
            } catch {
            }
        }
    }
    throw 'Secure local installation failed.'
} finally {
    Exit-HmaSourceEntryLease -Streams $sourceEntryLocks
    Exit-HmaUpdateFileLeases -Leases $updateFileLeases
    if ($null -ne $updateLock) {
        $updateLock.Dispose()
    }
    if ($null -ne $ps51Lock) {
        $ps51Lock.Dispose()
    }
    if ($null -ne $nodeLock) {
        $nodeLock.Dispose()
    }
    if ($null -ne $manifestBytes) {
        [Array]::Clear($manifestBytes, 0, $manifestBytes.Length)
    }
    if ($null -ne $installBytes) {
        [Array]::Clear($installBytes, 0, $installBytes.Length)
    }
    $bundle = $null
}
