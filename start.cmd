@echo off
setlocal
cd /d "%~dp0"
for %%I in ("%~dp0.") do set "FOLDER=%%~nxI"
title Agent Ops - %FOLDER%

set "PORT=8778"
set "URL=http://127.0.0.1:%PORT%"

rem ---- a server is already listening? just open the browser ----
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
echo.
echo   Port %PORT% already has a server running.
echo   ==================================================
echo   this script folder : %CD%
echo   the page comes from whichever folder started that server.
echo.
set "KILL="
set /p "KILL=Stop it and start THIS folder instead? [y/N] "
if /i not "%KILL%"=="y" goto openonly
echo.
echo   stopping the old server...
powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if($c){ foreach($x in $c){ Stop-Process -Id $x.OwningProcess -Force -ErrorAction SilentlyContinue } }" 2>nul
ping -n 2 127.0.0.1 >nul
goto run

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
