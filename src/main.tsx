import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './theme/ThemeContext';
import { I18nProvider } from './i18n/I18nContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { registerGlobalErrorHandlers, showErrorDialog } from './utils/globalErrorHandler';
import { api } from './ipc';
import { installGlobalSoundListeners } from './utils/sound';
import './styles/index.css';

// 非 Electron 环境（浏览器 / Capacitor WebView）引导：动态加载 Web 后端到 window.api。
// 桌面端由 preload 已注入 window.api，此处直接跳过，且不会打包 web 后端到桌面产物。
async function ensureWebBackend(): Promise<void> {
  if ((window as any).api) return;
  const { webApi, initNianyuWeb } = await import('./api/web');
  (window as any).api = webApi;
  await initNianyuWeb();
}

async function start(): Promise<void> {
  await ensureWebBackend();

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

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nProvider>
        <ThemeProvider>
          <ErrorBoundary><App /></ErrorBoundary>
        </ThemeProvider>
      </I18nProvider>
    </React.StrictMode>
  );
}

start();
