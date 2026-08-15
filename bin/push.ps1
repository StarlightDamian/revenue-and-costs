[CmdletBinding()]
param([switch]$DryRun)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workRoot = Join-Path $projectRoot '.work\push'
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
$mutex = [System.Threading.Mutex]::new($false, 'Local\RevenueCostsCodePush')
if (-not $mutex.WaitOne(0)) { throw 'DEPLOY_ALREADY_RUNNING' }

$releaseId = Get-Date -Format 'yyyyMMdd-HHmmss'
$runRoot = Join-Path $workRoot $releaseId
$stagedApp = Join-Path $runRoot 'app'
$dependencySource = Join-Path $runRoot 'dependency-source'
$appArchive = Join-Path $runRoot "release-$releaseId.tar.gz"
$dependencyArchive = Join-Path $runRoot "dependencies-$releaseId.tar.gz"
$knownHosts = Join-Path $runRoot 'known_hosts'
$hostKeyCandidate = Join-Path $runRoot 'host-key-candidate'
$askPass = Join-Path $runRoot 'askpass.cmd'
$remoteScript = Join-Path $PSScriptRoot 'push-remote.sh'

function Read-EnvFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "DEPLOY_CONFIG_MISSING:$Path" }
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { continue }
    $key = $Matches[1]
    $value = $Matches[2].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$key] = $value
  }
  return $values
}

function Require-Value([hashtable]$Values, [string]$Name) {
  if (-not $Values.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace([string]$Values[$Name])) {
    throw "DEPLOY_CONFIG_REQUIRED:$Name"
  }
  return [string]$Values[$Name]
}

function Assert-Match([string]$Name, [string]$Value, [string]$Pattern) {
  if ($Value -notmatch $Pattern) { throw "DEPLOY_CONFIG_INVALID:$Name" }
}

function Invoke-Native([string]$FilePath, [string[]]$ArgumentList) {
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) { throw "COMMAND_FAILED:${FilePath}:$LASTEXITCODE" }
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-DependencyManifestMatch([string]$ExpectedPath, [string]$ActualPath) {
  $program = @'
const fs = require("node:fs");
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const dependencyManifest = (path) => {
  const value = JSON.parse(fs.readFileSync(path, "utf8"));
  delete value.scripts;
  return canonical(value);
};
if (dependencyManifest(process.argv[2]) !== dependencyManifest(process.argv[3])) process.exit(1);
'@
  $program | & node.exe - $ExpectedPath $ActualPath
  if ($LASTEXITCODE -ne 0) { throw 'PINNED_DEPENDENCY_MANIFEST_MISMATCH' }
}

function Find-PinnedArtifact([string]$ExpectedHash) {
  $matches = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot '.work\artifacts') -File -Filter '*.tar.gz' |
    Where-Object { (Get-Sha256 $_.FullName) -ceq $ExpectedHash })
  if ($matches.Count -ne 1) { throw "PINNED_ARTIFACT_NOT_FOUND:$ExpectedHash" }
  return $matches[0].FullName
}

function Normalize-ArchiveEntry([string]$RawEntry) {
  $normalized = $RawEntry.Replace('\', '/')
  if ($normalized.StartsWith('/') -or $normalized -match '^[A-Za-z]:/' -or $normalized.StartsWith('//') -or
      $normalized -match '(^|/)\.\.(/|$)') {
    throw "ARCHIVE_UNSAFE_PATH:$RawEntry"
  }
  while ($normalized.StartsWith('./')) { $normalized = $normalized.Substring(2) }
  return $normalized
}

function Assert-Archive([string]$Archive, [ValidateSet('base', 'supplement', 'app', 'dependencies')] [string]$Kind) {
  $entries = @(& tar.exe -tzf $Archive)
  if ($LASTEXITCODE -ne 0 -or $entries.Count -eq 0) { throw "ARCHIVE_UNREADABLE:$Kind" }
  foreach ($raw in $entries) {
    $entry = Normalize-ArchiveEntry ([string]$raw)
    if ([string]::IsNullOrWhiteSpace($entry)) { continue }
    if ($entry -match '(^|/)\.env($|\.)|(^|/)nas/data(/|$)|(^|/)\.git(/|$)') {
      throw "ARCHIVE_FORBIDDEN_ENTRY:$entry"
    }
    $allowed = switch ($Kind) {
      'base' { $entry -match '^app(/.*)?/?$|^pnpm-store(/.*)?/?$|^tools(/.*)?/?$' }
      'supplement' { $entry -match '^pnpm-store(/.*)?/?$' }
      'app' { $entry -match '^app(/(dist|migrations)(/.*)?|/package\.json|/pnpm-lock\.yaml)?/?$' }
      'dependencies' { $entry -match '^(pnpm-store|tools)(/.*)?/?$|^(package\.json|pnpm-lock\.yaml)$' }
    }
    if (-not $allowed) { throw "ARCHIVE_NOT_ALLOWLISTED:${Kind}:$entry" }
  }
  $verbose = @(& tar.exe -tvzf $Archive)
  if ($LASTEXITCODE -ne 0 -or ($verbose | Where-Object { $_ -and $_[0] -notin @('-', 'd') })) {
    throw "ARCHIVE_NON_REGULAR_ENTRY:$Kind"
  }
}

foreach ($command in @('node.exe', 'pnpm.cmd', 'tar.exe', 'ssh.exe', 'scp.exe', 'ssh-keyscan.exe', 'ssh-keygen.exe')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "COMMAND_NOT_FOUND:$command" }
}
if ([System.IO.File]::ReadAllBytes($remoteScript) -contains 13) { throw 'REMOTE_SCRIPT_REQUIRES_LF' }

$config = Read-EnvFile (Join-Path $projectRoot '.env.local')
$hostName = Require-Value $config 'DEPLOY_HOST'
$sshPort = Require-Value $config 'DEPLOY_SSH_PORT'
$sshUser = Require-Value $config 'DEPLOY_SSH_USER'
$hostFingerprint = Require-Value $config 'DEPLOY_SSH_HOST_KEY_SHA256'
$remoteRoot = Require-Value $config 'DEPLOY_REVENUE_COSTS_ROOT'
$configRoot = Require-Value $config 'DEPLOY_REVENUE_COSTS_CONFIG_ROOT'
$nodeRoot = Require-Value $config 'DEPLOY_REVENUE_COSTS_NODE_CURRENT'
$apiService = Require-Value $config 'DEPLOY_REVENUE_COSTS_SERVICE_API'
$workerService = Require-Value $config 'DEPLOY_REVENUE_COSTS_SERVICE_WORKER'
$databaseName = Require-Value $config 'DEPLOY_REVENUE_COSTS_DATABASE'
$apiPort = Require-Value $config 'DEPLOY_REVENUE_COSTS_API_PORT'
$publicUrl = (Require-Value $config 'DEPLOY_PUBLIC_REQUESTED_URL').TrimEnd('/')
$credentialSourceRaw = Require-Value $config 'DEPLOY_CREDENTIAL_SOURCE'
$activeReleasePath = Require-Value $config 'DEPLOY_ACTIVE_RELEASE'
$activeArchiveSha = (Require-Value $config 'DEPLOY_ACTIVE_ARCHIVE_SHA256').ToLowerInvariant()
$baseArchiveSha = (Require-Value $config 'DEPLOY_STAGED_BASE_ARCHIVE_SHA256').ToLowerInvariant()
$supplementArchiveSha = (Require-Value $config 'DEPLOY_STAGED_LINUX_STORE_SUPPLEMENT_SHA256').ToLowerInvariant()

if ($activeReleasePath -notmatch '(?:^|/)(\d{8}-\d{6})(?:/app)?$') { throw 'DEPLOY_CONFIG_INVALID:DEPLOY_ACTIVE_RELEASE' }
$activeRelease = $Matches[1]
Assert-Match 'DEPLOY_HOST' $hostName '^[A-Za-z0-9.-]+$'
Assert-Match 'DEPLOY_SSH_PORT' $sshPort '^\d{1,5}$'
Assert-Match 'DEPLOY_SSH_USER' $sshUser '^[a-z_][a-z0-9_-]*$'
Assert-Match 'DEPLOY_SSH_HOST_KEY_SHA256' $hostFingerprint '^SHA256:[A-Za-z0-9+/]+={0,2}$'
Assert-Match 'DEPLOY_REVENUE_COSTS_ROOT' $remoteRoot '^/[A-Za-z0-9._/-]+$'
Assert-Match 'DEPLOY_REVENUE_COSTS_CONFIG_ROOT' $configRoot '^/[A-Za-z0-9._/-]+$'
Assert-Match 'DEPLOY_REVENUE_COSTS_NODE_CURRENT' $nodeRoot '^/[A-Za-z0-9._/-]+$'
Assert-Match 'DEPLOY_REVENUE_COSTS_SERVICE_API' $apiService '^[A-Za-z0-9_.@-]+\.service$'
Assert-Match 'DEPLOY_REVENUE_COSTS_SERVICE_WORKER' $workerService '^[A-Za-z0-9_.@-]+\.service$'
Assert-Match 'DEPLOY_REVENUE_COSTS_DATABASE' $databaseName '^[a-z_][a-z0-9_]*$'
Assert-Match 'DEPLOY_REVENUE_COSTS_API_PORT' $apiPort '^\d{2,5}$'
Assert-Match 'DEPLOY_PUBLIC_REQUESTED_URL' $publicUrl '^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$'
foreach ($hash in @($activeArchiveSha, $baseArchiveSha, $supplementArchiveSha)) {
  if ($hash -notmatch '^[a-f0-9]{64}$') { throw 'DEPLOY_CONFIG_INVALID:ARCHIVE_SHA256' }
}
if ([int]$sshPort -gt 65535 -or [int]$apiPort -gt 65535) { throw 'DEPLOY_CONFIG_INVALID:PORT' }
if ($remoteRoot -ne '/opt/revenue-costs') { throw 'DEPLOY_CONFIG_INVALID:DEPLOY_REVENUE_COSTS_ROOT' }
if ($credentialSourceRaw -notmatch '^[A-Za-z]:\\' -or $credentialSourceRaw.StartsWith('\\')) {
  throw 'DEPLOY_CREDENTIAL_SOURCE_MUST_BE_LOCAL_ABSOLUTE_PATH'
}
$credentialSource = [System.IO.Path]::GetFullPath($credentialSourceRaw)
if ($credentialSource.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'DEPLOY_CREDENTIAL_SOURCE_MUST_BE_EXTERNAL'
}
if (-not (Test-Path -LiteralPath $credentialSource -PathType Leaf)) { throw 'DEPLOY_CREDENTIAL_SOURCE_MISSING' }

$activeArchive = Join-Path $projectRoot ".work\deploy\release-$activeRelease.tar.gz"
if (-not (Test-Path -LiteralPath $activeArchive -PathType Leaf) -or (Get-Sha256 $activeArchive) -cne $activeArchiveSha) {
  throw 'DEPLOY_ACTIVE_ARCHIVE_HASH_MISMATCH'
}
$baseArchive = Find-PinnedArtifact $baseArchiveSha
$supplementArchive = Find-PinnedArtifact $supplementArchiveSha
Assert-Archive $baseArchive 'base'
Assert-Archive $supplementArchive 'supplement'

New-Item -ItemType Directory -Path $stagedApp, $dependencySource -Force | Out-Null
Write-Host '[1/5] Run local release gate: pnpm verify:release'
Invoke-Native 'pnpm.cmd' @('verify:release')

Write-Host '[2/5] Build allowlisted app and pinned Linux offline-store archives'
foreach ($name in @('dist', 'migrations')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination (Join-Path $stagedApp $name) -Recurse
}
foreach ($name in @('package.json', 'pnpm-lock.yaml')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination (Join-Path $stagedApp $name)
}
Invoke-Native 'tar.exe' @('-xzf', $baseArchive, '-C', $dependencySource)
Invoke-Native 'tar.exe' @('-xzf', $supplementArchive, '-C', $dependencySource)
$pinnedPackage = Join-Path $dependencySource 'app\package.json'
$currentPackage = Join-Path $projectRoot 'package.json'
$pinnedLock = Join-Path $dependencySource 'app\pnpm-lock.yaml'
$currentLock = Join-Path $projectRoot 'pnpm-lock.yaml'
if ((Get-Sha256 $pinnedLock) -cne (Get-Sha256 $currentLock)) { throw 'PINNED_DEPENDENCY_LOCK_MISMATCH' }
Assert-DependencyManifestMatch $pinnedPackage $currentPackage
Copy-Item -LiteralPath $currentPackage -Destination (Join-Path $dependencySource 'package.json')
Copy-Item -LiteralPath $currentLock -Destination (Join-Path $dependencySource 'pnpm-lock.yaml')
$dependencyApp = [System.IO.Path]::GetFullPath((Join-Path $dependencySource 'app'))
if (-not $dependencyApp.StartsWith($runRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'UNSAFE_STAGING_PATH'
}
Remove-Item -LiteralPath $dependencyApp -Recurse -Force
$pnpmMetadata = Get-Content -LiteralPath (Join-Path $dependencySource 'tools\pnpm-min\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$pnpmMetadata.version -ne '9.15.4') { throw 'PNPM_BASELINE_VERSION_MISMATCH' }

Invoke-Native 'tar.exe' @('-czf', $appArchive, '-C', $runRoot, 'app')
Invoke-Native 'tar.exe' @('-czf', $dependencyArchive, '-C', $dependencySource,
  'package.json', 'pnpm-lock.yaml', 'pnpm-store', 'tools')
Assert-Archive $appArchive 'app'
Assert-Archive $dependencyArchive 'dependencies'
$appSha = Get-Sha256 $appArchive
$dependencySha = Get-Sha256 $dependencyArchive

Write-Host '[3/5] Release inputs validated'
Write-Host "  release: $releaseId"
Write-Host "  target:  $sshUser@$hostName`:$sshPort $remoteRoot/releases/$releaseId/app"
Write-Host "  app:     $appSha"
Write-Host "  deps:    $dependencySha"
Write-Host '  data:    excludes workspace env/data/tests/node_modules/dumps; allows only reviewed append-only migrations after backup'
if ($DryRun) {
  Write-Host '[DRY-RUN] Verify, packaging, hashing, and denylist scan passed. Remote SSH/SCP calls: 0.'
  exit 0
}

$confirmation = Read-Host 'Type PUSH to connect and switch the remote code release'
if ($confirmation -cne 'PUSH') { throw 'DEPLOY_CANCELLED' }
$credentials = Read-EnvFile $credentialSource
$sshPassword = Require-Value $credentials 'DEPLOY_SSH_PASSWORD'

try {
  Write-Host '[4/5] Pin the exact host key and upload .partial artifacts'
  $scanOutput = @(& ssh-keyscan.exe -p $sshPort $hostName 2>$null)
  if ($LASTEXITCODE -ne 0 -or $scanOutput.Count -eq 0) { throw 'SSH_HOST_KEY_SCAN_FAILED' }
  $matchingKeys = @()
  foreach ($keyLine in $scanOutput) {
    [System.IO.File]::WriteAllText($hostKeyCandidate, [string]$keyLine + "`n", [System.Text.Encoding]::ASCII)
    $fingerprintLine = [string](& ssh-keygen.exe -E sha256 -lf $hostKeyCandidate)
    if ($LASTEXITCODE -ne 0) { continue }
    if ($fingerprintLine -match '\s(SHA256:[A-Za-z0-9+/]+={0,2})\s' -and $Matches[1] -ceq $hostFingerprint) {
      $matchingKeys += [string]$keyLine
    }
  }
  if ($matchingKeys.Count -eq 0) { throw 'SSH_HOST_KEY_FINGERPRINT_MISMATCH' }
  [System.IO.File]::WriteAllLines($knownHosts, [string[]]$matchingKeys, [System.Text.Encoding]::ASCII)
  [System.IO.File]::WriteAllText($askPass, '@echo off' + "`r`n" +
    'powershell.exe -NoLogo -NoProfile -Command "[Console]::Out.WriteLine($env:REVENUE_COSTS_DEPLOY_PASSWORD)"' + "`r`n",
    [System.Text.Encoding]::ASCII)
  $env:REVENUE_COSTS_DEPLOY_PASSWORD = $sshPassword
  $env:SSH_ASKPASS = $askPass
  $env:SSH_ASKPASS_REQUIRE = 'force'
  $env:DISPLAY = 'codex-deploy:0'
  $strictOptions = @('-o', "UserKnownHostsFile=$knownHosts", '-o', 'GlobalKnownHostsFile=NUL',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'BatchMode=no',
    '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1')
  $sshOptions = @('-p', $sshPort) + $strictOptions
  $scpOptions = @('-P', $sshPort) + $strictOptions
  $target = "$sshUser@$hostName"
  $incoming = "$remoteRoot/incoming"
  Invoke-Native 'ssh.exe' ($sshOptions + @($target, "umask 077; mkdir -p '$incoming'"))
  Invoke-Native 'scp.exe' ($scpOptions + @($appArchive, "$target`:$incoming/release-$releaseId.tar.gz.partial"))
  Invoke-Native 'scp.exe' ($scpOptions + @($dependencyArchive, "$target`:$incoming/dependencies-$releaseId.tar.gz.partial"))
  Invoke-Native 'scp.exe' ($scpOptions + @($remoteScript, "$target`:$incoming/push-$releaseId.sh.partial"))

  Write-Host '[5/5] Remote backup, atomic switch, health checks, and automatic code rollback'
  $remoteCommand = "chmod 700 '$incoming/push-$releaseId.sh.partial' && bash '$incoming/push-$releaseId.sh.partial' '$releaseId' '$incoming/release-$releaseId.tar.gz.partial' '$appSha' '$incoming/dependencies-$releaseId.tar.gz.partial' '$dependencySha' '$remoteRoot' '$configRoot' '$nodeRoot' '$apiService' '$workerService' '$databaseName' '$apiPort' '$publicUrl'"
  Invoke-Native 'ssh.exe' ($sshOptions + @($target, $remoteCommand))
  Write-Host "Release complete: $remoteRoot/releases/$releaseId/app"
} finally {
  Remove-Item Env:REVENUE_COSTS_DEPLOY_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:SSH_ASKPASS -ErrorAction SilentlyContinue
  Remove-Item Env:SSH_ASKPASS_REQUIRE -ErrorAction SilentlyContinue
  Remove-Item Env:DISPLAY -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $askPass) { Remove-Item -LiteralPath $askPass -Force }
  $sshPassword = $null
}
