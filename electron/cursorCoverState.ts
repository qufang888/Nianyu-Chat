/**
 * 动态光标「覆盖关系（covered）」与「面板可交互态」的**单一真源**（纯函数，零 Electron 依赖）。
 *
 * 为什么抽成独立模块（v2.3.126 QA 打回 P1）：
 *   ① 此前主进程轮询（200ms）与 hover 启动沿的即时推送**各写了一套谓词**——hover 沿无条件
 *      `send('main:cursor-window', true)`，而轮询算的是 `owner!=='main' && inMainNow`。
 *      光标停在面板内、但主窗矩形不含该点时，轮询算出 false → 「推 true → 下轮推 false →
 *      hover 再推 true」形成 5Hz 永久振荡（1.2 秒 24 条 IPC），主窗/小窗动态光标反复被隐藏 → 闪烁。
 *      根治办法 = **谓词同源 + 只在变化沿推送**（本模块）。
 *   ② 纯函数可被 scripts/verify-cursor-cover-state.mjs 用本地 typescript 转译后**直接执行**
 *      （行为断言真正驱动被测代码，而不是在脚本里复刻一份「看起来一样」的逻辑）。
 *
 * 矩形语义（务必与主进程/渲染端保持一致）：
 *   - 面板：传**不透明命中区**（面板窗 bounds 四边内缩 PANEL_PAD，面板 DOM 就是 inset 14）——
 *     owner 判定与 covered 判定用**同一套矩形**，保证「光标在面板不透明区」时 owner 仍是 'panel'，
 *     而「光标在面板透明边距」时 owner 归下层窗口 → 该区域不会一个光标都没有。
 *   - 球窗 / 菜单窗：传**整窗矩形**近似（它们的透明边距只有 4~10px）。
 *   - 主窗 / 小窗：整窗矩形。
 */

export const PANEL_PAD = 14;                 // 面板 DOM 相对面板窗的内边距（与渲染端 src/floating-ball.ts 同步）
export const PANEL_INTERACTIVE_HYSTERESIS = 3; // 面板可交互态的迟滞宽度（px）
/**
 * 球 DOM 相对球窗左上角的内边距（球窗 68×68，球 DOM 60×60 位于 (4,4)-(64,64)）。
 * 三处必须一致：主进程 electron/floatingBall.ts（原 BALL_PAD 常量）、渲染端 src/floating-ball.ts
 * 的 BALL_L / BALL_T、本模块。改任一处都要同步另两处。
 */
export const BALL_PAD = 4;

export interface CoverRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 覆盖关系输入：各窗矩形传 null 表示「不可见/不存在」 */
export interface CoverInput {
  cursorX: number;
  cursorY: number;
  /**
   * 球窗的**不透明命中区** = 球窗 bounds 四边内缩 BALL_PAD（= 球 DOM 实际范围 60×60）。
   * 为什么球要内缩而菜单不内缩：
   *   - 球：球窗外圈 4px 是**穿透区**（窗口 forward:true，OS 光标来自下层窗口）。若把整窗矩形
   *     当成球的不透明区，这 4px 窄条的 owner 会是 'ball' → 轮询 level 推 ball:cursor-window=true
   *     → **轮询无法自愈**；一旦渲染端 DOM mouseleave 在快速移动/穿透切换时序里丢失，
   *     该窄条会同时出现「下层原生光标 + 球窗动态字形」= 双光标窄条。内缩后 owner 归下层窗口，
   *     轮询 level 推 false → 球窗 setInteractive(false) → 门控打开 → 窄条只剩下层原生光标。
   *   - 菜单：菜单窗**不挂 CustomCursor**（无动态光标），天然不存在双光标，且菜单 DOM 几乎铺满
   *     窗体（无有效透明边距），故按整窗矩形近似即可，不做内缩。
   */
  ballRect: CoverRect | null;
  /** 菜单窗整窗矩形（不内缩，原因见 ballRect 注释） */
  menuRect: CoverRect | null;
  /** 面板**不透明命中区**（已内缩 PANEL_PAD） */
  panelRect: CoverRect | null;
  /** 主窗整窗矩形 */
  mainRect: CoverRect | null;
  /** 小窗整窗矩形 */
  miniRect: CoverRect | null;
  /** 拖球中（dragTimer 非空）→ 球窗恒独占 */
  dragging: boolean;
}

export type CursorOwner = 'ball' | 'panel' | 'menu' | 'mini' | 'main' | null;

export interface CoverState {
  owner: CursorOwner;
  /** 主窗动态光标是否应被门控隐藏（被悬浮球某窗压住） */
  main: boolean;
  /** 小窗动态光标是否应被门控隐藏 */
  mini: boolean;
}

/** 点是否落在矩形内（左闭右开） */
export function pointInRect(px: number, py: number, r: CoverRect | null): boolean {
  if (!r) return false;
  return px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height;
}

/** 矩形四边内缩 pad（pad=0 时返回等值副本） */
export function insetRect(r: CoverRect, pad: number): CoverRect {
  return {
    x: r.x + pad,
    y: r.y + pad,
    width: Math.max(0, r.width - pad * 2),
    height: Math.max(0, r.height - pad * 2),
  };
}

/** 矩形四边外扩 pad（迟滞用） */
export function expandRect(r: CoverRect, pad: number): CoverRect {
  return {
    x: r.x - pad,
    y: r.y - pad,
    width: r.width + pad * 2,
    height: r.height + pad * 2,
  };
}

/**
 * 光标所有权（整机只有一个动态光标）。
 * 优先级链（与 v2.3.117 一致）：拖拽中 → 球 > 菜单 > 球(窗内) > 面板 > 小窗 > 主窗。
 * 注意「面板」用的是**不透明命中区**：光标停在面板透明边距时，面板不接管光标，
 * 光标归下层窗口 → 透明边距区域不会出现「一个光标都没有」的死区。
 */
export function computeOwner(input: CoverInput): CursorOwner {
  if (input.dragging) return 'ball';
  if (pointInRect(input.cursorX, input.cursorY, input.menuRect)) return 'menu';
  if (pointInRect(input.cursorX, input.cursorY, input.ballRect)) return 'ball';
  if (pointInRect(input.cursorX, input.cursorY, input.panelRect)) return 'panel';
  if (pointInRect(input.cursorX, input.cursorY, input.miniRect)) return 'mini';
  if (pointInRect(input.cursorX, input.cursorY, input.mainRect)) return 'main';
  return null;
}

/**
 * 覆盖关系单一真源：owner + 主窗/小窗的 covered 判定。
 * - main：owner 存在且不是 'main'，且光标确实落在主窗矩形内（被悬浮球某窗压住主窗）。
 * - mini：owner 是 ball/panel/menu（悬浮球侧）且光标落在小窗矩形内。
 * owner 为 'main'/'mini' 时该窗自身即光标 owner，不应被自己网关掉（故 main 显式排除 'main'）。
 */
export function computeCoveredState(input: CoverInput): CoverState {
  const owner = computeOwner(input);
  const inMain = pointInRect(input.cursorX, input.cursorY, input.mainRect);
  const inMini = pointInRect(input.cursorX, input.cursorY, input.miniRect);
  const main = owner !== null && owner !== 'main' && inMain;
  const mini = (owner === 'ball' || owner === 'panel' || owner === 'menu') && inMini;
  return { owner, main, mini };
}

/**
 * 变化沿推送：只返回**与上次缓存不同**的值（true / false 都返回）。
 * prev 为 null 表示「首次」→ 首次必然推送（把真实状态告诉渲染端）。
 * 绝不能无条件推 true、也不能无条件把缓存写成 true —— 那正是 P1 振荡的根因。
 */
export function diffCoverState(
  prev: { main: boolean | null; mini: boolean | null },
  next: { main: boolean; mini: boolean }
): { main?: boolean; mini?: boolean } {
  const out: { main?: boolean; mini?: boolean } = {};
  if (prev.main !== next.main) out.main = next.main;
  if (prev.mini !== next.mini) out.mini = next.mini;
  return out;
}

/**
 * 面板「可交互态」判定（带迟滞）：
 * - 进入判定用不透明命中区（inset 矩形）；
 * - 退出判定用不透明命中区**再外扩 3px** 的矩形；
 * 迟滞避免指针在面板边缘来回移动时反复切换可交互态（切一次就派发一次合成 mouseout）。
 */
export function computePanelInteractive(
  cursorX: number,
  cursorY: number,
  opaqueRect: CoverRect | null,
  wasInteractive: boolean
): boolean {
  if (!opaqueRect) return false;
  const test = wasInteractive ? expandRect(opaqueRect, PANEL_INTERACTIVE_HYSTERESIS) : opaqueRect;
  return pointInRect(cursorX, cursorY, test);
}
