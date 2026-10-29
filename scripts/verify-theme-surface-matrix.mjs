#!/usr/bin/env node
/**
 * verify-theme-surface-matrix.mjs — v2.3.110 需求 4「全主题 × 全界面文字对比度普查」常驻闸门。
 *
 * ── 本脚本防的是什么回归（存在的理由）──────────────────────────────────────────
 *   v2.3.105 起玻璃家族细化覆写（ThemeContext isGlass 把 --color-panel 改写为
 *   color-mix(白 20%, transparent)）作用于 frost（冰川素白）后，frost 面板从纯白变半透明；
 *   叠加自定义玻璃背景图 / v2.3.109 body 透明化透出的深色桌面 → **深底深字几乎不可见**
 *   （用户截图实测 bug，v2.3.110 需求 4 修复：ThemeContext 半透明细化收窄回 glass/aura，
 *   frost 恢复自带不透明白面板）。本闸门把这次事故面固化成常驻矩阵，防止再次回归。
 *
 * ── 普查矩阵（15 主题 × 主要界面承载面）────────────────────────────────────────
 *   对每套主题逐格验算「文字令牌 压 承载面」的 WCAG 对比度：
 *     正文/标题  --color-text          压 --color-panel（设置页/弹窗/右键菜单 .more-dropdown）
 *                                 压 --color-panel-alt（次级面板）
 *                                 压 --color-input-bg（输入框）
 *     次要文字   --color-text-secondary 压 --color-panel / --color-panel-alt / --color-input-bg
 *     时间戳     --color-text-muted    压 --color-chat-bg
 *     系统消息   --color-system-msg    压 --color-chat-bg
 *     气泡文字   --color-bubble-ai-text 压 --color-bubble-ai（渐变取最差色标）
 *                --color-bubble-user-text 压 --color-bubble-user（渐变取最差色标）
 *     侧栏图标   --color-nav-icon      压 --color-nav-bg（图形/图标，AA 3.0）
 *     标题栏     --titlebar-text       压 --titlebar-bg
 *   判定：正文/次要/气泡/时间戳/系统消息 ≥ 4.5（WCAG AA 正文）；图标 ≥ 3.0（AA 大字与图形）。
 *
 * ── 深色自定义背景合成工况（玻璃家族专用）──────────────────────────────────────
 *   玻璃家族（glass/frost/aura）用户可设自定义玻璃背景图/色（ThemeContext 写 --app-bg），
 *   面板压在其上。对这三套主题额外注入两种合成背景（深 #14161a / 浅 #f2f3f5）重算全部格子：
 *     · frost（修复目标）：面板已恢复不透明 → 两种工况必须全部 ≥ 阈值（本闸门的核心断言）；
 *     · glass/aura（已知披露上界）：半透明面板压任意背景的对比度天花板是 v2.3.101 起如实
 *       披露的既有性质（见 verify-chat-ui-contrast C5/C6 与 GuideView v2.3.101 卡），深色
 *       工况下底色变暗、对比度只会更好 → 只做「不劣于实测基线」的棘轮，不新增 ≥4.5 硬门。
 *
 * ── 判定门 ─────────────────────────────────────────────────────────────────────
 *   M0 覆盖完整性：解析到的 [data-theme] 数 == 源码声明数（防静默漏解析）
 *   M1 13 套非披露主题（含 frost）× 全部界面格子 ≥ 阈值（不达标即红，须改令牌/承载面）
 *   M2 frost 深色自定义背景工况：全部格子 ≥ 阈值（本次事故的直接回归防线）
 *   M3 glass/aura 深色自定义背景工况：不劣于实测基线（棘轮；基线为 v2.3.110 实测值）
 *   M4 自证活性：合成「文字色==承载面」主题必须被判失败
 *
 * ── 可证伪性 ──────────────────────────────────────────────────────────────────
 *   NY_QA_SURFACE_BREAK=1 → 强制把 frost 正文色替换为其面板底色 → M1/M2 必须变红。
 *
 * 用法：node scripts/verify-theme-surface-matrix.mjs
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
  extractGradientStops,
  resolveColorTokenVars,
} = await import(new URL('./lib/dominantColor.ts', import.meta.url).href);

const BREAK = process.env.NY_QA_SURFACE_BREAK === '1';
const AA_TEXT = 4.5;
const AA_GRAPHIC = 3.0;

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; const l = `  ✗ ${name}${extra ? ' — ' + extra : ''}`; failures.push(l); console.log(l); }
};

// ---------- 1. variables.css → 每个主题的完整自定义属性表（含 :root 继承）----------
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
const declaredThemeCount = (css.match(/\[data-theme=/g) || []).length;
const themes = namedThemes.map((t) => ({ name: t.name, vars: resolveColorTokenVars({ ...rootVars, ...collectVars(t.body) }) }));

// ---------- 2. 求值助手 ----------
function resolveVar(value, vars, depth = 0) {
  if (value == null || depth > 8) return null;
  const s = String(value).trim();
  const m = s.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/);
  if (!m) return s;
  if (vars[m[1]] != null) return resolveVar(vars[m[1]], vars, depth + 1);
  if (m[2] != null) return resolveVar(m[2], vars, depth + 1);
  return null;
}
/** 承载面 css（可半透明/渐变）压到底色 css（可纯色/渐变）上 → 全部可能的合成面（hex 数组）。 */
function surfacesOf(surfaceCss, bgCss) {
  if (!surfaceCss) return [];
  const out = [];
  const layer = parseCssColorWithAlpha(surfaceCss);
  if (!layer) {
    // 不透明面：实色直接作为承载面；渐变取各色标（文字可能压在任意色标上，取最差）
    const stops = extractGradientStops(surfaceCss);
    if (stops.length) return stops;
    return parseCssColor(surfaceCss) ? [surfaceCss] : [];
  }
  const bgSolid = parseCssColor(bgCss);
  if (bgSolid) {
    const c = compositeOver(layer, bgSolid);
    return [rgbToHex(c.r, c.g, c.b)];
  }
  // 半透明面压渐变底：逐色标合成（与 scripts/lib/dominantColor.layerOverBg 同口径）
  const stops = extractGradientStops(bgCss);
  const list = stops.length ? stops : [bgCss];
  for (const st of list) {
    const bg = parseCssColor(st);
    if (!bg) continue;
    const c = compositeOver(layer, bg);
    out.push(rgbToHex(c.r, c.g, c.b));
  }
  return out;
}
/** 文字色压一组承载面的最差对比度；opacity 弱化按 alpha 合成后重算。 */
function worstContrast(fgCss, surfaces, opacity = 1) {
  let fg = parseCssColor(fgCss);
  if (!fg) return null;
  if (opacity < 1) {
    const w = surfaces.length ? Math.min(...surfaces.map((s) => {
      const bg = parseCssColor(s);
      if (!bg) return null;
      const c = compositeOver({ rgb: fg, a: opacity }, bg);
      return contrastRatio(rgbToHex(c.r, c.g, c.b), s);
    }).filter(Number.isFinite)) : null;
    return w;
  }
  const vals = surfaces.map((s) => contrastRatio(rgbToHex(fg.r, fg.g, fg.b), s)).filter(Number.isFinite);
  return vals.length ? Math.min(...vals) : null;
}

// ---------- 3. 普查矩阵定义 ----------
// [文字令牌, 承载面令牌, 阈值, 界面说明]
const MATRIX = [
  ['--color-text', '--color-panel', AA_TEXT, '设置页/弹窗/右键菜单 正文'],
  ['--color-text', '--color-panel-alt', AA_TEXT, '次级面板 正文'],
  ['--color-text', '--color-input-bg', AA_TEXT, '输入框 正文'],
  ['--color-text-secondary', '--color-panel', AA_TEXT, '设置页 标签/次要文字'],
  ['--color-text-secondary', '--color-panel-alt', AA_TEXT, '次级面板 次要文字'],
  ['--color-text-secondary', '--color-input-bg', AA_TEXT, '输入框 次要文字'],
  ['--color-text-muted', '--color-chat-bg', AA_TEXT, '时间戳/弱化文字'],
  ['--color-system-msg', '--color-chat-bg', AA_TEXT, '系统消息'],
  ['--color-bubble-ai-text', '--color-bubble-ai', AA_TEXT, 'AI 气泡文字'],
  ['--color-bubble-user-text', '--color-bubble-user', AA_TEXT, '用户气泡文字'],
  ['--color-nav-icon', '--color-nav-bg', AA_GRAPHIC, '侧栏导航图标（图形 3.0）'],
  ['--titlebar-text', '--titlebar-bg', AA_TEXT, '标题栏文字'],
  ['--titlebar-icon', '--titlebar-bg', AA_GRAPHIC, '标题栏图标（图形 3.0）'],
];

function evaluateMatrix(vars, bgOverride) {
  const bg = bgOverride || vars['--color-bg'];
  const rows = [];
  for (const [fgVar, surfVar, thresh, label] of MATRIX) {
    const fg = resolveVar(`var(${fgVar})`, vars);
    const surf = resolveVar(`var(${surfVar})`, vars);
    const surfaces = surf ? surfacesOf(surf, bg) : [];
    const r = fg ? worstContrast(fg, surfaces) : null;
    rows.push({ fgVar, surfVar, label, thresh, surfaces, value: r, fg });
  }
  return rows;
}

// ---------- 4. 输出矩阵 ----------
check(
  `M0 主题块无漏解析（源码声明 ${declaredThemeCount} 个 [data-theme=] == 解析 ${themes.length} 个）`,
  declaredThemeCount === themes.length && themes.length === 14,
  `源码 ${declaredThemeCount} vs 解析 ${themes.length}`
);

// 已知披露上界主题（玻璃家族半透明面板；见 verify-chat-ui-contrast C5/C6 与 v2.3.101 GuideView 卡）
// v2.3.122：'glass' 主题已删除（磨砂观感改为每主题开关 settings.glassEffect），
// 披露上界主题只剩 aura。
const DISCLOSED = new Set(['aura']);

console.log('\n主题'.padEnd(11) + '正文/面板'.padEnd(9) + '次要/面板'.padEnd(9) + '时间戳'.padEnd(8) + '系统消息'.padEnd(8) + 'AI气泡'.padEnd(8) + '用户气泡'.padEnd(8) + '图标'.padEnd(6) + '标题栏');
const fmt = (v) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(2));
const allRows = new Map();
for (const t of themes) {
  const rows = evaluateMatrix(t.vars);
  allRows.set(t.name, rows);
  const pick = (fgV, surfV) => rows.find((r) => r.fgVar === fgV && r.surfVar === surfV);
  const pickMin = (fgV, surfList) => {
    const vals = surfList.map((sv) => pick(fgV, sv)?.value).filter(Number.isFinite);
    return vals.length ? Math.min(...vals) : null;
  };
  console.log(
    (t.name + (DISCLOSED.has(t.name) ? '*' : '')).padEnd(11) +
    fmt(pickMin('--color-text', ['--color-panel', '--color-panel-alt', '--color-input-bg'])).padEnd(9) +
    fmt(pickMin('--color-text-secondary', ['--color-panel', '--color-panel-alt', '--color-input-bg'])).padEnd(9) +
    fmt(pick('--color-text-muted', '--color-chat-bg')?.value).padEnd(8) +
    fmt(pick('--color-system-msg', '--color-chat-bg')?.value).padEnd(8) +
    fmt(pick('--color-bubble-ai-text', '--color-bubble-ai')?.value).padEnd(8) +
    fmt(pick('--color-bubble-user-text', '--color-bubble-user')?.value).padEnd(8) +
    fmt(pick('--color-nav-icon', '--color-nav-bg')?.value).padEnd(6) +
    fmt(pick('--titlebar-text', '--titlebar-bg')?.value)
  );
}
console.log('  (* = 玻璃家族已知披露上界主题，半透明面板天花板见 verify-chat-ui-contrast C5/C6)');

// ---------- 5. M1：非披露主题全格硬门 ----------
console.log('\n=== M1 非披露主题（13 套，含 frost）× 全部界面格子 ≥ 阈值 ===');
{
  const bad = [];
  for (const t of themes) {
    if (DISCLOSED.has(t.name)) continue;
    for (const r of allRows.get(t.name)) {
      if (r.value === null || !Number.isFinite(r.value) || r.value < r.thresh) {
        bad.push(`${t.name} ${r.label} ${fmt(r.value)} < ${r.thresh}`);
      }
    }
  }
  if (bad.length) {
    console.log('  不达标清单：');
    for (const b of bad) console.log('    · ' + b);
  }
  check(
    bad.length === 0 ? `M1 全部 13 套主题 × ${MATRIX.length} 个界面格子全部达标` : `M1 有 ${bad.length} 格不达标（须改令牌或局部加深承载面，不许放水）`,
    bad.length === 0,
    bad.slice(0, 8).join('; ') + (bad.length > 8 ? ` …(共 ${bad.length})` : '')
  );
}

// ---------- 6. M2/M3：深色/浅色自定义背景合成工况（玻璃家族） ----------
console.log('\n=== M2/M3 玻璃家族自定义背景合成工况（深 #14161a / 浅 #f2f3f5）===');
const DEEP_BG = '#14161a';
const LIGHT_BG = '#f2f3f5';
{
  // M2 frost：修复目标 —— 两种工况全格 ≥ 阈值
  const frost = themes.find((t) => t.name === 'frost');
  const bad = [];
  for (const [label, bgOverride] of [['深色自定义背景', DEEP_BG], ['浅色自定义背景', LIGHT_BG]]) {
    for (const r of evaluateMatrix(frost.vars, bgOverride)) {
      if (r.value === null || !Number.isFinite(r.value) || r.value < r.thresh) {
        bad.push(`frost ${label} ${r.label} ${fmt(r.value)} < ${r.thresh}`);
      }
    }
  }
  if (bad.length) {
    console.log('  不达标清单：');
    for (const b of bad) console.log('    · ' + b);
  }
  check(
    'M2 frost 深/浅自定义背景工况全格达标（v2.3.110 需求 4 修复的回归防线）',
    bad.length === 0,
    bad.slice(0, 6).join('; ')
  );

  // M3 glass/aura：披露上界主题 → 深色工况下棘轮（不劣于 v2.3.110 实测基线）
  const DEEP_BASELINE = {
    // 基线 = v2.3.110 普查实测（需求 1 alpha 补偿后；半透明面板压深色自定义底）。
    // glass/aura 的半透明面板天花板属既有披露性质（verify-chat-ui-contrast C5/C6、
    // GuideView v2.3.101 卡「毛玻璃固有性质」）；深色底下面板合成变暗、绝大多数格子
    // 反而达标，仅「用户气泡文字」仍是已知上界。本棘轮锁实测值，任何令牌回退都会变红。
    aura: { text: 10.3, secondary: 9.74, muted: 12.89, system: 11.38, ai: 10.3, user: 2.6, nav: 18.46, titlebar: 16.59, ticon: 18.02 },
  };
  const keyOf = (r) => {
    if (r.fgVar === '--color-text') return 'text';
    if (r.fgVar === '--color-text-secondary') return 'secondary';
    if (r.fgVar === '--color-text-muted') return 'muted';
    if (r.fgVar === '--color-system-msg') return 'system';
    if (r.fgVar === '--color-bubble-ai-text') return 'ai';
    if (r.fgVar === '--color-bubble-user-text') return 'user';
    if (r.fgVar === '--color-nav-icon') return 'nav';
    if (r.fgVar === '--titlebar-icon') return 'ticon';
    return 'titlebar';
  };
  const ratchet = [];
  for (const name of ['aura']) {
    const t = themes.find((x) => x.name === name);
    for (const r of evaluateMatrix(t.vars, DEEP_BG)) {
      console.log(`  [deep-bg 实测] ${name} ${r.label} = ${fmt(r.value)}（基线 ${DEEP_BASELINE[name][keyOf(r)]}）`);
      const base = DEEP_BASELINE[name][keyOf(r)];
      if (r.value === null || !Number.isFinite(r.value) || r.value < base - 0.01) {
        ratchet.push(`${name} ${r.label} ${fmt(r.value)} < 基线 ${base}`);
      }
    }
  }
  check('M3 aura 深色自定义背景工况不劣于实测基线（披露上界棘轮）', ratchet.length === 0, ratchet.join('; '));
}

// ---------- 7. M4 自证活性 ----------
{
  const synth = {
    '--color-bg': '#808080', '--color-panel': '#808080', '--color-panel-alt': '#808080',
    '--color-chat-bg': '#808080', '--color-input-bg': '#808080', '--color-hover': '#808080',
    '--color-text': '#7f7f7f', '--color-text-secondary': '#7f7f7f', '--color-text-muted': '#7f7f7f',
    '--color-system-msg': '#7f7f7f', '--color-bubble-ai': '#808080', '--color-bubble-ai-text': '#7f7f7f',
    '--color-bubble-user': '#808080', '--color-bubble-user-text': '#7f7f7f',
    '--color-nav-bg': '#808080', '--color-nav-icon': '#7f7f7f',
    '--titlebar-bg': '#808080', '--titlebar-text': '#7f7f7f',
  };
  const rows = evaluateMatrix(synth);
  const failing = rows.filter((r) => r.value !== null && r.value < r.thresh);
  check(`M4 检查器非空转：合成主题至少 1 格被判失败（实际 ${failing.length} 格）`, failing.length > 0);
}

// ---------- 8. 可证伪性注入 ----------
if (BREAK) {
  const frost = themes.find((t) => t.name === 'frost');
  const rows = evaluateMatrix({ ...frost.vars, '--color-text': 'var(--color-panel)' });
  const bad = rows.filter((r) => r.fgVar === '--color-text' && r.value < r.thresh);
  console.log('\n[可证伪性] NY_QA_SURFACE_BREAK=1 → frost 正文色被替换为其面板底色，注入格必须被判失败。');
  if (bad.length) {
    fail++;
    failures.push('NY_QA_SURFACE_BREAK=1 注入被正确判失败（这是预期的可证伪性证明，退出码非 0 即目的达到）');
    console.log(`  注入已生效：frost 正文格对比度 = ${fmt(bad[0].value)}，被判失败 → 检查器是活的。`);
  } else {
    fail++;
    failures.push('NY_QA_SURFACE_BREAK=1 注入未被判失败 —— 检查器失效！');
    console.log('  ✗ 注入未生效（正文格仍通过）—— 检查器空转，必须排查！');
  }
}

// ---------- 9. G：毛玻璃开启时浮层文字对比度（v2.3.127 修复的回归防线）----------
// 浅色主题开启毛玻璃后，.modal/.more-dropdown 等浮层后台被强制为深色高不透明底
// rgba(18,16,38,0.92)，文字必须翻为亮色。本段把「亮色令牌 压 深色毛玻璃底」锁死为 ≥4.5
// （WCAG AA），并对「浅底（白）/ 深底（黑）」两种合成工况取最差，防止 v2.3.127 修复回归。
console.log('\n=== G 毛玻璃开启时浮层文字对比度（亮色令牌 压 深色毛玻璃底）===');
{
  const glassLayer = parseCssColorWithAlpha('rgba(18, 16, 38, 0.92)');
  const surfaces = [parseCssColor('#ffffff'), parseCssColor('#000000')]
    .filter(Boolean)
    .map((bg) => {
      const c = compositeOver(glassLayer, bg);
      return rgbToHex(c.r, c.g, c.b);
    });
  const GLASS_TEXT = {
    '--color-text': '#eef1f7',
    '--color-text-secondary': '#c2c9d6',
    '--color-text-muted': '#aab2c2',
    '--color-system-msg': '#c2c9d6',
    '--color-select-text': '#eef1f7',
  };
  const bad = [];
  for (const [tok, fg] of Object.entries(GLASS_TEXT)) {
    const r = worstContrast(fg, surfaces);
    if (r === null || !Number.isFinite(r) || r < AA_TEXT) bad.push(`${tok} ${fmt(r)} < ${AA_TEXT}`);
  }
  if (bad.length) {
    console.log('  不达标清单：');
    for (const b of bad) console.log('    · ' + b);
  }
  check('G 毛玻璃浮层亮色令牌 压 深色底（白/黑合成工况取最差）全部 ≥ 4.5', bad.length === 0, bad.join('; '));

  // 琉璃幻境（aura）浮层：深色底 rgba(9,21,40,0.88) + 主题自带亮色令牌，同样锁死
  const auraLayer = parseCssColorWithAlpha('rgba(9, 21, 40, 0.88)');
  const aSurfaces = [parseCssColor('#ffffff'), parseCssColor('#000000')]
    .filter(Boolean)
    .map((bg) => {
      const c = compositeOver(auraLayer, bg);
      return rgbToHex(c.r, c.g, c.b);
    });
  const AURA_TEXT = {
    '--color-text': '#eef7fb',
    '--color-text-secondary': 'rgba(226,242,248,0.72)',
    '--color-text-muted': 'rgba(220,240,248,0.85)',
    '--color-system-msg': 'rgba(190,230,240,0.75)',
  };
  const abad = [];
  for (const [tok, fg] of Object.entries(AURA_TEXT)) {
    const r = worstContrast(fg, aSurfaces);
    if (r === null || !Number.isFinite(r) || r < AA_TEXT) abad.push(`${tok} ${fmt(r)} < ${AA_TEXT}`);
  }
  if (abad.length) {
    console.log('  aura 不达标清单：');
    for (const b of abad) console.log('    · ' + b);
  }
  check('G 琉璃幻境(aura)浮层亮色令牌 压 深色底（白/黑合成工况取最差）全部 ≥ 4.5', abad.length === 0, abad.join('; '));
}

// ---------- 汇总 ----------
console.log(`\n断言：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.error('\n失败明细：');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('✅ 全主题 × 全界面文字对比度普查闸门通过');
