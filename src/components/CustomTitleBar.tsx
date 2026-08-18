import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import { useTheme } from '../theme/ThemeContext';
import { AvatarImg } from './ChatList';

interface CustomTitleBarProps {
  variant?: 'main' | 'mini';
  title: string;
  avatar?: string;
  maximized?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  onOpenMain?: () => void;
}

// 窗口控制按钮图标（SVG，继承 currentColor，跟随主题）
const IconMin = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
    <line x1="1.5" y1="5.5" x2="9.5" y2="5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
const IconMax = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
    <rect x="1.5" y="1.5" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);
const IconRestore = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
    <rect x="2.6" y="2.6" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <rect x="1.5" y="1.5" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.55" />
  </svg>
);
const IconClose = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
    <line x1="2" y1="2" x2="9" y2="9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <line x1="9" y1="2" x2="2" y2="9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
// 应用 Logo（主窗用）
const Logo = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
    <rect x="0" y="0" width="18" height="18" rx="5" fill="var(--color-primary)" />
    <circle cx="5.5" cy="9" r="1.4" fill="#fff" />
    <circle cx="9" cy="9" r="1.4" fill="#fff" />
    <circle cx="12.5" cy="9" r="1.4" fill="#fff" />
  </svg>
);

export const CustomTitleBar: React.FC<CustomTitleBarProps> = ({
  variant = 'main',
  title,
  avatar,
  maximized = false,
  pinned,
  onTogglePin,
  onOpenMain,
}) => {
  const { t } = useI18n();
  const { settings } = useTheme();
  const isMini = variant === 'mini';
  const [isMax, setIsMax] = useState(maximized);
  const [showClosePrompt, setShowClosePrompt] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  // 弹窗内临时选择的行为（默认跟随当前设置，用户可在弹窗内切换）
  const [promptCloseToTray, setPromptCloseToTray] = useState(true);

  // 主窗首次关闭提示：询问行为 + 支持「不再提示」（即时生效写入设置）。小窗无此逻辑，关闭即隐藏。
  const handleMainClose = () => {
    if (isMini) {
      api.windowControl('close');
      return;
    }
    if (settings?.closeConfirmDone) {
      api.windowControl('close');
      return;
    }
    // 每次打开弹窗时同步当前设置
    setPromptCloseToTray(settings?.closeToTray !== false);
    setShowClosePrompt(true);
  };
  const confirmClose = async () => {
    // 先把用户在弹窗里选的行为写回设置
    try { await api.saveSettings({ closeToTray: promptCloseToTray }); } catch {}
    if (dontShowAgain) {
      try { await api.saveSettings({ closeConfirmDone: true }); } catch {}
    }
    setShowClosePrompt(false);
    api.windowControl('close');
  };

  useEffect(() => setIsMax(maximized), [maximized]);

  // JS 驱动的窗口拖动（替换 -webkit-app-region: drag，让 JS 鼠标事件正常触发）
  const dragRef = useRef(false);
  const dragOffRef = useRef({ x: 0, y: 0 });
  const titleRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // 点到了按钮上 → 不拖动
    const t = e.target as HTMLElement;
    if (t.closest('.ctb-btn, .ctb-right, .mini-title-btns')) return;
    // 在最大化窗口上拖动无效
    if (!isMini && isMax) return;
    if (!api.windowDragTo) return;
    dragRef.current = true;
    dragOffRef.current = { x: e.screenX - window.screenX, y: e.screenY - window.screenY };
  };

  useEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      api.windowDragTo(e.screenX - dragOffRef.current.x, e.screenY - dragOffRef.current.y);
    };
    const onMouseUp = () => { dragRef.current = false; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isMini, isMax]);

  // 主窗：监听主进程推送的最大化/还原状态，同步图标与窗口圆角
  useEffect(() => {
    if (isMini) return;
    const cb = (m: boolean) => {
      setIsMax(m);
      document.documentElement.setAttribute('data-maximized', m ? 'true' : 'false');
    };
    api.onWindowStateChange(cb);
    return () => api.offWindowStateChange(cb);
  }, [isMini]);

  const toggleMax = () => {
    if (!isMini) api.windowControl(isMax ? 'unmaximize' : 'maximize');
  };
  // 双击标题栏空白区 → 最大化/还原（与原生行为一致）
  const onDoubleClick = () => {
    if (!isMini) toggleMax();
  };

  return (
    <div className={`custom-titlebar ${isMini ? 'mini' : ''}`} ref={titleRef} onMouseDown={handleMouseDown}>
      <div className="ctb-left" onDoubleClick={onDoubleClick}>
        {isMini ? (
          avatar ? (
            <span className="ctb-avatar">
              <AvatarImg path={avatar} />
            </span>
          ) : (
            <span className="ctb-avatar ctb-avatar-fallback">🤖</span>
          )
        ) : (
          <span className="ctb-logo">
            <Logo />
          </span>
        )}
        <span className="ctb-title">{title}</span>
      </div>

      <div className="ctb-mid" onDoubleClick={onDoubleClick} />

      <div className="ctb-right">
        {isMini ? (
          <>
            {onTogglePin && (
              <button
                className="ctb-btn"
                title={pinned ? t('mini.unpin') : t('mini.pin')}
                style={pinned ? { color: 'var(--color-primary)' } : undefined}
                onClick={onTogglePin}
              >
                📌
              </button>
            )}
            {onOpenMain && (
              <button className="ctb-btn" title={t('mini.openMain')} onClick={onOpenMain}>
                🗖
              </button>
            )}
            <button
              className="ctb-btn ctb-close"
              title={t('mini.hide')}
              onClick={() => api.miniHide()}
            >
              <IconClose />
            </button>
          </>
        ) : (
          <>
            <button
              className="ctb-btn"
              title={t('titlebar.minimize')}
              onClick={() => api.windowControl('minimize')}
            >
              <IconMin />
            </button>
            <button className="ctb-btn" title={t('titlebar.maximize')} onClick={toggleMax}>
              {isMax ? <IconRestore /> : <IconMax />}
            </button>
            <button
              className="ctb-btn ctb-close"
              title={t('titlebar.close')}
              onClick={handleMainClose}
            >
              <IconClose />
            </button>
          </>
        )}
      </div>
      {(showClosePrompt && !isMini) &&
        createPortal(
        <div className="modal-mask" onClick={() => setShowClosePrompt(false)} style={{ zIndex: 10000 }}>
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: 440,
              width: '92%',
              maxHeight: '85vh',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div className="modal-head">
              <span>{t('titlebar.closeConfirmTitle')}</span>
            </div>
            <div className="modal-body" style={{ flex: 1 }}>
              {/* 行为选择：托盘 vs 退出 */}
              <div style={{ marginBottom: 12 }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    border: promptCloseToTray ? '2px solid var(--color-primary)' : '2px solid transparent',
                    background: promptCloseToTray ? 'var(--color-hover)' : 'transparent',
                    transition: 'all 0.15s',
                  }}
                  onClick={() => setPromptCloseToTray(true)}
                >
                  <input
                    type="radio"
                    name="closeBehavior"
                    checked={promptCloseToTray}
                    onChange={() => setPromptCloseToTray(true)}
                    style={{ marginTop: 2 }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{t('settings.closeToTray')}</div>
                    <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-text-secondary)' }}>{t('titlebar.closeConfirmTray')}</div>
                  </div>
                </label>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    border: !promptCloseToTray ? '2px solid var(--color-primary)' : '2px solid transparent',
                    background: !promptCloseToTray ? 'var(--color-hover)' : 'transparent',
                    transition: 'all 0.15s',
                  }}
                  onClick={() => setPromptCloseToTray(false)}
                >
                  <input
                    type="radio"
                    name="closeBehavior"
                    checked={!promptCloseToTray}
                    onChange={() => setPromptCloseToTray(false)}
                    style={{ marginTop: 2 }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{t('settings.closeExit')}</div>
                    <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-text-secondary)' }}>{t('titlebar.closeConfirmExit')}</div>
                  </div>
                </label>
              </div>

              {/* 提示说明 */}
              <div style={{
                fontSize: 12,
                lineHeight: 1.6,
                marginBottom: 12,
                padding: '8px 10px',
                borderRadius: 6,
                background: 'var(--color-hover)',
                color: 'var(--color-text-secondary)',
              }}>
                {t('titlebar.closeConfirmHint')}
              </div>

              {/* 不再提示 */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={dontShowAgain} onChange={(e) => setDontShowAgain(e.target.checked)} />
                {t('titlebar.closeConfirmNoMore')}
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '12px 16px', borderTop: '1px solid var(--color-border)', flexShrink: 0 }}>
              <button className="btn-ghost" onClick={() => setShowClosePrompt(false)}>{t('common.cancel')}</button>
              <button className="btn-primary" onClick={confirmClose}>{t('common.confirm')}</button>
            </div>
          </div>
        </div>,
          document.body
        )}
    </div>
  );
};
