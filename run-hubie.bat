@echo off
REM Hubie Live - Windows supervisor loop (single-instance).
REM Node restarts dead children; this loop restarts Node if the process dies.
setlocal
cd /d "%~dp0"

REM Mutex via lock file (PID). Stale lock cleared if PID dead.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\hubie-single-instance.ps1" -Mode claim
if errorlevel 1 (
  echo [hubie] another Hubie supervisor already owns the lock - exit
  exit /b 2
)

if not exist node_modules (
  echo [hubie] installing dependencies
  call npm install
)

node scripts\bootstrap.mjs --check
if errorlevel 1 (
  echo [hubie] vendored binaries missing, downloading
  call node scripts\bootstrap.mjs
)

:loop
REM Re-claim / refuse if another node snuck in
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\hubie-single-instance.ps1" -Mode recheck
if errorlevel 1 (
  echo [hubie] another Hubie node detected before restart - exit
  exit /b 2
)
echo [hubie] starting %DATE% %TIME%
node src\index.js
echo [hubie] process exited, restarting in 5 seconds
timeout /t 5 /nobreak >nul
goto loop
