import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { MiniChat } from './components/MiniChat';
import { ThemeProvider } from './theme/ThemeContext';
import { I18nProvider } from './i18n/I18nContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { registerGlobalErrorHandlers, showErrorDialog } from './utils/globalErrorHandler';
import { api } from './ipc';
import { installGlobalSoundListeners } from './utils/sound';
import './styles/index.css';

// 注册全局错误监听（独立于 React 树，捕获未捕获错误和未处理 Promise rejection）
registerGlobalErrorHandlers();

// 安装全局 UI 点击音效监听（主窗口与小窗共用同一入口，覆盖两者）
installGlobalSoundListeners();

// 监听主进程推送的错误
api.onAppError?.((data) => {
  showErrorDialog({
    error: new Error(data.message),
    lang: data.lang as 'zh' | 'en',
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
        <ErrorBoundary>{isMini ? <MiniChat /> : <App />}</ErrorBoundary>
      </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>
);
