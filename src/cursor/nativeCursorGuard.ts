/**
 * v3.0.23 —— 「至少一个可见光标」硬不变量的单一实现（纯函数，零 React / Electron 依赖）。
 *
 * 背景：v3.0.21 把原生光标压制拆成两层：
 *   · HIDDEN_CLASS        由 DynamicCursor 引擎持有，空闲/移出/合成 mouseout 都会摘；
 *   · NATIVE_HIDDEN_CLASS 由「动态光标开关 + covered/dragging 覆盖关系」持有。
 * 两层各自正确，但发布/订阅时序可能错位：窗口 hide/show、窗口重建、拖拽强制结束、
 * IPC 丢失等路径会让 covered=false 永远不到达渲染端 → GATE_CLASS + NATIVE_HIDDEN_CLASS
 * 残留，而引擎 hidden=true → 原生与动态光标同时消失。
 *
 * 本模块给出可证明的不变量与兜底动作：
 *   ① 有权威门控（GATE_CLASS，说明悬浮球窗口正在出动态光标）→ 本窗允许无光标；
 *   ② 无权威门控且本窗没有可绘制字形 → 必须解除一切原生压制（两个 class 都摘），
 *      保证「全机同一时刻至少一个可见光标」；
 *   ③ 有可绘制字形 → 原生必须继续隐藏，杜绝双光标。
 *
 * 所有判断只依赖 DOM 可观测状态，便于 behavior gate 用 DOM 桩直接执行真实代码。
 */

import { GATE_CLASS, HIDDEN_CLASS, NATIVE_HIDDEN_CLASS } from './types';

/** 引擎给字形宿主打的标记（见 DynamicCursor.tsx），供本模块跨组件查询 */
export const GLYPH_MARKER_ATTR = 'data-ny-cursor-glyph';

/** 只需要 classList 的最小 DOM 形状（便于单测用桩对象驱动真实函数） */
export interface ClassListLike {
  add(className: string): void;
  remove(className: string): void;
  contains(className: string): boolean;
}

/** 只需要 body + querySelector 的最小 Document 形状 */
export interface CursorDocumentLike {
  body: { classList: ClassListLike };
  querySelector?(selector: string): unknown;
}

/**
 * 权威门控是否成立。
 * GATE_CLASS 只由主进程 covered 电平 / 拖拽电平 / 悬浮球自身门控设置，
 * 表示「本窗光标由另一个窗口的动态字形接管」，此时本窗无光标是设计内行为。
 */
export function hasAuthoritativeGate(doc: CursorDocumentLike): boolean {
  return doc.body.classList.contains(GATE_CLASS);
}

/**
 * 本窗是否真的有一枚可绘制的动态字形。
 * 依次检查：字形宿主存在、未被 visibility/display 隐藏、opacity 有效、
 * img 未因图片加载彻底失败而 display:none。
 */
export function isDynamicGlyphVisible(doc: CursorDocumentLike): boolean {
  if (typeof doc.querySelector !== 'function') return false;
  const host = doc.querySelector(`[${GLYPH_MARKER_ATTR}]`) as
    | { style?: { visibility?: string; display?: string; opacity?: string }; querySelector?: (s: string) => unknown }
    | null;
  if (!host || !host.style) return false;
  const style = host.style;
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  const opacity = Number.parseFloat(style.opacity ?? '1');
  if (!Number.isFinite(opacity) || opacity <= 0.001) return false;
  const img = host.querySelector?.('img') as { style?: { display?: string } } | null;
  if (img && img.style && img.style.display === 'none') return false;
  return true;
}

/**
 * 最后一道防线：没有权威门控、也没有可绘制字形时，立即摘掉两层原生压制。
 * @returns 是否真的做了修正（供闸门脚本断言「修复确实生效」，而不是空跑）
 */
export function restoreNativeIfNoGlyph(
  doc: CursorDocumentLike,
  glyphVisible: boolean = isDynamicGlyphVisible(doc)
): boolean {
  if (glyphVisible) return false;          // 动态字形在画 → 原生必须隐藏，否则双光标
  if (hasAuthoritativeGate(doc)) return false; // 权威门控在 → 由悬浮球出光标，本窗必须无光标
  const had =
    doc.body.classList.contains(NATIVE_HIDDEN_CLASS) || doc.body.classList.contains(HIDDEN_CLASS);
  doc.body.classList.remove(NATIVE_HIDDEN_CLASS);
  doc.body.classList.remove(HIDDEN_CLASS);
  return had;
}

/**
 * 渲染端统一不变量入口：非压制态调用一次即可自愈任何陈旧残留。
 * suppress = 动态光标开关 && (covered || dragging)；压制态由悬浮球出光标，不能在这里解除。
 */
export function applyCursorNeverBlankGuard(doc: CursorDocumentLike, suppress: boolean): boolean {
  if (suppress) return false;
  return restoreNativeIfNoGlyph(doc, isDynamicGlyphVisible(doc));
}

/**
 * 无条件解除本窗的全部原生压制（引擎 unmount / 动态光标关闭 / 窗口隐藏时调用）。
 * 与 restoreNativeIfNoGlyph 的区别：不看门控，用于「本窗即将没有动态光标」的确定性收尾。
 */
export function clearAllNativeSuppression(doc: CursorDocumentLike): void {
  doc.body.classList.remove(NATIVE_HIDDEN_CLASS);
  doc.body.classList.remove(HIDDEN_CLASS);
}
