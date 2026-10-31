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
          <div className="about-logo">{t('about.logo')}</div>
          <div className="about-sub">{t('about.sub')}</div>
          <div className="about-author">{t('about.author')}</div>
          <div className="about-lines">
            <div>{t('about.line1')}</div>
            <div>{t('about.line2')}</div>
            <div>{t('about.line3')}</div>
            <div>{t('about.line4')}</div>
          </div>
        </div>
      </div>
    </div>
  );
};
