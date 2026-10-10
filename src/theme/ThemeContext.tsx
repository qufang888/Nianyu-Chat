import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../ipc';
import { FONT_FAMILIES, type AppSettings, type ThemeName } from '../types';
import { applyAnimControl } from '../utils/animControl';

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
    // v2.3.97：液态玻璃「背景流动」开关（仅 liquid 主题消费，其他主题挂了也无副作用，
    // 因为 CSS 侧的选择器是 [data-theme='liquid'][data-liquid-flow='off']）。
    // 语义：缺省 / true = 流动；false = 完全静止（animation:none，而非暂停在首帧）。
    // 注意与 animControl 的正交关系：三档「全部关闭」已经能停掉流动，这里管的是
    // 「其他动效照常播放、唯独背景不流动」这一档，故需要独立属性。
    if (settings && settings.liquidFlow === false) {
      root.setAttribute('data-liquid-flow', 'off');
    } else {
      root.removeAttribute('data-liquid-flow');
    }
    // 毛玻璃主题背景（仅 glass/frost/liquid 主题生效）：自定义背景色或图片，磨砂效果由主题 CSS 的 backdrop-filter 保留
    // v2.3.97：liquid 加入判断 —— 液态玻璃同为半透明家族，同样支持自定义背景图。
    const isGlass = theme === 'glass' || theme === 'frost' || theme === 'liquid';
    const glassBg = settings.glassBgImage
      ? `url("${settings.glassBgImage}") center/cover no-repeat`
      : settings.glassBgColor || '';
    if (isGlass && glassBg) {
      root.style.setProperty('--app-bg', glassBg);
      // v2.3.97：液态玻璃的「流动」是 background-position 位移，**只在主题自带渐变上成立**。
      // 用户自定义了背景色/图之后，--app-bg 变成 `url(...) center/cover no-repeat`，
      // 此时若继续跑位移动画，等于让用户的照片在窗口里缓慢漂移（观感是 bug 不是特效）。
      // 故挂一个标记属性，让 index.css 的 liquid 段停掉动画并改用 --app-bg 原样显示。
      // 标记放在 data-liquid-custom-bg 上，与 data-liquid-flow 是两个正交维度：
      // 前者「有没有自定义背景」，后者「要不要流动」。
      root.setAttribute('data-liquid-custom-bg', 'on');
    } else {
      root.style.removeProperty('--app-bg');
      root.removeAttribute('data-liquid-custom-bg');
    }
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
    // v2.3.105：毛玻璃 / 液态玻璃专属细化 —— 色调 + 不透明度 + 模糊度。
    // 仅 glass / frost / liquid 主题生效；其余主题清除内联覆盖，回退变量默认值。
    // 不透明度按「白底基准 alpha 0.20」的比例同步缩放到 chat-bg(0.45×) / input-bg(0.95×)，
    // 使三者随滑块等比增减，观感一致。色调缺省近白（#ffffff），即当前默认玻璃观感。
    if (isGlass) {
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
