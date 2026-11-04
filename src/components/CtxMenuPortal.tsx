import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fitMenuRect, type FitPos } from '../hooks/useMenuFit';

interface Props {
  /** 锚点（视口坐标，右键点或触发按钮的右下角） */
  anchor: { x: number; y: number };
  /** 是否处于缩入（离场）阶段：加 .leaving 播放 popupLinearOut 且禁用指针事件 */
  leaving?: boolean;
  /** 层级（活菜单 300 / 退役快照 299） */
  zIndex?: number;
  /** 追加到 .ctx-menu 之后的类名（如 .list-menu，复用既有配色与弹出动画） */
  className?: string;
  /** 补充 / 覆盖的内联样式（如抵消 .list-menu 的 right:10px 用 right:'auto'） */
  extraStyle?: React.CSSProperties;
  children: React.ReactNode;
}

/**
 * 右键菜单的 Portal 容器（统一解决「超出主界面被裁切」）。
 *
 * - 渲染到 document.body：彻底脱离任何 overflow:hidden 祖先（如 .list-pane），不被内部容器裁切；
 * - position:fixed + 按**实测尺寸**贴合视口（fitMenuRect 翻转防溢出），菜单边缘超出视口时翻转到
 *   光标另一侧，保证完整可见；
 * - 沿用 .ctx-menu 的 popupLinearIn（弹出）/ .ctx-menu.leaving 的 popupLinearOut（缩入）动画，
 *   受「动效总开关 / ctxmenu 分组」统一控制；
 * - 先用估计值占位、useLayoutEffect 实测后纠正，paint 前完成，无可见闪烁。
 */
export const CtxMenuPortal: React.FC<Props> = ({
  anchor,
  leaving = false,
  zIndex = 300,
  className,
  extraStyle,
  children,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<FitPos>(() => fitMenuRect(anchor.x, anchor.y, 160, 200));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(fitMenuRect(anchor.x, anchor.y, el.offsetWidth, el.offsetHeight));
  }, [anchor.x, anchor.y]);

  return createPortal(
    <div
      ref={ref}
      className={`ctx-menu${className ? ` ${className}` : ''}${leaving ? ' leaving' : ''}`}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        zIndex,
        pointerEvents: leaving ? 'none' : undefined,
        ...extraStyle,
      }}
    >
      {children}
    </div>,
    document.body
  );
};
