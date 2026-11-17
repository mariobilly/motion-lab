# Creates the "Motion Lab" desktop shortcut (wscript + launch.vbs, custom icon).
$app = Split-Path -Parent $MyInvocation.MyCommand.Path
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$desk = [Environment]::GetFolderPath('Desktop')
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut((Join-Path $desk 'Motion Lab.lnk'))
$lnk.TargetPath = $wscript
$lnk.Arguments = '"' + (Join-Path $app 'launch.vbs') + '"'
$lnk.WorkingDirectory = $app
$lnk.IconLocation = (Join-Path $app 'motion-lab.ico') + ',0'
$lnk.Description = 'Motion Lab - layered, animated visual art from photos, videos and music'
$lnk.WindowStyle = 1
$lnk.Save()
Write-Output "Shortcut created: $(Join-Path $desk 'Motion Lab.lnk')"
