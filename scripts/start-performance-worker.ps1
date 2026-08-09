[CmdletBinding()]
param([string]$Schema = 'perf_opt_20260806')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$evidenceRoot = Join-Path $projectRoot '.work\performance-test-drive'
$values = @{}
foreach ($line in Get-Content -LiteralPath (Join-Path $projectRoot '.env.local') -Encoding UTF8) {
  if ($line -match '^\s*([^#=]+?)\s*=\s*(.*?)\s*$') { $values[$matches[1].Trim()] = $matches[2].Trim('"', "'") }
}
if ($Schema -notmatch '^perf_opt_[a-z0-9_]+$') { throw 'PERF_SCHEMA_INVALID' }
if (-not $values.ContainsKey('TEST_DATABASE_URL')) { throw 'TEST_DATABASE_URL_MISSING' }
$databaseUri = [Uri]$values['TEST_DATABASE_URL']
if ($databaseUri.AbsolutePath -notmatch '(?i)test') { throw 'PERFORMANCE_TEST_DATABASE_REQUIRED' }

$env:DATABASE_URL = $values['TEST_DATABASE_URL']
$env:PGOPTIONS = "-c search_path=$Schema,public"
$env:NODE_ENV = 'test'
$env:HOST = '127.0.0.1'
$env:PORT = '3011'
$env:PUBLIC_ORIGIN = 'http://127.0.0.1:5174'
$env:STORAGE_ROOT = Join-Path $evidenceRoot 'storage'
$env:STORAGE_REPLICA_ROOT = ''
$env:STORAGE_POLICY = 'LOCAL_VERIFIED'
$env:CHINAMONEY_ENABLED = 'false'
$env:PERF_PROFILER_DIR = Join-Path $evidenceRoot 'profiler'
$env:PERF_PROCESS_ROLE = 'worker'
$profilerModule = (Resolve-Path -LiteralPath (Join-Path $projectRoot 'scripts\performance-profiler.mjs')).Path
$profilerImport = "--import=$(([Uri]$profilerModule).AbsoluteUri)"
$env:NODE_OPTIONS = if ($env:NODE_OPTIONS) { "$($env:NODE_OPTIONS) $profilerImport" } else { $profilerImport }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path $evidenceRoot "$stamp-isolated-worker.out.log"
$stderr = Join-Path $evidenceRoot "$stamp-isolated-worker.err.log"
$process = Start-Process -FilePath (Get-Command pnpm.cmd -ErrorAction Stop).Source `
  -ArgumentList @('exec', 'tsx', 'src/worker/index.ts') -WorkingDirectory $projectRoot `
  -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
  $started = Get-Content -LiteralPath $stdout -ErrorAction SilentlyContinue | Select-String -SimpleMatch 'worker_started'
  if ($started) {
    [pscustomobject]@{ wrapperPid = $process.Id; logPrefix = $stamp; database = $databaseUri.AbsolutePath.Trim('/'); schema = $Schema; profilerDirectory = $env:PERF_PROFILER_DIR } | ConvertTo-Json -Compress
    exit 0
  }
  if ($process.HasExited) { throw "PERFORMANCE_TEST_WORKER_EXITED:$($process.ExitCode)" }
  Start-Sleep -Milliseconds 500
}
throw "PERFORMANCE_TEST_WORKER_NOT_READY:$($process.Id)"
