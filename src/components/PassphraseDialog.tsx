import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRetract, RETRACT_MS } from '../hooks/useRetract';

/**
 * 自绘口令对话框（v3.0.19）—— 创建态展示一次性明文口令 / 还原态输入口令。
 *
 * 严格复用 ConfirmDialog 的范式：createPortal 到 body + `.modal-mask/.modal` 三件套 +
 * `useRetract(..., 'theme')`（theme 组已登记 modal-* 与 quick-import-overlay）+ 焦点锁 +
 * Esc / Enter + 遮罩关闭。所有文案由宿主经 props 传入（组件内无裸中文，全部走 i18n）。
 * 全程无 window.alert / confirm / prompt。
 */
export interface PassphraseDialogProps {
  mode: 'display' | 'input';
  open: boolean;
  /** display 模式：待展示的一次性口令；input 模式不传。 */
  passphrase?: string;
  /** input 模式：错误行（已 i18n）。 */
  error?: string;
  /** input 模式：验证中禁用按钮。 */
  busy?: boolean;
  title: string;
  description: string;
  warning?: string;
  copyLabel?: string;
  copiedLabel?: string;
  doneLabel?: string;
  submitLabel?: string;
  cancelLabel?: string;
  showLabel?: string;
  hideLabel?: string;
  onCopy?: () => void;
  onClose: () => void;
  onSubmit?: (pass: string) => void;
}

const PassphraseDialog: React.FC<PassphraseDialogProps> = ({
  mode,
  open,
  passphrase = '',
  error = '',
  busy = false,
  title,
  description,
  warning = '',
  copyLabel = '',
  copiedLabel = '',
  doneLabel = '',
  submitLabel = '',
  cancelLabel = '',
  showLabel = '',
  hideLabel = '',
  onCopy,
  onClose,
  onSubmit,
}) => {
  const { shown, leaving } = useRetract(open ? true : null, RETRACT_MS, 'theme');
  const titleId = useId();
  const descId = useId();
  const errId = useId();

  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const copyRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const submitRef = useRef<HTMLButtonElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // 打开：记录触发元素并把焦点放到主操作上（display → 关闭按钮；input → 口令输入框）
  useEffect(() => {
    if (!open) return;
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;
    setValue('');
    setReveal(false);
    setCopied(false);
    const id = window.requestAnimationFrame(() => {
      if (mode === 'display') closeRef.current?.focus();
      else inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, mode]);

  // 关闭：焦点归还原触发元素
  useEffect(() => {
    if (open || shown) return;
    const el = restoreRef.current;
    restoreRef.current = null;
    if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
  }, [open, shown]);

  const doSubmit = useCallback(() => {
    if (busy || mode !== 'input' || !onSubmit) return;
    onSubmit(value);
  }, [busy, mode, onSubmit, value]);

  const doCopy = useCallback(() => {
    const text = passphrase;
    const fallback = (): void => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* 复制不可用时仍展示反馈，用户可手动选中口令文本 */
      }
      document.body.removeChild(ta);
    };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        void navigator.clipboard.writeText(text).catch(fallback);
      } else {
        fallback();
      }
    } catch {
      fallback();
    }
    setCopied(true);
    onCopy?.();
  }, [passphrase, onCopy]);

  // 焦点锁：Tab / Shift+Tab 在弹窗内的可聚焦元素间循环；Esc 取消；Enter 主操作。
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (mode === 'input') doSubmit();
        else onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables: HTMLElement[] =
        mode === 'display'
          ? [copyRef.current as HTMLElement | null, closeRef.current as HTMLElement | null].filter(
              (x): x is HTMLElement => !!x
            )
          : [
              inputRef.current as HTMLElement | null,
              toggleRef.current as HTMLElement | null,
              cancelRef.current as HTMLElement | null,
              submitRef.current as HTMLElement | null,
            ].filter((x): x is HTMLElement => !!x);
      if (focusables.length === 0) return;
      const active = document.activeElement;
      const idx = focusables.indexOf(active as HTMLElement);
      e.preventDefault();
      // 未落在环内时进第一个；否则按方向循环
      if (idx < 0) focusables[0].focus();
      else if (e.shiftKey) focusables[(idx - 1 + focusables.length) % focusables.length].focus();
      else focusables[(idx + 1) % focusables.length].focus();
    },
    [mode, doSubmit, onClose]
  );

  const handleMaskClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget && !leaving) onClose();
    },
    [leaving, onClose]
  );

  if (!shown) return null;

  const isDisplay = mode === 'display';

  return createPortal(
    <div className={`modal-mask pass-mask${leaving ? ' leaving' : ''}`} onClick={handleMaskClick}>
      <div
        className="modal pass-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onKeyDown={handleKeyDown}
        style={{ width: 460 }}
      >
        <div className="modal-head pass-head">
          <span id={titleId} className="confirm-title">
            {title}
          </span>
        </div>
        <div className="modal-body pass-body">
          <p id={descId} className="confirm-message">
            {description}
          </p>

          {isDisplay ? (
            <>
              <div className="pass-value" title="">
                {passphrase}
              </div>
              <button ref={copyRef} type="button" className="btn-ghost pass-copy" onClick={doCopy}>
                {copied ? copiedLabel : copyLabel}
              </button>
              {warning && <p className="pass-warning">{warning}</p>}
            </>
          ) : (
            <>
              <div className="pass-input-row">
                <input
                  ref={inputRef}
                  type={reveal ? 'text' : 'password'}
                  className="pass-input"
                  value={value}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setValue(e.target.value)}
                  aria-invalid={!!error}
                  aria-describedby={error ? errId : undefined}
                />
                <button
                  ref={toggleRef}
                  type="button"
                  className="btn-ghost pass-toggle"
                  onClick={() => setReveal((v) => !v)}
                  aria-label={reveal ? hideLabel : showLabel}
                >
                  {reveal ? hideLabel : showLabel}
                </button>
              </div>
              {error && (
                <p id={errId} className="pass-error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
        <div className="modal-foot pass-foot">
          {!isDisplay && (
            <button
              ref={cancelRef}
              type="button"
              className="btn-ghost confirm-cancel-btn"
              onClick={onClose}
              disabled={leaving || busy}
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={isDisplay ? closeRef : submitRef}
            type="button"
            className="confirm-confirm-btn is-normal"
            onClick={isDisplay ? onClose : doSubmit}
            disabled={leaving || (!isDisplay && busy)}
          >
            {isDisplay ? doneLabel : submitLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default PassphraseDialog;
