Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$DebugPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$hmaLauncherWasDotSourced = $MyInvocation.InvocationName -ceq '.'
$hmaLauncherArguments = @($args)
$script:HmaLauncherExecutingPath = $PSCommandPath

function Get-HmaLauncherCanonicalOrdinaryFile {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)

    $fileSystem = $null
    try {
        if ([string]::IsNullOrWhiteSpace($LiteralPath) -or
            -not [IO.Path]::IsPathRooted($LiteralPath) -or
            $LiteralPath.IndexOfAny([char[]]@("'", '"')) -ge 0) {
            throw 'Secure local launcher failed.'
        }
        $fullPath = [IO.Path]::GetFullPath($LiteralPath)
        $root = [IO.Path]::GetPathRoot($fullPath)
        $current = $root
        $segments = $fullPath.Substring($root.Length).Split(
            [char[]]@(
                [IO.Path]::DirectorySeparatorChar,
                [IO.Path]::AltDirectorySeparatorChar
            ),
            [StringSplitOptions]::RemoveEmptyEntries
        )
        for ($index = 0; $index -lt $segments.Count; $index += 1) {
            $current = [IO.Path]::Combine($current, $segments[$index])
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                ($index -lt ($segments.Count - 1) -and -not $item.PSIsContainer) -or
                ($index -eq ($segments.Count - 1) -and $item.PSIsContainer)) {
                throw 'Secure local launcher failed.'
            }
        }
        $fileSystem = New-Object -ComObject Scripting.FileSystemObject
        return [string]$fileSystem.GetFile($fullPath).Path
    } catch {
        throw 'Secure local launcher failed.'
    } finally {
        if ($null -ne $fileSystem) {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($fileSystem)
        }
        $fileSystem = $null
    }
}

function Get-HmaLauncherOperation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Operations,
        [Parameter(Mandatory)][string]$Name
    )

    if (-not $Operations.ContainsKey($Name) -or
        $Operations[$Name] -isnot [scriptblock]) {
        throw 'Secure local launcher failed.'
    }
    return [scriptblock]$Operations[$Name]
}

function Test-HmaLauncherHash {
    [CmdletBinding()]
    param(
        [AllowNull()][string]$Actual,
        [AllowNull()][string]$Expected
    )

    return (
        $Actual -cmatch '^[a-fA-F0-9]{64}$' -and
        $Expected -cmatch '^[a-fA-F0-9]{64}$' -and
        [string]::Equals(
            $Actual,
            $Expected,
            [StringComparison]::OrdinalIgnoreCase
        )
    )
}

function Get-HmaLauncherDefaultOperations {
    [CmdletBinding()]
    param()

    return @{
        GetExecutingPath = {
            return [string]$script:HmaLauncherExecutingPath
        }
        GetCanonicalPath = {
            param($LiteralPath)
            return Get-HmaLauncherCanonicalOrdinaryFile `
                -LiteralPath ([string]$LiteralPath)
        }
        GetFileHash = {
            param($LiteralPath)
            return [string](Get-FileHash `
                    -Algorithm SHA256 `
                    -LiteralPath ([string]$LiteralPath) `
                    -ErrorAction Stop).Hash
        }
        ImportIntegrity = {
            param($LiteralPath)
            Import-Module `
                -Name ([string]$LiteralPath) `
                -Force `
                -Global `
                -ErrorAction Stop
            return $true
        }
        AssertStartupIntegrity = {
            param($RequestedStateRoot)
            return Assert-HmaStartupIntegrity `
                -StateRoot ([string]$RequestedStateRoot)
        }
        ImportRuntime = {
            param($LiteralPath)
            Import-Module `
                -Name ([string]$LiteralPath) `
                -Force `
                -Global `
                -ErrorAction Stop
            return $true
        }
        GetTask = {
            param($TaskName)
            $name = [string]$TaskName
            if ($name -cnotin @('HowMuchAI-Service', 'HowMuchAI-Window')) {
                throw 'Secure local launcher failed.'
            }
            $task = Get-ScheduledTask `
                -TaskName $name `
                -ErrorAction Stop
            $xml = Export-ScheduledTask `
                -TaskName $name `
                -ErrorAction Stop
            return [pscustomobject]@{
                TaskName = [string]$task.TaskName
                State = [string]$task.State
                Principal = $task.Principal
                Actions = @($task.Actions)
                Triggers = @($task.Triggers)
                Settings = $task.Settings
                Xml = [string]$xml
            }
        }
        TestTask = {
            param($Task, $Config, $RequestedStateRoot)
            return [bool](Test-HmaRegisteredTaskPlan `
                    -Task $Task `
                    -Config $Config `
                    -StateRoot ([string]$RequestedStateRoot))
        }
        StartTask = {
            param($TaskName)
            $name = [string]$TaskName
            if ($name -cnotin @('HowMuchAI-Service', 'HowMuchAI-Window')) {
                return $false
            }
            $null = Start-ScheduledTask `
                -TaskName $name `
                -ErrorAction Stop
            return $true
        }
    }
}

function Invoke-HmaSecureLocalLauncherCore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)]
        [ValidatePattern('^[a-fA-F0-9]{64}$')]
        [string]$IntegrityModuleHash,
        [Parameter(Mandatory)]
        [ValidatePattern('^[a-fA-F0-9]{64}$')]
        [string]$LauncherHash,
        [Parameter(Mandatory)][hashtable]$Operations
    )

    try {
        $bootstrapRoot = Join-Path $StateRoot 'bootstrap'
        $launcherPath = Join-Path $bootstrapRoot 'launch-secure-local.ps1'
        $integrityPath = Join-Path $bootstrapRoot 'SecureLocalIntegrity.psm1'
        $runtimePath = Join-Path $bootstrapRoot 'SecureLocalRuntime.psm1'
        $hashOperation = Get-HmaLauncherOperation `
            -Operations $Operations `
            -Name 'GetFileHash'
        $canonicalPathOperation = Get-HmaLauncherOperation `
            -Operations $Operations `
            -Name 'GetCanonicalPath'
        $executingPathOperation = Get-HmaLauncherOperation `
            -Operations $Operations `
            -Name 'GetExecutingPath'
        $expectedLauncherPaths = @(& $canonicalPathOperation $launcherPath)
        $executingPaths = @(& $executingPathOperation)
        if ($expectedLauncherPaths.Count -ne 1 -or
            $expectedLauncherPaths[0] -isnot [string] -or
            $executingPaths.Count -ne 1 -or
            $executingPaths[0] -isnot [string]) {
            throw 'Secure local launcher failed.'
        }
        $canonicalExecutingPaths = @(
            & $canonicalPathOperation ([string]$executingPaths[0])
        )
        if ($canonicalExecutingPaths.Count -ne 1 -or
            $canonicalExecutingPaths[0] -isnot [string] -or
            -not [string]::Equals(
                [string]$expectedLauncherPaths[0],
                [string]$canonicalExecutingPaths[0],
                [StringComparison]::Ordinal
            )) {
            throw 'Secure local launcher failed.'
        }
        $launcherPath = [string]$expectedLauncherPaths[0]

        foreach ($entry in @(
                [pscustomobject]@{
                    Path = $launcherPath
                    Expected = $LauncherHash
                },
                [pscustomobject]@{
                    Path = $integrityPath
                    Expected = $IntegrityModuleHash
                }
            )) {
            $actual = @(& $hashOperation ([string]$entry.Path))
            if ($actual.Count -ne 1 -or
                $actual[0] -isnot [string] -or
                -not (Test-HmaLauncherHash `
                    -Actual ([string]$actual[0]) `
                    -Expected ([string]$entry.Expected))) {
                throw 'Secure local launcher failed.'
            }
        }

        foreach ($importName in @('ImportIntegrity')) {
            $import = Get-HmaLauncherOperation `
                -Operations $Operations `
                -Name $importName
            $result = @(& $import $integrityPath)
            if ($result.Count -ne 1 -or
                $result[0] -isnot [bool] -or
                -not [bool]$result[0]) {
                throw 'Secure local launcher failed.'
            }
        }
        $assertIntegrity = Get-HmaLauncherOperation `
            -Operations $Operations `
            -Name 'AssertStartupIntegrity'
        $configResult = @(& $assertIntegrity $StateRoot)
        if ($configResult.Count -ne 1 -or $null -eq $configResult[0]) {
            throw 'Secure local launcher failed.'
        }
        $config = $configResult[0]
        $hashes = $config.bootstrapHashes
        if (-not (Test-HmaLauncherHash `
                -Actual ([string]$hashes.launcher) `
                -Expected $LauncherHash) -or
            -not (Test-HmaLauncherHash `
                -Actual ([string]$hashes.integrity) `
                -Expected $IntegrityModuleHash) -or
            [string]$hashes.runtime -cnotmatch '^[a-fA-F0-9]{64}$') {
            throw 'Secure local launcher failed.'
        }
        $runtimeHashResult = @(& $hashOperation $runtimePath)
        if ($runtimeHashResult.Count -ne 1 -or
            $runtimeHashResult[0] -isnot [string] -or
            -not (Test-HmaLauncherHash `
                -Actual ([string]$runtimeHashResult[0]) `
                -Expected ([string]$hashes.runtime))) {
            throw 'Secure local launcher failed.'
        }
        $importRuntime = Get-HmaLauncherOperation `
            -Operations $Operations `
            -Name 'ImportRuntime'
        $runtimeImported = @(& $importRuntime $runtimePath)
        if ($runtimeImported.Count -ne 1 -or
            $runtimeImported[0] -isnot [bool] -or
            -not [bool]$runtimeImported[0]) {
            throw 'Secure local launcher failed.'
        }

        $getTask = Get-HmaLauncherOperation -Operations $Operations -Name 'GetTask'
        $testTask = Get-HmaLauncherOperation -Operations $Operations -Name 'TestTask'
        $tasks = [ordered]@{}
        foreach ($name in @('HowMuchAI-Service', 'HowMuchAI-Window')) {
            $taskResult = @(& $getTask $name)
            if ($taskResult.Count -ne 1 -or $null -eq $taskResult[0]) {
                throw 'Secure local launcher failed.'
            }
            $tasks[$name] = $taskResult[0]
        }
        foreach ($name in @('HowMuchAI-Service', 'HowMuchAI-Window')) {
            $valid = @(& $testTask $tasks[$name] $config $StateRoot)
            if ($valid.Count -ne 1 -or
                $valid[0] -isnot [bool] -or
                -not [bool]$valid[0]) {
                throw 'Secure local launcher failed.'
            }
        }

        $serviceState = [string]$tasks['HowMuchAI-Service'].State
        $startNames = if ($serviceState -ceq 'Ready') {
            @('HowMuchAI-Service', 'HowMuchAI-Window')
        } elseif ($serviceState -ceq 'Running') {
            @('HowMuchAI-Window')
        } else {
            throw 'Secure local launcher failed.'
        }
        $startTask = Get-HmaLauncherOperation `
            -Operations $Operations `
            -Name 'StartTask'
        foreach ($name in $startNames) {
            $started = @(& $startTask $name)
            if ($started.Count -ne 1 -or
                $started[0] -isnot [bool] -or
                -not [bool]$started[0]) {
                throw 'Secure local launcher failed.'
            }
        }
        return $true
    } catch {
        throw 'Secure local launcher failed.'
    }
}

if (-not $hmaLauncherWasDotSourced) {
    try {
        if ($hmaLauncherArguments.Count -ne 6 -or
            [string]$hmaLauncherArguments[0] -cne '-StateRoot' -or
            [string]$hmaLauncherArguments[2] -cne '-IntegrityModuleHash' -or
            [string]$hmaLauncherArguments[4] -cne '-LauncherHash') {
            throw 'Secure local launcher failed.'
        }
        $StateRoot = [string]$hmaLauncherArguments[1]
        $IntegrityModuleHash = [string]$hmaLauncherArguments[3]
        $LauncherHash = [string]$hmaLauncherArguments[5]
        $null = Invoke-HmaSecureLocalLauncherCore `
            -StateRoot $StateRoot `
            -IntegrityModuleHash $IntegrityModuleHash `
            -LauncherHash $LauncherHash `
            -Operations (Get-HmaLauncherDefaultOperations)
        exit 0
    } catch {
        $Error.Clear()
        [Console]::Error.WriteLine('Secure local launcher failed.')
        exit 1
    }
}
