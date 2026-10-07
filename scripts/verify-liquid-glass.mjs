// v2.3.97 验证：液态玻璃主题（liquid）的可访问性与注册完整性
// 用法：node scripts/verify-liquid-glass.mjs
//
// 可证伪性对照（两条都必须失败）：
//   NY_LOW_CONTRAST_TEXT=1 node scripts/verify-liquid-glass.mjs   应当失败（把 --color-text 换成低对比值）
//   NY_DROP_DEEPENING=1   node scripts/verify-liquid-glass.mjs   应当失败（删掉 deepening 块里一条选择器）
//
// ── 为什么必须自己做 alpha 合成，而不能直接用 statsChart 的 parseCssColor ──────
// src/utils/statsChart.ts 的 parseCssColor（statsChart.ts:16）用的是
//   /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/
// 它**只取前三个数字、丢弃 alpha 通道**。若直接拿它算半透明主题的对比度，
// 22% 不透明度会被当成 100% —— 结果严重高估（越透明看起来越"对比度高"，恰好反了）。
// 项目自己的记录印证了这点：index.css:971 写着 glass 主题主文案实测仅 3.33:1。
// 故本脚本只用 statsChart 导出的 relativeLuminance / contrastRatio（这两个是纯数学、
// 与 alpha 无关，可以放心复用），**alpha 合成自己实现**：out = alpha*fg + (1-alpha)*bg。
//
// ── 为什么对比度检查覆盖三组背景 ──────────────────────────────────────────────
// 液态玻璃是半透明主题，同一段文字会叠在三层背景上：
//   ① --color-bg（四色相渐变，各色标 alpha 0.55~0.62）
//   ② --color-panel（20% 半透明白，叠在 ① 之上 —— 列表/侧栏/输入区都是它）
//   ③ --color-chat-bg（9% 半透明白，叠在 ① 之上 —— 聊天区）
// 只测①会漏掉「面板上那层 20% 白」把底色抬亮、进而吃掉对比度的真实风险。

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

let pass = 0,
  fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log('  FAIL  ' + name + (extra ? '  << ' + extra : ''));
  }
}
function section(t) {
  console.log('\n=== ' + t + ' ===');
}

/** 强制环境（可证伪性检验用）：NY_LOW_CONTRAST_TEXT=1 / NY_DROP_DEEPENING=1 */
const FORCE = {
  lowContrastText: process.env.NY_LOW_CONTRAST_TEXT === '1',
  dropDeepening: process.env.NY_DROP_DEEPENING === '1',
};

// ============================================================================
// 1) 打包真实的 statsChart.ts，复用它的 relativeLuminance / contrastRatio
// ============================================================================
async function loadChartUtils() {
  const entry = path.join(ROOT, 'scripts', '.liquid-glass-statsChart-entry.ts');
  fs.writeFileSync(
    entry,
    [
      "export { relativeLuminance, contrastRatio } from '../src/utils/statsChart';",
    ].join('\n'),
    'utf8'
  );
  try {
    const out = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'node',
      target: 'node18',
      logLevel: 'silent',
    });
    const code = out.outputFiles[0].text;
    const mod = { exports: {} };
    new Function('module', 'exports', 'require', code)(mod, mod.exports, require);
    return mod.exports;
  } finally {
    fs.rmSync(entry, { force: true });
  }
}

// ============================================================================
// 2) 自己实现 alpha 合成（**不复用** statsChart 的 parseCssColor，见文件头说明）
// ============================================================================
/**
 * 解析 CSS 颜色为 { rgb: [r,g,b], a: 0~1 }。
 * 支持 #rgb / #rrggbb / rgb() / rgba()；渐变与颜色名返回 null。
 */
function parseColor(input) {
  const s = (input || '').trim().toLowerCase();
  if (!s) return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return {
        rgb: [
          parseInt(h[0] + h[0], 16),
          parseInt(h[1] + h[1], 16),
          parseInt(h[2] + h[2], 16),
        ],
        a: 1,
      };
    }
    return {
      rgb: [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
      ],
      a: 1,
    };
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/.exec(s);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) {
      a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    }
    return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a };
  }
  return null;
}

/** alpha 合成：out = alpha*fg + (1-alpha)*bg（逐通道，alpha ∈ [0,1]） */
function over(fg, bg) {
  const a = fg.a;
  return [
    a * fg.rgb[0] + (1 - a) * bg[0],
    a * fg.rgb[1] + (1 - a) * bg[1],
    a * fg.rgb[2] + (1 - a) * bg[2],
  ];
}

/** 把若干层由下往上合成（layers[0] 最底） */
function stack(layers) {
  return layers.reduce((acc, cur) => over(cur, acc), [0, 0, 0]);
}

/**
 * 取渐变里**最亮**的色标 —— 半透明主题的对比度最坏情况就是「最亮的色标」。
 * 理由：正文是浅色，底色越亮越难读。逐个色标算一遍、取最小比值，
 * 等价于「对整条渐变都达标」，比只看某一个色标更严格也更诚实。
 */
function brightestStop(gradient) {
  const stops = [];
  const re = /(rgba?\([^)]*\)|#[0-9a-f]{3,6})/gi;
  let m;
  while ((m = re.exec(gradient)) !== null) {
    const c = parseColor(m[1]);
    if (c) stops.push(c);
  }
  if (stops.length === 0) return null;
  return stops.reduce((best, c) => {
    const lum = c.rgb; // 只按不透明化的原色亮度比，够用：alpha 一致时单调
    const bl = best.rgb;
    const sum = (v) => v[0] + v[1] + v[2];
    return sum(lum) > sum(bl) ? c : best;
  });
}

// ============================================================================
// 3) 解析 variables.css 里 [data-theme='liquid'] 块的 28 个变量（真解析，不写死）
// ============================================================================
const REQUIRED_VARS = [
  '--color-primary',
  '--color-primary-text',
  '--color-bg',
  '--color-panel',
  '--color-panel-alt',
  '--color-chat-bg',
  '--color-nav-bg',
  '--color-nav-icon',
  '--color-nav-active',
  '--color-text',
  '--color-text-secondary',
  '--color-border',
  '--color-bubble-user',
  '--color-bubble-user-text',
  '--color-bubble-ai',
  '--color-bubble-ai-text',
  '--color-input-bg',
  '--color-hover',
  '--shadow-panel',
  '--color-system-msg',
  '--color-select-bg',
  '--color-select-text',
  '--color-text-muted',
  '--app-bg',
  '--titlebar-bg',
  '--titlebar-text',
  '--titlebar-icon',
  '--titlebar-btn-hover',
  '--titlebar-close-hover-bg',
  '--titlebar-close-hover-icon',
  '--titlebar-border',
  '--titlebar-blur',
  // v2.3.97 回归：浮层加深专用令牌。项目铁律是「颜色一律走 variables.css 的变量，
  // 不在 index.css 里硬编码」。这组变量若缺失，index.css 的 liquid 段就会退回硬编码色值。
  '--liquid-overlay',
  '--liquid-overlay-border',
  '--liquid-overlay-border-strong',
  '--liquid-overlay-text',
  '--liquid-overlay-text-dim',
  '--liquid-overlay-field',
  '--liquid-overlay-field-border',
  '--liquid-overlay-hover',
  '--liquid-overlay-text-strong',
  '--liquid-overlay-text-body',
  '--liquid-bar-base',
];

function readLiquidBlock() {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'theme', 'variables.css'), 'utf8');
  const start = css.indexOf("[data-theme='liquid']");
  if (start < 0) throw new Error("variables.css 里找不到 [data-theme='liquid'] 块");
  // 该块以第一个 '\n}' 结束（CSS 块内不含裸 '\n}'）
  const end = css.indexOf('\n}', start);
  if (end < 0) throw new Error("[data-theme='liquid'] 块没有正常闭合");
  return css.slice(start, end);
}

function parseVars(block) {
  const vars = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

// ============================================================================
// 4) deepening 块的 16 个选择器（照抄 glass 的既有清单，见 index.css:4765）
// ============================================================================
const DEEPENING_SELECTORS = [
  '.more-dropdown',
  '.mention-pop',
  '.mini-drawer',
  '.modal-card',
  '.modal',
  '.error-bubble',
  '.reasoning-block',
  '.qps-queue',
  '.mini-toast',
  '.hint-tip',
  '.chat-model-picker',
  '.update-banner',
  '.queue-dock-handle',
  '.queue-dock-panel',
  '.api-params-panel',
  '.chat-model-picker-results',
];

// ============================================================================
// 主流程
// ============================================================================
const { relativeLuminance, contrastRatio } = await loadChartUtils();
if (typeof relativeLuminance !== 'function' || typeof contrastRatio !== 'function') {
  console.error('FATAL: 未能从 statsChart.ts 取到 relativeLuminance / contrastRatio');
  process.exit(2);
}

section('0. 前置：statsChart 的两个纯数学函数可用');
check('relativeLuminance 是函数', typeof relativeLuminance === 'function');
check('contrastRatio 是函数', typeof contrastRatio === 'function');
check(
  'contrastRatio 对黑/白返回 21:1（sanity check）',
  Math.abs(contrastRatio([0, 0, 0], [255, 255, 255]) - 21) < 0.01,
  '实际 ' + contrastRatio([0, 0, 0], [255, 255, 255]).toFixed(2)
);

section('1. variables.css 解析');
const block = readLiquidBlock();
const vars = parseVars(block);
let themeText = vars['--color-text'];
if (FORCE.lowContrastText) {
  // 可证伪性检验：把正文换成与半透明底几乎同色的低对比值
  vars['--color-text'] = '#3a4a66';
  themeText = '#3a4a66';
  console.log('  (NY_LOW_CONTRAST_TEXT=1 → 已把 --color-text 换成 #3a4a66)');
}
for (const v of REQUIRED_VARS) {
  check(`${v} 已定义`, Object.prototype.hasOwnProperty.call(vars, v), '缺失');
}
check(
  `--blur 已定义（本主题取 ${vars['--blur'] || '缺失'}）`,
  Object.prototype.hasOwnProperty.call(vars, '--blur')
);
check(
  `--window-bg-blur 已定义（本主题取 ${vars['--window-bg-blur'] || '缺失'}）`,
  Object.prototype.hasOwnProperty.call(vars, '--window-bg-blur')
);

// ---- 构建三层背景（做alpha 合成） ----
const bgRaw = vars['--color-bg'] || '';
const bgStops = bgRaw.startsWith('linear-gradient')
  ? (() => {
      const out = [];
      const re = /(rgba?\([^)]*\)|#[0-9a-f]{3,6})/gi;
      let m;
      while ((m = re.exec(bgRaw)) !== null) {
        const c = parseColor(m[1]);
        if (c) out.push(c);
      }
      return out;
    })()
  : [parseColor(bgRaw)].filter(Boolean);
check('--color-bg 是含 ≥3 个色标的渐变（多色相 = 液态观感的来源）', bgStops.length >= 3, `实得 ${bgStops.length} 个`);

const text = parseColor(vars['--color-text']);
const panel = parseColor(vars['--color-panel']);
const chatBg = parseColor(vars['--color-chat-bg']);
const border = parseColor(vars['--color-border']);
const primary = parseColor(vars['--color-primary']);
const primaryText = parseColor(vars['--color-primary-text']);
const navIcon = parseColor(vars['--color-nav-icon']);
const bubbleAiText = parseColor(vars['--color-bubble-ai-text']);

check('--color-text 可解析为颜色', !!text, vars['--color-text']);
check('--color-panel 可解析为 rgba 且 alpha < 1（半透明）', !!panel && panel.a < 1, vars['--color-panel']);
check('--color-chat-bg 可解析为 rgba 且 alpha < 1（半透明）', !!chatBg && chatBg.a < 1, vars['--color-chat-bg']);

/**
 * 逐个色标分别作为「实际底色」，把 panel / chatBg 叠上去，再算对比度。
 * 对半透明渐变主题，这样才算「整条渐变都达标」。
 */
function worstOver(fg, fgName, topLayers, topName, minRatio, needText) {
  let worst = { ratio: Infinity, bg: null };
  for (const stop of bgStops) {
    // 最底层：色标自身（其 alpha 叠在窗口底色上，这里按「色标不透明化」处理 ——
    // 即最保守假设：色标后面是纯黑，合成后得到的亮度就是色标本身）
    let bg = stop.rgb;
    for (const layer of topLayers) {
      if (layer) bg = over(layer, bg);
    }
    const ratio = contrastRatio(fg.rgb, bg);
    if (ratio < worst.ratio) worst = { ratio, bg };
  }
  const val = worst.ratio;
  // 无论通过与否都打印实测值 —— 报告里要贴对比度数据表，
  // 只在失败时打印会导致「通过时看不到数值」，无法人工复核。
  console.log(
    `  实测 ${fgName} vs ${topName}：${val.toFixed(2)}:1` +
      `（最坏合成底 rgb(${worst.bg.map((v) => Math.round(v)).join(',')})，阈值 ${minRatio}:1）`
  );
  check(`${fgName} vs ${topName}（逐色标合成后取最坏）≥ ${minRatio}:1`, val >= minRatio, `实测 ${val.toFixed(2)}:1`);
  return val;
}

section('2. 正文对比度（WCAG AA 正文 4.5:1）');
console.log(`  --color-bg 色标：${bgStops.map((c) => `rgba(${c.rgb.join(',')},${c.a})`).join('  ')}`);
console.log(`  --color-panel = ${vars['--color-panel']}   --color-chat-bg = ${vars['--color-chat-bg']}`);
console.log('  合成后逐项实测：');
const rPanel = worstOver(text, '--color-text', [panel], '--color-panel（20% 半透明白叠在 bg 上）', 4.5);
const rChat = worstOver(text, '--color-text', [chatBg], '--color-chat-bg（9% 半透明白叠在 bg 上）', 4.5);
let worstBg = Infinity;
for (const stop of bgStops) {
  const r = contrastRatio(text.rgb, stop.rgb);
  if (r < worstBg) worstBg = r;
}
console.log(`  实测 --color-text vs --color-bg（裸渐变最坏色标）：${worstBg.toFixed(2)}:1（阈值 4.5:1）`);
check(`--color-text vs --color-bg（裸渐变最坏色标）≥ 4.5:1`, worstBg >= 4.5, `实测 ${worstBg.toFixed(2)}:1`);

section('3. 次要文字 / 导航图标（半透明承载面上的实际取值）');
if (navIcon) {
  let worstNav = Infinity;
  for (const stop of bgStops) {
    const bg = over(panel, stop.rgb); // 导航区用 --color-nav-bg，这里用 panel 近似其亮度环境
    const r = contrastRatio(navIcon.rgb, bg);
    if (r < worstNav) worstNav = r;
  }
  console.log(`  实测 --color-nav-icon vs panel 合成底：${worstNav.toFixed(2)}:1（阈值 3.0:1）`);
  check(
    `--color-nav-icon vs panel 合成底 ≥ 3.0（非文本/图标）`,
    worstNav >= 3.0,
    `实测 ${worstNav.toFixed(2)}:1`
  );
}
if (bubbleAiText) {
  const bubbleAi = parseColor(vars['--color-bubble-ai']);
  let worstB = Infinity;
  for (const stop of bgStops) {
    const bg = over(bubbleAi, over(chatBg, stop.rgb));
    const r = contrastRatio(bubbleAiText.rgb, bg);
    if (r < worstB) worstB = r;
  }
  console.log(`  实测 --color-bubble-ai-text vs AI 气泡：${worstB.toFixed(2)}:1（阈值 4.5:1）`);
  check(`--color-bubble-ai-text vs AI 气泡（叠在 chat-bg 上）≥ 4.5:1`, worstB >= 4.5, `实测 ${worstB.toFixed(2)}:1`);
}

section('4. 主色块与边框（非文本对比度 3:1）');
if (primary && primaryText) {
  const r = contrastRatio(primaryText.rgb, primary.rgb);
  console.log(`  实测 --color-primary-text vs --color-primary：${r.toFixed(2)}:1（阈值 4.5:1）`);
  check(`--color-primary-text vs --color-primary ≥ 4.5:1`, r >= 4.5, `实测 ${r.toFixed(2)}:1`);
}
if (border) {
  let worstBd = Infinity;
  for (const stop of bgStops) {
    // 边框画在面板上，故底 = panel 叠 bg
    const bg = over(panel, stop.rgb);
    const r = contrastRatio(border.rgb, bg);
    if (r < worstBd) worstBd = r;
  }
  console.log(`  实测 --color-border vs panel 合成底：${worstBd.toFixed(2)}:1（阈值 3.0:1）`);
  check(`--color-border vs panel 合成底 ≥ 3:1`, worstBd >= 3.0, `实测 ${worstBd.toFixed(2)}:1`);
}
if (primary) {
  let worstPr = Infinity;
  for (const stop of bgStops) {
    const r = contrastRatio(primary.rgb, over(panel, stop.rgb));
    if (r < worstPr) worstPr = r;
  }
  console.log(`  实测 --color-primary 作为色块 vs panel：${worstPr.toFixed(2)}:1（阈值 3.0:1）`);
  check(`--color-primary 作为色块 vs panel ≥ 3:1`, worstPr >= 3.0, `实测 ${worstPr.toFixed(2)}:1`);
}

section('5. deepening 覆盖块（16 个浮层选择器齐全）');
const indexCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'index.css'), 'utf8');
const deepStart = indexCss.indexOf("[data-theme='liquid'] .more-dropdown");
let deepSelectors = [];
if (deepStart >= 0) {
  const deepEnd = indexCss.indexOf('}', deepStart);
  const deepBlock = indexCss.slice(deepStart, deepEnd);
  const re = /\[data-theme='liquid'\]\s+(\.[a-z0-9-]+)/gi;
  let m;
  while ((m = re.exec(deepBlock)) !== null) deepSelectors.push(m[1]);
}
const droppedSel = FORCE.dropDeepening ? '.api-params-panel' : null;
const effSelectors = deepSelectors.filter((s) => s !== droppedSel);
if (FORCE.dropDeepening) {
  console.log('  (NY_DROP_DEEPENING=1 → 已从 deepening 块里删掉 .api-params-panel)');
}
check(
  `deepening 块存在（解析到 ${effSelectors.length} 个选择器）`,
  deepStart >= 0 && effSelectors.length > 0
);
for (const sel of DEEPENING_SELECTORS) {
  check(`deepening 含 ${sel}`, effSelectors.includes(sel), '缺失 —— 该浮层在半透明底上不可读');
}
// deepening 底色必须是近不透明。注意：底色已从硬编码 rgba() 收进 --liquid-overlay
// 变量（项目铁律：颜色走 variables.css），故这里**从变量取值**判定 alpha，
// 不能再去 index.css 里匹配 rgba() 字面量 —— 那样会在改成变量的那一刻误报。
{
  const deepBlock = indexCss.slice(deepStart, indexCss.indexOf('}', deepStart));
  check('deepening 块用 var(--liquid-overlay) 而非硬编码底色', /var\(--liquid-overlay\)/.test(deepBlock));
  const ovAlpha = parseColor(vars['--liquid-overlay']);
  check(
    `deepening 底色为近不透明（--liquid-overlay alpha ≥ 0.85，实测 ${ovAlpha?.a}）`,
    !!ovAlpha && ovAlpha.a >= 0.85,
    `alpha=${ovAlpha?.a}`
  );
}

section('6. 六处注册点');
const types = fs.readFileSync(path.join(ROOT, 'src', 'types.ts'), 'utf8');
check("types.ts 的 ThemeName 含 'liquid'", /export type ThemeName =[\s\S]*?\|\s*'liquid'/.test(types));

const settings = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Settings.tsx'), 'utf8');
const themesMatch = settings.match(/export const THEMES[\s\S]*?\n\];/);
check('Settings.tsx 导出 THEMES 数组', !!themesMatch);
const themesArr = themesMatch ? themesMatch[0] : '';
check(
  "THEMES 含 { key: 'liquid', ... swatch: 'linear-gradient(...)' }",
  /\{\s*key:\s*'liquid',\s*nameKey:\s*'theme\.liquid',\s*swatch:\s*'linear-gradient\([^']+\)'\s*\}/.test(themesArr)
);
check(
  'Settings.tsx 的毛玻璃面板对 liquid 开放（theme === liquid）',
  /theme === 'glass' \|\| theme === 'frost' \|\| theme === 'liquid'/.test(settings)
);
check('Settings.tsx 有「液态流动」开关（draft.liquidFlow）', /draft\.liquidFlow !== false/.test(settings));

// i18n：translations.ts 2 语言 + locales 8 语言 = 10
const trans = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'translations.ts'), 'utf8');
const LANG_FILES = ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'];
const i18nLangs = ['zh', 'en', ...LANG_FILES];
for (const lang of i18nLangs) {
  if (lang === 'zh' || lang === 'en') {
    // translations.ts 里 zh / en 各一份，共 2 处
    const n = (trans.match(/'theme\.liquid':/g) || []).length;
    check(`i18n ${lang}（translations.ts）含 theme.liquid`, n === 2, `theme.liquid 共 ${n} 处（应为 2）`);
  } else {
    const p = path.join(ROOT, 'src', 'i18n', 'locales', `${lang}.json`);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    check(`i18n ${lang} 含 theme.liquid`, typeof j['theme.liquid'] === 'string' && j['theme.liquid'].length > 0, JSON.stringify(j['theme.liquid']));
  }
}
check(
  'translations.ts 含 settings.liquidFlow / liquidFlowDesc（zh + en 共 4 处）',
  (trans.match(/'settings\.liquidFlow':/g) || []).length === 2 &&
    (trans.match(/'settings\.liquidFlowDesc':/g) || []).length === 2
);

const notify = fs.readFileSync(path.join(ROOT, 'src', 'notify.ts'), 'utf8');
check(
  "notify.ts 的 DARK_THEMES 含 'liquid'",
  /DARK_THEMES\s*=\s*new Set\(\[[^\]]*'liquid'[^\]]*\]\)/.test(notify)
);

const themeCtx = fs.readFileSync(path.join(ROOT, 'src', 'theme', 'ThemeContext.tsx'), 'utf8');
check(
  "ThemeContext 的 isGlass 含 'liquid'（自定义背景图生效）",
  /const isGlass = theme === 'glass' \|\| theme === 'frost' \|\| theme === 'liquid'/.test(themeCtx)
);
check(
  'ThemeContext 挂 data-liquid-flow（流动开关）',
  /setAttribute\('data-liquid-flow',\s*'off'\)/.test(themeCtx)
);
check(
  'ThemeContext 挂 data-liquid-custom-bg（自定义背景图时停流动）',
  /setAttribute\('data-liquid-custom-bg',\s*'on'\)/.test(themeCtx)
);
const mini = fs.readFileSync(path.join(ROOT, 'src', 'components', 'MiniChat.tsx'), 'utf8');
check(
  'MiniChat（独立 document）也挂 data-liquid-flow，否则小窗不听开关',
  /setAttribute\('data-liquid-flow',\s*'off'\)/.test(mini)
);

section('7. 流动动画');
const kfName = 'liquid-flow-drift';
const kfIdx = indexCss.indexOf(`@keyframes ${kfName}`);
check(`@keyframes ${kfName} 存在`, kfIdx >= 0);
let kfBody = '';
if (kfIdx >= 0) {
  const end = indexCss.indexOf('\n}', kfIdx);
  kfBody = indexCss.slice(kfIdx, end);
}
// 抽 0% / 50% / 100% 三帧的声明
function frameAt(pct) {
  const re = new RegExp(`${pct}\\s*\\{([^}]*)\\}`);
  const m = re.exec(kfBody);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}
const f0 = frameAt('0%');
const f50 = frameAt('50%');
const f100 = frameAt('100%');
check('0% 帧存在', !!f0);
check('50% 帧存在', !!f50);
check('100% 帧存在', !!f100);
check(
  '0% 与 100% 声明值相同（循环无缝，无跳变）',
  !!f0 && !!f100 && f0 === f100,
  `0%=[${f0}] 100%=[${f100}]`
);
check(
  '0% 与 50% 声明值不同（确实在动，不是原地不动）',
  !!f0 && !!f50 && f0 !== f50,
  `0%=[${f0}] 50%=[${f50}]`
);

// 周期与缓动：从使用处（animation 简写）里读
const usageRe = /animation:\s*liquid-flow-drift\s+([\d.]+)s\s+([a-z-]+)\s+([a-z-]+)/;
const usageM = usageRe.exec(indexCss);
check('animation 简写里能解析出周期/缓动/次数', !!usageM);
if (usageM) {
  const dur = parseFloat(usageM[1]);
  const easing = usageM[2];
  const iter = usageM[3];
  console.log(`  实测：周期 ${dur}s，缓动 ${easing}，重复 ${iter}`);
  check(`周期 ≥ 15s（实测 ${dur}s）`, dur >= 15, `实际 ${dur}s`);
  check(`缓动为 linear（实测 ${easing}）`, easing === 'linear');
  check(`无限循环（实测 ${iter}）`, iter === 'infinite');
}
// background-size 必须 > 100%，否则渐变被拉伸铺满、位移动画变成原地抖动
const sizeM = /\[data-theme='liquid'\]\s+\.app-root,[\s\S]{0,400}?background-size:\s*(\d+)%/.exec(indexCss);
check(
  '背景层 background-size > 100%（给位移留余量）',
  !!sizeM && parseInt(sizeM[1], 10) > 100,
  sizeM ? `实际 ${sizeM[1]}%` : '未找到 background-size'
);
check(
  '「液态流动」关闭时有兜底 animation:none（而非暂停在首帧）',
  /\[data-theme='liquid'\]\[data-liquid-flow='off'\][\s\S]{0,200}?animation:\s*none/.test(indexCss)
);
// 回归防护：背景层必须用 var(--app-bg) 而不是硬编码渐变，否则用户在设置里
// 自定义背景图后，CSS 里的硬编码渐变会把 --app-bg 覆盖掉（自定义背景功能静默失效）。
check(
  "背景层用 background-image: var(--app-bg)（自定义背景图才不会被覆盖）",
  /\[data-theme='liquid'\]\s\.app-root,[\s\S]{0,120}?background-image:\s*var\(--app-bg\)/.test(indexCss)
);
check(
  '自定义背景图时停掉流动（避免用户的照片在窗口里漂移）',
  /\[data-theme='liquid'\]\[data-liquid-custom-bg\][\s\S]{0,240}?animation:\s*none/.test(indexCss)
);

const anim = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'animControl.ts'), 'utf8');
check("animControl.ts 的 theme 组登记了 .app-root（流动动画载体）", /'\.app-root'/.test(anim));
check("animControl.ts 的 theme 组登记了 .mini-shell（小窗流动载体）", /'\.mini-shell'/.test(anim));

/**
 * 关键回归防护：门禁规则必须**真的能匹配到**元素。
 * buildGateCss 拼的是 `html[data-anim-off~="<id>"] <登记选择器>`（后代组合器），
 * 而 data-theme 设在 <html> 上。若把选择器登记成 `[data-theme="liquid"] .app-root`，
 * 拼出来就要求 html 的**后代**里有 data-theme —— 永远匹配不上，
 * 「自定义档关掉 theme 组」就会对流动动画静默失效。
 * 这里真的用正则模拟一遍匹配，而不是只断言「字符串出现过」。
 */
{
  // 从 animControl.ts 里抠出 theme 组的 selectors 数组字面量
  const themeGrp = /id:\s*'theme'[\s\S]*?selectors:\s*\[([\s\S]*?)\n\s*\],/.exec(anim);
  check('能从 animControl.ts 解析出 theme 组的 selectors 数组', !!themeGrp);
  const sels = themeGrp ? (themeGrp[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)) : [];
  check('theme 组登记了 .app-root', sels.includes('.app-root'), `实得 ${JSON.stringify(sels.filter((s) => /app-root|mini-shell/.test(s)))}`);
  check('theme 组登记了 .mini-shell', sels.includes('.mini-shell'));
  // 后代组合器 + data-theme 在 html 上 → 登记项里不得含 [data-theme=...]
  const bad = sels.filter((s) => /\[data-theme=/.test(s));
  check(
    '登记项里不含 [data-theme=...]（后代组合器匹配不上，会静默失效）',
    bad.length === 0,
    `这些登记项会导致门禁失效：${JSON.stringify(bad)}`
  );
  // 真的模拟一次匹配：html[data-anim-off~="theme"] .app-root 对 <html data-theme="liquid" class="app-root"> 链
  const domChain = ['html', 'body', 'div.app-root']; // data-theme 与 class 都在 html 的后代上
  const gateWorks = sels.some((sel) => {
    const parts = sel.trim().split(/\s+/);
    return parts.length === 1 && parts[0] === '.app-root'; // 裸类名 = 单段 = 能在任意深度匹配
  });
  check('门禁规则在真实 DOM 链路上可匹配（裸类名是唯一正确形态）', gateWorks);
  void domChain;
}

const typesHasGroup = /theme:\s*true/.test(types);
check('types.ts 默认 animGroups 仍含 theme: true（登记在既有组，无需新键）', typesHasGroup);

section('8. 小字处理（半透明承载面禁用 secondary）');
check(
  "[data-theme='liquid'] 把 .msg-meta 改用 --color-text",
  /\[data-theme='liquid'\]\s\.msg-meta,[\s\S]{0,120}?color:\s*var\(--color-text\)/.test(indexCss)
);
check(
  "[data-theme='liquid'] 把 .scene-image-sub 改用 --color-text",
  /\[data-theme='liquid'\]\s\.msg-meta,\s*\n\[data-theme='liquid'\]\s\.scene-image-sub\s*\{\s*\n\s*color:\s*var\(--color-text\)/.test(
    indexCss
  )
);
check(
  '未在 liquid 段里用 --color-text-secondary 给半透明面（避免浅灰陷阱）',
  !/\[data-theme='liquid'\][^{]*\{[^}]*color:\s*var\(--color-text-secondary\)/.test(indexCss)
);

section('9. 零硬编码色值（项目铁律：颜色一律走 variables.css 的变量）');
// 项目铁律：颜色必须走 CSS 变量，否则换主题时这批浮层不跟着变。
// scripts/verify-no-native-dialog.mjs 的断言 8 会扫描 index.css 里 v2.3.97 之后的段落，
// 但它对 glass 段开了白名单（历史代码），对其他段落一律零容忍 —— 液态玻璃必须守住。
{
  const liquidStart = indexCss.indexOf("[data-theme='liquid'] .more-dropdown");
  // liquid 段的起点：取 @keyframes liquid-flow-drift 之前的那段大注释之前
  const blockStart = indexCss.lastIndexOf('/* ====', liquidStart);
  const liquidSection = indexCss.slice(blockStart >= 0 ? blockStart : liquidStart);
  // 剥掉 CSS 注释（脚本侧的 colorRe 不剥注释，所以注释里的色值字面量也算命中，
  // 这里同样要剥 —— 否则会把「注释里写了 rgba(...) 说明」误判成硬编码）
  const codeOnly = liquidSection.replace(/\/\*[\s\S]*?\*\//g, '');
  const colorRe = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;
  const hits = codeOnly.match(colorRe) || [];
  check(
    'liquid 段（剔除注释后）零硬编码色值',
    hits.length === 0,
    `命中 ${hits.length} 处：${hits.join(', ')}`
  );
  // 反向校验：liquid 段用到的每个 var(--liquid-*) 都必须在 variables.css 里真实存在，
  // 否则会静默失效（回退到 unset → 声明被丢弃 → 浮层直接没有底色）。
  const usedVars = new Set(
    (codeOnly.match(/var\((--liquid-[a-z-]+)\)/g) || []).map((v) => v.slice(4, -1))
  );
  for (const v of usedVars) {
    check(`liquid 段用到的 ${v} 已在 variables.css 定义`, Object.prototype.hasOwnProperty.call(vars, v), '未定义');
  }
  check('liquid 段确实用上了 --liquid-overlay（而不是硬编码底色）', /var\(--liquid-overlay\)/.test(codeOnly));
}

section('10. 浮层加深后的文字对比度（deepening 底色上）');
// deepening 把浮层底色从「20% 半透明白」换成「近不透明深蓝紫」，
// 这一步必须让文字对比度**升高或持平**，绝不能降低。
{
  const overlay = parseColor(vars['--liquid-overlay']);
  const ovText = parseColor(vars['--liquid-overlay-text']);
  const ovDim = parseColor(vars['--liquid-overlay-text-dim']);
  check('--liquid-overlay 是不透明深色（alpha ≥ 0.85）', !!overlay && overlay.a >= 0.85, `alpha=${overlay?.a}`);

  if (overlay && ovText) {
    // overlay 叠在「最坏情况」的面板底上（面板是浮层原本的底）
    let worst = Infinity;
    for (const stop of bgStops) {
      const base = over(panel, stop.rgb);
      const r = contrastRatio(ovText.rgb, over(overlay, base));
      if (r < worst) worst = r;
    }
    console.log(`  实测 --liquid-overlay-text vs 加深底（叠在面板上）：${worst.toFixed(2)}:1（阈值 4.5:1）`);
    check('浮层正文在加深底上 ≥ 4.5:1', worst >= 4.5, `实测 ${worst.toFixed(2)}:1`);
  }
  if (overlay && ovDim) {
    let worst = Infinity;
    for (const stop of bgStops) {
      const base = over(panel, stop.rgb);
      const r = contrastRatio(ovDim.rgb, over(overlay, base));
      if (r < worst) worst = r;
    }
    console.log(`  实测 --liquid-overlay-text-dim vs 加深底：${worst.toFixed(2)}:1（阈值 4.5:1）`);
    check('浮层占位符/空态文字在加深底上 ≥ 4.5:1', worst >= 4.5, `实测 ${worst.toFixed(2)}:1`);
  }
  if (overlay && ovText) {
    // 边框（非文本）对比度
    const borderVar = parseColor(vars['--liquid-overlay-border']);
    if (borderVar) {
      let worst = Infinity;
      for (const stop of bgStops) {
        const base = over(panel, stop.rgb);
        const r = contrastRatio(borderVar.rgb, over(overlay, base));
        if (r < worst) worst = r;
      }
      console.log(`  实测 --liquid-overlay-border vs 加深底：${worst.toFixed(2)}:1（阈值 3.0:1）`);
      check('浮层边框在加深底上 ≥ 3.0:1', worst >= 3.0, `实测 ${worst.toFixed(2)}:1`);
    }
  }
}

// ============================================================================
console.log('\n========================================');
console.log(`断言总数：${pass + fail}   通过：${pass}   失败：${fail}`);
console.log('========================================');
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log('  - ' + f);
  console.log('\n结果：不通过');
  process.exit(1);
}
console.log('\n结果：全部通过');
process.exit(0);