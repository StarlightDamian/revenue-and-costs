[CmdletBinding()]
param(
  [ValidateSet('api', 'worker', 'web')]
  [string]$Service = 'api',
  [string]$RequestId,
  [string]$ErrorCode,
  [string]$JobId,
  [string]$BatchId,
  [string]$RunId,
  [string]$SnapshotId,
  [ValidateRange(1, 1000)]
  [int]$Tail = 50
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$startupRoot = Join-Path $projectRoot '.work\startup'
$manifestPath = Join-Path $startupRoot "current-$Service.json"
$candidateFiles = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
$manifestFound = Test-Path -LiteralPath $manifestPath

function Read-RecordField([object]$Record, [string]$Name) {
  $property = $Record.PSObject.Properties[$Name]
  return $(if ($null -eq $property) { $null } else { $property.Value })
}

if ($manifestFound) {
  try {
    $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in @('stdoutFile', 'stderrFile')) {
      $name = [string]$manifest.$property
      if ($name -and [System.IO.Path]::GetFileName($name) -eq $name) {
        $path = Join-Path $startupRoot $name
        if (Test-Path -LiteralPath $path) { $candidateFiles.Add((Get-Item -LiteralPath $path)) }
      }
    }
  } catch {
    throw "Current $Service log manifest is invalid: $manifestPath"
  }
}

if ($manifestFound -and $candidateFiles.Count -eq 0) {
  throw "Current $Service manifest does not reference an available log file: $manifestPath"
}

if ($candidateFiles.Count -eq 0) {
  $fallback = Get-ChildItem -LiteralPath $startupRoot -Filter "*-$Service.*.log" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Length -gt 0 } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 2
  foreach ($file in $fallback) { $candidateFiles.Add($file) }
}

if ($candidateFiles.Count -eq 0) {
  throw "No $Service logs are available under $startupRoot"
}

$records = foreach ($file in $candidateFiles) {
  foreach ($line in Get-Content -LiteralPath $file.FullName -Encoding UTF8) {
    try { $record = $line | ConvertFrom-Json } catch { continue }
    if (-not (Read-RecordField $record 'event')) { continue }
    if ($RequestId -and [string](Read-RecordField $record 'requestId') -ne $RequestId) { continue }
    if ($ErrorCode -and [string](Read-RecordField $record 'errorCode') -ne $ErrorCode -and [string](Read-RecordField $record 'errorMessageCode') -ne $ErrorCode) { continue }
    if ($JobId -and [string](Read-RecordField $record 'jobId') -ne $JobId) { continue }
    if ($BatchId -and [string](Read-RecordField $record 'batchId') -ne $BatchId) { continue }
    if ($RunId -and [string](Read-RecordField $record 'runId') -ne $RunId) { continue }
    if ($SnapshotId -and [string](Read-RecordField $record 'snapshotId') -ne $SnapshotId) { continue }
    [ordered]@{
      time = Read-RecordField $record 'time'
      event = Read-RecordField $record 'event'
      service = Read-RecordField $record 'service'
      pid = Read-RecordField $record 'pid'
      requestId = Read-RecordField $record 'requestId'
      method = Read-RecordField $record 'method'
      route = Read-RecordField $record 'route'
      statusCode = Read-RecordField $record 'statusCode'
      durationMs = Read-RecordField $record 'durationMs'
      outcome = Read-RecordField $record 'outcome'
      errorCode = Read-RecordField $record 'errorCode'
      errorMessageCode = Read-RecordField $record 'errorMessageCode'
      jobId = Read-RecordField $record 'jobId'
      batchId = Read-RecordField $record 'batchId'
      runId = Read-RecordField $record 'runId'
      snapshotId = Read-RecordField $record 'snapshotId'
      exportId = Read-RecordField $record 'exportId'
      fileId = Read-RecordField $record 'fileId'
      shopId = Read-RecordField $record 'shopId'
      errorType = Read-RecordField $record 'errorType'
      errorSource = Read-RecordField $record 'errorSource'
      errorSystemCode = Read-RecordField $record 'errorSystemCode'
      errorConstraint = Read-RecordField $record 'errorConstraint'
      causeType = Read-RecordField $record 'causeType'
      causeMessageCode = Read-RecordField $record 'causeMessageCode'
      causeSource = Read-RecordField $record 'causeSource'
      causeSystemCode = Read-RecordField $record 'causeSystemCode'
      sourceLog = $file.Name
    }
  }
}

$records | Sort-Object { [double]$_.time } | Select-Object -Last $Tail | ForEach-Object { $_ | ConvertTo-Json -Compress }
