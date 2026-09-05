import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
  tooltip?: React.ReactNode; // 悬停该选项时显示的说明（如模型能力）
}

interface SelectMenuProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  placeholder?: string;
}

// 常量（硬编码，说明用途）
const ITEM_HEIGHT = 34; // 单个选项高度（px），须与 index.css .select-menu-item 高度一致
const MAX_VISIBLE = 8;  // 面板最多同时可见选项数，超出则内部滚动

/**
 * SelectMenu - 纯 DOM 自定义下拉选择器
 *
 * 取代原生 <select>：原生 <select> 的弹层是 OS 级控件，CSS `cursor:none` 无法穿透，
 * 且自定义光标 Canvas 位于 BrowserWindow 内、无法覆盖 OS 弹层，导致动态光标失效、出现割裂的原生光标。
 * 本组件的下拉面板是普通 DOM（portal 到 body），受 body.cursor-hidden 管控，自定义光标可正常覆盖。
 *
 * 特性：键盘上下/回车/ESC、外部点击关闭、滚动/缩放自动重定位、当前项滚动入可视区。
 */
const SelectMenu: React.FC<SelectMenuProps> = ({
  value, onChange, options, disabled, className, style, title, placeholder,
}) => {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; below: boolean }>({
    top: 0, left: 0, width: 0, below: true,
  });
  const [tip, setTip] = useState<{ node: React.ReactNode; x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value);
  const display = current ? current.label : (placeholder ?? '');

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const estH = Math.min(options.length, MAX_VISIBLE) * ITEM_HEIGHT + 8;
    // 下方空间足够则向下展开，否则向上
    const below = r.bottom + estH <= window.innerHeight || r.top > window.innerHeight - r.bottom;
    setRect({ top: r.bottom, left: r.left, width: r.width, below });
  }, [options.length]);

  const openMenu = useCallback(() => {
    if (disabled) return;
    reposition();
    const idx = options.findIndex((o) => o.value === value);
    setActiveIndex(idx >= 0 ? idx : 0);
    setOpen(true);
  }, [disabled, options, value, reposition]);

  const close = useCallback(() => { setOpen(false); setTip(null); }, []);

  const choose = useCallback((opt: SelectOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
  }, [onChange]);

  // 外部点击 + 键盘
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current && triggerRef.current.contains(t)) return;
      if (panelRef.current && panelRef.current.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => {
          let n = i;
          for (let k = 0; k < options.length; k++) {
            n = (n + 1) % options.length;
            if (!options[n].disabled) break;
          }
          return n;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => {
          let n = i;
          for (let k = 0; k < options.length; k++) {
            n = (n - 1 + options.length) % options.length;
            if (!options[n].disabled) break;
          }
          return n;
        });
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const opt = options[activeIndex];
        if (opt && !opt.disabled) choose(opt);
      }
    };
    const onScroll = () => reposition();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, options, activeIndex, choose, reposition]);

  // 当前项滚动进可视区
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const item = panel.querySelector(`[data-idx="${activeIndex}"]`) as HTMLElement | null;
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`select-menu-trigger${className ? ' ' + className : ''}`}
        style={style}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openMenu())}
      >
        <span className="select-menu-value">{display}</span>
        <span className="select-menu-caret" aria-hidden>▾</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="select-menu-panel"
          role="listbox"
          style={{
            top: rect.below ? rect.top : undefined,
            bottom: rect.below ? undefined : (window.innerHeight - rect.top),
            left: rect.left,
            width: rect.width,
          }}
        >
          {options.map((opt, i) => (
            <div
              key={opt.value}
              data-idx={i}
              role="option"
              aria-selected={opt.value === value}
              className={
                'select-menu-item' +
                (i === activeIndex ? ' active' : '') +
                (opt.value === value ? ' selected' : '') +
                (opt.disabled ? ' disabled' : '')
              }
              onMouseEnter={(e) => {
                if (!opt.disabled) setActiveIndex(i);
                if (opt.tooltip) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const toRight = r.right + 230 < window.innerWidth;
                  setTip({ node: opt.tooltip, x: toRight ? r.right + 6 : r.left - 236, y: r.top });
                } else {
                  setTip(null);
                }
              }}
              onMouseLeave={() => setTip(null)}
              onMouseDown={(e) => { e.preventDefault(); if (!opt.disabled) choose(opt); }}
            >
              {opt.label}
            </div>
          ))}
        </div>,
        document.body,
      )}

      {tip && createPortal(
        <div className="select-menu-tip" style={{ top: tip.y, left: tip.x }} role="tooltip">
          {tip.node}
        </div>,
        document.body,
      )}
    </>
  );
};

export default SelectMenu;
