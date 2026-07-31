[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$StateRoot,
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$IntegrityModuleHash
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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
            $fullCandidate = [IO.Path]::GetFullPath($candidate)
            $rootPath = [IO.Path]::GetPathRoot($fullCandidate)
            if ([string]::IsNullOrWhiteSpace($rootPath) -or
                $rootPath -notmatch '^[A-Za-z]:\\$') {
                throw 'The Edge path is invalid.'
            }

            $currentPath = $rootPath
            $segments = @(
                $fullCandidate.Substring($rootPath.Length).Split(
                    [char[]]@(
                        [IO.Path]::DirectorySeparatorChar,
                        [IO.Path]::AltDirectorySeparatorChar
                    ),
                    [StringSplitOptions]::RemoveEmptyEntries
                )
            )
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
                    ($isLeaf -and $item.PSIsContainer) -or
                    (-not $isLeaf -and -not $item.PSIsContainer) -or
                    -not [string]::Equals(
                        [IO.Path]::GetFullPath($currentPath),
                        [IO.Path]::GetFullPath([string]$item.FullName),
                        [StringComparison]::OrdinalIgnoreCase
                    )) {
                    throw 'The Edge path is invalid.'
                }
            }

            $signature = Get-AuthenticodeSignature `
                -LiteralPath $fullCandidate `
                -ErrorAction Stop
            if ([string]$signature.Status -cne 'Valid' -or
                $null -eq $signature.SignerCertificate -or
                [string]$signature.SignerCertificate.Subject -notmatch (
                    '(?:^|,\s*)O=Microsoft Corporation(?:,|$)'
                )) {
                continue
            }
            return $fullCandidate
        } catch {
        }
    }
    throw 'Microsoft Edge validation failed.'
}

function Test-HmaReadyResponse {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Response)

    try {
        $statusCode = [int]$Response.StatusCode
        if ($statusCode -eq 200) {
            return $true
        }
        if ($statusCode -notin @(307, 308)) {
            return $false
        }
        $location = [string]$Response.Headers['Location']
        return (
            [string]::Equals($location, '/login', [StringComparison]::Ordinal) -or
            [string]::Equals(
                $location,
                'http://127.0.0.1:37645/login',
                [StringComparison]::Ordinal
            )
        )
    } catch {
        return $false
    }
}

function Wait-HmaSecureLocalReady {
    [CmdletBinding()]
    param()

    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    try {
        while ($stopwatch.ElapsedMilliseconds -lt 300000) {
            $readinessResponse = $null
            try {
                $readinessResponse = Invoke-WebRequest `
                    -Uri 'http://127.0.0.1:37645/login' `
                    -UseBasicParsing `
                    -MaximumRedirection 0 `
                    -TimeoutSec 5 `
                    -ErrorAction Stop
                if (Test-HmaReadyResponse -Response $readinessResponse) {
                    return
                }
            } catch {
                try {
                    $webResponse = $_.Exception.Response
                    if ($null -ne $webResponse -and
                        (Test-HmaReadyResponse -Response $webResponse)) {
                        return
                    }
                } catch {
                }
            } finally {
                $readinessResponse = $null
            }
            Start-Sleep -Milliseconds 500
        }
    } finally {
        $stopwatch.Stop()
    }
    throw 'The service did not become ready.'
}

function Get-HmaVerifiedServiceListenerPid {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Plan
    )

    try {
        $listeners = @(
            Get-NetTCPConnection `
                -State Listen `
                -ErrorAction Stop
        )
        $listeners = @($listeners | Where-Object {
                [int]$_.LocalPort -eq 37645
            })
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
    } catch {
        throw 'The listener is invalid.'
    }
}

function Get-HmaBootstrapTicket {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Password)

    $requestBody = $null
    $response = $null
    try {
        $requestBody = ConvertTo-Json `
            -InputObject ([ordered]@{ password = $Password }) `
            -Compress
        $response = Invoke-WebRequest `
            -Uri 'http://127.0.0.1:37645/api/auth/bootstrap/start' `
            -Method Post `
            -ContentType 'application/json' `
            -Body $requestBody `
            -UseBasicParsing `
            -MaximumRedirection 0 `
            -TimeoutSec 10 `
            -ErrorAction Stop
        if ([int]$response.StatusCode -ne 200 -or
            [string]::IsNullOrWhiteSpace([string]$response.Content) -or
            ([string]$response.Content).Length -gt 4096) {
            throw 'The bootstrap response is invalid.'
        }

        $payload = ConvertFrom-Json -InputObject ([string]$response.Content) -ErrorAction Stop
        $properties = @($payload.PSObject.Properties | ForEach-Object { $_.Name })
        if ([bool](Compare-Object `
                -ReferenceObject @('expiresInMs', 'ticket') `
                -DifferenceObject @($properties | Sort-Object) `
                -CaseSensitive) -or
            $payload.expiresInMs -isnot [int] -or
            [int]$payload.expiresInMs -ne 20000 -or
            $payload.ticket -isnot [string] -or
            [string]$payload.ticket -cnotmatch '^[A-Za-z0-9_-]{43}$') {
            throw 'The bootstrap response is invalid.'
        }
        return [string]$payload.ticket
    } catch {
        throw 'The bootstrap request failed.'
    } finally {
        $requestBody = $null
        $response = $null
        $payload = $null
    }
}

$bundle = $null
$password = $null
$ticket = $null
$response = $null
$servicePlan = $null
$edgePlan = $null
try {
    $state = [IO.Path]::GetFullPath($StateRoot)
    $bootstrap = Join-Path $state 'bootstrap'
    $integrityModule = Join-Path $bootstrap 'SecureLocalIntegrity.psm1'
    $actualIntegrityHash = (Get-FileHash `
            -Algorithm SHA256 `
            -LiteralPath $integrityModule `
            -ErrorAction Stop).Hash
    if (-not [string]::Equals(
            $actualIntegrityHash,
            $IntegrityModuleHash,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'The integrity module is invalid.'
    }

    Import-Module $integrityModule -Force -ErrorAction Stop
    $config = Assert-HmaStartupIntegrity -StateRoot $state
    Import-Module (Join-Path $bootstrap 'SecureLocalRuntime.psm1') `
        -Force `
        -ErrorAction Stop

    Import-Module (Join-Path $bootstrap 'SecureLocalSecrets.psm1') `
        -Force `
        -ErrorAction Stop
    $bundle = Unprotect-HmaSecretBundle -Path (Join-Path $state 'secrets.dpapi')
    $password = [string]$bundle.appPassword
    $servicePlan = New-HmaServiceLaunchPlan `
        -Config $config `
        -StateRoot $state `
        -Bundle $bundle
    $firstListenerPid = Get-HmaVerifiedServiceListenerPid -Plan $servicePlan

    $edgePath = Get-HmaStableMicrosoftEdge
    Wait-HmaSecureLocalReady

    $ticket = Get-HmaBootstrapTicket -Password $password
    $secondListenerPid = Get-HmaVerifiedServiceListenerPid -Plan $servicePlan
    if ($secondListenerPid -ne $firstListenerPid) {
        $ticket = $null
        throw 'The listener changed.'
    }

    $launchUri = 'http://127.0.0.1:37645/bootstrap#bootstrap=' + $ticket
    $edgePlan = New-HmaEdgeLaunchPlan `
        -Config $config `
        -StateRoot $state `
        -EdgePath $edgePath `
        -LaunchUri $launchUri
    Set-HmaExactProcessEnvironment -Environment $edgePlan.Environment
    Start-Process `
        -FilePath $edgePlan.FilePath `
        -ArgumentList $edgePlan.ArgumentList `
        -WindowStyle $edgePlan.WindowStyle | Out-Null
} catch {
    throw 'Secure local window launch failed.'
} finally {
    $edgePlan = $null
    $servicePlan = $null
    $response = $null
    $ticket = $null
    $password = $null
    $bundle = $null
}
