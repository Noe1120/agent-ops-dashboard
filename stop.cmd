@echo off
setlocal
cd /d "%~dp0"
title Agent Ops - stop
set "PORT=8778"

echo.
echo   Agent Ops - stopping the server on port %PORT%
echo   ==================================================
powershell -NoProfile -Command "try{ $d=Invoke-RestMethod ('http://127.0.0.1:%PORT%/api/agent-ops/debug') -TimeoutSec 3; Write-Host ('  currently serving: ' + $d.servedFrom) }catch{ }; $c=Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if($c){ foreach($x in $c){ Stop-Process -Id $x.OwningProcess -Force -ErrorAction SilentlyContinue }; Write-Host '  stopped.' } else { Write-Host '  nothing was running on this port.' }"
echo.
echo   press any key to close
pause >nul
exit /b 0
