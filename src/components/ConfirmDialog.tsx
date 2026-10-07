import React, { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useRetract, RETRACT_MS } from '../hooks/useRetract';

/**
 * 自绘确认框（v2.3.97）——替换 Electron 的 `dialog.showMessageBox`。
 *
 * 为什么要自绘：原生确认框在深色主题下是**刺眼的白底黑字系统对话框**，
 * 且它关闭后还会破坏渲染器的输入框焦点路由（键击无法进入任何输入框，
 * 详见 `electron/main.ts` 中旧 `app:confirm` 的注释）。改成主题内自绘后，
 * 这两个问题一并根除：配色跟随 14 套主题，且焦点始终在渲染器内循环。
 *
 * 样式：**刻意复用项目现成的 `.modal-mask` + `.modal` 类**，不另造容器样式，
 * 这样入场动画与动效开关（animControl）能自动继承，无需在本组件里写入场关键帧。
 *
 * 无障碍（WCAG AA）：
 *  - `role="dialog"` + `aria-modal="true"` + `aria-labelledby` / `aria-describedby`
 *  - 打开时焦点移到**确认按钮**（破坏性操作最常被点「取消」，但把焦点放在确认按钮上
 *    是对话框的通行惯例；`danger` 时仍放确认按钮，靠颜色区分而非靠焦点躲避）
 *  - 关闭时焦点归还原触发元素
 *  - Esc 取消、Enter 确认
 *  - **焦点锁在弹窗内**（Tab / Shift+Tab 在两个按钮间循环，不会跑到背后的输入框）
 */
export interface ConfirmDialogProps {
  /** 是否展开（false 时走退场动画后再卸载） */
  open: boolean;
  /** 正文内容（已是本地化后的文案） */
  message: string;
  /** 标题；不传则用默认的「请确认」（由调用方 i18n 后传入） */
  title?: string;
  /** 破坏性操作：确认按钮用 --color-danger，且默认文案更强调不可恢复 */
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  message,
  title,
  danger = false,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}) => {
  // useRetract：v2.3.97 起分组参数化（详见 hooks/useRetract.ts 注释）。
  // 分组传 'theme'：本组件根节点就是 .modal-mask，而 modal-anim 已把
  // `.modal-mask` / `.modal` / `.modal-card` 统一登记在 animControl 的 theme 组
  // （该组管「通用 UI 外观与交互」，与 .hint-tip / .drop-hint 同族）。
  // 必须与该登记保持一致 —— 否则自定义档关掉 theme 组时，本弹窗的退场门禁
  // 不会命中，退场动画将无法被单独关闭（流式恒开的豁免同样不能被波及）。
  const { shown, leaving } = useRetract(open ? true : null, RETRACT_MS, 'theme');
  const titleId = useId();
  const descId = useId();

  const panelRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  /** 打开前记录 activeElement，关闭后把焦点还回去（无障碍要求） */
  const restoreRef = useRef<HTMLElement | null>(null);

  // 打开：记住触发元素 + 焦点移到确认按钮
  useEffect(() => {
    if (!open) return;
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;
    // 等一帧，确保按钮已挂载
    const id = window.requestAnimationFrame(() => confirmRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // 关闭（含退场结束）：把焦点还给触发元素
  useEffect(() => {
    if (open || shown) return;
    const el = restoreRef.current;
    restoreRef.current = null;
    if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
  }, [open, shown]);

  /**
   * 焦点锁：Tab / Shift+Tab 在「取消」「确定」两个按钮之间循环。
   * 用 keydown 拦截而不是靠 DOM 顺序 —— 因为弹窗被 portal 到 body，
   * 若用户先前把焦点放在背景输入框上，原生 Tab 会跑到背景里去。
   */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key === 'Enter') {
      // 只在没有按钮自带焦点语义冲突时接管；按钮上 Enter 会触发 click，
      // 这里统一交给 confirm，避免「按两下」（keydown 确认 + click 再确认）。
      e.preventDefault();
      e.stopPropagation();
      onConfirm();
      return;
    }
    if (e.key !== 'Tab') return;
    const a = cancelRef.current;
    const b = confirmRef.current;
    if (!a || !b) return;
    // 两个可聚焦元素：无论当前在哪个，按 Tab 都跳到另一个（形成环）
    const active = document.activeElement;
    e.preventDefault();
    if (active === a) b.focus();
    else a.focus();
  }, [onCancel, onConfirm]);

  // 点击遮罩 = 取消（与主流对话框行为一致；点面板内部不关闭）
  const handleMaskClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onCancel();
    },
    [onCancel]
  );

  if (!shown) return null;

  return createPortal(
    <div
      className={`modal-mask confirm-mask${leaving ? ' leaving' : ''}`}
      onClick={handleMaskClick}
      // 退场期间禁止再次点击（避免连点两次触发两次 onCancel/onConfirm）
      onMouseDown={(e) => {
        if (leaving) e.preventDefault();
      }}
    >
      <div
        ref={panelRef}
        className={`modal confirm-dialog${danger ? ' danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={descId}
        onKeyDown={handleKeyDown}
        style={{ width: 420 }}
      >
        <div className="modal-head confirm-head">
          {/* 危险操作用图标 + 文字双重提示，不单独依赖颜色传达状态 */}
          {danger && (
            <span className="confirm-icon" aria-hidden="true">
              !
            </span>
          )}
          <span id={titleId} className="confirm-title">
            {title}
          </span>
        </div>
        <div className="modal-body confirm-body">
          <p id={descId} className="confirm-message">
            {message}
          </p>
        </div>
        <div className="modal-foot confirm-foot">
          <button
            ref={cancelRef}
            type="button"
            className="btn-ghost confirm-cancel-btn"
            onClick={onCancel}
            disabled={leaving}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`confirm-confirm-btn ${danger ? 'is-danger' : 'is-normal'}`}
            onClick={onConfirm}
            disabled={leaving}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ConfirmDialog;