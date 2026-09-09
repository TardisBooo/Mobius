param([ValidateSet('install-old','install-new','upgrade','uninstall')][string]$Stage)
$ErrorActionPreference='Stop'
$destination='E:\Workspaces\MyDesk\production\lifecycle-verification-20260908'
$evidence='D:\AcceptedArtifacts\Mobius-Verification-20260908-final'
$productName='M'+[char]0xD6+'BIUS'
$registry="HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$productName"
$registered=Get-ItemProperty -LiteralPath $registry -ErrorAction SilentlyContinue
if ($registered -and $registered.InstallLocation.Trim('"') -ne $destination) { throw 'Refusing to touch a non-test installation' }
if ($Stage -eq 'install-old') {
  if ($registered -or (Test-Path -LiteralPath $destination)) { throw 'Test installation already exists' }
  $setup="E:\Workspaces\MyDesk\production\MOBIUS-0.3.7-20260908\${productName}_0.3.7_x64-setup.exe"
} elseif ($Stage -eq 'install-new') {
  if ($registered -or (Test-Path -LiteralPath $destination)) { throw 'Clean install requires absent test destination' }
  $setup="E:\Workspaces\MyDesk\production\MOBIUS-0.3.8-20260908\${productName}_0.3.8_x64-setup.exe"
} elseif ($Stage -eq 'upgrade') {
  if (-not $registered) { throw 'Previous test installation is required' }
  $setup="E:\Workspaces\MyDesk\production\MOBIUS-0.3.8-20260908\${productName}_0.3.8_x64-setup.exe"
} else {
  if (-not $registered) { throw 'No test installation registered' }
  $setup=Join-Path $destination 'uninstall.exe'
}
if ([IO.Path]::GetFullPath($destination) -ne $destination -or -not $destination.StartsWith('E:\Workspaces\MyDesk\production\')) { throw 'Invalid installation destination' }
if ($Stage -eq 'uninstall') { $arguments='/S' } else { $arguments="/S /D=$destination" }
$preservedRoots=@('D:\DataVault\Mobius-Verification-20260908-final','E:\Workspaces\Mobius-Verification-20260908-final\harness-home','.\tests')
function Get-PreservedInventory {
  foreach($root in $preservedRoots) {
    Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object FullName | ForEach-Object {
      [pscustomobject]@{path=$_.FullName;bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName).Hash}
    }
  }
}
$before=Get-PreservedInventory | ConvertTo-Json -Depth 4 -Compress
$process=Start-Process -FilePath $setup -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
$after=Get-PreservedInventory | ConvertTo-Json -Depth 4 -Compress
$record=[ordered]@{stage=$Stage;timestamp=(Get-Date).ToUniversalTime().ToString('o');installer=$setup;destination=$destination;exitCode=$process.ExitCode;binaryExists=(Test-Path -LiteralPath "$destination\mobius-desktop.exe");registered=(Test-Path -LiteralPath $registry)}
$record.preservedDataUnchanged=($before -eq $after)
$before | Set-Content -LiteralPath "$evidence\installer-$Stage-inventory-before.json" -Encoding UTF8
$after | Set-Content -LiteralPath "$evidence\installer-$Stage-inventory-after.json" -Encoding UTF8
if ($record.binaryExists) { $record.binarySha256=(Get-FileHash -LiteralPath "$destination\mobius-desktop.exe").Hash; $record.fileVersion=(Get-Item -LiteralPath "$destination\mobius-desktop.exe").VersionInfo.FileVersion }
$record | ConvertTo-Json | Set-Content -LiteralPath "$evidence\installer-$Stage.json" -Encoding UTF8
$record | ConvertTo-Json
if ($process.ExitCode -ne 0) { throw 'Installer returned nonzero exit' }
if (-not $record.preservedDataUnchanged) { throw 'Installer changed preserved data' }
