@echo off
setlocal
cd /d "%~dp0"
for %%I in ("%~dp0.") do set "FOLDER=%%~nxI"
title Agent Ops - stop
if not defined PORT set "PORT=8778"

rem [PORT-CHECK-BEGIN] PORT must be a decimal 1..65535. PORT=0 is rejected on purpose:
rem this script cannot know which port the system would assign, so it must not treat 0 as
rem the listening port. Nothing is echoed before validation, so a hostile value cannot inject.
powershell -NoProfile -Command "$v=$env:PORT; if($v -notmatch '^[0-9]+$'){exit 1}; $n=0; [int]::TryParse($v,[ref]$n) | Out-Null; if($v -match '^0'){ if($n -eq 0){exit 2} else {exit 3} }; if($n -lt 1 -or $n -gt 65535){exit 4}; exit 0" >nul 2>nul
if errorlevel 4 (
  echo   [x] PORT is out of range: must be 1..65535.
  exit /b 4
)
if errorlevel 3 (
  echo   [x] PORT has leading zeros; use a plain decimal number 1..65535.
  exit /b 3
)
if errorlevel 2 (
  echo   [x] PORT=0 is not supported by this script: it cannot know the real port.
  exit /b 2
)
if errorlevel 1 (
  echo   [x] PORT must be a decimal number 1..65535.
  exit /b 1
)
rem [PORT-CHECK-END]

echo.
echo   Agent Ops - stopping the server on port %PORT%
echo   ==================================================

rem ---- instance identity comes from the server itself: servedFrom + epoch ----
rem A PID or a command line containing dsh-bridge.mjs alone is not proof that this port
rem belongs to THIS folder. If identity does not match, this script must not kill anything.
set "LISTEN_ID="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$u='http://127.0.0.1:%PORT%/api/agent-ops/state'; if($env:TOKEN){$u += '?token=' + [uri]::EscapeDataString($env:TOKEN)}; try{ $d=Invoke-RestMethod $u -TimeoutSec 3; if($d.epoch -and $d.servedFrom){ Write-Output ('OK ' + $d.servedFrom) } else { Write-Output 'NOIDENTITY' } }catch{ Write-Output 'NOIDENTITY' }"`) do set "LISTEN_ID=%%I"
if not defined LISTEN_ID goto notours
if /i not "%LISTEN_ID:~0,3%"=="OK " goto notours
if /i not "%LISTEN_ID:~3%"=="%FOLDER%" goto notours

powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if($c){ foreach($x in $c){ $p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $x.OwningProcess) -ErrorAction SilentlyContinue; if($p -and $p.CommandLine -match 'dsh-bridge\.mjs'){ Stop-Process -Id $x.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Host '  stopped our bridge (servedFrom verified).' } else { Write-Host ('  port held by another program (' + $x.OwningProcess + '), NOT killing it.') } } } else { Write-Host '  nothing was running on this port.' }"
echo.
echo   press any key to close
pause >nul
exit /b 0

:notours
echo.
echo   [x] This port does NOT serve the Agent Ops instance from this folder.
echo   ==================================================
echo   this script folder : %CD%
echo   servedFrom check failed (different folder, no epoch, or not an Agent Ops server).
echo   NOT stopping anything. Use the correct PORT, or close it from its own window.
echo.
pause >nul
exit /b 2
