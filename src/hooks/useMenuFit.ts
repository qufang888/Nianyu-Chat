import { useLayoutEffect, useState } from 'react';

export interface FitPos {
  left: number;
  top: number;
}

/**
 * 计算菜单在视口内的落位，确保菜单**完全可见、不被裁切**：
 * 以锚点 (anchorX, anchorY) 为菜单左上角起点；若向右溢出视口则翻转到光标左侧，
 * 若向下溢出则翻转到光标上方；极端情况（菜单比视口还高/宽）则贴边并预留 margin。
 *
 * 与「右键菜单图层在界面之上、不应被裁切」的诉求一致——宁可翻转到光标另一侧，
 * 也不让菜单被主界面 / 窗口边界截断（Electron 窗口本身会裁切超出窗口的内容，
 * 故贴合视口是「保证完整可见」的唯一稳妥做法）。
 *
 * @param anchorX 锚点 X（视口坐标，通常为右键点 / 触发按钮的右下角）
 * @param anchorY 锚点 Y
 * @param menuW 菜单实测宽
 * @param menuH 菜单实测高
 * @param margin 与视口边缘的最小留白
 */
export function fitMenuRect(
  anchorX: number,
  anchorY: number,
  menuW: number,
  menuH: number,
  margin = 8
): FitPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchorX;
  let top = anchorY;
  // 向右溢出 → 翻到光标左侧
  if (left + menuW > vw - margin) {
    left = anchorX - menuW;
    if (left < margin) left = margin; // 仍越界则贴左缘
  }
  // 向下溢出 → 翻到光标上方
  if (top + menuH > vh - margin) {
    top = anchorY - menuH;
    if (top < margin) top = margin; // 仍越界则贴顶缘
  }
  return { left: Math.max(margin, left), top: Math.max(margin, top) };
}

/**
 * 给定锚点与菜单元素 ref，在布局阶段测量真实尺寸并算出贴合视口的落位（paint 前完成，无闪烁）。
 * 菜单首次渲染用估计值占位，useLayoutEffect 实测后纠正。
 *
 * @param anchor 锚点（视口坐标）；为 null 时不计算（菜单未打开）
 * @param ref 菜单根元素 ref
 */
export function useMenuFit(
  anchor: { x: number; y: number } | null,
  ref: { current: HTMLElement | null }
): FitPos | null {
  const [pos, setPos] = useState<FitPos | null>(null);
  useLayoutEffect(() => {
    if (!anchor || !ref.current) {
      setPos(null);
      return;
    }
    const el = ref.current;
    const w = el.offsetWidth || 160;
    const h = el.offsetHeight || 200;
    setPos(fitMenuRect(anchor.x, anchor.y, w, h));
  }, [anchor?.x, anchor?.y, ref]);
  return pos;
}
