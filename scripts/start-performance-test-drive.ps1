[CmdletBinding()]
param(
  [int]$ApiPort = 3011,
  [int]$WebPort = 5174,
  [string]$Schema = 'perf_opt_20260806',
  [switch]$SkipWeb
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$evidenceRoot = Join-Path $projectRoot '.work\performance-test-drive'
$envFile = Join-Path $projectRoot '.env.local'

function Read-EnvFile([string]$Path) {
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*([^#=]+?)\s*=\s*(.*?)\s*$') {
      $value = $matches[2]
      if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $values[$matches[1].Trim()] = $value
    }
  }
  return $values
}

function Assert-PortFree([int]$Port) {
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "PERFORMANCE_TEST_PORT_IN_USE:$Port"
  }
}

function Wait-Http([string]$Uri, [scriptblock]$Accept, [int]$Attempts = 80) {
  for ($attempt = 0; $attempt -lt $Attempts; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
      if (& $Accept $response) { return }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  throw "PERFORMANCE_TEST_HTTP_NOT_READY:$Uri"
}

if ($Schema -notmatch '^perf_opt_[a-z0-9_]+$') { throw 'PERF_SCHEMA_INVALID' }
New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
Assert-PortFree $ApiPort
if (-not $SkipWeb) { Assert-PortFree $WebPort }

$values = Read-EnvFile $envFile
if (-not $values.ContainsKey('TEST_DATABASE_URL')) { throw 'TEST_DATABASE_URL_MISSING' }
$databaseUri = [Uri]$values['TEST_DATABASE_URL']
if ($databaseUri.AbsolutePath -notmatch '(?i)test') { throw 'PERFORMANCE_TEST_DATABASE_REQUIRED' }

$env:DATABASE_URL = $values['TEST_DATABASE_URL']
$env:PGOPTIONS = "-c search_path=$Schema,public"
$env:NODE_ENV = 'test'
$env:HOST = '127.0.0.1'
$env:PORT = [string]$ApiPort
$env:PUBLIC_ORIGIN = "http://127.0.0.1:$WebPort"
$env:API_PROXY_TARGET = "http://127.0.0.1:$ApiPort"
$env:STORAGE_ROOT = Join-Path $evidenceRoot 'storage'
$env:STORAGE_REPLICA_ROOT = ''
$env:STORAGE_POLICY = 'LOCAL_VERIFIED'
$env:CHINAMONEY_ENABLED = 'false'
$env:PERF_PROFILER_DIR = Join-Path $evidenceRoot 'profiler'
$env:PERF_IMPORT_BREAKDOWN = 'true'
$profilerModule = (Resolve-Path -LiteralPath (Join-Path $projectRoot 'scripts\performance-profiler.mjs')).Path
$profilerImport = "--import=$(([Uri]$profilerModule).AbsoluteUri)"
$env:NODE_OPTIONS = if ($env:NODE_OPTIONS) { "$($env:NODE_OPTIONS) $profilerImport" } else { $profilerImport }

$startedAt = Get-Date
$stamp = $startedAt.ToString('yyyyMMdd-HHmmss')
$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
$processes = @()
try {
  $env:PERF_PROCESS_ROLE = 'api'
  $api = Start-Process -FilePath $pnpm -ArgumentList @('exec', 'tsx', 'src/api/index.ts') `
    -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $evidenceRoot "$stamp-isolated-api.out.log") `
    -RedirectStandardError (Join-Path $evidenceRoot "$stamp-isolated-api.err.log")
  $processes += $api
  $env:PERF_PROCESS_ROLE = 'worker'
  $worker = Start-Process -FilePath $pnpm -ArgumentList @('exec', 'tsx', 'src/worker/index.ts') `
    -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $evidenceRoot "$stamp-isolated-worker.out.log") `
    -RedirectStandardError (Join-Path $evidenceRoot "$stamp-isolated-worker.err.log")
  $processes += $worker
  $web = $null
  if (-not $SkipWeb) {
    $env:PERF_PROCESS_ROLE = 'web'
    $web = Start-Process -FilePath $pnpm -ArgumentList @('exec', 'vite', '--host', '127.0.0.1', '--port', [string]$WebPort) `
      -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $evidenceRoot "$stamp-isolated-web.out.log") `
      -RedirectStandardError (Join-Path $evidenceRoot "$stamp-isolated-web.err.log")
    $processes += $web
  }

  Wait-Http "http://127.0.0.1:$ApiPort/health/ready" { param($response)
    $body = $response.Content | ConvertFrom-Json
    return $response.StatusCode -eq 200 -and $body.service -eq 'api' -and $body.status -eq 'ok'
  }
  if (-not $SkipWeb) {
    Wait-Http "http://127.0.0.1:$WebPort" { param($response)
      return $response.StatusCode -eq 200 -and $response.Content.Contains('revenueCostsThemeV01')
    }
  }

  $expectedPorts = if ($SkipWeb) { @($ApiPort) } else { @($ApiPort, $WebPort) }
  $listeners = @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in $expectedPorts })
  $children = @(Get-CimInstance Win32_Process | Where-Object {
    $_.CreationDate -ge $startedAt.AddSeconds(-2) -and
    $_.CommandLine -match [regex]::Escape($projectRoot) -and
    $_.CommandLine -match '(?:src[/\\](?:api|worker)[/\\]index\.ts|vite)'
  } | Select-Object ProcessId, ParentProcessId, Name, CreationDate)
  $manifest = [ordered]@{
    schemaVersion = 1
    startedAt = $startedAt.ToUniversalTime().ToString('o')
    database = $databaseUri.AbsolutePath.Trim('/')
    schema = $Schema
    apiUrl = "http://127.0.0.1:$ApiPort"
    webUrl = if ($SkipWeb) { $null } else { "http://127.0.0.1:$WebPort" }
    wrappers = [ordered]@{ api = $api.Id; worker = $worker.Id; web = if ($web) { $web.Id } else { $null } }
    listeners = $listeners | Select-Object LocalAddress, LocalPort, OwningProcess
    children = $children
    logPrefix = $stamp
    profilerDirectory = $env:PERF_PROFILER_DIR
  }
  $manifestPath = Join-Path $evidenceRoot "$stamp-isolated-processes.json"
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  $manifest | ConvertTo-Json -Depth 5
} catch {
  foreach ($process in $processes) {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
  throw
}
