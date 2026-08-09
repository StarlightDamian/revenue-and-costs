param(
  [string]$OutputRoot = '.work/acceptance',
  [string]$PgBin = 'D:\Program Files\PostgreSQL\17\bin',
  [int]$PrimaryPort = 55433,
  [int]$RestorePort = 55434
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputRoot)
$runRoot = Join-Path $resolvedOutput "pitr-$stamp"
$primaryRoot = Join-Path $runRoot 'primary'
$archiveRoot = Join-Path $runRoot 'archive'
$restoreRoot = Join-Path $runRoot 'restore'
$evidencePath = Join-Path $resolvedOutput 'pitr-evidence.json'
$initdb = Join-Path $PgBin 'initdb.exe'
$pgCtl = Join-Path $PgBin 'pg_ctl.exe'
$psql = Join-Path $PgBin 'psql.exe'
$pgBasebackup = Join-Path $PgBin 'pg_basebackup.exe'

foreach ($binary in @($initdb, $pgCtl, $psql, $pgBasebackup)) {
  if (-not (Test-Path -LiteralPath $binary)) { throw "PostgreSQL binary not found: $binary" }
}
New-Item -ItemType Directory -Force -Path $resolvedOutput, $runRoot, $archiveRoot | Out-Null

$primaryStarted = $false
$restoreStarted = $false
try {
  & $initdb -D $primaryRoot -U postgres -A trust --encoding=UTF8 --no-locale
  if ($LASTEXITCODE -ne 0) { throw "initdb failed with exit code $LASTEXITCODE" }
  # PostgreSQL config strings consume one escaping layer and Windows `copy`
  # requires native backslash paths. Doubling here leaves one backslash for cmd.
  $archiveSqlPath = $archiveRoot.Replace('\', '\\')
  Add-Content -LiteralPath (Join-Path $primaryRoot 'postgresql.auto.conf') -Encoding utf8 -Value @(
    "listen_addresses = '127.0.0.1'",
    "port = $PrimaryPort",
    "archive_mode = on",
    "wal_level = replica",
    "max_wal_senders = 3",
    "archive_command = 'copy /Y `"%p`" `"$archiveSqlPath\\%f`" >NUL'"
  )
  & $pgCtl -D $primaryRoot -l (Join-Path $runRoot 'primary.log') -w start
  if ($LASTEXITCODE -ne 0) { throw "primary pg_ctl start failed with exit code $LASTEXITCODE" }
  $primaryStarted = $true

  & $psql -h 127.0.0.1 -p $PrimaryPort -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE pitr_acceptance'
  if ($LASTEXITCODE -ne 0) { throw 'create PITR acceptance database failed' }
  & $psql -h 127.0.0.1 -p $PrimaryPort -U postgres -d pitr_acceptance -v ON_ERROR_STOP=1 -c "CREATE TABLE recovery_marker(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,label text UNIQUE NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()); INSERT INTO recovery_marker(label) VALUES('before_base');"
  if ($LASTEXITCODE -ne 0) { throw 'create PITR marker failed' }

  & $pgBasebackup -h 127.0.0.1 -p $PrimaryPort -U postgres -D $restoreRoot -Fp -X stream -c fast
  if ($LASTEXITCODE -ne 0) { throw "pg_basebackup failed with exit code $LASTEXITCODE" }
  & $psql -h 127.0.0.1 -p $PrimaryPort -U postgres -d pitr_acceptance -v ON_ERROR_STOP=1 -c "INSERT INTO recovery_marker(label) VALUES('after_base_before_target');"
  if ($LASTEXITCODE -ne 0) { throw 'write pre-target marker failed' }
  & $psql -h 127.0.0.1 -p $PrimaryPort -U postgres -d pitr_acceptance -v ON_ERROR_STOP=1 -c "SELECT pg_create_restore_point('revenue_costs_acceptance_target');"
  if ($LASTEXITCODE -ne 0) { throw 'create named restore point failed' }
  & $psql -h 127.0.0.1 -p $PrimaryPort -U postgres -d pitr_acceptance -v ON_ERROR_STOP=1 -c "INSERT INTO recovery_marker(label) VALUES('after_target'); SELECT pg_switch_wal();"
  if ($LASTEXITCODE -ne 0) { throw 'write post-target marker failed' }
  & $pgCtl -D $primaryRoot -m fast -w stop
  if ($LASTEXITCODE -ne 0) { throw 'primary pg_ctl stop failed' }
  $primaryStarted = $false

  $restoreSqlPath = $archiveRoot.Replace('\', '\\')
  Add-Content -LiteralPath (Join-Path $restoreRoot 'postgresql.auto.conf') -Encoding utf8 -Value @(
    "port = $RestorePort",
    "restore_command = 'copy /Y `"$restoreSqlPath\\%f`" `"%p`" >NUL'",
    "recovery_target_name = 'revenue_costs_acceptance_target'",
    "recovery_target_action = 'promote'"
  )
  New-Item -ItemType File -Force -Path (Join-Path $restoreRoot 'recovery.signal') | Out-Null
  & $pgCtl -D $restoreRoot -l (Join-Path $runRoot 'restore.log') -w start
  if ($LASTEXITCODE -ne 0) { throw 'restored pg_ctl start failed' }
  $restoreStarted = $true

  $labelsJson = & $psql -h 127.0.0.1 -p $RestorePort -U postgres -d pitr_acceptance -v ON_ERROR_STOP=1 -At -c "SELECT json_agg(label ORDER BY id)::text FROM recovery_marker;"
  if ($LASTEXITCODE -ne 0) { throw 'restored marker verification failed' }
  $labels = $labelsJson | ConvertFrom-Json
  if (@($labels).Count -ne 2 -or $labels[0] -ne 'before_base' -or $labels[1] -ne 'after_base_before_target') {
    throw "PITR target mismatch: $labelsJson"
  }
  & $pgCtl -D $restoreRoot -m fast -w stop
  if ($LASTEXITCODE -ne 0) { throw 'restored pg_ctl stop failed' }
  $restoreStarted = $false

  $evidence = [ordered]@{
    status = 'ok'
    restoreTarget = 'revenue_costs_acceptance_target'
    recoveredLabels = @($labels)
    afterTargetExcluded = -not ($labels -contains 'after_target')
    archivedWalFiles = @(Get-ChildItem -LiteralPath $archiveRoot -File).Count
    primaryPort = $PrimaryPort
    restorePort = $RestorePort
    runRoot = $runRoot
    verifiedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  $evidence | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $evidencePath -Encoding utf8
  Write-Output ($evidence | ConvertTo-Json -Compress)
}
finally {
  if ($restoreStarted) { & $pgCtl -D $restoreRoot -m immediate -w stop | Out-Null }
  if ($primaryStarted) { & $pgCtl -D $primaryRoot -m immediate -w stop | Out-Null }
}
