import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../ipc';
import { FONT_FAMILIES, type AppSettings, type ThemeName } from '../types';

interface ThemeCtx {
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
  settings: AppSettings | null;
  reloadSettings: () => Promise<void>;
}

const Ctx = createContext<ThemeCtx>({
  theme: 'wechat',
  setTheme: () => {},
  settings: null,
  reloadSettings: async () => {},
});

export const useTheme = () => useContext(Ctx);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeName>('wechat');
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s);
      setThemeState(s.theme || 'wechat');
    });
  }, []);

  // 监听设置变更广播（来自本窗口或其他窗口的 saveSettings）
  useEffect(() => {
    const off = api.onSettingsChanged((_e) => {
      api.getSettings().then((s) => {
        setSettings(s);
        setThemeState(s.theme || 'wechat');
      });
    });
    return off;
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // 应用自定义圆角（内联变量优先级高于主题 CSS）
  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const ui = Number(settings.uiRadius);
    const bubble = Number(settings.bubbleRadius);
    if (Number.isFinite(ui) && ui >= 0) {
      root.style.setProperty('--radius', `${ui}px`);
      root.style.setProperty('--radius-sm', `${Math.max(2, Math.round(ui * 0.6))}px`);
    }
    if (Number.isFinite(bubble) && bubble >= 0) {
      root.style.setProperty('--bubble-radius', `${bubble}px`);
    }
    const bo = Number(settings.bubbleOpacity);
    if (Number.isFinite(bo) && bo >= 50 && bo <= 100) {
      root.style.setProperty('--bubble-opacity', String(bo / 100));
    } else {
      root.style.setProperty('--bubble-opacity', '1');
    }
    // 字体大小（全局 UI 基准字号）
    const fs = Number(settings.fontSize);
    if (Number.isFinite(fs) && fs > 0) {
      root.style.setProperty('--font-size', `${fs}px`);
      root.style.setProperty('--font-scale', String(fs / 14));
    }
    // 字体样式（按 key 取 CSS 字体栈；缺省回退系统默认）
    const ff = FONT_FAMILIES[settings.fontFamily] || FONT_FAMILIES.system;
    if (ff) root.style.setProperty('--font-family', ff);
    // 输入框文字色 / 内部背景色（留空跟随主题；默认浅灰底 + 深字）
    if (settings.inputBgColor) root.style.setProperty('--input-bg', settings.inputBgColor);
    else root.style.removeProperty('--input-bg');
    if (settings.inputTextColor) root.style.setProperty('--input-fg', settings.inputTextColor);
    else root.style.removeProperty('--input-fg');
    // 全局动效总开关：低配电脑关闭以省性能
    root.classList.toggle('anim-off', !settings.enableAnimations);
    // 毛玻璃主题背景（仅 glass/frost 主题生效）：自定义背景色或图片，磨砂效果由主题 CSS 的 backdrop-filter 保留
    const isGlass = theme === 'glass' || theme === 'frost';
    const glassBg = settings.glassBgImage
      ? `url("${settings.glassBgImage}") center/cover no-repeat`
      : settings.glassBgColor || '';
    if (isGlass && glassBg) root.style.setProperty('--app-bg', glassBg);
    else root.style.removeProperty('--app-bg');
    // 毛玻璃主题：聊天界面颜色覆盖（仅 glass/frost 生效），解决自定义背景后字体/边框与背景融合看不清
    const setGlassVar = (name: string, val?: string) => {
      if (isGlass && val) root.style.setProperty(name, val);
      else root.style.removeProperty(name);
    };
    setGlassVar('--glass-token-fg', settings.glassTokenText);
    setGlassVar('--glass-token-border', settings.glassTokenBorder);
    setGlassVar('--glass-bubble-user-fg', settings.glassBubbleUserText);
    setGlassVar('--glass-bubble-ai-fg', settings.glassBubbleAiText);
    setGlassVar('--glass-bubble-border', settings.glassBubbleBorder);
  }, [settings, theme]);

  const setTheme = (t: ThemeName) => {
    setThemeState(t);
    api.saveSettings({ theme: t });
  };

  const reloadSettings = async () => {
    const s = await api.getSettings();
    setSettings(s);
    setThemeState(s.theme || 'wechat');
  };

  return (
    <Ctx.Provider value={{ theme, setTheme, settings, reloadSettings }}>{children}</Ctx.Provider>
  );
};
