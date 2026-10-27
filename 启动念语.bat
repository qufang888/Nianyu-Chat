@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 常规启动直接跑已构建版本（秒开，约 1 秒）；仅在缺少 dist 时才构建。
rem 冷启动启动界面已于 v2.3.120 移除（启动已足够快，无需等待界面）。
rem 改了代码想重新构建，请先运行：npm run build
if not exist "dist\index.html" (
  echo Building Nianyu (first run^)...
  call npm run build
  if errorlevel 1 (
    echo.
    echo ========================================
    echo BUILD FAILED - see errors above
    echo ========================================
    pause
    exit /b 1
  )
)
echo Starting Nianyu...
call npm start
pause
