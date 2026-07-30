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
; =====================================================================
!ifdef BUILD_UNINSTALLER
  !include "nsDialogs.nsh"
  Var /GLOBAL deleteAppDataChecked
  Var chkDeleteData

  ; 自定义卸载页：勾选框，默认不勾选
  UninstPage custom un.DataChoicePage

  Function un.DataChoicePage
    StrCpy $deleteAppDataChecked 0
    nsDialogs::Create 1018
    Pop $R0
    ${If} $R0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 42u "卸载 念语 时，是否一并删除所有使用数据？$\n（聊天记录、记忆、设置、自定义音效等，位于 AppData 目录）$\n默认不删除，你可稍后手动清理。"
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

  ; 卸载区段末尾：先杀进程，勾选才删除数据目录
  Section "-postuninstall"
    ${If} $deleteAppDataChecked == 1
      ; 杀进程释放文件锁，确保 AppData 目录可删
      nsExec::Exec 'taskkill /f /im "nianyu-client.exe" 2>nul'
      Sleep 500
      RMDir /r "$APPDATA\nianyu-client"
      RMDir /r "$LOCALAPPDATA\nianyu-client"
    ${EndIf}
  SectionEnd
!endif
