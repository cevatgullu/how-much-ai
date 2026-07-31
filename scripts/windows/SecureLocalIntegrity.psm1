Set-StrictMode -Version Latest

$script:HmaUpstreamBase = '1238189b7017601d21e3579d041480ce3773e191'
$script:HmaInstallProperties = @(
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
$script:HmaBootstrapHashProperties = @(
    'start',
    'open',
    'connector',
    'integrity',
    'runtime',
    'secrets'
)
$script:HmaManifestProperties = @(
    'commit',
    'nodeSha256',
    'runtimeFiles',
    'bootstrapFiles'
)
$script:HmaManifestFileProperties = @('path', 'size', 'sha256')
$script:HmaBootstrapHashFiles = [ordered]@{
    start = 'start-secure-local.ps1'
    open = 'open-secure-local.ps1'
    connector = 'connect-claude-secure.ps1'
    integrity = 'SecureLocalIntegrity.psm1'
    runtime = 'SecureLocalRuntime.psm1'
    secrets = 'SecureLocalSecrets.psm1'
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

function Assert-HmaSha256 {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Value)

    if ($Value -isnot [string] -or [string]$Value -cnotmatch '^[a-fA-F0-9]{64}$') {
        throw 'The SHA-256 value is invalid.'
    }
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

function Get-HmaCanonicalExistingPath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)

    try {
        if ([string]::IsNullOrWhiteSpace($LiteralPath) -or
            -not [IO.Path]::IsPathRooted($LiteralPath) -or
            $LiteralPath.IndexOfAny([char[]]@("'", '"')) -ge 0) {
            throw 'The path is invalid.'
        }
        foreach ($character in $LiteralPath.ToCharArray()) {
            if ([char]::IsControl($character)) {
                throw 'The path is invalid.'
            }
        }

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
        return $fullPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
    } catch {
        throw 'The path is invalid.'
    }
}

function Test-HmaExactPrivateAcl {
    [CmdletBinding()]
    param([Parameter(Mandatory)][IO.FileSystemInfo]$Item)

    try {
        if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            return $false
        }
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $systemSid = 'S-1-5-18'
        if (Test-HmaOrdinalEqual -Left $currentSid -Right $systemSid) {
            return $false
        }

        $acl = Get-Acl -LiteralPath $Item.FullName -ErrorAction Stop
        $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if (-not (Test-HmaOrdinalEqual -Left $ownerSid -Right $currentSid) -or
            -not $acl.AreAccessRulesProtected) {
            return $false
        }

        $rules = @($acl.GetAccessRules(
                $true,
                $true,
                [Security.Principal.SecurityIdentifier]
            ))
        if ($rules.Count -ne 2) {
            return $false
        }
        $expectedInheritance = if ($Item.PSIsContainer) {
            [Security.AccessControl.InheritanceFlags](
                [int][Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                [int][Security.AccessControl.InheritanceFlags]::ObjectInherit
            )
        } else {
            [Security.AccessControl.InheritanceFlags]::None
        }

        $currentCount = 0
        $systemCount = 0
        foreach ($rule in $rules) {
            if ($rule.IsInherited -or
                $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
                $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
                $rule.InheritanceFlags -ne $expectedInheritance -or
                $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
                return $false
            }
            if (Test-HmaOrdinalEqual -Left $rule.IdentityReference.Value -Right $currentSid) {
                $currentCount += 1
            } elseif (Test-HmaOrdinalEqual -Left $rule.IdentityReference.Value -Right $systemSid) {
                $systemCount += 1
            } else {
                return $false
            }
        }
        return ($currentCount -eq 1 -and $systemCount -eq 1)
    } catch {
        return $false
    }
}

function Assert-HmaPrivateItem {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [switch]$Directory,
        [switch]$File
    )

    $verified = Get-HmaCanonicalExistingPath -LiteralPath $LiteralPath
    $item = Get-Item -LiteralPath $verified -Force -ErrorAction Stop
    if (($Directory -and -not $item.PSIsContainer) -or
        ($File -and $item.PSIsContainer) -or
        -not (Test-HmaExactPrivateAcl -Item $item)) {
        throw 'The private item is invalid.'
    }
    return $item
}

function Get-HmaTree {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Root)

    $rootPath = Get-HmaCanonicalExistingPath -LiteralPath $Root
    $rootItem = Get-Item -LiteralPath $rootPath -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer -or -not (Test-HmaExactPrivateAcl -Item $rootItem)) {
        throw 'The tree is invalid.'
    }

    $results = New-Object 'Collections.Generic.List[object]'
    $queue = New-Object 'Collections.Generic.Queue[string]'
    $queue.Enqueue($rootPath)
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        foreach ($child in @(Get-ChildItem -LiteralPath $parent -Force -ErrorAction Stop)) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                -not (Test-HmaExactPrivateAcl -Item $child)) {
                throw 'The tree is invalid.'
            }
            $relative = $child.FullName.Substring($rootPath.Length).TrimStart(
                [IO.Path]::DirectorySeparatorChar
            ).Replace('\', '/')
            if ([string]::IsNullOrWhiteSpace($relative)) {
                throw 'The tree is invalid.'
            }
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

function Assert-HmaPrivateTree {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Root)

    $null = @(Get-HmaTree -Root $Root)
}

function Get-HmaStrictUtf8Text {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [Parameter(Mandatory)][long]$MaximumBytes
    )

    $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or $item.Length -le 0 -or $item.Length -gt $MaximumBytes) {
        throw 'The JSON input is invalid.'
    }
    $bytes = [IO.File]::ReadAllBytes($item.FullName)
    try {
        $utf8 = New-Object Text.UTF8Encoding($false, $true)
        return $utf8.GetString($bytes)
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Get-HmaFileSha256 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)

    $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $LiteralPath -ErrorAction Stop
    return ([string]$hash.Hash).ToLowerInvariant()
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
    if ($segments.Count -eq 0 -or
        @($segments | Where-Object { $_ -ceq '' -or $_ -ceq '.' -or $_ -ceq '..' }).Count -gt 0) {
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

    if ($null -eq $Entries -or $Entries -is [string] -or $Entries -isnot [Collections.IEnumerable]) {
        throw 'The manifest file list is invalid.'
    }
    $inputEntries = @($Entries)
    if ($inputEntries.Count -eq 0) {
        throw 'The manifest file list is invalid.'
    }

    $seen = @{}
    $validated = New-Object 'Collections.Generic.List[object]'
    $previousPath = $null
    foreach ($entry in $inputEntries) {
        Assert-HmaExactProperties -InputObject $entry -Expected $script:HmaManifestFileProperties
        $prefix = if ($Kind -ceq 'bootstrap') { 'scripts/windows/' } else { '' }
        $manifestPath = Assert-HmaManifestRelativePath `
            -Value $entry.path `
            -RequiredPrefix $prefix
        if ($null -ne $previousPath -and
            [string]::CompareOrdinal($previousPath, $manifestPath) -ge 0) {
            throw 'The manifest file list is invalid.'
        }
        $previousPath = $manifestPath

        $folded = $manifestPath.ToLowerInvariant()
        if ($seen.ContainsKey($folded)) {
            throw 'The manifest file list is invalid.'
        }
        $seen[$folded] = $true
        if (($entry.size -isnot [int] -and $entry.size -isnot [long]) -or
            [long]$entry.size -lt 0) {
            throw 'The manifest file size is invalid.'
        }
        Assert-HmaSha256 -Value $entry.sha256

        $installedPath = if ($Kind -ceq 'bootstrap') {
            $manifestPath.Substring('scripts/windows/'.Length)
        } else {
            $manifestPath
        }
        [void]$validated.Add([pscustomobject]@{
                ManifestPath = $manifestPath
                InstalledPath = $installedPath
                Size = [long]$entry.size
                Sha256 = ([string]$entry.sha256).ToLowerInvariant()
            })
    }
    return $validated.ToArray()
}

function Get-HmaExpectedDirectories {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Entries)

    $directories = @{}
    foreach ($entry in @($Entries)) {
        $segments = @(([string]$entry.InstalledPath).Split('/'))
        if ($segments.Count -gt 1) {
            for ($count = 1; $count -lt $segments.Count; $count += 1) {
                $directory = [string]::Join('/', $segments[0..($count - 1)])
                $directories[$directory.ToLowerInvariant()] = $directory
            }
        }
    }
    return @($directories.Values | Sort-Object)
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

function Assert-HmaExactManifestTree {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)]$Entries
    )

    $tree = @(Get-HmaTree -Root $Root)
    $actualFiles = @($tree | Where-Object { -not $_.IsDirectory })
    $actualDirectories = @($tree | Where-Object { $_.IsDirectory })
    $expectedFiles = @($Entries | ForEach-Object { $_.InstalledPath })
    $expectedDirectories = @(Get-HmaExpectedDirectories -Entries $Entries)
    $actualFilePaths = @($actualFiles | ForEach-Object { [string]$_.Relative })
    $actualDirectoryPaths = @($actualDirectories | ForEach-Object { [string]$_.Relative })
    if (-not (Test-HmaExactStringSet `
            -Expected $expectedFiles `
            -Actual $actualFilePaths) -or
        -not (Test-HmaExactStringSet `
            -Expected $expectedDirectories `
            -Actual $actualDirectoryPaths)) {
        throw 'The installed file set is invalid.'
    }

    $actualByPath = @{}
    foreach ($file in $actualFiles) {
        $actualByPath[$file.Relative.ToLowerInvariant()] = $file
    }
    foreach ($entry in @($Entries)) {
        $file = $actualByPath[$entry.InstalledPath.ToLowerInvariant()]
        if ($null -eq $file -or
            [long]$file.Length -ne [long]$entry.Size -or
            -not (Test-HmaOrdinalEqual `
                -Left (Get-HmaFileSha256 -LiteralPath $file.FullName) `
                -Right ([string]$entry.Sha256) `
                -IgnoreCase)) {
            throw 'An installed file is invalid.'
        }
    }
}

function Assert-HmaNoForbiddenMutableNames {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Tree)

    foreach ($item in @($Tree)) {
        $segments = @(([string]$item.Relative).Split('/'))
        foreach ($segment in $segments) {
            if ($segment.StartsWith('.env', [StringComparison]::OrdinalIgnoreCase) -or
                $segment.Equals('vault.key', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'A forbidden state name is present.'
            }
        }
    }
}

function Assert-HmaStartupIntegrity {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$StateRoot)

    try {
        $state = Get-HmaCanonicalExistingPath -LiteralPath $StateRoot
        $stateItem = Assert-HmaPrivateItem -LiteralPath $state -Directory

        $expectedRootNames = @(
            'bootstrap',
            'edge-profile',
            'install.json',
            'integrity.json',
            'oauth-temp',
            'runtime',
            'secrets.dpapi',
            'vault'
        )
        $rootChildren = @(Get-ChildItem -LiteralPath $stateItem.FullName -Force -ErrorAction Stop)
        if ([bool](Compare-Object `
                -ReferenceObject @($expectedRootNames | Sort-Object) `
                -DifferenceObject @($rootChildren.Name | Sort-Object) `
                -CaseSensitive)) {
            throw 'The state root file set is invalid.'
        }

        $installPath = Join-Path $state 'install.json'
        $integrityPath = Join-Path $state 'integrity.json'
        $secretsPath = Join-Path $state 'secrets.dpapi'
        $runtimeRoot = Join-Path $state 'runtime'
        $bootstrapRoot = Join-Path $state 'bootstrap'
        $vaultRoot = Join-Path $state 'vault'
        $edgeRoot = Join-Path $state 'edge-profile'
        $oauthRoot = Join-Path $state 'oauth-temp'

        $null = Assert-HmaPrivateItem -LiteralPath $installPath -File
        $null = Assert-HmaPrivateItem -LiteralPath $integrityPath -File
        $null = Assert-HmaPrivateItem -LiteralPath $secretsPath -File
        $null = Assert-HmaPrivateItem -LiteralPath $runtimeRoot -Directory
        $null = Assert-HmaPrivateItem -LiteralPath $bootstrapRoot -Directory
        $null = Assert-HmaPrivateItem -LiteralPath $vaultRoot -Directory
        $null = Assert-HmaPrivateItem -LiteralPath $edgeRoot -Directory
        $null = Assert-HmaPrivateItem -LiteralPath $oauthRoot -Directory

        $installText = Get-HmaStrictUtf8Text -LiteralPath $installPath -MaximumBytes 65536
        $install = ConvertFrom-Json -InputObject $installText -ErrorAction Stop
        Assert-HmaExactProperties -InputObject $install -Expected $script:HmaInstallProperties
        Assert-HmaExactProperties `
            -InputObject $install.bootstrapHashes `
            -Expected $script:HmaBootstrapHashProperties

        if ($install.version -isnot [int] -or [int]$install.version -ne 1 -or
            $install.port -isnot [int] -or [int]$install.port -ne 37645 -or
            $install.upstreamBase -isnot [string] -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$install.upstreamBase) `
                -Right $script:HmaUpstreamBase) -or
            $install.commit -isnot [string] -or
            [string]$install.commit -cnotmatch '^[a-fA-F0-9]{40}$') {
            throw 'The install configuration is invalid.'
        }
        Assert-HmaSha256 -Value $install.manifestSha256
        foreach ($hashName in $script:HmaBootstrapHashProperties) {
            Assert-HmaSha256 -Value $install.bootstrapHashes.$hashName
        }

        if ($install.stateRoot -isnot [string] -or
            -not (Test-HmaOrdinalEqual `
                -Left (Get-HmaCanonicalExistingPath -LiteralPath ([string]$install.stateRoot)) `
                -Right $state `
                -IgnoreCase)) {
            throw 'The install configuration is invalid.'
        }
        $appRoot = Get-HmaCanonicalExistingPath -LiteralPath ([string]$install.appRoot)
        $expectedAppRoot = Join-Path $runtimeRoot ([string]$install.commit)
        if (-not (Test-HmaOrdinalEqual -Left $appRoot -Right $expectedAppRoot -IgnoreCase)) {
            throw 'The install configuration is invalid.'
        }
        $nodePath = Get-HmaCanonicalExistingPath -LiteralPath ([string]$install.nodePath)
        $nodeItem = Get-Item -LiteralPath $nodePath -Force -ErrorAction Stop
        if ($nodeItem.PSIsContainer) {
            throw 'The Node executable is invalid.'
        }

        $manifestHash = Get-HmaFileSha256 -LiteralPath $integrityPath
        if (-not (Test-HmaOrdinalEqual `
                -Left $manifestHash `
                -Right ([string]$install.manifestSha256) `
                -IgnoreCase)) {
            throw 'The integrity manifest is invalid.'
        }
        $manifestText = Get-HmaStrictUtf8Text `
            -LiteralPath $integrityPath `
            -MaximumBytes 67108864
        $manifest = ConvertFrom-Json -InputObject $manifestText -ErrorAction Stop
        Assert-HmaExactProperties -InputObject $manifest -Expected $script:HmaManifestProperties
        if ($manifest.commit -isnot [string] -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string]$manifest.commit) `
                -Right ([string]$install.commit))) {
            throw 'The integrity manifest is invalid.'
        }
        Assert-HmaSha256 -Value $manifest.nodeSha256

        $runtimeEntries = @(
            Get-HmaValidatedManifestEntries -Entries $manifest.runtimeFiles -Kind runtime
        )
        $bootstrapEntries = @(
            Get-HmaValidatedManifestEntries -Entries $manifest.bootstrapFiles -Kind bootstrap
        )

        $runtimeParentTree = @(Get-HmaTree -Root $runtimeRoot)
        if ($runtimeParentTree.Count -lt 1 -or
            @($runtimeParentTree | Where-Object {
                    $_.Relative -notmatch ('^' + [regex]::Escape([string]$install.commit) + '(?:/|$)')
                }).Count -ne 0) {
            throw 'The runtime root is invalid.'
        }
        Assert-HmaExactManifestTree -Root $appRoot -Entries $runtimeEntries
        Assert-HmaExactManifestTree -Root $bootstrapRoot -Entries $bootstrapEntries

        if ([long]$nodeItem.Length -lt 0 -or
            -not (Test-HmaOrdinalEqual `
                -Left (Get-HmaFileSha256 -LiteralPath $nodePath) `
                -Right ([string]$manifest.nodeSha256) `
                -IgnoreCase)) {
            throw 'The Node executable is invalid.'
        }

        $bootstrapByInstalledPath = @{}
        foreach ($entry in $bootstrapEntries) {
            $bootstrapByInstalledPath[$entry.InstalledPath.ToLowerInvariant()] = $entry
        }
        foreach ($hashName in $script:HmaBootstrapHashFiles.Keys) {
            $fileName = [string]$script:HmaBootstrapHashFiles[$hashName]
            $entry = $bootstrapByInstalledPath[$fileName.ToLowerInvariant()]
            if ($null -eq $entry -or
                -not (Test-HmaOrdinalEqual `
                    -Left ([string]$entry.Sha256) `
                    -Right ([string]$install.bootstrapHashes.$hashName) `
                    -IgnoreCase)) {
                throw 'A bootstrap hash is invalid.'
            }
        }

        $vaultTree = @(Get-HmaTree -Root $vaultRoot)
        Assert-HmaNoForbiddenMutableNames -Tree $vaultTree
        $oauthTree = @(Get-HmaTree -Root $oauthRoot)
        if ($oauthTree.Count -ne 0) {
            throw 'The OAuth temporary root is not empty.'
        }

        return [pscustomobject]@{
            version = 1
            appRoot = $appRoot
            stateRoot = $state
            nodePath = $nodePath
            port = 37645
            upstreamBase = $script:HmaUpstreamBase
            commit = [string]$install.commit
            manifestSha256 = ([string]$install.manifestSha256).ToLowerInvariant()
            bootstrapHashes = [pscustomobject]@{
                start = ([string]$install.bootstrapHashes.start).ToLowerInvariant()
                open = ([string]$install.bootstrapHashes.open).ToLowerInvariant()
                connector = ([string]$install.bootstrapHashes.connector).ToLowerInvariant()
                integrity = ([string]$install.bootstrapHashes.integrity).ToLowerInvariant()
                runtime = ([string]$install.bootstrapHashes.runtime).ToLowerInvariant()
                secrets = ([string]$install.bootstrapHashes.secrets).ToLowerInvariant()
            }
        }
    } catch {
        throw 'Startup integrity verification failed.'
    }
}

Export-ModuleMember -Function 'Assert-HmaStartupIntegrity'
