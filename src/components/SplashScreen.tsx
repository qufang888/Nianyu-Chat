import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';

// 开屏欢迎语：线性动画展示，自动淡出（点按可跳过；关闭动效时更短且不淡入）
export const SplashScreen: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const { t } = useI18n();
  const [hide, setHide] = useState(false);

  useEffect(() => {
    const reduced = document.documentElement.classList.contains('anim-off');
    const dur = reduced ? 600 : 1800;
    const t1 = setTimeout(() => setHide(true), dur);
    const t2 = setTimeout(() => onDone(), dur + (reduced ? 0 : 500));
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [onDone]);

  return (
    <div className={`splash ${hide ? 'hide' : ''}`} onClick={() => onDone()}>
      <div className="splash-logo">念语</div>
      <div className="splash-sub">NIANYU</div>
      <div className="splash-line" />
      <div className="splash-welcome">{t('splash.welcome')}</div>
    </div>
  );
};
