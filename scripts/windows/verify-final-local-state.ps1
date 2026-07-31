# Invocation contract: the caller verifies this script's SHA-256 against the reviewed
# runtime manifest before starting a fresh Windows PowerShell 5.1 process with -File.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$StateRoot,
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$ExpectedRuntimeHash,
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$ExpectedIntegrityHash,
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$ExpectedSecretsHash
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$DebugPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$hmaFinalWasDotSourced = $MyInvocation.InvocationName -ceq '.'
$script:HmaFinalRuntimeModuleTrusted = $false

function Get-HmaFinalPropertyValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$InputObject,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $InputObject) {
        throw 'Final local state verification failed.'
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        throw 'Final local state verification failed.'
    }
    return $property.Value
}

function Get-HmaFinalOperation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Operations,
        [Parameter(Mandatory)][string]$Name
    )

    if (-not $Operations.ContainsKey($Name) -or
        $Operations[$Name] -isnot [scriptblock]) {
        throw 'Final local state verification failed.'
    }
    return [scriptblock]$Operations[$Name]
}

function Invoke-HmaFinalBooleanOperation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Operations,
        [Parameter(Mandatory)][string]$Name,
        [object[]]$Arguments = @()
    )

    $operation = Get-HmaFinalOperation -Operations $Operations -Name $Name
    $result = @(& $operation @Arguments)
    return (
        $result.Count -eq 1 -and
        $result[0] -is [bool] -and
        [bool]$result[0]
    )
}

function Test-HmaFinalHashEqual {
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

function Get-HmaFinalSafeAbsolutePath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)

    try {
        if ([string]::IsNullOrWhiteSpace($LiteralPath) -or
            $LiteralPath.IndexOfAny([char[]]@("'", '"')) -ge 0 -or
            -not [IO.Path]::IsPathRooted($LiteralPath)) {
            throw 'invalid'
        }
        foreach ($character in $LiteralPath.ToCharArray()) {
            if ([char]::IsControl($character)) {
                throw 'invalid'
            }
        }
        $fullPath = [IO.Path]::GetFullPath($LiteralPath)
        if ($fullPath -notmatch '^[A-Za-z]:\\') {
            throw 'invalid'
        }
        return $fullPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
    } catch {
        throw 'Final local state verification failed.'
    }
}

function Test-HmaFinalStableEdgePath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)

    try {
        $candidate = Get-HmaFinalSafeAbsolutePath -LiteralPath $LiteralPath
        foreach ($base in @(
                [Environment]::GetFolderPath(
                    [Environment+SpecialFolder]::ProgramFiles
                ),
                [Environment]::GetFolderPath(
                    [Environment+SpecialFolder]::ProgramFilesX86
                )
            )) {
            if ([string]::IsNullOrWhiteSpace($base)) {
                continue
            }
            $expected = [IO.Path]::GetFullPath(
                (Join-Path $base 'Microsoft\Edge\Application\msedge.exe')
            )
            if ([string]::Equals(
                    $candidate,
                    $expected,
                    [StringComparison]::OrdinalIgnoreCase
                )) {
                $signature = Get-AuthenticodeSignature `
                    -LiteralPath $candidate `
                    -ErrorAction Stop
                return (
                    [string]$signature.Status -ceq 'Valid' -and
                    $null -ne $signature.SignerCertificate -and
                    [string]$signature.SignerCertificate.Subject -match (
                        '(?:^|,\s*)O=Microsoft Corporation(?:,|$)'
                    )
                )
            }
        }
        return $false
    } catch {
        return $false
    }
}

function ConvertFrom-HmaFinalWindowsCommandLine {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$CommandLine)

    if ($null -eq ('HmaFinal.NativeCommandLine' -as [type])) {
        $null = Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace HmaFinal
{
    public static class NativeCommandLine
    {
        [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CommandLineToArgvW(
            [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
            out int argumentCount);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        public static string[] Split(string commandLine)
        {
            if (String.IsNullOrWhiteSpace(commandLine))
            {
                throw new ArgumentException("Invalid command line.");
            }

            int count;
            IntPtr arguments = CommandLineToArgvW(commandLine, out count);
            if (arguments == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            try
            {
                string[] result = new string[count];
                for (int index = 0; index < count; index++)
                {
                    result[index] = Marshal.PtrToStringUni(
                        Marshal.ReadIntPtr(arguments, index * IntPtr.Size));
                }
                return result;
            }
            finally
            {
                LocalFree(arguments);
            }
        }
    }
}
'@ -ErrorAction Stop
    }
    return [HmaFinal.NativeCommandLine]::Split($CommandLine)
}

function Test-HmaFinalDedicatedEdgeProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Process,
        [Parameter(Mandatory)][string]$ProfileArgument
    )

    try {
        $processId = [int](Get-HmaFinalPropertyValue -InputObject $Process -Name 'ProcessId')
        $executable = [string](Get-HmaFinalPropertyValue -InputObject $Process -Name 'ExecutablePath')
        $commandLine = [string](Get-HmaFinalPropertyValue -InputObject $Process -Name 'CommandLine')
        if ($processId -le 0 -or
            -not (Test-HmaFinalStableEdgePath -LiteralPath $executable)) {
            return $false
        }
        $arguments = @(ConvertFrom-HmaFinalWindowsCommandLine -CommandLine $commandLine)
        return @(
            $arguments | Where-Object {
                [string]::Equals(
                    [string]$_,
                    $ProfileArgument,
                    [StringComparison]::OrdinalIgnoreCase
                )
            }
        ).Count -eq 1
    } catch {
        return $false
    }
}

function Stop-HmaFinalDedicatedEdgeFallback {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$StateRoot)

    $allStopped = $true
    try {
        $state = Get-HmaFinalSafeAbsolutePath -LiteralPath $StateRoot
        $profileArgument = '--user-data-dir=' + (Join-Path $state 'edge-profile')
        $rows = @(
            Get-CimInstance `
                -ClassName Win32_Process `
                -Filter "Name = 'msedge.exe'" `
                -ErrorAction Stop
        )
        $candidateIds = New-Object 'Collections.Generic.List[int]'
        foreach ($row in $rows) {
            if (Test-HmaFinalDedicatedEdgeProcess `
                    -Process $row `
                    -ProfileArgument $profileArgument) {
                [void]$candidateIds.Add([int]$row.ProcessId)
            }
        }

        foreach ($candidateId in $candidateIds) {
            try {
                $current = @(
                    Get-CimInstance `
                        -ClassName Win32_Process `
                        -Filter ('ProcessId = ' + [string]$candidateId) `
                        -ErrorAction Stop
                )
                if ($current.Count -ne 1 -or
                    -not (Test-HmaFinalDedicatedEdgeProcess `
                        -Process $current[0] `
                        -ProfileArgument $profileArgument)) {
                    $allStopped = $false
                    continue
                }
                $null = Stop-Process `
                    -Id $candidateId `
                    -Force `
                    -ErrorAction Stop
                try {
                    $null = Wait-Process `
                        -Id $candidateId `
                        -Timeout 30 `
                        -ErrorAction Stop
                } catch {
                    if ($null -ne (Get-Process `
                            -Id $candidateId `
                            -ErrorAction SilentlyContinue)) {
                        throw
                    }
                }
            } catch {
                $allStopped = $false
            }
        }
        return $allStopped
    } catch {
        return $false
    }
}

function Stop-HmaFinalDedicatedEdge {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$StateRoot)

    try {
        $trustedCommand = Get-Command `
            -Name Stop-HmaDedicatedEdgeProfile `
            -CommandType Function `
            -ErrorAction SilentlyContinue
        if ($script:HmaFinalRuntimeModuleTrusted -and
            $null -ne $trustedCommand -and
            (Stop-HmaDedicatedEdgeProfile -StateRoot $StateRoot)) {
            return $true
        }
    } catch {
    }
    return Stop-HmaFinalDedicatedEdgeFallback -StateRoot $StateRoot
}

function Wait-HmaFinalDedicatedEdgeExit {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateRoot,
        [scriptblock]$ProcessProvider,
        [scriptblock]$DelayProvider,
        [ValidateRange(2, 600)][int]$MaximumAttempts = 150
    )

    try {
        $state = Get-HmaFinalSafeAbsolutePath -LiteralPath $StateRoot
        $profileArgument = '--user-data-dir=' + (Join-Path $state 'edge-profile')
        $stableEmptyScans = 0

        for ($attempt = 0; $attempt -lt $MaximumAttempts; $attempt += 1) {
            $rows = if ($null -ne $ProcessProvider) {
                @(& $ProcessProvider)
            } else {
                @(
                    Get-CimInstance `
                        -ClassName Win32_Process `
                        -Filter "Name = 'msedge.exe'" `
                        -ErrorAction Stop
                )
            }

            $profileProcessCount = 0
            foreach ($row in $rows) {
                $processId = [int](Get-HmaFinalPropertyValue `
                    -InputObject $row `
                    -Name 'ProcessId')
                $commandLine = [string](Get-HmaFinalPropertyValue `
                    -InputObject $row `
                    -Name 'CommandLine')
                if ($processId -le 0 -or
                    [string]::IsNullOrWhiteSpace($commandLine)) {
                    throw 'Final local state verification failed.'
                }
                $arguments = @(
                    ConvertFrom-HmaFinalWindowsCommandLine `
                        -CommandLine $commandLine
                )
                $profileMatches = @(
                    $arguments | Where-Object {
                        [string]::Equals(
                            [string]$_,
                            $profileArgument,
                            [StringComparison]::OrdinalIgnoreCase
                        )
                    }
                )
                if ($profileMatches.Count -gt 0) {
                    $profileProcessCount += 1
                }
            }

            if ($profileProcessCount -eq 0) {
                $stableEmptyScans += 1
                if ($stableEmptyScans -ge 2) {
                    return $true
                }
            } else {
                $stableEmptyScans = 0
            }

            if ($attempt + 1 -lt $MaximumAttempts) {
                if ($null -ne $DelayProvider) {
                    $null = & $DelayProvider
                } else {
                    Start-Sleep -Milliseconds 200
                }
            }
        }
        return $false
    } catch {
        return $false
    }
}

function Get-HmaFinalPortListeners {
    [CmdletBinding()]
    param()

    return @(
        Get-NetTCPConnection `
            -State Listen `
            -ErrorAction Stop |
            Where-Object {
                [int]$_.LocalPort -eq 37645 -and
                [string]$_.State -ceq 'Listen'
            }
    )
}

function Wait-HmaFinalTaskStopped {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$TaskName)

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $stableStoppedStates = 0
    do {
        try {
            $task = Get-ScheduledTask `
                -TaskName $TaskName `
                -ErrorAction Stop
            $state = [string]$task.State
            if ($state -ceq 'Ready' -or $state -ceq 'Disabled') {
                $stableStoppedStates += 1
                if ($stableStoppedStates -ge 2) {
                    return $true
                }
            } elseif ($state -ceq 'Running') {
                $stableStoppedStates = 0
            } else {
                return $false
            }
        } catch {
            return $false
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Wait-HmaFinalListenerExit {
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$ListenerPid)

    if ($ListenerPid -le 0) {
        return $false
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $ownedListeners = @(
            Get-HmaFinalPortListeners | Where-Object {
                [int]$_.OwningProcess -eq $ListenerPid
            }
        )
        $process = Get-Process `
            -Id $ListenerPid `
            -ErrorAction SilentlyContinue
        if ($ownedListeners.Count -eq 0 -and $null -eq $process) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Wait-HmaFinalPortListenersExit {
    [CmdletBinding()]
    param()

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        if (@(Get-HmaFinalPortListeners).Count -eq 0) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Test-HmaFinalNoSecretArguments {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Process,
        [Parameter(Mandatory)][object[]]$Values
    )

    try {
        $commandLine = [string](
            Get-HmaFinalPropertyValue -InputObject $Process -Name 'CommandLine'
        )
        if ([string]::IsNullOrWhiteSpace($commandLine) -or
            @($Values).Count -ne 3) {
            return $false
        }
        foreach ($candidate in @($Values)) {
            if ($candidate -isnot [string] -or
                [string]::IsNullOrEmpty([string]$candidate) -or
                $commandLine.IndexOf(
                    [string]$candidate,
                    [StringComparison]::Ordinal
                ) -ge 0) {
                return $false
            }
        }
        return $true
    } catch {
        return $false
    }
}

function Stop-HmaFinalValidatedListener {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$ListenerPid,
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)][object[]]$Values
    )

    try {
        $portListeners = @(
            Get-HmaFinalPortListeners | Where-Object {
                [int]$_.OwningProcess -eq $ListenerPid
            }
        )
        $listeners = @(
            Get-HmaFinalExactListenerRows -Rows $portListeners
        )
        $processes = @(
            Get-CimInstance `
                -ClassName Win32_Process `
                -Filter ('ProcessId = ' + [string]$ListenerPid) `
                -ErrorAction Stop
        )
        if ($portListeners.Count -ne 1 -or
            $listeners.Count -ne 1 -or
            $processes.Count -ne 1 -or
            -not (Test-HmaLiveServiceProcess `
                -Process $processes[0] `
                -Plan $Plan `
                -ListenerPid $ListenerPid) -or
            -not (Test-HmaFinalNoSecretArguments `
                -Process $processes[0] `
                -Values $Values)) {
            return $false
        }
        $null = Stop-Process `
            -Id $ListenerPid `
            -Force `
            -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function New-HmaFinalDefaultOperations {
    [CmdletBinding()]
    param()

    return @{
        GetFileHash = {
            param($LiteralPath)
            return [string](
                Get-FileHash `
                    -Algorithm SHA256 `
                    -LiteralPath ([string]$LiteralPath) `
                    -ErrorAction Stop
            ).Hash
        }
        ImportRuntime = {
            param($LiteralPath)
            Import-Module `
                -Name ([string]$LiteralPath) `
                -Force `
                -Global `
                -ErrorAction Stop
            $script:HmaFinalRuntimeModuleTrusted = $true
            return $true
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
        ImportSecrets = {
            param($LiteralPath)
            Import-Module `
                -Name ([string]$LiteralPath) `
                -Force `
                -Global `
                -ErrorAction Stop
            return $true
        }
        DecryptBundle = {
            param($LiteralPath)
            return Unprotect-HmaSecretBundle `
                -Path ([string]$LiteralPath)
        }
        BuildServicePlan = {
            param($Config, $RequestedStateRoot, $Bundle)
            return New-HmaServiceLaunchPlan `
                -Config $Config `
                -StateRoot ([string]$RequestedStateRoot) `
                -Bundle $Bundle
        }
        GetListeners = {
            return @(Get-HmaFinalPortListeners)
        }
        GetProcesses = {
            param($ListenerPid)
            return @(
                Get-CimInstance `
                    -ClassName Win32_Process `
                    -Filter ('ProcessId = ' + [string]$ListenerPid) `
                    -ErrorAction Stop
            )
        }
        TestLiveServiceProcess = {
            param($Process, $Plan, $ListenerPid)
            return [bool](Test-HmaLiveServiceProcess `
                -Process $Process `
                -Plan $Plan `
                -ListenerPid ([int]$ListenerPid))
        }
        CloseDedicatedEdge = {
            param($RequestedStateRoot)
            return [bool](Stop-HmaFinalDedicatedEdge `
                -StateRoot ([string]$RequestedStateRoot))
        }
        WaitDedicatedEdgeExit = {
            param($RequestedStateRoot)
            return [bool](Wait-HmaFinalDedicatedEdgeExit `
                -StateRoot ([string]$RequestedStateRoot))
        }
        StopTask = {
            param($TaskName)
            $null = Stop-ScheduledTask `
                -TaskName ([string]$TaskName) `
                -ErrorAction Stop
            return $true
        }
        WaitTaskStopped = {
            param($TaskName)
            return [bool](Wait-HmaFinalTaskStopped `
                -TaskName ([string]$TaskName))
        }
        WaitListenerExit = {
            param($ListenerPid)
            return [bool](Wait-HmaFinalListenerExit `
                -ListenerPid ([int]$ListenerPid))
        }
        WaitPortListenersExit = {
            return [bool](Wait-HmaFinalPortListenersExit)
        }
        TerminateValidatedListener = {
            param($ListenerPid, $Plan, $Values)
            return [bool](Stop-HmaFinalValidatedListener `
                -ListenerPid ([int]$ListenerPid) `
                -Plan $Plan `
                -Values @($Values))
        }
        TestPrivateState = {
            param($RequestedStateRoot)
            return [bool](Test-HmaPrivateAcl `
                -LiteralPath ([string]$RequestedStateRoot) `
                -Recurse)
        }
        TestNoExactValuesAtRest = {
            param($RequestedStateRoot, $Values)
            return [bool](Test-HmaNoExactValuesAtRest `
                -LiteralPath ([string]$RequestedStateRoot) `
                -Values @($Values))
        }
    }
}

function Get-HmaFinalSecretValues {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Bundle)

    $values = @(
        [string](Get-HmaFinalPropertyValue -InputObject $Bundle -Name 'appPassword'),
        [string](Get-HmaFinalPropertyValue -InputObject $Bundle -Name 'authSecret'),
        [string](Get-HmaFinalPropertyValue -InputObject $Bundle -Name 'vaultEncryptionSecret')
    )
    foreach ($value in $values) {
        if ([string]::IsNullOrWhiteSpace($value) -or
            $value.Length -lt 32 -or
            $value.Length -gt 4096) {
            throw 'Final local state verification failed.'
        }
    }
    if ([string]::Equals($values[0], $values[1], [StringComparison]::Ordinal) -or
        [string]::Equals($values[0], $values[2], [StringComparison]::Ordinal) -or
        [string]::Equals($values[1], $values[2], [StringComparison]::Ordinal)) {
        throw 'Final local state verification failed.'
    }
    return $values
}

function Get-HmaFinalExactListenerRows {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object[]]$Rows)

    $matches = New-Object 'Collections.Generic.List[object]'
    foreach ($row in @($Rows)) {
        try {
            if ([string](Get-HmaFinalPropertyValue `
                    -InputObject $row `
                    -Name 'LocalAddress') -ceq '127.0.0.1' -and
                [int](Get-HmaFinalPropertyValue `
                    -InputObject $row `
                    -Name 'LocalPort') -eq 37645 -and
                [string](Get-HmaFinalPropertyValue `
                    -InputObject $row `
                    -Name 'State') -ceq 'Listen' -and
                [int](Get-HmaFinalPropertyValue `
                    -InputObject $row `
                    -Name 'OwningProcess') -gt 0) {
                [void]$matches.Add($row)
            }
        } catch {
        }
    }
    return $matches.ToArray()
}

function Get-HmaFinalListenerOwner {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object[]]$Processes,
        [Parameter(Mandatory)][int]$ListenerPid
    )

    $matches = New-Object 'Collections.Generic.List[object]'
    foreach ($process in @($Processes)) {
        try {
            $processId = $null
            foreach ($name in @('ProcessId', 'Id')) {
                $property = $process.PSObject.Properties[$name]
                if ($null -ne $property) {
                    $processId = [int]$property.Value
                    break
                }
            }
            if ($null -ne $processId -and $processId -eq $ListenerPid) {
                [void]$matches.Add($process)
            }
        } catch {
        }
    }
    if ($matches.Count -ne 1) {
        throw 'Final local state verification failed.'
    }
    return $matches[0]
}

function Invoke-HmaFinalFailSafeShutdown {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][hashtable]$Operations,
        [AllowNull()]$ValidatedListenerPid,
        [AllowNull()]$ServicePlan,
        [AllowNull()][object[]]$SecretValues
    )

    foreach ($taskName in @('HowMuchAI-Window', 'HowMuchAI-Service')) {
        try {
            $null = Invoke-HmaFinalBooleanOperation `
                -Operations $Operations `
                -Name 'StopTask' `
                -Arguments @($taskName)
        } catch {
        }
    }

    $taskStopCount = 0
    foreach ($taskName in @('HowMuchAI-Window', 'HowMuchAI-Service')) {
        try {
            if (Invoke-HmaFinalBooleanOperation `
                    -Operations $Operations `
                    -Name 'WaitTaskStopped' `
                    -Arguments @($taskName)) {
                $taskStopCount += 1
            }
        } catch {
        }
    }

    $edgeCloseSucceeded = $false
    try {
        $edgeCloseSucceeded = Invoke-HmaFinalBooleanOperation `
            -Operations $Operations `
            -Name 'CloseDedicatedEdge' `
            -Arguments @($StateRoot)
    } catch {
        $edgeCloseSucceeded = $false
    }

    $edgeExitStable = $false
    try {
        $edgeExitStable = Invoke-HmaFinalBooleanOperation `
            -Operations $Operations `
            -Name 'WaitDedicatedEdgeExit' `
            -Arguments @($StateRoot)
    } catch {
        $edgeExitStable = $false
    }
    $edgeClosed = (
        [bool]$edgeCloseSucceeded -and
        [bool]$edgeExitStable
    )

    $listenerStopped = $false
    if ($null -eq $ValidatedListenerPid) {
        try {
            $listenerStopped = Invoke-HmaFinalBooleanOperation `
                -Operations $Operations `
                -Name 'WaitPortListenersExit'
        } catch {
            $listenerStopped = $false
        }
    } else {
        try {
            $listenerStopped = Invoke-HmaFinalBooleanOperation `
                -Operations $Operations `
                -Name 'WaitListenerExit' `
                -Arguments @([int]$ValidatedListenerPid)
        } catch {
            $listenerStopped = $false
        }
        if (-not $listenerStopped) {
            try {
                $null = Invoke-HmaFinalBooleanOperation `
                    -Operations $Operations `
                    -Name 'TerminateValidatedListener' `
                    -Arguments @(
                        [int]$ValidatedListenerPid,
                        $ServicePlan,
                        @($SecretValues)
                    )
            } catch {
            }
            try {
                $listenerStopped = Invoke-HmaFinalBooleanOperation `
                    -Operations $Operations `
                    -Name 'WaitListenerExit' `
                    -Arguments @([int]$ValidatedListenerPid)
            } catch {
                $listenerStopped = $false
            }
        }
        $portListenersStopped = $false
        try {
            $portListenersStopped = Invoke-HmaFinalBooleanOperation `
                -Operations $Operations `
                -Name 'WaitPortListenersExit'
        } catch {
            $portListenersStopped = $false
        }
        $listenerStopped = (
            [bool]$listenerStopped -and
            [bool]$portListenersStopped
        )
    }

    return [pscustomobject]@{
        edgeClosed = [bool]$edgeClosed
        taskStopCount = [int]$taskStopCount
        listenerStopped = [bool]$listenerStopped
    }
}

function Invoke-HmaFinalLocalStateCore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)]
        [ValidatePattern('^[a-fA-F0-9]{64}$')]
        [string]$ExpectedRuntimeHash,
        [Parameter(Mandatory)]
        [ValidatePattern('^[a-fA-F0-9]{64}$')]
        [string]$ExpectedIntegrityHash,
        [Parameter(Mandatory)]
        [ValidatePattern('^[a-fA-F0-9]{64}$')]
        [string]$ExpectedSecretsHash,
        [Parameter(Mandatory)][hashtable]$Operations
    )

    $bundle = $null
    $config = $null
    $secretValues = $null
    $servicePlan = $null
    $validatedListenerPid = $null
    $listenerCount = 0
    $moduleHashesValid = $false
    $startupIntegrityValid = $false
    $listenerOwnerValid = $false
    $secretArgumentsAbsent = $false
    $validationFailed = $false
    $shutdown = $null

    try {
        $bootstrapRoot = Join-Path $StateRoot 'bootstrap'
        $runtimeModule = Join-Path $bootstrapRoot 'SecureLocalRuntime.psm1'
        $integrityModule = Join-Path $bootstrapRoot 'SecureLocalIntegrity.psm1'
        $secretsModule = Join-Path $bootstrapRoot 'SecureLocalSecrets.psm1'
        $hashOperation = Get-HmaFinalOperation `
            -Operations $Operations `
            -Name 'GetFileHash'
        foreach ($entry in @(
                [pscustomobject]@{
                    Path = $runtimeModule
                    Expected = $ExpectedRuntimeHash
                },
                [pscustomobject]@{
                    Path = $integrityModule
                    Expected = $ExpectedIntegrityHash
                },
                [pscustomobject]@{
                    Path = $secretsModule
                    Expected = $ExpectedSecretsHash
                }
            )) {
            $actual = @(& $hashOperation ([string]$entry.Path))
            if ($actual.Count -ne 1 -or
                $actual[0] -isnot [string] -or
                -not (Test-HmaFinalHashEqual `
                    -Actual ([string]$actual[0]) `
                    -Expected ([string]$entry.Expected))) {
                throw 'Final local state verification failed.'
            }
        }
        $moduleHashesValid = $true

        foreach ($import in @(
                [pscustomobject]@{
                    Name = 'ImportRuntime'
                    Path = $runtimeModule
                },
                [pscustomobject]@{
                    Name = 'ImportIntegrity'
                    Path = $integrityModule
                }
            )) {
            if (-not (Invoke-HmaFinalBooleanOperation `
                    -Operations $Operations `
                    -Name ([string]$import.Name) `
                    -Arguments @([string]$import.Path))) {
                throw 'Final local state verification failed.'
            }
        }

        $integrityOperation = Get-HmaFinalOperation `
            -Operations $Operations `
            -Name 'AssertStartupIntegrity'
        $integrityResult = @(& $integrityOperation $StateRoot)
        if ($integrityResult.Count -ne 1 -or
            $null -eq $integrityResult[0]) {
            throw 'Final local state verification failed.'
        }
        $config = $integrityResult[0]
        $startupIntegrityValid = $true

        if (-not (Invoke-HmaFinalBooleanOperation `
                -Operations $Operations `
                -Name 'ImportSecrets' `
                -Arguments @($secretsModule))) {
            throw 'Final local state verification failed.'
        }
        $decryptOperation = Get-HmaFinalOperation `
            -Operations $Operations `
            -Name 'DecryptBundle'
        $decrypted = @(
            & $decryptOperation (Join-Path $StateRoot 'secrets.dpapi')
        )
        if ($decrypted.Count -ne 1 -or $null -eq $decrypted[0]) {
            throw 'Final local state verification failed.'
        }
        $bundle = $decrypted[0]
        $secretValues = @(Get-HmaFinalSecretValues -Bundle $bundle)

        $planOperation = Get-HmaFinalOperation `
            -Operations $Operations `
            -Name 'BuildServicePlan'
        $plans = @(& $planOperation $config $StateRoot $bundle)
        if ($plans.Count -ne 1 -or $null -eq $plans[0]) {
            throw 'Final local state verification failed.'
        }
        $servicePlan = $plans[0]

        $listenerOperation = Get-HmaFinalOperation `
            -Operations $Operations `
            -Name 'GetListeners'
        $portListenerRows = @(& $listenerOperation)
        $listenerCount = $portListenerRows.Count
        if ($listenerCount -ne 1) {
            throw 'Final local state verification failed.'
        }
        $listenerRows = @(
            Get-HmaFinalExactListenerRows -Rows $portListenerRows
        )
        if ($listenerRows.Count -ne 1) {
            throw 'Final local state verification failed.'
        }
        $listenerPid = [int](
            Get-HmaFinalPropertyValue `
                -InputObject $listenerRows[0] `
                -Name 'OwningProcess'
        )

        $processOperation = Get-HmaFinalOperation `
            -Operations $Operations `
            -Name 'GetProcesses'
        $listenerProcess = Get-HmaFinalListenerOwner `
            -Processes @(& $processOperation $listenerPid) `
            -ListenerPid $listenerPid
        if (-not (Invoke-HmaFinalBooleanOperation `
                -Operations $Operations `
                -Name 'TestLiveServiceProcess' `
                -Arguments @(
                    $listenerProcess,
                    $servicePlan,
                    $listenerPid
                ))) {
            throw 'Final local state verification failed.'
        }
        $listenerOwnerValid = $true

        if (-not (Test-HmaFinalNoSecretArguments `
                -Process $listenerProcess `
                -Values $secretValues)) {
            throw 'Final local state verification failed.'
        }
        $secretArgumentsAbsent = $true
        $validatedListenerPid = $listenerPid
    } catch {
        $validationFailed = $true
    } finally {
        try {
            $shutdown = Invoke-HmaFinalFailSafeShutdown `
                -StateRoot $StateRoot `
                -Operations $Operations `
                -ValidatedListenerPid $validatedListenerPid `
                -ServicePlan $servicePlan `
                -SecretValues $secretValues
        } catch {
            $shutdown = [pscustomobject]@{
                edgeClosed = $false
                taskStopCount = 0
                listenerStopped = $false
            }
        }
    }

    try {
        if ($validationFailed -or
            $null -eq $shutdown -or
            -not [bool]$shutdown.edgeClosed -or
            [int]$shutdown.taskStopCount -ne 2 -or
            -not [bool]$shutdown.listenerStopped) {
            throw 'Final local state verification failed.'
        }

        $aclValid = Invoke-HmaFinalBooleanOperation `
            -Operations $Operations `
            -Name 'TestPrivateState' `
            -Arguments @($StateRoot)
        if (-not $aclValid) {
            throw 'Final local state verification failed.'
        }

        $exactValuesAbsent = Invoke-HmaFinalBooleanOperation `
            -Operations $Operations `
            -Name 'TestNoExactValuesAtRest' `
            -Arguments @($StateRoot, @($secretValues))
        if (-not $exactValuesAbsent) {
            throw 'Final local state verification failed.'
        }

        return [pscustomobject]@{
            ok = $true
            moduleHashesValid = [bool]$moduleHashesValid
            startupIntegrityValid = [bool]$startupIntegrityValid
            listenerCount = [int]$listenerCount
            listenerOwnerValid = [bool]$listenerOwnerValid
            secretArgumentsAbsent = [bool]$secretArgumentsAbsent
            edgeClosed = [bool]$shutdown.edgeClosed
            taskStopCount = [int]$shutdown.taskStopCount
            listenerStopped = [bool]$shutdown.listenerStopped
            aclValid = [bool]$aclValid
            exactValuesAbsent = [bool]$exactValuesAbsent
        }
    } catch {
        throw 'Final local state verification failed.'
    } finally {
        $bundle = $null
        $config = $null
        $secretValues = $null
        $servicePlan = $null
        $validatedListenerPid = $null
    }
}

if (-not $hmaFinalWasDotSourced) {
    try {
        $summary = Invoke-HmaFinalLocalStateCore `
            -StateRoot $StateRoot `
            -ExpectedRuntimeHash $ExpectedRuntimeHash `
            -ExpectedIntegrityHash $ExpectedIntegrityHash `
            -ExpectedSecretsHash $ExpectedSecretsHash `
            -Operations (New-HmaFinalDefaultOperations)
        [Console]::Out.WriteLine(
            ($summary | ConvertTo-Json -Compress -Depth 3)
        )
        $summary = $null
        exit 0
    } catch {
        $Error.Clear()
        [Console]::Error.WriteLine(
            'Final local state verification failed.'
        )
        exit 1
    }
}
