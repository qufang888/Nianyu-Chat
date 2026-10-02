import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';

interface ModelErrorItem {
  id: string;
  code: string;
  message: string;
  detail?: string;
  cause: string;
  solution: string;
  lang: string;
  roleName?: string;
  expanded: boolean;
}

// 模型回复错误气泡：全局唯一实例，主窗/小窗都挂载。
// 订阅主进程推送的 app:modelError（非致命模型错误），右上角浮层展示；
// 设计要点：外层容器 pointer-events:none，仅卡片本体 pointer-events:auto，
// 因此空区域点击会穿透到下层 UI，绝不会遮挡/阻断聊天输入框。
// 15 秒自动消失；可点右上 × 关闭；点击卡片展开「原因 / 解决方案 / 错误码」。
const ErrorBubble: React.FC = () => {
  const { t } = useI18n();
  const [items, setItems] = useState<ModelErrorItem[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const timers = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const off = api.onModelError?.((data) => {
      const id = `err_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      setItems((prev) => [
        ...prev,
        {
          id,
          code: data.code || 'exception',
          message: data.message || t('errorBubble.unknown'),
          detail: data.detail,
          cause: data.cause || '',
          solution: data.solution || '',
          lang: data.lang || 'zh',
          roleName: data.roleName,
          expanded: false,
        },
      ]);
      // 15 秒自动消失
      const timer = window.setTimeout(() => {
        timers.current.delete(id);
        setItems((prev) => prev.filter((x) => x.id !== id));
      }, 15000);
      timers.current.set(id, timer);
    });
    return () => {
      off?.();
      timers.current.forEach((tid) => window.clearTimeout(tid));
      timers.current.clear();
    };
  }, [t]);

  const close = (id: string) => {
    const tid = timers.current.get(id);
    if (tid) {
      window.clearTimeout(tid);
      timers.current.delete(id);
    }
    setItems((prev) => prev.filter((x) => x.id !== id));
  };

  const toggle = (id: string) => {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, expanded: !x.expanded } : x)));
  };

  // 快捷复制完整错误信息（v2.3.38）：标题 + 消息 + 原因 + 解决方案 + 错误码 + 详情
  const copyError = async (it: ModelErrorItem) => {
    const parts = [
      `${t('errorBubble.modelReply')}${it.roleName ? ` · ${it.roleName}` : ''}`,
      it.message,
      it.cause ? `${t('errorBubble.cause')}: ${it.cause}` : '',
      it.solution ? `${t('errorBubble.solution')}: ${it.solution}` : '',
      `${t('errorBubble.code')}: ${it.code}`,
      it.detail ? `detail: ${it.detail}` : '',
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(parts.join('\n'));
      setCopiedId(it.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === it.id ? null : cur)), 1500);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };

  if (!items.length) return null;

  return createPortal(
    <div className="error-bubble-layer">
      {items.map((it) => (
        <div
          key={it.id}
          className={`error-bubble ${it.expanded ? 'error-bubble-open' : ''}`}
          onClick={() => toggle(it.id)}
          role="alert"
        >
          <div className="error-bubble-head">
            <span className="error-bubble-icon">⚠️</span>
            <span className="error-bubble-title">
              {it.roleName ? `${it.roleName} · ${t('errorBubble.modelReply')}` : t('errorBubble.modelReply')}
            </span>
            {/* 快捷复制错误信息（v2.3.38）：复制成功后短暂显示 ✓ */}
            <button
              className="error-bubble-close"
              aria-label={t('errorBubble.copy')}
              title={t('errorBubble.copy')}
              onClick={(e) => {
                e.stopPropagation();
                void copyError(it);
              }}
              style={copiedId === it.id ? { color: '#2e9e5b' } : undefined}
            >
              {copiedId === it.id ? '✓' : '⧉'}
            </button>
            <button
              className="error-bubble-close"
              aria-label={t('errorBubble.close')}
              onClick={(e) => {
                e.stopPropagation();
                close(it.id);
              }}
            >
              ×
            </button>
          </div>
          <div className="error-bubble-msg">{it.message}</div>
          {it.expanded && (
            <div className="error-bubble-detail" onClick={(e) => e.stopPropagation()}>
              {it.cause && (
                <div className="error-bubble-row">
                  <b>{t('errorBubble.cause')}</b>
                  <p>{it.cause}</p>
                </div>
              )}
              {it.solution && (
                <div className="error-bubble-row">
                  <b>{t('errorBubble.solution')}</b>
                  <p>{it.solution}</p>
                </div>
              )}
              <div className="error-bubble-code">
                {t('errorBubble.code')}: {it.code}
                {it.detail ? ` · ${it.detail.slice(0, 240)}` : ''}
              </div>
            </div>
          )}
          <div className="error-bubble-hint">{it.expanded ? t('errorBubble.clickCollapse') : t('errorBubble.clickExpand')}</div>
        </div>
      ))}
    </div>,
    document.body
  );
};

export default ErrorBubble;
