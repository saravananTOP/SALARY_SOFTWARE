param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$portalDirectory = $PSScriptRoot
$serverDirectory = Join-Path $portalDirectory 'server'
$environmentFile = Join-Path $serverDirectory '.env'
$lockFile = Join-Path $serverDirectory 'package-lock.json'
$nodeModulesDirectory = Join-Path $serverDirectory 'node_modules'
$logsDirectory = Join-Path $serverDirectory 'logs'

if (-not (Test-Path (Join-Path $serverDirectory 'server.js'))) {
    throw "Portal server.js was not found under '$serverDirectory'. Keep Start-Portal.ps1 in the salary-processing folder."
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $nodeCommand -or -not $npmCommand) {
    throw 'Node.js 20 or newer is required. Install Node.js, reopen PowerShell, and run this script again.'
}

$nodeVersionText = (& $nodeCommand.Source --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v?(\d+)\.') {
    throw 'Could not determine the installed Node.js version.'
}
if ([int]$Matches[1] -lt 20) {
    throw "Node.js 20 or newer is required; found $nodeVersionText."
}

if (-not (Test-Path $environmentFile)) {
    $randomBytes = New-Object byte[] 32
    $randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $randomGenerator.GetBytes($randomBytes)
    } finally {
        $randomGenerator.Dispose()
    }
    $sessionSecret = [BitConverter]::ToString($randomBytes).Replace('-', '').ToLowerInvariant()
    $localEnvironment = @"
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=false
APP_ORIGIN=http://127.0.0.1:3000
DATABASE_PATH=./data/portal.sqlite
SESSION_SECRET=$sessionSecret
"@
    Set-Content -Path $environmentFile -Value $localEnvironment -Encoding Ascii
    Write-Host 'Created a local server configuration and generated a private session secret.'
}

$settings = @{}
foreach ($line in Get-Content -Path $environmentFile) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
        $value = $Matches[2].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $settings[$Matches[1]] = $value
    }
}

$hostName = if ($settings.ContainsKey('HOST') -and $settings['HOST']) { $settings['HOST'] } else { '127.0.0.1' }
$portText = if ($settings.ContainsKey('PORT') -and $settings['PORT']) { $settings['PORT'] } else { '3000' }
$appOrigin = if ($settings.ContainsKey('APP_ORIGIN')) { $settings['APP_ORIGIN'] } else { '' }
$sessionSecret = if ($settings.ContainsKey('SESSION_SECRET')) { $settings['SESSION_SECRET'] } else { '' }

if ($hostName -notin @('127.0.0.1', 'localhost', '::1', '[::1]')) {
    throw "The launcher only binds to this computer. Set HOST=127.0.0.1 in '$environmentFile'; network-wide exposure is not enabled."
}
if ($portText -notmatch '^\d+$' -or [int]$portText -lt 1 -or [int]$portText -gt 65535) {
    throw "PORT in '$environmentFile' must be a number from 1 to 65535."
}
if ($sessionSecret.Length -lt 32 -or $sessionSecret.StartsWith('replace-with-')) {
    throw "SESSION_SECRET in '$environmentFile' must be a random secret of at least 32 characters."
}

$port = [int]$portText
try {
    $originUri = [Uri]$appOrigin
} catch {
    throw "APP_ORIGIN in '$environmentFile' must be the local portal URL, such as http://127.0.0.1:$port."
}
if ($originUri.Scheme -ne 'http' -or
    $originUri.Host -notin @('127.0.0.1', 'localhost', '::1') -or
    $originUri.Port -ne $port -or
    $originUri.AbsolutePath -ne '/' -or
    $originUri.Query -or
    $originUri.Fragment) {
    throw "APP_ORIGIN must use http, a loopback host, and PORT $port. This launcher does not expose the payroll portal to other computers."
}

if (-not (Test-Path $lockFile)) {
    throw "Dependency lock file not found: '$lockFile'. The salary-processing folder may be incomplete."
}

$requiredPackages = @(
    (Join-Path $nodeModulesDirectory 'express\package.json'),
    (Join-Path $nodeModulesDirectory 'better-sqlite3\package.json'),
    (Join-Path $nodeModulesDirectory 'better-sqlite3\build\Release\better_sqlite3.node')
)
if (@($requiredPackages | Where-Object { -not (Test-Path $_) }).Count -gt 0) {
    Write-Host 'Installing portal dependencies. This can take a few minutes on first launch...'
    Push-Location $serverDirectory
    try {
        & $npmCommand.Source ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw 'Dependency installation failed. Check the npm output above and try again.'
        }
    } finally {
        Pop-Location
    }
}

$portalUrl = $originUri.GetLeftPart([System.UriPartial]::Authority)
$existingPortal = $false
try {
    $existingPage = Invoke-WebRequest -Uri $portalUrl -UseBasicParsing -TimeoutSec 2
    $existingPortal = $existingPage.StatusCode -eq 200 -and $existingPage.Content -match 'Employees Payroll'
} catch {
    $existingPortal = $false
}

if (-not $existingPortal) {
    $portProbe = New-Object System.Net.Sockets.TcpClient
    try {
        $connect = $portProbe.BeginConnect($originUri.Host, $port, $null, $null)
        if ($connect.AsyncWaitHandle.WaitOne(300) -and $portProbe.Connected) {
            throw "Port $port is already in use by another program. Stop that program or choose a free PORT and matching APP_ORIGIN in '$environmentFile'."
        }
    } finally {
        $portProbe.Close()
    }

    New-Item -ItemType Directory -Path $logsDirectory -Force | Out-Null
    $stdoutLog = Join-Path $logsDirectory 'portal-startup.log'
    $stderrLog = Join-Path $logsDirectory 'portal-errors.log'
    $portalProcess = Start-Process `
        -FilePath $nodeCommand.Source `
        -ArgumentList @('server.js') `
        -WorkingDirectory $serverDirectory `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog

    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        if ($portalProcess.HasExited) {
            $details = if (Test-Path $stderrLog) { (Get-Content $stderrLog -Raw).Trim() } else { '' }
            throw "The portal server exited during startup. $details"
        }
        try {
            $page = Invoke-WebRequest -Uri $portalUrl -UseBasicParsing -TimeoutSec 2
            if ($page.StatusCode -eq 200 -and $page.Content -match 'Employees Payroll') {
                $ready = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    if (-not $ready) {
        throw "The server process is running but the portal did not become ready at $portalUrl. Check '$stderrLog'."
    }
    Write-Host "Started the portal server (process ID $($portalProcess.Id))."
} else {
    Write-Host 'The portal is already running.'
}

Write-Host "Portal available on this computer: $portalUrl"
Write-Host 'This launcher keeps the portal bound to this computer; it does not enable LAN or internet access.'
Push-Location $serverDirectory
try {
    $accountList = & $npmCommand.Source run users -- list
    $accountListExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($accountListExitCode -ne 0) {
    throw 'Could not check portal accounts. Review the server configuration and database permissions.'
}
$activeAdministrator = @($accountList | Where-Object { $_ -match '^[^\s@]+@[^\s@]+\.[^\s@]+\s+admin\s+active\s+' }).Count -gt 0
if (-not $activeAdministrator) {
    Write-Host "No active administrator was found. Create one from '$serverDirectory' with: npm run users -- create admin@example.com admin"
}

if (-not $NoBrowser) {
    Start-Process $portalUrl
}
