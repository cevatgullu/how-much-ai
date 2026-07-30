Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security

$script:HmaEntropy = [Text.Encoding]::UTF8.GetBytes('HowMuchAI:strict-local:dpapi:v1')
$script:HmaMaximumBlobBytes = 65536
$script:HmaMaximumSecretCharacters = 4096
$script:HmaScanBufferBytes = 4096

function New-HmaRandomSecret {
    [CmdletBinding()]
    param([ValidateRange(32, 128)][int]$ByteCount = 32)

    $bytes = New-Object byte[] $ByteCount
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
        return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $rng.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Assert-HmaSecretBundle {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Bundle)

    if ($null -eq $Bundle) {
        throw 'The secret bundle is invalid.'
    }

    $isDictionary = $Bundle -is [Collections.IDictionary]
    if ($isDictionary) {
        if (-not $Bundle.Contains('version')) {
            throw 'The secret bundle is invalid.'
        }
        $version = $Bundle['version']
    } else {
        $versionProperty = $Bundle.PSObject.Properties['version']
        if ($null -eq $versionProperty) {
            throw 'The secret bundle is invalid.'
        }
        $version = $versionProperty.Value
    }

    try {
        if ([int]$version -ne 1) {
            throw 'The secret bundle is invalid.'
        }
    } catch {
        throw 'The secret bundle is invalid.'
    }

    $values = New-Object 'Collections.Generic.List[string]'
    foreach ($name in @('appPassword', 'authSecret', 'vaultEncryptionSecret')) {
        if ($isDictionary) {
            if (-not $Bundle.Contains($name)) {
                throw 'The secret bundle is invalid.'
            }
            $rawValue = $Bundle[$name]
        } else {
            $property = $Bundle.PSObject.Properties[$name]
            if ($null -eq $property) {
                throw 'The secret bundle is invalid.'
            }
            $rawValue = $property.Value
        }
        if ($rawValue -isnot [string]) {
            throw 'The secret bundle is invalid.'
        }

        $value = [string]$rawValue
        if ([string]::IsNullOrWhiteSpace($value) -or
            $value.Length -lt 32 -or
            $value.Length -gt $script:HmaMaximumSecretCharacters) {
            throw 'The secret bundle is invalid.'
        }
        [void]$values.Add($value)
    }

    if ([string]::Equals($values[0], $values[1], [StringComparison]::Ordinal) -or
        [string]::Equals($values[0], $values[2], [StringComparison]::Ordinal) -or
        [string]::Equals($values[1], $values[2], [StringComparison]::Ordinal)) {
        throw 'The secret bundle is invalid.'
    }
}

function Get-HmaVerifiedFullPath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)

    try {
        $fullPath = [IO.Path]::GetFullPath($LiteralPath)
        $rootPath = [IO.Path]::GetPathRoot($fullPath)
        if ([string]::IsNullOrWhiteSpace($rootPath) -or
            $rootPath -notmatch '^[A-Za-z]:\\$') {
            throw 'Only local drive paths are permitted.'
        }

        $currentPath = $rootPath
        $rootItem = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
        if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Reparse points are not permitted.'
        }

        $relativePath = $fullPath.Substring($rootPath.Length)
        $separators = [char[]]@(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        )
        foreach ($segment in $relativePath.Split(
                $separators,
                [StringSplitOptions]::RemoveEmptyEntries
            )) {
            $currentPath = [IO.Path]::Combine($currentPath, $segment)
            $item = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Reparse points are not permitted.'
            }
        }

        return $fullPath
    } catch {
        throw 'The private state path could not be verified.'
    }
}

function Get-HmaAclTargets {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [switch]$Recurse
    )

    try {
        $verifiedPath = Get-HmaVerifiedFullPath -LiteralPath $LiteralPath
        $root = Get-Item -LiteralPath $verifiedPath -Force -ErrorAction Stop
        if (($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Reparse points are not permitted.'
        }

        $targets = New-Object 'Collections.Generic.List[IO.FileSystemInfo]'
        [void]$targets.Add($root)
        if ($Recurse -and $root.PSIsContainer) {
            $queue = New-Object 'Collections.Generic.Queue[string]'
            $queue.Enqueue($root.FullName)
            while ($queue.Count -gt 0) {
                $parent = $queue.Dequeue()
                foreach ($child in @(Get-ChildItem -LiteralPath $parent -Force -ErrorAction Stop)) {
                    if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                        throw 'Reparse points are not permitted.'
                    }
                    [void]$targets.Add($child)
                    if ($child.PSIsContainer) {
                        $queue.Enqueue($child.FullName)
                    }
                }
            }
        }

        return $targets.ToArray()
    } catch {
        throw 'The private state tree could not be inspected.'
    }
}

function Test-HmaPrivateAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [switch]$Recurse
    )

    try {
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $systemSid = 'S-1-5-18'
        if ([string]::Equals($currentSid, $systemSid, [StringComparison]::Ordinal)) {
            return $false
        }

        $targets = @(Get-HmaAclTargets -LiteralPath $LiteralPath -Recurse:$Recurse)
        if ($targets.Count -eq 0) {
            return $false
        }

        foreach ($target in $targets) {
            $acl = Get-Acl -LiteralPath $target.FullName -ErrorAction Stop
            $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
            if (-not [string]::Equals($ownerSid, $currentSid, [StringComparison]::Ordinal) -or
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

            $expectedInheritance = if ($target.PSIsContainer) {
                [Security.AccessControl.InheritanceFlags](
                    [int][Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                    [int][Security.AccessControl.InheritanceFlags]::ObjectInherit
                )
            } else {
                [Security.AccessControl.InheritanceFlags]::None
            }
            $seenCurrent = 0
            $seenSystem = 0
            foreach ($entry in $rules) {
                $entrySid = $entry.IdentityReference.Value
                if ($entry.IsInherited -or
                    $entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
                    $entry.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
                    $entry.InheritanceFlags -ne $expectedInheritance -or
                    $entry.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
                    return $false
                }

                if ([string]::Equals($entrySid, $currentSid, [StringComparison]::Ordinal)) {
                    $seenCurrent += 1
                } elseif ([string]::Equals($entrySid, $systemSid, [StringComparison]::Ordinal)) {
                    $seenSystem += 1
                } else {
                    return $false
                }
            }

            if ($seenCurrent -ne 1 -or $seenSystem -ne 1) {
                return $false
            }
        }

        return $true
    } catch {
        return $false
    }
}

function Set-HmaPrivateAcl {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)

    try {
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
        if ([string]::Equals(
                $currentSid.Value,
                $systemSid.Value,
                [StringComparison]::Ordinal
            )) {
            throw 'The required principals are not distinct.'
        }

        $targets = @(Get-HmaAclTargets -LiteralPath $LiteralPath -Recurse)
        foreach ($target in $targets) {
            $existingAcl = Get-Acl -LiteralPath $target.FullName -ErrorAction Stop
            $existingOwnerSid = $existingAcl.GetOwner(
                [Security.Principal.SecurityIdentifier]
            ).Value
            if (-not [string]::Equals(
                    $existingOwnerSid,
                    $currentSid.Value,
                    [StringComparison]::Ordinal
                )) {
                throw 'The private state owner is invalid.'
            }

            $acl = if ($target.PSIsContainer) {
                New-Object Security.AccessControl.DirectorySecurity
            } else {
                New-Object Security.AccessControl.FileSecurity
            }
            $acl.SetAccessRuleProtection($true, $false)

            $inheritance = if ($target.PSIsContainer) {
                [Security.AccessControl.InheritanceFlags](
                    [int][Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                    [int][Security.AccessControl.InheritanceFlags]::ObjectInherit
                )
            } else {
                [Security.AccessControl.InheritanceFlags]::None
            }

            foreach ($identity in @($currentSid, $systemSid)) {
                $rule = New-Object Security.AccessControl.FileSystemAccessRule(
                    $identity,
                    [Security.AccessControl.FileSystemRights]::FullControl,
                    $inheritance,
                    [Security.AccessControl.PropagationFlags]::None,
                    [Security.AccessControl.AccessControlType]::Allow
                )
                [void]$acl.AddAccessRule($rule)
            }
            if ($target.PSIsContainer) {
                [IO.Directory]::SetAccessControl($target.FullName, $acl)
            } else {
                [IO.File]::SetAccessControl($target.FullName, $acl)
            }
        }

        if (-not (Test-HmaPrivateAcl -LiteralPath $LiteralPath -Recurse)) {
            throw 'The private ACL did not verify.'
        }
    } catch {
        throw 'The private ACL could not be applied.'
    }
}

function Protect-HmaSecretBundle {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Bundle,
        [Parameter(Mandatory)][string]$Path
    )

    $jsonBytes = $null
    $protectedBytes = $null
    $fullPath = $null
    $tempPath = $null
    $createdDestination = $false
    try {
        Assert-HmaSecretBundle -Bundle $Bundle
        if ([string]::IsNullOrWhiteSpace($Path)) {
            throw 'The destination is invalid.'
        }

        $fullPath = [IO.Path]::GetFullPath($Path)
        $parent = [IO.Path]::GetDirectoryName($fullPath)
        if ([string]::IsNullOrWhiteSpace($parent) -or
            -not [IO.Directory]::Exists($parent) -or
            -not (Test-HmaPrivateAcl -LiteralPath $parent -Recurse)) {
            throw 'The destination is invalid.'
        }
        if ([IO.File]::Exists($fullPath) -or [IO.Directory]::Exists($fullPath)) {
            throw 'The destination already exists.'
        }

        $canonical = [ordered]@{
            version = 1
            appPassword = [string]$Bundle.appPassword
            authSecret = [string]$Bundle.authSecret
            vaultEncryptionSecret = [string]$Bundle.vaultEncryptionSecret
        }
        $json = ConvertTo-Json -InputObject $canonical -Compress -Depth 2
        $jsonBytes = [Text.Encoding]::UTF8.GetBytes($json)
        $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
            $jsonBytes,
            $script:HmaEntropy,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $base64 = [Convert]::ToBase64String($protectedBytes)
        if ([Text.Encoding]::UTF8.GetByteCount($base64) -gt $script:HmaMaximumBlobBytes) {
            throw 'The protected payload is too large.'
        }

        $tempPath = Join-Path $parent ('.hma-secrets-' + [Guid]::NewGuid().ToString('N') + '.tmp')
        [IO.File]::WriteAllText(
            $tempPath,
            $base64,
            (New-Object Text.UTF8Encoding($false))
        )
        Set-HmaPrivateAcl -LiteralPath $tempPath
        [IO.File]::Move($tempPath, $fullPath)
        $tempPath = $null
        $createdDestination = $true

        if (-not (Test-HmaPrivateAcl -LiteralPath $fullPath)) {
            throw 'The protected payload ACL did not verify.'
        }
    } catch {
        if ($createdDestination -and $null -ne $fullPath) {
            try {
                if ([IO.File]::Exists($fullPath)) {
                    [IO.File]::Delete($fullPath)
                }
            } catch {
            }
        }
        throw 'The DPAPI secret bundle could not be protected.'
    } finally {
        if ($null -ne $tempPath) {
            try {
                if ([IO.File]::Exists($tempPath)) {
                    [IO.File]::Delete($tempPath)
                }
            } catch {
            }
        }
        if ($null -ne $jsonBytes) {
            [Array]::Clear($jsonBytes, 0, $jsonBytes.Length)
        }
        if ($null -ne $protectedBytes) {
            [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
        }
    }
}

function Unprotect-HmaSecretBundle {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    $protectedBytes = $null
    $plainBytes = $null
    try {
        if ([string]::IsNullOrWhiteSpace($Path)) {
            throw 'The source is invalid.'
        }

        $fullPath = [IO.Path]::GetFullPath($Path)
        $targets = @(Get-HmaAclTargets -LiteralPath $fullPath)
        if ($targets.Count -ne 1 -or
            $targets[0].PSIsContainer -or
            $targets[0].Length -le 0 -or
            $targets[0].Length -gt $script:HmaMaximumBlobBytes -or
            -not (Test-HmaPrivateAcl -LiteralPath $fullPath)) {
            throw 'The source is invalid.'
        }

        $base64 = [IO.File]::ReadAllText($fullPath)
        $protectedBytes = [Convert]::FromBase64String($base64)
        $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
            $protectedBytes,
            $script:HmaEntropy,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $utf8 = New-Object Text.UTF8Encoding($false, $true)
        $json = $utf8.GetString($plainBytes)
        $bundle = ConvertFrom-Json -InputObject $json -ErrorAction Stop
        Assert-HmaSecretBundle -Bundle $bundle

        return [pscustomobject]@{
            version = 1
            appPassword = [string]$bundle.appPassword
            authSecret = [string]$bundle.authSecret
            vaultEncryptionSecret = [string]$bundle.vaultEncryptionSecret
        }
    } catch {
        throw 'The DPAPI secret bundle could not be unprotected.'
    } finally {
        if ($null -ne $protectedBytes) {
            [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
        }
        if ($null -ne $plainBytes) {
            [Array]::Clear($plainBytes, 0, $plainBytes.Length)
        }
    }
}

function Test-HmaByteArraysEqual {
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

function Add-HmaUniquePattern {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Patterns,
        [Parameter(Mandatory)][byte[]]$Pattern
    )

    foreach ($existing in $Patterns) {
        if (Test-HmaByteArraysEqual -Left $existing -Right $Pattern) {
            return
        }
    }
    [void]$Patterns.Add($Pattern)
}

function Test-HmaAsciiString {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Value)

    foreach ($character in $Value.ToCharArray()) {
        if ([int]$character -gt 127) {
            return $false
        }
    }
    return $true
}

function Test-HmaWindowContainsPattern {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][byte[]]$Buffer,
        [Parameter(Mandatory)][int]$Count,
        [Parameter(Mandatory)][byte[]]$Pattern
    )

    if ($Pattern.Length -eq 0 -or $Pattern.Length -gt $Count) {
        return $false
    }

    $lastStart = $Count - $Pattern.Length
    for ($start = 0; $start -le $lastStart; $start += 1) {
        $matched = $true
        for ($offset = 0; $offset -lt $Pattern.Length; $offset += 1) {
            if ($Buffer[$start + $offset] -ne $Pattern[$offset]) {
                $matched = $false
                break
            }
        }
        if ($matched) {
            return $true
        }
    }
    return $false
}

function Test-HmaFileContainsPatterns {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [Parameter(Mandatory)]$Patterns,
        [Parameter(Mandatory)][int]$MaximumPatternLength
    )

    $stream = $null
    $window = $null
    try {
        $overlapLimit = [Math]::Max(0, $MaximumPatternLength - 1)
        $window = New-Object byte[] ($script:HmaScanBufferBytes + $overlapLimit)
        $stream = New-Object IO.FileStream(
            $LiteralPath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read
        )

        $overlap = 0
        while (($read = $stream.Read(
                    $window,
                    $overlap,
                    $script:HmaScanBufferBytes
                )) -gt 0) {
            $available = $overlap + $read
            foreach ($pattern in $Patterns) {
                if (Test-HmaWindowContainsPattern -Buffer $window -Count $available -Pattern $pattern) {
                    return $true
                }
            }

            $overlap = [Math]::Min($overlapLimit, $available)
            if ($overlap -gt 0) {
                [Buffer]::BlockCopy(
                    $window,
                    $available - $overlap,
                    $window,
                    0,
                    $overlap
                )
            }
        }

        return $false
    } finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        if ($null -ne $window) {
            [Array]::Clear($window, 0, $window.Length)
        }
    }
}

function Test-HmaNoExactValuesAtRest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiteralPath,
        [Parameter(Mandatory)][object[]]$Values
    )

    try {
        if ([string]::IsNullOrWhiteSpace($LiteralPath) -or
            $null -eq $Values -or
            @($Values).Count -eq 0) {
            return $false
        }

        $patterns = New-Object 'Collections.Generic.List[byte[]]'
        $utf8 = New-Object Text.UTF8Encoding($false, $true)
        $ascii = [Text.Encoding]::ASCII
        $utf16 = [Text.Encoding]::Unicode
        foreach ($candidate in @($Values)) {
            if ($candidate -isnot [string] -or
                [string]::IsNullOrEmpty([string]$candidate) -or
                ([string]$candidate).Length -gt $script:HmaMaximumSecretCharacters) {
                return $false
            }

            $value = [string]$candidate
            $utf8Bytes = $utf8.GetBytes($value)
            Add-HmaUniquePattern -Patterns $patterns -Pattern $utf8Bytes
            if (Test-HmaAsciiString -Value $value) {
                $asciiBytes = $ascii.GetBytes($value)
                Add-HmaUniquePattern -Patterns $patterns -Pattern $asciiBytes
            }
            $utf16Bytes = $utf16.GetBytes($value)
            Add-HmaUniquePattern -Patterns $patterns -Pattern $utf16Bytes
        }

        if ($patterns.Count -eq 0) {
            return $false
        }

        $maximumPatternLength = 0
        foreach ($pattern in $patterns) {
            $maximumPatternLength = [Math]::Max($maximumPatternLength, $pattern.Length)
        }

        $targets = @(Get-HmaAclTargets -LiteralPath $LiteralPath -Recurse)
        foreach ($target in $targets) {
            if (-not $target.PSIsContainer) {
                $fresh = Get-Item -LiteralPath $target.FullName -Force -ErrorAction Stop
                if ($fresh.PSIsContainer -or
                    ($fresh.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    return $false
                }
                if (Test-HmaFileContainsPatterns `
                        -LiteralPath $fresh.FullName `
                        -Patterns $patterns `
                        -MaximumPatternLength $maximumPatternLength) {
                    return $false
                }
            }
        }

        return $true
    } catch {
        return $false
    }
}

Export-ModuleMember -Function @(
    'New-HmaRandomSecret',
    'Protect-HmaSecretBundle',
    'Unprotect-HmaSecretBundle',
    'Set-HmaPrivateAcl',
    'Test-HmaPrivateAcl',
    'Test-HmaNoExactValuesAtRest'
)
