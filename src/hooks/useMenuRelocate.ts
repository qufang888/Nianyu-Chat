import { useEffect, useRef, useState } from 'react';
import { scaledRetractMs } from './useRetract';

/**
 * useMenuRelocate —— 右键菜单「同气泡重定位」的旧隐新弹并行 Hook（v2.3.104 R3）
 *
 * 背景：菜单每气泡自持 `menuPos` state + `ctxMenu = useRetract(menuPos)`。
 * 跨气泡重定位天然并行（新泡重挂载播 `popupLinearIn`，旧泡走 useRetract 播
 * `popupLinearOut` 再卸载）；但**同气泡**二次右键时 `setMenuPos` 是非空→非空，
 * `useRetract` 仅更新 `shown`，DOM 不重挂载、动画类不重放 → inline 坐标瞬变 = 瞬移。
 *
 * 方案（架构设计 §3.2「退役快照双实例」）：同气泡重定位时——
 * 1. 返回值 `seq` +1，调用方把活菜单 portal 根 div 的 `key={seq}` 换掉，
 *    强制重挂载以重放 `popupLinearIn`（基态即正常可见，anim-off 下直接呈现基态，安全）；
 * 2. 返回值 `retiring` 携带旧坐标，调用方据此渲染**第二个 portal**
 *    （`className="ctx-menu leaving"` + `pointerEvents:'none'`）：
 *    命中 index.css 既有 `.ctx-menu.leaving` 规则（popupLinearOut 0.15s forwards +
 *    pointer-events:none）——退场动画、终态透明、不可拦截点击全部白拿，零新增动画 CSS。
 *
 * 边界（与 useRetract 的契约对齐，不触碰其本体）：
 * - 关闭路径（非空→null）完全走既有 useRetract leaving 分支，本 Hook 不干预；
 * - anim-off 总控关闭、或自定义档关闭 `ctxmenu` 分组（`data-anim-off~=ctxmenu`）时，
 *   `retiring` 恒为 null、`seq` 照常递增 → 菜单无动画直接换位（防「菜单点了不消失」前科复发）。
 *   该判断与 `useRetract.ts` 私有的 `isRetractSuppressed` 同逻辑（私有函数不可 import，故在此自写）；
 * - 快照卸载靠 `scaledRetractMs(160)` 定时器（从 useRetract import，方向「乘」已由该函数保证），
 *   **不依赖 animationend**；连续快速重定位用最新旧坐标覆盖 `retiring` 并重置定时器，
 *   任意时刻至多 1 活 + 1 退役实例，无累积；
 * - 首次打开（null→非空）不产生快照、不改变 seq（活菜单本就是新挂载，动画自然播放）；
 * - 非空→非空但坐标相同（如同一像素点二次右键）视为非重定位，不做任何事。
 *
 * @param menuPos 活菜单坐标（与 useRetract 消费的同一个 state，null = 关闭）
 * @returns `seq`（活菜单重挂载 key）与 `retiring`（退役快照坐标，null = 无）
 */
export interface MenuRelocateState {
  /** 活菜单 portal 根 div 的重挂载 key：每次同气泡重定位 +1（初始 1） */
  seq: number;
  /** 退役快照坐标；null 表示当前没有正在退场的旧菜单 */
  retiring: { x: number; y: number } | null;
}

/** 快照退场动画的基准时长：与 index.css `.ctx-menu.leaving` 的 popupLinearOut 0.15s 对齐 + 10ms 余量 */
const RETIRE_MS = 160;

export function useMenuRelocate(menuPos: { x: number; y: number } | null): MenuRelocateState {
  const [seq, setSeq] = useState(1);
  const [retiring, setRetiring] = useState<{ x: number; y: number } | null>(null);
  // 上一次的 menuPos：用 ref 承载，effect 闭包里不依赖 state，避免循环
  const prevRef = useRef<{ x: number; y: number } | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearTimer = (): void => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const prev = prevRef.current;
    prevRef.current = menuPos;

    // ⚠️ 本 effect **不返回 cleanup**（QA 第 2 轮修复 B）：若每次 run 返回 clearTimer，
    // React 会在下次 deps 变化时先执行**上一轮**的 cleanup —— 「重定位后 160ms×speed 窗口内
    // 关菜单（Esc/点外）」时，重定位那轮注册的快照卸载定时器会被误清 → retiring 永久滞留
    // state（常态 opacity:0 不可见，但随后切 anim-off 会以基态 opacity:1 显形为假菜单）。
    // 故定时器改为**显式管理**：只在重定位分支开头 clear（连续重定位重置），其余路径一律不动，
    // 由定时器自然到期卸载快照；组件卸载时的兜底清理见下方独立的 [] effect。
    // （闭包 shadow：本函数仅在 effect 体内使用，不进 cleanup，无「清理自身刚注册定时器」的矛盾。）

    // 关闭（非空→null）：走既有 useRetract leaving 分支，本 Hook 不干预。
    // 快照若还在退场，由其自身定时器收尾，不受影响（定时器未被任何 cleanup 误清）。
    if (menuPos === null) return;

    // 首次打开（null→非空）：活菜单本就是新挂载，popupLinearIn 自然播放，无需任何处理
    if (prev === null) return;

    // 非空→非空但坐标相同：非重定位，不做任何事（也不动在飞的快照定时器）
    if (prev.x === menuPos.x && prev.y === menuPos.y) return;

    // ---- 同气泡重定位：旧坐标降级为退役快照 + seq+1 强制活菜单重挂载 ----
    // suppressed 判断与 useRetract.isRetractSuppressed 同逻辑（该函数私有，不可 import）：
    // 1. 总控「全部关闭」档：documentElement 挂 .anim-off；
    // 2. 自定义档关闭 ctxmenu 分组：documentElement 写 data-anim-off（含 'ctxmenu'）。
    const root = document.documentElement;
    const suppressed =
      root.classList.contains('anim-off') ||
      (root.dataset.animOff || '').split(/\s+/).includes('ctxmenu');

    clearTimer();
    setSeq((s) => s + 1);
    if (suppressed) {
      // 无动画直接换位：不产生快照 DOM（retiring 恒 null），seq 照加
      setRetiring(null);
    } else {
      // 连续快速右键：用最新旧坐标覆盖 retiring 并重置定时器（至多 1 活 + 1 退役）
      setRetiring({ x: prev.x, y: prev.y });
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setRetiring(null);
      }, scaledRetractMs(RETIRE_MS));
    }
  }, [menuPos]);

  // 组件卸载时清理定时器，避免对已卸载组件 setState
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  return { seq, retiring };
}

export default useMenuRelocate;
