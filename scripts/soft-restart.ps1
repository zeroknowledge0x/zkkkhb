# Soft-restart Hubie headed: kill supervisors + nodes, wait, start exactly one.
$ErrorActionPreference = 'Continue'
$root = Split-Path (Split-Path $MyInvocation.MyCommand.Path -Parent) -Parent
Set-Location $root

Write-Output '[soft-restart] stopping Hubie supervisors and nodes'

$cmds = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'cmd.exe' -and $_.CommandLine -and ($_.CommandLine -match 'start-hubie-headed|run-hubie\.bat')
})
foreach ($c in $cmds) {
  Write-Output ("[soft-restart] kill cmd pid={0}" -f $c.ProcessId)
  Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue
}

$nodes = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -and ($_.CommandLine -match 'src\\index')
})
foreach ($n in $nodes) {
  Write-Output ("[soft-restart] kill node pid={0}" -f $n.ProcessId)
  Stop-Process -Id $n.ProcessId -Force -ErrorAction SilentlyContinue
}

$lock = Join-Path $root 'logs\hubie.supervisor.lock'
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 6

$left = @(Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'src\\index') -or
  ($_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'start-hubie-headed|run-hubie\.bat')
})
if ($left.Count -gt 0) {
  Write-Output '[soft-restart] stubborn processes remain, force again'
  $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
}

Write-Output '[soft-restart] starting one headed Hubie'
$bat = Join-Path $root 'start-hubie-headed.bat'
$arg = '/c "' + $bat + '"'
Start-Process -FilePath 'cmd.exe' -ArgumentList $arg -WorkingDirectory $root -WindowStyle Minimized
Start-Sleep -Seconds 15

$hubies = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -match 'src\\index'
})
Write-Output ("[soft-restart] hubie_nodes={0}" -f $hubies.Count)
$hubies | ForEach-Object { Write-Output ("[soft-restart] node pid={0} ppid={1}" -f $_.ProcessId, $_.ParentProcessId) }
$sup = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'start-hubie-headed|run-hubie\.bat'
})
Write-Output ("[soft-restart] supervisor_cmds={0}" -f $sup.Count)
if (Test-Path $lock) { Write-Output ('[soft-restart] lock=' + (Get-Content $lock -Raw).Trim()) }
if ($hubies.Count -ne 1) {
  Write-Output '[soft-restart] WARNING expected exactly 1 node'
  exit 1
}
Write-Output '[soft-restart] ok'
exit 0
