/**
 * 琉璃幻境（aura）主题色派生工具（v2.3.109 需求 2c）。
 *
 * 用户在设置里为 aura 主题选定任意主题色（accent）后，需要为它配一个可读的
 * 文字色（--color-primary-text）：亮色 accent 配深字、暗色 accent 配白字。
 * 这里实现一个最小纯函数集（WCAG 2.x 相对亮度 + 对比度），**不复活** v2.3.101
 * 已下线的 dominantColor 染色体系 —— 只做「二选一」判定，不做色彩空间搜索。
 *
 * 基准取自 variables.css 的 aura 块出厂值：深字 #06222a（默认青色 accent 的配字）。
 */

/** 深色文字：aura 主题的出厂 primary-text（亮 accent 下使用） */
export const AURA_PRIMARY_TEXT_DARK = '#06222a';
/** 亮色文字：暗 accent 下的兜底 */
export const AURA_PRIMARY_TEXT_LIGHT = '#ffffff';

/** 解析 #rgb / #rrggbb 为 { r, g, b }（0~255）；非法输入返回 null */
export function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  let s = (hex || '').trim();
  if (!s.startsWith('#')) return null;
  s = s.slice(1);
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

/** WCAG 2.x 相对亮度（0~1，sRGB 线性化 + 加权） */
export function relativeLuminance(hex: string): number | null {
  const c = parseHexColor(hex);
  if (!c) return null;
  const lin = (v: number) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 对比度（1~21）；任一色非法返回 null */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 按对比度二选一：返回与 accent 对比度更高的文字色。
 *  - 亮 accent（如出厂 #45e0c8）→ 深字 #06222a；
 *  - 暗 accent（如深蓝/深紫）→ 白字 #ffffff。
 * accent 非法（非 #hex）时回退出厂深字（与 variables.css 默认一致，不会拿到空值）。
 */
export function auraPrimaryText(accent: string): string {
  const dark = contrastRatio(accent, AURA_PRIMARY_TEXT_DARK);
  const light = contrastRatio(accent, AURA_PRIMARY_TEXT_LIGHT);
  if (dark === null && light === null) return AURA_PRIMARY_TEXT_DARK;
  return (light ?? -1) > (dark ?? -1) ? AURA_PRIMARY_TEXT_LIGHT : AURA_PRIMARY_TEXT_DARK;
}

/** auraAccent 设置值的合法性校验（只接受 #rgb / #rrggbb；非法 = 未设置，回退主题默认） */
export function isValidAuraAccent(v: string | undefined | null): v is string {
  return typeof v === 'string' && parseHexColor(v) !== null;
}
