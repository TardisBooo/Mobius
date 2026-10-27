param(
  [Parameter(Mandatory=$true)][string]$FixtureRoot,
  [Parameter(Mandatory=$true)][string]$Executable,
  [int]$Port = 9337,
  [ValidateSet('source', 'candidate', 'installed')][string]$Layer = 'candidate',
  [switch]$Visible
)
$ErrorActionPreference = 'Stop'
$fixturePath = (Resolve-Path -LiteralPath $FixtureRoot).Path
$binaryPath = (Resolve-Path -LiteralPath $Executable).Path
if (-not $fixturePath.StartsWith('E:\Workspaces\_verification\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Not an isolated verification directory' }
if (-not (Test-Path -LiteralPath (Join-Path $fixturePath 'vault\mobius.sqlite'))) { throw 'Seed the isolated fixture first' }
if ($Layer -eq 'installed' -and -not $binaryPath.StartsWith('E:\SOFTWARE\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Installed acceptance requires the maintained E:\SOFTWARE executable' }
if ($Port -lt 9300 -or $Port -gt 9399) { throw 'Use a dedicated verification port from 9300 to 9399' }
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw 'Verification port already in use' }
$env:MOBIUS_WORKSPACE = Join-Path $fixturePath 'workspace'
$env:MOBIUS_DATA_ROOT = Join-Path $fixturePath 'vault'
$env:MOBIUS_ARTIFACTS_ROOT = Join-Path $fixturePath 'artifacts'
$env:MOBIUS_CATALOG_ROOT = Join-Path $fixturePath 'catalog'
$env:MOBIUS_HARNESS_HOME = Join-Path $fixturePath 'harness'
$env:MOBIUS_CODEX_HOME = Join-Path $fixturePath 'harness\codex'
$env:PI_CODING_AGENT_DIR = Join-Path $fixturePath 'harness\pi'
$env:GROK_HOME = Join-Path $fixturePath 'harness\grok'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $fixturePath 'webview'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port"
$windowStyle = if ($Visible) { 'Normal' } else { 'Hidden' }
$stream = [IO.File]::OpenRead($binaryPath)
$sha256 = [Security.Cryptography.SHA256]::Create()
try { $binaryHash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
finally { $stream.Dispose(); $sha256.Dispose() }
$child = Start-Process -FilePath $binaryPath -WorkingDirectory $env:MOBIUS_WORKSPACE -WindowStyle $windowStyle -PassThru
$receipt = [ordered]@{
  ProcessId = $child.Id
  Executable = $binaryPath
  BinarySha256 = $binaryHash
  FileVersion = (Get-Item -LiteralPath $binaryPath).VersionInfo.FileVersion
  Fixture = $fixturePath
  Profile = $env:WEBVIEW2_USER_DATA_FOLDER
  Port = $Port
  Layer = $Layer
  StartedAt = $child.StartTime.ToUniversalTime().ToString('o')
}
$json = $receipt | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $fixturePath 'launch-receipt.json'), $json, [Text.UTF8Encoding]::new($false))
$json
