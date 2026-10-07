import { useEffect, useRef, useState } from 'react';
import { readAnimSpeed } from '../utils/animControl';

/**
 * 缩入（关闭）动画的**基准**时长（毫秒，1× 速度下）。
 * 与 index.css 中 `popupLinearOut` 的 `0.15s` 对齐，留 10ms 余量后卸载 DOM，
 * 确保动画一定播完（与 floating-ball.ts 悬浮球菜单的 180ms 延迟卸载同一思路）。
 *
 * v2.3.97：CSS 已改为 `calc(0.15s * var(--anim-speed, 1))`，本 Hook 的等待时长**必须同步缩放**
 * （{@link scaledRetractMs}，注意是**乘**倍率而非除，理由见该函数注释）。这是「动画受控不能破坏」
 * 的关键一环：
 *   - 速度调快（CSS 变快）而 JS 不变 → 动画播完还多等一会儿，用户感觉「有点迟钝」（可接受）；
 *   - 速度调慢（CSS 变慢）而 JS 不变 → **动画播到一半元素就被卸载，表现为「菜单点了不消失」**
 *     ——这是本 Hook 必须在 v2.3.97 跟着改的原因。
 * 所以 {@link scaledRetractMs} 是强制的，不是可选优化。
 */
export const RETRACT_MS = 160;

/**
 * 按当前动画速度倍率缩放延迟卸载时长。
 *
 * ⚠️ 方向必须是**乘**而不是除 —— 这是本函数最容易写反、且写反后果严重的地方：
 *   `--anim-speed` 是**时长倍率**（CSS 侧写的是 `calc(0.16s * var(--anim-speed, 1))`），
 *   1.5 表示「很慢」= 时长 ×1.5。若 JS 这里写成 `base / speed`，
 *   则 speed=1.5 时 JS 只等 107ms 而 CSS 要播 240ms —— 动画播到一半元素就被卸载，
 *   表现为**「菜单点了不消失」**（与 v2.3.97 之前「缩入被禁用导致卡住」同一类故障）。
 *   验证脚本 `scripts/verify-anim-speed.mjs` 的 H7 组断言专门锁死这个方向。
 *
 * 倍率从 `documentElement` 上的 `--anim-speed` 读取 —— 该变量由
 * `animControl.applyAnimControl` **同步**写入每个 document 自己的根元素（主窗 / 悬浮球 / 通知窗
 * 三者互不相同），正是各自动效的唯一真源。这样做的好处是**不需要改本 Hook 的参数签名**，
 * 16 处既有调用点零改动，且倍率在定时器触发时读到的一定是当前值。
 *
 * @param baseMs 基准时长（毫秒）
 * @param doc 目标文档，缺省 `document`（SSR / 测试环境安全：拿不到就按 1× 处理）
 */
export function scaledRetractMs(baseMs: number = RETRACT_MS, doc?: Document | null): number {
  const speed = readAnimSpeed(doc);
  // 上限 10s：倍率被 clamp 到 ≤ 6 时 160*6 = 960ms，仍属「慢但可接受」；
  // 这里再兜一道，防止未来把 clamp 上限放宽后出现「菜单十几秒才消失」的尴尬。
  return Math.min(10000, Math.max(16, Math.round(baseMs * speed)));
}

/**
 * 判断「缩入动画是否已被禁用」，即此时必须把缩入时长降为 0 直接卸载，否则会出
 * 「菜单点了不消失」的问题——被禁用的关键帧/过渡会让元素停留在**动画初始态**
 * （`opacity: 1`），也就是菜单仍完整可见地杵在屏幕上 RETRACT_MS 才被卸载。
 * （悬浮球那套能免疫是因为它用 `transition`：基态本就是隐藏态，`transition:none`
 * 等于瞬间跳到隐藏态；而 `animation` 的基态是显示态，语义相反。）
 *
 * 两种禁用来源都要认：
 * 1. **「全部关闭」档**：`ThemeContext` 走 `applyAnimControl`，在 `animMode === 'all-off'`
 *    时给 `document.documentElement` 挂 `.anim-off`，其 `.anim-off * { animation:none!important }`
 *    会把缩入关键帧整个抹掉。
 * 2. **「自定义」档关闭了某个分组**：此时**不挂** `.anim-off`（自定义档刻意不挂，
 *    以免误杀流式豁免与其它仍开启的分组），而是由 `applyAnimControl` 写入
 *    `data-anim-off="<被关分组…>"`，并注入 `html[data-anim-off~="<groupId>"] <选择器>
 *    { animation:none!important }` 门禁抹掉本组缩入动画。`.anim-off` 不存在，
 *    所以必须额外读 `data-anim-off` 才能识别。
 *
 * 直接读根元素的类名/属性：二者都是同步的、无需引入 React 上下文，且是各自动画的唯一真源。
 *
 * v2.3.97（弹窗自绘化）：`groupId` 改为**参数传入**。此前本函数把分组硬编码为 `ctxmenu`，
 * 于是所有调用方都被迫归到 `ctxmenu` 分组——这对菜单/下拉是对的，但自绘弹窗
 * （`ConfirmDialog` / `FilePickerModal`）语义上属于独立的 `modal` 分组：
 * 用户在自定义档里关掉「右键菜单与下拉」不应连带关掉弹窗的退场动画，反之亦然。
 * 故此处接受分组 id，缺省仍为 `ctxmenu`，**保证既有 16 处调用点零改动**。
 *
 * @param groupId 动画分组 id（必须是 `animControl.ts` 的 `ANIM_GROUPS` 里真实存在的 id，
 *                否则自定义档的门禁选择器不会命中本元素，退场动画将无法被单独关闭）
 */
function isRetractSuppressed(groupId: string): boolean {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  if (root.classList.contains('anim-off')) return true;
  const off = root.dataset.animOff || '';
  return off.split(/\s+/).includes(groupId);
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
 * @param durationMs 缩入动画的**基准**时长（1× 速度下），默认 {@link RETRACT_MS}。
 *                   实际等待时长由 {@link scaledRetractMs} 按当前速度倍率缩放后得出。
 * @param groupId 所属动画分组（`ANIM_GROUPS` 的 id）。默认 `'ctxmenu'`，
 *                即**既有全部调用方的行为与升级前完全一致**（零改动）；
 *                自绘弹窗传 `'modal'` 以便独立开关。
 * @returns `shown`（渲染用值，可能在关闭期间短暂非空）与 `leaving`（缩入中标记）
 */
export function useRetract<T>(
  value: T | null,
  durationMs: number = RETRACT_MS,
  groupId: string = 'ctxmenu'
): RetractState<T> {
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
    // 缩入动画已被禁用（总控关闭，或单控下本分组关闭）：跳过整个缩入阶段
    // 直接卸载（详见 isRetractSuppressed 注释）
    if (isRetractSuppressed(groupId)) {
      shownRef.current = null;
      setState({ shown: null, leaving: false });
      return clearTimer;
    }
    setState((prev) => (prev.leaving ? prev : { shown: shownRef.current as T, leaving: true }));
    // v2.3.97：按当前速度倍率缩放等待时长，必须与 CSS 的 calc(… * var(--anim-speed)) 同步，
    // 否则速度调慢时会在动画播完前就把 DOM 摘掉（菜单点了不消失）。
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      shownRef.current = null;
      setState({ shown: null, leaving: false });
    }, scaledRetractMs(durationMs));
    return clearTimer;
  }, [value, durationMs, groupId]);

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
