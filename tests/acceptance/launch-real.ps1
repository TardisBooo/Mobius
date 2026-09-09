param([string]$Executable = 'E:\Workspaces\Mobius-20260907\target\debug\mobius-desktop.exe')
$ErrorActionPreference = 'Stop'
$runRoot = 'E:\Workspaces\Mobius-Verification-20260908-final'
$env:MOBIUS_WORKSPACE = 'E:\Workspaces\Mobius-Verification-20260908-real\workspace'
$env:MOBIUS_DATA_ROOT = 'D:\DataVault\Mobius-Verification-20260908-final'
$env:MOBIUS_ARTIFACTS_ROOT = 'D:\AcceptedArtifacts\Mobius-Verification-20260908-final'
$env:MOBIUS_CATALOG_ROOT = 'D:\Catalog\Mobius-Verification-20260908-final'
$env:MOBIUS_HARNESS_HOME = "$runRoot\harness-home"
$env:MOBIUS_CODEX_HOME = "$runRoot\harness-home\codex"
$env:PI_CODING_AGENT_SESSION_DIR = "$runRoot\harness-home\.pi\agent\sessions"
$env:GROK_HOME = "$runRoot\harness-home\.grok"
$env:WEBVIEW2_USER_DATA_FOLDER = "$runRoot\webview"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9351'
foreach ($directory in @($runRoot, $env:MOBIUS_DATA_ROOT, $env:MOBIUS_ARTIFACTS_ROOT, $env:MOBIUS_CATALOG_ROOT, $env:MOBIUS_CODEX_HOME, $env:PI_CODING_AGENT_SESSION_DIR, $env:GROK_HOME)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
# Reuse only the configured model definitions. Never print credential values.
if (-not (Test-Path -LiteralPath "$env:GROK_HOME\config.toml")) {
  Copy-Item -LiteralPath 'C:\Users\MSI-NB\.grok\config.toml' -Destination "$env:GROK_HOME\config.toml"
}
$piSource = 'E:\Workspaces\Mobius-Verification-20260908-real\harness-home\.pi\agent\sessions\2026-09-08T12-19-50-705Z_01a080f5-d930-7c38-87a5-9bab3ba65b43.jsonl'
$piDestination = Join-Path $env:PI_CODING_AGENT_SESSION_DIR (Split-Path $piSource -Leaf)
if (-not (Test-Path -LiteralPath $piDestination)) { Copy-Item -LiteralPath $piSource -Destination $piDestination }
$grokParent = 'E%3A%5CWorkspaces%5CMobius-Verification-20260908-real%5Cworkspace'
$grokId = '01a080f5-f309-7cc2-a0f8-8c25f74b9b74'
$grokDestination = Join-Path $env:GROK_HOME "sessions\$grokParent"
New-Item -ItemType Directory -Path $grokDestination -Force | Out-Null
if (-not (Test-Path -LiteralPath "$grokDestination\$grokId")) { Copy-Item -LiteralPath "C:\Users\MSI-NB\.grok\sessions\$grokParent\$grokId" -Destination $grokDestination -Recurse }
Start-Process -FilePath $Executable -WorkingDirectory $env:MOBIUS_WORKSPACE -WindowStyle Hidden
