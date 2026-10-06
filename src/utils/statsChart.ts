/**
 * 统计页饼图配色与几何工具（v2.3.94 需求 11 · 板块一）
 * ============================================================================
 * 设计约束（用户铁律）：
 *   - **不得硬编码一套配色**：项目有 14 套主题，深色/浅色/渐变背景差异极大，
 *     写死 `#7c6cf0` 之类的色板在「经典微信」（浅灰底）与「极光夜」（深紫渐变底）
 *     上都会撞色甚至糊在一起。故配色从**当前主题的 CSS 变量**现场取色生成。
 *   - **可访问性 WCAG AA**：tooltip 的文字/背景对比度必须 ≥ 4.5:1，
 *     且不能用「浅灰压浅色背景」。做法是 tooltip 一律用「面板色底 + 主文字色」，
 *     并用 {@link readableTextOn} 按背景相对亮度二选一黑/白字。
 */

/** 从 documentElement 读取某个 CSS 变量的值（取不到返回空串） */
export function cssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return '';
  }
}

/** 解析 `#rgb` / `#rrggbb` / `rgb()` / `rgba()` 为 [r,g,b]；不支持（渐变/颜色名等）返回 null */
export function parseCssColor(input: string): [number, number, number] | null {
  const s = (input || '').trim().toLowerCase();
  if (!s) return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return [
        parseInt(h[0] + h[0], 16),
        parseInt(h[1] + h[1], 16),
        parseInt(h[2] + h[2], 16),
      ];
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(s);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** 相对亮度（WCAG 定义，sRGB → 线性化） */
export function relativeLuminance(rgb: [number, number, number]): number {
  const chan = rgb.map((v) => {
    const c = Math.min(255, Math.max(0, v)) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

/** 两色对比度（WCAG 2.x 定义） */
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 给定背景色，返回可读的前景色（黑或白）。
 * 取「与背景对比度更高」的那个，保证任何主题下都 ≥ 4.5:1（AA 正文）。
 */
export function readableTextOn(bg: [number, number, number]): string {
  return contrastRatio(bg, [255, 255, 255]) >= contrastRatio(bg, [0, 0, 0]) ? '#ffffff' : '#101010';
}

/** HSL → CSS 颜色字符串（h: 0-360, s/l: 0-1） */
function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(((h % 360) + 360) % 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

/** #rrggbb → HSL（用于在主题主色基础上派生出同色系但可区分的邻近色） */
function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const rgbv = parseCssColor(hex);
  if (!rgbv) return null;
  const r = rgbv[0] / 255;
  const g = rgbv[1] / 255;
  const b = rgbv[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s, l };
}

/** 判定当前主题是否为「深色底」（用于决定扇区明度档位） */
function isDarkTheme(): boolean {
  // 优先用面板色亮度；面板色解析不了（如渐变主题）时退回背景色，再退回 --color-text
  for (const v of [cssVar('--color-panel'), cssVar('--color-bg'), cssVar('--color-text')]) {
    const rgbv = parseCssColor(v);
    if (rgbv) return relativeLuminance(rgbv) < 0.4;
  }
  return false;
}

/** 主题语义色变量清单（按语义取色，跨 14 套主题都能得到协调的一组色） */
const THEME_SEED_VARS = [
  '--color-primary',
  '--color-info',
  '--color-success',
  '--color-warn',
  '--color-danger',
];

/**
 * 生成 count 个扇区颜色。
 *
 * 策略（三层兜底，保证任何主题都有可用配色）：
 *   1. 先取当前主题的语义色变量（primary/info/success/warn/danger）——它们本身就是主题协调色；
 *   2. 不够就用主题主色的 **HSL 色相环等分 + 明度交替**派生（保证色相分散、相邻可辨，
 *      明度档位按主题深浅自动切换，深色主题用高明度、浅色主题用中明度）；
 *   3. 连主色都取不到（极端自定义主题）→ 走最后的中性彩虹兜底。
 *
 * @param count 需要的颜色数量
 * @returns 长度至少为 count 的颜色数组（元素为任意合法 CSS 颜色）
 */
export function buildPiePalette(count: number): string[] {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (c: string): void => {
    const key = c.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(c.trim());
  };

  // 1) 主题语义色
  for (const v of THEME_SEED_VARS) {
    const raw = cssVar(v);
    // 只接受可解析的纯色（渐变色如 --color-bg 会被 parseColor 拒掉，自然跳过）
    if (parseCssColor(raw)) push(raw);
    if (out.length >= n) return out.slice(0, n);
  }

  // 2) 由主色派生（色相环等分 + 明度交替）
  // 用一个「必定非 null」的兜底对象收窄类型，避免每处都写 `base!`（易被后续重构踩坏）
  const found = hexToHsl(cssVar('--color-primary'));
  const base: { h: number; s: number; l: number } = found || { h: 210, s: 0.7, l: 0.5 };
  const dark = isDarkTheme();
  // 深色底 → 明度 0.62/0.46 两档；浅色底 → 0.52/0.38 两档（都与面板底有足够对比）
  const lightHigh = dark ? 0.66 : 0.54;
  const lightLow = dark ? 0.46 : 0.38;
  let i = 0;
  while (out.length < n && i < n * 4) {
    const hue = base.h + (360 / Math.max(3, n)) * i;
    const l = i % 2 === 0 ? lightHigh : lightLow;
    // 饱和度：主色本身过淡（如微信绿 s≈0.86 尚可，但某些主题 s 很低）时兜底抬到 0.55
    const s = Math.max(0.55, Math.min(0.85, base.s));
    push(hsl(hue, s, l));
    i += 1;
  }

  // 3) 中性彩虹兜底（理论上不会走到，留着是为了「主题变量全缺」时不至于崩）
  let h = 0;
  while (out.length < n) {
    push(hsl(h, 0.62, dark ? 0.6 : 0.46));
    h += 360 / Math.max(1, n);
  }
  return out.slice(0, n);
}

/**
 * 取一个用于「其它」聚合项的灰色（跟随主题文字色，避免浅灰压浅色背景不可读）。
 */
export function otherSliceColor(): string {
  const t = parseCssColor(cssVar('--color-text-muted')) || parseCssColor(cssVar('--color-text-secondary'));
  if (!t) return isDarkTheme() ? '#9aa0a6' : '#6b7280';
  // 与面板底对比不足时压暗/提亮到满足 AA
  let c = t;
  for (let k = 0; k < 6; k += 1) {
    if (contrastRatio(c, [255, 255, 255]) >= 4.5 || relativeLuminance(c) < 0.2) break;
    c = [Math.round(c[0] * 0.82), Math.round(c[1] * 0.82), Math.round(c[2] * 0.82)];
  }
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// ============ 饼图几何（SVG path 生成）============

/** 极坐标 → 直角坐标；angle 以「12 点方向」为 0，顺时针增长（单位：度） */
function polar(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/**
 * 生成一个「圆环扇区」的 SVG path。
 *
 * @param cx,cy     圆心
 * @param rOuter    外半径
 * @param rInner    内半径（0 即为实心扇形/传统饼图）
 * @param startDeg  起始角（12 点为 0，顺时针）
 * @param endDeg    结束角
 */
export function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startDeg: number,
  endDeg: number
): string {
  const sweep = Math.max(0, endDeg - startDeg);
  // 整圆（>=359.99°）必须拆成两段，否则起止点重合 → SVG 什么都不画
  if (sweep >= 359.999) {
    const half = startDeg + 180;
    return `${arcPath(cx, cy, rOuter, rInner, startDeg, half)} ${arcPath(cx, cy, rOuter, rInner, half, endDeg)}`;
  }
  if (sweep <= 0.001) return '';
  const largeArc = sweep > 180 ? 1 : 0;
  const [x1, y1] = polar(cx, cy, rOuter, startDeg);
  const [x2, y2] = polar(cx, cy, rOuter, endDeg);
  if (rInner <= 0) {
    return `M ${cx} ${cy} L ${x1} ${y1} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2} ${y2} Z`;
  }
  const [x3, y3] = polar(cx, cy, rInner, endDeg);
  const [x4, y4] = polar(cx, cy, rInner, startDeg);
  return (
    `M ${x1} ${y1} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2} ${y2} ` +
    `L ${x3} ${y3} A ${rInner} ${rInner} 0 ${largeArc} 0 ${x4} ${y4} Z`
  );
}

/** 陪伴时长的「拆解结果」（毫秒 → 天/小时/分/秒），由调用方用 i18n 拼单位，避免硬编码 d/h/m/s */
export interface CompanionParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** 不足 1 分钟时的秒数（用于「刚刚」级别的极短时长展示） */
  onlySeconds: boolean;
}

/** 把毫秒拆成天/时/分/秒（不含单位文案 —— 文案由调用方走 i18n，保证 10 种语言都能正确显示） */
export function splitCompanion(ms: number): CompanionParts {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
    onlySeconds: total < 60,
  };
}