import React, { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n/I18nContext';
import { useRetract, RETRACT_MS } from '../hooks/useRetract';

/**
 * 「选择本地图片」引导弹窗（v2.3.97）—— 包裹 `<input type="file">` 之前的最后一步。
 *
 * 为什么需要它：`<input type="file">` 一旦 `.click()`，弹出的就是**操作系统原生文件框**
 * （在深色主题下是刺眼的白底黑字系统对话框，与软件风格割裂）。
 * 本组件的做法是：先弹一个**主题内**的引导弹窗（带入场动画，承接用户的点击动线），
 * 用户在弹窗里点「点击选择文件」才触发隐藏 input 的 `.click()`。
 * 于是系统文件框只在**最后一步**闪现一次，用户已经先在软件自己的弹窗里完成了
 * 「我要去挑文件」这个动作，割裂感显著降低。
 *
 * 弹窗同时提供「把图片拖到这里」的提示 —— 但**刻意不做拖放实现**：
 * 拖到隐藏 input 上浏览器不会给可靠的路径（Electron 32 起 File.path 已移除，
 * 需webUtils.getPathForFile，而那要求拿到真实 File 对象）。
 * 因此这里只给出与项目既有拖拽导入一致的操作提示文案。
 */
export interface ImagePickGuideProps {
  open: boolean;
  /** 允许多选（朋友圈配图需要） */
  multiple?: boolean;
  /** 触发真实 input 的回调；由调用方持有 input ref 并调用 .click() */
  onTriggerInput: () => void;
  onClose: () => void;
}

const ImagePickGuide: React.FC<ImagePickGuideProps> = ({
  open,
  multiple = false,
  onTriggerInput,
  onClose,
}) => {
  const { t } = useI18n();
  // 分组传 'theme'：与 ConfirmDialog 同理（.modal-card 已由 modal-anim 登记在 theme 组）
  const { shown, leaving } = useRetract(open ? true : null, RETRACT_MS, 'theme');
  const okRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    if (!leaving) onClose();
  }, [leaving, onClose]);

  // 打开时记住触发元素 + 焦点落到主按钮
  useEffect(() => {
    if (!open) return;
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const id = window.requestAnimationFrame(() => okRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // 关闭后焦点归还
  useEffect(() => {
    if (open || shown) return;
    const el = restoreRef.current;
    restoreRef.current = null;
    if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
  }, [open, shown]);

  // Esc 取消；Tab 在两个按钮间成环
  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (!leaving) onTriggerInput();
        return;
      }
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const a = cancelRef.current;
      const b = okRef.current;
      if (a && b) (document.activeElement === a ? b : a).focus();
    },
    [close, leaving, onTriggerInput]
  );

  if (!shown) return null;

  return createPortal(
    <div
      className={`modal-mask imagepick-mask${leaving ? ' leaving' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="modal-card imagepick-guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="imagepick-title"
        onKeyDown={handleKey}
      >
        <div className="modal-title" id="imagepick-title">
          {t('filepicker.title')}
        </div>
        <div className="modal-desc">{t('imagepick.guideDesc')}</div>
        {/* 拖放提示区：与项目既有拖拽导入一致的文案 */}
        <div className="imagepick-dropzone" aria-hidden="true">
          <div className="imagepick-dropzone-icon">{multiple ? '🖼️' : '📁'}</div>
          <div className="imagepick-dropzone-text">{t('imagepick.dropHint')}</div>
        </div>
        <div className="imagepick-actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn-ghost"
            onClick={close}
            disabled={leaving}
          >
            {t('common.cancel')}
          </button>
          <button
            ref={okRef}
            type="button"
            className="btn-primary"
            onClick={onTriggerInput}
            disabled={leaving}
          >
            {t('imagepick.browse')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ImagePickGuide;