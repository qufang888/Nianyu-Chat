#!/usr/bin/env node
/**
 * verify-chat-ui-contrast.mjs — v2.3.102「新增聊天面 UI 的底色/前景对比度」常驻闸门。
 *
 * ── 本脚本防的是什么回归（存在的理由）──────────────────────────────────────────
 *   v2.3.102 新引入的三处 UI 直接落在**聊天承载面**上，而既有 verify-dye-contrast.mjs 的
 *   承载面矩阵里**根本没有这个面**（它只建模 --color-panel / --color-hover / --color-chat-scrim
 *   压在 --color-bg 上的组合）：
 *     · .msg-resend-btn（打断后「重发」按钮）
 *     · .msg-time-above（气泡发送时间，移到头像正下方）
 *     · .advanced-toggle（设置「高级设置」折叠标题）
 *   只要有人把这些控件的文字/底色令牌换成「未做过聊天面校验」的值，本闸门就会变红。
 *
 *   真实历史（本门固化的修复点）：初版 .msg-resend-btn 用 `--color-primary-ink` 当文字色，
 *   而它在**未染色时恒等于 --color-primary**（那是给填充用的强调色），压在裸聊天面上
 *   15 套主题里 6 套 <4.5（wechat 仅 2.04:1、glass 1.44:1）。修复改用「--color-text + --color-panel」。
 *
 * ── 与 verify-dye-contrast.mjs 的关系 ─────────────────────────────────────────
 *   互补、不重叠：那个门守「染色 ink 文字压在面板/磨砂面」；本门守「新增聊天面 UI」。
 *   两门都用同一份真实实现，避免「平行影子 oracle」。
 *
 * ── 方法（不猜、不写死）──────────────────────────────────────────────────────
 *   · 对比度 / 合成 / 渐变抽色标 一律 **import 真实实现** src/utils/dominantColor.ts（Node 22 type-stripping）。
 *   · 控件的**配色令牌**（--color-text / --color-panel / --color-hover / --color-text-muted）从
 *     **真实 src/styles/index.css** 解析后按主题求值 —— 实现者再改配色，本门自动跟随并重新判定，
 *     不会因为「令牌换了但门还写死旧值」而给出假绿。
 *
 * ── 判定门（对 variables.css 里当前全部主题自动生效，加主题即纳入）──────────────
 *   C0  覆盖完整性：解析到的 [data-theme] 数 == 源码声明数（防静默漏解析）
 *   C1  重发按钮 常态：**非 glass 14 主题** contrast(按钮色, 按钮承载面) ≥ 4.5
 *   C2  重发按钮 hover：非 glass ≥ 4.5
 *   C3  重发按钮 disabled：非 glass ≥ 4.5（若实现改用 opacity 弱化，会按 alpha 合成后重算 → 仍能抓）
 *   C4  高级设置折叠标题(.advanced-toggle)：非 glass ≥ 4.5
 *   C5  glass 上界断言：glass 下「按钮值」==「该主题 --color-text 压同一承载面」的值（±0.01）
 *       —— 数学上证明「新 UI 没有给 glass 引入任何额外赤字」（不用 skip/排除把 glass 藏起来）
 *   C6  glass ceiling 披露：断言 glass 按钮值与 glass 折叠标题值 < 4.5（已知上界写成断言；
 *       将来有人改了 glass 的面板/文字色，本断言会主动报出而不是继续绿）
 *   C7  时间戳(.msg-time-above, --color-text-muted) 棘轮：各主题实测**不劣于**本次记录基线
 *       （该对比度是**本版之前就存在**的性质 —— 令牌与承载面都非本次引入 —— 故本版如实记录、不改，
 *        但绝不放宽/删除：一旦有人把次要文字色改得更差，本棘轮立即变红）
 *   C8  自证活性：注入一个「合成必败」主题（文字色 == 承载面），判定器必须判它失败
 *
 * ── 可证伪性（证明断言是活的、非空转）──────────────────────────────────────────
 *   NY_QA_CONTRAST_BREAK=1 → 强制把「按钮文字色」替换为「按钮底色」→ C1/C2/C3 必须变红。
 *
 * 用法：node scripts/verify-chat-ui-contrast.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const {
  contrastRatio,
  parseCssColor,
  parseCssColorWithAlpha,
  compositeOver,
  rgbToHex,
  computePrimarySurfaces,
  computeSecondarySurfaces,
} = await import(new URL('../src/utils/dominantColor.ts', import.meta.url).href);

const BREAK = process.env.NY_QA_CONTRAST_BREAK === '1';
const AA = 4.5;

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; const l = `  ✗ ${name}${extra ? ' — ' + extra : ''}`; failures.push(l); console.log(l); }
};

// ---------- 1. 通用：抽顶层 `选择器 { ... }` 块 ----------
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
      else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    opener.lastIndex = i + 1;
    if (!sel || sel.startsWith('@') || sel.startsWith('*')) continue;
    out.push({ sel, body: src.slice(braceStart + 1, i) });
  }
  return out;
}

// ---------- 2. variables.css → 每个主题的完整自定义属性表（含 :root 继承）----------
const cssRaw = fs.readFileSync(path.join(ROOT, 'src/theme/variables.css'), 'utf8');
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
const collectVars = (body) => {
  const out = {};
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body)) !== null) out[m[1]] = m[2].trim();
  return out;
};
const blocks = topLevelBlocks(css);
const themeSelRe = /^\[data-theme=['"]([^'"]+)['"]\]$/;
const rootBlock = blocks.find((b) => b.sel === ':root');
const rootVars = rootBlock ? collectVars(rootBlock.body) : {};
const namedThemes = blocks
  .map((b) => ({ name: (b.sel.match(themeSelRe) || [])[1], body: b.body }))
  .filter((t) => t.name);
const themes = namedThemes.map((t) => ({ name: t.name, vars: { ...rootVars, ...collectVars(t.body) } }));
const declaredThemeCount = (css.match(/\[data-theme=/g) || []).length;

// ---------- 3. index.css → 控件配色令牌（真实来源）----------
const idxRaw = fs.readFileSync(path.join(ROOT, 'src/styles/index.css'), 'utf8');
const idxBlocks = topLevelBlocks(idxRaw.replace(/\/\*[\s\S]*?\*\//g, ''));
const findBlock = (sel) => idxBlocks.find((b) => b.sel === sel);
const extractProp = (body, prop) => {
  if (!body) return null;
  const m = body.match(new RegExp('(?:^|[;{\\n])\\s*' + prop + '\\s*:\\s*([^;]+)', 'i'));
  return m ? m[1].trim() : null;
};

const btnBlock = findBlock('.msg-resend-btn');
const btnHoverBlock = findBlock('.msg-resend-btn:not(:disabled):hover') || findBlock('.msg-resend-btn:hover');
const btnDisabledBlock = findBlock('.msg-resend-btn:disabled');
const toggleBlock = findBlock('.advanced-toggle');
const timeBlock = findBlock('.msg-time-above');

let TOKEN = {
  btnColor: extractProp(btnBlock && btnBlock.body, 'color'),
  btnBg: extractProp(btnBlock && btnBlock.body, 'background'),
  btnHoverBg: extractProp(btnHoverBlock && btnHoverBlock.body, 'background'),
  btnDisabledOpacity: extractProp(btnDisabledBlock && btnDisabledBlock.body, 'opacity'),
  toggleColor: extractProp(toggleBlock && toggleBlock.body, 'color'),
  timeColor: extractProp(timeBlock && timeBlock.body, 'color'),
};
if (BREAK) TOKEN = { ...TOKEN, btnColor: 'var(--color-panel)' }; // 强制 文字色 == 底色 → 必红

// 断言「令牌解析到位」——否则后续断言会静默空转（disabledOpacity 允许缺失 = 未用 opacity）
check('C-tok 从 index.css 解析到全部控件配色令牌',
  !!TOKEN.btnColor && !!TOKEN.btnBg && !!TOKEN.btnHoverBg && !!TOKEN.toggleColor && !!TOKEN.timeColor,
  JSON.stringify(TOKEN));

// ---------- 4. 变量求值 / 合成助手 ----------
function resolveVar(value, vars, depth = 0) {
  if (value == null || depth > 8) return null;
  const s = String(value).trim();
  const m = s.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/);
  if (!m) return s;
  if (vars[m[1]] != null) return resolveVar(vars[m[1]], vars, depth + 1);
  if (m[2] != null) return resolveVar(m[2], vars, depth + 1);
  return null;
}
function resolveScrimCss(scrimCss, bgCss) {
  if (!scrimCss) return null;
  if (parseCssColorWithAlpha(scrimCss)) return scrimCss;
  const m = scrimCss.match(/color-mix\(\s*in\s+srgb\s*,\s*var\(\s*--color-bg\s*\)\s+([\d.]+)%\s*,\s*transparent\s*\)/i);
  if (!m) return null;
  const bg = parseCssColor(bgCss);
  if (!bg) return null;
  return `rgba(${bg.r}, ${bg.g}, ${bg.b}, ${parseFloat(m[1]) / 100})`;
}
/** 把 layerCss（可为 null/transparent）合成到 surfaceHex 上；null 层 → 原面不变。 */
const overSurface = (layerCss, surfaceHex) => {
  const bg = parseCssColor(surfaceHex);
  if (!bg) return null;
  const layer = parseCssColorWithAlpha(layerCss);
  if (!layer || layer.a === 0) return surfaceHex;
  const c = compositeOver(layer, bg);
  return rgbToHex(c.r, c.g, c.b);
};
const withAlpha = (colorCss, a) => {
  const c = parseCssColor(colorCss);
  return c ? `rgba(${c.r}, ${c.g}, ${c.b}, ${a})` : colorCss;
};
const minRatio = (fg, surfaces) =>
  surfaces && surfaces.length ? Math.min(...surfaces.filter(Boolean).map((s) => contrastRatio(fg, s))) : null;

// ---------- 5. 单主题评估 ----------
function evaluateTheme(vars) {
  const bg = vars['--color-bg'];
  const chatBg = vars['--color-chat-bg'] || bg;
  // 聊天承载面：chat-bg 合成面（无图）∪ scrim 合成面（有图）—— 两者都可达，取最坏
  let chatSurfaces = computePrimarySurfaces(chatBg, bg);
  const sec = computeSecondarySurfaces(resolveScrimCss(vars['--color-chat-scrim'], bg) || '', bg);
  if (sec && sec.length) chatSurfaces = chatSurfaces.concat(sec);

  // 按钮承载面 = 其自身底色压到聊天面上（透明底则退化为聊天面）
  const btnColor = resolveVar(TOKEN.btnColor, vars);
  const btnBg = resolveVar(TOKEN.btnBg, vars);
  const hoverBg = resolveVar(TOKEN.btnHoverBg, vars);
  const op = TOKEN.btnDisabledOpacity != null ? parseFloat(TOKEN.btnDisabledOpacity) : 1;

  const normSurfaces = chatSurfaces.map((s) => overSurface(btnBg, s)).filter(Boolean);
  const hoverSurfaces = chatSurfaces.map((s) => overSurface(hoverBg, s)).filter(Boolean);

  const x1 = minRatio(btnColor, normSurfaces);
  const x2 = minRatio(btnColor, hoverSurfaces);
  // disabled：有 opacity 就按 alpha 合成后重算（复现「禁用态一起塌陷」），无则与常态同
  const x3 = op < 1
    ? (normSurfaces.length ? Math.min(...normSurfaces.map((s) => contrastRatio(overSurface(withAlpha(btnColor, op), s), s))) : null)
    : x1;

  // 参考：正文色压**同一**承载面（glass 上界断言用）
  const textColor = resolveVar('var(--color-text)', vars);
  const refTextNorm = minRatio(textColor, normSurfaces);
  const refTextHover = minRatio(textColor, hoverSurfaces);

  // 折叠标题：色令牌压 settings 面板面
  const panelSurfaces = computePrimarySurfaces(vars['--color-panel'], bg, vars['--color-hover']);
  const toggleColor = resolveVar(TOKEN.toggleColor, vars);
  const x4 = minRatio(toggleColor, panelSurfaces);

  // 时间戳：色令牌压聊天面（棘轮）
  const timeMuted = minRatio(resolveVar(TOKEN.timeColor, vars), chatSurfaces);
  const timeText = minRatio(textColor, chatSurfaces);

  return { name: vars.__name, x1, x2, x3, x4, timeMuted, timeText, refTextNorm, refTextHover, btnColor, op };
}

const rows = themes.map((t) => evaluateTheme({ ...t.vars, __name: t.name }));
const glass = rows.find((r) => r.name === 'glass');
const nonGlassRows = rows.filter((r) => r.name !== 'glass');

// ---------- 6. 输出矩阵 ----------
check(
  `C0 主题块无漏解析（源码声明 ${declaredThemeCount} 个 [data-theme=] == 解析 ${themes.length} 个）`,
  declaredThemeCount === themes.length,
  `源码 ${declaredThemeCount} vs 解析 ${themes.length}`
);

console.log('\n主题'.padEnd(12) + 'btn常态'.padEnd(10) + 'btn:hover'.padEnd(11) + 'btn禁'.padEnd(9) + 'toggle'.padEnd(9) + 'time-muted');
const fmt = (v) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(2));
for (const r of rows) {
  console.log(
    r.name.padEnd(12) + fmt(r.x1).padEnd(10) + fmt(r.x2).padEnd(11) + fmt(r.x3).padEnd(9) + fmt(r.x4).padEnd(9) + fmt(r.timeMuted)
  );
}

const brief = (xs) => xs.slice(0, 20).join('; ') + (xs.length > 20 ? ` …(共${xs.length})` : '');
const gateNonGlass = (label, pick, thresh = AA) => {
  const bad = nonGlassRows.filter((r) => { const v = pick(r); return v !== null && Number.isFinite(v) && v < thresh; });
  const minRow = nonGlassRows.reduce((a, r) => (pick(r) < pick(a) ? r : a), nonGlassRows[0]);
  check(
    `${label}（非 glass 最小 ${fmt(pick(minRow))} @ ${minRow.name}）`,
    bad.length === 0,
    bad.length ? brief(bad.map((r) => `${r.name}=${fmt(pick(r))}`)) : ''
  );
};

console.log('');
gateNonGlass('C1 .msg-resend-btn 常态 ≥4.5', (r) => r.x1);
gateNonGlass('C2 .msg-resend-btn:hover ≥4.5', (r) => r.x2);
gateNonGlass('C3 .msg-resend-btn:disabled ≥4.5', (r) => r.x3);
gateNonGlass('C4 .advanced-toggle ≥4.5', (r) => r.x4);

// ---------- 7. glass：上界断言 + ceiling 披露（不 skip、不排除）----------
console.log('\n=== C5/C6 glass 上界 + ceiling（照 verify-dye-contrast.mjs 的 G2/G2b 范式）===');
check(
  `C5a glass 按钮常态值 == 该主题 --color-text 压同一承载面（${fmt(glass.x1)} vs ${fmt(glass.refTextNorm)}）`,
  glass.x1 !== null && Math.abs(glass.x1 - glass.refTextNorm) <= 0.01,
  `按钮=${fmt(glass.x1)} 正文参考=${fmt(glass.refTextNorm)}`
);
check(
  `C5b glass 按钮 hover 值 == 该主题 --color-text 压同一承载面（${fmt(glass.x2)} vs ${fmt(glass.refTextHover)}）`,
  glass.x2 !== null && Math.abs(glass.x2 - glass.refTextHover) <= 0.01,
  `按钮=${fmt(glass.x2)} 正文参考=${fmt(glass.refTextHover)}`
);
check(
  `C6a glass ceiling 披露：按钮常态 ${fmt(glass.x1)} < 4.5（已知上界，写成断言以便面板/文字变动时报出）`,
  glass.x1 !== null && glass.x1 < AA,
  `glass=${fmt(glass.x1)}`
);
check(
  `C6b glass ceiling 披露：折叠标题 ${fmt(glass.x4)} < 4.5`,
  glass.x4 !== null && glass.x4 < AA,
  `glass=${fmt(glass.x4)}`
);

// ---------- 8. C7 时间戳棘轮（既有性质，如实记录，不放宽）----------
// 基线 = v2.3.102 复核时各主题的实测 time-muted 值（--color-text-muted 压聊天面）。
// 这是**本版之前就存在**的性质（令牌与承载面均非本次引入）；本版不改，但棘轮住不许变差。
const X5_BASELINE = {
  wechat: 3.03, glass: 1.24, dark: 4.28, vibrant: 3.12, azure: 5.9, galaxy: 5.35, pine: 6.15,
  ember: 5.6, frost: 3.43, rose: 5.57, cyber: 6.28, graphite: 5.11, indigo: 5.27, sand: 4.94, liquid: 1.26,
};
console.log('\n=== C7 时间戳 --color-text-muted 棘轮（不劣于基线；基线为既有性质，待下一版处理）===');
const ratchetMiss = [];
const ratchetMissing = [];
for (const r of rows) {
  const base = X5_BASELINE[r.name];
  if (base == null) { ratchetMissing.push(r.name); continue; }
  if (r.timeMuted === null || r.timeMuted < base - 0.01) ratchetMiss.push(`${r.name}=${fmt(r.timeMuted)}(<${base})`);
}
check(`C7a 每个主题都有棘轮基线（新增主题必须补基线）`, ratchetMissing.length === 0, ratchetMissing.join(', '));
check(`C7b 时间戳对比度不劣于基线（15 主题棘轮住）`, ratchetMiss.length === 0,
  ratchetMiss.join('; ') || '全部 ≥ 基线');
console.log('  · 当前 <4.5 的主题（既有性质，本版如实披露，非本次引入）：' +
  rows.filter((r) => r.timeMuted !== null && r.timeMuted < AA).map((r) => `${r.name}=${fmt(r.timeMuted)}`).join(', '));

// ---------- 9. C8 自证活性（合成必败主题）----------
{
  const synth = {
    __name: 'qa-synthetic(文字色==承载面)',
    '--color-bg': '#808080', '--color-panel': '#808080', '--color-chat-bg': '#808080',
    '--color-hover': '#808080', '--color-text': '#777777', '--color-text-muted': '#777777',
    '--color-chat-scrim': '',
  };
  const r = evaluateTheme(synth);
  check(`C8 检查器非空转：合成主题被判失败（常态 ${fmt(r.x1)} < 4.5）`,
    Number.isFinite(r.x1) && r.x1 < AA, `得到 ${fmt(r.x1)}`);
}

// ---------- 10. 可证伪性注入 ----------
if (BREAK) {
  console.log('\n[可证伪性] NY_QA_CONTRAST_BREAK=1 → 按钮文字色被替换为其底色，C1/C2/C3 应变红。');
  console.log(`  当前失败数 = ${fail}（>0 即证明断言是活的、非空转）。`);
}

// ---------- 汇总 ----------
console.log(`\n断言：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.error('\n失败明细：');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('✅ 聊天面新增 UI 对比度闸门通过');
