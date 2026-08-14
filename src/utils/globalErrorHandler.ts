// 渲染进程全局错误处理
// 当 React 崩溃或发生未捕获错误时，创建独立 DOM 覆盖层显示错误诊断信息
import { diagnoseError, type DiagnosisResult } from './errorDiagnosis';
import { playSoundSync } from './sound';

interface ShowErrorOptions {
  error: Error | string;
  source?: string;
  lang?: 'zh' | 'en';
  fatal?: boolean; // 致命错误（允许重启）
}

// 获取当前界面语言（从设置或 HTML 属性）
function detectLang(): 'zh' | 'en' {
  try {
    return (document.documentElement.lang as 'zh' | 'en') || 'zh';
  } catch {
    return 'zh';
  }
}

let dialogContainer: HTMLDivElement | null = null;

function getDialogContainer(): HTMLDivElement {
  if (!dialogContainer) {
    dialogContainer = document.createElement('div');
    dialogContainer.id = 'nianyu-global-error-dialog';
    // 重要：遮罩默认隐藏，且 pointer-events:none —— 即使报错弹窗出现，也绝不拦截下层应用的鼠标/键盘，
    // 避免「全屏点不动、输不进字」的问题。卡片自身用 pointer-events:auto 保证按钮可点。
    dialogContainer.style.cssText = `
      position: fixed; inset: 0; z-index: 999999;
      display: none; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.5);
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;
    document.body.appendChild(dialogContainer);
  }
  return dialogContainer;
}

export function showErrorDialog(options: ShowErrorOptions) {
  const { error, fatal = false, source = '' } = options;
  const lang = options.lang || detectLang();
  // 报错弹窗音效
  playSoundSync('error');
  const message = typeof error === 'string' ? error : error.message || String(error);
  const diagnosis: DiagnosisResult = diagnoseError(message);

  const isZh = lang === 'zh';
  const title = isZh ? '应用发生错误' : 'Application Error';
  const causeLabel = isZh ? '可能原因' : 'Possible Cause';
  const solutionLabel = isZh ? '解决方法' : 'Solution';
  const copyBtn = isZh ? '复制详情' : 'Copy Details';
  const reloadBtn = isZh ? '重启应用' : 'Restart App';
  const closeBtn = isZh ? '关闭' : 'Close';
  const errorTitle = isZh ? '错误信息' : 'Error Message';
  const sourceText = source ? (isZh ? `来源: ${source}` : `Source: ${source}`) : '';

  const container = getDialogContainer();
  container.style.display = 'flex'; // 真正报错时才显示遮罩（默认 none）
  container.innerHTML = `
    <div style="
      background: #fff; border-radius: 12px; padding: 28px 32px;
      max-width: 520px; width: 90%; box-shadow: 0 8px 32px rgba(0,0,0,0.2);
      animation: nianyuErrorFadeIn 0.25s ease;
      color: #333; pointer-events: auto;
    ">
      <div style="font-size: 20px; font-weight: 600; margin-bottom: 16px;">
        ⚠️ ${title}
      </div>
      <div style="margin-bottom: 16px;">
        <div style="font-size: 13px; color: #666; margin-bottom: 4px;">${errorTitle}:</div>
        <div style="font-size: 13px; color: #e74c3c; background: #fef0ef; padding: 8px 12px; border-radius: 6px; word-break: break-word; margin-bottom: 12px;">
          ${escapeHtml(message)}
        </div>
        ${sourceText ? `<div style="font-size: 12px; color: #999; margin-bottom: 8px;">${sourceText}</div>` : ''}
        <div style="font-size: 13px; color: #666; margin-bottom: 4px;">${causeLabel}:</div>
        <div style="font-size: 14px; color: #d97706; background: #fffbeb; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px;">
          ${escapeHtml(diagnosis.cause[lang])}
        </div>
        <div style="font-size: 13px; color: #666; margin-bottom: 4px;">${solutionLabel}:</div>
        <div style="font-size: 14px; color: #059669; background: #ecfdf5; padding: 8px 12px; border-radius: 6px;">
          ${escapeHtml(diagnosis.solution[lang])}
        </div>
      </div>
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button id="nianyu-error-copy" style="
          padding: 8px 16px; font-size: 13px; border: 1px solid #d9d9d9;
          border-radius: 6px; background: #fff; color: #333; cursor: pointer;
        ">${copyBtn}</button>
        ${fatal ? `<button id="nianyu-error-reload" style="
          padding: 8px 16px; font-size: 13px; border: none;
          border-radius: 6px; background: #1677ff; color: #fff; cursor: pointer;
        ">${reloadBtn}</button>` : ''}
        <button id="nianyu-error-close" style="
          padding: 8px 16px; font-size: 13px; border: none;
          border-radius: 6px; background: #e8e8e8; color: #333; cursor: pointer;
        ">${closeBtn}</button>
      </div>
    </div>
    <style>
      @keyframes nianyuErrorFadeIn {
        from { opacity: 0; transform: scale(0.95); }
        to { opacity: 1; transform: scale(1); }
      }
    </style>
  `;

  const copyButton = document.getElementById('nianyu-error-copy');
  copyButton?.addEventListener('click', () => {
    const detailText = [
      `Error: ${message}`,
      `Cause: ${diagnosis.cause[lang]}`,
      `Solution: ${diagnosis.solution[lang]}`,
      source ? `Source: ${source}` : '',
      `Time: ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join('\n');
    navigator.clipboard.writeText(detailText).catch(() => {});
    copyButton.textContent = isZh ? '已复制' : 'Copied';
    setTimeout(() => {
      copyButton.textContent = copyBtn;
    }, 2000);
  });

  const reloadButton = document.getElementById('nianyu-error-reload');
  reloadButton?.addEventListener('click', () => {
    window.location.reload();
  });

  const closeButton = document.getElementById('nianyu-error-close');
  closeButton?.addEventListener('click', () => {
    container.style.display = 'none';
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 将错误异步写入主进程错误日志（不阻塞，失败静默）
function persistError(category: 'functional' | 'model' | 'other', message: string, detail?: string): void {
  try {
    const w = window as any;
    w.api?.logAppError?.(category, message, detail);
  } catch {
    /* 忽略：错误日志写入失败不应影响主流程 */
  }
}

// 注册全局错误监听器
export function registerGlobalErrorHandlers() {
  // 捕获未处理的 Promise rejection
  window.addEventListener('unhandledrejection', (event) => {
    const err = event.reason instanceof Error ? event.reason : new Error(String(event.reason || 'Unknown Promise rejection'));
    event.preventDefault();
    persistError('other', err.message || String(event.reason), err.stack);
    showErrorDialog({ error: err, source: 'Promise', fatal: false });
  });

  // 捕获全局运行时错误
  window.onerror = (message, source, lineno, colno, error) => {
    const err = error || new Error(String(message));
    persistError('functional', err.message || String(message), `${source}:${lineno}:${colno}\n${err.stack || ''}`);
    showErrorDialog({
      error: err,
      source: source ? `${source}:${lineno}:${colno}` : 'runtime',
      fatal: true,
    });
    // 返回 true 表示已处理，阻止默认浏览器错误提示
    return true;
  };
}
