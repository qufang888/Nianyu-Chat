import React, { useEffect, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';

/**
 * 关于软件弹窗（v3.0.4 改版）。
 * - 文案只保留品牌标语「万物皆可对话，心意自有回响」，旧的自我介绍长句已删除；
 * - 视觉：品牌 Logo + 强调线 + 标语主角 + 作者署名 / 版本徽标 + GitHub 入口；
 * - 所有颜色走主题变量，14 套主题下保持可读；不引入投影（遵循 .modal 既有约定）。
 */
export const AboutModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useI18n();
  const [version, setVersion] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // 版本号取自主进程 app.getVersion()，失败时静默留空（不影响关于页其它内容）
    void api
      .updateStatus()
      .then((s) => setVersion(s?.currentVersion || ''))
      .catch(() => {});
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const openGitHub = () => {
    try {
      api.openExternal('https://github.com/qufang888/Nianyu-Chat');
    } catch {
      // 外链失败静默降级：不影响关于弹窗本身
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal about" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t('about.heading')}</span>
          <span className="modal-close" onClick={onClose}>
            ×
          </span>
        </div>
        <div className="about-body">
          {/* 品牌区：Logo + 英文副名 + 强调线 */}
          <div className="about-brand">
            <div className="about-logo">{t('about.logo')}</div>
            <div className="about-sub">{t('about.sub')}</div>
            <div className="about-accent" aria-hidden="true" />
          </div>

          {/* 标语区：唯一保留的文案，作为视觉主角 */}
          <div className="about-slogan">{t('about.line4')}</div>

          {/* 信息区：作者署名 + 版本徽标 */}
          <div className="about-meta">
            <span className="about-author">{t('about.author')}</span>
            {version && <span className="badge primary">{`v${version.replace(/^v/, '')}`}</span>}
          </div>

          {/* 操作区：GitHub 入口 */}
          <div className="about-actions">
            <button type="button" className="btn-ghost" onClick={openGitHub}>
              {t('about.github')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
