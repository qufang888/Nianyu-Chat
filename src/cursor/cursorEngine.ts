/**
 * 动态光标引擎（v2.3.126 重做）
 * ============================================================================
 * 与旧版（双 Canvas）的根本区别：**字形不再画在 Canvas 上**。
 *
 *   · 字形层 = 一个 DOM 元素（div + 内嵌 img）
 *       定位**只在指针事件处理函数里同步写入**：
 *         el.style.transform = translate3d(x - offX*s, y - offY*s, 0) scale(s)
 *       → 字形位置与真实指针位置**严格相等**，构造性保证「显示位置 == 点击位置」，
 *         且**零帧延迟**（不进 rAF 队列）。字形层不需要清屏、不需要脏矩形。
 *
 *   · 特效层 = 单张全屏 Canvas
 *       只画**拖尾（ribbon）+ 粒子（spark）**，走 rAF + 对象池 + 脏矩形清除。
 *
 * 本引擎**刻意不 import React**（保持框架无关、可单测），配置由 React 层注入。
 * 引擎也不 import 任何图片资源（内置 cursor.png 由调用方以 URL 注入）。
 *
 * 硬性约束（性能）：
 *   · 统一粒子池上限 64，拖尾点位上限 24；
 *   · 禁止模糊滤镜 / 径向渐变发光等高开销操作（柔光用同心圆叠加近似）；
 *   · 静止 300ms 停止 rAF（保留静态字形，降 CPU）；
 *   · FPS < 52 自动降级（先关 spark，再减 ribbon）。
 */

import {
  CursorConfig,
  CursorFadeState,
  CursorHoverState,
  CursorParticle,
  DIRTY_MARGIN,
  EDGE_BAND_HYSTERESIS_PX,
  FPS_CHECK_INTERVAL,
  FPS_DEGRADE_THRESHOLD,
  FPS_RECOVER_THRESHOLD,
  FADE_IN_MS,
  FADE_OUT_MS,
  GATE_CLASS,
  HIDDEN_CLASS,
  HOTSPOT_PREVIEW_EVENT,
  IDLE_STOP_MS,
  INTERACTION_CHECK_THROTTLE_MS,
  MAX_PARTICLES,
  MAX_TRAIL_POINTS,
  OFFSCREEN,
  SPARK_VELOCITY_INHERIT,
  TRAIL_IDLE_MS,
} from './types';
import { clampNumber, clampRatio, computeCursorDrawSize, hotspotToOffset } from './cursorImage';

// ===== 对外类型 =====

/** 引擎需要操控的两个宿主元素（由 React 层通过 portal 渲染到 document.body） */
export interface CursorEngineElements {
  /** 字形层宿主（div）。引擎会写入样式并在内部创建 img */
  glyphHost: HTMLElement;
  /** 特效层画布 */
  fxCanvas: HTMLCanvasElement;
}

export interface CursorEngineOptions {
  /** 初始配置 */
  config: CursorConfig;
  /** 内置光标图片 URL（由调用方注入 —— 引擎不 import 资源，便于单测） */
  builtinImageUrl: string;
}

/** 脏矩形 */
interface DirtyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 热点预览事件负载 */
interface HotspotPreviewDetail {
  hotspotX: number;
  hotspotY: number;
}

// ===== 引擎 =====

export class CursorEngine {
  /** 内置光标 URL */
  private readonly builtinImageUrl: string;

  /** 当前生效配置 */
  private cfg: CursorConfig;

  /** 已挂载的元素 */
  private elements: CursorEngineElements | null = null;

  // ---- 字形层 ----
  private glyphEl: HTMLElement | null = null;
  private glyphImg: HTMLImageElement | null = null;
  private imgNaturalW = 0;
  private imgNaturalH = 0;
  /** 内置光标也加载失败（极端情况）→ 隐藏 img，避免浏览器画「破图」占位 */
  private imgFailed = false;

  // ---- 特效层 ----
  private fxCanvas: HTMLCanvasElement | null = null;
  private fxCtx: CanvasRenderingContext2D | null = null;
  private canvasDpr = 1;
  /** 统一粒子池（预分配，永不新建对象） */
  private readonly particles: CursorParticle[] = [];
  /** 上一帧脏区域（下一帧先清掉） */
  private prevRects: DirtyRect[] = [];

  // ---- 指针状态 ----
  private pointerX = OFFSCREEN;
  private pointerY = OFFSCREEN;
  /** 上一帧的指针位置（用于计算每帧速度 → 粒子发射频率与速度继承） */
  private prevPointerX = OFFSCREEN;
  private prevPointerY = OFFSCREEN;
  /** 指针是否真正位于本窗口内 */
  private inside = false;
  /** 字形是否隐藏（失焦 / 右键菜单 / 空闲 / 门控） */
  private hidden = true;
  /** 悬停态 */
  private hoverState: CursorHoverState = 'normal';
  /** 当前缩放（悬停放大用；**不影响**位置精度） */
  private scale = 1;
  /** 缩放目标值 */
  private scaleTarget = 1;
  /** 最后一次移动时间戳 */
  private lastMoveTime = 0;
  /** 上一帧时间戳（dt 计算） */
  private lastFrameTime = 0;
  /** 交互检测节流定时器 */
  private interactionTimer = 0;

  // ---- 动画 ----
  private rafId = 0;
  private running = false;
  private opacity = 1;
  private fadeState: CursorFadeState = 'none';
  private fadeStart = 0;

  // ---- 性能与节流 ----
  private fpsFrames = 0;
  private fpsWindowStart = 0;
  /** 降级等级：0 = 正常，1 = 关 spark，2 = 再减 ribbon */
  private degraded = 0;
  /** 生成序号（回收最旧 ribbon 用） */
  private seq = 0;
  /** 拖尾发射累加器 */
  private trailAccum = 0;
  /** 粒子发射累加器 */
  private sparkAccum = 0;

  // ---- 边缘带 / 空闲 / 资源 ----
  /** 当前是否由系统原生光标接管（指针在右/下边缘带内） */
  private edgeNative = false;
  private idleTimer = 0;
  private resizeObserver: ResizeObserver | null = null;
  private dprMql: MediaQueryList | null = null;
  private listenersBound = false;

  constructor(options: CursorEngineOptions) {
    this.builtinImageUrl = options.builtinImageUrl;
    this.cfg = normalizeConfig(options.config);
    // 预分配粒子池
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        kind: 'spark',
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        radius: 0,
        alpha: 0,
        life: 0,
        maxLife: 1,
        seq: 0,
      });
    }
  }

  // ===== 生命周期 =====

  /**
   * 挂载引擎：接管两层宿主元素、绑定指针事件、启动 rAF。
   */
  mount(elements: CursorEngineElements): void {
    if (this.elements) this.unmount();
    this.elements = elements;
    this.glyphEl = elements.glyphHost;
    this.fxCanvas = elements.fxCanvas;

    this.setupGlyphHost();
    this.setupCanvas();
    this.applyImage();
    this.bindListeners();

    // 动态光标启用时先隐藏系统原生光标（全局类方式，压制按钮等 cursor:pointer 覆盖）。
    // 与主进程单光标仲裁链路协作：covered 时外部会加 cursor-gate-off 并派发合成 mouseout，
    // 由 onMouseOut → hideCursorImmediate 一步到位摘掉本类。
    document.body.classList.add(HIDDEN_CLASS);
    this.refreshGlyphVisibility();
    this.startLoop();
  }

  /** 卸载引擎：解绑事件、停循环、清画布、摘掉 body 类 */
  unmount(): void {
    this.unbindListeners();
    this.stopLoop();
    this.cancelIdleHide();
    if (this.interactionTimer) {
      clearTimeout(this.interactionTimer);
      this.interactionTimer = 0;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.dprMql) {
      try {
        this.dprMql.removeEventListener('change', this.onDprChange);
      } catch {
        /* matchMedia 不可用时忽略 */
      }
      this.dprMql = null;
    }
    this.clearFx();
    this.resetParticles();
    document.body.classList.remove(HIDDEN_CLASS);
    document.body.style.cursor = '';
    this.glyphEl = null;
    this.glyphImg = null;
    this.fxCanvas = null;
    this.fxCtx = null;
    this.elements = null;
    this.hidden = true;
    this.inside = false;
  }

  /**
   * 更新配置（设置变更 / 其它窗口广播时调用）。
   * 配置变化**不重挂**引擎，避免光标闪烁。
   */
  updateConfig(config: Partial<CursorConfig>): void {
    const prev = this.cfg;
    this.cfg = normalizeConfig({ ...this.cfg, ...config });

    // 图片变了 → 重新加载
    if (prev.image !== this.cfg.image) {
      this.applyImage();
    }
    // 尺寸变了 → 同步 img 的显示宽高
    if (prev.cursorSize !== this.cfg.cursorSize) {
      this.syncImageSize();
      this.repositionGlyph();
    }
    // 悬停倍率变了 → 立即生效
    if (prev.hoverScale !== this.cfg.hoverScale) {
      this.scaleTarget = this.hoverState === 'hover' ? this.cfg.hoverScale : 1;
    }
    // 总开关被关闭 → 立即让位给原生光标
    if (!this.cfg.enabled) {
      this.hideCursorImmediate();
    } else if (!prev.enabled) {
      this.hidden = false;
      document.body.classList.add(HIDDEN_CLASS);
      this.refreshGlyphVisibility();
    }
    // 热点变了 → 立即重新定位（拖动预览实时生效）
    if (prev.hotspotX !== this.cfg.hotspotX || prev.hotspotY !== this.cfg.hotspotY) {
      this.repositionGlyph();
    }
  }

  // ===== 字形层 =====

  /** 配置字形层宿主样式（几何契约集中在这里，React 层只负责渲染空壳） */
  private setupGlyphHost(): void {
    const el = this.glyphEl;
    if (!el) return;
    el.style.position = 'fixed';
    el.style.top = '0';
    el.style.left = '0';
    el.style.pointerEvents = 'none';
    el.style.zIndex = String(2147483647);
    el.style.willChange = 'transform';
    el.style.transformOrigin = '0 0';
    el.style.opacity = '0';
    el.style.visibility = 'hidden';

    // 内嵌 img（字形本体）
    if (!this.glyphImg) {
      const img = document.createElement('img');
      img.alt = 'cursor';
      img.draggable = false;
      img.style.display = 'block';
      img.style.pointerEvents = 'none';
      img.style.userSelect = 'none';
      img.style.setProperty('-webkit-user-drag', 'none');
      el.appendChild(img);
      this.glyphImg = img;
    }
  }

  /**
   * 加载光标图片（用户上传优先，否则用内置 cursor.png）。
   *
   * **复用同一个 DOM img 元素**（只换 src）：字形层是常驻 DOM，换元素会导致
   * 新元素没有挂到 DOM 上 → 画布上什么都没有（光标「消失」）。
   *
   * 加载失败 → 回退内置光标，**绝不让光标消失**。
   */
  private applyImage(): void {
    const custom = (this.cfg.image || '').trim();
    const src = custom || this.builtinImageUrl;
    this.imgFailed = false;
    this.imgNaturalW = 0;
    this.imgNaturalH = 0;

    const img = this.glyphImg;
    if (!img) return;

    const onLoaded = () => {
      this.imgNaturalW = img.naturalWidth;
      this.imgNaturalH = img.naturalHeight;
      this.imgFailed = !(img.naturalWidth > 0 && img.naturalHeight > 0);
      this.syncImageSize();
      this.repositionGlyph();
    };
    const onError = () => {
      // 自定义图坏了 → 回落内置光标（内置也坏了就隐藏 img，不让浏览器画「破图」占位）
      if (src !== this.builtinImageUrl) {
        this.cfg = { ...this.cfg, image: '' };
        this.applyImage();
        return;
      }
      this.imgFailed = true;
      this.refreshGlyphVisibility();
    };

    img.onload = onLoaded;
    img.onerror = onError;
    img.src = src;
    // dataURL / 资源 URL 可能是缓存命中 → onload 不会触发，这里补一次判定
    if (img.complete && img.naturalWidth > 0) onLoaded();
  }

  /** 把 img 的 CSS 宽高同步为「长边 = cursorSize、保持宽高比」 */
  private syncImageSize(): void {
    const img = this.glyphImg;
    if (!img) return;
    const size = this.drawSize();
    img.style.width = `${size.Dw}px`;
    img.style.height = `${size.Dh}px`;
  }

  /** 当前光标显示尺寸 */
  private drawSize(): { Dw: number; Dh: number } {
    return computeCursorDrawSize(this.imgNaturalW, this.imgNaturalH, this.cfg.cursorSize);
  }

  /**
   * 字形定位 —— **唯一**写 transform 的地方。
   *
   * 位置严格 = 传入的指针坐标（事件坐标），**不做任何 lerp / 缓动 / 追赶**：
   *   transform = translate3d(x - offX*s, y - offY*s, 0) scale(s)
   * 其中 offX/offY = 热点比例 × 实际显示宽高，s = 悬停缩放倍率。
   * 由于 transform-origin 为 0 0，图像上的热点像素恰好落在 (x, y) —— 即真实点击点。
   */
  private applyGlyphTransform(x: number, y: number): void {
    const el = this.glyphEl;
    if (!el) return;
    const size = this.drawSize();
    const off = hotspotToOffset(this.cfg.hotspotX, this.cfg.hotspotY, size.Dw, size.Dh);
    const s = this.scale;
    el.style.transform = `translate3d(${x - off.offX * s}px, ${y - off.offY * s}px, 0) scale(${s})`;
  }

  /** 重新定位字形（配置/图片/缩放变化后调用；位置仍取当前指针坐标） */
  private repositionGlyph(): void {
    if (this.hidden || this.pointerX <= OFFSCREEN) return;
    this.applyGlyphTransform(this.pointerX, this.pointerY);
  }

  /** 同步字形可见性与透明度 */
  private refreshGlyphVisibility(): void {
    const el = this.glyphEl;
    if (!el) return;
    if (this.hidden || this.edgeNative) {
      el.style.opacity = '0';
      el.style.visibility = 'hidden';
      return;
    }
    const op = Math.max(0, Math.min(1, this.opacity));
    el.style.opacity = op.toFixed(3);
    el.style.visibility = op > 0.001 ? 'visible' : 'hidden';
    // 图片彻底加载失败时隐藏 img（不让浏览器画「破图」占位），字形层其余逻辑不受影响
    if (this.glyphImg) this.glyphImg.style.display = this.imgFailed ? 'none' : 'block';
  }

  // ===== 特效层 =====

  /** 统一设置画布尺寸与 DPR */
  private setupCanvas(): void {
    const canvas = this.fxCanvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvasDpr = dpr;

    if (!this.fxCtx) {
      this.fxCtx = canvas.getContext('2d', { alpha: true });
    }
    const ctx = this.fxCtx;
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.prevRects = [];
  }

  /** 清空特效层 */
  private clearFx(): void {
    const canvas = this.fxCanvas;
    const ctx = this.fxCtx;
    if (!canvas || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(this.canvasDpr, 0, 0, this.canvasDpr, 0, 0);
    this.prevRects = [];
  }

  /** 计算本帧所有绘制内容的包围盒（CSS 像素坐标） */
  private computeDirtyRects(): DirtyRect[] {
    const rects: DirtyRect[] = [];
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      const s = p.radius * 2 + DIRTY_MARGIN;
      rects.push({ x: p.x - s, y: p.y - s, w: s * 2, h: s * 2 });
    }
    return rects;
  }

  /** 按画布边界裁剪后清除脏矩形 */
  private clearRects(ctx: CanvasRenderingContext2D, rects: DirtyRect[]): void {
    const canvas = ctx.canvas;
    // 用「建画布时的 DPR」换算边界：DPR 变化后当前 devicePixelRatio 与 backing store
    // 不一致，用错 DPR 会算错 CSS 边界 → 旧帧清不掉 → 光标叠成一片。
    const dpr = this.canvasDpr || 1;
    const maxW = canvas.width / dpr;
    const maxH = canvas.height / dpr;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const x = Math.max(0, r.x);
      const y = Math.max(0, r.y);
      const x2 = Math.min(maxW, r.x + r.w);
      const y2 = Math.min(maxH, r.y + r.h);
      if (x2 > x && y2 > y) ctx.clearRect(x, y, x2 - x, y2 - y);
    }
  }

  /**
   * 绘制特效层（拖尾 + 粒子）。
   * @param staticFrame true = 空闲静态帧：只清残留，不画特效
   */
  private drawFx(staticFrame: boolean): void {
    const ctx = this.fxCtx;
    if (!ctx) return;

    const cur = this.computeDirtyRects();
    const all = this.prevRects.concat(cur);
    this.clearRects(ctx, all);
    this.prevRects = cur;

    if (staticFrame || this.hidden) return;

    const op = Math.max(0, Math.min(1, this.opacity));
    if (op < 1) ctx.globalAlpha = op;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.active) continue;

      if (p.kind === 'ribbon') {
        if (!this.cfg.trailEnabled || this.degraded >= 2) continue;
        const a = Math.max(0, Math.min(1, p.alpha));
        if (a <= 0.01) continue;
        const lifeRatio = p.maxLife > 0 ? p.life / p.maxLife : 0;
        const r = Math.max(0.5, p.radius * (0.35 + 0.65 * lifeRatio));
        // 柔性圆点：两层同心圆近似柔光（**不用**径向渐变/模糊滤镜 —— 高开销）
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 1.9, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(120, 190, 255, ${(a * 0.2).toFixed(3)})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(155, 210, 255, ${(a * 0.55).toFixed(3)})`;
        ctx.fill();
      } else {
        if (!this.cfg.particlesEnabled || this.degraded >= 1) continue;
        const lifeRatio = p.maxLife > 0 ? p.life / p.maxLife : 0;
        const a = lifeRatio * 0.85;
        if (a <= 0.01) continue;
        const r = Math.max(0.4, p.radius * lifeRatio);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(185, 218, 255, ${a.toFixed(3)})`;
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1;
  }

  // ===== 粒子池 =====

  /** 找一个空闲槽位 */
  private findFreeSlot(): CursorParticle | null {
    for (let i = 0; i < this.particles.length; i++) {
      if (!this.particles[i].active) return this.particles[i];
    }
    return null;
  }

  /** 找最旧的 ribbon 槽位（超出上限时回收它） */
  private findOldestRibbon(): CursorParticle | null {
    let oldest: CursorParticle | null = null;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.active || p.kind !== 'ribbon') continue;
      if (!oldest || p.seq < oldest.seq) oldest = p;
    }
    return oldest;
  }

  /**
   * 生成拖尾点位（ribbon）：较大的柔性圆点，半径随生命衰减、渐变消散。
   */
  private spawnRibbon(cx: number, cy: number): void {
    let slot = this.findFreeSlot();
    if (!slot) {
      // 池满 → 回收最旧的 ribbon；一个 ribbon 都没有则放弃（不抢占 spark）
      slot = this.findOldestRibbon();
      if (!slot) return;
    }
    const size = this.drawSize();
    slot.kind = 'ribbon';
    slot.active = true;
    slot.x = cx;
    slot.y = cy;
    slot.vx = 0;
    slot.vy = 0;
    slot.radius = Math.max(2, size.Dw * 0.17);
    slot.alpha = 0.72;
    slot.life = 26 + Math.floor(Math.random() * 14);
    slot.maxLife = slot.life;
    slot.seq = ++this.seq;
  }

  /**
   * 生成粒子（spark）：细小、快速衰减的柔光点。
   *
   * **速度继承**：初速 = -光标速度 × SPARK_VELOCITY_INHERIT + 抖动
   * → 粒子被「甩」在光标身后，产生用户要的拖动手感。
   */
  private spawnSpark(cx: number, cy: number, vx: number, vy: number): void {
    const slot = this.findFreeSlot();
    if (!slot) return;
    slot.kind = 'spark';
    slot.active = true;
    slot.x = cx + (Math.random() - 0.5) * 6;
    slot.y = cy + (Math.random() - 0.5) * 6;
    slot.vx = -vx * SPARK_VELOCITY_INHERIT + (Math.random() - 0.5) * 2.6;
    slot.vy = -vy * SPARK_VELOCITY_INHERIT + (Math.random() - 0.5) * 2.6;
    slot.radius = 0.9 + Math.random() * 1.7;
    slot.alpha = 0.85;
    slot.life = 16 + Math.floor(Math.random() * 16);
    slot.maxLife = slot.life;
    slot.seq = ++this.seq;
  }

  /** 更新粒子（生命衰减 / 阻尼 / 拖尾轻微跟随） */
  private updateParticles(dt: number): void {
    const k = Math.min(3, Math.max(0.4, dt / 16));
    // 拖尾跟随系数：lerpSpeed 只影响拖尾手感（**不影响字形**）
    const tether = this.cfg.lerpSpeed * 0.12 * k;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      if (p.kind === 'spark') {
        p.x += p.vx * k;
        p.y += p.vy * k;
        p.vx *= 0.94;
        p.vy *= 0.94;
        p.life -= 1;
        if (p.life <= 0) p.active = false;
      } else {
        // 拖尾点位轻微向光标牵引（液态手感），位置不会被拖到光标正下方
        p.x += (this.pointerX - p.x) * tether;
        p.y += (this.pointerY - p.y) * tether;
        p.alpha -= 0.042 * k;
        p.life -= 1;
        if (p.life <= 0 || p.alpha <= 0) {
          p.active = false;
          p.alpha = 0;
        }
      }
    }
  }

  /** 清空所有粒子 */
  private resetParticles(): void {
    for (let i = 0; i < this.particles.length; i++) this.particles[i].active = false;
    this.trailAccum = 0;
    this.sparkAccum = 0;
  }

  // ===== rAF 循环 =====

  private startLoop(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = 0;
    this.fpsFrames = 0;
    this.fpsWindowStart = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  private stopLoop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    const dt = this.lastFrameTime ? now - this.lastFrameTime : 16;
    this.lastFrameTime = now;

    // ---- FPS 统计与自动降级 ----
    this.fpsFrames++;
    if (this.fpsFrames >= FPS_CHECK_INTERVAL) {
      const elapsed = now - this.fpsWindowStart;
      if (elapsed > 0) {
        const fps = this.fpsFrames / (elapsed / 1000);
        if (fps < FPS_DEGRADE_THRESHOLD) this.degraded = Math.min(2, this.degraded + 1);
        else if (fps >= FPS_RECOVER_THRESHOLD) this.degraded = Math.max(0, this.degraded - 1);
      }
      this.fpsFrames = 0;
      this.fpsWindowStart = now;
    }

    // ---- 淡入淡出（窗口级切换过渡；动效关闭时一步到位） ----
    if (this.fadeState !== 'none') {
      const fadeState = this.updateFade(now);
      if (fadeState === 'none' && this.hidden) {
        this.drawFx(false);
        this.stopLoop();
        return;
      }
    }

    // ---- 隐藏态且无过渡 → 停循环（省 CPU）；ensureVisible 会重新启动 ----
    if (this.hidden && this.fadeState === 'none') {
      this.running = false;
      this.rafId = 0;
      return;
    }

    // ---- 缩放缓动（只影响 scale，不影响位置精度） ----
    if (Math.abs(this.scale - this.scaleTarget) > 0.001) {
      this.scale += (this.scaleTarget - this.scale) * 0.25;
      this.repositionGlyph();
    } else if (this.scale !== this.scaleTarget) {
      this.scale = this.scaleTarget;
      this.repositionGlyph();
    }

    // ---- 空闲停帧：静止超过 IDLE_STOP_MS 停止 rAF（保留静态字形） ----
    const idleMs = now - this.lastMoveTime;
    const fading = this.fadeState !== 'none';
    if (idleMs > IDLE_STOP_MS && !this.hidden && !fading && this.pointerX > OFFSCREEN) {
      this.drawFx(true);
      this.running = false;
      this.rafId = 0;
      this.scheduleIdleHide();
      return;
    }

    // ---- 每帧速度（用于发射频率与粒子速度继承） ----
    const vx = this.pointerX - this.prevPointerX;
    const vy = this.pointerY - this.prevPointerY;
    this.prevPointerX = this.pointerX;
    this.prevPointerY = this.pointerY;
    const speed = Math.sqrt(vx * vx + vy * vy);

    // ---- 发射（频率与移动速度成正比；静止不发射） ----
    const fxOn = this.cfg.animEnabled;
    if (fxOn && !this.hidden && idleMs < TRAIL_IDLE_MS && speed > 0.5) {
      if (this.cfg.trailEnabled && this.degraded < 2) {
        this.trailAccum += speed * (dt / 16) * 0.05;
        let guard = 0;
        while (this.trailAccum >= 1 && guard < 4) {
          this.trailAccum -= 1;
          guard++;
          this.spawnRibbon(this.pointerX, this.pointerY);
          // 拖尾点位上限
          this.trimRibbons();
        }
      }
      if (this.cfg.particlesEnabled && this.degraded < 1) {
        this.sparkAccum += speed * (dt / 16) * 0.06;
        let guard = 0;
        while (this.sparkAccum >= 1 && guard < 4) {
          this.sparkAccum -= 1;
          guard++;
          this.spawnSpark(this.pointerX, this.pointerY, vx, vy);
        }
      }
    } else {
      this.trailAccum = 0;
      this.sparkAccum = 0;
    }

    this.updateParticles(dt);
    this.drawFx(false);

    if (this.running) this.rafId = requestAnimationFrame(this.frame);
  };

  /** 拖尾点位超出上限时，回收最旧的几个 */
  private trimRibbons(): void {
    const limit = Math.max(1, Math.min(MAX_TRAIL_POINTS, this.cfg.trailMaxLength));
    let count = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (p.active && p.kind === 'ribbon') count++;
    }
    while (count > limit) {
      const oldest = this.findOldestRibbon();
      if (!oldest) break;
      oldest.active = false;
      count--;
    }
  }

  /** 淡入淡出更新；返回过渡结束后的状态 */
  private updateFade(now: number): CursorFadeState {
    const cfg = this.cfg;
    // 动效关闭 → elapsed 视作无穷大，t 立刻饱和到 1 → 一步到位（无补间）
    const elapsed = cfg.animEnabled ? now - this.fadeStart : Number.POSITIVE_INFINITY;
    if (this.fadeState === 'in') {
      const t = Math.min(1, elapsed / (FADE_IN_MS * Math.max(0.1, cfg.animSpeed)));
      this.opacity = 1 - (1 - t) * (1 - t);
      if (t >= 1) {
        this.opacity = 1;
        this.fadeState = 'none';
      }
    } else if (this.fadeState === 'out') {
      const t = Math.min(1, elapsed / (FADE_OUT_MS * Math.max(0.1, cfg.animSpeed)));
      this.opacity = 1 - t * t;
      if (t >= 1) {
        this.opacity = 0;
        this.fadeState = 'none';
        this.finishHide();
      }
    }
    this.refreshGlyphVisibility();
    return this.fadeState;
  }

  /** 淡出完成后的收尾（隐藏 + 摘 cursor-hidden + 清特效层） */
  private finishHide(): void {
    this.hidden = true;
    this.inside = false;
    this.pointerX = OFFSCREEN;
    this.pointerY = OFFSCREEN;
    this.edgeNative = false;
    this.resetParticles();
    this.clearFx();
    document.body.classList.remove(HIDDEN_CLASS);
    this.refreshGlyphVisibility();
    this.stopLoop();
  }

  // ===== 显隐控制 =====

  /**
   * 确保光标可见。
   * @param crisp true = 指针进入窗口（一步到位全显，不淡入）；false = 窗口聚焦（丝滑淡入）
   */
  private ensureVisible(crisp: boolean): void {
    this.cancelIdleHide();
    this.lastMoveTime = performance.now();
    if (this.hidden) {
      this.hidden = false;
      // 边缘带内由系统原生光标接管，此时不能重新隐藏原生光标
      if (!this.edgeNative) document.body.classList.add(HIDDEN_CLASS);
      if (crisp) {
        this.opacity = 1;
        this.fadeState = 'none';
      } else {
        this.opacity = this.cfg.animEnabled ? 0 : 1;
        this.fadeState = 'in';
        this.fadeStart = performance.now();
      }
      this.refreshGlyphVisibility();
    } else if (this.fadeState === 'out') {
      if (crisp) {
        this.opacity = 1;
        this.fadeState = 'none';
      } else {
        this.fadeState = 'in';
        this.fadeStart = performance.now();
      }
      this.refreshGlyphVisibility();
    }
    if (!this.running) this.startLoop();
  }

  /**
   * 一步到位隐藏（鼠标移出窗口 / 门控 / 页面隐藏 / 右键菜单）。
   *
   * 用户诉求：「鼠标滑出软件之后立即变成原生光标，不能有延迟」→ **不走淡出**。
   */
  private hideCursorImmediate(): void {
    this.cancelIdleHide();
    this.fadeState = 'none';
    this.opacity = 1;
    // 位置打回离屏哨兵：下次进入时第一个指针事件直接落到指针处，不从陈旧位置追过来
    this.pointerX = OFFSCREEN;
    this.pointerY = OFFSCREEN;
    this.prevPointerX = OFFSCREEN;
    this.prevPointerY = OFFSCREEN;
    this.inside = false;
    this.hidden = true;
    this.edgeNative = false;
    this.resetParticles();
    this.clearFx();
    // 立即摘掉 cursor-hidden → 系统原生光标即时接管
    document.body.classList.remove(HIDDEN_CLASS);
    this.refreshGlyphVisibility();
    this.stopLoop();
  }

  /** 淡出隐藏（仅用于窗口级切换：失焦 / 被覆盖） */
  private hideCursor(): void {
    // 已完全隐藏时不再重复触发淡出（避免 blur 兜底把隐藏的光标又拉回循环空转）
    if (this.hidden && this.fadeState !== 'in') return;
    this.cancelIdleHide();
    this.fadeState = 'out';
    this.fadeStart = performance.now();
    if (!this.running) this.startLoop();
  }

  /** 空闲隐藏调度：超时后隐藏字形并恢复系统原生光标 */
  private scheduleIdleHide(): void {
    this.cancelIdleHide();
    const ms = this.cfg.idleHideMs;
    const remaining = Math.max(0, ms - IDLE_STOP_MS);
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = 0;
      this.hidden = true;
      this.edgeNative = false;
      this.resetParticles();
      this.clearFx();
      document.body.classList.remove(HIDDEN_CLASS);
      this.refreshGlyphVisibility();
    }, remaining);
  }

  private cancelIdleHide(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = 0;
    }
  }

  // ===== 边缘带 =====

  /**
   * 边缘带判定（带 4px 迟滞）。
   *
   * 字形从热点向右下延伸，进入窗口右/下边缘带时会被窗口裁剪 → 动态光标几乎不可见。
   * 该带内**让位给系统原生光标**（原生光标由合成器绘制、不受窗口裁剪、位置绝对精确），
   * 离开后动态光标无缝接管。迟滞避免指针在带边界反复横跳导致两个光标来回闪烁。
   */
  private updateEdgeBand(x: number, y: number): boolean {
    if (this.hidden) {
      this.edgeNative = false;
      return false;
    }
    const size = this.drawSize();
    const bandW = size.Dw / 2;
    const bandH = size.Dh / 2;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const inBand = this.edgeNative
      ? x >= w - (bandW + EDGE_BAND_HYSTERESIS_PX) || y >= h - (bandH + EDGE_BAND_HYSTERESIS_PX)
      : x >= w - bandW || y >= h - bandH;
    if (inBand !== this.edgeNative) {
      this.edgeNative = inBand;
      if (inBand) {
        // 进入边缘带 → 摘掉 cursor-hidden，露出系统原生光标
        document.body.classList.remove(HIDDEN_CLASS);
      } else if (!this.hidden) {
        // 离开边缘带 → 动态光标无缝接管
        document.body.classList.add(HIDDEN_CLASS);
      }
      this.refreshGlyphVisibility();
    }
    return inBand;
  }

  // ===== 交互检测 =====

  /** 检测鼠标下方元素是否可交互（廉价判定优先，避免 getComputedStyle 触发全树样式重算） */
  private detectInteractive(): CursorHoverState {
    if (this.hidden) return 'normal';
    if (this.pointerX < OFFSCREEN || this.pointerY < OFFSCREEN) return 'normal';
    const el = document.elementFromPoint(this.pointerX, this.pointerY);
    if (!el) return 'normal';

    // 拖拽状态：各拖拽实现统一以 data-dragging 标记
    if (el.hasAttribute('data-dragging')) return 'grabbing';

    const tag = el.tagName.toLowerCase();
    const isInteractive =
      tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea' ||
      tag === 'select' || tag === 'option' ||
      el.getAttribute('role') === 'button' || el.getAttribute('role') === 'slider' ||
      el.getAttribute('role') === 'option' || el.getAttribute('role') === 'listbox' ||
      el.getAttribute('tabindex') !== null ||
      el.classList.contains('btn-primary') || el.classList.contains('btn-ghost') ||
      el.classList.contains('custom-titlebar') || el.classList.contains('mini-titlebar') ||
      el.closest(
        'button, a, [role="button"], [role="option"], [role="listbox"], .custom-titlebar, .mini-titlebar, input, textarea, select, [tabindex], .btn-primary, .btn-ghost'
      );
    if (isInteractive) return 'hover';

    // 兜底：仅廉价判定未命中时才读计算样式
    const cs = getComputedStyle(el);
    if (cs.cursor === 'grabbing' || cs.cursor === 'move') return 'grabbing';
    if (cs.cursor === 'pointer' || cs.cursor === 'grab') return 'hover';
    return 'normal';
  }

  /** 节流调度交互检测 */
  private scheduleInteractionCheck(): void {
    if (this.interactionTimer) return;
    this.interactionTimer = window.setTimeout(() => {
      this.interactionTimer = 0;
      const next = this.detectInteractive();
      if (next === this.hoverState) return;
      this.hoverState = next;
      this.scaleTarget = next === 'hover' ? this.cfg.hoverScale : 1;
    }, INTERACTION_CHECK_THROTTLE_MS);
  }

  // ===== 事件 =====

  /** 单光标仲裁门控是否生效（body.cursor-gate-off） */
  private isGated(): boolean {
    return document.body.classList.contains(GATE_CLASS);
  }

  private onMouseMove = (e: MouseEvent): void => {
    // 门控（悬浮球穿透区 / 被其它窗口覆盖）：忽略指针，不响应、不显示字形
    if (this.isGated()) return;
    if (!this.cfg.enabled) return;

    // 位置**直接**取事件坐标：不做 lerp、不做缓动追赶 → 显示位置 == 点击位置
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    this.inside = true;
    this.lastMoveTime = performance.now();

    // 指针进入窗口 → 一步到位全显（不淡入）
    this.ensureVisible(true);
    if (!this.running) this.startLoop();

    this.scheduleInteractionCheck();

    // 字形定位：同步、精确
    this.updateGlyphAt(e.clientX, e.clientY);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (this.isGated()) return;
    if (this.hidden || !this.cfg.enabled) return;
    // 点击瞬间把字形吸附到真实指针（位置严格 = 事件坐标）
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    this.lastMoveTime = performance.now();
    if (this.hoverState === 'hover') {
      this.hoverState = 'grabbing';
      this.scaleTarget = 1;
    }
    this.updateGlyphAt(e.clientX, e.clientY);
  };

  private onMouseUp = (): void => {
    const next = this.detectInteractive();
    if (next !== this.hoverState) {
      this.hoverState = next;
      this.scaleTarget = next === 'hover' ? this.cfg.hoverScale : 1;
    }
    // 边缘带内仍由系统原生光标接管，不重复隐藏，否则边缘没光标
    if (!this.edgeNative && !this.hidden) document.body.classList.add(HIDDEN_CLASS);
  };

  /** 指针离开文档（滑出软件）→ 立即隐藏并恢复原生光标 */
  private onMouseLeaveDoc = (): void => {
    if (!this.inside) return;
    // 拖动滑块时鼠标可能短暂离开 document（range input 内部捕获），不隐藏
    if (document.querySelector(':active')) return;
    this.hideCursorImmediate();
  };

  private onMouseOut = (e: MouseEvent): void => {
    // relatedTarget 为空 = 指针离开文档（到窗口外或另一个窗口）
    if (e.relatedTarget) return;
    if (!this.inside) return;
    if (document.querySelector(':active')) return;
    this.hideCursorImmediate();
  };

  private onFocus = (): void => {
    if (this.fadeState === 'out') this.fadeState = 'none';
    if (this.inside) this.ensureVisible(false);
  };

  private onBlur = (): void => {
    this.cancelIdleHide();
    if (this.fadeState !== 'out') this.hideCursor();
  };

  /** 右键菜单唤起 → 立即隐藏字形（露出原生光标便于操作菜单），菜单关闭后恢复 */
  private onContextMenu = (): void => {
    this.cancelIdleHide();
    this.hidden = true;
    this.edgeNative = false;
    this.resetParticles();
    this.clearFx();
    document.body.classList.remove(HIDDEN_CLASS);
    this.refreshGlyphVisibility();
    this.stopLoop();
    window.setTimeout(() => {
      // 引擎已卸载 → 不再恢复（否则会重启 rAF 循环并残留 cursor-hidden）
      if (!this.elements) return;
      this.hidden = false;
      this.lastMoveTime = performance.now();
      if (this.cfg.enabled && !this.isGated()) {
        document.body.classList.add(HIDDEN_CLASS);
      }
      this.refreshGlyphVisibility();
      if (!this.running) this.startLoop();
    }, 150);
  };

  private onResize = (): void => {
    this.setupCanvas();
    this.repositionGlyph();
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) {
      // 页面被隐藏时 rAF 会被节流甚至停摆 → 走确定性复位路径
      this.hideCursorImmediate();
    } else if (this.inside) {
      this.ensureVisible(false);
    }
  };

  private onPageHide = (): void => {
    this.hideCursorImmediate();
  };

  private onDprChange = (): void => {
    this.setupCanvas();
    this.rearmDprWatch();
  };

  /** DPR 变化（全屏 / 换显示器 / 缩放）时重新监听 */
  private rearmDprWatch(): void {
    try {
      if (this.dprMql) this.dprMql.removeEventListener('change', this.onDprChange);
      this.dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      this.dprMql.addEventListener('change', this.onDprChange);
    } catch {
      this.dprMql = null;
    }
  }

  /** 设置页拖动热点时的实时预览（不落盘） */
  private onHotspotPreview = (e: Event): void => {
    const detail = (e as CustomEvent<HotspotPreviewDetail>).detail;
    if (!detail) return;
    this.cfg = {
      ...this.cfg,
      hotspotX: clampRatio(detail.hotspotX, this.cfg.hotspotX),
      hotspotY: clampRatio(detail.hotspotY, this.cfg.hotspotY),
    };
    this.repositionGlyph();
  };

  /** 字形定位入口：处理边缘带 → 写 transform */
  private updateGlyphAt(x: number, y: number): void {
    if (this.hidden) return;
    if (this.updateEdgeBand(x, y)) {
      this.refreshGlyphVisibility();
      return;
    }
    this.applyGlyphTransform(x, y);
    this.refreshGlyphVisibility();
  }

  private bindListeners(): void {
    if (this.listenersBound) return;
    this.listenersBound = true;

    document.addEventListener('mousemove', this.onMouseMove, { capture: true, passive: true });
    document.addEventListener('mouseleave', this.onMouseLeaveDoc, { passive: true });
    document.addEventListener('mouseout', this.onMouseOut, { passive: true });
    document.addEventListener('mousedown', this.onMouseDown, { passive: true });
    document.addEventListener('mouseup', this.onMouseUp, { passive: true });
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('focus', this.onFocus);
    document.addEventListener('contextmenu', this.onContextMenu, { passive: true });
    window.addEventListener('resize', this.onResize, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener(HOTSPOT_PREVIEW_EVENT, this.onHotspotPreview);

    // ResizeObserver 兜底：窗口缩放因子变化不一定触发 resize，但 canvas 的 contentRect 会变
    try {
      this.resizeObserver = new ResizeObserver(() => {
        this.setupCanvas();
      });
      if (this.fxCanvas) this.resizeObserver.observe(this.fxCanvas);
    } catch {
      this.resizeObserver = null;
    }
    this.rearmDprWatch();
  }

  private unbindListeners(): void {
    if (!this.listenersBound) return;
    this.listenersBound = false;

    document.removeEventListener('mousemove', this.onMouseMove, true);
    document.removeEventListener('mouseleave', this.onMouseLeaveDoc);
    document.removeEventListener('mouseout', this.onMouseOut);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('focus', this.onFocus);
    document.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener(HOTSPOT_PREVIEW_EVENT, this.onHotspotPreview);
  }
}

// ===== 配置归一化 =====

/** 把（可能来自旧版本 / 脏数据的）配置夹到安全区间 */
export function normalizeConfig(input: CursorConfig): CursorConfig {
  return {
    enabled: !!input.enabled,
    animEnabled: input.animEnabled !== false,
    animSpeed: clampNumber(input.animSpeed, 0.1, 5, 1),
    lerpSpeed: clampNumber(input.lerpSpeed, 0.05, 0.5, 0.25),
    trailEnabled: input.trailEnabled !== false,
    trailMaxLength: Math.round(clampNumber(input.trailMaxLength, 1, MAX_TRAIL_POINTS, MAX_TRAIL_POINTS)),
    particlesEnabled: input.particlesEnabled !== false,
    maxParticles: Math.round(clampNumber(input.maxParticles, 1, MAX_PARTICLES, MAX_PARTICLES)),
    hoverScale: clampNumber(input.hoverScale, 1, 1.5, 1.25),
    idleHideMs: clampNumber(input.idleHideMs, 500, 300000, 5000),
    cursorSize: clampNumber(input.cursorSize, 16, 64, 28),
    hotspotX: clampRatio(input.hotspotX, 0),
    hotspotY: clampRatio(input.hotspotY, 0),
    image: (input.image || '').trim(),
  };
}
