#!/usr/bin/env node
/**
 * verify-dye-contrast.mjs — 「背景取色染色」文字对比度常驻闸门（v2.3.101）
 *
 * 为什么需要它：`--color-primary-ink` 是**文字色**，而它的承载面不是某个固定色，
 * 而是「半透明面板/悬浮态 合成到 bg 色标」。这类推导极易在后续改主题/改面板 alpha 时
 * 静默退化（v2.3.101 就真实出现过：渐变主题下承载面推错 → ink 压上去只有 1.3:1）。
 * 本脚本把它固化成可回归的断言。
 *
 * 关键设计：**直接 import 真实实现**（Node 22 原生 type-stripping 可加载 .ts），
 * 不复制一份公式 —— 复制出来的「影子实现」会与被测代码一起跑偏，是无效 oracle。
 * （唯一例外：色相/饱和度辅助函数用于 G3，不参与对比度主判据；见文件末注释。）
 *
 * ⚠️ 本闸门的**能力边界**（经独立审计确认，避免过度信赖）：
 *   - 它守的是「承载面/CSS 层面」的回归（改面板 alpha、删 --color-hover 登记、改 bg 色标）。
 *   - 它**守不住**「目标函数被改成退化实现」这类回归的**一部分**：因为非 glass 的
 *     `minPrim` 由实现自身的「≥5.0 取池」策略保证，accent 换色不会让它掉下来。
 *     故另设 G1c 直接断言该策略仍生效（余量线），并在 §断言表 里区分「产品线」与「策略线」。
 *
 * 判定门（对 variables.css 里**当前全部**主题自动生效，加主题即自动纳入）：
 *   G0  覆盖完整性：解析到的主题数 == 源码里 `[data-theme=...]` 出现次数（防静默漏解析）
 *   G1  【产品线】非 glass：任意 accent 下 min 对比度 ≥ 4.5（WCAG AA 硬线）
 *   G1c 【策略线】非 glass：min 对比度 ≥ 4.99（证明「≥5.0 取池 + 余量」策略仍在）
 *   G2  glass：min 对比度 == 该主题的**数学可达上界**（穷举复核，±0.01）
 *   G2b glass 上界 <4.5（CSS 数据守卫，**不检验实现**，仅记录事实）
 *   G3  色相保留：非 glass + 有彩 accent → ink 不得退化成纯黑/纯白
 *   G3b 色相保留：Δhue ≤ 2°（且样本非空时才有意义，空集判失败）
 *   G4  【次要承载面】min 对比度 ≥ 4.5（聊天磨砂面上的 ink 文字）
 *
 * 可证伪性（NY_* 必须让脚本**失败**，用来证明断言是活的、非空转）：
 *   NY_DYE_DROP_HOVER=1  去掉 hover 合成面（模拟「有人删了 --color-hover 登记」）→ 必须失败
 *   NY_DYE_FORCE_BLACK=1 强制 ink=#000000（模拟「目标函数被改回最大对比」）→ 必须失败
 * 注：注入模式下**一律** exit 1；「是否真捕获」以打印出的 ✗ 明细与 fail 计数为准。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const {
  contrastRatio,
  computePrimarySurfaces,
  computeSecondarySurfaces,
  deriveInkForSurfaces,
  deriveAccent,
  parseCssColor,
  parseCssColorWithAlpha,
  rgbToHex,
} = await import(new URL('../src/utils/dominantColor.ts', import.meta.url).href);

const DROP_HOVER = process.env.NY_DYE_DROP_HOVER === '1';
const FORCE_BLACK = process.env.NY_DYE_FORCE_BLACK === '1';

let pass = 0;
let fail = 0;
const failures = [];
/** 明细只列前 N 条，避免一屏刷屏掩盖真正的结论 */
const brief = (xs, n = 6) =>
  xs.length <= n ? xs.join(' ') : `${xs.slice(0, n).join(' ')} …（共 ${xs.length} 条）`;
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    const line = `  ✗ ${name}${extra ? ' — ' + extra : ''}`;
    failures.push(line);
    console.log(line);
  }
};

// ---------- 1. 解析 variables.css 的主题变量 ----------
const cssRaw = fs.readFileSync(path.join(ROOT, 'src/theme/variables.css'), 'utf8');
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 抽出顶层 `选择器 { ... }` 块（按花括号配平扫描）。
 * 跳过 @property/@media 等 at-rule 的**块体**（推进 lastIndex），避免其内部内容被当顶层。
 */
function topLevelBlocks(src) {
  const out = [];
  const opener = /^[ \t]*([^\s{}][^{}\n]*?)[ \t]*\{/gm;
  let m;
  while ((m = opener.exec(src)) !== null) {
    const sel = m[1].trim();
    const braceStart = src.indexOf('{', m.index);
    let depth = 0;
    let i = braceStart;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    // 无论是否采纳，都要跳过整块（否则 at-rule 块体内会被误当顶层）
    opener.lastIndex = i + 1;
    if (!sel || sel.startsWith('@') || sel.startsWith('*')) continue;
    out.push({ sel, body: src.slice(braceStart + 1, i) });
  }
  return out;
}

const blocks = topLevelBlocks(css);
// 单/双引号都要认，否则改引号会静默丢主题
const themeSelRe = /^\[data-theme=['"]([^'"]+)['"]\]$/;
const themes = [];
for (const b of blocks) {
  const nameMatch = b.sel.match(themeSelRe);
  const isRoot = b.sel === ':root';
  if (!nameMatch && !isRoot) continue;
  const get = (prop) => {
    const mm = b.body.match(new RegExp('--' + prop + '\\s*:\\s*([^;]*);'));
    return mm ? mm[1].trim() : null;
  };
  themes.push({
    name: isRoot ? ':root(默认)' : nameMatch[1],
    bg: get('color-bg'),
    panel: get('color-panel'),
    hover: get('color-hover'),
    scrim: get('color-chat-scrim'),
  });
}

// 防静默漏解析：源码里出现多少次 `[data-theme=`，就必须解析出多少个主题块
const declaredThemeCount = (css.match(/\[data-theme=/g) || []).length;
const parsedThemeCount = themes.filter((t) => !t.name.startsWith(':root')).length;

const rootTheme = themes.find((t) => t.name.startsWith(':root')) || {};
const resolved = themes.map((t) => ({
  name: t.name,
  bg: t.bg ?? rootTheme.bg,
  panel: t.panel ?? rootTheme.panel,
  hover: t.hover ?? rootTheme.hover,
  scrim: t.scrim ?? rootTheme.scrim,
}));

check(
  `G0 主题块无漏解析（源码声明 ${declaredThemeCount} 个 == 解析 ${parsedThemeCount} 个）`,
  declaredThemeCount === parsedThemeCount,
  `源码 ${declaredThemeCount} vs 解析 ${parsedThemeCount}`
);
check(
  `G0b 每个主题都能解析出 --color-bg 与 --color-panel（共 ${resolved.length} 项）`,
  resolved.length > 0 && resolved.every((t) => t.bg && t.panel),
  resolved.filter((t) => !t.bg || !t.panel).map((t) => t.name).join(',')
);

/**
 * 复现浏览器对 `--color-chat-scrim` 的**计算值**。
 * 生产侧 `--color-chat-scrim` 已用 `@property syntax:'<color>'` 注册，故 getComputedStyle
 * 返回的是**已求值的颜色**；默认值写法是
 *   color-mix(in srgb, var(--color-bg) 70%, transparent)
 * 等价于「--color-bg 以 70% alpha 呈现」。本函数把它解析成可被 computeSecondarySurfaces
 * 接受的 rgba(...) 文本，使闸门的次要承载面口径与生产**一致**（否则该维度会被误判为空转）。
 * 若 --color-bg 是渐变则 color-mix 本身非法（浏览器亦得无效值）→ 返回 null。
 */
function resolveScrimCss(scrimCss, bgCss) {
  if (!scrimCss) return null;
  if (parseCssColorWithAlpha(scrimCss)) return scrimCss; // 已可直接解析（rgba / color-mix 之外的写法）
  const m = scrimCss.match(
    /color-mix\(\s*in\s+srgb\s*,\s*var\(\s*--color-bg\s*\)\s+([\d.]+)%\s*,\s*transparent\s*\)/i
  );
  if (!m) return null;
  const bg = parseCssColor(bgCss);
  if (!bg) return null; // 渐变色 → color-mix 非法，生产同样无效
  const a = parseFloat(m[1]) / 100;
  return `rgba(${bg.r}, ${bg.g}, ${bg.b}, ${a})`;
}

// ---------- 2. accent 样本（覆盖色相环 + 灰阶 + 极端白/黑） ----------
const SWATCHES = [
  '#ffd400', '#3a8fd0', '#9aa0a6', '#ffffff', '#ff6b6b',
  '#7c6cf0', '#000000', '#8b5a2b', '#2c3e50', '#22c55e',
];

// ---------- 3. 辅助（仅 G3 色相判定使用；对比度一律用真实实现） ----------
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hueOf = (h) => {
  const [r0, g0, b0] = hexToRgb(h).map((v) => v / 255);
  const max = Math.max(r0, g0, b0);
  const min = Math.min(r0, g0, b0);
  const d = max - min;
  if (d === 0) return null; // 无彩色
  let hh;
  if (max === r0) hh = ((g0 - b0) / d) % 6;
  else if (max === g0) hh = (b0 - r0) / d + 2;
  else hh = (r0 - g0) / d + 4;
  return ((hh * 60) % 360 + 360) % 360;
};
const satOf = (h) => {
  const [r, g, b] = hexToRgb(h).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return 0;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
};
const hueDelta = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

const minContrast = (ink, surfaces) =>
  surfaces && surfaces.length ? Math.min(...surfaces.map((s) => contrastRatio(ink, s))) : null;

/** 穷举某组承载面下「任何单一 ink」的可达上界（32³ 网格 + 精确黑白） */
function achievableCeiling(surfaces) {
  let best = -1;
  let bestInk = null;
  const consider = (rgb) => {
    const h = rgbToHex(rgb[0], rgb[1], rgb[2]);
    const m = Math.min(...surfaces.map((s) => contrastRatio(h, s)));
    if (m > best) {
      best = m;
      bestInk = h;
    }
  };
  consider([0, 0, 0]);
  consider([255, 255, 255]);
  for (let r = 0; r <= 255; r += 8)
    for (let g = 0; g <= 255; g += 8)
      for (let b = 0; b <= 255; b += 8) consider([r, g, b]);
  return { m: best, ink: bestInk };
}

// ---------- 4. 主矩阵 ----------
// 注意：注入模式下「推导用」承载面去掉 hover，但「校验用」承载面仍含 hover
// —— 这才是真实回归形态（有人删掉 --color-hover 登记 → ink 不再考虑 hover 面，
//    但用户实际看到的 hover 芯片底没变），必须按真实面测量才能捕获。
const rows = [];
for (const t of resolved) {
  const deriveSurfaces = computePrimarySurfaces(t.panel, t.bg, DROP_HOVER ? undefined : t.hover || undefined);
  const checkSurfaces = computePrimarySurfaces(t.panel, t.bg, t.hover || undefined);
  const secondarySurfaces = computeSecondarySurfaces(resolveScrimCss(t.scrim, t.bg) || '', t.bg);
  for (const sw of SWATCHES) {
    const { primary } = deriveAccent(sw);
    let ink = deriveInkForSurfaces(primary, deriveSurfaces, secondarySurfaces);
    if (FORCE_BLACK) ink = '#000000';
    rows.push({
      theme: t.name,
      swatch: sw,
      accent: primary,
      ink,
      mPrim: minContrast(ink, checkSurfaces),
      mSec: minContrast(ink, secondarySurfaces),
      isGlass: t.name === 'glass',
    });
  }
}

console.log('主题'.padEnd(14) + 'accent'.padEnd(9) + 'ink'.padEnd(10) + 'minPrim'.padEnd(9) + 'minSec');
for (const r of rows) {
  console.log(
    r.theme.padEnd(14) +
      r.accent.padEnd(9) +
      r.ink.padEnd(10) +
      r.mPrim.toFixed(2).padEnd(9) +
      (r.mSec === null ? '—' : r.mSec.toFixed(2))
  );
}

const nonGlass = rows.filter((r) => !r.isGlass);
const glassRows = rows.filter((r) => r.isGlass);
const minNonGlass = Math.min(...nonGlass.map((r) => r.mPrim));
const minNonGlassSec = Math.min(...nonGlass.filter((r) => r.mSec !== null).map((r) => r.mSec));
const secRowsExist = nonGlass.some((r) => r.mSec !== null);
console.log(`\n非 glass 最小 minPrim = ${minNonGlass.toFixed(3)}  最小 minSec = ${secRowsExist ? minNonGlassSec.toFixed(3) : '—'}`);

// ---------- G1 / G1c: 产品线（AA）与策略线（余量） ----------
check(
  `G1【产品线】非 glass 全部 ≥4.5（WCAG AA 硬线，实际最小 ${minNonGlass.toFixed(3)}）`,
  minNonGlass >= 4.5,
  brief(nonGlass.filter((r) => r.mPrim < 4.5).map((r) => `${r.theme}/${r.swatch}=${r.mPrim.toFixed(2)}`))
);
check(
  `G1c【策略线】非 glass 全部 ≥4.99（证明「≥5.0 取池 + 余量」仍生效，实际最小 ${minNonGlass.toFixed(3)}）`,
  minNonGlass >= 4.99,
  brief(nonGlass.filter((r) => r.mPrim < 4.99).map((r) => `${r.theme}/${r.swatch}=${r.mPrim.toFixed(2)}`))
);

// ---------- G2 / G2b: glass 达到数学上界 ----------
const glassTheme = resolved.find((x) => x.name === 'glass');
const glassSurfaceSet = computePrimarySurfaces(glassTheme.panel, glassTheme.bg, glassTheme.hover || undefined);
const ceiling = achievableCeiling(glassSurfaceSet);
const glassMin = Math.min(...glassRows.map((r) => r.mPrim));
check(
  `G2【产品线】glass 已达数学可达上界（${glassMin.toFixed(3)} vs 上界 ${ceiling.m.toFixed(3)}）`,
  Math.abs(glassMin - ceiling.m) <= 0.01,
  `glass=${glassMin.toFixed(3)} ceiling=${ceiling.m.toFixed(3)}`
);
check(
  `G2b 玻璃上界确实 <4.5（CSS 数据守卫·不检验实现）`,
  ceiling.m < 4.5,
  `ceiling=${ceiling.m.toFixed(3)}`
);

// ---------- G3 / G3b: 色相保留 ----------
const chromatic = nonGlass.filter((r) => satOf(r.swatch) >= 0.2);
const blackWhite = chromatic.filter((r) => ['#000000', '#ffffff'].includes(r.ink.toLowerCase()));
check(
  `G3【产品线】有彩 accent 下 ink 未退化为纯黑/纯白（${chromatic.length} 格）`,
  blackWhite.length === 0,
  brief(blackWhite.map((r) => `${r.theme}/${r.swatch}→${r.ink}`))
);
const hueDeltas = chromatic
  .map((r) => {
    const ha = hueOf(r.accent);
    const hi = hueOf(r.ink);
    return ha === null || hi === null ? null : { r, d: hueDelta(ha, hi) };
  })
  .filter(Boolean);
const maxHue = hueDeltas.length ? Math.max(...hueDeltas.map((x) => x.d)) : Infinity;
check(
  `G3b【产品线】ink 与 accent 色相 Δhue ≤2°（样本 ${hueDeltas.length}/${chromatic.length}，最大 ${
    hueDeltas.length ? maxHue.toFixed(2) + '°' : 'N/A'
  }）`,
  hueDeltas.length > 0 && maxHue <= 2,
  hueDeltas.length === 0
    ? '所有样本 ink 均为无彩色（Δhue 无从计算）→ 判失败，防止空集真空通过'
    : brief(hueDeltas.filter((x) => x.d > 2).map((x) => `${x.r.theme}/${x.r.swatch} Δ${x.d.toFixed(2)}°`))
);

// ---------- G4: 次要承载面（聊天磨砂面） ----------
check(
  `G4【产品线】非 glass 次要承载面 minSec ≥4.5（${
    secRowsExist ? '实际最小 ' + minNonGlassSec.toFixed(3) : '未解析到任何 scrim'
  }）`,
  secRowsExist && minNonGlassSec >= 4.5,
  secRowsExist
    ? brief(nonGlass.filter((r) => r.mSec !== null && r.mSec < 4.5).map((r) => `${r.theme}/${r.swatch}=${r.mSec.toFixed(2)}`))
    : 'computeSecondarySurfaces 对所有主题都返回 undefined —— scrim 解析失效，该维度形同虚设'
);

// ---------- 可证伪性自证 ----------
if (DROP_HOVER || FORCE_BLACK) {
  const mode = DROP_HOVER ? 'NY_DYE_DROP_HOVER=1' : 'NY_DYE_FORCE_BLACK=1';
  const broken = fail > 0;
  console.log(
    `\n[可证伪性] ${mode} → ${broken ? '断言已捕获回归（符合预期）' : '未捕获任何回归（断言是死代码！）'}`
  );
  if (!broken) {
    console.error(`  ✗ ${mode} 未能使闸门失败 —— 断言无效`);
    process.exit(1);
  }
  console.log('  说明：注入模式的退出码恒为 1（便于 CI 区分），「是否真捕获」以上方 ✗ 明细为准。');
  process.exit(1);
}

// ---------- 汇总 ----------
console.log(`\n断言：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.error('\n失败明细：');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('✅ 染色文字对比度闸门通过');
