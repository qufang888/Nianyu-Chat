/**
 * v2.3.102 需求 4：统一的「跳转高亮闪动」工具。
 *
 * 背景：项目里此前有 6 处各自为政的闪动实现 —— Settings（5000ms）/ GuideView（5000ms）/
 * ChatList（内联 FLASH_MS=5000）/ ChatModelPicker（3200ms）/ MemoryPanel（只加不移，缺清理定时器）/
 * 以及 index.css 里两套不一致的 keyframe。本模块把「时长」与「播放」收敛到唯一入口：
 *   - 动画时长由 CSS 侧的 `flashPulse 1s linear 5`（= 5 秒）决定；
 *   - 类名移除时机由本模块的 `FLASH_MS` 决定，两者数值必须保持一致（均为 5000ms）。
 *
 * 受控性：本模块只增删类名，不直接触碰动画样式；因此 `.setting-flash` / `.model-flash`
 * 仍受 animControl 的「主题」动画组门禁（all-off 档与自定义档）控制，不会被绕过。
 */

/** 闪动总时长（毫秒）。与 index.css 的 `flashPulse 1s linear 5`（= 5000ms）严格对齐。 */
export const FLASH_MS = 5000;

/**
 * 每个元素当前挂起的「移除类」定时器句柄。
 * 用 WeakMap 而非 Map：元素被 GC 后句柄随键一起回收，避免长会话下的内存泄漏。
 */
const timers = new WeakMap<Element, number>();

/**
 * 在给定元素上播放一次闪动高亮。
 *
 * 幂等 / 去抖：若同一元素上已有未到期的闪动，先清掉旧定时器再重播 —— 否则连续触发时
 * 旧定时器会提前移除新加的类，导致第二次闪动「闪一下就没」。
 *
 * 重排（reflow）技巧：先 remove 再读一次 `offsetWidth`，强制浏览器提交一次样式重排，
 * 这样紧接着 add 同一个类时动画会被重新触发（否则 CSS 认为「类没变」，动画不会重播）。
 *
 * @param el  目标元素（必须已挂载到 DOM；分离节点无法播放动画）
 * @param cls 闪动类名，默认 `setting-flash`（模型卡用 `model-flash`）
 */
export function flashElement(el: HTMLElement, cls: string = 'setting-flash'): void {
  const prev = timers.get(el);
  if (prev !== undefined) window.clearTimeout(prev);

  el.classList.remove(cls);
  // 强制重排：让浏览器「忘掉」上一次的动画状态，连续闪动也能重新播放
  void el.offsetWidth;
  el.classList.add(cls);

  const handle = window.setTimeout(() => {
    el.classList.remove(cls);
    timers.delete(el);
  }, FLASH_MS);
  timers.set(el, handle);
}
