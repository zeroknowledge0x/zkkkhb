@echo off
cd /d "%~dp0"
set HUBIE_HEADED=1
REM Desktop grab (gdigrab) fails on this RDP with ffmpeg exit 4294967274, so the working
REM path is the CDP screencast + capture pump. Set this to desktop only on a bare console.
set CAPTURE_MODE=screencast
set PATH=C:\Program Files\nodejs;%PATH%
REM Keep Windows session on console so ffmpeg gdigrab can capture (Disc RDP = error 5)
for /f "skip=1 tokens=3" %%i in ('query user Administrator 2^>nul') do tscon %%i /dest:console >nul 2>&1
call run-hubie.bat
