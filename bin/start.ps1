[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$startupRoot = Join-Path $projectRoot '.work\startup'
$startedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$startupMutex = [System.Threading.Mutex]::new($false, 'Local\RevenueAndCosts.Start')
$startupLockTaken = $false

function Write-Step([string]$Message) {
  Write-Host "[revenue-and-costs] $Message"
}

function Read-LocalEnvValue([string]$Name) {
  $envPath = Join-Path $projectRoot '.env.local'
  foreach ($line in Get-Content -LiteralPath $envPath -Encoding UTF8) {
    if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*?)\s*$") {
      $value = $matches[1]
      if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
        return $value.Substring(1, $value.Length - 2)
      }
      return $value
    }
  }
  return $null
}

function Read-EffectiveEnvValue([string]$Name) {
  $processValue = [Environment]::GetEnvironmentVariable($Name, [EnvironmentVariableTarget]::Process)
  if ($null -ne $processValue) { return $processValue }
  return Read-LocalEnvValue $Name
}

function Test-PrivateIpv4Address([System.Net.IPAddress]$Address) {
  if ($Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
  $bytes = $Address.GetAddressBytes()
  return $bytes[0] -eq 10 -or
    ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
    ($bytes[0] -eq 192 -and $bytes[1] -eq 168)
}

function Get-PreferredLanIpv4Address {
  $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction Stop |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*' -and
      (Test-PrivateIpv4Address ([System.Net.IPAddress]$_.IPAddress)) -and
      (-not $_.PSObject.Properties['SkipAsSource'] -or -not $_.SkipAsSource)
    })
  if ($addresses.Count -eq 0) { throw 'No preferred non-loopback IPv4 address is available.' }

  $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq 'Alive' } |
    Sort-Object RouteMetric)
  foreach ($route in $routes) {
    $candidate = @($addresses | Where-Object { $_.InterfaceIndex -eq $route.InterfaceIndex } |
      Sort-Object PrefixOrigin,IPAddress |
      Select-Object -First 1)
    if ($candidate.Count -eq 1) { return [string]$candidate[0].IPAddress }
  }
  if ($addresses.Count -eq 1) { return [string]$addresses[0].IPAddress }
  throw "Cannot choose one LAN IPv4 address. Candidates: $($addresses.IPAddress -join ', ')."
}

function Resolve-LaunchOrigin([string]$ConfiguredOrigin) {
  [Uri]$origin = $null
  if (-not [Uri]::TryCreate($ConfiguredOrigin, [UriKind]::Absolute, [ref]$origin) -or $origin.Scheme -ne 'http' -or $origin.Port -ne 5173) {
    throw 'PUBLIC_ORIGIN must be an absolute HTTP URL using port 5173.'
  }
  $canonicalOrigin = $origin.GetLeftPart([UriPartial]::Authority)
  if ($ConfiguredOrigin -cne $canonicalOrigin) {
    throw "PUBLIC_ORIGIN must contain only the canonical origin without a trailing slash or path: $canonicalOrigin"
  }

  [System.Net.IPAddress]$configuredAddress = $null
  if (-not [System.Net.IPAddress]::TryParse($origin.Host, [ref]$configuredAddress) -or
      -not (Test-PrivateIpv4Address $configuredAddress)) {
    return $canonicalOrigin
  }
  $localAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction Stop |
    Select-Object -ExpandProperty IPAddress)
  if ($localAddresses -contains $origin.Host) { return $canonicalOrigin }

  $currentAddress = Get-PreferredLanIpv4Address
  $effectiveOrigin = "http://${currentAddress}:5173"
  Write-Step "Configured PUBLIC_ORIGIN host $($origin.Host) is not assigned to this computer; using $effectiveOrigin for this launch."
  return $effectiveOrigin
}

function Get-HttpResult([string]$Uri) {
  try {
    $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Content = [string]$response.Content }
  } catch {
    return $null
  }
}

function Test-ApiResponse([object]$Result, [string]$ExpectedStatus) {
  if ($null -eq $Result -or $Result.StatusCode -ne 200) { return $false }
  try {
    $body = $Result.Content | ConvertFrom-Json
    return $body.service -eq 'api' -and $body.status -eq $ExpectedStatus
  } catch {
    return $false
  }
}

function Test-WebResponse([object]$Result) {
  return $null -ne $Result -and $Result.StatusCode -eq 200 -and $Result.Content.Contains('revenueCostsThemeV01')
}

function Test-ApiPublicOrigin([string]$Origin) {
  try {
    Invoke-WebRequest `
      -Uri 'http://127.0.0.1:3000/api/v1/auth/logout' `
      -Method Post `
      -Headers @{ Origin = $Origin; 'x-csrf-token' = 'startup-origin-probe' } `
      -ContentType 'application/json' `
      -Body '{}' `
      -UseBasicParsing `
      -TimeoutSec 2 `
      -ErrorAction Stop | Out-Null
    return $false
  } catch {
    if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) {
      return $false
    }
    try {
      $body = $_.ErrorDetails.Message | ConvertFrom-Json
      return $body.code -eq 'SESSION_REQUIRED'
    } catch {
      return $false
    }
  }
}

function Test-TcpPort([string]$HostName, [int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $pending = $client.BeginConnect($HostName, $Port, $null, $null)
    return $pending.AsyncWaitHandle.WaitOne(500) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Test-LoopbackHost([string]$HostName) {
  if ($HostName -eq 'localhost') { return $true }
  [System.Net.IPAddress]$address = $null
  return [System.Net.IPAddress]::TryParse($HostName, [ref]$address) -and [System.Net.IPAddress]::IsLoopback($address)
}

function Get-DatabaseEndpoint {
  $databaseUrl = Read-EffectiveEnvValue 'DATABASE_URL'
  [Uri]$uri = $null
  if (-not $databaseUrl -or -not [Uri]::TryCreate($databaseUrl, [UriKind]::Absolute, [ref]$uri) -or
      $uri.Scheme -notin @('postgres', 'postgresql') -or -not $uri.Host) {
    throw 'DATABASE_URL must be an absolute postgres:// or postgresql:// URL.'
  }
  $port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
  return [pscustomobject]@{ HostName = $uri.Host; Port = $port }
}

function Get-PostgresServiceLaunch([int]$Port) {
  $launches = @()
  $services = @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '(?i)^postgresql' -and $_.PathName -match '(?i)pg_ctl\.exe' })
  foreach ($service in $services) {
    $command = [string]$service.PathName
    $pgCtlPath = $null
    if ($command -match '^"(?<path>[^"]+pg_ctl\.exe)"') {
      $pgCtlPath = $matches.path
    } elseif ($command -match '^(?<path>\S+pg_ctl\.exe)') {
      $pgCtlPath = $matches.path
    }
    $dataDirectory = $null
    if ($command -match '(?:^|\s)-D\s+"(?<data>[^"]+)"') {
      $dataDirectory = $matches.data
    } elseif ($command -match '(?:^|\s)-D\s+(?<data>\S+)') {
      $dataDirectory = $matches.data
    }
    if (-not $pgCtlPath -or -not $dataDirectory -or
        -not (Test-Path -LiteralPath $pgCtlPath) -or -not (Test-Path -LiteralPath $dataDirectory)) {
      continue
    }

    $matchesPort = $service.Name -match "-$Port$"
    if (-not $matchesPort) {
      $configPath = Join-Path $dataDirectory 'postgresql.conf'
      if (Test-Path -LiteralPath $configPath) {
        $portSetting = Select-String -LiteralPath $configPath -Pattern '^\s*port\s*=\s*(\d+)' -ErrorAction SilentlyContinue |
          Select-Object -Last 1
        $matchesPort = $null -ne $portSetting -and [int]$portSetting.Matches[0].Groups[1].Value -eq $Port
      }
    }
    if ($matchesPort) {
      $launches += [pscustomobject]@{
        ServiceName = [string]$service.Name
        ServiceState = [string]$service.State
        PgCtlPath = $pgCtlPath
        DataDirectory = $dataDirectory
      }
    }
  }
  if ($launches.Count -gt 1) {
    throw "Multiple installed PostgreSQL services match port ${Port}: $($launches.ServiceName -join ', ')."
  }
  if ($launches.Count -eq 1) { return $launches[0] }
  return $null
}

function Start-ConfiguredLocalPostgresIfNeeded {
  $endpoint = Get-DatabaseEndpoint
  if (-not (Test-LoopbackHost $endpoint.HostName) -or (Test-TcpPort $endpoint.HostName $endpoint.Port)) {
    return
  }

  $launch = Get-PostgresServiceLaunch $endpoint.Port
  if ($null -eq $launch) {
    throw "PostgreSQL is not listening on $($endpoint.HostName):$($endpoint.Port), and no installed PostgreSQL service matches that port."
  }
  if ($launch.ServiceState -eq 'Running') {
    Write-Step "PostgreSQL service $($launch.ServiceName) is running; waiting for port $($endpoint.Port)"
    return
  }

  Write-Step "Starting local PostgreSQL for port $($endpoint.Port)"
  try {
    Start-Service -Name $launch.ServiceName -ErrorAction Stop
    Write-Step "Started PostgreSQL Windows service $($launch.ServiceName)"
    return
  } catch {
    Write-Step "Windows service start was unavailable; starting the same PostgreSQL cluster directly"
  }

  $postgresLog = Join-Path $startupRoot "postgres-$($endpoint.Port).out.log"
  & $launch.PgCtlPath start -D $launch.DataDirectory -l $postgresLog -w -t 60
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to start PostgreSQL cluster $($launch.DataDirectory). Check $postgresLog."
  }
  Write-Step "Started PostgreSQL cluster $($launch.DataDirectory)"
}

function Quote-ProcessArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Find-ProcessLogFileName([string]$Name, [int]$ProcessId, [string]$Stream) {
  $needle = '"pid":' + $ProcessId
  $files = Get-ChildItem -LiteralPath $startupRoot -Filter "*-$Name.$Stream.log" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  try {
    $startedAt = (Get-Process -Id $ProcessId -ErrorAction Stop).StartTime.ToUniversalTime()
    $startedAtUnixMs = [DateTimeOffset]::new($startedAt).ToUnixTimeMilliseconds()
    foreach ($file in $files) {
      foreach ($match in Select-String -LiteralPath $file.FullName -SimpleMatch $needle -ErrorAction SilentlyContinue) {
        try {
          $record = $match.Line | ConvertFrom-Json
          if ([int]$record.pid -eq $ProcessId -and [double]$record.time -ge ($startedAtUnixMs - 1000)) {
            return $file.Name
          }
        } catch { }
      }
    }
  } catch { }
  return $null
}

function Write-CurrentProcessManifest(
  [string]$Name,
  [System.Diagnostics.Process]$Process,
  [string]$StdoutFile,
  [string]$StderrFile
) {
  $manifestPath = Join-Path $startupRoot "current-$Name.json"
  $processStartedAt = $Process.StartTime.ToUniversalTime()
  if ((-not $StdoutFile -or -not $StderrFile) -and (Test-Path -LiteralPath $manifestPath)) {
    try {
      $existing = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
      $existingStartedAt = [DateTimeOffset]::Parse([string]$existing.startedAt).UtcDateTime
      if ([int]$existing.pid -eq $Process.Id -and [Math]::Abs(($existingStartedAt - $processStartedAt).TotalSeconds) -lt 1) {
        if (-not $StdoutFile) { $StdoutFile = [string]$existing.stdoutFile }
        if (-not $StderrFile) { $StderrFile = [string]$existing.stderrFile }
      }
    } catch { }
  }
  if (-not $StdoutFile) { $StdoutFile = Find-ProcessLogFileName $Name $Process.Id 'out' }
  if (-not $StderrFile) { $StderrFile = Find-ProcessLogFileName $Name $Process.Id 'err' }
  if ($StdoutFile -and -not $StderrFile) {
    $candidate = $StdoutFile -replace '\.out\.log$', '.err.log'
    if (Test-Path -LiteralPath (Join-Path $startupRoot $candidate)) { $StderrFile = $candidate }
  }
  if ($StderrFile -and -not $StdoutFile) {
    $candidate = $StderrFile -replace '\.err\.log$', '.out.log'
    if (Test-Path -LiteralPath (Join-Path $startupRoot $candidate)) { $StdoutFile = $candidate }
  }
  $manifest = [ordered]@{
    version = 1
    service = $Name
    pid = $Process.Id
    startedAt = $processStartedAt.ToString('o')
    stdoutFile = $StdoutFile
    stderrFile = $StderrFile
  }
  $manifestJson = $manifest | ConvertTo-Json
  $temporaryPath = Join-Path $startupRoot ('.current-' + $Name + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $backupPath = Join-Path $startupRoot ('.current-' + $Name + '.' + [Guid]::NewGuid().ToString('N') + '.bak')
  try {
    [System.IO.File]::WriteAllText($temporaryPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $manifestPath) {
      [System.IO.File]::Replace($temporaryPath, $manifestPath, $backupPath)
    } else {
      [System.IO.File]::Move($temporaryPath, $manifestPath)
    }
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
    if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath -Force }
  }
}

function Start-ProjectProcess([string]$Name, [string[]]$Arguments, [string]$Stamp, [string]$NodePath) {
  $stdout = Join-Path $startupRoot "$Stamp-$Name.out.log"
  $stderr = Join-Path $startupRoot "$Stamp-$Name.err.log"
  $argumentLine = ($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' '
  $process = Start-Process -FilePath $NodePath -ArgumentList $argumentLine -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $startedProcesses.Add($process)
  Write-CurrentProcessManifest $Name $process ([System.IO.Path]::GetFileName($stdout)) ([System.IO.Path]::GetFileName($stderr))
  Write-Step "Started $Name (PID $($process.Id); logs: $stdout / $stderr)"
  return $process
}

function Find-ProjectRuntimeProcess([string]$EntryPath) {
  $needle = (Join-Path $projectRoot $EntryPath).ToLowerInvariant().Replace('/', '\')
  $candidates = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine.ToLowerInvariant().Replace('/', '\').Contains($needle) -and
      $_.CommandLine -notmatch '(?i)[\\/]tsx[\\/]dist[\\/]cli\.mjs'
    })
  if ($candidates.Count -eq 0) { return $null }
  if ($candidates.Count -gt 1) { throw "Multiple runtime processes match ${EntryPath}: $($candidates.ProcessId -join ', ')." }
  return Get-Process -Id $candidates[0].ProcessId -ErrorAction SilentlyContinue
}

function Find-ListeningProjectRuntimeProcess([int]$Port, [string]$EntryPath) {
  $listenerIds = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
    Select-Object -ExpandProperty OwningProcess -Unique |
    Where-Object { $_ -gt 0 })
  if ($listenerIds.Count -eq 0) { return $null }
  $needle = (Join-Path $projectRoot $EntryPath).ToLowerInvariant().Replace('/', '\')
  $candidates = @(foreach ($listenerId in $listenerIds) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerId" -ErrorAction SilentlyContinue
    if ($null -ne $candidate -and $candidate.CommandLine -and $candidate.CommandLine.ToLowerInvariant().Replace('/', '\').Contains($needle) -and $candidate.CommandLine -notmatch '(?i)[\\/]tsx[\\/]dist[\\/]cli\.mjs') {
      $candidate
    }
  })
  if ($candidates.Count -ne 1) {
    throw "Port $Port is not owned by exactly one expected $EntryPath runtime (listener PIDs: $($listenerIds -join ', '))."
  }
  return Get-Process -Id $candidates[0].ProcessId -ErrorAction Stop
}

function Stop-ProcessTree([int]$ProcessId) {
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) { Stop-ProcessTree -ProcessId $child.ProcessId }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Test-ProjectInputsNewerThanProcess([System.Diagnostics.Process]$Process) {
  if ($null -eq $Process) { return $false }
  try {
    $startedAtUtc = $Process.StartTime.ToUniversalTime()
    $inputs = @(
      Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src') -Recurse -File -ErrorAction Stop
      Get-Item -LiteralPath (Join-Path $projectRoot 'package.json') -ErrorAction Stop
      Get-Item -LiteralPath (Join-Path $projectRoot '.env.local') -ErrorAction Stop
    )
    return $null -ne ($inputs | Where-Object { $_.LastWriteTimeUtc -gt $startedAtUtc } | Select-Object -First 1)
  } catch {
    return $true
  }
}

function Assert-ProcessesRunning([System.Diagnostics.Process[]]$Processes) {
  foreach ($process in $Processes) {
    $process.Refresh()
    if ($process.HasExited) { throw "Process PID $($process.Id) exited early. Check .work\startup logs." }
  }
}

function Wait-For([string]$Description, [scriptblock]$Probe, [System.Diagnostics.Process[]]$Processes, [int]$TimeoutSeconds = 45) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    Assert-ProcessesRunning $Processes
    if (& $Probe) {
      Write-Step "$Description is ready"
      return
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for $Description. Check .work\startup logs."
}

try {
  try {
    $startupLockTaken = $startupMutex.WaitOne(30000)
  } catch [System.Threading.AbandonedMutexException] {
    $startupLockTaken = $true
  }
  if (-not $startupLockTaken) { throw 'Another startup attempt is still running. Try again after it finishes.' }

  Set-Location -LiteralPath $projectRoot
  New-Item -ItemType Directory -Path $startupRoot -Force | Out-Null

  foreach ($requiredPath in @('.env.local', 'package.json', 'node_modules\tsx\dist\cli.mjs', 'node_modules\vite\bin\vite.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $requiredPath))) {
      throw "Missing $requiredPath. Complete the local setup in README first."
    }
  }

  $nodeCommand = Get-Command node.exe -ErrorAction Stop
  $pnpmCommand = Get-Command pnpm.cmd -ErrorAction Stop
  $nodeVersion = (& $nodeCommand.Source --version).Trim()
  $pnpmVersion = (& $pnpmCommand.Source --version).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read the pnpm version.' }
  if ($nodeVersion -notmatch '^v24\.' -or $pnpmVersion -notmatch '^9\.15\.') {
    throw "Unsupported runtime versions: Node $nodeVersion, pnpm $pnpmVersion. Node 24 and pnpm 9.15 are required."
  }

  $publicOriginText = Read-EffectiveEnvValue 'PUBLIC_ORIGIN'
  $canonicalOrigin = Resolve-LaunchOrigin $publicOriginText
  # Child API/Vite processes must use the same origin that the launcher probes.
  # This process-scoped override keeps auth/CSRF checks aligned after DHCP changes.
  $env:PUBLIC_ORIGIN = $canonicalOrigin
  $browserUrl = $canonicalOrigin + '/'

  Write-Step "Environment OK: Node $nodeVersion, pnpm $pnpmVersion, site $browserUrl"
  if (-not $CheckOnly) { Start-ConfiguredLocalPostgresIfNeeded }
  Write-Step 'Waiting for PostgreSQL to become writable'
  & $pnpmCommand.Source db:status -- --wait-writable-ms 60000
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL is unavailable or remained read-only/recovering for 60 seconds.' }

  if ($CheckOnly) {
    Write-Step 'Check-only mode passed; no migrations or processes were started.'
    exit 0
  }

  Write-Step 'Applying pending forward migrations'
  & $pnpmCommand.Source db:migrate
  if ($LASTEXITCODE -ne 0) { throw 'Database migration failed; application processes were not started.' }

  Write-Step 'Ensuring built-in mappings and resuming recoverable preflight batches'
  & $pnpmCommand.Source db:bootstrap-mappings
  if ($LASTEXITCODE -ne 0) { throw 'Mapping bootstrap failed; application processes were not started.' }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $tsxCli = Join-Path $projectRoot 'node_modules\tsx\dist\cli.mjs'
  $viteCli = Join-Path $projectRoot 'node_modules\vite\bin\vite.js'
  $apiEntry = Join-Path $projectRoot 'src\api\index.ts'
  $workerEntry = Join-Path $projectRoot 'src\worker\index.ts'

  $runningApiProcess = $null
  if (Test-TcpPort '127.0.0.1' 3000) {
    $runningApiProcess = Find-ListeningProjectRuntimeProcess 3000 'src\api\index.ts'
  }
  $runningWorkerProcess = Find-ProjectRuntimeProcess 'src\worker\index.ts'
  if ((Test-ProjectInputsNewerThanProcess $runningApiProcess) -or (Test-ProjectInputsNewerThanProcess $runningWorkerProcess)) {
    Write-Step 'Project inputs changed; restarting the API and Worker'
    if ($null -ne $runningApiProcess) { Stop-ProcessTree -ProcessId $runningApiProcess.Id }
    if ($null -ne $runningWorkerProcess) { Stop-ProcessTree -ProcessId $runningWorkerProcess.Id }
    Start-Sleep -Milliseconds 500
  } elseif ($null -ne $runningApiProcess -and -not (Test-ApiPublicOrigin $canonicalOrigin)) {
    Write-Step 'PUBLIC_ORIGIN changed; restarting the API so login and CSRF checks use the current site address'
    Stop-ProcessTree -ProcessId $runningApiProcess.Id
    Start-Sleep -Milliseconds 500
  }

  $apiLive = Test-ApiResponse (Get-HttpResult 'http://127.0.0.1:3000/health/live') 'ok'
  $webLive = Test-WebResponse (Get-HttpResult $browserUrl)
  if (-not $apiLive -and (Test-TcpPort '127.0.0.1' 3000)) { throw 'Port 3000 is occupied by another service.' }
  if (-not $webLive -and (Test-TcpPort '127.0.0.1' 5173)) { throw 'Port 5173 is occupied by another service.' }

  $apiProcess = $null
  if (-not $apiLive) {
    $apiProcess = Start-ProjectProcess 'api' @($tsxCli, $apiEntry) $stamp $nodeCommand.Source
  } else {
    Write-Step 'Reusing the ready API'
    $reusedApiProcess = Find-ListeningProjectRuntimeProcess 3000 'src\api\index.ts'
    if ($null -ne $reusedApiProcess) { Write-CurrentProcessManifest 'api' $reusedApiProcess $null $null }
  }

  $workerStartedByLauncher = $false
  $workerProcess = Find-ProjectRuntimeProcess 'src\worker\index.ts'
  if ($null -eq $workerProcess) {
    $workerStartedByLauncher = $true
    $workerProcess = Start-ProjectProcess 'worker' @($tsxCli, $workerEntry) $stamp $nodeCommand.Source
  } else {
    Write-Step "Reusing the running Worker (PID $($workerProcess.Id))"
    Write-CurrentProcessManifest 'worker' $workerProcess $null $null
  }

  $watchedBackend = @($workerProcess)
  if ($null -ne $apiProcess) { $watchedBackend += $apiProcess }
  Wait-For 'API readiness' {
    Test-ApiResponse (Get-HttpResult 'http://127.0.0.1:3000/health/ready') 'ok'
  } $watchedBackend 60
  Wait-For 'API public-origin contract' {
    Test-ApiPublicOrigin $canonicalOrigin
  } $watchedBackend 30
  $apiRuntimeProcess = Find-ListeningProjectRuntimeProcess 3000 'src\api\index.ts'
  if ($null -eq $apiRuntimeProcess) { throw 'API is ready but its runtime process cannot be identified.' }
  if ($null -ne $apiProcess) {
    Write-CurrentProcessManifest 'api' $apiRuntimeProcess "$stamp-api.out.log" "$stamp-api.err.log"
  } else {
    Write-CurrentProcessManifest 'api' $apiRuntimeProcess $null $null
  }
  $workerRuntimeProcess = Find-ProjectRuntimeProcess 'src\worker\index.ts'
  if ($null -eq $workerRuntimeProcess) { throw 'Worker runtime process cannot be identified.' }
  if ($workerStartedByLauncher) {
    Write-CurrentProcessManifest 'worker' $workerRuntimeProcess "$stamp-worker.out.log" "$stamp-worker.err.log"
  } else {
    Write-CurrentProcessManifest 'worker' $workerRuntimeProcess $null $null
  }

  $webProcess = $null
  if (-not $webLive) {
    $webProcess = Start-ProjectProcess 'web' @($viteCli, '--host', '0.0.0.0', '--port', '5173', '--strictPort') $stamp $nodeCommand.Source
  } else {
    Write-Step 'Reusing the ready website'
    $reusedWebProcess = Find-ListeningProjectRuntimeProcess 5173 'node_modules\vite\bin\vite.js'
    if ($null -ne $reusedWebProcess) { Write-CurrentProcessManifest 'web' $reusedWebProcess $null $null }
  }

  $watchedAll = @($workerProcess)
  if ($null -ne $apiProcess) { $watchedAll += $apiProcess }
  if ($null -ne $webProcess) { $watchedAll += $webProcess }
  Wait-For 'website' { Test-WebResponse (Get-HttpResult $browserUrl) } $watchedAll 45
  Wait-For 'website-to-API proxy' {
    Test-ApiResponse (Get-HttpResult ($browserUrl + 'health/live')) 'ok'
  } $watchedAll 30
  $webRuntimeProcess = Find-ListeningProjectRuntimeProcess 5173 'node_modules\vite\bin\vite.js'
  if ($null -eq $webRuntimeProcess) { throw 'Website is ready but its runtime process cannot be identified.' }
  Write-CurrentProcessManifest 'web' $webRuntimeProcess $null $null

  $launchOrigin = [Uri]$canonicalOrigin
  Write-Step "Startup complete: $browserUrl"
  Write-Host ''
  Write-Host '=== COPY CONNECTION DETAILS ==='
  Write-Host "HOST: $($launchOrigin.Host):$($launchOrigin.Port)"
  Write-Host "URL : $browserUrl"
  Write-Host '==============================='
  if (-not $NoBrowser) {
    try { Start-Process $browserUrl | Out-Null } catch { Write-Warning "Services are ready, but the browser did not open: $($_.Exception.Message)" }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine("[revenue-and-costs] Startup failed: $($_.Exception.Message)")
  foreach ($process in $startedProcesses) {
    $process.Refresh()
    if (-not $process.HasExited) { Stop-ProcessTree -ProcessId $process.Id }
  }
  exit 1
} finally {
  if ($startupLockTaken) { $startupMutex.ReleaseMutex() }
  $startupMutex.Dispose()
}
