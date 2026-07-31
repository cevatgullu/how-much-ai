Set-StrictMode -Version Latest

$script:HmaBaseEnvironmentNames = @(
    'APPDATA',
    'COMSPEC',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'WINDIR'
)

$script:HmaServiceEnvironmentNames = @(
    'APP_PASSWORD',
    'AUTH_SECRET',
    'ENABLE_LOCAL_CONNECT',
    'HMC_LISTEN_HOST',
    'HMC_LISTEN_PORT',
    'HMC_STRICT_LOCAL_MODE',
    'NEXT_TELEMETRY_DISABLED',
    'NODE_ENV',
    'PORT',
    'TRUST_PROXY_IP_HEADERS',
    'VAULT_DATA_DIR',
    'VAULT_ENCRYPTION_SECRET'
)

if ($null -eq ('Hma.NativeCommandLine' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Hma
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
                throw new ArgumentException("The command line is invalid.");
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
                    IntPtr value = Marshal.ReadIntPtr(arguments, index * IntPtr.Size);
                    result[index] = Marshal.PtrToStringUni(value);
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

function Get-HmaPropertyValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$InputObject,
        [Parameter(Mandatory)][string]$Name
    )

    if ($InputObject -is [Collections.IDictionary]) {
        if (-not $InputObject.Contains($Name)) {
            throw 'The launch configuration is invalid.'
        }
        return $InputObject[$Name]
    }

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        throw 'The launch configuration is invalid.'
    }
    return $property.Value
}

function Get-HmaSafeAbsolutePath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)

    try {
        if ([string]::IsNullOrWhiteSpace($LiteralPath) -or
            $LiteralPath.IndexOfAny([char[]]@("'", '"')) -ge 0) {
            throw 'The path is invalid.'
        }
        foreach ($character in $LiteralPath.ToCharArray()) {
            if ([char]::IsControl($character)) {
                throw 'The path is invalid.'
            }
        }
        if (-not [IO.Path]::IsPathRooted($LiteralPath)) {
            throw 'The path is invalid.'
        }

        $fullPath = [IO.Path]::GetFullPath($LiteralPath)
        if ($fullPath -notmatch '^[A-Za-z]:\\') {
            throw 'The path is invalid.'
        }
        return $fullPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
    } catch {
        throw 'The path is invalid.'
    }
}

function Get-HmaRequiredSecret {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Bundle,
        [Parameter(Mandatory)][string]$Name
    )

    $value = Get-HmaPropertyValue -InputObject $Bundle -Name $Name
    if ($value -isnot [string] -or
        [string]::IsNullOrWhiteSpace([string]$value) -or
        ([string]$value).Length -lt 32 -or
        ([string]$value).Length -gt 4096) {
        throw 'The secret bundle is invalid.'
    }
    return [string]$value
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

function ConvertFrom-HmaWindowsCommandLine {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$CommandLine)

    return [Hma.NativeCommandLine]::Split($CommandLine)
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

function Test-HmaStableEdgePath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)

    try {
        $path = Get-HmaSafeAbsolutePath -LiteralPath $LiteralPath
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
            if (Test-HmaOrdinalEqual -Left $path -Right $expected -IgnoreCase) {
                return $true
            }
        }
        return $false
    } catch {
        return $false
    }
}

function New-HmaMinimalChildEnvironment {
    [CmdletBinding()]
    param()

    $environment = [ordered]@{}
    foreach ($name in $script:HmaBaseEnvironmentNames) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if (-not [string]::IsNullOrEmpty($value)) {
            $environment[$name] = $value
        }
    }
    return $environment
}

function Set-HmaExactProcessEnvironment {
    [CmdletBinding()]
    param([Parameter(Mandatory)][Collections.IDictionary]$Environment)

    $validated = New-Object 'Collections.Generic.List[Collections.DictionaryEntry]'
    foreach ($entry in $Environment.GetEnumerator()) {
        if ($entry.Key -isnot [string] -or
            $entry.Value -isnot [string] -or
            [string]::IsNullOrEmpty([string]$entry.Value)) {
            throw 'The child environment is invalid.'
        }

        $name = [string]$entry.Key
        if (-not ($script:HmaBaseEnvironmentNames -ccontains $name) -and
            -not ($script:HmaServiceEnvironmentNames -ccontains $name)) {
            throw 'The child environment is invalid.'
        }
        [void]$validated.Add($entry)
    }

    $current = [Environment]::GetEnvironmentVariables('Process')
    foreach ($name in @($current.Keys)) {
        [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
    }
    foreach ($entry in $validated) {
        [Environment]::SetEnvironmentVariable(
            [string]$entry.Key,
            [string]$entry.Value,
            'Process'
        )
    }
}

function New-HmaServiceLaunchPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)]$Bundle
    )

    $appRoot = Get-HmaSafeAbsolutePath -LiteralPath (
        [string](Get-HmaPropertyValue -InputObject $Config -Name 'appRoot')
    )
    $nodePath = Get-HmaSafeAbsolutePath -LiteralPath (
        [string](Get-HmaPropertyValue -InputObject $Config -Name 'nodePath')
    )
    $state = Get-HmaSafeAbsolutePath -LiteralPath $StateRoot
    try {
        $port = [int](Get-HmaPropertyValue -InputObject $Config -Name 'port')
    } catch {
        throw 'The launch configuration is invalid.'
    }
    if ($port -ne 37645) {
        throw 'The launch configuration is invalid.'
    }

    $appPassword = Get-HmaRequiredSecret -Bundle $Bundle -Name 'appPassword'
    $authSecret = Get-HmaRequiredSecret -Bundle $Bundle -Name 'authSecret'
    $vaultSecret = Get-HmaRequiredSecret -Bundle $Bundle -Name 'vaultEncryptionSecret'
    if ((Test-HmaOrdinalEqual -Left $appPassword -Right $authSecret) -or
        (Test-HmaOrdinalEqual -Left $appPassword -Right $vaultSecret) -or
        (Test-HmaOrdinalEqual -Left $authSecret -Right $vaultSecret)) {
        throw 'The secret bundle is invalid.'
    }

    $environment = New-HmaMinimalChildEnvironment
    $environment['APP_PASSWORD'] = $appPassword
    $environment['AUTH_SECRET'] = $authSecret
    $environment['ENABLE_LOCAL_CONNECT'] = '1'
    $environment['HMC_LISTEN_HOST'] = '127.0.0.1'
    $environment['HMC_LISTEN_PORT'] = '37645'
    $environment['HMC_STRICT_LOCAL_MODE'] = '1'
    $environment['NEXT_TELEMETRY_DISABLED'] = '1'
    $environment['NODE_ENV'] = 'production'
    $environment['PORT'] = '37645'
    $environment['TRUST_PROXY_IP_HEADERS'] = '0'
    $environment['VAULT_DATA_DIR'] = Join-Path $state 'vault'
    $environment['VAULT_ENCRYPTION_SECRET'] = $vaultSecret

    return [pscustomobject]@{
        FilePath = $nodePath
        WorkingDirectory = $appRoot
        ArgumentList = @(
            (Join-Path $appRoot 'node_modules\next\dist\bin\next'),
            'start',
            '--hostname',
            '127.0.0.1',
            '--port',
            ([string]$port)
        )
        Environment = $environment
    }
}

function Test-HmaLiveServiceProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Process,
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)][int]$ListenerPid
    )

    try {
        if ($ListenerPid -le 0) {
            return $false
        }

        $processId = $null
        foreach ($name in @('ProcessId', 'Id')) {
            $property = $Process.PSObject.Properties[$name]
            if ($null -ne $property) {
                $processId = [int]$property.Value
                break
            }
        }
        if ($null -eq $processId -or $processId -ne $ListenerPid) {
            return $false
        }

        $executable = [string](Get-HmaPropertyValue -InputObject $Process -Name 'ExecutablePath')
        $commandLine = [string](Get-HmaPropertyValue -InputObject $Process -Name 'CommandLine')
        $expectedExecutable = [string](Get-HmaPropertyValue -InputObject $Plan -Name 'FilePath')
        $expectedArguments = @(
            Get-HmaPropertyValue -InputObject $Plan -Name 'ArgumentList'
        )
        if (-not (Test-HmaOrdinalEqual -Left $executable -Right $expectedExecutable -IgnoreCase)) {
            return $false
        }

        $arguments = @(ConvertFrom-HmaWindowsCommandLine -CommandLine $commandLine)
        if ($arguments.Count -ne ($expectedArguments.Count + 1) -or
            -not (Test-HmaOrdinalEqual -Left ([string]$arguments[0]) -Right $expectedExecutable -IgnoreCase)) {
            return $false
        }
        for ($index = 0; $index -lt $expectedArguments.Count; $index += 1) {
            if (-not (Test-HmaOrdinalEqual `
                    -Left ([string]$arguments[$index + 1]) `
                    -Right ([string]$expectedArguments[$index]))) {
                return $false
            }
        }
        return $true
    } catch {
        return $false
    }
}

function New-HmaEdgeLaunchPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$EdgePath,
        [Parameter(Mandatory)][string]$LaunchUri
    )

    $state = Get-HmaSafeAbsolutePath -LiteralPath $StateRoot
    $edge = Get-HmaSafeAbsolutePath -LiteralPath $EdgePath
    try {
        $port = [int](Get-HmaPropertyValue -InputObject $Config -Name 'port')
    } catch {
        throw 'The launch configuration is invalid.'
    }
    if ($port -ne 37645 -or -not (Test-HmaStableEdgePath -LiteralPath $edge)) {
        throw 'The Edge launch configuration is invalid.'
    }

    $rootPattern = '^http://127\.0\.0\.1:' + [string]$port + '/$'
    $bootstrapPattern = '^http://127\.0\.0\.1:' + [string]$port +
        '/bootstrap#bootstrap=[A-Za-z0-9_-]{43}$'
    if ($LaunchUri -cnotmatch $rootPattern -and
        $LaunchUri -cnotmatch $bootstrapPattern) {
        throw 'The Edge launch URI is invalid.'
    }

    $arguments = @(
        ('--app=' + $LaunchUri),
        ('--user-data-dir=' + (Join-Path $state 'edge-profile')),
        '--no-first-run',
        '--disable-background-mode'
    )
    return [pscustomobject]@{
        FilePath = $edge
        ArgumentList = @($arguments | ForEach-Object {
                ConvertTo-HmaWindowsCommandLineArgument -Value ([string]$_)
            })
        WindowStyle = 'Normal'
        Environment = New-HmaMinimalChildEnvironment
    }
}

function Get-HmaRequiredSha256 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Hashes,
        [Parameter(Mandatory)][string]$Name
    )

    $value = Get-HmaPropertyValue -InputObject $Hashes -Name $Name
    if ($value -isnot [string] -or [string]$value -cnotmatch '^[a-fA-F0-9]{64}$') {
        throw 'The bootstrap hash map is invalid.'
    }
    return ([string]$value).ToLowerInvariant()
}

function New-HmaTaskActionArguments {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [Parameter(Mandatory)][string]$ScriptHash,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$IntegrityHash
    )

    $command = "& { " +
        "`$scriptPath = '$ScriptPath'; " +
        "if ((Get-FileHash -Algorithm SHA256 -LiteralPath `$scriptPath).Hash.ToLowerInvariant() -cne '$ScriptHash') { throw 'Bootstrap verification failed.' }; " +
        "& `$scriptPath -StateRoot '$StateRoot' -IntegrityModuleHash '$IntegrityHash' }"
    return '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' +
        $command.Replace('"', '\"') + '"'
}

function New-HmaTaskPlans {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BootstrapRoot,
        [Parameter(Mandatory)][string]$StateRoot,
        [Parameter(Mandatory)][string]$PowerShellPath,
        [Parameter(Mandatory)]$BootstrapHashes
    )

    $bootstrap = Get-HmaSafeAbsolutePath -LiteralPath $BootstrapRoot
    $state = Get-HmaSafeAbsolutePath -LiteralPath $StateRoot
    $powershell = Get-HmaSafeAbsolutePath -LiteralPath $PowerShellPath
    if ($powershell -cnotmatch '(?i)\\WindowsPowerShell\\v1\.0\\powershell\.exe$') {
        throw 'Windows PowerShell 5.1 is required.'
    }

    $startHash = Get-HmaRequiredSha256 -Hashes $BootstrapHashes -Name 'start'
    $openHash = Get-HmaRequiredSha256 -Hashes $BootstrapHashes -Name 'open'
    $integrityHash = Get-HmaRequiredSha256 -Hashes $BootstrapHashes -Name 'integrity'
    $definitions = @(
        [pscustomobject]@{
            Name = 'HowMuchAI-Service'
            ScriptName = 'start-secure-local.ps1'
            ScriptHash = $startHash
        },
        [pscustomobject]@{
            Name = 'HowMuchAI-Window'
            ScriptName = 'open-secure-local.ps1'
            ScriptHash = $openHash
        }
    )

    foreach ($definition in $definitions) {
        $scriptPath = Join-Path $bootstrap $definition.ScriptName
        [pscustomobject]@{
            Name = $definition.Name
            FilePath = $powershell
            ActionArguments = New-HmaTaskActionArguments `
                -ScriptPath $scriptPath `
                -ScriptHash $definition.ScriptHash `
                -StateRoot $state `
                -IntegrityHash $integrityHash
            RunLevel = 'Limited'
        }
    }
}

function Test-HmaRegisteredTaskPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Task,
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][string]$StateRoot
    )

    try {
        $state = Get-HmaSafeAbsolutePath -LiteralPath $StateRoot
        $bootstrap = Join-Path $state 'bootstrap'
        $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $hashes = Get-HmaPropertyValue -InputObject $Config -Name 'bootstrapHashes'
        $plans = @(
            New-HmaTaskPlans `
                -BootstrapRoot $bootstrap `
                -StateRoot $state `
                -PowerShellPath $powershell `
                -BootstrapHashes $hashes
        )

        $taskName = $null
        foreach ($name in @('TaskName', 'Name')) {
            $property = $Task.PSObject.Properties[$name]
            if ($null -ne $property) {
                $taskName = [string]$property.Value
                break
            }
        }
        $expected = @($plans | Where-Object { $_.Name -ceq $taskName })
        if ($expected.Count -ne 1) {
            return $false
        }
        $expectedPlan = $expected[0]

        $principal = Get-HmaPropertyValue -InputObject $Task -Name 'Principal'
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        if (-not (Test-HmaOrdinalEqual `
                -Left ([string](Get-HmaPropertyValue -InputObject $principal -Name 'UserId')) `
                -Right $currentSid) -or
            [string](Get-HmaPropertyValue -InputObject $principal -Name 'LogonType') -cnotin @(
                'Interactive',
                'InteractiveToken'
            ) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string](Get-HmaPropertyValue -InputObject $principal -Name 'RunLevel')) `
                -Right 'Limited')) {
            return $false
        }

        $actions = @(Get-HmaPropertyValue -InputObject $Task -Name 'Actions')
        $triggers = @(Get-HmaPropertyValue -InputObject $Task -Name 'Triggers')
        $settings = Get-HmaPropertyValue -InputObject $Task -Name 'Settings'
        $triggerType = $null
        if ($triggers.Count -eq 1) {
            $typeProperty = $triggers[0].PSObject.Properties['TriggerType']
            if ($null -ne $typeProperty) {
                $triggerType = [string]$typeProperty.Value
            } else {
                $cimClassProperty = $triggers[0].PSObject.Properties['CimClass']
                if ($null -ne $cimClassProperty -and $null -ne $cimClassProperty.Value) {
                    $classNameProperty = $cimClassProperty.Value.PSObject.Properties['CimClassName']
                    if ($null -ne $classNameProperty) {
                        $triggerType = [string]$classNameProperty.Value
                    }
                }
            }
        }
        if ($actions.Count -ne 1 -or
            $triggers.Count -ne 1 -or
            $triggerType -cnotin @('Logon', 'MSFT_TaskLogonTrigger') -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string](Get-HmaPropertyValue -InputObject $actions[0] -Name 'Execute')) `
                -Right ([string]$expectedPlan.FilePath) `
                -IgnoreCase) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string](Get-HmaPropertyValue -InputObject $actions[0] -Name 'Arguments')) `
                -Right ([string]$expectedPlan.ActionArguments)) -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string](Get-HmaPropertyValue -InputObject $triggers[0] -Name 'UserId')) `
                -Right $currentSid) -or
            -not [bool](Get-HmaPropertyValue -InputObject $settings -Name 'StartWhenAvailable') -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string](Get-HmaPropertyValue -InputObject $settings -Name 'MultipleInstances')) `
                -Right 'IgnoreNew') -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string](Get-HmaPropertyValue -InputObject $settings -Name 'ExecutionTimeLimit')) `
                -Right 'PT0S') -or
            [int](Get-HmaPropertyValue -InputObject $settings -Name 'RestartCount') -ne 3 -or
            -not (Test-HmaOrdinalEqual `
                -Left ([string](Get-HmaPropertyValue -InputObject $settings -Name 'RestartInterval')) `
                -Right 'PT1M')) {
            return $false
        }

        $xmlProperty = $Task.PSObject.Properties['Xml']
        if ($null -eq $xmlProperty -or [string]::IsNullOrWhiteSpace([string]$xmlProperty.Value)) {
            return $false
        }
        [xml]$xml = [string]$xmlProperty.Value
        $namespace = New-Object Xml.XmlNamespaceManager($xml.NameTable)
        $namespace.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
        if ($xml.SelectNodes('//t:Principals/t:Principal', $namespace).Count -ne 1 -or
            $xml.SelectNodes('//t:Triggers/*', $namespace).Count -ne 1 -or
            $xml.SelectNodes('//t:Triggers/t:LogonTrigger', $namespace).Count -ne 1 -or
            $xml.SelectNodes('//t:Actions/t:Exec', $namespace).Count -ne 1) {
            return $false
        }
        $xmlValues = @{
            PrincipalUser = [string]$xml.SelectSingleNode('//t:Principals/t:Principal/t:UserId', $namespace).InnerText
            LogonType = [string]$xml.SelectSingleNode('//t:Principals/t:Principal/t:LogonType', $namespace).InnerText
            RunLevel = [string]$xml.SelectSingleNode('//t:Principals/t:Principal/t:RunLevel', $namespace).InnerText
            TriggerUser = [string]$xml.SelectSingleNode('//t:Triggers/t:LogonTrigger/t:UserId', $namespace).InnerText
            Command = [string]$xml.SelectSingleNode('//t:Actions/t:Exec/t:Command', $namespace).InnerText
            Arguments = [string]$xml.SelectSingleNode('//t:Actions/t:Exec/t:Arguments', $namespace).InnerText
            MultipleInstances = [string]$xml.SelectSingleNode('//t:Settings/t:MultipleInstancesPolicy', $namespace).InnerText
            StartWhenAvailable = [string]$xml.SelectSingleNode('//t:Settings/t:StartWhenAvailable', $namespace).InnerText
            ExecutionTimeLimit = [string]$xml.SelectSingleNode('//t:Settings/t:ExecutionTimeLimit', $namespace).InnerText
            RestartInterval = [string]$xml.SelectSingleNode('//t:Settings/t:RestartOnFailure/t:Interval', $namespace).InnerText
            RestartCount = [string]$xml.SelectSingleNode('//t:Settings/t:RestartOnFailure/t:Count', $namespace).InnerText
        }
        if (-not (Test-HmaOrdinalEqual -Left $xmlValues.PrincipalUser -Right $currentSid) -or
            -not (Test-HmaOrdinalEqual -Left $xmlValues.LogonType -Right 'InteractiveToken') -or
            -not (Test-HmaOrdinalEqual -Left $xmlValues.RunLevel -Right 'LeastPrivilege') -or
            -not (Test-HmaOrdinalEqual -Left $xmlValues.TriggerUser -Right $currentSid) -or
            -not (Test-HmaOrdinalEqual -Left $xmlValues.Command -Right ([string]$expectedPlan.FilePath) -IgnoreCase) -or
            -not (Test-HmaOrdinalEqual -Left $xmlValues.Arguments -Right ([string]$expectedPlan.ActionArguments)) -or
            -not (Test-HmaOrdinalEqual -Left $xmlValues.MultipleInstances -Right 'IgnoreNew') -or
            -not (Test-HmaOrdinalEqual -Left $xmlValues.StartWhenAvailable -Right 'true' -IgnoreCase) -or
            -not (Test-HmaOrdinalEqual -Left $xmlValues.ExecutionTimeLimit -Right 'PT0S') -or
            -not (Test-HmaOrdinalEqual -Left $xmlValues.RestartInterval -Right 'PT1M') -or
            -not (Test-HmaOrdinalEqual -Left $xmlValues.RestartCount -Right '3')) {
            return $false
        }
        return $true
    } catch {
        return $false
    }
}

function Stop-HmaDedicatedEdgeProfile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateRoot,
        [scriptblock]$ProcessProvider,
        [scriptblock]$Terminator,
        [scriptblock]$Waiter
    )

    try {
        $state = Get-HmaSafeAbsolutePath -LiteralPath $StateRoot
        $profileArgument = '--user-data-dir=' + (Join-Path $state 'edge-profile')
        $rows = if ($null -ne $ProcessProvider) {
            @(& $ProcessProvider)
        } else {
            @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction Stop)
        }

        $matches = New-Object 'Collections.Generic.List[object]'
        foreach ($row in $rows) {
            $executableProperty = $row.PSObject.Properties['ExecutablePath']
            $commandProperty = $row.PSObject.Properties['CommandLine']
            $idProperty = $row.PSObject.Properties['ProcessId']
            if ($null -eq $executableProperty -or
                $null -eq $commandProperty -or
                $null -eq $idProperty -or
                -not (Test-HmaStableEdgePath -LiteralPath ([string]$executableProperty.Value))) {
                continue
            }

            $arguments = @(ConvertFrom-HmaWindowsCommandLine -CommandLine ([string]$commandProperty.Value))
            $profileMatches = @(
                $arguments | Where-Object {
                    Test-HmaOrdinalEqual -Left ([string]$_) -Right $profileArgument -IgnoreCase
                }
            )
            if ($profileMatches.Count -eq 1) {
                [void]$matches.Add($row)
            }
        }

        foreach ($row in $matches) {
            $processId = [int]$row.ProcessId
            $terminated = if ($null -ne $Terminator) {
                & $Terminator $processId
            } else {
                Stop-Process -Id $processId -Force -ErrorAction Stop
                $true
            }
            if ($terminated -isnot [bool] -or -not [bool]$terminated) {
                return $false
            }

            $waited = if ($null -ne $Waiter) {
                & $Waiter $processId
            } else {
                Wait-Process -Id $processId -Timeout 30 -ErrorAction Stop
                $true
            }
            if ($waited -isnot [bool] -or -not [bool]$waited) {
                return $false
            }
        }
        return $true
    } catch {
        return $false
    }
}

Export-ModuleMember -Function @(
    'New-HmaMinimalChildEnvironment',
    'Set-HmaExactProcessEnvironment',
    'New-HmaServiceLaunchPlan',
    'Test-HmaLiveServiceProcess',
    'New-HmaEdgeLaunchPlan',
    'New-HmaTaskPlans',
    'Test-HmaRegisteredTaskPlan',
    'Stop-HmaDedicatedEdgeProfile'
)
