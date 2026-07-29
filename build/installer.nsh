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
