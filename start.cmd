@echo off
setlocal
cd /d "%~dp0"
for %%I in ("%~dp0.") do set "FOLDER=%%~nxI"
title Agent Ops - %FOLDER%

rem ---- PORT / TOKEN come from the environment; stop.cmd uses the same PORT ----
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
  echo       Use PORT=1..65535, or start dsh-bridge.mjs directly when you need PORT=0.
  exit /b 2
)
if errorlevel 1 (
  echo   [x] PORT must be a decimal number 1..65535.
  exit /b 1
)
rem [PORT-CHECK-END]

rem URL must match the port above and carry the token when one is configured
set "TOKEN_ENC="
if defined TOKEN for /f "usebackq delims=" %%T in (`powershell -NoProfile -Command "[uri]::EscapeDataString($env:TOKEN)"`) do set "TOKEN_ENC=%%T"
set "URL=http://127.0.0.1:%PORT%"
if defined TOKEN_ENC set "URL=%URL%/?token=%TOKEN_ENC%"

rem ---- a server is already listening? identify it before touching anything ----
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient;try{$c.Connect('127.0.0.1',%PORT%);exit 0}catch{exit 1}" >nul 2>nul
if not errorlevel 1 goto already

:run
rem ---- find node: portable .\node\node.exe first, then PATH ----
set "NODE=%~dp0node\node.exe"
if exist "%NODE%" goto havenode
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 goto nonode
:havenode

echo.
echo   Agent Ops dashboard
echo   ==================================================
echo   folder : %CD%
echo   URL    : %URL%
echo   ==================================================
echo   Browser opens automatically once the server is ready.
echo.
echo   TO STOP: close this window, or double-click stop.cmd
echo   Keep this window open while you use the dashboard.
echo.
set "OPEN=1"
"%NODE%" dsh-bridge.mjs
echo.
echo   server stopped.
pause
exit /b 0

:already
rem Instance identity: servedFrom + epoch from the server's own HTTP state. A PID or a
rem command line containing dsh-bridge.mjs alone is not proof that it is THIS folder's server.
set "LISTEN_ID="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$u='http://127.0.0.1:%PORT%/api/agent-ops/state'; if($env:TOKEN){$u += '?token=' + [uri]::EscapeDataString($env:TOKEN)}; try{ $d=Invoke-RestMethod $u -TimeoutSec 3; if($d.epoch -and $d.servedFrom){ Write-Output ('OK ' + $d.servedFrom) } else { Write-Output 'NOIDENTITY' } }catch{ Write-Output 'NOIDENTITY' }"`) do set "LISTEN_ID=%%I"
if not defined LISTEN_ID goto already_other
if /i not "%LISTEN_ID:~0,3%"=="OK " goto already_other
if /i not "%LISTEN_ID:~3%"=="%FOLDER%" goto already_other

echo.
echo   Port %PORT% already has an Agent Ops server from THIS folder: %FOLDER%
echo   ==================================================
echo   this script folder : %CD%
echo.
set "KILL="
set /p "KILL=Stop it and start THIS folder instead? [y/N] "
if /i not "%KILL%"=="y" goto openonly
echo.
echo   stopping the old server (verified instance)...
powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if($c){ foreach($x in $c){ $p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $x.OwningProcess) -ErrorAction SilentlyContinue; if($p -and $p.CommandLine -match 'dsh-bridge\.mjs'){ Stop-Process -Id $x.OwningProcess -Force -ErrorAction SilentlyContinue } } }" 2>nul
ping -n 2 127.0.0.1 >nul
goto run

:already_other
echo.
echo   Port %PORT% is already in use, but it is NOT this folder's Agent Ops server
echo   (servedFrom mismatch, missing epoch, or no HTTP identity).
echo   ==================================================
echo   this script folder : %CD%
echo   Not stopping it. Close it manually or choose another PORT.
echo.
exit /b 2

:openonly
echo.
echo   opening browser only.
start "" "%URL%"
ping -n 2 127.0.0.1 >nul
exit /b 0

:nonode
echo.
echo   [x] Node.js not found.
echo.
echo     Install Node.js 18+ from https://nodejs.org
echo     (DSH data source needs Node 23.8+ for zstd; Codex / Claude work on 18+)
echo.
echo     Or drop a portable node.exe into:  %~dp0node\node.exe
echo.
pause
exit /b 1
