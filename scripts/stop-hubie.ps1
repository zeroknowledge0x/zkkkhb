# Stop the Hubie stream without restarting it. Used by the Telegram bot.
$ErrorActionPreference = 'Continue'
$root = Split-Path (Split-Path $MyInvocation.MyCommand.Path -Parent) -Parent
Set-Location $root
$sup = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'start-hubie-headed|run-hubie' }
foreach ($p in $sup) { Write-Output ("stop supervisor pid={0}" -f $p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
$node = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'src.index' }
foreach ($p in $node) { Write-Output ("stop node pid={0}" -f $p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
$ff = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ffmpeg.exe' }
foreach ($p in $ff) { Write-Output ("stop ffmpeg pid={0}" -f $p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item (Join-Path $root 'logs\hubie.supervisor.lock') -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$left = (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'src.index' } | Measure-Object).Count
Write-Output ("remaining_nodes={0}" -f $left)
if ($left -eq 0) { Write-Output 'stopped' } else { Write-Output 'WARNING: node still running' }
