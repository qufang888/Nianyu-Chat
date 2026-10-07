import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { playNodeBannerSound } from '../utils/sound';
import { animMs } from '../utils/animControl';

export interface NodeBannerData {
  title: string; // 横幅主文案（剧情节点名称）
  subtitle?: string; // 副文案（如「跳转到剧情节点」「已从该节点开始新剧情」）
}

/**
 * 剧情节点横幅（v2.3.37）：屏幕上方居中弹出，
 * 时间线 = 弹入 → 停留 3.5s → 渐隐 → 卸载（onDone 回调清 state）。
 * 弹出瞬间播放 achievement-unlock 音效（跟随音效总开关/音量）。
 *
 * v2.3.97：弹入/渐隐的动画时长由 1s / 0.6s 改为 0.2s / 0.2s（线性、无 scale），
 * 故下面三个定时器**必须与 CSS 时长同步**，否则会出现「动画早已播完但仍在空等」
 * 的拖沓感。三个常量与 index.css 的 nodeBannerIn / nodeBannerOut 保持 1:1 对应。
 *
 * ## v2.3.97 界面动效速度：为什么是函数而不是模块级常量
 * CSS 侧已改成 `calc(0.2s * var(--anim-speed, 1))`，本文件的 IN/OUT 必须**乘同一个倍率**，
 * 否则用户调快/调慢时横幅会与自己的动画脱节：
 *   - 0.5×：CSS 0.1s 播完，JS 仍等 200ms → 横幅**僵在原地傻等 0.1s**；
 *   - 2×  ：CSS 要 0.4s，JS 只等 200ms → **动画没播完就被卸载** → 横幅一闪而过。
 *
 * 选**函数**（而非 `useMemo` 或模块级常量）的理由：
 *   1. `readAnimSpeed()` 读的是 `documentElement.style` 上的当前值，**不是 React state**，
 *      没有可订阅的依赖 —— `useMemo` 的依赖数组里放什么都会拿到过期值；
 *   2. 横幅的 useEffect 依赖是 `[banner?.title, banner?.subtitle, banner]`（刻意不含速度），
 *      因为「速度变了就把已显示的横幅重新计时」是错的：横幅已经弹出了一半，
 *      改速度不该让它跳回起点重播；
 *   3. 「用的时候现算」是最不易腐化的写法 —— 没有需要在两处同步维护的缓存值。
 *   这与 `useRetract.scaledRetractMs()` 是同一思路（那里也是调用时现算）。
 */

/** 停留时长（与动画无关，纯产品节奏）—— **不缩放**，快档下不能一闪而过、慢档下不能久到以为卡死 */
const HOLD_MS = 3500;

export const NodeBanner: React.FC<{ banner: NodeBannerData | null; onDone: () => void }> = ({
  banner,
  onDone,
}) => {
  const [visible, setVisible] = useState(false); // 已渲染实例（用于渐隐离场动画）
  const [phase, setPhase] = useState<'hidden' | 'in' | 'hold' | 'out'>('hidden');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (!banner) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setVisible(true);
    setPhase('in');
    playNodeBannerSound();
    // 与 CSS 严格 1:1：index.css 的 nodeBannerIn / nodeBannerOut 基准均为 0.2s，
    // 且已被 v2.3.97 改成 calc(0.2s * var(--anim-speed, 1))，故这里用 animMs(0.2)。
    // ⚠️ 改 CSS 侧时长或倍率方案时，**必须同步改这里的 0.2**（animMs 的入参）。
    const inMs = animMs(0.2);
    const outMs = animMs(0.2);
    // 弹入完成 → 进入停留期
    timers.current.push(setTimeout(() => setPhase('hold'), inMs));
    // 弹入 + 停留 → 渐隐
    timers.current.push(setTimeout(() => setPhase('out'), inMs + HOLD_MS));
    // 渐隐结束后彻底卸载
    timers.current.push(
      setTimeout(() => {
        setVisible(false);
        setPhase('hidden');
        onDone();
      }, inMs + HOLD_MS + outMs)
    );
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [banner?.title, banner?.subtitle, banner]);

  if (!banner || !visible) return null;
  return createPortal(
    <div className={`node-banner phase-${phase}`} role="status">
      <div className="node-banner-card">
        <div className="node-banner-sub">{banner.subtitle || '\u00A0'}</div>
        <div className="node-banner-title">{banner.title}</div>
      </div>
    </div>,
    document.body
  );
};
