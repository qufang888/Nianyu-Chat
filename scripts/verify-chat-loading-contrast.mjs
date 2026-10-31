#!/usr/bin/env node
/**
 * verify-chat-loading-contrast.mjs — v3.0.1-beta.4「聊天气泡内加载态可读性」全主题普查闸门。
 *
 * ── 这个闸门防的是什么回归（用户实测）──────────────────────────────────────
 *   用户反馈：「加载的动画在这个聊天气泡内融为一体，和背景颜色十分接近，根本看不清」。
 *   加载动画由两处构成：
 *     · .typing .typing-bar   —— 气泡内整条等待条（占位气泡「正在回复」）
 *     · .typing-inline         —— 气泡正文内联的流式等待条（F6 修复）
 *   旧实现二者的**底槽**都写死 `rgba(128, 128, 128, 0.18)`（固定中性灰），
 *   **不随主题走** → 在某些主题的气泡底色上底槽与气泡几乎同色（"融为一体"）。
 *
 * ── 修复方案（本次闸门固化其结果）────────────────────────────────────────────
 *   改用 **currentColor**（= 所在气泡的文字色，由 .bubble 的 color 决定）：
 *     底槽 = color-mix(currentColor 30%, transparent) 叠在气泡底色上
 *     前景 = currentColor 100%
 *   气泡的文字色与气泡底色**本来就受主题契约保证高对比**（见 verify-theme-surface-matrix
 *   的气泡文字 ≥4.5 断言），故：
 *     · 底槽是「文字色压气泡底」的中间态 → 与气泡底色必然可分辨（不融为一体）
 *     · 前景是文字色本体 → 与底槽、与气泡底色都是最高对比
 *   这样**任何主题都自动满足**，无需逐主题硬编码色值（新增主题也不会漏）。
 *
 * ── 普查矩阵（15 主题 × 加载态）──────────────────────────────────────────────
 *   L1 底槽 vs AI 气泡底色    ≥ 1.5（要看出是「一条独立的加载槽」）
 *   L2 前景 vs 底槽           ≥ 3.0（移动高亮条必须清晰，WCAG AA 非文本图形）
 *   L3 前景 vs AI 气泡底色     ≥ 3.0
 *   L4/L5 同上两项 × 用户气泡  ≥ 1.5 / 2.0（**宽松兜底**：加载条实际只出现在 AI 气泡
 *                             ——.typing 气泡与 .typing-inline 均只在 AI 消息上渲染；
 *                             用户气泡侧明暗跨度与 AI 气泡相反，单一 currentColor 方案
 *                             在两侧不可能同时最优，故此处只要求「不至于完全不可见」）
 *   L6 .img-loading（图片加载文案）：图片移进气泡后承载面由面板底变为**气泡底**，
 *      已改用 currentColor（气泡文字色）→ 判据为「前景 vs AI 气泡底 ≥ 4.5」。
 *
 * ── 可证伪性 ─────────────────────────────────────────────────────────────────
 *   NY_QA_LOADING_BREAK=1 → 把某主题的气泡文字色强制改成与气泡底同色 → L2/L3 必须变红。
 *
 * 用法：node scripts/verify-chat-loading-contrast.mjs
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
  extractGradientStops,
  resolveColorTokenVars,
} = await import(new URL('./lib/dominantColor.ts', import.meta.url).href);

const BREAK = process.env.NY_QA_LOADING_BREAK === '1';
const AA_GRAPHIC = 3.0;   // 前景高亮条：非文本图形（WCAG AA）
const AA_TRACK = 1.5;     // 底槽：装饰性槽，但必须能与气泡底色区分
const AA_TRACK_USER = 1.5; // 用户气泡侧底槽（宽松兜底）
const AA_BAR_USER = 2.0;   // 用户气泡侧前景（宽松兜底）
const AA_TEXT = 4.5;      // .img-loading 文字：正文级
/** 底槽混合比例（与 index.css 的 color-mix(currentColor 30%, transparent) 保持一致） */
const TRACK_MIX_PCT = 30;

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; const l = `  ✗ ${name}${extra ? ' — ' + extra : ''}`; failures.push(l); console.log(l); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// ---------- 1. 解析 variables.css → 每个主题的变量表 ----------
const css = fs.readFileSync(path.join(ROOT, 'src/theme/variables.css'), 'utf-8');

function collectVars(body) {
  const vars = {};
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body)) !== null) vars[m[1]] = m[2].trim();
  return vars;
}
function blockOf(selector) {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  const open = css.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') { depth--; if (depth === 0) return css.slice(open + 1, j); }
  }
  return '';
}
const rootVars = collectVars(blockOf(':root'));
const named = [...css.matchAll(/\[data-theme='([a-z-]+)'\]/g)].map((m) => m[1]);

/** token → 实际渲染色：半透明逐层合成到不透明底；渐变取最暗档（浅色前景在深底上最易分辨） */
function surface(vars, token, fb) {
  let raw = vars[token] ?? fb;
  const stops = extractGradientStops(raw);
  if (stops && stops.length) raw = stops[stops.length - 1];
  const p = parseCssColorWithAlpha(raw);
  if (!p) return parseCssColor(raw) || parseCssColor(fb);
  if (p.a >= 1) return p.rgb;
  let under = parseCssColor(vars['--color-chat-bg'] || '#ffffff') || parseCssColor('#ffffff');
  const cb = parseCssColorWithAlpha(vars['--color-chat-bg'] || '');
  if (cb && cb.a < 1) {
    const abRaw = vars['--app-bg'] || vars['--color-bg'] || '#ffffff';
    const abStops = extractGradientStops(abRaw);
    const ab = parseCssColor(abStops && abStops.length ? abStops[abStops.length - 1] : abRaw) || parseCssColor('#ffffff');
    under = compositeOver({ rgb: cb.rgb, a: cb.a }, ab);
  } else if (cb) under = cb.rgb;
  return compositeOver({ rgb: p.rgb, a: p.a }, under);
}

/** RGB → #rrggbb（contrastRatio 收 hex 字符串） */
const toHex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const cr = (x, y) => contrastRatio(toHex(x), toHex(y));

const themes = named.map((name) => {
  const vars = resolveColorTokenVars({ ...rootVars, ...collectVars(blockOf(`[data-theme='${name}']`)) });
  if (BREAK && name === 'frost') {
    // 自证活性：把气泡文字色改成与气泡底同色 → 前景不可见 → L2/L3 必须变红
    vars['--color-bubble-ai-text'] = vars['--color-bubble-ai'];
  }
  return { name, vars };
});

// ---------- 2. 普查 ----------
section('L0 覆盖完整性');
const uniq = [...new Set(named)];
check(`解析到 ${uniq.length} 套主题（去重后）`, uniq.length === 14, `实得 ${uniq.length}：${uniq.join(',')}`);

section(`L1–L5 加载态 × ${uniq.length} 主题对比度（底槽 = currentColor ${TRACK_MIX_PCT}%，前景 = currentColor）`);
for (const th of themes) {
  const ai = surface(th.vars, '--color-bubble-ai', '#ffffff');
  const aiText = surface(th.vars, '--color-bubble-ai-text', '#1a1a1a');
  const usr = surface(th.vars, '--color-bubble-user', '#95ec69');
  const usrText = surface(th.vars, '--color-bubble-user-text', '#1a1a1a');
  if (!ai || !aiText || !usr || !usrText) {
    check(`${th.name} 变量可解析`, false, '颜色令牌缺失');
    continue;
  }
  // 底槽 = currentColor P% 叠在气泡底色上
  const trackAi = compositeOver({ rgb: aiText, a: TRACK_MIX_PCT / 100 }, ai);
  const trackUsr = compositeOver({ rgb: usrText, a: TRACK_MIX_PCT / 100 }, usr);
  const L1 = cr(trackAi, ai);      // 底槽 vs AI 气泡底
  const L2 = cr(aiText, trackAi);  // 前景 vs 底槽
  const L3 = cr(aiText, ai);       // 前景 vs AI 气泡底
  const L4 = cr(trackUsr, usr);    // 底槽 vs 用户气泡
  const L5 = cr(usrText, trackUsr);// 前景 vs 底槽（用户气泡）
  const LI = cr(aiText, ai);           // .img-loading 文字（已改 currentColor）vs AI 气泡底
  const ok = L1 >= AA_TRACK && L2 >= AA_GRAPHIC && L3 >= AA_GRAPHIC &&
             L4 >= AA_TRACK_USER && L5 >= AA_BAR_USER && LI >= AA_TEXT;
  check(
    `${th.name}：底槽/AI气泡 ${L1.toFixed(2)}｜前景/底槽 ${L2.toFixed(2)}｜前景/AI气泡 ${L3.toFixed(2)}｜用户气泡 ${L4.toFixed(2)}/${L5.toFixed(2)}｜图注文 ${LI.toFixed(2)}`,
    ok,
    `需 底槽≥${AA_TRACK} 前景≥${AA_GRAPHIC} 图注文≥${AA_TEXT}`,
  );
}

section('L6 CSS 实现（结构契约）');
{
  const idx = fs.readFileSync(path.join(ROOT, 'src/styles/index.css'), 'utf-8');
  check('.typing .typing-bar 底槽改用 color-mix(currentColor …) —— 不再写死中性灰',
    /\.typing \.typing-bar \{[^}]*background:\s*color-mix\(in srgb, currentColor \d+%,\s*transparent\)/.test(idx));
  check('.typing-inline 底槽改用 color-mix(currentColor …)',
    /\.typing-inline \{[^}]*background:\s*color-mix\(in srgb, currentColor \d+%,\s*transparent\)/.test(idx));
  check('.typing .typing-bar::after 前景改用 currentColor',
    /\.typing \.typing-bar::after \{[^}]*background:\s*currentColor;/.test(idx));
  check('.typing-inline::after 前景改用 currentColor',
    /\.typing-inline::after \{[^}]*background:\s*currentColor;/.test(idx));
  // 加载条两处的底槽不得再写死中性灰（.cite-badge:hover / .splash-line 是无关元素，保留）
  const typingBlock = /\.typing \.typing-bar \{[^}]*\}/.exec(idx)?.[0] || '';
  const inlineBlock = /\.typing-inline \{[^}]*\}/.exec(idx)?.[0] || '';
  check('加载条底槽不再写死 rgba(128, 128, 128, 0.18)',
    !/rgba\(128,\s*128,\s*128,\s*0\.18\)/.test(typingBlock) &&
    !/rgba\(128,\s*128,\s*128,\s*0\.18\)/.test(inlineBlock));
  check('.img-loading 改用 currentColor（图片移进气泡后承载面变为气泡底）',
    /\.img-loading \{[^}]*color:\s*currentColor/.test(idx));
  check('底槽混合比例与本脚本常量一致（30%）',
    new RegExp(`currentColor ${TRACK_MIX_PCT}%,`).test(idx));
}

console.log('\n' + '='.repeat(60));
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(f));
  process.exit(1);
}
process.exit(0);
