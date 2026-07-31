[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$ExpectedManifestSha256,
    [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'HowMuchAI'),
    [ValidateSet(37645)][int]$Port = 37645
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$upstreamBase = '1238189b7017601d21e3579d041480ce3773e191'
$registrationAttempted = $false
$registeredTaskNames = @('HowMuchAI-Service', 'HowMuchAI-Window')
$bundle = $null
$manifestBytes = $null
$installBytes = $null
$bootstrapHashFiles = [ordered]@{
    start = 'start-secure-local.ps1'
    open = 'open-secure-local.ps1'
    connector = 'connect-claude-secure.ps1'
    integrity = 'SecureLocalIntegrity.psm1'
    runtime = 'SecureLocalRuntime.psm1'
    secrets = 'SecureLocalSecrets.psm1'
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
            if (-not $runtimeAllowed) {
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
                    if ($relative -cnotmatch '^\.next/cache(?:/|$)') {
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

    $forbiddenEnvironmentFiles = @(
        Get-ChildItem -LiteralPath $Source -Force -File -ErrorAction Stop |
            Where-Object { $_.Name.StartsWith('.env', [StringComparison]::OrdinalIgnoreCase) }
    )
    if ($forbiddenEnvironmentFiles.Count -gt 0 -or
        [IO.File]::Exists((Join-Path $Source '.data\vault.key'))) {
        throw 'A forbidden source file is present.'
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
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)]$Entries
    )

    foreach ($entry in @($Entries)) {
        $sourcePath = Join-Path $Source ([string]$entry.ManifestPath).Replace(
            '/',
            [IO.Path]::DirectorySeparatorChar
        )
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
            Copy-Item `
                -LiteralPath $sourcePath `
                -Destination $destinationPath `
                -ErrorAction Stop
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

function Get-HmaTaskVerificationRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$TaskName)

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        return $null
    }
    $xml = Export-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    return [pscustomobject]@{
        TaskName = [string]$task.TaskName
        Principal = $task.Principal
        Actions = @($task.Actions)
        Triggers = @($task.Triggers)
        Settings = $task.Settings
        Xml = [string]$xml
    }
}

try {
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

    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $nodePath = Get-HmaVerifiedExistingPath -LiteralPath $nodeCommand.Source -File
    $powerShellPath = Get-HmaVerifiedExistingPath `
        -LiteralPath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
        -File

    $headOutput = @(& git -C $source rev-parse HEAD)
    if ($LASTEXITCODE -ne 0 -or $headOutput.Count -ne 1) {
        throw 'The source revision is invalid.'
    }
    $head = ([string]$headOutput[0]).Trim()
    if ($head -cnotmatch '^[a-fA-F0-9]{40}$') {
        throw 'The source revision is invalid.'
    }
    $null = & git -C $source merge-base --is-ancestor $upstreamBase $head
    if ($LASTEXITCODE -ne 0) {
        throw 'The required upstream revision is absent.'
    }
    $status = @(& git -C $source status --porcelain --untracked-files=all)
    if ($LASTEXITCODE -ne 0 -or
        @($status | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -ne 0) {
        throw 'The source tree is not clean.'
    }

    $auditRoot = Join-Path $source 'audit\final'
    $commitPath = Get-HmaVerifiedExistingPath `
        -LiteralPath (Join-Path $auditRoot 'final-commit.txt') `
        -File
    $reviewedCommit = [IO.File]::ReadAllText($commitPath).Trim()
    if (-not (Test-HmaOrdinalEqual -Left $reviewedCommit -Right $head)) {
        throw 'The reviewed commit is invalid.'
    }

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
        if ($manifestBytes.Length -le 0 -or $manifestBytes.Length -gt 67108864) {
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
        -Expected @('commit', 'nodeSha256', 'runtimeFiles', 'bootstrapFiles')
    if ($manifest.commit -isnot [string] -or
        -not (Test-HmaOrdinalEqual -Left ([string]$manifest.commit) -Right $head)) {
        throw 'The reviewed manifest revision is invalid.'
    }
    Assert-HmaSha256 -Value $manifest.nodeSha256
    if (-not (Test-HmaOrdinalEqual `
            -Left (Get-HmaSha256 -LiteralPath $nodePath) `
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

    $sourceIntegrityModule = Join-Path $source 'scripts\windows\SecureLocalIntegrity.psm1'
    $sourceSecretsModule = Join-Path $source 'scripts\windows\SecureLocalSecrets.psm1'
    Import-Module $sourceIntegrityModule -Force -ErrorAction Stop
    Import-Module $sourceSecretsModule -Force -ErrorAction Stop
    $secretsPath = Join-Path $state 'secrets.dpapi'
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
    Copy-HmaManifestEntries `
        -Source $source `
        -Destination $appRoot `
        -Entries $runtimeEntries
    Copy-HmaManifestEntries `
        -Source $source `
        -Destination $bootstrapRoot `
        -Entries $bootstrapEntries
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

    $listeners = @(
        Get-NetTCPConnection `
            -LocalAddress '127.0.0.1' `
            -LocalPort 37645 `
            -State Listen `
            -ErrorAction SilentlyContinue
    )
    $listeners = @($listeners | Where-Object {
            [string]$_.LocalAddress -ceq '127.0.0.1' -and
            [int]$_.LocalPort -eq 37645 -and
            [string]$_.State -ceq 'Listen'
        })
    if ($listeners.Count -gt 0) {
        if ($listeners.Count -ne 1) {
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
} catch {
    if ($registrationAttempted) {
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
    if ($null -ne $manifestBytes) {
        [Array]::Clear($manifestBytes, 0, $manifestBytes.Length)
    }
    if ($null -ne $installBytes) {
        [Array]::Clear($installBytes, 0, $installBytes.Length)
    }
    $bundle = $null
}
