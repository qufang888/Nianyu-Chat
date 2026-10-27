/**
 * CustomCursor - 高性能自定义 Canvas 光标系统
 *
 * 架构（v2.3.126 重做）：顶层全屏透明**双层 Canvas**
 *   - 画布 A（特效层，底层）：拖尾 + 粒子。走 rAF 循环 + 对象池 + 脏区域重绘。
 *   - 画布 B（本体层，顶层）：**光标字形本体**。只在指针事件里**同步绘制**
 *     （mousemove / mousedown / 进入窗口），位置严格 = e.clientX/e.clientY，**不经 rAF 排队**。
 *
 * 为什么拆两层（本次重做的根因）：原先光标本体位置在 rAF 帧里更新，mousemove 事件要等
 * 下一帧才画 → 快速移动、或从主窗切到小窗/悬浮球时，字形落后真实指针一帧（可差 10+px），
 * 用户按字形尖点击，落点却在别处。现在本体层与事件同帧绘制 → 显示位置 == 点击位置。
 * 两层画布各自维护「上一帧矩形」，互不干扰：本体层不会把拖尾挖出洞，特效层也不会擦掉字形。
 *
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
import { isGroupEnabled, getAnimSpeed } from '../utils/animControl';

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
// v2.3.126：默认热点按 cursor.png **实测**校准 —— 该图是 512×512 调色板 PNG，顶行(y=0)的
// alpha 梯度实测为 x=34→7、x=35→71、x=36→119…，轮廓可见起点（箭头尖端）在 x=35，
// 28 基准 = 35/512*28 = 1.9141px。
// 旧默认值 0.44 来自「把尖端误测为 8/512」的错误取证，会让字形尖端偏右 1.47px ——
// 用户看到的光标尖在真实点击点**右侧**，点下去落在左侧（用户原话：点击位置在光标显示位置左侧）。
// 热点必须精确到 1/512 像素级：0.1px 误差在 28px 光标上已是肉眼可辨的「点不中」。
// 校准闸门见 scripts/verify-cursor-hotspot.mjs（换图后必跑，防止再次漂移）。
const HOTSPOT_MIN = 0;
const HOTSPOT_MAX = 64;   // 最大值 64 留出小范围微调余地
// v2.3.126：右/下边缘带的迟滞宽度（像素）。指针在边缘带内时由**系统原生光标**接管
// （合成器绘制、不受窗口裁剪、位置绝对精确），离开后动态光标无缝接管。
// 迟滞避免指针在带边界反复横跳导致两个光标来回闪烁。
const EDGE_BAND_HYSTERESIS_PX = 4;
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
// v2.3.97：这两个是**基准**时长（1× 速度下），实际时长 = 基准 / 速度倍率（见下方 speedRef）。
const FADE_IN_MS = 200;             // 聚焦时淡入时长（毫秒）
const FADE_OUT_MS = 150;            // 失焦时淡出时长（毫秒）

// ===== 组件 =====

const CustomCursor: React.FC = () => {
  const { settings } = useTheme();
  // v2.3.126：双层画布 —— fxCanvas = 特效层（拖尾/粒子，底层），bodyCanvas = 本体层（光标字形，顶层）。
  const fxCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodyCanvasRef = useRef<HTMLCanvasElement | null>(null);

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
  const canvasDprRef = useRef(1);           // 建画布时的 DPR（clearRectClamped 用它换算边界，防 DPR 变化后清不掉旧帧）
  const fxCtxRef = useRef<CanvasRenderingContext2D | null>(null);   // 特效层 2D 上下文（避免每帧 getContext）
  const bodyCtxRef = useRef<CanvasRenderingContext2D | null>(null); // 本体层 2D 上下文
  // v2.3.126：本体层「上一帧字形矩形」——本体层独立维护自己的清除区域，
  // 不与特效层的脏矩形混用（否则本体层擦掉拖尾、或特效层擦掉字形 → 拖尾被挖洞 / 字形缺角）。
  const bodyPrevRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  // v2.3.126：边缘带状态——true 表示当前由系统原生光标接管（本体层不画字形）。
  const edgeNativeRef = useRef(false);

  // ===== 淡入淡出状态（窗口切换丝滑过渡）=====
  type FadeState = 'none' | 'in' | 'out';
  const opacityRef = useRef(1);             // 当前全局透明度 0~1
  const fadeStateRef = useRef<FadeState>('none'); // 当前淡入淡出状态
  const fadeStartRef = useRef(0);           // 淡入/淡出开始时间戳
  // 动效控制。Canvas 的 globalAlpha 补间是纯 JS 绘制逻辑，`.anim-off` 的 CSS
  // 全局规则管不到它，故需在此显式门控：关闭动效时淡入/淡出「一步到位」（直接写终值），
  // 不再播放 rAF 补间。判定走 isGroupEnabled —— 'all-off' 档或 custom 关掉「自定义光标」分组都生效。
  // 用 ref 而非闭包变量：rAF 回调长期存活，需读到最新值而不必重建整条回调链。
  // 在 effect 中同步（而非渲染期直接赋值）——渲染期写 ref 在并发模式下属于副作用。
  const cursorAnimOn = isGroupEnabled(settings, 'cursor');
  const animOnRef = useRef(cursorAnimOn);
  useEffect(() => {
    animOnRef.current = cursorAnimOn;
  }, [cursorAnimOn]);

  // ===== v2.3.97：界面动效速度倍率 =====
  // Canvas 光标是纯 JS rAF 绘制，CSS 的 calc(...*var(--anim-speed)) 完全管不到它，
  // 所以必须在这里**显式**把倍率应用到两个语义相反的参数上。
  // 注意 `--anim-speed` 是**时长倍率**（1.5 = 很慢 = 时长 ×1.5），因此：
  //   1) 淡入/淡出**时长**（FADE_IN_MS / FADE_OUT_MS）→ **乘**倍率（越慢等越久）；
  //   2) lerp 跟随**系数**（cfg.lerpSpeed，每帧向目标插值的比例，越大越快）→ **除**倍率
  //      （越慢每帧走得越少）。
  // ⚠️ 这两处方向相反，弄反任一个都会得到「调慢反而变快」的诡异手感：
  //    时长用除 → 慢档下淡入秒完但光标乱抖；lerp 用乘 → 慢档下光标疯狂甩尾。
  //    验证脚本 D 组对两个方向都有断言。
  // 用 ref 承载：rAF 回调长期存活，需读到最新值而不必重建整条回调链。
  const animSpeed = getAnimSpeed(settings);
  const speedRef = useRef(animSpeed);
  useEffect(() => {
    speedRef.current = animSpeed;
  }, [animSpeed]);

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
  // v2.3.126：图片加载失败标记（区分「还在加载」与「加载失败」）：
  // 还在加载 → 本体层先不画（避免闪出后备箭头）；加载失败 → 画后备箭头。
  const imgFailedRef = useRef(false);

  // ===== 脏区域追踪（减少重绘范围）=====
  const prevDirtyRectsRef = useRef<{ x: number; y: number; w: number; h: number }[]>([]);

  // ===== 工具函数 =====

  /** 读取当前配置到引用（配置变化时调用，避免每帧读 React state） */
  const syncConfig = useCallback((s: AppSettings | null) => {
    if (!s?.customCursor) return;
    const c = s.customCursor;
    cfgRef.current = {
      enabled: c.enabled,
      // v2.3.97：lerp 系数是**每帧插值比例**（越大越快），语义与「时长」相反，
      // 所以这里要**除以**时长倍率而不是乘：倍率 1.5（更慢）→ 系数变小 → 每帧走得更少。
      // 上下限：下限 0.02 保证极慢档下光标仍会跟上（否则会「跟丢」鼠标）；
      // 上限 0.5 保持不变 —— 系数 ≥1 会插值过冲并引起抖动，任何倍率下都不该越过。
      lerpSpeed: Math.max(
        0.02,
        Math.min(0.5, Math.max(0.05, Math.min(0.5, c.lerpSpeed ?? 0.25)) / speedRef.current)
      ),
      trailEnabled: c.trailEnabled !== false,
      trailMaxLength: Math.min(MAX_TRAIL_POINTS, c.trailMaxLength ?? 10),
      particlesEnabled: c.particlesEnabled !== false,
      maxParticles: Math.min(MAX_PARTICLES, c.maxParticles ?? 8),
      hoverScale: Math.max(1, Math.min(1.5, c.hoverScale ?? 1.25)),
      idleHideMs: Math.max(500, Math.min(300000, c.idleHideMs ?? 5000)),
      cursorSize: Math.max(16, Math.min(64, c.cursorSize ?? DEFAULT_CURSOR_SIZE)),
      hotspotX: Math.max(HOTSPOT_MIN, Math.min(HOTSPOT_MAX, c.hotspotX ?? 1.9141)),
      hotspotY: Math.max(HOTSPOT_MIN, Math.min(HOTSPOT_MAX, c.hotspotY ?? 0)),
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

    // 拖拽状态检测：各拖拽实现统一以 data-dragging 属性标记（廉价，先行）
    if (el.hasAttribute('data-dragging')) return 'grabbing';

    // v2.3.121：廉价判定优先（标签/角色/tabindex/类名/closest，不触发样式重算）。
    // getComputedStyle 会强制整棵文档树样式重算，在消息流这类大型 DOM 上每次数毫秒；
    // 80ms 节流的交互检测是「开启动态光标后点击延迟/卡顿」的主因之一，故绝大多数
    // 悬停目标（按钮/链接/输入框等）走廉价分支，不再付 getComputedStyle 代价。
    const tag = el.tagName.toLowerCase();
    const isInteractive =
      tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea' ||
      tag === 'select' || tag === 'option' ||
      el.getAttribute('role') === 'button' || el.getAttribute('role') === 'slider' ||
      el.getAttribute('role') === 'option' || el.getAttribute('role') === 'listbox' ||
      el.getAttribute('tabindex') !== null ||
      el.classList.contains('btn-primary') || el.classList.contains('btn-ghost') ||
      el.classList.contains('custom-titlebar') || el.classList.contains('mini-titlebar') ||
      el.closest('button, a, [role="button"], [role="option"], [role="listbox"], .custom-titlebar, .mini-titlebar, input, textarea, select, [tabindex], .btn-primary, .btn-ghost');
    if (isInteractive) return 'hover';

    // 兜底：仅廉价判定未命中时才读计算样式（cursor:grabbing/move → 拖拽中；pointer/grab → 可交互）
    const cs = getComputedStyle(el);
    if (cs.cursor === 'grabbing' || cs.cursor === 'move') return 'grabbing';
    if (cs.cursor === 'pointer' || cs.cursor === 'grab') return 'hover';
    return 'normal';
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

  /** 计算特效层（画布 A）当前帧所有绘制内容的包围盒（均使用 CSS 像素坐标）
   *  v2.3.126：光标本体已移到本体层（画布 B）同步绘制，本层**不再**包含字形脏矩形——
   *  两层各自维护清除区域，否则本体层会擦掉拖尾（挖洞）、特效层会擦掉字形（缺角）。 */
  const computeDirtyRects = useCallback((
    drawW: number, drawH: number
  ): { x: number; y: number; w: number; h: number }[] => {
    const rects: { x: number; y: number; w: number; h: number }[] = [];

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
    // v2.3.119：用「建画布时的 DPR」(canvasDprRef) 而非当前 window.devicePixelRatio 换算边界。
    // 若全屏 / 换显示器导致 DPR 变化而 resize 未触发，当前 DPR 与 backing store 的 DPR 不一致，
    // 用错 DPR 会算错 CSS 边界 → 旧帧清不掉 → 光标叠成一片（曾现于全屏 + 模型编辑界面）。
    const dpr = canvasDprRef.current || 1;
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
   * 特效层（画布 A）清除脏区域并绘制拖尾/粒子
   * @param staticFrame true=空闲静态帧：只清残留特效，不画拖尾/粒子（本体层字形不受影响）
   *
   * v2.3.126：光标本体**不在本层绘制**——本体已移到本体层（画布 B）由指针事件同步绘制，
   * 保证「显示位置 == 点击位置」。本层只管拖尾与粒子。
   */
  const clearAndDrawFx = useCallback((
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

    // 绘制尺寸（拖尾半径基准用；本体层另有自己的尺寸计算）
    const state = cursorStateRef.current;
    const baseScale = state === 'hover' ? (cfg.hoverScale as number) : 1;
    const img = cursorImgRef.current;
    const { drawW, drawH } = getCursorDrawSize(img, baseScale);

    // ---- 计算本帧和上一帧的脏区域，合并清除 ----
    const curRects = computeDirtyRects(drawW, drawH);
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
      const maxP = (cfgRef.current.maxParticles as number) || MAX_PARTICLES;
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

    ctx.restore();

    // 记录本帧脏区域供下一帧清除
    prevDirtyRectsRef.current = curRects;
  }, [computeDirtyRects, getCursorDrawSize]);

  // ===== 本体层（画布 B：光标字形）=====
  // v2.3.126：本体层与特效层彻底解耦——
  //   · 绘制时机：**只在指针事件里同步绘制**（mousemove / mousedown / 进入窗口），
  //     不进 rAF 队列 → 绘制位置严格 = e.clientX/e.clientY，事件与绘制同帧，
  //     「显示位置 == 点击位置」成立（原先本体在 rAF 帧里画，落后真实指针一帧，可差 10+px）。
  //   · 清除区域：自己维护 bodyPrevRectRef（上一帧字形矩形），不碰特效层脏矩形
  //     → 不会把拖尾/粒子挖出洞。
  //   · 边缘带（A3）：指针进入右/下边缘带时**让位给系统原生光标**（原生光标由合成器绘制、
  //     不受窗口裁剪、位置绝对精确），此时本体层不画字形。

  /** 清除本体层上一帧字形矩形（按画布边界裁剪，避免清到画布外） */
  const clearBody = useCallback(() => {
    const ctx = bodyCtxRef.current;
    const r = bodyPrevRectRef.current;
    bodyPrevRectRef.current = null;
    if (!ctx || !r) return;
    const dpr = canvasDprRef.current || 1;
    const x = Math.max(0, r.x);
    const y = Math.max(0, r.y);
    const x2 = Math.min(ctx.canvas.width / dpr, r.x + r.w);
    const y2 = Math.min(ctx.canvas.height / dpr, r.y + r.h);
    if (x2 > x && y2 > y) ctx.clearRect(x, y, x2 - x, y2 - y);
  }, []);

  /** 边缘带判定 + 迟滞：返回 true 表示「当前由系统原生光标接管」。
   *  - 带宽 = 字形绘制尺寸的一半（drawW/2、drawH/2）：字形从热点向右下延伸，
   *    指针进入右/下边缘这半张字形会被窗口裁掉 → 动态光标几乎不可见。
   *  - 迟滞：进入阈值 = band，离开阈值 = band + EDGE_BAND_HYSTERESIS_PX，
   *    避免指针在带边界反复横跳时两个光标来回闪烁。
   *  - 隐藏态优先：隐藏（空闲/失焦/门控）时不让原生光标接管逻辑插手。
   *  - 左/上边缘不需要带：字形向右下延伸，左/上侧本就完整可见。 */
  const updateEdgeBand = useCallback((x: number, y: number): boolean => {
    if (hiddenRef.current) {
      // 隐藏态：本体层不画字形，原生光标由隐藏路径自己负责（摘 cursor-hidden）
      edgeNativeRef.current = false;
      return false;
    }
    const img = cursorImgRef.current;
    const state = cursorStateRef.current;
    const baseScale = state === 'hover' ? (cfgRef.current.hoverScale as number) : 1;
    const { drawW, drawH } = getCursorDrawSize(img, baseScale);
    const bandW = drawW / 2;
    const bandH = drawH / 2;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const inBand = edgeNativeRef.current
      ? x >= w - (bandW + EDGE_BAND_HYSTERESIS_PX) || y >= h - (bandH + EDGE_BAND_HYSTERESIS_PX)
      : x >= w - bandW || y >= h - bandH;
    if (inBand !== edgeNativeRef.current) {
      edgeNativeRef.current = inBand;
      if (inBand) {
        // 进入边缘带：摘掉 cursor-hidden → 露出系统原生光标（不受窗口裁剪、位置绝对精确）
        document.body.classList.remove('cursor-hidden');
      } else if (!hiddenRef.current) {
        // 离开边缘带：动态光标无缝接管
        document.body.classList.add('cursor-hidden');
      }
    }
    return inBand;
  }, [getCursorDrawSize]);

  /** 在本体层同步绘制光标字形：位置严格 = 传入的指针坐标（事件坐标，**不做任何钳制/平移**）。
   *  v2.3.126：撤销 v2.3.126 的「画布内钳制」——钳制会把字形整体平移，等于人为制造
   *  「显示位置 != 点击位置」的偏移（与用户诉求直接冲突）。边缘可见性改由 A3 的
   *  「边缘带 + 系统原生光标接管」解决，两者互不冲突。 */
  const drawBodyAt = useCallback((x: number, y: number) => {
    const cfg = cfgRef.current;
    if (!cfg.enabled) return;
    if (hiddenRef.current) return;
    const ctx = bodyCtxRef.current;
    if (!ctx) return;
    // 边缘带内让位给系统原生光标（本体层不画字形，只清掉上一帧残留）
    if (updateEdgeBand(x, y)) { clearBody(); return; }
    // v2.3.126：图片仍在加载 → 先不画（避免闪出后备箭头）；加载失败 → 走后备箭头绘制
    if (!imgLoadedRef.current && !imgFailedRef.current) { clearBody(); return; }
    const img = cursorImgRef.current;
    const state = cursorStateRef.current;
    const baseScale = state === 'hover' ? (cfg.hoverScale as number) : 1;
    const { drawW, drawH } = getCursorDrawSize(img, baseScale);
    // 热点像素偏移（按 baseScale 应用悬停放大，并按 cursorSize 缩放，使调整光标大小后
    // 热点相对图像位置保持一致）。HOTSPOT_BASE_SIZE 是热点值的参考尺寸，默认 28。
    const sizeRatio = (cfg.cursorSize as number) / HOTSPOT_BASE_SIZE;
    const hsX = (cfg.hotspotX as number) * baseScale * sizeRatio;
    const hsY = (cfg.hotspotY as number) * baseScale * sizeRatio;

    // 先清本体层上一帧字形（只清自己的矩形，绝不碰特效层 → 拖尾不会被挖洞）
    clearBody();
    ctx.save();
    const op = opacityRef.current;
    if (op < 1) ctx.globalAlpha = Math.max(0, Math.min(1, op));
    if (img && img.complete && img.naturalWidth > 0) {
      // 热点机制：图像放置到 (x - hsX, y - hsY)，使图像上的热点像素正好落在指针位置 (x, y)
      ctx.drawImage(img, x - hsX, y - hsY, drawW, drawH);
      bodyPrevRectRef.current = { x: x - hsX, y: y - hsY, w: drawW, h: drawH };
    } else {
      // 图片未加载时的后备箭头（同样画在本体层）
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 14, y - 18);
      ctx.lineTo(x - 8, y - 14);
      ctx.lineTo(x - 10, y);
      ctx.closePath();
      ctx.fillStyle = '#222';
      ctx.fill();
      // 后备箭头向**左上**延伸，清除矩形须覆盖实际绘制区域
      bodyPrevRectRef.current = { x: x - 14, y: y - 18, w: 14, h: 18 };
    }
    ctx.restore();
  }, [clearBody, getCursorDrawSize, updateEdgeBand]);

  /** 按当前渲染位置重画本体层（rAF 驱动，仅用于淡入淡出时同步透明度） */
  const redrawBody = useCallback(() => {
    if (hiddenRef.current) return;
    if (renderXRef.current < OFFSCREEN || renderYRef.current < OFFSCREEN) return;
    drawBodyAt(renderXRef.current, renderYRef.current);
  }, [drawBodyAt]);

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
      // v2.3.90：动效总开关关闭 → 跳过补间，把 elapsed 视作无穷大，
      // 下面的 t 立刻饱和到 1，走既有分支的「终值路径」：淡入直接置 1，
      // 淡出直接置 0 并完成隐藏收尾（清屏 / 摘 cursor-hidden / 停循环）。
      // 这样无需在两处分支里各写一份「瞬时完成」代码，也不会残留半透明帧。
      const fadeElapsed = animOnRef.current ? now - fadeStartRef.current : Number.POSITIVE_INFINITY;
      if (fade === 'in') {
        // 淡入：透明度 0 → 1（时长基准 FADE_IN_MS，按速度倍率缩短）
        const t = Math.min(1, fadeElapsed / (FADE_IN_MS * speedRef.current));
        // ease-out 缓动：先快后慢，更自然
        opacityRef.current = 1 - (1 - t) * (1 - t);
        if (t >= 1) { opacityRef.current = 1; fadeStateRef.current = 'none'; }
      } else {
        // 淡出：透明度 1 → 0（时长基准 FADE_OUT_MS，按速度倍率缩短）
        const t = Math.min(1, fadeElapsed / (FADE_OUT_MS * speedRef.current));
        // ease-in 缓动：先慢后快
        opacityRef.current = 1 - t * t;
        if (t >= 1) {
          opacityRef.current = 0;
          fadeStateRef.current = 'none';
          // 淡出完成：正式进入隐藏态
          hiddenRef.current = true;
          // v2.3.116：失焦淡出收尾时一并把渲染位置打回离屏哨兵，
          // 下次鼠标进入由 onMouseMove 吸附到指针，不从陈旧位置飞入。
          renderXRef.current = OFFSCREEN;
          renderYRef.current = OFFSCREEN;
          // v2.3.126（A4）：一并置 mouseInside=false —— 淡出收尾即「本窗已无光标」，
          // 下次进入的第一个指针事件必然走「离屏吸附」分支，字形直接落在指针处。
          mouseInsideRef.current = false;
          // v2.3.126：本体层同步收尾（清字形 + 清「上一帧矩形」），否则淡出后本体层残留半透明字形
          clearBody();
          document.body.classList.remove('cursor-hidden');
          prevDirtyRectsRef.current = [];
          const c = fxCanvasRef.current;
          if (c) { const ctx = c.getContext('2d'); if (ctx) ctx.clearRect(0, 0, c.width, c.height); }
          stopLoop();
          return; // 本帧不再绘制
        }
      }
      // v2.3.126：淡入/淡出期间 rAF 继续驱动透明度插值 → 本体层要跟着重画，
      // 否则字形透明度不随窗口切换过渡（本体层在事件里画，透明度变化不会被事件触发）。
      redrawBody();
    }

    // ---- 空闲检测：静止超过 IDLE_STOP_MS 停止循环，但保留静态光标 ----
    // 正在淡入/淡出时不停帧（必须持续渲染以完成过渡动画）
    const fading = fadeStateRef.current !== 'none';
    const idleMs = now - lastMoveTimeRef.current;
    if (idleMs > IDLE_STOP_MS && !hiddenRef.current && !fading && renderXRef.current > OFFSCREEN) {
      renderXRef.current = mouseXRef.current; // v2.3.120：空闲静态帧也一步贴合指针
      renderYRef.current = mouseYRef.current;
      // v2.3.126：静态帧只清特效层残留拖尾/粒子；本体层字形已在事件里画好，保持不动
      clearAndDrawFx(ctx, now, true);
      runningRef.current = false;
      scheduleIdleHideRef.current();
      return;
    }

    // ---- 更新位置 ----
    // v2.3.120：光标本体一步贴合指针（无 lerp 滞后）。用户反馈「动态光标显示位置与真实点击
    // 位置有偏移、要往右移一点才点得到」——lerp 缓动追使光标滞后于真实指针，而点击命中走
    // 真实指针，二者错位。液态手感由拖尾承担，光标本体始终贴指针。
    const dx = mouseXRef.current - renderXRef.current;
    const dy = mouseYRef.current - renderYRef.current;
    renderXRef.current = mouseXRef.current;
    renderYRef.current = mouseYRef.current;
    const dynamicSpeed = 1; // 拖尾速度用满位移

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

    // ---- 绘制（特效层）----
    clearAndDrawFx(ctx, now, false);
  }, [lerp, addTrailPoint, updateTrail, spawnParticle, updateParticles, clearAndDrawFx, clearBody, redrawBody]);

  const loop = useCallback((now: number) => {
    // v2.3.126：特效层画布（画布 A）。本体层（画布 B）不走 rAF，由指针事件同步绘制。
    const canvas = fxCanvasRef.current;
    if (!canvas) return;
    // v2.3.121：缓存 2D 上下文（原先每帧都 getContext，属无谓开销）
    let ctx = fxCtxRef.current;
    if (!ctx) {
      ctx = canvas.getContext('2d', { alpha: true });
      fxCtxRef.current = ctx;
    }
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
      // v2.3.x：显式清除任何内联 cursor 覆盖，确保原生光标可靠显示。球/面板窗口在穿透态
      // （setIgnoreMouseEvents(true,{forward:true})）下依赖本窗自身（而非主窗）决定光标样式，
      // 故关闭动态光标时每个窗口的 CustomCursor 各自跑此 disabled 分支，互不依赖、互不残留。
      document.body.style.cursor = '';
      // v2.3.126：双画布（特效层 + 本体层）都要清
      const c = fxCanvasRef.current;
      if (c) { const ctx = c.getContext('2d'); if (ctx) ctx.clearRect(0, 0, c.width, c.height); }
      const bc = bodyCanvasRef.current;
      if (bc) { const bctx = bc.getContext('2d'); if (bctx) bctx.clearRect(0, 0, bc.width, bc.height); }
      bodyPrevRectRef.current = null;
      return;
    }

    syncConfig(settings);

    // 加载光标图片
    const cursorImg = new Image();
    cursorImg.src = cursorPngUrl;
    const onLoaded = () => {
      cursorImgRef.current = cursorImg;
      imgLoadedRef.current = cursorImg.complete && cursorImg.naturalWidth > 0;
      // v2.3.126：图片就绪的瞬间补画一次本体层 —— 否则「图片晚于首次指针移动才加载完成」时，
      // 用户不动鼠标就看不到光标（本体层只在指针事件里画），要等下一次移动才出现。
      redrawBody();
    };
    if (cursorImg.complete) onLoaded();
    else {
      cursorImg.onload = onLoaded;
      cursorImg.onerror = () => { imgFailedRef.current = true; onLoaded(); }; // 加载失败 → 用后备绘制
    }

    // 隐藏原生光标（全局类方式，压制按钮等 cursor:pointer 覆盖）
    document.body.classList.add('cursor-hidden');

    // 画布尺寸（含 DPR 以保证清晰度）
    // v2.3.126：特效层（画布 A）与本体层（画布 B）两块画布同步设置 —— 尺寸/DPR 必须一致，
    // 否则本体层字形与特效层特效的坐标空间会错位。
    const setupCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      canvasDprRef.current = dpr; // 记录建画布时的 DPR，供 clearRectClamped / clearBody 换算边界
      const sizeOne = (
        c: HTMLCanvasElement | null,
        ctxHolder: { current: CanvasRenderingContext2D | null }
      ) => {
        if (!c) return;
        // 重置前先清整屏，避免旧内容在尺寸变化后残留在扩展出来的边缘
        let ctx = ctxHolder.current;
        if (!ctx) {
          ctx = c.getContext('2d', { alpha: true });
          ctxHolder.current = ctx;
        }
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
      sizeOne(fxCanvasRef.current, fxCtxRef);
      sizeOne(bodyCanvasRef.current, bodyCtxRef);
      // 尺寸变化后本体层「上一帧矩形」的坐标空间已失效 → 重置，避免误清/漏清
      bodyPrevRectRef.current = null;
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
        // v2.3.126：本体层同步清空（字形 + 上一帧矩形），否则空闲隐藏后本体层残留字形
        bodyPrevRectRef.current = null;
        edgeNativeRef.current = false;
        const c = fxCanvasRef.current;
        if (c) { const ctx = c.getContext('2d'); if (ctx) ctx.clearRect(0, 0, c.width, c.height); }
        const bc = bodyCanvasRef.current;
        if (bc) { const bctx = bc.getContext('2d'); if (bctx) bctx.clearRect(0, 0, bc.width, bc.height); }
      }, remaining);
    };
    scheduleIdleHideRef.current = scheduleIdleHide;

    const cancelIdleHide = () => {
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = 0; }
    };

    // 进入/离开本窗口的显隐控制（核心：用「鼠标是否真正在窗内」驱动，
    // 而非窗口焦点，避免多窗口同时打开时焦点不随鼠标切换导致光标不显示或双光标）
    // crisp=true：鼠标进入窗口 —— 一步到位全显并吸附到指针（不做淡入），
    //   避免「边缘光标消失 / 与原生光标双现」；crisp=false：窗口聚焦（alt-tab）丝滑淡入。
    const ensureVisible = (crisp = false) => {
      cancelIdleHide();
      lastMoveTimeRef.current = performance.now();
      // 离屏吸附：渲染位置处于离屏哨兵（上次是即时隐藏收尾）时，直接落到当前指针，
      // 不从上次离开的陈旧位置缓动追过来（v2.3.115 修进入边缘双光标/无光标）。
      if (renderXRef.current < OFFSCREEN && mouseXRef.current > OFFSCREEN) {
        renderXRef.current = mouseXRef.current;
        renderYRef.current = mouseYRef.current;
      }
      if (hiddenRef.current) {
        hiddenRef.current = false;
        // v2.3.126：边缘带内由**系统原生光标**接管，此时不能重新隐藏原生光标
        // （否则刚恢复可见又立刻把原生光标藏掉 → 边缘仍然「没有任何光标」）
        if (!edgeNativeRef.current) document.body.classList.add('cursor-hidden');
        if (crisp) {
          // 鼠标进入：立即全显，杜绝淡入期间的「自定义未现 + 原生滞后」双光标窗口
          opacityRef.current = 1;
          fadeStateRef.current = 'none';
        } else {
          // 从透明开始淡入，丝滑浮现；动效关闭时直接给终值 1
          opacityRef.current = animOnRef.current ? 0 : 1;
          fadeStateRef.current = 'in';
          fadeStartRef.current = performance.now();
        }
      } else if (fadeStateRef.current === 'out') {
        if (crisp) { opacityRef.current = 1; fadeStateRef.current = 'none'; }
        else { fadeStateRef.current = 'in'; fadeStartRef.current = performance.now(); }
      }
      if (!runningRef.current) startLoop();
    };

    const hideCursor = () => {
      // 已完全隐藏（含「移出窗口瞬时隐藏」收尾）时不再重复触发淡出：
      // 否则切窗口时紧随其后的 blur / visibilitychange 兜底会把已隐藏的光标
      // 又拉回 rAF 循环空转。淡入进行中（fadeState==='in'）不拦，允许即时改为淡出。
      if (hiddenRef.current && fadeStateRef.current !== 'in') return;
      cancelIdleHide();
      fadeStateRef.current = 'out';
      fadeStartRef.current = performance.now();
      if (!runningRef.current) startLoop();
    };

    // v2.3.114：鼠标移出本窗口 → 立即隐藏自定义光标并恢复系统原生光标（不再淡出）。
    // 用户诉求：光标移开软件后应立刻变回原生光标，不能有「残留再淡出消失」的停留感。
    // 淡出仅保留给「窗口被覆盖 / 切后台」等窗口级切换的丝滑过渡；鼠标真正离开
    // 窗口（到桌面或其他窗口）必须一步到位，native 光标即时回归。
    const hideCursorImmediate = () => {
      cancelIdleHide();
      fadeStateRef.current = 'none';                   // 取消任何进行中的淡入 / 淡出
      opacityRef.current = 1;                          // 复位透明度
      // v2.3.115：把渲染位置打回离屏哨兵。下次鼠标进入时由 onMouseMove 的
      // 「离屏吸附」把自定义光标直接落到指针处 —— 否则会从上次离开的陈旧位置
      // 缓动追过来，造成「边缘无光标 / 要挪一大段才出现 / 快进入时与原生双光标」。
      renderXRef.current = OFFSCREEN;
      renderYRef.current = OFFSCREEN;
      // v2.3.126（A4）：本窗已无光标 → mouseInside 一并置 false，
      // 保证下次进入的第一个指针事件走「离屏吸附」，字形直接落在指针处、无旧坐标残留。
      mouseInsideRef.current = false;
      hiddenRef.current = true;
      document.body.classList.remove('cursor-hidden'); // 立即恢复原生光标
      prevDirtyRectsRef.current = [];
      // v2.3.126：本体层同步清空（字形 + 上一帧矩形），否则隐藏后本体层残留字形
      bodyPrevRectRef.current = null;
      edgeNativeRef.current = false;
      const c = fxCanvasRef.current;
      if (c) {
        const ctx = c.getContext('2d');
        if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); }
      }
      const bc = bodyCanvasRef.current;
      if (bc) {
        const bctx = bc.getContext('2d');
        if (bctx) { bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.clearRect(0, 0, bc.width, bc.height); }
      }
      stopLoop();
    };

    const onMouseMove = (e: MouseEvent) => {
      // 门控（悬浮球窗口专用）：body 带 cursor-gate-off 类时表示鼠标位于穿透区（球/面板之外），
      // 忽略 mousemove —— 穿透模式下窗口收不到 mouseleave，靠门控阻止光标在透明区显示/残留
      if (document.body.classList.contains('cursor-gate-off')) return;
      // v2.3.116：进入窗口这一跳（上次鼠标在窗外 / 渲染位离屏）直接把自定义光标落到指针，
      // 绝不由「上次离开的陈旧位置」缓动飞入 —— 无论上次是即时隐藏 / 失焦淡出 / 空闲 / 从未显示收尾。
      const wasInside = mouseInsideRef.current;
      if (!wasInside || renderXRef.current < OFFSCREEN) {
        renderXRef.current = e.clientX;
        renderYRef.current = e.clientY;
      }
      mouseXRef.current = e.clientX;
      mouseYRef.current = e.clientY;
      lastMoveTimeRef.current = performance.now();

      // 鼠标在本窗口内移动 → 标记在窗内并（必要时）淡入显示
      mouseInsideRef.current = true;
      ensureVisible(true); // v2.3.115：鼠标进入走「一步到位全显 + 吸附指针」，不做淡入

      // 启动循环（如果因空闲停止了）
      if (!runningRef.current) startLoop();

      // 节流交互检测
      if (!interactionCheckTimer) {
        interactionCheckTimer = window.setTimeout(() => {
          interactionCheckTimer = 0;
          cursorStateRef.current = detectInteractive();
        }, INTERACTION_CHECK_THROTTLE_MS);
      }

      // v2.3.126：本体层**同步**绘制（不排队 rAF）——绘制位置严格 = 事件坐标，
      // 消除「字形落后真实指针一帧（可差 10+px）→ 按字形尖点击却落在别处」的偏移。
      // 这是本次重做的核心：本体层不进帧队列，事件与绘制同帧 → 显示位置 == 点击位置。
      drawBodyAt(e.clientX, e.clientY);
    };

    // 鼠标离开本窗口（进入桌面或其他窗口）：立即隐藏并恢复原生光标（v2.3.114 不再淡出，消除残留停留感）
    const onMouseLeaveDoc = () => {
      if (!mouseInsideRef.current) return;
      // 拖动滑块时鼠标可能短暂离开 document（range input 内部捕获），不隐藏
      if (document.querySelector(':active')) return;
      mouseInsideRef.current = false;
      hideCursorImmediate();
    };
    const onMouseOut = (e: MouseEvent) => {
      // relatedTarget 为空 = 指针离开文档（到窗口外或另一个窗口）
      if (!e.relatedTarget && mouseInsideRef.current) {
        // 拖动滑块时鼠标可能短暂离开 document（range input 内部捕获），不隐藏
        if (document.querySelector(':active')) return;
        mouseInsideRef.current = false;
        hideCursorImmediate();
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      // v2.3.126：点击瞬间把光标本体吸附到真实指针并**同步重画本体层**。
      // 绘制位置严格 = e.clientX/e.clientY（不经 rAF 排队）→ 「看到的光标尖」与
      // 「实际点到的位置」必然一致。门控/隐藏态直接跳过（此时本就不绘制动态光标）。
      if (document.body.classList.contains('cursor-gate-off')) return;
      if (hiddenRef.current) return;
      mouseXRef.current = e.clientX;
      mouseYRef.current = e.clientY;
      renderXRef.current = e.clientX;
      renderYRef.current = e.clientY;
      lastMoveTimeRef.current = performance.now();
      if (cursorStateRef.current === 'hover') {
        cursorStateRef.current = 'grabbing';
      }
      drawBodyAt(e.clientX, e.clientY);
    };

    const onMouseUp = () => {
      cursorStateRef.current = detectInteractive();
      // 滚动条拖拽结束后确保恢复动态光标
      // （v2.3.126：边缘带内仍由系统原生光标接管，不重复隐藏，否则边缘没光标）
      if (!edgeNativeRef.current) document.body.classList.add('cursor-hidden');
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
      // v2.3.126：本体层同步清空（字形 + 上一帧矩形）
      bodyPrevRectRef.current = null;
      edgeNativeRef.current = false;
      const c = fxCanvasRef.current;
      if (c) { const ctx = c.getContext('2d'); if (ctx) ctx.clearRect(0, 0, c.width, c.height); }
      const bc = bodyCanvasRef.current;
      if (bc) { const bctx = bc.getContext('2d'); if (bctx) bctx.clearRect(0, 0, bc.width, bc.height); }
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
      // v2.3.126：两块画布都要观察（尺寸/DPR 必须一致）
      const c = fxCanvasRef.current;
      if (c) resizeObserver.observe(c);
      const bc = bodyCanvasRef.current;
      if (bc) resizeObserver.observe(bc);
    } catch {
      resizeObserver = null;
    }

    // v2.3.119：DPR 变化（全屏 / 换显示器 / 显示缩放）重设画布。这类场景可能只变 DPR、
    // CSS 尺寸不变，resize 与 ResizeObserver 都不触发；不重设会让 backing store 与显示 DPR
    // 不一致（光标尺寸/位置错、旧帧清不掉叠成一片）。matchMedia 的 resolution 查询按当前 DPR
    // 定向，故每次变化后需重新监听。
    let dprMql: MediaQueryList | null = null;
    const onDprChange = () => {
      setupCanvas();
      prevDirtyRectsRef.current = [];
      rearmDprWatch();
    };
    const rearmDprWatch = () => {
      try {
        if (dprMql) dprMql.removeEventListener('change', onDprChange);
        dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        dprMql.addEventListener('change', onDprChange);
      } catch { /* matchMedia 不可用时忽略 */ }
    };
    rearmDprWatch();

    // 可见性变化处理
    // v2.3.126（A4 跨界面切换的状态复位）：页面被隐藏（切标签页/最小化）时 rAF 会被节流甚至停摆，
    // 淡出收尾（renderX/Y 打回离屏 + mouseInside 置 false）可能永远不执行 → 复位走「立即隐藏」
    // 这条确定性路径，保证下次进入的第一个指针事件就吸附到指针、无旧坐标残留。
    const onVisibilityChange = () => {
      if (document.hidden) hideCursorImmediate();
      else if (mouseInsideRef.current) ensureVisible();
    };
    // v2.3.126（A4）：页面卸载/关闭前同样复位，避免下次进入带着陈旧坐标
    const onPageHide = () => { hideCursorImmediate(); };

    // v2.3.121：只挂 mousemove。原先 mousemove + pointermove 双监听同一 handler，鼠标每次
    // 物理移动都会触发两遍（双倍 ensureVisible/检测调度），是输入卡顿的来源之一。
    // 鼠标移动必然伴随 mousemove；纯触屏设备不显示鼠标光标，无需 pointermove。
    document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
    document.addEventListener('mouseleave', onMouseLeaveDoc, { passive: true });
    document.addEventListener('mouseout', onMouseOut, { passive: true });
    document.addEventListener('mousedown', onMouseDown, { passive: true });
    document.addEventListener('mouseup', onMouseUp, { passive: true });
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('contextmenu', onContextMenu, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);

    // 初始启动
    startLoop();

    return () => {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('mouseleave', onMouseLeaveDoc);
      document.removeEventListener('mouseout', onMouseOut);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      if (interactionCheckTimer) clearTimeout(interactionCheckTimer);
      if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
      if (dprMql) { try { dprMql.removeEventListener('change', onDprChange); } catch { /* ignore */ } dprMql = null; }
      cancelIdleHide();
      stopLoop();
      document.body.classList.remove('cursor-hidden');
      hiddenRef.current = true;
      mouseInsideRef.current = false;
      const c = fxCanvasRef.current;
      if (c) { const ctx = c.getContext('2d'); if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); } }
      const bc = bodyCanvasRef.current;
      if (bc) { const bctx = bc.getContext('2d'); if (bctx) { bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.clearRect(0, 0, bc.width, bc.height); } }
      bodyPrevRectRef.current = null;
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
  // canvas（2147483646/2147483647 > 2147483645）始终在最上层。
  //
  // v2.3.126：双画布 —— 特效层（拖尾/粒子）在下，本体层（光标字形）在上。
  // 本体层 z-index 最高：字形是用户直接盯着的东西，绝不能被弹窗/Toast 盖住。
  const canvasStyle = {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    // 与 setupCanvas 使用同一来源（window.innerWidth/innerHeight，不含滚动条宽度），
    // 避免 100vw 含滚动条宽度导致的尺寸错位（setupCanvas 未执行时画布尺寸不一致）
    width: window.innerWidth + 'px',
    height: window.innerHeight + 'px',
    pointerEvents: 'none' as const, // 关键：不拦截鼠标事件
  };
  return createPortal(
    <>
      {/* 画布 A：特效层（拖尾 + 粒子），rAF 驱动 */}
      <canvas ref={fxCanvasRef} style={{ ...canvasStyle, zIndex: 2147483646 }} />
      {/* 画布 B：本体层（光标字形），指针事件里同步绘制 */}
      <canvas ref={bodyCanvasRef} style={{ ...canvasStyle, zIndex: 2147483647 }} />
    </>,
    document.body,
  );
};

export default CustomCursor;
