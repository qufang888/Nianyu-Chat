import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { MiniChat } from './components/MiniChat';
import { ThemeProvider } from './theme/ThemeContext';
import { I18nProvider } from './i18n/I18nContext';
import { ErrorBoundary } from './components/ErrorBoundary';
// v2.3.97：自绘弹窗宿主（确认框 / 文件选择器）。
// 挂在**顶层、与 <App /> 和 <MiniChat /> 并列**（不是它们的孩子），
// 于是主窗与小窗共享同一套宿主，两个窗口都能弹主题内弹窗。
import ConfirmHost from './components/ConfirmHost';
import FilePickerHost from './components/FilePickerHost';
import { registerGlobalErrorHandlers, showErrorDialog } from './utils/globalErrorHandler';
import { api } from './ipc';
import { installGlobalSoundListeners } from './utils/sound';
// v2.3.104：玻璃/液态玻璃主题文字对比度看门狗（可读性功能，非动画，独立开关）。
import { initAutoContrast, setAutoContrastEnabled } from './utils/autoContrast';
import type { Lang } from './i18n/translations';
import './styles/index.css';

// 注册全局错误监听（独立于 React 树，捕获未捕获错误和未处理 Promise rejection）
registerGlobalErrorHandlers();

// 安装全局 UI 点击音效监听（主窗口与小窗共用同一入口，覆盖两者）
installGlobalSoundListeners();

// v2.3.104：对比度看门狗初始化（幂等）。
// 挂在本文件（主窗与小窗共用同一渲染入口：主窗 <App /> / 小窗 <MiniChat /> 都从这里出），
// 两个窗口都能吃到玻璃/液态玻璃主题的可读性兜底。
initAutoContrast();
// 开关初值读 settings（缺省视为开启）；设置变更广播后同步（与 ThemeContext 的分发模式一致）
api.getSettings().then((s) => setAutoContrastEnabled(s?.autoContrast !== false));
api.onSettingsChanged(() => {
  api.getSettings().then((s) => setAutoContrastEnabled(s?.autoContrast !== false));
});

// 监听主进程推送的错误
api.onAppError?.((data) => {
  showErrorDialog({
    error: new Error(data.message),
    lang: data.lang as Lang,
    source: 'main',
    fatal: false,
  });
});

// #mini 路由 → 快捷聊天小窗；否则渲染主界面
const isMini = window.location.hash.replace(/^#\/?/, '') === 'mini';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <ErrorBoundary>
          {isMini ? <MiniChat /> : <App />}
          {/* v2.3.97：自绘弹窗宿主（主窗 / 小窗共用）。放在 ErrorBoundary 内、
              与页面并列 —— 无论当前是小窗还是主窗、无论 ErrorBoundary 是否已降级，
              确认框与文件选择器都始终可用。 */}
          <ConfirmHost />
          <FilePickerHost />
        </ErrorBoundary>
      </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>
);
