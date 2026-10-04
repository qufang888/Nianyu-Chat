import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';
import { useTheme } from '../theme/ThemeContext';
import { isGroupEnabled } from '../utils/animControl';

// 开屏欢迎语：线性动画展示，自动淡出（点按可跳过；关闭动效时更短且不淡入）
export const SplashScreen: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const { t } = useI18n();
  // v2.3.90：原先只读根元素 `.anim-off`（只能识别总控），单控模式下会误判为「动效开启」。
  // 改读「开屏欢迎语」分组：总控关闭或单控关掉该项都用缩短版时长并跳过淡出等待。
  const { settings } = useTheme();
  const animOn = isGroupEnabled(settings, 'splash');
  const [hide, setHide] = useState(false);

  useEffect(() => {
    const reduced = !animOn;
    const dur = reduced ? 600 : 1800;
    const t1 = setTimeout(() => setHide(true), dur);
    const t2 = setTimeout(() => onDone(), dur + (reduced ? 0 : 500));
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [onDone, animOn]);

  return (
    <div className={`splash ${hide ? 'hide' : ''}`} onClick={() => onDone()}>
      <div className="splash-logo">念语</div>
      <div className="splash-sub">NIANYU</div>
      <div className="splash-line" />
      <div className="splash-welcome">{t('splash.welcome')}</div>
    </div>
  );
};
