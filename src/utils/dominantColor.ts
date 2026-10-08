/**
 * dominantColor.ts
 * 从聊天背景图提取主体色，并派生出「可用的主题主色 + 与之对比清晰的前景色」。
 *
 * 设计目标（v2.3.101）：
 * 1. extractDominantColor：缩放到 ~32×32 后统计主色（出现最多的高频色簇），
 *    对「几乎全透明 / 几乎纯白 / 几乎纯黑」等退化输入返回 null（调用方据此回退主题默认色）。
 * 2. deriveAccent：把主色整理成明度/饱和度可读的主题主色，并计算保证 WCAG AA
 *    （对比度 ≥ 4.5）的前景色（黑或白）。
 * 3. 导出 relativeLuminance / contrastRatio 纯函数便于自测。
 *
 * 注：src 来自 api.getImage()，是 data URL，绘制到 canvas 不会产生跨域污染，
 * 因此可以安全 getImageData。
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** 解析 #rgb / #rrggbb 为 RGB；非法输入返回 null。 */
function hexToRgb(hex: string): RGB | null {
  if (!hex || typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** 把任意数值夹取到 [0,255] 的整数（用于把合成/解析结果规范化为可编码的通道值）。 */
function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** RGB → #rrggbb（越界自动夹取）。 */
export function rgbToHex(r: number, g: number, b: number): string {
  const to2 = (v: number) => clamp255(v).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/** sRGB 通道线性化（WCAG 2.x 相对亮度公式）。 */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 相对亮度（WCAG 2.x）。非法色值回退为 0。 */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
}

/** 对比度（WCAG 2.x）：(L1+0.05)/(L2+0.05)，恒 ≥ 1。 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

interface HSL {
  h: number; // 0..360
  s: number; // 0..1
  l: number; // 0..1
}

function rgbToHsl(rgb: RGB): HSL {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h, s, l };
}

function hslToRgb(hsl: HSL): RGB {
  const h = (((hsl.h % 360) + 360) % 360) / 360;
  const { s, l } = hsl;
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: Math.round(hue2rgb(h + 1 / 3) * 255),
    g: Math.round(hue2rgb(h) * 255),
    b: Math.round(hue2rgb(h - 1 / 3) * 255),
  };
}

function hslToHex(hsl: HSL): string {
  const rgb = hslToRgb(hsl);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/**
 * 从图片 data URL 提取主体色。
 * 成功返回 #rrggbb；图片无效 / 加载失败 / 几乎全透明 / 几乎纯白 / 几乎纯黑 → null。
 */
export function extractDominantColor(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!src || typeof src !== 'string') {
      resolve(null);
      return;
    }

    const img = new Image();

    img.onerror = () => resolve(null);

    img.onload = () => {
      try {
        const SIZE = 32;
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;
        if (!iw || !ih) {
          resolve(null);
          return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          resolve(null);
          return;
        }

        // cover 方式填充到 32×32，避免拉伸变形影响统计
        const scale = Math.max(SIZE / iw, SIZE / ih);
        const dw = iw * scale;
        const dh = ih * scale;
        ctx.drawImage(img, (SIZE - dw) / 2, (SIZE - dh) / 2, dw, dh);

        const { data } = ctx.getImageData(0, 0, SIZE, SIZE);

        // 按每通道 >>4（16 级）分桶统计频次
        const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
        let opaque = 0;
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3];
          if (a < 125) continue; // 跳过近乎透明像素
          opaque++;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const bk = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
          bk.count++;
          bk.r += r;
          bk.g += g;
          bk.b += b;
          buckets.set(key, bk);
        }

        if (opaque === 0) {
          resolve(null); // 几乎全透明
          return;
        }

        let best: { count: number; r: number; g: number; b: number } | null = null;
        // 打分 = 频次 × 饱和度：既偏好高频簇，又避免灰底盖过画面里的彩色主体
        let bestScore = -1;
        for (const bk of buckets.values()) {
          const ar = bk.r / bk.count;
          const ag = bk.g / bk.count;
          const ab = bk.b / bk.count;
          const mx = Math.max(ar, ag, ab);
          const mn = Math.min(ar, ag, ab);
          const sat = mx <= 0 ? 0 : (mx - mn) / mx;
          const score = bk.count * sat;
          if (score > bestScore) {
            bestScore = score;
            best = bk;
          }
        }
        if (!best) {
          resolve(null);
          return;
        }

        // 高频桶内取真实像素平均，得到更精确的主色
        const r = best.r / best.count;
        const g = best.g / best.count;
        const b = best.b / best.count;
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const sat = mx <= 0 ? 0 : (mx - mn) / mx;

        // 退化：几乎纯白 / 几乎纯黑 / 几乎无彩（灰）→ 视为「无有效主体色」
        if (r > 245 && g > 245 && b > 245) {
          resolve(null);
          return;
        }
        if (r < 12 && g < 12 && b < 12) {
          resolve(null);
          return;
        }
        if (sat < 0.12) {
          resolve(null);
          return;
        }

        resolve(rgbToHex(r, g, b));
      } catch {
        resolve(null);
      }
    };

    img.src = src;
  });
}

/** 在给定明度下，某前景文字色的对比度；同时返回该明度对应的 hex。 */
function variantAt(h: number, s: number, l: number): string {
  return hslToHex({ h, s, l: Math.max(0, Math.min(1, l)) });
}

/** 从基准明度出发，朝 dir 方向逐步调整明度，直到与 textColor 对比度 ≥ 4.5。 */
function searchVariant(
  h: number,
  s: number,
  baseL: number,
  textColor: string,
  dir: number
): { hex: string; ratio: number; l: number } {
  let l = baseL;
  let hex = variantAt(h, s, l);
  let ratio = contrastRatio(hex, textColor);
  let guard = 0;
  while (ratio < 4.5 && guard < 80) {
    l += dir;
    hex = variantAt(h, s, l);
    ratio = contrastRatio(hex, textColor);
    guard++;
    if (l <= 0 || l >= 1) break; // 已达极限
  }
  return { hex, ratio, l };
}

/**
 * 把主色整理成可用的主题主色，并计算对比清晰的前景色。
 * 保证返回的 (primary, primaryText) 对比度 ≥ 4.5（WCAG AA 正文）。
 */
export function deriveAccent(baseHex: string): { primary: string; primaryText: string } {
  const rgb = hexToRgb(baseHex) || { r: 58, g: 143, b: 208 }; // 兜底：默认蓝
  const hsl = rgbToHsl(rgb);

  // 提升饱和度（仅对彩色生效；近无彩色不强行造色）+ 夹到可读明度区间，避免过淡/过暗
  const s = hsl.s < 0.08 ? hsl.s : Math.min(1, Math.max(hsl.s, 0.55));
  const l = Math.min(0.62, Math.max(hsl.l, 0.36));

  // 两个方向的候选：变暗配白字 / 变亮配黑字，取偏离基准明度更小者
  const darkForWhite = searchVariant(hsl.h, s, l, '#ffffff', -0.02);
  const lightForBlack = searchVariant(hsl.h, s, l, '#111111', 0.02);

  const darkDelta = Math.abs(darkForWhite.l - l);
  const lightDelta = Math.abs(lightForBlack.l - l);
  const chosen = darkDelta <= lightDelta ? darkForWhite : lightForBlack;
  const primaryText = chosen === darkForWhite ? '#ffffff' : '#111111';

  let primary = chosen.hex;
  let ratio = chosen.ratio;

  // 极端兜底：万一两侧都未达标（理论上不会），强制取对比度更高的一侧
  if (ratio < 4.5) {
    const cw = contrastRatio(primary, '#ffffff');
    const cb = contrastRatio(primary, '#111111');
    if (cw >= cb) return { primary, primaryText: '#ffffff' };
    return { primary, primaryText: '#111111' };
  }

  return { primary, primaryText };
}

/**
 * 当主色被当作**文字色**使用时的「承载面」表面色（RGBA，含不透明度）。
 * 例如 --color-panel 常为半透明（rgba(255,255,255,0.2)），需与底下的
 * --color-bg 合成后才能得到真实的视觉表面色。
 */
export interface RGBA {
  rgb: RGB;
  a: number;
}

/**
 * 解析 CSS 颜色字符串为 { rgb, a }。
 * 支持 `#rgb` / `#rrggbb` / `rgb(r,g,b)` / `rgba(r,g,b,a)`；无法解析返回 null。
 * 说明：此处刻意不处理 `linear-gradient(...)` 等非纯色值（返回 null），调用方据此回退。
 */
export function parseCssColorWithAlpha(v: string): RGBA | null {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (s[0] === '#') {
    const rgb = hexToRgb(s);
    return rgb ? { rgb, a: 1 } : null;
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const r = Number(parts[0]);
      const g = Number(parts[1]);
      const b = Number(parts[2]);
      if (![r, g, b].every((n) => Number.isFinite(n))) return null;
      const aRaw = parts.length >= 4 ? Number(parts[3]) : 1;
      const a = Number.isFinite(aRaw) ? Math.max(0, Math.min(1, aRaw)) : 1;
      return { rgb: { r: clamp255(r), g: clamp255(g), b: clamp255(b) }, a };
    }
  }
  return null;
}

/**
 * 解析 CSS 颜色字符串为 RGB（忽略 alpha）。支持 #rgb/#rrggbb/rgb()/rgba()。
 * 无法解析或非纯色（如渐变）返回 null。
 */
export function parseCssColor(v: string): RGB | null {
  const parsed = parseCssColorWithAlpha(v);
  return parsed ? parsed.rgb : null;
}

/**
 * 把半透明前景 fg（颜色 + alpha）合成到不透明背景 bg 上（source-over），返回不透明 RGB。
 * 用于求「半透明面板压在页面底色上」的真实表面色。
 */
export function compositeOver(fg: { rgb: RGB; a: number }, bg: RGB): RGB {
  const a = Math.max(0, Math.min(1, fg.a));
  const mix = (f: number, b: number) => Math.round(f * a + b * (1 - a));
  return {
    r: clamp255(mix(fg.rgb.r, bg.r)),
    g: clamp255(mix(fg.rgb.g, bg.g)),
    b: clamp255(mix(fg.rgb.b, bg.b)),
  };
}

/**
 * 从 `linear-gradient(...)` 声明中抽取所有颜色色标，规范化为 `#rrggbb`。
 * 支持 #hex 与 rgb()/rgba()；方向关键字（135deg / to right 等）会被忽略；
 * 非渐变输入返回 []。rgba 色标只取其 RGB（忽略其自身 alpha），与调用方
 * 「面板合成到色标」的口径一致。
 */
export function extractGradientStops(v: string): string[] {
  if (!v || typeof v !== 'string') return [];
  const s = v.trim();
  if (!/gradient\(/i.test(s)) return [];
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const inner = s.slice(open + 1, close);

  // 顶层逗号切分（rgba(...) 内部的逗号不算）
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);

  const stops: string[] = [];
  for (const p of parts) {
    const seg = p.trim();
    if (!seg) continue;
    const rgbMatch = seg.match(/rgba?\([^)]*\)/i);
    const hexMatch = seg.match(/#[0-9a-fA-F]{3,8}/);
    const token = rgbMatch ? rgbMatch[0] : hexMatch ? hexMatch[0] : null;
    if (!token) continue;
    const rgb = parseCssColor(token);
    if (rgb) stops.push(rgbToHex(rgb.r, rgb.g, rgb.b));
  }
  return stops;
}

/**
 * 在多重承载面上求解「仅用于文字」的主色。
 *
 * 为何需要「多个承载面」：glass / liquid 这类主题的 --color-bg 是渐变，半透明面板
 * 合成到不同色标会得到亮度跨度很大的表面色（如 glass 从 #505996 到 #b56bb2）。
 * 此时单纯「远离某个亮度」会崩塌，必须对全部候选面同时求解。
 *
 * 求解方式（确定性；**优先保留 accent 色相并留安全余量**，与 deriveAccent「仅调到恰好达标」的既有风格一致）：
 *  1. 候选 ink 保留 accent 的色相/饱和度（彩色 accent 饱和度下限 0.55，与 deriveAccent
 *     同口径），在明度 l ∈ [0,1] 以 0.01 步长扫描（l=0/1 即纯黑/纯白），并额外评估纯黑/纯白；
 *  2. 令 m(ink) = min(contrast(ink, s) for s in primarySurfaces)；
 *  3. **分级取池（保色相 + 留余量）**：优先取 m(ink) ≥ 5.0 的候选；若无则退取 m(ink) ≥ 4.5 的候选；
 *     池内择优规则一致：①|明度 − accent 原明度|最小 ②差 ≤0.02 时以 secondary 最小对比度更大者决胜
 *     ③仍平则最接近 accent 明度；
 *  4. **退化分支**（无任何候选 ≥4.5 时，如 glass 的可达上限仅 3.64）：最大化 m(ink)，
 *     再以 secondary、accent 明度决胜，此时只能退化为最大对比的黑/白。
 *
 * 之所以加 5.0 一级：承载面是「面板/hover 的 alpha 合成到 bg 色标」的**估算**，
 * 未建模 backdrop-filter 的 saturate 等真实渲染偏差，贴着 4.5 交付在工程上过脆；
 * 只要存在 ≥5.0 的同色相候选就用它（色相不变，仅明度更远离 accent 一点），拿不到才退 4.5。
 * primarySurfaces 为空时退化为对 ['#ffffff'] 求解；对任意非空集合都返回确定的颜色。
 */
export function deriveInkForSurfaces(
  accentHex: string,
  primarySurfaces: string[],
  secondarySurfaces?: string[]
): string {
  const acc = parseCssColor(accentHex) || { r: 58, g: 143, b: 208 }; // 兜底：默认蓝
  const hsl = rgbToHsl(acc);
  const s = hsl.s < 0.08 ? hsl.s : Math.min(1, Math.max(hsl.s, 0.55));
  const baseL = hsl.l;

  const primList = (primarySurfaces || []).filter(Boolean);
  const prim = primList.length > 0 ? primList : ['#ffffff'];
  const sec = (secondarySurfaces || []).filter(Boolean);

  const minContrast = (ink: string, surfaces: string[]): number => {
    if (surfaces.length === 0) return 0;
    let m = Number.POSITIVE_INFINITY;
    for (const sf of surfaces) m = Math.min(m, contrastRatio(ink, sf));
    return m;
  };

  interface Candidate {
    hex: string;
    l: number;
    minPrim: number;
    minSec: number;
  }
  const candidates: Candidate[] = [];
  const push = (hex: string, l: number): void => {
    candidates.push({ hex, l, minPrim: minContrast(hex, prim), minSec: minContrast(hex, sec) });
  };

  for (let i = 0; i <= 100; i++) {
    const l = i / 100;
    push(hslToHex({ h: hsl.h, s, l }), l);
  }
  push('#000000', 0);
  push('#ffffff', 1);

  // 分级取池：优先 m(ink) ≥5.0（保色相 + 留安全余量），其次 ≥4.5，都没有才走退化分支
  let feasible = candidates.filter((c) => c.minPrim >= 5.0);
  if (feasible.length === 0) feasible = candidates.filter((c) => c.minPrim >= 4.5);

  let pool: Candidate[];
  if (feasible.length > 0) {
    // 3a. 明度最接近 accent 原始明度
    let minDelta = Number.POSITIVE_INFINITY;
    for (const c of feasible) minDelta = Math.min(minDelta, Math.abs(c.l - baseL));
    const closePool = feasible.filter((c) => Math.abs(c.l - baseL) <= minDelta + 0.02);
    // 3b. 同分（差 ≤0.02）→ secondary 最小对比度更大者决胜
    let maxSec = Number.NEGATIVE_INFINITY;
    for (const c of closePool) if (c.minSec > maxSec) maxSec = c.minSec;
    pool = closePool.filter((c) => c.minSec >= maxSec - 1e-9);
  } else {
    // 4. 无候选可达标（如 glass 上限 3.64）→ 退化为最大化 m(ink)
    let maxPrim = Number.NEGATIVE_INFINITY;
    for (const c of candidates) if (c.minPrim > maxPrim) maxPrim = c.minPrim;
    const tiedPrim = candidates.filter((c) => c.minPrim >= maxPrim - 0.05);
    let maxSec = Number.NEGATIVE_INFINITY;
    for (const c of tiedPrim) if (c.minSec > maxSec) maxSec = c.minSec;
    pool = tiedPrim.filter((c) => c.minSec >= maxSec - 1e-9);
  }

  // 最终：明度最接近 accent 原始明度
  let best = pool[0];
  for (const c of pool) {
    if (Math.abs(c.l - baseL) < Math.abs(best.l - baseL)) best = c;
  }
  return best.hex;
}

/**
 * 把一个「承载层」（面板 / hover / 磨砂遮罩）合成到页面底色上，得到该层实际压住的表面色集合。
 * - 底色可解析为纯色 → 单个表面色（该层合成到该纯色）；
 * - 底色是渐变 → 对每个色标各合成一个表面色（覆盖该层在渐变上所有可能位置）；
 * - 色标抽取为空 → 以中灰近似兜底。
 */
function layerOverBg(layerCss: string, bgCss: string): string[] {
  const layer = parseCssColorWithAlpha(layerCss) || { rgb: { r: 255, g: 255, b: 255 }, a: 0 };
  const bgSolid = parseCssColor(bgCss);
  if (bgSolid) {
    const c = compositeOver(layer, bgSolid);
    return [rgbToHex(c.r, c.g, c.b)];
  }
  const stops = extractGradientStops(bgCss);
  const list = stops.length > 0 ? stops : ['#808080'];
  return list.map((st) => {
    const rgb = parseCssColor(st) || { r: 128, g: 128, b: 128 };
    const c = compositeOver(layer, rgb);
    return rgbToHex(c.r, c.g, c.b);
  });
}

/**
 * 由「半透明面板色 + 页面底色（+ 可选 hover 底色）」推导 ink 文字的主要承载面集合。
 * - 面板层：等价 layerOverBg(panel, bg)；
 * - hover 层：仓库里存在唯一一处在 `--color-hover` 底上使用 ink 文字
 *   （Library.tsx 徽标 background:var(--color-hover) + color:var(--color-primary-ink)），
 *   故把 `--color-hover` 也按同样规则合成后**追加**进集合，避免 solver 遗漏该承载面。
 *   hover 多为近白/近灰，纳入后可能要求更深的 ink —— 这正是如实反映真实承载面。
 *   hoverCss 缺省或解析失败则不追加。
 */
export function computePrimarySurfaces(
  panelCss: string,
  bgCss: string,
  hoverCss?: string
): string[] {
  const surfaces = layerOverBg(panelCss, bgCss);
  if (hoverCss && parseCssColorWithAlpha(hoverCss)) {
    surfaces.push(...layerOverBg(hoverCss, bgCss));
  }
  return surfaces;
}

/**
 * 由「聊天磨砂遮罩色 + 页面底色」推导 ink 文字的次要承载面集合：
 * 把 `--color-chat-scrim` 合成到与 primary **相同的 bg 色标**上
 * （bg 纯色 → 1 面；bg 渐变 → 逐色标各 1 面）。
 *
 * 注：不再用「遮罩压纯黑/纯白图」——纯黑/纯白图会被 extractDominantColor 判为无效主体色，
 * 根本不会触发染色，属不可达面，会误导决胜。用 bg 色标更贴近真实承载位置。
 * 无法解析遮罩色时返回 undefined（调用方据此前置该维度的决胜失效）。
 */
export function computeSecondarySurfaces(scrimCss: string, bgCss: string): string[] | undefined {
  if (!parseCssColorWithAlpha(scrimCss)) return undefined;
  return layerOverBg(scrimCss, bgCss);
}

/**
 * 单承载面便捷封装：等价于 deriveInkForSurfaces(accentHex, [surfaceHex])。
 * 保留原签名以兼容既有调用与测试。
 */
export function deriveInk(accentHex: string, surfaceHex: string): string {
  return deriveInkForSurfaces(accentHex, [surfaceHex]);
}
