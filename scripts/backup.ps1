param(
  [string]$DatabaseUrl = $env:DATABASE_URL,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string]$TargetName = 'local-validation',
  [string]$TargetReference,
  [switch]$Offsite,
  [string]$ManifestHmacKeyFile = $env:BACKUP_MANIFEST_HMAC_KEY_FILE,
  [string]$BackupEncryptionKeyFile = $env:BACKUP_ENCRYPTION_KEY_FILE,
  [string]$TemporaryDirectory = $env:BACKUP_TEMP_DIRECTORY,
  [string]$PgBin = 'D:\Program Files\PostgreSQL\17\bin'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'operations\common.ps1')

if (-not $DatabaseUrl) { throw 'DATABASE_URL_MISSING' }
if (-not $ManifestHmacKeyFile) { throw 'MANIFEST_KEY_FILE_MISSING' }
if (-not $BackupEncryptionKeyFile) { throw 'BACKUP_ENCRYPTION_KEY_FILE_MISSING' }
if (-not $TemporaryDirectory) { throw 'BACKUP_TEMP_DIRECTORY_MISSING' }
if (-not $TargetName.Trim() -or $TargetName.Length -gt 120) { throw 'TARGET_NAME_INVALID' }

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
$resolvedKey = [System.IO.Path]::GetFullPath($ManifestHmacKeyFile)
$resolvedEncryptionKey = [System.IO.Path]::GetFullPath($BackupEncryptionKeyFile)
$resolvedTemporary = [System.IO.Path]::GetFullPath($TemporaryDirectory)
$outputPrefix = $resolvedOutput.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if ($resolvedKey.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'MANIFEST_KEY_MUST_BE_SEPARATE' }
if ($resolvedEncryptionKey.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'BACKUP_KEY_MUST_BE_SEPARATE' }
if ($resolvedEncryptionKey -eq $resolvedKey) { throw 'BACKUP_KEYS_MUST_BE_SEPARATE' }
New-Item -ItemType Directory -Force -Path $resolvedTemporary | Out-Null

$targetKind = if ($Offsite) { 'OFFSITE' } else { 'LOCAL_VALIDATION' }
if ($Offsite -and -not $TargetReference) { throw 'OFFSITE_TARGET_REFERENCE_REQUIRED' }
if (-not $TargetReference) { $TargetReference = $resolvedOutput }
$targetReferenceSha256 = Get-TextSha256Hex $TargetReference
$key = Get-ManifestKey $resolvedKey

$pgDump = Join-Path $PgBin 'pg_dump.exe'
$psql = Join-Path $PgBin 'psql.exe'
foreach ($binary in @($pgDump, $psql)) {
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'POSTGRES_BINARY_MISSING' }
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss-fff')
$nonce = [guid]::NewGuid().ToString('N')
$businessKey = "base:$stamp`:$nonce"
$baseName = "revenue-and-costs-$stamp-$($nonce.Substring(0, 12))"
$runTemporary = Join-Path $resolvedTemporary "backup-$nonce"
New-Item -ItemType Directory -Path $runTemporary | Out-Null
$plaintextDumpPath = Join-Path $runTemporary "$baseName.dump"
$backupPath = Join-Path $resolvedOutput "$baseName.dump.esdk"
$manifestPath = Join-Path $resolvedOutput "$baseName.manifest.json"
$signaturePath = Join-Path $resolvedOutput "$baseName.manifest.hmac"
$createdPaths = @($backupPath, $manifestPath, $signaturePath)
$cryptoScript = Join-Path $PSScriptRoot 'operations\backup-crypto.mjs'
$runStarted = $false
$failureCode = 'BACKUP_FAILED'

try {
  $runId = Invoke-PsqlScalar -DatabaseUrl $DatabaseUrl -PsqlPath $psql -FailureCode 'BACKUP_RECORD_START_FAILED' -Variables @{
    business_key = $businessKey
    target_name = $TargetName
    target_kind = $targetKind
    target_reference_sha256 = $targetReferenceSha256
  } -Sql @"
INSERT INTO backup_run
  (business_key, backup_kind, status, target_name, target_kind, target_reference_sha256, details)
VALUES
  (:'business_key', 'BASE', 'RUNNING', :'target_name', :'target_kind', :'target_reference_sha256',
   jsonb_build_object('scriptVersion', 2, 'manifestAuthenticated', true))
RETURNING id::text;
"@
  if (-not $runId) { throw 'BACKUP_RECORD_START_FAILED' }
  $runStarted = $true

  $failureCode = 'PG_DUMP_FAILED'
  Invoke-PostgresNative -DatabaseUrl $DatabaseUrl -Executable $pgDump -FailureCode $failureCode -Arguments @(
    '--format=custom', '--no-owner', '--no-privileges', '--file', $plaintextDumpPath
  ) | Out-Null

  $failureCode = 'BACKUP_ENCRYPTION_FAILED'
  $encryptionContext = @{
    businessKey = $businessKey
    backupKind = 'BASE'
    format = 'AWS_ESDK_V2_FRAMED'
    targetReferenceSha256 = $targetReferenceSha256
  }
  $crypto = Invoke-BackupCrypto -Operation encrypt -InputPath $plaintextDumpPath -OutputPath $backupPath `
    -KeyFile $resolvedEncryptionKey -Context $encryptionContext -CryptoScript $cryptoScript
  Remove-Item -LiteralPath $plaintextDumpPath -Force

  $failureCode = 'BACKUP_MANIFEST_FAILED'
  $backupInfo = Get-Item -LiteralPath $backupPath
  $manifest = [ordered]@{
    format = 'revenue-and-costs-backup-manifest-v3'
    businessKey = $businessKey
    backupKind = 'BASE'
    backupFile = [System.IO.Path]::GetFileName($backupPath)
    plaintextBytes = [string]$crypto.plaintextBytes
    plaintextSha256 = [string]$crypto.plaintextSha256
    ciphertextBytes = [string]$crypto.ciphertextBytes
    ciphertextSha256 = [string]$crypto.ciphertextSha256
    encryptionFormat = [string]$crypto.encryptionFormat
    encryptionContext = $encryptionContext
    targetName = $TargetName
    targetKind = $targetKind
    targetReferenceSha256 = $targetReferenceSha256
    completedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  }
  $manifestBytes = [System.Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json -Compress))
  $manifestSha256 = Get-Sha256Hex $manifestBytes
  $manifestHmacSha256 = Get-HmacSha256Hex -Key $key -Bytes $manifestBytes
  Write-AtomicBytes -Path $manifestPath -Bytes $manifestBytes
  Write-AtomicBytes -Path $signaturePath -Bytes ([System.Text.Encoding]::ASCII.GetBytes("$manifestHmacSha256`n"))

  $writtenManifestBytes = [System.IO.File]::ReadAllBytes($manifestPath)
  if (-not (Test-FixedHexEqual -Expected $manifestSha256 -Actual (Get-Sha256Hex $writtenManifestBytes))) {
    throw 'MANIFEST_WRITE_VERIFICATION_FAILED'
  }
  if (-not (Test-FixedHexEqual -Expected $manifestHmacSha256 -Actual (Get-HmacSha256Hex -Key $key -Bytes $writtenManifestBytes))) {
    throw 'MANIFEST_AUTH_WRITE_VERIFICATION_FAILED'
  }
  if ($backupInfo.Length.ToString() -ne [string]$crypto.ciphertextBytes) { throw 'BACKUP_CIPHERTEXT_SIZE_MISMATCH' }
  if (-not (Test-FixedHexEqual -Expected ([string]$crypto.ciphertextSha256) -Actual (Get-FileSha256Hex $backupPath))) {
    throw 'BACKUP_CIPHERTEXT_HASH_MISMATCH'
  }

  foreach ($path in $createdPaths) { (Get-Item -LiteralPath $path).IsReadOnly = $true }

  $failureCode = 'BACKUP_RECORD_FINISH_FAILED'
  $finished = Invoke-PsqlScalar -DatabaseUrl $DatabaseUrl -PsqlPath $psql -FailureCode $failureCode -Variables @{
    business_key = $businessKey
    manifest_sha256 = $manifestSha256
    manifest_hmac_sha256 = $manifestHmacSha256
    plaintext_sha256 = [string]$crypto.plaintextSha256
    ciphertext_sha256 = [string]$crypto.ciphertextSha256
    ciphertext_bytes = [string]$crypto.ciphertextBytes
  } -Sql @"
UPDATE backup_run
   SET status = 'SUCCEEDED', finished_at = clock_timestamp(),
       manifest_sha256 = :'manifest_sha256', manifest_hmac_sha256 = :'manifest_hmac_sha256',
       details = details || jsonb_build_object(
         'plaintextSha256', :'plaintext_sha256', 'ciphertextSha256', :'ciphertext_sha256',
         'ciphertextBytes', :'ciphertext_bytes', 'encryptionFormat', 'AWS_ESDK_V2_FRAMED',
         'manifestAuthenticated', true)
 WHERE business_key = :'business_key' AND status = 'RUNNING'
RETURNING id::text;
"@
  if (-not $finished) { throw 'BACKUP_RECORD_FINISH_FAILED' }

  Write-Output ([pscustomobject]@{
    status = 'ok'
    businessKey = $businessKey
    backup = $backupPath
    manifest = $manifestPath
    signature = $signaturePath
    plaintextSha256 = [string]$crypto.plaintextSha256
    ciphertextSha256 = [string]$crypto.ciphertextSha256
    manifestSha256 = $manifestSha256
    targetName = $TargetName
    targetKind = $targetKind
  } | ConvertTo-Json -Compress)
}
catch {
  if ($runStarted) {
    try {
      Invoke-PsqlScalar -DatabaseUrl $DatabaseUrl -PsqlPath $psql -FailureCode 'BACKUP_RECORD_FAILURE_FAILED' -Variables @{
        business_key = $businessKey
        error_code = $failureCode
      } -Sql @"
UPDATE backup_run
   SET status = 'FAILED', finished_at = clock_timestamp(), error_code = :'error_code'
 WHERE business_key = :'business_key' AND status = 'RUNNING'
RETURNING id::text;
"@ | Out-Null
    } catch { }
  }
  foreach ($path in $createdPaths) {
    if (Test-Path -LiteralPath $path) {
      try { (Get-Item -LiteralPath $path).IsReadOnly = $false } catch { }
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
  }
  if (Test-Path -LiteralPath $runTemporary) { Remove-Item -LiteralPath $runTemporary -Recurse -Force -ErrorAction SilentlyContinue }
  throw $failureCode
}
finally {
  if (Test-Path -LiteralPath $runTemporary) { Remove-Item -LiteralPath $runTemporary -Recurse -Force -ErrorAction SilentlyContinue }
  if ($key) { [Array]::Clear($key, 0, $key.Length) }
}
