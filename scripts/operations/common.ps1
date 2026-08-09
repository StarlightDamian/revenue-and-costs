Set-StrictMode -Version Latest

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $sha.Dispose() }
}

function Get-TextSha256Hex {
  param([Parameter(Mandatory = $true)][string]$Value)
  return Get-Sha256Hex ([System.Text.Encoding]::UTF8.GetBytes($Value))
}

function Get-FileSha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-ManifestKey {
  param([Parameter(Mandatory = $true)][string]$KeyFile)
  $resolved = [System.IO.Path]::GetFullPath($KeyFile)
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw 'MANIFEST_KEY_FILE_MISSING' }
  try { $key = [Convert]::FromBase64String([System.IO.File]::ReadAllText($resolved).Trim()) }
  catch { throw 'MANIFEST_KEY_INVALID' }
  if ($key.Length -lt 32) { throw 'MANIFEST_KEY_TOO_SHORT' }
  return ,$key
}

function Get-HmacSha256Hex {
  param(
    [Parameter(Mandatory = $true)][byte[]]$Key,
    [Parameter(Mandatory = $true)][byte[]]$Bytes
  )
  $hmac = [System.Security.Cryptography.HMACSHA256]::new($Key)
  try { return (($hmac.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $hmac.Dispose() }
}

function Test-FixedHexEqual {
  param(
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Actual
  )
  if ($Expected -notmatch '^[0-9a-fA-F]{64}$' -or $Actual -notmatch '^[0-9a-fA-F]{64}$') { return $false }
  $difference = 0
  for ($index = 0; $index -lt 32; $index += 1) {
    $left = [Convert]::ToByte($Expected.Substring($index * 2, 2), 16)
    $right = [Convert]::ToByte($Actual.Substring($index * 2, 2), 16)
    $difference = $difference -bor ($left -bxor $right)
  }
  return $difference -eq 0
}

function Write-AtomicBytes {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][byte[]]$Bytes
  )
  $resolved = [System.IO.Path]::GetFullPath($Path)
  if (Test-Path -LiteralPath $resolved) { throw 'OUTPUT_ALREADY_EXISTS' }
  $partial = "$resolved.partial-$PID-$([guid]::NewGuid().ToString('N'))"
  try {
    [System.IO.File]::WriteAllBytes($partial, $Bytes)
    [System.IO.File]::Move($partial, $resolved)
  }
  finally {
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
  }
}

function Get-DatabaseIdentity {
  param([Parameter(Mandatory = $true)][string]$DatabaseUrl)
  try { $uri = [Uri]$DatabaseUrl } catch { throw 'DATABASE_URL_INVALID' }
  if ($uri.Scheme -notin @('postgres', 'postgresql') -or -not $uri.Host -or $uri.AbsolutePath.Length -lt 2) {
    throw 'DATABASE_URL_INVALID'
  }
  $port = if ($uri.IsDefaultPort) { 5432 } else { $uri.Port }
  $database = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
  return "$($uri.Host.ToLowerInvariant()):$port/$database"
}

function Invoke-PostgresNative {
  param(
    [Parameter(Mandatory = $true)][string]$DatabaseUrl,
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureCode,
    [string]$InputText
  )
  try { $uri = [Uri]$DatabaseUrl } catch { throw 'DATABASE_URL_INVALID' }
  if ($uri.Scheme -notin @('postgres', 'postgresql') -or -not $uri.Host -or $uri.AbsolutePath.Length -lt 2) {
    throw 'DATABASE_URL_INVALID'
  }
  $userInfo = $uri.UserInfo.Split(':', 2)
  if ($userInfo.Count -lt 1 -or -not $userInfo[0]) { throw 'DATABASE_URL_INVALID' }
  $values = [ordered]@{
    PGHOST = $uri.Host
    PGPORT = $(if ($uri.IsDefaultPort) { '5432' } else { $uri.Port.ToString() })
    PGUSER = [Uri]::UnescapeDataString($userInfo[0])
    PGPASSWORD = $(if ($userInfo.Count -eq 2) { [Uri]::UnescapeDataString($userInfo[1]) } else { '' })
    PGDATABASE = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
    PGAPPNAME = 'revenue-costs-recovery-script'
  }
  $previous = @{}
  foreach ($name in $values.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $values[$name], 'Process')
  }
  try {
    $output = if ($PSBoundParameters.ContainsKey('InputText')) {
      $InputText | & $Executable @Arguments
    } else {
      & $Executable @Arguments
    }
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "$FailureCode`_EXIT_$exitCode" }
    return $output
  }
  finally {
    foreach ($name in $values.Keys) {
      [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
  }
}

function Invoke-PsqlScalar {
  param(
    [Parameter(Mandatory = $true)][string]$DatabaseUrl,
    [Parameter(Mandatory = $true)][string]$PsqlPath,
    [Parameter(Mandatory = $true)][string]$Sql,
    [hashtable]$Variables = @{},
    [string]$FailureCode = 'PSQL_FAILED'
  )
  $arguments = @('-X', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--quiet', '--tuples-only', '--no-align')
  foreach ($name in @($Variables.Keys | Sort-Object)) {
    $value = [string]$Variables[$name]
    if ($value.Contains("`0")) { throw 'PSQL_VARIABLE_INVALID' }
    $arguments += @('--set', "$name=$value")
  }
  $output = Invoke-PostgresNative -DatabaseUrl $DatabaseUrl -Executable $PsqlPath -Arguments $arguments -FailureCode $FailureCode -InputText $Sql
  return (($output | Out-String).Trim())
}

function Invoke-BackupCrypto {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('encrypt', 'decrypt')][string]$Operation,
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$KeyFile,
    [Parameter(Mandatory = $true)][hashtable]$Context,
    [Parameter(Mandatory = $true)][string]$CryptoScript
  )
  $names = @('BACKUP_ENCRYPTION_KEY_FILE', 'BACKUP_ENCRYPTION_CONTEXT')
  $previous = @{}
  foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  try {
    [Environment]::SetEnvironmentVariable('BACKUP_ENCRYPTION_KEY_FILE', $KeyFile, 'Process')
    [Environment]::SetEnvironmentVariable('BACKUP_ENCRYPTION_CONTEXT', ($Context | ConvertTo-Json -Compress), 'Process')
    $output = & node $CryptoScript $Operation $InputPath $OutputPath
    if ($LASTEXITCODE -ne 0) { throw "BACKUP_CRYPTO_$($Operation.ToUpperInvariant())_FAILED" }
    try { return (($output | Out-String).Trim() | ConvertFrom-Json) }
    catch { throw 'BACKUP_CRYPTO_OUTPUT_INVALID' }
  }
  finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
  }
}
