param(
  [string]$DatabaseUrl = $env:RESTORE_DATABASE_URL,
  [string]$ControlDatabaseUrl = $env:DATABASE_URL,
  [Parameter(Mandatory = $true)][string]$DumpPath,
  [string]$ManifestPath,
  [string]$SignaturePath,
  [string]$ManifestHmacKeyFile = $env:BACKUP_MANIFEST_HMAC_KEY_FILE,
  [string]$BackupEncryptionKeyFile = $env:BACKUP_ENCRYPTION_KEY_FILE,
  [string]$TemporaryDirectory = $env:RESTORE_TEMP_DIRECTORY,
  [string]$PgBin = 'D:\Program Files\PostgreSQL\17\bin'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'operations\common.ps1')

if (-not $DatabaseUrl) { throw 'RESTORE_DATABASE_URL_MISSING' }
if (-not $ControlDatabaseUrl) { throw 'CONTROL_DATABASE_URL_MISSING' }
if (-not $ManifestHmacKeyFile) { throw 'MANIFEST_KEY_FILE_MISSING' }
if (-not $BackupEncryptionKeyFile) { throw 'BACKUP_ENCRYPTION_KEY_FILE_MISSING' }
if (-not $TemporaryDirectory) { throw 'RESTORE_TEMP_DIRECTORY_MISSING' }
if ((Get-DatabaseIdentity $DatabaseUrl) -eq (Get-DatabaseIdentity $ControlDatabaseUrl)) {
  throw 'RESTORE_TARGET_MUST_BE_ISOLATED'
}

$resolvedDump = [System.IO.Path]::GetFullPath($DumpPath)
if (-not (Test-Path -LiteralPath $resolvedDump -PathType Leaf)) { throw 'DUMP_FILE_MISSING' }
$backupFileName = [System.IO.Path]::GetFileName($resolvedDump)
$baseName = if ($backupFileName.EndsWith('.dump.esdk', [StringComparison]::OrdinalIgnoreCase)) {
  $backupFileName.Substring(0, $backupFileName.Length - '.dump.esdk'.Length)
} else {
  [System.IO.Path]::GetFileNameWithoutExtension($resolvedDump)
}
$directory = [System.IO.Path]::GetDirectoryName($resolvedDump)
if (-not $ManifestPath) { $ManifestPath = Join-Path $directory "$baseName.manifest.json" }
if (-not $SignaturePath) { $SignaturePath = Join-Path $directory "$baseName.manifest.hmac" }
$resolvedManifest = [System.IO.Path]::GetFullPath($ManifestPath)
$resolvedSignature = [System.IO.Path]::GetFullPath($SignaturePath)
if (-not (Test-Path -LiteralPath $resolvedManifest -PathType Leaf)) { throw 'MANIFEST_FILE_MISSING' }
if (-not (Test-Path -LiteralPath $resolvedSignature -PathType Leaf)) { throw 'MANIFEST_SIGNATURE_MISSING' }

$pgRestore = Join-Path $PgBin 'pg_restore.exe'
$psql = Join-Path $PgBin 'psql.exe'
$cryptoScript = Join-Path $PSScriptRoot 'operations\backup-crypto.mjs'
foreach ($binary in @($pgRestore, $psql)) {
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'POSTGRES_BINARY_MISSING' }
}

$key = Get-ManifestKey ([System.IO.Path]::GetFullPath($ManifestHmacKeyFile))
$resolvedEncryptionKey = [System.IO.Path]::GetFullPath($BackupEncryptionKeyFile)
$resolvedTemporary = [System.IO.Path]::GetFullPath($TemporaryDirectory)
New-Item -ItemType Directory -Force -Path $resolvedTemporary | Out-Null
$failureCode = 'MANIFEST_AUTH_FAILED'
$sourceVersion = "restore-check:$([guid]::NewGuid().ToString('N'))"
$targetKind = 'LOCAL_VALIDATION'
$targetReferenceSha256 = ''
$manifestSha256 = ''
$manifestHmacSha256 = ''
$checkpointRecorded = $false
$runTemporary = ''

try {
  # Authenticate the exact manifest bytes before parsing any path or hash from it.
  $manifestBytes = [System.IO.File]::ReadAllBytes($resolvedManifest)
  $providedHmac = [System.IO.File]::ReadAllText($resolvedSignature).Trim().ToLowerInvariant()
  $computedHmac = Get-HmacSha256Hex -Key $key -Bytes $manifestBytes
  if (-not (Test-FixedHexEqual -Expected $providedHmac -Actual $computedHmac)) { throw $failureCode }
  $manifestHmacSha256 = $computedHmac
  $manifestSha256 = Get-Sha256Hex $manifestBytes

  $failureCode = 'MANIFEST_INVALID'
  try { $manifest = [System.Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json }
  catch { throw $failureCode }
  $required = @(
    'format', 'businessKey', 'backupFile', 'plaintextBytes', 'plaintextSha256',
    'ciphertextBytes', 'ciphertextSha256', 'encryptionFormat', 'encryptionContext',
    'targetKind', 'targetReferenceSha256'
  )
  foreach ($name in $required) {
    if (-not $manifest.PSObject.Properties[$name] -or -not [string]$manifest.$name) { throw $failureCode }
  }
  if ($manifest.format -ne 'revenue-and-costs-backup-manifest-v3') { throw $failureCode }
  if ($manifest.targetKind -notin @('LOCAL_VALIDATION', 'OFFSITE')) { throw $failureCode }
  if ($manifest.encryptionFormat -ne 'AWS_ESDK_V2_FRAMED') { throw $failureCode }
  if ([string]$manifest.plaintextSha256 -notmatch '^[0-9a-f]{64}$') { throw $failureCode }
  if ([string]$manifest.ciphertextSha256 -notmatch '^[0-9a-f]{64}$') { throw $failureCode }
  if ([string]$manifest.targetReferenceSha256 -notmatch '^[0-9a-f]{64}$') { throw $failureCode }
  if ([string]$manifest.plaintextBytes -notmatch '^(0|[1-9][0-9]*)$') { throw $failureCode }
  if ([string]$manifest.ciphertextBytes -notmatch '^(0|[1-9][0-9]*)$') { throw $failureCode }
  if ([System.IO.Path]::GetFileName($resolvedDump) -ne [string]$manifest.backupFile) { throw $failureCode }
  $sourceVersion = [string]$manifest.businessKey
  $targetKind = [string]$manifest.targetKind
  $targetReferenceSha256 = [string]$manifest.targetReferenceSha256
  $expectedEncryptionContext = @{
    businessKey = $sourceVersion
    backupKind = 'BASE'
    format = 'AWS_ESDK_V2_FRAMED'
    targetReferenceSha256 = $targetReferenceSha256
  }
  foreach ($name in $expectedEncryptionContext.Keys) {
    if (-not $manifest.encryptionContext.PSObject.Properties[$name] -or
        [string]$manifest.encryptionContext.$name -ne $expectedEncryptionContext[$name]) { throw $failureCode }
  }

  $failureCode = 'BACKUP_CIPHERTEXT_HASH_MISMATCH'
  $dumpInfo = Get-Item -LiteralPath $resolvedDump
  if ($dumpInfo.Length.ToString() -ne [string]$manifest.ciphertextBytes) { throw $failureCode }
  if (-not (Test-FixedHexEqual -Expected ([string]$manifest.ciphertextSha256) -Actual (Get-FileSha256Hex $resolvedDump))) {
    throw $failureCode
  }

  $failureCode = 'BACKUP_DECRYPTION_FAILED'
  $runTemporary = Join-Path $resolvedTemporary "restore-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $runTemporary | Out-Null
  $plaintextDumpPath = Join-Path $runTemporary 'database.dump'
  $crypto = Invoke-BackupCrypto -Operation decrypt -InputPath $resolvedDump -OutputPath $plaintextDumpPath `
    -KeyFile $resolvedEncryptionKey -Context $expectedEncryptionContext -CryptoScript $cryptoScript
  if ([string]$crypto.plaintextBytes -ne [string]$manifest.plaintextBytes -or
      [string]$crypto.ciphertextBytes -ne [string]$manifest.ciphertextBytes -or
      -not (Test-FixedHexEqual -Expected ([string]$manifest.plaintextSha256) -Actual ([string]$crypto.plaintextSha256)) -or
      -not (Test-FixedHexEqual -Expected ([string]$manifest.ciphertextSha256) -Actual ([string]$crypto.ciphertextSha256))) {
    throw 'BACKUP_DECRYPTION_VERIFICATION_FAILED'
  }

  $failureCode = 'RESTORE_TARGET_NOT_EMPTY'
  $targetTableCount = Invoke-PsqlScalar -DatabaseUrl $DatabaseUrl -PsqlPath $psql -FailureCode $failureCode -Sql @"
SELECT count(*)::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r','p')
   AND n.nspname NOT IN ('pg_catalog','information_schema');
"@
  if ($targetTableCount -ne '0') { throw $failureCode }

  $failureCode = 'PG_RESTORE_FAILED'
  $restoreDatabaseName = [Uri]::UnescapeDataString(([Uri]$DatabaseUrl).AbsolutePath.TrimStart('/'))
  Invoke-PostgresNative -DatabaseUrl $DatabaseUrl -Executable $pgRestore -FailureCode $failureCode -Arguments @(
    '--exit-on-error', '--no-owner', '--no-privileges', '--dbname', $restoreDatabaseName, $plaintextDumpPath
  ) | Out-Null

  $failureCode = 'RESTORE_VALIDATION_FAILED'
  $migrationCount = Invoke-PsqlScalar -DatabaseUrl $DatabaseUrl -PsqlPath $psql -Sql "SELECT count(*)::text FROM schema_migration;"
  $walletViolations = Invoke-PsqlScalar -DatabaseUrl $DatabaseUrl -PsqlPath $psql -Sql @"
SELECT count(*)::text FROM wallet_account wa
 WHERE wa.balance_cents <> COALESCE((SELECT sum(wl.delta_cents) FROM wallet_ledger wl WHERE wl.wallet_id = wa.id), 0)
    OR wa.balance_cents <> COALESCE((SELECT wl.balance_after_cents FROM wallet_ledger wl WHERE wl.wallet_id = wa.id ORDER BY wl.id DESC LIMIT 1), 0);
"@
  $datasetPointerViolations = Invoke-PsqlScalar -DatabaseUrl $DatabaseUrl -PsqlPath $psql -Sql @"
SELECT count(*)::text FROM dataset_slice ds
  LEFT JOIN dataset_version dv ON dv.id = ds.current_version_id
 WHERE ds.current_version_id IS NOT NULL
   -- A confirmed slice remains current even when one required source is absent;
   -- that state is intentionally publish-excluded, not a broken pointer.
   AND (dv.id IS NULL OR dv.dataset_slice_id <> ds.id OR dv.status NOT IN ('ACTIVE', 'INCOMPLETE'));
"@
  $publishedPointerViolations = Invoke-PsqlScalar -DatabaseUrl $DatabaseUrl -PsqlPath $psql -Sql @"
SELECT count(*)::text FROM shop_current_published_snapshot current
  LEFT JOIN published_snapshot snapshot ON snapshot.id = current.published_snapshot_id
 WHERE snapshot.id IS NULL OR snapshot.shop_id <> current.shop_id;
"@
  $objectReferenceViolations = Invoke-PsqlScalar -DatabaseUrl $DatabaseUrl -PsqlPath $psql -Sql @"
SELECT (
  (SELECT count(*) FROM upload_file WHERE status = 'STORED' AND stored_object_id IS NULL) +
  (SELECT count(*) FROM export_request WHERE status = 'SUCCEEDED' AND output_object_id IS NULL) +
  (SELECT count(*) FROM stored_object so
    WHERE so.verification_status = 'REMOTE_VERIFIED'
      AND NOT EXISTS (
        SELECT 1 FROM stored_object_replica replica
         WHERE replica.object_id = so.id AND replica.status = 'VERIFIED'
           AND replica.replica_kind = 'OFFSITE'
           AND replica.ciphertext_sha256 = so.ciphertext_sha256
           AND replica.verified_at IS NOT NULL
      ))
)::text;
"@
  $objectCount = Invoke-PsqlScalar -DatabaseUrl $DatabaseUrl -PsqlPath $psql -Sql "SELECT count(*)::text FROM stored_object;"
  $walletEntryCount = Invoke-PsqlScalar -DatabaseUrl $DatabaseUrl -PsqlPath $psql -Sql "SELECT count(*)::text FROM wallet_ledger;"
  $datasetPointerCount = Invoke-PsqlScalar -DatabaseUrl $DatabaseUrl -PsqlPath $psql -Sql "SELECT count(*)::text FROM dataset_slice WHERE current_version_id IS NOT NULL;"
  $publishedPointerCount = Invoke-PsqlScalar -DatabaseUrl $DatabaseUrl -PsqlPath $psql -Sql "SELECT count(*)::text FROM shop_current_published_snapshot;"
  $objectManifestSha256 = Invoke-PsqlScalar -DatabaseUrl $DatabaseUrl -PsqlPath $psql -Sql @"
SELECT encode(sha256(convert_to(COALESCE(string_agg(
  id::text || ':' || object_kind || ':' || ciphertext_sha256 || ':' || verification_status,
  E'\n' ORDER BY id), ''), 'UTF8')), 'hex')
FROM stored_object;
"@
  if (
    [int64]$migrationCount -lt 23 -or
    $walletViolations -ne '0' -or
    $datasetPointerViolations -ne '0' -or
    $publishedPointerViolations -ne '0' -or
    $objectReferenceViolations -ne '0' -or
    $objectManifestSha256 -notmatch '^[0-9a-f]{64}$'
  ) { throw $failureCode }

  $failureCode = 'RECOVERY_CHECKPOINT_WRITE_FAILED'
  $checkpointId = Invoke-PsqlScalar -DatabaseUrl $ControlDatabaseUrl -PsqlPath $psql -FailureCode $failureCode -Variables @{
    source_version = $sourceVersion
    target_kind = $targetKind
    target_reference_sha256 = $targetReferenceSha256
    manifest_sha256 = $manifestSha256
    manifest_hmac_sha256 = $manifestHmacSha256
    object_manifest_sha256 = $objectManifestSha256
    wallet_entry_count = $walletEntryCount
    dataset_pointer_count = $datasetPointerCount
    published_pointer_count = $publishedPointerCount
    object_count = $objectCount
  } -Sql @"
INSERT INTO recovery_checkpoint
  (checkpoint_kind, source_version, status, target_kind, target_reference_sha256,
   manifest_sha256, manifest_hmac_sha256, details, verified_at)
VALUES
  ('FULL_RESTORE_TEST', :'source_version', 'VERIFIED', :'target_kind', :'target_reference_sha256',
   :'manifest_sha256', :'manifest_hmac_sha256',
   jsonb_build_object(
     'validationVersion', 2,
     'objectManifestSha256', :'object_manifest_sha256',
     'walletEntryCount', :'wallet_entry_count',
     'datasetPointerCount', :'dataset_pointer_count',
     'publishedPointerCount', :'published_pointer_count',
     'objectCount', :'object_count'),
   clock_timestamp())
RETURNING id::text;
"@
  if (-not $checkpointId) { throw $failureCode }
  $checkpointRecorded = $true

  Write-Output ([pscustomobject]@{
    status = 'ok'
    restored = $resolvedDump
    target = '<redacted>'
    checkpointId = $checkpointId
    sourceVersion = $sourceVersion
    manifestSha256 = $manifestSha256
    objectManifestSha256 = $objectManifestSha256
    walletEntryCount = $walletEntryCount
    datasetPointerCount = $datasetPointerCount
    publishedPointerCount = $publishedPointerCount
    objectCount = $objectCount
    targetKind = $targetKind
  } | ConvertTo-Json -Compress)
}
catch {
  if (-not $checkpointRecorded) {
    try {
      Invoke-PsqlScalar -DatabaseUrl $ControlDatabaseUrl -PsqlPath $psql -FailureCode 'RECOVERY_FAILURE_RECORD_FAILED' -Variables @{
        source_version = $sourceVersion
        target_kind = $targetKind
        target_reference_sha256 = $targetReferenceSha256
        manifest_sha256 = $manifestSha256
        manifest_hmac_sha256 = $manifestHmacSha256
        error_code = $failureCode
      } -Sql @"
INSERT INTO recovery_checkpoint
  (checkpoint_kind, source_version, status, target_kind, target_reference_sha256,
   manifest_sha256, manifest_hmac_sha256, error_code, details)
VALUES
  ('FULL_RESTORE_TEST', :'source_version', 'FAILED', :'target_kind',
   NULLIF(:'target_reference_sha256', ''), NULLIF(:'manifest_sha256', ''),
   NULLIF(:'manifest_hmac_sha256', ''), :'error_code', jsonb_build_object('validationVersion', 2))
RETURNING id::text;
"@ | Out-Null
    } catch { }
  }
  throw $failureCode
}
finally {
  if ($runTemporary -and (Test-Path -LiteralPath $runTemporary)) {
    Remove-Item -LiteralPath $runTemporary -Recurse -Force -ErrorAction SilentlyContinue
  }
  [Array]::Clear($key, 0, $key.Length)
}
