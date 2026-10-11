import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../ipc';
import { FONT_FAMILIES, type AppSettings, type ThemeName } from '../types';
import { applyAnimControl } from '../utils/animControl';
import { auraPrimaryText, isValidAuraAccent } from '../utils/auraAccent';

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
    // 高级动画控制（v2.3.92）：全开 / 全关 / 自定义三档。原先这里只挂 `.anim-off`（总控 kill），
    // 现统一走 applyAnimControl —— 'all-off' 档挂 `.anim-off`；'custom' 档改挂
    // `html[data-anim-off~="<id>"]` 并由自动生成的 <style> 精确关掉对应分组；
    // 'custom' 档永不挂 `.anim-off`，以保证仍开启的分组动画与「流式豁免」不被误杀。
    applyAnimControl(document, settings, 'main');
    // 玻璃家族主题背景（仅 glass/frost/aura 主题生效）：自定义背景色或图片，磨砂效果由主题 CSS 的 backdrop-filter 保留
    // v2.3.108：aura（琉璃幻境）加入玻璃家族；前代 liquid 主题已在 v2.3.107 整体删除。
    // v2.3.110 需求 4：frost（冰川素白）保留在玻璃家族里（自定义玻璃背景 / Token 配色继续可用），
    // 但**退出半透明面板细化**（见 glassTintScope）——frost 的面板/聊天区本就是不透明白，
    // 深色自定义背景图也不再能把文字底压暗，深底深字不可读的根因即此。
    const isGlass = theme === 'glass' || theme === 'frost' || theme === 'aura';
    // v2.3.110 需求 4：半透明面板细化（glassTint/glassOpacity/glassBlur → --color-panel /
    // --color-chat-bg / --color-input-bg / --blur 覆写）收窄到 glass / aura。
    // frost 是浅色不透明主题（--color-panel #ffffff 等全部实色），不需要也不应该被
    // 「白 20% 半透明」覆写：覆写后深色自定义背景下面板变成深底、配 #1e293b 深字 → 不可读
    // （用户截图实测 bug）。frost 的自定义玻璃背景仍由上面的 isGlass 分支照常下发。
    const glassTintScope = theme === 'glass' || theme === 'aura';
    const glassBg = settings.glassBgImage
      ? `url("${settings.glassBgImage}") center/cover no-repeat`
      : settings.glassBgColor || '';
    if (isGlass && glassBg) {
      root.style.setProperty('--app-bg', glassBg);
      // 用户自定义了背景色/图之后挂标记属性，供 autoContrast 看门狗把采样出的
      // 自定义背景色垫在最底参与对比度求解（属性名 v2.3.108 起由 data-liquid-custom-bg
      // 更名为 data-glass-custom-bg，旧名随 liquid 主题一并退役）。
      // 该属性同时是 index.css「aura 背景流动」的停流开关：自定义背景 = 用户素材，
      // 流动叠层会盖在素材上，故 ::before 整层隐藏（见 index.css auraFlowDrift 注释）。
      root.setAttribute('data-glass-custom-bg', 'on');
    } else {
      root.style.removeProperty('--app-bg');
      root.removeAttribute('data-glass-custom-bg');
    }
    // 琉璃幻境主题色（v2.3.109 需求 2c）：仅 aura 主题生效，空/非法 = 跟随主题默认 #45e0c8。
    // 三件事：写 --aura-accent（variables.css 的 bg 渐变 / hover / nav-active / border 等
    // color-mix 链条的总开关）；派生 --color-primary（直接用该色）；按 WCAG 相对亮度派生
    // --color-primary-text（亮 accent 配深字 #06222a、暗 accent 配白字，见 utils/auraAccent.ts）。
    // 清空/切走主题时移除全部内联值，回退 variables.css 出厂默认。
    // 注意作用域是 theme==='aura' 而非 isGlass：--color-primary 是全主题通用令牌，
    // 若在 glass/frost 下也写入会把 aura 的主题色漏进玻璃家族其余成员。
    const auraAccent = isValidAuraAccent(settings.auraAccent) ? settings.auraAccent : '';
    if (theme === 'aura' && auraAccent) {
      root.style.setProperty('--aura-accent', auraAccent);
      root.style.setProperty('--color-primary', auraAccent);
      root.style.setProperty('--color-primary-text', auraPrimaryText(auraAccent));
    } else {
      root.style.removeProperty('--aura-accent');
      root.style.removeProperty('--color-primary');
      root.style.removeProperty('--color-primary-text');
    }
    // 玻璃家族主题：聊天界面颜色覆盖（仅 glass/frost/aura 生效），解决自定义背景后字体/边框与背景融合看不清
    const setGlassVar = (name: string, val?: string) => {
      if (isGlass && val) root.style.setProperty(name, val);
      else root.style.removeProperty(name);
    };
    setGlassVar('--glass-token-fg', settings.glassTokenText);
    setGlassVar('--glass-token-border', settings.glassTokenBorder);
    setGlassVar('--glass-bubble-user-fg', settings.glassBubbleUserText);
    setGlassVar('--glass-bubble-ai-fg', settings.glassBubbleAiText);
    setGlassVar('--glass-bubble-border', settings.glassBubbleBorder);
    // 玻璃家族专属细化（v2.3.105 引入，v2.3.108 扩展到 aura；v2.3.110 需求 4 收窄回 glass/aura）
    // —— 色调 + 不透明度 + 模糊度。仅 glass / aura 主题生效（frost 为不透明浅色主题，
    // 不参与半透明细化，面板保持 variables.css 自带的实色白，深色自定义背景下深字仍可读）；
    // 其余主题清除内联覆盖，回退变量默认值。
    // 不透明度按「白底基准 alpha 0.20」的比例同步缩放到 chat-bg(0.45×) / input-bg(0.95×)，
    // 使三者随滑块等比增减，观感一致。色调缺省近白（#ffffff），即当前默认玻璃观感。
    if (glassTintScope) {
      const tint = settings.glassTint || '#ffffff';
      const rawOp = Number(settings.glassOpacity);
      const op = Number.isFinite(rawOp) && rawOp >= 0 && rawOp <= 100 ? rawOp : 20;
      root.style.setProperty(
        '--color-panel',
        `color-mix(in srgb, ${tint} ${op}%, transparent)`
      );
      root.style.setProperty(
        '--color-chat-bg',
        `color-mix(in srgb, ${tint} ${Math.round(op * 0.45)}%, transparent)`
      );
      root.style.setProperty(
        '--color-input-bg',
        `color-mix(in srgb, ${tint} ${Math.round(op * 0.95)}%, transparent)`
      );
      const rawBlur = Number(settings.glassBlur);
      if (Number.isFinite(rawBlur) && rawBlur > 0) {
        root.style.setProperty('--blur', `${rawBlur}px`);
      } else {
        root.style.removeProperty('--blur');
      }
    } else {
      root.style.removeProperty('--color-panel');
      root.style.removeProperty('--color-chat-bg');
      root.style.removeProperty('--color-input-bg');
      root.style.removeProperty('--blur');
    }
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
