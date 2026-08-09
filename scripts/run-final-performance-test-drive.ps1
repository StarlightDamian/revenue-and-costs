[CmdletBinding()]
param(
  [ValidateRange(1, 20)][int]$Measurements = 5,
  [ValidateRange(0, 100)][double]$MaxHostCpuPercent = 20,
  [ValidatePattern('^[a-z0-9_]+$')][string]$SuiteId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmss'),
  [switch]$Resume,
  [switch]$SkipHostLoadCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$evidenceRoot = Join-Path $projectRoot '.work\performance-test-drive'
$suitePath = Join-Path $evidenceRoot "$SuiteId-suite.json"
$envPath = Join-Path $projectRoot '.env.local'
$baseNodeOptions = $env:NODE_OPTIONS
$utf8 = [System.Text.Encoding]::UTF8
$companies = @(
  [ordered]@{ name = $utf8.GetString([Convert]::FromBase64String('5byA5qih5biI')); slug = 'kaimoshi' }
  [ordered]@{ name = $utf8.GetString([Convert]::FromBase64String('57Gz5YWL')); slug = 'mike' }
  [ordered]@{ name = $utf8.GetString([Convert]::FromBase64String('6Zi/5bCU6YeR')); slug = 'aerjin' }
)

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

function Get-SourceFingerprint {
  $roots = @('src', 'migrations', 'scripts')
  $files = @()
  foreach ($root in $roots) {
    $files += Get-ChildItem -LiteralPath (Join-Path $projectRoot $root) -Recurse -File
  }
  foreach ($name in @('package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'vite.config.ts')) {
    $path = Join-Path $projectRoot $name
    if (Test-Path -LiteralPath $path -PathType Leaf) { $files += Get-Item -LiteralPath $path }
  }
  $lines = foreach ($file in $files | Sort-Object FullName) {
    $relative = $file.FullName.Substring($projectRoot.Length + 1).Replace('\', '/')
    "$relative`t$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-HostSnapshot {
  $samples = @((Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 5).CounterSamples | ForEach-Object {
    [math]::Round($_.CookedValue, 2)
  })
  $operatingSystem = Get-CimInstance Win32_OperatingSystem
  return [ordered]@{
    sampledAt = (Get-Date).ToUniversalTime().ToString('o')
    cpuPercent = $samples
    cpuAveragePercent = [math]::Round(($samples | Measure-Object -Average).Average, 2)
    cpuMaximumPercent = [math]::Round(($samples | Measure-Object -Maximum).Maximum, 2)
    freePhysicalMemoryBytes = ([int64]$operatingSystem.FreePhysicalMemory * 1024).ToString()
  }
}

function Write-Suite([object]$Suite) {
  $Suite.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  $temporary = "$suitePath.tmp"
  $Suite | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $suitePath -Force
}

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "COMMAND_FAILED:$Program $($Arguments -join ' ')" }
}

function Find-ProcessManifest([string]$Schema, [datetime]$NotBefore) {
  foreach ($file in Get-ChildItem -LiteralPath $evidenceRoot -Filter '*-isolated-processes.json' | Sort-Object LastWriteTime -Descending) {
    if ($file.LastWriteTime -lt $NotBefore.AddSeconds(-5)) { continue }
    $manifest = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schema -eq $Schema) { return $file.FullName }
  }
  throw "PROCESS_MANIFEST_NOT_FOUND:$Schema"
}

function Stop-IsolatedRuntime([string]$ManifestPath, [string]$ExpectedSchema) {
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.schema -ne $ExpectedSchema) { throw "PROCESS_MANIFEST_SCHEMA_MISMATCH:$($manifest.schema)" }
  $wrapperIds = @($manifest.wrappers.api, $manifest.wrappers.worker) | Where-Object { $_ }
  $childIds = @($manifest.children | ForEach-Object { $_.ProcessId }) | Where-Object { $_ }
  foreach ($id in $wrapperIds) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -notmatch 'pnpm\.CMD.+exec tsx src[/\\](api|worker)[/\\]index\.ts') {
      throw "PERFORMANCE_WRAPPER_VALIDATION_FAILED:$id"
    }
  }
  foreach ($id in $childIds) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if ($process -and ($process.CommandLine -notmatch [regex]::Escape($projectRoot) -or $process.CommandLine -notmatch 'src[/\\](api|worker)[/\\]index\.ts')) {
      throw "PERFORMANCE_CHILD_VALIDATION_FAILED:$id"
    }
  }
  foreach ($id in @($wrapperIds + $childIds | Sort-Object -Unique)) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  $listener = Get-NetTCPConnection -LocalPort 3011 -State Listen -ErrorAction SilentlyContinue
  if ($listener) { throw "PERFORMANCE_PORT_STILL_IN_USE:$($listener.OwningProcess)" }
}

function Find-RunEvidence([string]$Schema, [datetime]$NotBefore) {
  foreach ($file in Get-ChildItem -LiteralPath $evidenceRoot -Filter 'test-drive-run-*.json' | Sort-Object LastWriteTime -Descending) {
    if ($file.LastWriteTime -lt $NotBefore.AddSeconds(-5)) { continue }
    $run = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($run.target.schema -eq $Schema) { return $file.FullName }
  }
  throw "TEST_DRIVE_EVIDENCE_NOT_FOUND:$Schema"
}

New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
$values = Read-EnvFile $envPath
foreach ($required in @('DATABASE_URL', 'TEST_DATABASE_URL', 'REGISTRATION_ADMIN_PHONE')) {
  if (-not $values.ContainsKey($required)) { throw "${required}_MISSING" }
}
$testDatabase = [Uri]$values['TEST_DATABASE_URL']
if ($testDatabase.AbsolutePath -notmatch '(?i)test') { throw 'PERFORMANCE_TEST_DATABASE_REQUIRED' }
$sourceFingerprint = Get-SourceFingerprint

if ($Resume) {
  if (-not (Test-Path -LiteralPath $suitePath -PathType Leaf)) { throw 'PERFORMANCE_SUITE_NOT_FOUND' }
  $suite = Get-Content -LiteralPath $suitePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($suite.sourceFingerprint -ne $sourceFingerprint) { throw 'PERFORMANCE_SUITE_SOURCE_CHANGED' }
  if ([int]$suite.measurements -ne $Measurements) { throw 'PERFORMANCE_SUITE_MEASUREMENT_MISMATCH' }
  if ([double]$suite.maxHostCpuPercent -ne $MaxHostCpuPercent) { throw 'PERFORMANCE_SUITE_CPU_LIMIT_MISMATCH' }
  $suite.status = 'RUNNING'
} else {
  if (Test-Path -LiteralPath $suitePath) { throw 'PERFORMANCE_SUITE_ALREADY_EXISTS' }
  $suite = [ordered]@{
    schemaVersion = 1
    suiteId = $SuiteId
    status = 'RUNNING'
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    sourceFingerprint = $sourceFingerprint
    database = $testDatabase.AbsolutePath.Trim('/')
    measurements = $Measurements
    maxHostCpuPercent = $MaxHostCpuPercent
    samples = @()
    finishedAt = $null
  }
  Write-Suite $suite
}

$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
$schedule = @()
foreach ($company in $companies) {
  $schedule += [ordered]@{ company = $company.name; slug = $company.slug; phase = 'warmup'; ordinal = 0 }
  for ($ordinal = 1; $ordinal -le $Measurements; $ordinal += 1) {
    $schedule += [ordered]@{ company = $company.name; slug = $company.slug; phase = 'measure'; ordinal = $ordinal }
  }
}

foreach ($scheduled in $schedule) {
  $completed = @($suite.samples | Where-Object {
    $_.company -eq $scheduled.company -and $_.phase -eq $scheduled.phase -and [int]$_.ordinal -eq $scheduled.ordinal -and $_.status -eq 'SUCCEEDED'
  })
  if ($completed.Count -gt 0) { continue }

  if (Get-NetTCPConnection -LocalPort 3011 -State Listen -ErrorAction SilentlyContinue) {
    throw 'PERFORMANCE_TEST_PORT_IN_USE:3011'
  }
  $currentFingerprint = Get-SourceFingerprint
  if ($currentFingerprint -ne $sourceFingerprint) { throw 'PERFORMANCE_SUITE_SOURCE_CHANGED' }
  $hostSnapshot = Get-HostSnapshot
  if (-not $SkipHostLoadCheck -and [double]$hostSnapshot.cpuAveragePercent -gt $MaxHostCpuPercent) {
    Write-Suite $suite
    throw "PERFORMANCE_HOST_BUSY:$($hostSnapshot.cpuAveragePercent)"
  }
  $attempt = @($suite.samples | Where-Object {
    $_.company -eq $scheduled.company -and $_.phase -eq $scheduled.phase -and [int]$_.ordinal -eq $scheduled.ordinal
  }).Count + 1
  $phaseCode = if ($scheduled.phase -eq 'warmup') { 'w0' } else { "m$($scheduled.ordinal)" }
  $schema = "perf_opt_final_${SuiteId}_$($scheduled.slug)_${phaseCode}_a$attempt"
  if ($schema.Length -gt 63 -or $schema -notmatch '^perf_opt_[a-z0-9_]+$') { throw "PERF_SCHEMA_INVALID:$schema" }
  $sampleStarted = Get-Date
  $processManifest = $null
  $entry = [ordered]@{
    company = $scheduled.company
    phase = $scheduled.phase
    ordinal = $scheduled.ordinal
    attempt = $attempt
    status = 'RUNNING'
    schema = $schema
    startedAt = $sampleStarted.ToUniversalTime().ToString('o')
    host = $hostSnapshot
    sourceFingerprint = $sourceFingerprint
    processManifest = $null
    runEvidence = $null
    failure = $null
    finishedAt = $null
  }
  $suite.samples = @($suite.samples) + $entry
  Write-Suite $suite
  try {
    $env:DATABASE_URL = $values['TEST_DATABASE_URL']
    $env:SOURCE_DATABASE_URL = $values['DATABASE_URL']
    $env:PERF_SCHEMA = $schema
    Invoke-Checked $pnpm @('exec', 'tsx', 'scripts/performance-test-drive.ts', 'prepare-schema')

    if ($null -eq $baseNodeOptions) { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue }
    else { $env:NODE_OPTIONS = $baseNodeOptions }
    & (Join-Path $PSScriptRoot 'start-performance-test-drive.ps1') -Schema $schema -SkipWeb
    $processManifest = Find-ProcessManifest $schema $sampleStarted
    $entry.processManifest = $processManifest.Substring($projectRoot.Length + 1)
    Write-Suite $suite

    $env:PGOPTIONS = "-c search_path=$schema,public"
    $env:PERF_COMPANY = $scheduled.company
    $env:PERF_ADMIN_PHONE = $values['REGISTRATION_ADMIN_PHONE']
    $env:PERF_API_URL = 'http://127.0.0.1:3011'
    $env:PERF_WEB_URL = 'http://127.0.0.1:5174'
    Invoke-Checked $pnpm @('exec', 'tsx', 'scripts/performance-test-drive.ts', 'prepare-fixture')
    Invoke-Checked $pnpm @('db:bootstrap-mappings')
    $runStarted = Get-Date
    Invoke-Checked $pnpm @('exec', 'tsx', 'scripts/performance-test-drive.ts', 'run-one')
    $runEvidence = Find-RunEvidence $schema $runStarted
    $entry.runEvidence = $runEvidence.Substring($projectRoot.Length + 1)
    $entry.status = 'SUCCEEDED'
    $entry.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  } catch {
    $entry.status = 'FAILED'
    $entry.failure = $_.Exception.Message
    $entry.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    throw
  } finally {
    if ($processManifest) { Stop-IsolatedRuntime $processManifest $schema }
    Write-Suite $suite
  }
}

$suite.status = 'SUCCEEDED'
$suite.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
Write-Suite $suite
Invoke-Checked (Get-Command node.exe -ErrorAction Stop).Source @('scripts/summarize-performance-test-drive.mjs', $suitePath)
Write-Output ($suite | ConvertTo-Json -Depth 5)
