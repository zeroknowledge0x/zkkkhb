param(
  [ValidateSet('claim','recheck','release')]
  [string]$Mode = 'claim'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $MyInvocation.MyCommand.Path -Parent) -Parent
$lockPath = Join-Path $root 'logs\hubie.supervisor.lock'
if (-not (Test-Path (Join-Path $root 'logs'))) {
  New-Item -ItemType Directory -Path (Join-Path $root 'logs') | Out-Null
}

function Get-HubieNodes {
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and ($_.CommandLine -match 'src\\index')
  })
}

function Read-Lock {
  if (-not (Test-Path $lockPath)) { return $null }
  try {
    $raw = (Get-Content -Path $lockPath -TotalCount 1).Trim()
    $pidLock = [int]$raw
    $proc = Get-Process -Id $pidLock -ErrorAction SilentlyContinue
    if (-not $proc) { Remove-Item $lockPath -Force -ErrorAction SilentlyContinue; return $null }
    return $pidLock
  } catch {
    Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
    return $null
  }
}

$myPid = $PID
$parent = Get-CimInstance Win32_Process -Filter "ProcessId=$myPid" -ErrorAction SilentlyContinue
$ownerPid = $myPid
if ($parent -and $parent.ParentProcessId) {
  $pp = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $parent.ParentProcessId) -ErrorAction SilentlyContinue
  if ($pp -and $pp.Name -eq 'cmd.exe') { $ownerPid = $pp.ProcessId }
}

switch ($Mode) {
  'release' {
    $existing = Read-Lock
    if ($existing -and ($existing -eq $ownerPid -or $existing -eq $myPid)) {
      Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
    }
    exit 0
  }
  'claim' {
    $existing = Read-Lock
    $nodes = Get-HubieNodes
    if ($existing -and $existing -ne $ownerPid -and $existing -ne $myPid) {
      Write-Output ("[hubie] lock held by pid={0}" -f $existing)
      exit 1
    }
    if ($nodes.Count -gt 0) {
      Write-Output ("[hubie] node already live count={0}" -f $nodes.Count)
      exit 1
    }
    Set-Content -Path $lockPath -Value "$ownerPid" -Encoding ASCII
    exit 0
  }
  'recheck' {
    $existing = Read-Lock
    if (-not $existing) {
      Set-Content -Path $lockPath -Value "$ownerPid" -Encoding ASCII
      $existing = $ownerPid
    }
    if ($existing -ne $ownerPid -and $existing -ne $myPid) {
      Write-Output ("[hubie] lock held by pid={0}" -f $existing)
      exit 1
    }
    $nodes = Get-HubieNodes
    if ($nodes.Count -gt 0) {
      $foreign = @($nodes | Where-Object { $_.ParentProcessId -ne $ownerPid })
      if ($foreign.Count -gt 0) {
        Write-Output '[hubie] foreign node(s) live - refuse restart'
        exit 1
      }
    }
    Set-Content -Path $lockPath -Value "$ownerPid" -Encoding ASCII
    exit 0
  }
}
