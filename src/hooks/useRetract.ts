import { useEffect, useRef, useState } from 'react';

/**
 * 缩入（关闭）动画时长（毫秒）。
 * 与 index.css 中 `popupLinearOut` 的 `0.15s` 对齐，留 10ms 余量后卸载 DOM，
 * 确保动画一定播完（与 floating-ball.ts 悬浮球菜单的 180ms 延迟卸载同一思路）。
 */
export const RETRACT_MS = 160;

/**
 * 动效总开关是否已关闭（`ThemeContext` 在 `settings.enableAnimations === false` 时
 * 给 `document.documentElement` 挂 `.anim-off`）。
 *
 * 关闭时必须把缩入时长降为 0，否则会出「菜单点了不消失」的问题：
 * 总控规则 `.anim-off * { animation: none !important }` 会把缩入关键帧整个抹掉，
 * 元素停留在未播放的初始态（`opacity: 1`）—— 也就是**菜单仍完整可见地杵在屏幕上
 * 160ms** 才被卸载。（悬浮球那套能免疫是因为它用 `transition`：基态本就是隐藏态，
 * `transition:none` 等于瞬间跳到隐藏态；而 `animation` 的基态是显示态，语义相反。）
 * 故此处直接读根元素类名——它是总控的唯一真源，且是同步的，无需引入 React 上下文依赖。
 */
function isAnimOff(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('anim-off');
}

export interface RetractState<T> {
  /**
   * 实际用于渲染的值。
   * - 打开中：等于最新传入值
   * - 缩入中：保持「最后一次非空值」（菜单定位所需的坐标/锚点不会因关闭而丢失）
   * - 缩入结束：置为 null，调用方据此卸载 DOM
   */
  shown: T | null;
  /** 是否处于缩入（离场）阶段：调用方需给根节点追加 `leaving` 类（其 CSS 含 `pointer-events:none`） */
  leaving: boolean;
}

/**
 * useRetract —— 菜单/弹层「缩入后退场」通用 Hook
 *
 * 背景：项目里绝大多数菜单只有弹出动画（`popupLinearIn`），关闭时是 setState(null) 直接卸载，
 * 视觉上「瞬间消失」，与弹出不不对称。本 Hook 提供与弹出对称的缩入动画：
 * 参照 `src/floating-ball.ts` 悬浮球右键菜单的做法（先移除 `.show` 让过渡播完，
 * 约 180ms 后再移除 DOM），在 React 里以「延迟卸载」实现。
 *
 * 契约：
 * 1. `value` 传 `null` / `undefined` 表示关闭，**不得传 `false`**（布尔请写 `open ? true : null`）；
 * 2. 缩入期间 `shown` 保留最后一次值，故坐标/锚点不会闪回 (0,0)；
 * 3. 缩入期间 `leaving === true`，调用方负责加 `leaving` 类（CSS 里带 `pointer-events:none`，
 *    避免透明菜单拦截点击）——动画本身是纯 CSS 类动画，故被总控 `.anim-off` 自动禁用；
 * 4. 缩入途中重新打开会取消待卸载定时器，且元素从未离开 DOM，因此无闪烁、无双重渲染；
 * 5. 定时器在依赖变化或组件卸载时清理，不会对已卸载组件 setState。
 *
 * @param value 打开状态 + 定位数据（菜单坐标 / 锚点 rect / id），关闭时传 null
 * @param durationMs 缩入动画时长，默认 {@link RETRACT_MS}
 * @returns `shown`（渲染用值，可能在关闭期间短暂非空）与 `leaving`（缩入中标记）
 */
export function useRetract<T>(value: T | null, durationMs: number = RETRACT_MS): RetractState<T> {
  const [state, setState] = useState<RetractState<T>>({ shown: value ?? null, leaving: false });
  // 用 ref 承载「最后一次非空值」：effect 闭包里不依赖 state，避免把 state 放进依赖造成循环
  const shownRef = useRef<T | null>(value ?? null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    /** 清理待卸载定时器（依赖变化 / 重新打开 / 组件卸载时都要调用） */
    const clearTimer = (): void => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    // ---- 打开（含缩入途中重新打开）：撤销待卸载定时器，元素全程未离开 DOM → 无闪烁 ----
    if (value !== null && value !== undefined) {
      clearTimer();
      shownRef.current = value;
      setState((prev) => (prev.shown === value && !prev.leaving ? prev : { shown: value, leaving: false }));
      return clearTimer;
    }

    // ---- 关闭 ----
    if (shownRef.current === null) {
      // 本就没打开过：无需缩入
      setState((prev) => (prev.leaving ? { shown: null, leaving: false } : prev));
      return clearTimer;
    }
    // 动效总控关闭：缩入动画被 CSS 全局禁用，跳过整个缩入阶段直接卸载（详见 isAnimOff 注释）
    if (isAnimOff()) {
      shownRef.current = null;
      setState({ shown: null, leaving: false });
      return clearTimer;
    }
    setState((prev) => (prev.leaving ? prev : { shown: shownRef.current as T, leaving: true }));
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      shownRef.current = null;
      setState({ shown: null, leaving: false });
    }, durationMs);
    return clearTimer;
  }, [value, durationMs]);

  // 组件卸载时清理定时器，避免对已卸载组件 setState
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  return state;
}

export default useRetract;
