@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================================
rem v2.3.118：启动界面（覆盖「构建 + 启动」整段等待期，随当前主题适配）
rem   - 读上次运行写下的当前主题（.launch-theme，无则默认 wechat）
rem   - 经 Edge 无边框窗口打开 dist/launch.html（src=bat 专属标题 NianYu-Launcher）
rem   - 用独立 profile 目录隔离；主进程/收尾按 'nianyu-launch-profile' 精准结束该实例，
rem     绝不影响用户其它 Edge 窗口 / 标签
rem   - Edge 缺失/打开失败时静默跳过（2>nul），控制台照旧，不影响启动
rem ============================================================================
set "THEME=wechat"
if exist ".launch-theme" set /p THEME=<".launch-theme"
set "ROOT=%~dp0"
set "ROOT=%ROOT:\=/%"
start "" msedge "--app=file:///%ROOT%dist/launch.html?src=bat&theme=%THEME%" "--user-data-dir=%TEMP%\nianyu-launch-profile" 2>nul

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
rem 标记由 bat 启动：主进程据此跳过自带启动窗，并在主界面首帧就绪时关闭 Edge 启动界面
set "NIANYU_LAUNCHER=1"
call npm start

rem 兜底收尾：若应用未来得及关闭，强制结束启动界面那个 Edge 实例（按独立 profile 名匹配）
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*nianyu-launch-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
pause
