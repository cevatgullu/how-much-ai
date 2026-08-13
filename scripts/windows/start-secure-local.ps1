[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$StateRoot,
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$IntegrityModuleHash
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$bundle = $null
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
    throw 'Startup integrity module verification failed.'
}

Import-Module $integrityModule -Force -ErrorAction Stop
$config = Assert-HmaStartupIntegrity -StateRoot $state
Import-Module (Join-Path $bootstrap 'SecureLocalSecrets.psm1') -Force -ErrorAction Stop
Import-Module (Join-Path $bootstrap 'SecureLocalRuntime.psm1') -Force -ErrorAction Stop
$bundle = Unprotect-HmaSecretBundle -Path (Join-Path $state 'secrets.dpapi')
$plan = New-HmaServiceLaunchPlan -Config $config -StateRoot $state -Bundle $bundle
Set-HmaExactProcessEnvironment -Environment $plan.Environment

Push-Location $plan.WorkingDirectory
try {
    $arguments = @($plan.ArgumentList)
    & $plan.FilePath @arguments
    exit $LASTEXITCODE
} finally {
    Pop-Location
    foreach ($name in @(
            'APP_PASSWORD',
            'AUTH_SECRET',
            'VAULT_ENCRYPTION_SECRET'
        )) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    $arguments = $null
    $plan = $null
    $bundle = $null
}
