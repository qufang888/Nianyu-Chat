; 念语 安装程序深度定制 UI
; 所有 !define 均用 !ifndef 保护，避免与 electron-builder 内置模板冲突

; ===== 欢迎 / 完成页面侧图（164x314 BMP） =====
!ifndef MUI_WELCOMEFINISHPAGE_BITMAP
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${BUILD_RESOURCES_DIR}\sidebar.bmp"
!endif
!ifndef MUI_UNWELCOMEFINISHPAGE_BITMAP
  !define MUI_UNWELCOMEFINISHPAGE_BITMAP "${BUILD_RESOURCES_DIR}\sidebar.bmp"
!endif

; ===== 头部信息 =====
!ifndef MUI_HEADERIMAGE
  !define MUI_HEADERIMAGE
!endif
!ifndef MUI_HEADERIMAGE_RIGHT
  !define MUI_HEADERIMAGE_RIGHT
!endif
!ifndef MUI_HEADERIMAGE_BITMAP
  !define MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}\header.bmp"
!endif

; ===== 品牌文字 =====
BrandingText "念语 Nianyu AI Chat"

; ===== 欢迎页文字（不设标题，让 assistedInstaller.nsh 处理）=====
!ifndef MUI_WELCOMEPAGE_SUBTITLE
  !define MUI_WELCOMEPAGE_SUBTITLE "念语 — 你的 AI 数字人聊天伙伴"
!endif

; ===== 取消确认 =====
!ifndef MUI_ABORTWARNING_TEXT
  !define MUI_ABORTWARNING_TEXT "确定要取消安装吗？"
!endif

; =====================================================================
; 卸载时询问是否删除使用数据（默认不删）
; 仅卸载器编译（BUILD_UNINSTALLER）时生效；安装器编译自动跳过。
; 使用 UninstPage custom（而非 MUI_UNPAGE_CUSTOM），因为
; installer.nsh 在 electron-builder 脚本末尾才被 include，
; 此时 MUI 页宏定义已完成，只能以自定义页形式插入。
; 删除前先杀进程，防止文件锁导致 RMDir 失败。
; 注意：Electron 的 userData 目录取自 package.json 的 name（nianyu-client），
;       并非 productName（念语），故此处按真实目录名删除。
; v2.3.23 修复三处残留根因：
;   ① custom-data-path.txt 位于被删的 AppData 内，必须先于 RMDir 读取（此前顺序颠倒，自定义数据目录永远删不到）；
;   ② 注册表自启动项（HKCU Run 的 electron.app.念语）此前从不清理；
;   ③ 删除无重试——首杀进程后 800ms 内锁可能未释放，增加多轮「杀进程→删除」循环。
; =====================================================================
!ifdef BUILD_UNINSTALLER
  !include "nsDialogs.nsh"
  Var /GLOBAL deleteAppDataChecked
  Var chkDeleteData

  ; 自定义卸载页：勾选框，默认不勾选
  ; 同时注册 leave 回调,在用户点击下一步时强制读取复选框最新状态,
  ; 避免某些 NSIS 版本下 OnClick 不触发导致 $deleteAppDataChecked 未赋值。
  UninstPage custom un.DataChoicePage un.LeaveDataChoice

  Function un.DataChoicePage
    StrCpy $deleteAppDataChecked 0
    nsDialogs::Create 1018
    Pop $R0
    ${If} $R0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 42u "卸载 念语 时，是否一并删除所有使用数据？$\n（聊天记录、记忆、设置、自定义音效、自启动项等，位于 AppData 或「文档\念语数据」目录）$\n默认不删除，你可稍后手动清理。"
    Pop $R1
    ${NSD_CreateCheckBox} 0 54u 100% 16u "删除所有使用数据（不可恢复）"
    Pop $chkDeleteData
    ${NSD_SetState} $chkDeleteData 0
    ${NSD_OnClick} $chkDeleteData un.OnChkDeleteData
    nsDialogs::Show
  FunctionEnd

  Function un.OnChkDeleteData
    ${NSD_GetState} $chkDeleteData $R2
    StrCpy $deleteAppDataChecked $R2
  FunctionEnd

  ; 离开页面时强制读取复选框最新状态（兜底）
  Function un.LeaveDataChoice
    ${NSD_GetState} $chkDeleteData $deleteAppDataChecked
    ; v2.3.24：勾选后点「下一步」当场执行清理（主路径，不依赖任何回调触发时机）；
    ; un.onUninstSuccess 兜底再跑一遍，删除幂等（RMDir/DeleteRegValue 对不存在目标静默无害）。
    ; 注意：卸载成功回调的正确名称是 un.onUninstSuccess——此前误写成 .onUninstSuccess（安装器回调），
    ; 导致删除逻辑在卸载器里从未被执行过，这才是「勾选了没效果」的真正根因。
    ${If} $deleteAppDataChecked == 1
      Call un.RemoveAllData
    ${EndIf}
  FunctionEnd

  ; 全量清理（幂等，可重复调用）：
  ;   ① 主数据目录：文档\念语数据（聊天记录/角色卡/世界书/朋友圈/图片/朗读缓存）
  ;   ② 自定义数据目录：custom-data-path.txt（changeDataDir 时写入，每行一个路径）
  ;      ——该文件在被删的 AppData 内，必须先于 RMDir 读取；cmd for /f 逐行删除，兼容含空格路径
  ;   ③ 运行时目录：AppData\Roaming 与 LocalAppData 下的 nianyu-client（Electron userData 真实包名）
  ;      以及产品名目录 念语（未来命名兼容）与 nianyu-client-updater（electron-updater 下载缓存）
  ;   ④ 注册表自启动项：HKCU Run 的 electron.app.念语（含历史命名变体；不存在时静默跳过）
  Function un.RemoveAllData
    DetailPrint "正在删除所有使用数据..."
    nsExec::Exec 'taskkill /f /im "念语.exe"'
    Sleep 800
    ; 先读后删：自定义数据目录清单
    nsExec::Exec 'cmd /c for /f "usebackq delims=" %A in ("$APPDATA\nianyu-client\custom-data-path.txt") do rmdir /s /q "%A"'
    ; 循环 3 轮「杀进程 → 删除」，规避杀进程后文件锁释放延迟
    StrCpy $R6 0
    ${Do}
      RMDir /r "$DOCUMENTS\念语数据"
      RMDir /r "$APPDATA\nianyu-client"
      RMDir /r "$LOCALAPPDATA\nianyu-client"
      RMDir /r "$APPDATA\念语"
      RMDir /r "$LOCALAPPDATA\念语"
      RMDir /r "$LOCALAPPDATA\nianyu-client-updater"
      IntOp $R6 $R6 + 1
      ${If} $R6 >= 3
        ${ExitDo}
      ${EndIf}
      nsExec::Exec 'taskkill /f /im "念语.exe"'
      Sleep 400
    ${Loop}
    ; 注册表自启动项（含历史命名变体）
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.念语"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "念语"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "nianyu-client"
    DetailPrint "使用数据清理完成。"
  FunctionEnd

  Function un.onUninstSuccess
    ${If} $deleteAppDataChecked == 1
      Call un.RemoveAllData
    ${EndIf}
  FunctionEnd

  ; 保留空的后置区段以避免与 electron-builder 卸载区段结构冲突；真正的数据删除已移至 un.RemoveAllData
  Section "-postuninstall"
  SectionEnd
!endif
