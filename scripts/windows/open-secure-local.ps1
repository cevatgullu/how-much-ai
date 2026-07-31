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

function ConvertTo-HmaBase64Url {
    [CmdletBinding()]
    param([Parameter(Mandatory)][byte[]]$Bytes)

    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Test-HmaCanonicalBase64Url32 {
    [CmdletBinding()]
    param([AllowNull()][object]$Value)

    if ($Value -isnot [string] -or
        [string]$Value -cnotmatch '^[A-Za-z0-9_-]{43}$') {
        return $false
    }
    $decoded = $null
    try {
        $encoded = ([string]$Value).Replace('-', '+').Replace('_', '/') + '='
        $decoded = [Convert]::FromBase64String($encoded)
        return (
            $decoded.Length -eq 32 -and
            [string]::Equals(
                (ConvertTo-HmaBase64Url -Bytes $decoded),
                [string]$Value,
                [StringComparison]::Ordinal
            )
        )
    } catch {
        return $false
    } finally {
        if ($null -ne $decoded) {
            [Array]::Clear($decoded, 0, $decoded.Length)
        }
    }
}

function Get-HmaBootstrapHmac {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Secret,
        [Parameter(Mandatory)][string]$Context,
        [Parameter(Mandatory)][string]$Challenge
    )

    $keyBytes = $null
    $messageBytes = $null
    $hashBytes = $null
    $hmac = $null
    try {
        $keyBytes = [Text.Encoding]::UTF8.GetBytes($Secret)
        $message = $Context + [char]0 + $Challenge
        $messageBytes = [Text.Encoding]::UTF8.GetBytes($message)
        $hmac = New-Object Security.Cryptography.HMACSHA256
        $hmac.Key = $keyBytes
        $hashBytes = $hmac.ComputeHash($messageBytes)
        return ConvertTo-HmaBase64Url -Bytes $hashBytes
    } finally {
        if ($null -ne $hmac) {
            $hmac.Dispose()
        }
        foreach ($bytes in @($keyBytes, $messageBytes, $hashBytes)) {
            if ($null -ne $bytes) {
                [Array]::Clear($bytes, 0, $bytes.Length)
            }
        }
        $message = $null
    }
}

function Test-HmaConstantTimeProof {
    [CmdletBinding()]
    param(
        [AllowNull()][object]$Actual,
        [Parameter(Mandatory)][string]$Expected
    )

    if (-not (Test-HmaCanonicalBase64Url32 -Value $Actual) -or
        -not (Test-HmaCanonicalBase64Url32 -Value $Expected)) {
        return $false
    }
    $actualBytes = $null
    $expectedBytes = $null
    try {
        $actualBytes = [Text.Encoding]::ASCII.GetBytes([string]$Actual)
        $expectedBytes = [Text.Encoding]::ASCII.GetBytes($Expected)
        $difference = 0
        for ($index = 0; $index -lt $actualBytes.Length; $index += 1) {
            $difference = $difference -bor (
                [int]$actualBytes[$index] -bxor [int]$expectedBytes[$index]
            )
        }
        return $difference -eq 0
    } finally {
        foreach ($bytes in @($actualBytes, $expectedBytes)) {
            if ($null -ne $bytes) {
                [Array]::Clear($bytes, 0, $bytes.Length)
            }
        }
    }
}

function Get-HmaBootstrapTicket {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$AuthSecret)

    $challenge = $null
    $serverProof = $null
    $expectedServerProof = $null
    $clientProof = $null
    $requestBody = $null
    $response = $null
    $bootstrapHeaders = @{ 'X-HMA-Local-Bootstrap' = 'proof-v1' }
    try {
        $response = Invoke-WebRequest `
            -Uri 'http://127.0.0.1:37645/api/auth/bootstrap/start' `
            -Method Get `
            -Headers $bootstrapHeaders `
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
                -ReferenceObject @('challenge', 'expiresInMs', 'serverProof') `
                -DifferenceObject @($properties | Sort-Object) `
                -CaseSensitive) -or
            $payload.expiresInMs -isnot [int] -or
            [int]$payload.expiresInMs -ne 10000 -or
            -not (Test-HmaCanonicalBase64Url32 -Value $payload.challenge) -or
            -not (Test-HmaCanonicalBase64Url32 -Value $payload.serverProof)) {
            throw 'The bootstrap response is invalid.'
        }

        $challenge = [string]$payload.challenge
        $serverProof = [string]$payload.serverProof
        $expectedServerProof = Get-HmaBootstrapHmac `
            -Secret $AuthSecret `
            -Context 'how-much-ai:local-bootstrap:server-proof:v1' `
            -Challenge $challenge
        if (-not (Test-HmaConstantTimeProof `
                -Actual $serverProof `
                -Expected $expectedServerProof)) {
            throw 'The bootstrap response is invalid.'
        }

        $clientProof = Get-HmaBootstrapHmac `
            -Secret $AuthSecret `
            -Context 'how-much-ai:local-bootstrap:client-proof:v1' `
            -Challenge $challenge
        $requestBody = ConvertTo-Json `
            -InputObject ([ordered]@{
                challenge = $challenge
                proof = $clientProof
            }) `
            -Compress
        $response = $null
        $response = Invoke-WebRequest `
            -Uri 'http://127.0.0.1:37645/api/auth/bootstrap/start' `
            -Method Post `
            -ContentType 'application/json' `
            -Body $requestBody `
            -Headers $bootstrapHeaders `
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
        $challenge = $null
        $serverProof = $null
        $expectedServerProof = $null
        $clientProof = $null
        $requestBody = $null
        $response = $null
        $payload = $null
        $bootstrapHeaders = $null
    }
}

$bundle = $null
$authSecret = $null
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
    $authSecret = [string]$bundle.authSecret
    $servicePlan = New-HmaServiceLaunchPlan `
        -Config $config `
        -StateRoot $state `
        -Bundle $bundle
    $firstListenerPid = Get-HmaVerifiedServiceListenerPid -Plan $servicePlan

    $edgePath = Get-HmaStableMicrosoftEdge
    Wait-HmaSecureLocalReady

    $readyListenerPid = Get-HmaVerifiedServiceListenerPid -Plan $servicePlan
    if ($readyListenerPid -ne $firstListenerPid) {
        throw 'The listener changed.'
    }
    $ticket = Get-HmaBootstrapTicket -AuthSecret $authSecret
    $postListenerPid = Get-HmaVerifiedServiceListenerPid -Plan $servicePlan
    if ($postListenerPid -ne $readyListenerPid) {
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
    $authSecret = $null
    $bundle = $null
}
