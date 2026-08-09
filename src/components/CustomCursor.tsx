/**
 * CustomCursor - 高性能自定义 Canvas 光标系统
 *
 * 架构：顶层全屏透明单层 Canvas 渲染光标与全部特效
 * 性能优先：对象池复用、空闲停帧、FPS 自动降级、脏区域重绘
 *
 * 硬性限制：
 * - 拖尾轨迹点位 ≤ 10
 * - 同时存在粒子 ≤ 8
 * - 禁止模糊滤镜/径向渐变发光等高开销操作
 * - 静止 300ms 停止 rAF 循环（仍保留静态光标，省 CPU）
 * - FPS < 52 自动降级（关粒子 → 减拖尾）
 *
 * 光标始终以固定显示尺寸绘制（与 PNG 原始 512 解耦），避免被画成巨幅图像。
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../theme/ThemeContext';
import type { AppSettings } from '../types';
import cursorPngUrl from '../assets/cursor/cursor.png';

// ===== 类型定义 =====

interface TrailPoint {
  x: number;
  y: number;
  alpha: number;     // 0~1 透明度
  scale: number;      // 缩放比例（用于液态消散）
}

interface Particle {
  x: number;
  y: number;
  vx: number;        // x 方向速度
  vy: number;        // y 方向速度
  life: number;      // 剩余生命（帧数）
  maxLife: number;   // 总生命（帧数）
  size: number;      // 半径
  active: boolean;   // 是否在用
}

type CursorState = 'normal' | 'hover' | 'grabbing';

// ===== 常量（硬编码值说明） =====

// 光标显示尺寸（长边像素），与 PNG 原始 512 解耦。默认 28，可通过设置调节（16~64）。
// 此值由 syncConfig 从 settings.customCursor.cursorSize 读取，此处仅作 fallback。
const DEFAULT_CURSOR_SIZE = 28;
// 热点参考尺寸：hotspotX/HotspotY 存储的是「在 28 像素基础尺寸下」从图像左上角算起的像素偏移。
// 运行时按 (cfg.cursorSize / HOTSPOT_BASE_SIZE) 等比缩放，保证调整光标大小后热点相对位置保持一致。
const HOTSPOT_BASE_SIZE = 28;
// 热点范围：hotspotX/HotspotY 相对图像左上角的像素偏移（基础尺寸下）。运行时乘以 baseScale。
// 由于 PNG 箭头尖端几乎在 (8,0)/512 ≈ (0.44,0) 处，默认填 1 表示「尖端贴近左上角」，
// 让用户用标准箭头光标的视觉习惯。最大值 64 留出小范围微调余地。
const HOTSPOT_MIN = 0;
const HOTSPOT_MAX = 64;
const IDLE_STOP_MS = 300;           // 静止超过此时间停止 rAF（毫秒），仍保留静态光标
const TRAIL_IDLE_MS = 200;          // 拖尾静止后不再新增点位（毫秒）
const MAX_TRAIL_POINTS = 10;        // 拖尾硬上限
const MAX_PARTICLES = 8;            // 粒子硬上限
const FPS_DEGRADE_THRESHOLD = 52;   // 低于此帧率触发降级
const FPS_CHECK_INTERVAL = 60;      // 每 60 帧检查一次 FPS
const INTERACTION_CHECK_THROTTLE_MS = 80; // 元素交互检测节流间隔
const DIRTY_MARGIN = 44;            // 脏区域扩展边距（像素）
const OFFSCREEN = -9000;            // 初始离屏哨兵值
// 淡入淡出常量（窗口切换时光标丝滑过渡，避免突然弹出/消失的割裂感）
const FADE_IN_MS = 200;             // 聚焦时淡入时长（毫秒）
const FADE_OUT_MS = 150;            // 失焦时淡出时长（毫秒）

// ===== 组件 =====

const CustomCursor: React.FC = () => {
  const { settings } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ===== 引用（避免闭包 stale）=====
  const rafIdRef = useRef<number>(0);
  const runningRef = useRef(false);
  const mouseXRef = useRef(OFFSCREEN);     // 原生鼠标位置
  const mouseYRef = useRef(OFFSCREEN);
  const renderXRef = useRef(OFFSCREEN);    // lerp 缓动后的渲染位置
  const renderYRef = useRef(OFFSCREEN);
  const lastMoveTimeRef = useRef(0);        // 最后移动时间戳
  const lastFrameTimeRef = useRef(0);       // 上一帧时间戳（FPS 计算 + dt）
  const scheduleIdleHideRef = useRef<() => void>(() => {}); // 空闲隐藏调度（useEffect 中赋值）
  const fpsWindowStartRef = useRef(0);      // FPS 统计窗口起点
  const fpsFrameCountRef = useRef(0);       // 帧计数器
  const fpsRef = useRef(60);                // 当前估算 FPS
  const degradedRef = useRef(0);            // 降级等级：0=正常 1=关粒子 2=减拖尾
  const cursorStateRef = useRef<CursorState>('normal');
  const hiddenRef = useRef(false);          // 是否隐藏（失焦/右键菜单/空闲隐藏）
  const mouseInsideRef = useRef(false);      // 鼠标是否真正位于本窗口内（多窗口协调核心）
  const cfgRef = useRef<{ [k: string]: number | boolean }>({});
  const hideTimerRef = useRef<number>(0);   // 空闲隐藏定时器

  // ===== 淡入淡出状态（窗口切换丝滑过渡）=====
  type FadeState = 'none' | 'in' | 'out';
  const opacityRef = useRef(1);             // 当前全局透明度 0~1
  const fadeStateRef = useRef<FadeState>('none'); // 当前淡入淡出状态
  const fadeStartRef = useRef(0);           // 淡入/淡出开始时间戳

  // ===== 对象池（预分配，永不销毁）=====
  const trailPoolRef = useRef<TrailPoint[]>(
    Array.from({ length: MAX_TRAIL_POINTS }, () => ({
      x: 0, y: 0, alpha: 0, scale: 1,
    }))
  );
  const trailLenRef = useRef(0);         // 当前活跃轨迹点数
  const lastTrailAddRef = useRef(0);     // 最后添加轨迹点时间

  const particlePoolRef = useRef<Particle[]>(
    Array.from({ length: MAX_PARTICLES }, () => ({
      x: 0, y: 0, vx: 0, vy: 0,
      life: 0, maxLife: 0, size: 0, active: false,
    }))
  );

  // ===== 图片资源 =====
  const cursorImgRef = useRef<HTMLImageElement | null>(null);
  const imgLoadedRef = useRef(false);

  // ===== 脏区域追踪（减少重绘范围）=====
  const prevDirtyRectsRef = useRef<{ x: number; y: number; w: number; h: number }[]>([]);

  // ===== 工具函数 =====

  /** 读取当前配置到引用（配置变化时调用，避免每帧读 React state） */
  const syncConfig = useCallback((s: AppSettings | null) => {
    if (!s?.customCursor) return;
    const c = s.customCursor;
    cfgRef.current = {
      enabled: c.enabled,
      lerpSpeed: Math.max(0.05, Math.min(0.5, c.lerpSpeed ?? 0.25)),
      trailEnabled: c.trailEnabled !== false,
      trailMaxLength: Math.min(MAX_TRAIL_POINTS, c.trailMaxLength ?? 10),
      particlesEnabled: c.particlesEnabled !== false,
      maxParticles: Math.min(MAX_PARTICLES, c.maxParticles ?? 8),
      hoverScale: Math.max(1, Math.min(1.5, c.hoverScale ?? 1.25)),
      idleHideMs: Math.max(500, Math.min(300000, c.idleHideMs ?? 5000)),
      cursorSize: Math.max(16, Math.min(64, c.cursorSize ?? DEFAULT_CURSOR_SIZE)),
      hotspotX: Math.max(HOTSPOT_MIN, Math.min(HOTSPOT_MAX, c.hotspotX ?? 1)),
      hotspotY: Math.max(HOTSPOT_MIN, Math.min(HOTSPOT_MAX, c.hotspotY ?? 1)),
    };
  }, []);

  /** lerp 线性插值 */
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  /** 计算光标绘制尺寸（可调显示尺寸，保持 PNG 宽高比），与 512 原始尺寸解耦 */
  const getCursorDrawSize = useCallback((img: HTMLImageElement | null, scale: number) => {
    const base = (cfgRef.current.cursorSize as number) || DEFAULT_CURSOR_SIZE;
    let w = base;
    let h = base;
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
      const r = img.naturalWidth / img.naturalHeight;
      if (r >= 1) { w = base; h = base / r; }
      else { h = base; w = base * r; }
    }
    return { drawW: w * scale, drawH: h * scale };
  }, []);

  /** 检测鼠标下方元素是否为可交互控件 */
  const detectInteractive = useCallback((): CursorState => {
    if (hiddenRef.current) return 'normal';
    if (mouseXRef.current < OFFSCREEN || mouseYRef.current < OFFSCREEN) return 'normal';
    const el = document.elementFromPoint(mouseXRef.current, mouseYRef.current);
    if (!el) return 'normal';

    // 拖拽状态检测
    const cs = getComputedStyle(el);
    if (cs.cursor === 'grabbing' || cs.cursor === 'move' ||
        el.hasAttribute('data-dragging')) {
      return 'grabbing';
    }

    // 可交互元素检测
    const tag = el.tagName.toLowerCase();
    const isInteractive =
      tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea' ||
      tag === 'select' || tag === 'option' ||
      el.getAttribute('role') === 'button' || el.getAttribute('role') === 'slider' ||
      el.getAttribute('role') === 'option' || el.getAttribute('role') === 'listbox' ||
      el.getAttribute('tabindex') !== null ||
      cs.cursor === 'pointer' || cs.cursor === 'grab' ||
      el.classList.contains('btn-primary') || el.classList.contains('btn-ghost') ||
      el.classList.contains('custom-titlebar') || el.classList.contains('mini-titlebar') ||
      el.closest('button, a, [role="button"], [role="option"], [role="listbox"], .custom-titlebar, .mini-titlebar, input, textarea, select, [tabindex], .btn-primary, .btn-ghost');

    return isInteractive ? 'hover' : 'normal';
  }, []);

  // ===== 轨迹管理 =====

  const addTrailPoint = useCallback((x: number, y: number) => {
    const pool = trailPoolRef.current;
    const maxLen = (cfgRef.current.trailMaxLength as number) || MAX_TRAIL_POINTS;

    // 移动所有点位向后（最旧的被覆盖）
    for (let i = maxLen - 1; i > 0; i--) {
      pool[i].x = pool[i - 1].x;
      pool[i].y = pool[i - 1].y;
      pool[i].alpha = pool[i - 1].alpha * 0.85; // 逐级衰减
      pool[i].scale = pool[i - 1].scale * 0.92;
    }

    // 新点位在头部
    pool[0].x = x;
    pool[0].y = y;
    pool[0].alpha = 0.7;
    pool[0].scale = 1.0;

    if (trailLenRef.current < maxLen) trailLenRef.current = maxLen;
    lastTrailAddRef.current = performance.now();
  }, []);

  const updateTrail = useCallback((dt: number) => {
    const pool = trailPoolRef.current;
    let activeCount = 0;
    const decay = dt < 50 ? 0.016 * (dt / 16) : 0.04; // 按帧时间缩放衰减

    for (let i = 0; i < pool.length; i++) {
      if (pool[i].alpha <= 0.01) continue;
      pool[i].alpha -= decay;
      pool[i].scale -= decay * 0.15;
      if (pool[i].alpha <= 0.01) {
        pool[i].alpha = 0;
        pool[i].scale = 0;
      } else {
        activeCount++;
      }
    }
    trailLenRef.current = activeCount;
  }, []);

  // ===== 粒子管理 =====

  const spawnParticle = useCallback((cx: number, cy: number, vx: number, vy: number) => {
    const maxP = (cfgRef.current.maxParticles as number) || MAX_PARTICLES;
    const pool = particlePoolRef.current;

    for (let i = 0; i < maxP; i++) {
      if (!pool[i].active) {
        pool[i].x = cx + (Math.random() - 0.5) * 8;
        pool[i].y = cy + (Math.random() - 0.5) * 8;
        pool[i].vx = vx * (0.3 + Math.random() * 0.4) + (Math.random() - 0.5) * 0.8;
        pool[i].vy = vy * (0.3 + Math.random() * 0.4) + (Math.random() - 0.5) * 0.8;
        pool[i].life = 25 + Math.floor(Math.random() * 20); // 25~45 帧
        pool[i].maxLife = pool[i].life;
        pool[i].size = 1.5 + Math.random() * 2.0; // 1.5~3.5px 半径
        pool[i].active = true;
        return;
      }
    }
  }, []);

  const updateParticles = useCallback(() => {
    const maxP = (cfgRef.current.maxParticles as number) || MAX_PARTICLES;
    const pool = particlePoolRef.current;

    for (let i = 0; i < maxP; i++) {
      if (!pool[i].active) continue;
      pool[i].x += pool[i].vx;
      pool[i].y += pool[i].vy;
      pool[i].vx *= 0.96; // 阻尼
      pool[i].vy *= 0.96;
      pool[i].life--;
      if (pool[i].life <= 0) {
        pool[i].active = false;
      }
    }
  }, []);

  // ===== 绘制函数 =====

  /** 计算当前帧所有绘制内容的包围盒（均使用 CSS 像素坐标） */
  const computeDirtyRects = useCallback((
    cx: number, cy: number, drawW: number, drawH: number, hsX: number, hsY: number
  ): { x: number; y: number; w: number; h: number }[] => {
    const rects: { x: number; y: number; w: number; h: number }[] = [];

    // 光标本体（图像实际绘制区域 = (cx - hsX, cy - hsY) ~ (cx - hsX + drawW, cy - hsY + drawH)）
    rects.push({
      x: cx - hsX - DIRTY_MARGIN,
      y: cy - hsY - DIRTY_MARGIN,
      w: drawW + DIRTY_MARGIN * 2,
      h: drawH + DIRTY_MARGIN * 2,
    });

    // 轨迹点
    const trailOn = cfgRef.current.trailEnabled && degradedRef.current < 2;
    if (trailOn) {
      const pool = trailPoolRef.current;
      const base = (drawW + drawH) / 2 * 0.22;
      for (let i = 0; i < pool.length; i++) {
        if (pool[i].alpha <= 0.01) continue;
        const s = Math.max(2, pool[i].scale * base) + DIRTY_MARGIN;
        rects.push({ x: pool[i].x - s, y: pool[i].y - s, w: s * 2, h: s * 2 });
      }
    }

    // 粒子
    const partOn = cfgRef.current.particlesEnabled && degradedRef.current < 1;
    if (partOn) {
      const pool = particlePoolRef.current;
      const maxP = (cfgRef.current.maxParticles as number) || MAX_PARTICLES;
      for (let i = 0; i < maxP; i++) {
        if (!pool[i].active) continue;
        const s = pool[i].size + DIRTY_MARGIN;
        rects.push({ x: pool[i].x - s, y: pool[i].y - s, w: s * 2, h: s * 2 });
      }
    }

    return rects;
  }, []);

  const clearRectClamped = (
    ctx: CanvasRenderingContext2D,
    rects: { x: number; y: number; w: number; h: number }[]
  ) => {
    const c = ctx.canvas;
    const dpr = window.devicePixelRatio || 1;
    // setTransform(dpr,...) 之后所有坐标都是 CSS 像素，c.width/c.height 是物理像素，
    // 必须除以 dpr 才能得到合法的 CSS 像素边界。否则高 DPR 或缩放时右/下边缘清不干净。
    const maxW = c.width / dpr;
    const maxH = c.height / dpr;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const x = Math.max(0, r.x);
      const y = Math.max(0, r.y);
      const x2 = Math.min(maxW, r.x + r.w);
      const y2 = Math.min(maxH, r.y + r.h);
      if (x2 > x && y2 > y) ctx.clearRect(x, y, x2 - x, y2 - y);
    }
  };

  /**
   * 清除脏区域并绘制整帧
   * @param staticFrame true=空闲静态帧：仅绘制光标本体，不绘制拖尾/粒子（并清掉残留拖尾）
   */
  const clearAndDraw = useCallback((
    ctx: CanvasRenderingContext2D,
    _now: number,
    staticFrame: boolean
  ) => {
    const cfg = cfgRef.current;
    const cx = renderXRef.current;
    const cy = renderYRef.current;

    // 尚未定位（首帧前）或离屏：仅清空上一帧脏区域
    if (cx < OFFSCREEN || cy < OFFSCREEN) {
      clearRectClamped(ctx, prevDirtyRectsRef.current);
      prevDirtyRectsRef.current = [];
      return;
    }

    // 确定光标状态和缩放
    const state = cursorStateRef.current;
    const baseScale = state === 'hover' ? (cfg.hoverScale as number) : 1;
    const img = cursorImgRef.current;
    const { drawW, drawH } = getCursorDrawSize(img, baseScale);
    // 热点像素偏移（按 baseScale 应用悬停放大，并按 cursorSize 缩放，使调整光标大小后
    // 热点相对图像位置保持一致）。HOTSPOT_BASE_SIZE 是热点值的参考尺寸，默认 28。
    const sizeRatio = (cfg.cursorSize as number) / HOTSPOT_BASE_SIZE;
    const hsX = (cfg.hotspotX as number) * baseScale * sizeRatio;
    const hsY = (cfg.hotspotY as number) * baseScale * sizeRatio;

    // ---- 计算本帧和上一帧的脏区域，合并清除 ----
    const curRects = computeDirtyRects(cx, cy, drawW, drawH, hsX, hsY);
    const allRects = [...prevDirtyRectsRef.current, ...curRects];

    ctx.save();
    clearRectClamped(ctx, allRects);

    // 应用淡入淡出透明度（窗口切换丝滑过渡）
    const op = opacityRef.current;
    if (op < 1) ctx.globalAlpha = Math.max(0, Math.min(1, op));

    // 隐藏态（失焦/右键菜单/空闲隐藏）：清空后不绘制任何内容
    if (hiddenRef.current || !imgLoadedRef.current) {
      ctx.restore();
      prevDirtyRectsRef.current = curRects;
      return;
    }

    // ---- 拖尾（液态渐变消散），静态帧跳过 ----
    if (!staticFrame && cfg.trailEnabled && degradedRef.current < 2 && trailLenRef.current > 0) {
      const pool = trailPoolRef.current;
      const baseR = drawW * 0.22;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        if (p.alpha <= 0.01) continue;
        const radius = Math.max(0.5, p.scale * baseR);
        const alpha = Math.max(0, Math.min(1, p.alpha));
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(100, 180, 255, ${alpha.toFixed(3)})`;
        ctx.fill();
      }
    }

    // ---- 粒子（简单柔光圆点），静态帧跳过 ----
    if (!staticFrame && cfg.particlesEnabled && degradedRef.current < 1) {
      const pool = particlePoolRef.current;
      const maxP = (cfg.maxParticles as number) || MAX_PARTICLES;
      for (let i = 0; i < maxP; i++) {
        const p = pool[i];
        if (!p.active) continue;
        const lifeRatio = p.life / p.maxLife;
        const alpha = lifeRatio * 0.7;
        const r = Math.max(0.5, p.size * lifeRatio);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(160, 200, 255, ${alpha.toFixed(3)})`;
        ctx.fill();
      }
    }

    // ---- 绘制光标本体（可调尺寸 + 热点） ----
    // 热点机制：将图像放置到 (cx - hsX, cy - hsY)，其中 hsX/hsY 已按 baseScale 与 cursorSize 缩放，
    // 这样图像上 (hotspotX, hotspotY) 这点正好对齐鼠标位置 (cx, cy)。标准箭头光标的尖端本就在
    // 图像左上角附近 (8/512 ≈ 0.44px)，所以 hotspotX/HotspotY 默认设为 1，对齐左上角尖端。
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, cx - hsX, cy - hsY, drawW, drawH);
    } else {
      // 图片未加载时的后备：画一个箭头形状
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx - 14, cy - 18);
      ctx.lineTo(cx - 8, cy - 14);
      ctx.lineTo(cx - 10, cy);
      ctx.closePath();
      ctx.fillStyle = '#222';
      ctx.fill();
    }

    ctx.restore();

    // 记录本帧脏区域供下一帧清除
    prevDirtyRectsRef.current = curRects;
  }, [computeDirtyRects, getCursorDrawSize]);

  // ===== 主循环 =====

  const drawFrame = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const cfg = cfgRef.current;
    if (!cfg.enabled) return;

    const dt = lastFrameTimeRef.current ? now - lastFrameTimeRef.current : 16;
    lastFrameTimeRef.current = now;

    // ---- FPS 监测（基于统计窗口，避免错误计算）----
    fpsFrameCountRef.current++;
    if (fpsFrameCountRef.current >= FPS_CHECK_INTERVAL) {
      const elapsed = now - fpsWindowStartRef.current;
      if (elapsed > 0) {
        fpsRef.current = Math.round((fpsFrameCountRef.current / (elapsed / 1000)) * 100) / 100;
        if (fpsRef.current < FPS_DEGRADE_THRESHOLD && fpsRef.current > 0) {
          degradedRef.current = Math.min(2, degradedRef.current + 1);
        } else if (fpsRef.current >= 58) {
          degradedRef.current = Math.max(0, degradedRef.current - 1);
        }
      }
      fpsFrameCountRef.current = 0;
      fpsWindowStartRef.current = now;
    }

    // ---- 淡入淡出更新（窗口切换丝滑过渡）----
    const fade = fadeStateRef.current;
    if (fade !== 'none') {
      const fadeElapsed = now - fadeStartRef.current;
      if (fade === 'in') {
        // 淡入：透明度 0 → 1
        const t = Math.min(1, fadeElapsed / FADE_IN_MS);
        // ease-out 缓动：先快后慢，更自然
        opacityRef.current = 1 - (1 - t) * (1 - t);
        if (t >= 1) { opacityRef.current = 1; fadeStateRef.current = 'none'; }
      } else {
        // 淡出：透明度 1 → 0
        const t = Math.min(1, fadeElapsed / FADE_OUT_MS);
        // ease-in 缓动：先慢后快
        opacityRef.current = 1 - t * t;
        if (t >= 1) {
          opacityRef.current = 0;
          fadeStateRef.current = 'none';
          // 淡出完成：正式进入隐藏态
          hiddenRef.current = true;
          document.body.classList.remove('cursor-hidden');
          prevDirtyRectsRef.current = [];
          const c = canvasRef.current;
          if (c) { const ctx = c.getContext('2d'); if (ctx) ctx.clearRect(0, 0, c.width, c.height); }
          stopLoop();
          return; // 本帧不再绘制
        }
      }
    }

    // ---- 空闲检测：静止超过 IDLE_STOP_MS 停止循环，但保留静态光标 ----
    // 正在淡入/淡出时不停帧（必须持续渲染以完成过渡动画）
    const fading = fadeStateRef.current !== 'none';
    const idleMs = now - lastMoveTimeRef.current;
    if (idleMs > IDLE_STOP_MS && !hiddenRef.current && !fading && renderXRef.current > OFFSCREEN) {
      renderXRef.current = lerp(renderXRef.current, mouseXRef.current, cfg.lerpSpeed as number);
      renderYRef.current = lerp(renderYRef.current, mouseYRef.current, cfg.lerpSpeed as number);
      clearAndDraw(ctx, now, true); // 静态帧：仅画光标，清掉残留特效
      runningRef.current = false;
      scheduleIdleHideRef.current();
      return;
    }

    // ---- 更新位置（lerp 缓动）----
    const speed = cfg.lerpSpeed as number;
    const dx = mouseXRef.current - renderXRef.current;
    const dy = mouseYRef.current - renderYRef.current;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const dynamicSpeed = dist > 30 ? Math.min(0.45, speed * 1.8) : speed;

    renderXRef.current = lerp(renderXRef.current, mouseXRef.current, dynamicSpeed);
    renderYRef.current = lerp(renderYRef.current, mouseYRef.current, dynamicSpeed);

    const cx = renderXRef.current;
    const cy = renderYRef.current;

    // ---- 速度计算（用于拖尾长度和粒子发射）----
    const vx = dx * dynamicSpeed;
    const vy = dy * dynamicSpeed;
    const speedVal = Math.sqrt(vx * vx + vy * vy);

    // ---- 拖尾更新 ----
    if (cfg.trailEnabled && degradedRef.current < 2 && idleMs < TRAIL_IDLE_MS && speedVal > 0.5) {
      const interval = Math.max(16, Math.floor(50 / (speedVal + 1)));
      if (now - lastTrailAddRef.current > interval) {
        addTrailPoint(cx, cy);
      }
    }
    updateTrail(dt);

    // ---- 粒子更新 ----
    if (cfg.particlesEnabled && degradedRef.current < 1 && idleMs < TRAIL_IDLE_MS && speedVal > 0.8) {
      if (Math.random() < 0.18) {
        spawnParticle(cx, cy, vx, vy);
      }
    }
    updateParticles();

    // ---- 绘制 ----
    clearAndDraw(ctx, now, false);
  }, [lerp, addTrailPoint, updateTrail, spawnParticle, updateParticles, computeDirtyRects, getCursorDrawSize]);

  const loop = useCallback((now: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    drawFrame(ctx, now);

    if (runningRef.current) {
      rafIdRef.current = requestAnimationFrame(loop);
    }
  }, [drawFrame]);

  // ===== 启动/停止循环 =====

  const startLoop = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    lastFrameTimeRef.current = performance.now();
    fpsFrameCountRef.current = 0;
    fpsWindowStartRef.current = performance.now();
    rafIdRef.current = requestAnimationFrame(loop);
  }, [loop]);

  const stopLoop = useCallback(() => {
    runningRef.current = false;
    if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = 0;
  }, []);

  // ===== 事件处理 =====

  useEffect(() => {
    const cfg = settings?.customCursor;
    if (!cfg?.enabled) {
      stopLoop();
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = 0; }
      document.body.classList.remove('cursor-hidden'); // 恢复原生光标
      const c = canvasRef.current;
      if (c) { const ctx = c.getContext('2d'); if (ctx) ctx.clearRect(0, 0, c.width, c.height); }
      return;
    }

    syncConfig(settings);

    // 加载光标图片
    const cursorImg = new Image();
    cursorImg.src = cursorPngUrl;
    const onLoaded = () => {
      cursorImgRef.current = cursorImg;
      imgLoadedRef.current = cursorImg.complete && cursorImg.naturalWidth > 0;
    };
    if (cursorImg.complete) onLoaded();
    else {
      cursorImg.onload = onLoaded;
      cursorImg.onerror = onLoaded; // 即使加载失败也继续运行（使用后备绘制）
    }

    // 隐藏原生光标（全局类方式，压制按钮等 cursor:pointer 覆盖）
    document.body.classList.add('cursor-hidden');

    // 画布尺寸（含 DPR 以保证清晰度）
    const setupCanvas = () => {
      const c = canvasRef.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      // 重置前先清整屏，避免旧内容在尺寸变化后残留在扩展出来的边缘
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, c.width, c.height);
      }
      c.width = Math.max(1, Math.floor(window.innerWidth * dpr));
      c.height = Math.max(1, Math.floor(window.innerHeight * dpr));
      c.style.width = window.innerWidth + 'px';
      c.style.height = window.innerHeight + 'px';
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    setupCanvas();

    let interactionCheckTimer = 0;

    // 空闲隐藏：超时后隐藏自定义光标并恢复系统原生光标
    const scheduleIdleHide = () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      const ms = (cfgRef.current.idleHideMs as number) || 5000;
      const remaining = Math.max(0, ms - IDLE_STOP_MS);
      hideTimerRef.current = window.setTimeout(() => {
        hiddenRef.current = true;
        document.body.classList.remove('cursor-hidden'); // 恢复原生光标
        prevDirtyRectsRef.current = [];
        const c = canvasRef.current;
        if (c) { const ctx = c.getContext('2d'); if (ctx) ctx.clearRect(0, 0, c.width, c.height); }
      }, remaining);
    };
    scheduleIdleHideRef.current = scheduleIdleHide;

    const cancelIdleHide = () => {
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = 0; }
    };

    // 进入/离开本窗口的显隐控制（核心：用「鼠标是否真正在窗内」驱动，
    // 而非窗口焦点，避免多窗口同时打开时焦点不随鼠标切换导致光标不显示或双光标）
    const ensureVisible = () => {
      cancelIdleHide();
      lastMoveTimeRef.current = performance.now();
      if (hiddenRef.current) {
        hiddenRef.current = false;
        document.body.classList.add('cursor-hidden');
        opacityRef.current = 0; // 从透明开始淡入，丝滑浮现
        fadeStateRef.current = 'in';
        fadeStartRef.current = performance.now();
      } else if (fadeStateRef.current === 'out') {
        fadeStateRef.current = 'in';
        fadeStartRef.current = performance.now();
      }
      if (!runningRef.current) startLoop();
    };

    const hideCursor = () => {
      cancelIdleHide();
      fadeStateRef.current = 'out';
      fadeStartRef.current = performance.now();
      if (!runningRef.current) startLoop();
    };

    const onMouseMove = (e: MouseEvent) => {
      // 首次移动直接吸附到目标，避免从离屏位置长距离缓动
      if (renderXRef.current < OFFSCREEN) {
        renderXRef.current = e.clientX;
        renderYRef.current = e.clientY;
      }
      mouseXRef.current = e.clientX;
      mouseYRef.current = e.clientY;
      lastMoveTimeRef.current = performance.now();

      // 鼠标在本窗口内移动 → 标记在窗内并（必要时）淡入显示
      mouseInsideRef.current = true;
      ensureVisible();

      // 启动循环（如果因空闲停止了）
      if (!runningRef.current) startLoop();

      // 节流交互检测
      if (!interactionCheckTimer) {
        interactionCheckTimer = window.setTimeout(() => {
          interactionCheckTimer = 0;
          cursorStateRef.current = detectInteractive();
        }, INTERACTION_CHECK_THROTTLE_MS);
      }
    };

    // 鼠标离开本窗口（进入桌面或其他窗口）：淡出隐藏
    const onMouseLeaveDoc = () => {
      if (!mouseInsideRef.current) return;
      // 拖动滑块时鼠标可能短暂离开 document（range input 内部捕获），不隐藏
      if (document.querySelector(':active')) return;
      mouseInsideRef.current = false;
      hideCursor();
    };
    const onMouseOut = (e: MouseEvent) => {
      // relatedTarget 为空 = 指针离开文档（到窗口外或另一个窗口）
      if (!e.relatedTarget && mouseInsideRef.current) {
        // 拖动滑块时鼠标可能短暂离开 document（range input 内部捕获），不隐藏
        if (document.querySelector(':active')) return;
        mouseInsideRef.current = false;
        hideCursor();
      }
    };

    const onMouseDown = () => {
      if (cursorStateRef.current === 'hover') {
        cursorStateRef.current = 'grabbing';
      }
    };

    const onMouseUp = () => {
      cursorStateRef.current = detectInteractive();
      // 滚动条拖拽结束后确保恢复动态光标
      document.body.classList.add('cursor-hidden');
    };

    // 焦点变化仅作兜底：只在鼠标确实位于本窗口内时才恢复显示，
    // 这样被其他窗口（含另一个 Electron 窗口）覆盖时不会出现双光标
    const onFocus = () => {
      if (fadeStateRef.current === 'out') {
        fadeStateRef.current = 'none';
      }
      if (mouseInsideRef.current) {
        ensureVisible();
      }
    };

    const onBlur = () => {
      cancelIdleHide();
      // 失焦即淡出（被其他窗口覆盖时鼠标本就不在本窗口，mouseleave 已处理；
      // 此处兜底，避免极端情况下残留光标）
      if (fadeStateRef.current !== 'out') hideCursor();
    };

    const onContextMenu = () => {
      // 唤起右键菜单：暂停渲染、清空画布、显示原生光标以便操作菜单
      hiddenRef.current = true;
      cancelIdleHide();
      const c = canvasRef.current;
      if (c) { const ctx = c.getContext('2d'); if (ctx) ctx.clearRect(0, 0, c.width, c.height); }
      stopLoop();
      document.body.classList.remove('cursor-hidden');
      // 菜单关闭后恢复
      setTimeout(() => {
        hiddenRef.current = false;
        lastMoveTimeRef.current = performance.now();
        if (cfg.enabled) document.body.classList.add('cursor-hidden');
        if (!runningRef.current) startLoop();
      }, 150);
    };

    const onResize = () => {
      setupCanvas();
      prevDirtyRectsRef.current = []; // 清空旧脏区域
    };

    // ResizeObserver 兜底：窗口缩放因子变化不一定触发 resize 事件，但 canvas 的
    // contentRect 会变化；用它来重新同步 backing store 与 CSS 尺寸，防止边缘残留。
    let resizeObserver: ResizeObserver | null = null;
    try {
      resizeObserver = new ResizeObserver(() => {
        setupCanvas();
        prevDirtyRectsRef.current = [];
      });
      const c = canvasRef.current;
      if (c) resizeObserver.observe(c);
    } catch {
      resizeObserver = null;
    }

    // 可见性变化处理
    const onVisibilityChange = () => {
      if (document.hidden) hideCursor();
      else if (mouseInsideRef.current) ensureVisible();
    };

    document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
    document.addEventListener('pointermove', onMouseMove, { capture: true, passive: true });
    document.addEventListener('mouseleave', onMouseLeaveDoc, { passive: true });
    document.addEventListener('mouseout', onMouseOut, { passive: true });
    document.addEventListener('mousedown', onMouseDown, { passive: true });
    document.addEventListener('mouseup', onMouseUp, { passive: true });
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('contextmenu', onContextMenu, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);

    // 初始启动
    startLoop();

    return () => {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('pointermove', onMouseMove, true);
      document.removeEventListener('mouseleave', onMouseLeaveDoc);
      document.removeEventListener('mouseout', onMouseOut);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (interactionCheckTimer) clearTimeout(interactionCheckTimer);
      if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
      cancelIdleHide();
      stopLoop();
      document.body.classList.remove('cursor-hidden');
      hiddenRef.current = true;
      mouseInsideRef.current = false;
      const c = canvasRef.current;
      if (c) { const ctx = c.getContext('2d'); if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); } }
    };
  }, [settings?.customCursor?.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // 配置变化时同步
  useEffect(() => {
    if (settings) syncConfig(settings);
  }, [settings, syncConfig]);

  // 不启用时不渲染 Canvas
  if (!settings?.customCursor?.enabled) return null;

  // 使用 Portal 把 canvas 直接挂到 document.body，避免被 .app-root
  // 的 transform/backdrop-filter 形成的合成层「困」在内部，导致原本 portal 到
  // body 的下拉面板（z-index 2147483645）反客为主把 canvas 盖住。挂到 body 后，
  // canvas 处于 body 的同一图层堆叠上下文，与下拉面板同级比较 z-index，
  // canvas（2147483646 > 2147483645）始终在最上层。
  return createPortal(
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 2147483646, // 最高层级：高于所有模态(10001)、弹窗、Toast、右键菜单(OS原生)。
                       // pointer-events:none 确保不拦截任何交互。
        pointerEvents: 'none', // 关键：不拦截鼠标事件
      }}
    />,
    document.body,
  );
};

export default CustomCursor;
