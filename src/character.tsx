// 念语 · 桌面角色窗口渲染入口（V3）
//
// 独立 BrowserWindow 加载本入口，仅引入主题变量与角色专属样式（不引入主界面 index.css，
// 避免 7000+ 行主界面样式影响透明小窗布局与性能）。
//
// 合规：本文件与 src/character/* 只实现通用的桌面陪伴交互范式；角色形象为**原创几何图形**
// （PlaceholderCharacter），不含任何第三方软件的角色、文案、音效或动画复刻。
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './theme/ThemeContext';
import { I18nProvider } from './i18n/I18nContext';
import { CharacterApp } from './character/CharacterApp';
import './theme/variables.css';
import './styles/character.css';
import { installGlobalSoundListeners } from './utils/sound';

// 角色窗是独立渲染进程：主窗 main.tsx 的全局音效监听器覆盖不到这里，
// 需在本入口各自安装一次，否则角色窗内的点击/弹窗等交互静默。
installGlobalSoundListeners();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <CharacterApp />
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>
);
