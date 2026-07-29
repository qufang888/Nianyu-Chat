@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Building Nianyu (one moment)...
call npm run build
if errorlevel 1 (
  echo.
  echo ========================================
  echo BUILD FAILED - see errors above
  echo ========================================
  pause
  exit /b 1
)
echo Starting Nianyu...
call npm start
pause
