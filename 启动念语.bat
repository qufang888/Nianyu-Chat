@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 启动界面由念语自身（Electron 无边框、随主题配色的窗口）承担，覆盖「进程起到主界面首帧」的
rem 等待，主界面首帧就绪即自动关闭，二者不共存。故不再需要 Edge 外挂启动界面。
rem 仅在缺少构建产物时才构建（常规启动直接跑已构建版本，秒开）；
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
