import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
// v2.3.90：面板缩入（关闭）动画
import { useRetract } from '../hooks/useRetract';

// 可输入 + 可滚动建议列表的组合框（v2.3.39）
//
// 取代浏览器原生 <datalist>：原生下拉的弹层由操作系统/浏览器接管，无法加滚动条，
// 长列表（模型列表 / 音色列表 / 标签）只能靠键盘硬翻，无法用鼠标滚轮浏览。
//
// 本组件复用项目既有的 SelectMenu 面板样式（.select-menu-panel：max-height 280px +
// overflow-y: auto + 高 z-index），并 portal 到 body + fixed 定位 → 天然带滚动条，
// 且不会被模态/设置面板的滚动容器裁剪。
//
// 特性：输入即过滤（不区分大小写）、↑/↓ 移动高亮、回车选中、Esc 只关下拉（不冒泡）、
//       点击面板外关闭、resize/scroll 自动重定位、高亮项自动滚入可视区、
//       openSignal 自增信号可让外部（如「刷新列表」按钮）主动展开。
// 可选：enterToSelect=false（回车不选中建议，交给使用方自行处理，如标签的「回车=添加」）、
//       onKeyDown（使用方键盘钩子，先于内部逻辑执行；若已 preventDefault 则内部跳过）。
const ITEM_HEIGHT = 34; // 与 .select-menu-item 高度对齐，用于估算面板展开方向
const MAX_VISIBLE = 8;  // 面板最多同时可见项数（与 .select-menu-panel 的 max-height 对齐）

export interface ComboBoxProps {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  openSignal?: number; // 自增信号：变化时自动展开（刷新列表后调用）
  style?: React.CSSProperties;
  title?: string;
  disabled?: boolean;
  enterToSelect?: boolean; // 默认 true；false=回车不选中建议（透给 onKeyDown）
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export const ComboBox: React.FC<ComboBoxProps> = ({
  value, onChange, options, placeholder, openSignal, style, title, disabled, enterToSelect = true, onKeyDown,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; below: boolean }>({
    top: 0, left: 0, width: 0, below: true,
  });
  // v2.3.90：关闭时先播缩入动画再卸载（与 SelectMenu 同一模式）。
  // retract 值带上 shown.length 判定：过滤到 0 条时面板本就不可见，若只在 open 转 null 时才缩入，
  // 「无结果」状态下点外部关闭会闪出一个空面板 160ms。故以「实际应渲染」为唯一真源。
  const panelUi = useRetract(open && shown.length > 0 ? rect : null);

  // 输入即过滤（不区分大小写）；为空则显示全部
  const q = value.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;

  const reposition = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const estH = Math.min(Math.max(shown.length, 1), MAX_VISIBLE) * ITEM_HEIGHT + 8;
    // 下方空间足够则向下展开，否则向上
    const below = r.bottom + estH <= window.innerHeight || r.top > window.innerHeight - r.bottom;
    setRect({ top: r.bottom, left: r.left, width: r.width, below });
  }, [shown.length]);

  const openPanel = useCallback(() => {
    if (disabled || options.length === 0) return; // 无列表不弹
    reposition();
    const idx = shown.findIndex((o) => o === value);
    setActive(idx >= 0 ? idx : 0);
    setOpen(true);
  }, [disabled, options.length, shown, value, reposition]);

  // 刷新列表后自动展开（openSignal 变化）
  useEffect(() => {
    if (!openSignal) return;
    inputRef.current?.focus();
    const t = window.setTimeout(() => openPanel(), 0); // 等一帧，确保布局稳定后再定位
    return () => window.clearTimeout(t);
  }, [openSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // 过滤结果变化时把高亮重置到首项
  useEffect(() => { setActive(0); }, [q]);

  // 外部点击关闭 + 滚动/缩放重定位
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (inputRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onMove = () => reposition();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, reposition]);

  // 键盘上下移动时把高亮项滚入可视区
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const item = panel.querySelector(`[data-idx="${active}"]`) as HTMLElement | null;
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  return (
    <>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        title={title}
        disabled={disabled}
        style={style}
        onChange={(e) => { onChange(e.target.value); if (!open) openPanel(); }}
        onFocus={() => openPanel()}
        onClick={() => openPanel()}
        onKeyDown={(e) => {
          // 使用方钩子优先（如标签的「回车=添加」）；已 preventDefault 则内部不再处理
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!open) { openPanel(); return; }
            setActive((i) => (shown.length ? (i + 1) % shown.length : 0));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) { openPanel(); return; }
            setActive((i) => (shown.length ? (i - 1 + shown.length) % shown.length : 0));
          } else if (e.key === 'Enter') {
            if (enterToSelect && open && shown[active] !== undefined) {
              e.preventDefault();
              onChange(shown[active]);
              setOpen(false);
            }
          } else if (e.key === 'Escape' && open) {
            // 仅关闭下拉：stopPropagation 防止 ESC 冒泡到 window 连带关闭外层弹窗
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {panelUi.shown &&
        createPortal(
          <div
            ref={panelRef}
            className={`select-menu-panel${panelUi.leaving ? ' leaving' : ''}`}
            role="listbox"
            style={{
              top: panelUi.shown.below ? panelUi.shown.top + 2 : undefined,
              bottom: panelUi.shown.below ? undefined : window.innerHeight - panelUi.shown.top + 2,
              left: panelUi.shown.left,
              width: panelUi.shown.width,
            }}
          >
            {shown.map((m, i) => (
              <div
                key={m}
                data-idx={i}
                role="option"
                aria-selected={m === value}
                title={m}
                className={'select-menu-item' + (i === active ? ' active' : '') + (m === value ? ' selected' : '')}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // 保持输入框焦点，避免 blur 抢先触发
                  onChange(m);
                  setOpen(false);
                }}
              >
                {m}
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  );
};

export default ComboBox;
