/**
 * DynamicCursor —— 动态光标的 React 包装层（v2.3.126 重做）
 * ============================================================================
 * 职责边界（刻意做得很薄）：
 *   1. 读 `useTheme().settings.customCursor` → 归一化成引擎配置；
 *   2. 驱动引擎实例的生命周期（enabled 变化时挂载 / 卸载；其余配置变化只更新配置）；
 *   3. 用 `createPortal` 把**两层**渲染到 document.body。
 *
 * 为什么必须 portal 到 body：
 *   `.app-root` 上有 transform / backdrop-filter，会形成合成层，把 fixed 定位的
 *   光标层「困」在内部，导致 z-index 2147483646/2147483647 的光标被下拉面板
 *   （z-index 2147483645）盖住。挂到 body 后两层处于同一图层堆叠上下文。
 *
 * 两层的分工：
 *   · 字形层（DOM div + img）：z-index 2147483647。位置只在指针事件里同步写入
 *     transform → 「显示位置 == 点击位置」，零帧延迟。
 *   · 特效层（Canvas）：z-index 2147483646。只画拖尾 + 粒子，走 rAF。
 */

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../theme/ThemeContext';
import { isGroupEnabled, getAnimSpeed } from '../utils/animControl';
import type { AppSettings } from '../types';
import cursorPngUrl from '../assets/cursor/cursor.png';
import { CursorEngine } from './cursorEngine';
import type { CursorConfig } from './types';
import {
  DEFAULT_CURSOR_SIZE,
  DEFAULT_HOTSPOT_X,
  DEFAULT_HOTSPOT_Y,
  MAX_PARTICLES,
  MAX_TRAIL_POINTS,
} from './types';

/** 把 settings 里的 customCursor 归一化成引擎配置 */
function buildConfig(settings: AppSettings | null): CursorConfig {
  const c = settings?.customCursor;
  const animSpeed = getAnimSpeed(settings);
  const lerpSpeed = Math.max(
    0.05,
    Math.min(0.5, Math.max(0.05, Math.min(0.5, c?.lerpSpeed ?? 0.25) / Math.max(0.1, animSpeed)))
  );
  return {
    enabled: !!c?.enabled,
    // 动画门控：'all-off' 档或自定义档关闭「自定义光标」分组时，拖尾/粒子停发、淡入淡出一步到位
    animEnabled: isGroupEnabled(settings, 'cursor'),
    animSpeed,
    lerpSpeed,
    trailEnabled: c?.trailEnabled !== false,
    trailMaxLength: Math.min(MAX_TRAIL_POINTS, c?.trailMaxLength ?? MAX_TRAIL_POINTS),
    particlesEnabled: c?.particlesEnabled !== false,
    maxParticles: Math.min(MAX_PARTICLES, c?.maxParticles ?? MAX_PARTICLES),
    hoverScale: Math.max(1, Math.min(1.5, c?.hoverScale ?? 1.25)),
    idleHideMs: Math.max(500, Math.min(300000, c?.idleHideMs ?? 5000)),
    cursorSize: Math.max(16, Math.min(64, c?.cursorSize ?? DEFAULT_CURSOR_SIZE)),
    hotspotX: Math.max(0, Math.min(1, c?.hotspotX ?? DEFAULT_HOTSPOT_X)),
    hotspotY: Math.max(0, Math.min(1, c?.hotspotY ?? DEFAULT_HOTSPOT_Y)),
    image: (c?.image || '').trim(),
  };
}

/**
 * 动态光标（主窗 / 小窗 / 悬浮球三处共用同一实现）。
 */
const DynamicCursor: React.FC = () => {
  const { settings } = useTheme();
  const enabled = !!settings?.customCursor?.enabled;

  const engineRef = useRef<CursorEngine | null>(null);
  const configRef = useRef<CursorConfig | null>(null);
  const glyphHostRef = useRef<HTMLDivElement | null>(null);
  const fxCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // ① 配置同步：settings 变化（含其它窗口广播）时更新引擎配置
  useEffect(() => {
    const cfg = buildConfig(settings);
    configRef.current = cfg;
    engineRef.current?.updateConfig(cfg);
  }, [settings]);

  // ② 引擎生命周期：仅在「启用状态」变化时挂载 / 卸载（其余配置变化不重挂，避免闪烁）
  useEffect(() => {
    if (!enabled) {
      engineRef.current?.unmount();
      engineRef.current = null;
      return;
    }
    const glyphHost = glyphHostRef.current;
    const fxCanvas = fxCanvasRef.current;
    if (!glyphHost || !fxCanvas) return;
    const cfg = configRef.current ?? buildConfig(settings);
    const engine = new CursorEngine({ config: cfg, builtinImageUrl: cursorPngUrl });
    engineRef.current = engine;
    engine.mount({ glyphHost, fxCanvas });
    return () => {
      engine.unmount();
      if (engineRef.current === engine) engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // 未启用时不渲染任何层（原生光标照常）
  if (!enabled) return null;

  const layerStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    pointerEvents: 'none',
  };

  return createPortal(
    <>
      {/* 特效层（拖尾 + 粒子，rAF 驱动） */}
      <canvas ref={fxCanvasRef} style={{ ...layerStyle, zIndex: 2147483646 }} />
      {/* 字形层（DOM，本体）—— 位置由引擎在指针事件里同步写入 transform */}
      <div ref={glyphHostRef} style={{ ...layerStyle, zIndex: 2147483647 }} />
    </>,
    document.body
  );
};

export default DynamicCursor;
