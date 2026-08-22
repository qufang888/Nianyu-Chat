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
    ${NSD_CreateLabel} 0 0 100% 42u "卸载 念语 时，是否一并删除所有使用数据？$\n（聊天记录、记忆、设置、自定义音效等，位于 AppData 或「文档\念语数据」目录）$\n默认不删除，你可稍后手动清理。"
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
  FunctionEnd

  ; 卸载区段末尾：先杀进程，勾选才删除数据目录
  ; 同时检查自定义数据路径（用户可能将数据迁移到了文档文件夹等位置）
  Section "-postuninstall"
    ${If} $deleteAppDataChecked == 1
      ; 杀进程释放文件锁，确保 AppData 目录可删
      ; 关键修复：exe 实际文件名取自 productName（念语），而非 package.json 的 name（nianyu-client）。
      ; 此前误用 nianyu-client.exe 导致进程杀不掉 → 数据目录被锁 → RMDir 静默失败 → 重装后数据仍在。
      nsExec::Exec 'taskkill /f /im "念语.exe" 2>nul'
      Sleep 800
      ; 多次尝试删除，规避文件锁残留（首轮失败后再杀一次并重试）
      RMDir /r "$APPDATA\nianyu-client"
      RMDir /r "$LOCALAPPDATA\nianyu-client"
      ; 默认数据目录「文档\念语数据」：早期版本数据存于 AppData，现版本默认存于文档目录，
      ; 此前未删此目录是「勾选删除数据但数据仍保留」的根因。$DOCUMENTS 自动适配系统语言。
      RMDir /r "$DOCUMENTS\念语数据"
      nsExec::Exec 'taskkill /f /im "念语.exe" 2>nul'
      Sleep 300
      RMDir /r "$APPDATA\nianyu-client"
      RMDir /r "$LOCALAPPDATA\nianyu-client"
      RMDir /r "$DOCUMENTS\念语数据"
      ; 删除自定义数据目录（路径存储在 custom-data-path.txt 中，每行一个路径）
      ${If} ${FileExists} "$APPDATA\nianyu-client\custom-data-path.txt"
        ; NSIS 3.x 可用 FileRead 逐行读取并删除
        FileOpen $4 "$APPDATA\nianyu-client\custom-data-path.txt" r
        IfErrors done_custom_path
        loop_custom_path:
          FileRead $4 $5
          IfErrors done_custom_path
          StrCpy $5 "$5" "" -1  ; 去掉换行符
          StrCmp $5 "" loop_custom_path  ; 跳过空行
          ; 先删 custom-data-path.txt 自身（它在待删目录内的话会被 RMDir /r 一并删除）
          ; 但它实际在 APPDATA 里，所以单独保留到后面统一清
          RMDir /r "$5"
          Goto loop_custom_path
        done_custom_path:
        FileClose $4
      ${EndIf}
    ${EndIf}
  SectionEnd
!endif
