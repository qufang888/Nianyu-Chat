/**
 * autoContrast —— 玻璃/液态玻璃主题的「文字对比度看门狗」（v2.3.104，任务 T01）
 *
 * 定位：可读性功能（非动画）。事件驱动的近似机制（非逐像素实时），
 * 对应 Apple Liquid Glass「材质随底层内容自适应、必要时明暗翻转」的 Web 可达近似。
 * 作用域：仅 `data-theme ∈ {glass, liquid}`；其余 13 主题零开销早退。
 *
 * 工作原理（设计文档 §4.6）：
 *  1. WATCH_SELECTORS 注册表：玻璃文字承载面清单。
 *     【同步维护说明】本清单与 src/styles/index.css 的玻璃承载面（deepening/4a 玻璃组）清单同源，
 *     两处必须同步维护——index.css 侧由 T03 维护，此处由本文件维护，改动任一侧务必同步另一侧。
 *  2. compositeBackground(el)：自 el 沿祖先链向上做 premultiplied alpha 合成 backgroundColor，
 *     累计 alpha ≥ 0.97 即停；合成到根之后垫 `--auto-contrast-base` 基准色（窗口底等效色）。
 *     若 html 挂了 `data-liquid-custom-bg`（用户自定义背景图生效），用离屏 canvas 把背景图
 *     降采样 8×8 求均值色参与合成（按 URL 缓存，避免重复绘制）。
 *     【blur 近似说明】backdrop blur 保持区域平均亮度，故对自定义背景取均值是合理近似；
 *     但对小浮层（尺寸 < 3× blur 半径）存在边界效应——透出的多半是暗缘而非区域平均，
 *     故对采样亮度取 P10 低分位做保守估计，宁深勿浅（宁可误加深、不可漏掉不可读）。
 *  3. 判级：容器解析后的文字色 vs 合成背景做 WCAG 对比度——
 *     ≥ 4.5 不干预；< 4.5 挂 `data-auto-contrast='boost'`；
 *     模拟叠加 boost 加深层后仍 < 4.5 → 升级 `'flip'`（整体翻转为浅底深字）。
 *  4. 触发与门禁：
 *     - documentElement attributes MutationObserver（data-theme / data-liquid-flow / data-liquid-custom-bg）；
 *     - body childList+subtree MutationObserver（debounce 120ms，捕捉菜单/弹窗 portal 动态挂载）；
 *     - window resize（debounce 200ms）；
 *     - 非 glass/liquid 主题：移除全部 `data-auto-contrast` 后早退（观察器保持存活以响应换主题）；
 *     - anim-off 不影响本机制（可读性功能，不依赖任何动画）；
 *     - 开关关闭（setAutoContrastEnabled(false)）：清空属性并停止全部观察，零开销。
 *
 * CSS 消费端（T03，src/styles/index.css）：`[data-theme='glass|liquid'] [data-auto-contrast='boost'|'flip']`
 * 规则与 `--auto-contrast-*` 令牌定义；本文件只在容器上挂属性，不定义任何样式。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 解析后的 RGBA 颜色（各通道 0~1，alpha 0~1） */
interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 判级结果：'boost' = 叠加加深层；'flip' = 翻转为浅底深字 */
type Verdict = 'boost' | 'flip';

// ---------------------------------------------------------------------------
// 常量（Shared Knowledge：JS 侧允许的 fallback 字面量，CSS 侧令牌由 T03 定义）
// ---------------------------------------------------------------------------

/** 看门狗作用主题（其余 13 主题早退） */
const WATCHED_THEMES: ReadonlySet<string> = new Set(['glass', 'liquid']);

/** 玻璃 backdrop blur 半径（px），与 --liquid-backdrop 的 blur(30px) 对应，用于小浮层判定 */
const BLUR_RADIUS_PX = 30;

/** 小浮层判定阈值：最大边长 < 3× blur 半径（设计文档 §4.6 第 2 条） */
const SMALL_FLOAT_EDGE_PX = BLUR_RADIUS_PX * 3;

/** WCAG AA 正文对比度门槛 */
const AA_CONTRAST = 4.5;

/** 累计 alpha 达到该值即认为已不透明、停止向上合成 */
const OPAQUE_ENOUGH = 0.97;

/**
 * 基准色 fallback：`--auto-contrast-base` 读不到时的窗口底等效色。
 * 仅 JS 常量允许（Shared Knowledge #1）；CSS 内仍零硬编码（令牌归 variables.css / T03）。
 */
const FALLBACK_BASE: RGBA = { r: 14 / 255, g: 30 / 255, b: 62 / 255, a: 1 };

/** boost 加深层 fallback：`--auto-contrast-scrim` 读不到时使用 */
const FALLBACK_SCRIM: RGBA = { r: 6 / 255, g: 12 / 255, b: 28 / 255, a: 0.55 };

/**
 * 玻璃文字承载面选择器注册表。
 * 【同步维护说明】与 src/styles/index.css 的玻璃承载面清单（deepening 组 L7077-7092 +
 * 4a 玻璃组 L7165-7180 的浮层面）同源，两处必须同步维护；改动任一侧务必同步另一侧。
 */
const WATCH_SELECTORS: string[] = [
  '.ctx-menu',
  '.obs-menu',
  '.list-menu',
  '.more-dropdown',
  '.modal-card',
  '.mini-drawer',
  '.chat-model-picker',
  '.mention-pop',
  '.reasoning-block',
  '.fb-panel',
  '.queue-dock-panel',
  '.api-params-panel',
  '.update-banner',
  '.role-card',
  '.theme-card',
  '.sidebar',
  '.modal',
];

/** 合并后的选择器串（供 querySelectorAll 使用） */
const WATCH_SELECTOR_ALL = WATCH_SELECTORS.join(', ');

/** 每个受管元素的最近一次判定签名（签名未变则跳过 DOM 写入） */
const verdictCache = new WeakMap<Element, string>();

// ---------------------------------------------------------------------------
// 模块状态
// ---------------------------------------------------------------------------

let initialized = false;
let enabled = true;
let rootAttrObserver: MutationObserver | null = null;
let bodyObserver: MutationObserver | null = null;
let resizeHandler: (() => void) | null = null;
let applyDebounceTimer: number | null = null;
let resizeDebounceTimer: number | null = null;

/** 自定义背景图采样缓存：URL → 均值色（8×8 降采样） */
const bgSampleCache = new Map<string, RGBA>();

// ---------------------------------------------------------------------------
// 颜色解析与 WCAG 对比度
// ---------------------------------------------------------------------------

/**
 * 解析 getComputedStyle 返回的颜色串（rgb()/rgba() 格式）。
 * 'transparent' / 解析失败返回 null。computed style 不返回 hex，无需处理。
 */
function parseColor(str: string): RGBA | null {
  if (!str) return null;
  const m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.%]+))?\s*\)$/i);
  if (!m) return null;
  const r = Number(m[1]) / 255;
  const g = Number(m[2]) / 255;
  const b = Number(m[3]) / 255;
  let a = 1;
  if (m[4] !== undefined) {
    a = m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  }
  if ([r, g, b, a].some((v) => !Number.isFinite(v))) return null;
  return { r, g, b, a: Math.min(1, Math.max(0, a)) };
}

/** over 合成：把 top 层叠在 bottom 层之上，返回合成结果（premultiplied 语义） */
function compositeOver(top: RGBA, bottom: RGBA): RGBA {
  const outA = top.a + bottom.a * (1 - top.a);
  if (outA <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / outA,
    g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / outA,
    b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / outA,
    a: outA,
  };
}

/** sRGB 通道 → 线性化（WCAG 定义） */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 相对亮度 */
function relativeLuminance(c: RGBA): number {
  return (
    0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b)
  );
}

/** WCAG 对比度（fg/bg 两个颜色之间） */
function contrastRatio(fg: RGBA, bg: RGBA): number {
  const lf = relativeLuminance(fg);
  const lb = relativeLuminance(bg);
  const lighter = Math.max(lf, lb);
  const darker = Math.min(lf, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// 有效背景合成
// ---------------------------------------------------------------------------

/** 从 documentElement 读取 CSS 令牌颜色（读不到返回 null，由调用方用 fallback） */
function readTokenColor(token: string): RGBA | null {
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (!v) return null;
  const c = parseColor(v);
  // 令牌可能是 hex（如 --auto-contrast-flip-text: #0b1220），补 hex 解析
  if (c) return c;
  const hex = v.match(/^#([0-9a-f]{3,8})$/i);
  if (!hex) return null;
  let h = hex[1];
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}

/** 令牌读不到时的取值（fallback 字面量仅 JS 允许） */
function tokenOr(token: string, fallback: RGBA): RGBA {
  return readTokenColor(token) || fallback;
}

/**
 * 尝试一次绘制 + 像素采样（**不写缓存**，缓存决策权在调用方 sampleImageColor）。
 * 返回 null = 图片未就绪 / 绘制失败 / 读取失败（跨域污染）。
 *
 * 关键点：drawImage 对未加载完成的图片是**静默 no-op（不抛错）**，画上去的是透明黑，
 * 因此必须先用 `img.complete && img.naturalWidth > 0` 判就绪，再绘制——
 * 否则会把「未加载」误判成「纯黑背景」并把坏值写进缓存（v2.3.104 QA 修复项 C）。
 */
function trySample(url: string, smallFloat: boolean): RGBA | null {
  const N = 8;
  const canvas = document.createElement('canvas');
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const img = new Image();
  img.src = url;
  // 就绪判定：complete 为 true 且 naturalWidth > 0 才代表图片真的解码完成可绘制
  if (!(img.complete && img.naturalWidth > 0)) return null;
  try {
    ctx.drawImage(img, 0, 0, N, N);
  } catch {
    return null;
  }
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, N, N).data;
  } catch {
    return null; // 跨域污染等
  }
  const px = Math.min(N * N, data.length / 4);
  if (px <= 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  const lums: number[] = [];
  for (let i = 0; i < px; i++) {
    const c: RGBA = {
      r: data[i * 4] / 255,
      g: data[i * 4 + 1] / 255,
      b: data[i * 4 + 2] / 255,
      a: data[i * 4 + 3] / 255,
    };
    r += c.r;
    g += c.g;
    b += c.b;
    lums.push(relativeLuminance(c));
  }
  const mean: RGBA = { r: r / px, g: g / px, b: b / px, a: 1 };
  if (!smallFloat) return mean;
  // 小浮层：P10 低分位（把亮度从低到高排，取第 10% 处），把均值色压暗到该亮度 —— 宁深勿浅
  const sorted = lums.slice().sort((a, b2) => a - b2);
  const p10 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.1))];
  const meanLum = relativeLuminance(mean);
  if (meanLum <= 0 || p10 >= meanLum) return mean;
  const k = Math.min(1, p10 / meanLum);
  return { r: mean.r * k, g: mean.g * k, b: mean.b * k, a: 1 };
}

/**
 * 离屏 canvas 把背景图降采样 8×8 求均值色（按 URL 缓存）。
 *
 * 缓存纪律（QA 修复项 C）：**成功采样之前绝不写 URL 缓存**——坏值（透明黑/纯黑）
 * 一旦入缓存会永久化，看门狗在自定义背景场景将永远不自愈。
 * 三条路径：
 *  ① 图未就绪（首次判级最常见）：本轮返回 null → resolveCustomBg 返回 null →
 *     合成走「无自定义背景」回退基准色；同时发起 img.decode() 异步重试。
 *  ② 异步重试成功：写入缓存，并 scheduleApply() 触发重判，把此前按基准色算出的
 *     判级自动纠正过来（自愈，无需用户再触发）。
 *  ③ 图裂 / 解码失败：不写缓存、本轮回退基准色；下轮任一触发源到来时自然重试
 *     （重试成本被 120ms debounce 与 URL 缓存共同约束，裂图场景每轮一次 decode 请求，可接受）。
 */
function sampleImageColor(url: string, smallFloat: boolean): RGBA | null {
  const cached = bgSampleCache.get(url);
  if (cached) return cached;
  const direct = trySample(url, smallFloat);
  if (direct) {
    bgSampleCache.set(url, direct);
    return direct;
  }
  // 未就绪 / 同步尝试失败：异步等解码完成后重试一次
  const img = new Image();
  img.src = url;
  img
    .decode()
    .then(() => {
      const retry = trySample(url, smallFloat);
      if (retry) {
        bgSampleCache.set(url, retry);
        scheduleApply(); // 采样就绪 → 重判，纠正此前的基准色回退结果
      }
    })
    .catch(() => {
      /* 图裂/解码失败：不缓存，本轮按无自定义背景回退，下轮触发时重试 */
    });
  return null;
}

/**
 * 解析 html 上的 `--app-bg`（ThemeContext 写入的自定义背景值）：
 * 含 url() → 采样图片均值色；否则按颜色解析。均失败返回 null。
 */
function resolveCustomBg(smallFloat: boolean): RGBA | null {
  const root = document.documentElement;
  if (root.getAttribute('data-liquid-custom-bg') !== 'on') return null;
  const appBg = root.style.getPropertyValue('--app-bg').trim();
  if (!appBg) return null;
  const urlMatch = appBg.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
  if (urlMatch) return sampleImageColor(urlMatch[1], smallFloat);
  return parseColor(appBg);
}

/**
 * 有效背景合成：自 el 沿祖先链向上 premultiplied 合成 backgroundColor，
 * 累计 alpha ≥ 0.97 停；到根后垫 --auto-contrast-base；
 * data-liquid-custom-bg 生效时把采样出的背景色垫在最底（自定义背景是整个窗口的最底层）。
 */
function compositeBackground(el: Element): RGBA {
  const rect = el.getBoundingClientRect();
  const smallFloat =
    Math.max(rect.width, rect.height) > 0 && Math.max(rect.width, rect.height) < SMALL_FLOAT_EDGE_PX;

  // 自 el 向上逐层收集，再自底向上合成（祖先层在下方 → over 语义为 祖先 over 累计）
  const layers: RGBA[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    const cs = getComputedStyle(node);
    const c = parseColor(cs.backgroundColor);
    if (c && c.a > 0) layers.push(c);
    if (layers.length > 0 && layers[layers.length - 1].a >= OPAQUE_ENOUGH) break;
    if (node === document.documentElement) break;
  }
  let acc: RGBA = { r: 0, g: 0, b: 0, a: 0 };
  // layers[0] 是 el 自己（最上层），向前遍历到根（最底层）
  for (let i = layers.length - 1; i >= 0; i--) {
    if (acc.a >= OPAQUE_ENOUGH) break;
    acc = compositeOver(layers[i], acc);
  }
  // 自定义背景（图/色）：整个窗口的最底层（在所有 DOM 层之下）——
  // 必须先于基准色垫入，否则不透明基准色会把自定义背景完全盖掉
  const custom = resolveCustomBg(smallFloat);
  if (custom && acc.a < OPAQUE_ENOUGH) acc = compositeOver(custom, acc);
  // 垫基准色（窗口底等效色）：最底层的兜底
  const base = tokenOr('--auto-contrast-base', FALLBACK_BASE);
  if (acc.a < OPAQUE_ENOUGH) acc = compositeOver(base, acc);
  return acc;
}

// ---------------------------------------------------------------------------
// 判级
// ---------------------------------------------------------------------------

/** 计算单个容器的判定结果；返回 null 表示对比度达标、无需干预 */
function judge(el: Element, bg: RGBA): Verdict | null {
  const cs = getComputedStyle(el);
  const textRaw = parseColor(cs.color);
  if (!textRaw) return null;
  // 文字色若带透明度，先合成到背景上得到有效显示色
  const text = textRaw.a >= 1 ? textRaw : compositeOver(textRaw, bg);
  if (contrastRatio(text, bg) >= AA_CONTRAST) return null;
  // 模拟 boost：把 scrim 加深层叠到合成背景上再算一次
  const scrim = tokenOr('--auto-contrast-scrim', FALLBACK_SCRIM);
  const boostedBg = compositeOver(scrim, bg);
  if (contrastRatio(text, boostedBg) >= AA_CONTRAST) return 'boost';
  return 'flip';
}

/** 清除全部受管元素上的 data-auto-contrast 属性 */
function clearAllVerdicts(): void {
  document.querySelectorAll(WATCH_SELECTOR_ALL).forEach((el) => {
    if (el.hasAttribute('data-auto-contrast')) {
      el.removeAttribute('data-auto-contrast');
      verdictCache.delete(el);
    }
  });
}

/** 全量判级：对每个受管容器算合成背景 → 判级 → 写/清 data-auto-contrast */
function applyVerdicts(): void {
  if (!enabled) return;
  const theme = document.documentElement.getAttribute('data-theme');
  // 门禁：非 glass/liquid 主题移除全部属性后早退（观察器保持存活以响应换主题）
  if (!theme || !WATCHED_THEMES.has(theme)) {
    clearAllVerdicts();
    return;
  }
  const els = document.querySelectorAll(WATCH_SELECTOR_ALL);
  els.forEach((el) => {
    const bg = compositeBackground(el);
    const verdict = judge(el, bg);
    // 签名必须包含背景/文字的实际取值：换自定义背景图、调玻璃文字色等都会改变
    // 合成结果，即使判定档位相同也要重算（否则属性停在旧判级上）。
    const textRaw = parseColor(getComputedStyle(el).color);
    const sigText = textRaw
      ? `${Math.round(textRaw.r * 255)},${Math.round(textRaw.g * 255)},${Math.round(textRaw.b * 255)}`
      : 'na';
    const signature = `${theme}|${verdict || 'ok'}|${Math.round(relativeLuminance(bg) * 1000)}|${sigText}`;
    if (verdictCache.get(el) === signature) return; // 无变化，跳过 DOM 写入
    verdictCache.set(el, signature);
    if (verdict) el.setAttribute('data-auto-contrast', verdict);
    else el.removeAttribute('data-auto-contrast');
  });
}

// ---------------------------------------------------------------------------
// 触发（debounce）
// ---------------------------------------------------------------------------

/** 120ms debounce 的全量判级（body childList / portal 挂载用） */
function scheduleApply(): void {
  if (applyDebounceTimer !== null) window.clearTimeout(applyDebounceTimer);
  applyDebounceTimer = window.setTimeout(() => {
    applyDebounceTimer = null;
    applyVerdicts();
  }, 120);
}

/** 200ms debounce 的全量判级（resize 用） */
function scheduleResizeApply(): void {
  if (resizeDebounceTimer !== null) window.clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = window.setTimeout(() => {
    resizeDebounceTimer = null;
    applyVerdicts();
  }, 200);
}

// ---------------------------------------------------------------------------
// 观察器启停
// ---------------------------------------------------------------------------

function startObservers(): void {
  if (rootAttrObserver || bodyObserver) return;
  // 1) documentElement 属性变化：换主题 / 流动开关 / 自定义背景开关
  rootAttrObserver = new MutationObserver(() => scheduleApply());
  rootAttrObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-liquid-flow', 'data-liquid-custom-bg', 'style'],
  });
  // 2) body 子树挂载：捕捉菜单/弹窗 portal 的动态挂载
  bodyObserver = new MutationObserver(() => scheduleApply());
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  // 3) 窗口尺寸变化
  resizeHandler = scheduleResizeApply;
  window.addEventListener('resize', resizeHandler);
  // 立即跑一次，覆盖「先 init 后挂 DOM」的场景
  scheduleApply();
}

function stopObservers(): void {
  rootAttrObserver?.disconnect();
  rootAttrObserver = null;
  bodyObserver?.disconnect();
  bodyObserver = null;
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  if (applyDebounceTimer !== null) {
    window.clearTimeout(applyDebounceTimer);
    applyDebounceTimer = null;
  }
  if (resizeDebounceTimer !== null) {
    window.clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = null;
  }
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 初始化看门狗：注册观察器并跑首轮判级。幂等（多次调用只生效一次）。
 * 在应用入口（main.tsx，主窗与小窗共用同一渲染入口）调用一次。
 */
export function initAutoContrast(): void {
  if (initialized) return;
  initialized = true;
  startObservers();
}

/**
 * 设置开关：true = 启用（重连观察器并立即判级）；
 * false = 清空全部 data-auto-contrast 属性并停止观察，零开销。
 * anim-off 不影响本机制（可读性功能非动画），开关独立于 animMode 三档。
 */
export function setAutoContrastEnabled(on: boolean): void {
  const next = on !== false; // undefined / null 一律视为开启（缺省即默认开启）
  if (!initialized) initAutoContrast();
  if (next === enabled && next) return; // 重复开启无需动作；关闭态必须每次执行（保证属性被清空）
  enabled = next;
  if (enabled) {
    startObservers();
    applyVerdicts();
  } else {
    stopObservers();
    clearAllVerdicts();
  }
}
