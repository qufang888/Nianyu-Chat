import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../ipc';
import type { AppSettings } from '../types';
import { LANGS, translate, type Lang } from './translations';

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<I18nCtx>({
  lang: 'zh',
  setLang: () => {},
  t: (k) => k,
});

export const useI18n = () => useContext(Ctx);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>('zh');

  useEffect(() => {
    api.getSettings().then((s: AppSettings) => {
      // v2.3.38：支持全部 10 种语言（zh/en/fr/de/ja/ko/es/pt/ru/zh-Hant）
      if (LANGS.some((l) => l.key === s.lang)) {
        setLangState(s.lang as Lang);
        api.setMenuLang(s.lang as string);
      }
    });
  }, []);

  const setLang = (l: Lang) => {
    setLangState(l);
    // 同步 <html lang>，供全局错误处理等非 React 模块读取当前语言
    try { document.documentElement.lang = l; } catch { /* ignore */ }
    api.saveSettings({ lang: l } as Partial<AppSettings>);
    api.setMenuLang(l);
  };

  const t = (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars);

  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>;
};
