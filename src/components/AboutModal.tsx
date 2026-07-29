import React, { useEffect } from 'react';
import { useI18n } from '../i18n/I18nContext';

// 关于软件：直观展示软件介绍与作者
export const AboutModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal about" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t('about.heading')}</span>
          <span className="modal-close" onClick={onClose}>
            ×
          </span>
        </div>
        <div className="modal-body" style={{ textAlign: 'center' }}>
          <div className="about-logo">念语</div>
          <div className="about-sub">NIANYU</div>
          <div className="about-author">made by 前方</div>
          <div className="about-lines">
            <div>一款面向深度情感交互的 AI 数字人对话网站。</div>
            <div>不追逐流水线模板，不盲从通用框架。</div>
            <div>以对话为媒介，搭建虚拟与现实的边界。</div>
            <div>万物皆可对话，心意自有回响。</div>
          </div>
        </div>
      </div>
    </div>
  );
};
