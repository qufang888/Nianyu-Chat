import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../ipc';
import type { AppSettings } from '../types';
import { translate, type Lang } from './translations';

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
      if (s.lang === 'en' || s.lang === 'zh') {
        setLangState(s.lang);
        api.setMenuLang(s.lang);
      }
    });
  }, []);

  const setLang = (l: Lang) => {
    setLangState(l);
    api.saveSettings({ lang: l } as Partial<AppSettings>);
    api.setMenuLang(l);
  };

  const t = (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars);

  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>;
};
