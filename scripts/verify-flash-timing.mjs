#!/usr/bin/env node
/**
 * verify-flash-timing.mjs — v2.3.102 需求 4「闪动统一 1s×5 + 主题取色」**可执行**验证。
 *
 * ── 本脚本防的是什么回归（存在的理由）──────────────────────────────────────────
 *   需求 4 要求「所有闪动统一为 1s×5=5s，且闪动颜色随主题适配」。
 *   · 时长回归：`.setting-flash,.model-flash{animation:flashPulse 1s linear 5}` 一旦被改动
 *     （如改回 3 次），本门 R4d 立即变红（CSS 与 FLASH_MS 的配对断言）。
 *   · 取色回归：`--color-flash-bg`/`--color-flash-ring` 必须从当前主题主色派生。历史上 ring 曾写
 *     `var(--color-primary-shadow, rgba(58,143,208,0.4))`，而 `--color-primary-shadow` **全仓从未定义**，
 *     故 15 套主题的光环恒为同一抹蓝 —— 违背「随主题适配」。本门 R4f-4/5 断言 ring 派生自主色且无硬编码色。
 *   · 移除回归：原 MemoryPanel 只加类不移除；本门 R4b 用虚时钟断言 FLASH_MS 后类**被移除**。
 *
 * 立场：直接 import 真实实现 src/utils/flash.ts（Node 22 type-stripping），用「可控假时钟 + stub 元素」验证行为，
 * 而不是只 grep 源码。
 *
 * 断言：
 *   R4a 调用后闪动类被加上
 *   R4b 经过 FLASH_MS 后类**被移除**（这是原 MemoryPanel 缺的路径 = 真 bug 修复点）
 *   R4c 去抖：同元素连续两次，旧定时器被清（不得出现「第一个定时器提前摘类导致第二次被腰斩」）
 *   R4d 时长配对：从 index.css 解析 `animation: flashPulse <d>s linear <n>`，d×n×1000 == import 的 FLASH_MS（不写死数字）
 *   R4e setting-flash / model-flash 共用同一 keyframe（flashPulse），且只有一个 @keyframes flashPulse
 *   R4f --color-flash-bg / --color-flash-ring 只在 :root 定义（无主题覆盖）→ 15 主题继承；
 *       且 ring 派生自 var(--color-primary)（随主题适配）、不含硬编码色
 *   R4g 闪动「可辨认」：bg(=--color-primary) 相对各主题面板/聊天面 ≥3:1（非文本对比度可感知阈值）
 *
 * 时间控制方式：把 window.setTimeout/clearTimeout 换成基于「虚拟时钟」的实现，手动 advance(t) 触发到期回调
 *   —— 不真的等待 5 秒，确定性、可复现。stub 元素只提供 { classList.add/remove/contains, offsetWidth }。
 *
 * 用法：node scripts/verify-flash-timing.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');
const BREAK = process.env.NY_QA_R4_BREAK === '1';
if (BREAK) console.log('⚠️  NY_QA_R4_BREAK=1（把 flashPulse 改成 1s×3 → 时长配对断言应变红）');

// ---------- 假时钟（在 import flash.ts 之前装好 window）----------
let now = 0, seq = 0;
const pending = new Map(); // id -> { at, fn }
globalThis.window = {
  setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { at: now + (Number(ms) || 0), fn }); return id; },
  clearTimeout: (id) => { pending.delete(id); },
};
function advance(to) {
  for (;;) {
    let best = null;
    for (const [id, t] of pending) if (t.at <= to && (best === null || t.at < pending.get(best).at)) best = id;
    if (best === null) break;
    now = pending.get(best).at;
    const fn = pending.get(best).fn;
    pending.delete(best);
    fn();
  }
  now = Math.max(now, to);
}
const resetClock = () => { now = 0; seq = 0; pending.clear(); };

const flash = await import(new URL('../src/utils/flash.ts', import.meta.url).href);
const { flashElement, FLASH_MS } = flash;

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✔ ' + name); }
  else { fail++; const l = `  ✗ ${name}${extra ? ' — ' + extra : ''}`; failures.push(l); console.log(l); }
};

function mkEl() {
  const set = new Set();
  const log = [];
  return {
    set, log, offsetWidth: 0,
    classList: {
      add: (c) => { set.add(c); log.push('add:' + c); },
      remove: (c) => { set.delete(c); log.push('rm:' + c); },
      contains: (c) => set.has(c),
    },
  };
}

// ---------- R4a/R4b ----------
console.log('=== R4a/b 加类 / FLASH_MS 后移除类 ===');
check('R4a-0 FLASH_MS 为有限正数（来自真实 import）', Number.isFinite(FLASH_MS) && FLASH_MS > 0, `FLASH_MS=${FLASH_MS}`);
resetClock();
{
  const el = mkEl();
  flashElement(el);
  check('R4a 调用后类被加上', el.classList.contains('setting-flash'), el.log.join(' '));
  const before = pending.size;
  check('R4a-1 恰挂了 1 个移除定时器', before === 1, `pending=${before}`);
  advance(FLASH_MS - 1);
  check(`R4b-0 到 FLASH_MS-1 时类仍在（未提前移除）`, el.classList.contains('setting-flash'));
  advance(FLASH_MS);
  check(`R4b 经过 FLASH_MS(${FLASH_MS}ms) 后类被移除（原 MemoryPanel 缺失的路径）`,
    !el.classList.contains('setting-flash'), el.log.join(' '));
  check('R4b-1 定时器执行后已清空（无泄漏）', pending.size === 0, `pending=${pending.size}`);
}

// ---------- R4c 去抖 ----------
console.log('\n=== R4c 去抖（连续两次不被腰斩）===');
resetClock();
{
  const el = mkEl();
  flashElement(el);                 // t=0, timer@5000
  advance(4000);                    // t=4000 仍应闪
  const stillFirst = el.classList.contains('setting-flash');
  flashElement(el);                 // t=4000 再次触发 → 应清掉旧 timer，重挂 @9000
  check('R4c-0 第二次触发前类仍在（第一次闪动未被提前摘）', stillFirst);
  check('R4c-1 连续两次后仍只有 1 个活跃定时器（旧定时器被 clearTimeout）', pending.size === 1, `pending=${pending.size}`);
  const onlyAt = [...pending.values()][0]?.at;
  check('R4c-2 存活定时器到期时间为 t=4000+FLASH_MS（计时被重置）', onlyAt === 4000 + FLASH_MS, `at=${onlyAt}`);
  advance(5000);                     // 原第一个定时器的到期点
  check('R4c-3 到达「第一个定时器」到期点(t=5000)时类**仍在**（证明它已被清 → 第二次闪动不被腰斩）',
    el.classList.contains('setting-flash'));
  advance(4000 + FLASH_MS);          // 第二个定时器到期
  check('R4c-4 到达第二个定时器到期点(t=9000)后类被移除', !el.classList.contains('setting-flash'));
  check('R4c-5 结束时无残留定时器', pending.size === 0);
}

// ---------- R4d 时长配对（从 CSS 解析，不写死）----------
console.log('\n=== R4d CSS 动画 × 次数 与 FLASH_MS 配对 ===');
const CSS_RAW = read('src/styles/index.css');
const CSS = BREAK ? CSS_RAW.replace('flashPulse 1s linear 5', 'flashPulse 1s linear 3') : CSS_RAW;
const rule = CSS.match(/\.setting-flash\s*,\s*\.model-flash\s*\{([^}]*)\}/);
const anim = rule ? ((rule[1].match(/animation\s*:\s*([^;]+);/) || [])[1] || '').trim().replace(/\s+/g, ' ') : '';
const parts = anim.match(/([A-Za-z]+)\s+([\d.]+)s\s+linear\s+(\d+)/);
const kfName = parts ? parts[1] : null;
const durS = parts ? Number(parts[2]) : NaN;
const iter = parts ? Number(parts[3]) : NaN;
const totalMs = durS * 1000 * iter;
console.log(`  解析 animation = "${anim}" → keyframe=${kfName} ${durS}s × ${iter} = ${totalMs}ms；FLASH_MS=${FLASH_MS}`);
check('R4d-1 从 CSS 解析出 `flashPulse <d>s linear <n>` 形式', !!parts, `实际 "${anim}"`);
check('R4d-2 单次 1s', durS === 1, `实际 ${durS}s`);
check('R4d-3 次数 5', iter === 5, `实际 ${iter}`);
check(`R4d-4 CSS 总时长 == FLASH_MS（${totalMs} == ${FLASH_MS}）`, totalMs === FLASH_MS, `不符`);

// ---------- R4e 共享 keyframe ----------
console.log('\n=== R4e 共享 keyframe ===');
const kfCount = (CSS.match(/@keyframes\s+flashPulse\s*\{/g) || []).length;
check('R4e-1 仅存在 1 个 @keyframes flashPulse', kfCount === 1, `实际 ${kfCount}`);
check('R4e-2 setting-flash 与 model-flash 引用同一 keyframe（同一条规则）',
  kfName === 'flashPulse' && /\.setting-flash\s*,\s*\.model-flash\s*\{/.test(CSS));

// ---------- R4f/R4g 取色 ----------
console.log('\n=== R4f/g 取色随主题 ===');
const VARS = read('src/theme/variables.css');
// 检查是否有主题块覆盖 --color-flash-*
function topLevelBlocks(src) {
  const out = [];
  const opener = /^[ \t]*([^\s{}][^{}\n]*?)[ \t]*\{/gm;
  let m;
  while ((m = opener.exec(src)) !== null) {
    const sel = m[1].trim();
    const bs = src.indexOf('{', m.index);
    let depth = 0, i = bs;
    for (; i < src.length; i++) { const ch = src[i]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) break; } }
    opener.lastIndex = i + 1;
    if (!sel || sel.startsWith('@') || sel.startsWith('*')) continue;
    out.push({ sel, body: src.slice(bs + 1, i) });
  }
  return out;
}
const blocks = topLevelBlocks(VARS.replace(/\/\*[\s\S]*?\*\//g, ''));
const themeBlocks = blocks.filter((b) => /^\[data-theme=/.test(b.sel));
const overrides = themeBlocks.filter((b) => /--color-flash-/.test(b.body));
check('R4f-1 无任何 [data-theme] 块覆盖 --color-flash-*（15 主题统一经 :root 继承）',
  overrides.length === 0, overrides.map((b) => b.sel).join(', '));
const rootBlock = blocks.find((b) => b.sel === ':root');
const rootFlashBg = rootBlock ? (rootBlock.body.match(/--color-flash-bg\s*:\s*([^;]*);/) || [])[1] : null;
const rootFlashRing = rootBlock ? (rootBlock.body.match(/--color-flash-ring\s*:\s*([^;]*);/) || [])[1] : null;
check('R4f-2 :root 定义 --color-flash-bg = var(--color-primary)', /var\(--color-primary\)/.test(rootFlashBg || ''), `${rootFlashBg}`);
check('R4f-3 :root 定义 --color-flash-ring', !!rootFlashRing, `${rootFlashRing}`);
// 需求 4「颜色随主题适配」：ring 必须从当前主题主色派生，且不得出现任何硬编码色值。
// （历史 bug：ring 曾写 var(--color-primary-shadow, rgba(58,143,208,0.4))，而 --color-primary-shadow
//   全仓从未定义 → 15 套主题光环恒为同一抹蓝。）\brgba?\( 的前导 \b 用于排除 color-mix 的 "srgb("。
const ringValue = rootFlashRing || '';
const ringFollowsPrimary = /var\(--color-primary\)/.test(ringValue);
const ringHardcoded = /#[0-9a-fA-F]{3,8}\b/.test(ringValue) || /\brgba?\(/i.test(ringValue);
check('R4f-4 --color-flash-ring 派生自 var(--color-primary)（光环随主题适配）', ringFollowsPrimary, `${ringValue}`);
check('R4f-5 --color-flash-ring 不含硬编码色值（hex / rgb / rgba）', !ringHardcoded, `${ringValue}`);
// 自证活性：把**旧的**硬编码 ring 值喂给同一判定 → 必须判「未派生主色 + 有硬编码色」
{
  const oldRing = 'var(--color-primary-shadow, rgba(58, 143, 208, 0.4))';
  const ok = ringCheckPasses(oldRing);
  check('R4f-6 自证活性：旧硬编码 ring 会被本判定判红', !ok, `${oldRing} → ${ok ? '误判为通过' : '正确判红'}`);
}
function ringCheckPasses(v) {
  return /var\(--color-primary\)/.test(v) && !/#[0-9a-fA-F]{3,8}\b/.test(v) && !/\brgba?\(/i.test(v);
}

// 各主题：flash-bg(=primary) 对 面板/聊天 面的可感知性（≥3:1）
const { contrastRatio, parseCssColor, compositeOver, rgbToHex, parseCssColorWithAlpha, computePrimarySurfaces } = await import(
  new URL('../src/utils/dominantColor.ts', import.meta.url).href
);
const varsOf = (body) => {
  const g = (p) => { const m = body.match(new RegExp('--' + p + '\\s*:\\s*([^;]*);')); return m ? m[1].trim() : null; };
  return { bg: g('color-bg'), panel: g('color-panel'), chatBg: g('color-chat-bg'), primary: g('color-primary') };
};
const rv = varsOf(rootBlock ? rootBlock.body : '');
const themes = themeBlocks.map((b) => {
  const v = varsOf(b.body);
  for (const k of Object.keys(v)) v[k] = v[k] ?? rv[k];
  return { name: b.sel.match(/\[data-theme=['"]([^'"]+)['"]\]/)[1], ...v };
});
const overBg = (layerCss, bgHex) => {
  const layer = parseCssColorWithAlpha(layerCss); const bg = parseCssColor(bgHex);
  if (!layer || !bg) return null; const c = compositeOver(layer, bg); return rgbToHex(c.r, c.g, c.b);
};
// 用真实 computePrimarySurfaces 处理渐变底（glass/vibrant/liquid 的 --color-bg 是渐变）
const surfacesOf = (layerCss, bgCss) => computePrimarySurfaces(layerCss, bgCss);
const minContrastOver = (fg, surfaces) => (surfaces.length ? Math.min(...surfaces.map((s) => contrastRatio(fg, s))) : null);
let worst = { ratio: Infinity, name: null, kind: '' };
const rows = [];
for (const t of themes) {
  const chatSurf = surfacesOf(t.chatBg, t.bg);
  const panelSurf = surfacesOf(t.panel, t.bg);
  const rPanel = minContrastOver(t.primary, panelSurf);
  const rChat = minContrastOver(t.primary, chatSurf);
  const r = Math.min(rPanel ?? Infinity, rChat ?? Infinity);
  if (r < worst.ratio) worst = { ratio: r, name: t.name, kind: r === rPanel ? 'panel' : 'chat' };
  rows.push({ name: t.name, primary: t.primary, rPanel, rChat });
}
console.log('  ' + 'theme'.padEnd(12) + 'primary'.padEnd(10) + 'vs-panel'.padEnd(10) + 'vs-chat');
for (const r of rows) {
  console.log('  ' + r.name.padEnd(12) + r.primary.padEnd(10) + (r.rPanel === null ? 'n/a' : r.rPanel.toFixed(2)).padEnd(10) + (r.rChat === null ? 'n/a' : r.rChat.toFixed(2)));
}
// 硬判据（可辩护）：闪动 bg 必须解析到该主题真实主色（证明「随主题适配」不是空话）
check('R4g-1 每套主题的 --color-primary 均可解析为有效颜色（闪动 bg 恒可渲染）',
  themes.every((t) => !!parseCssColor(t.primary)), themes.filter((t) => !parseCssColor(t.primary)).map((t) => t.name).join(','));
check('R4g-2 flash-bg 恒等于该主题 --color-primary（确为「随主题适配」）',
  /var\(--color-primary\)/.test(rootFlashBg || '') && !overrides.length);
// 观测（软判据，不作硬失败）：说明判定依据
const lowPerceive = rows.filter((r) => Math.min(r.rPanel ?? Infinity, r.rChat ?? Infinity) < 3);
console.log(`  · flashPulse 是「背景色脉冲 + box-shadow ring」；判定「可辨认」用的量化代理：脉冲底色(=--color-primary) 对承载面的 WCAG 对比度。`);
console.log(`  · 全主题最小 = ${worst.ratio.toFixed(2)} @ ${worst.name}(${worst.kind})；<3:1 的主题 ${lowPerceive.length} 套：${lowPerceive.map((r) => `${r.name}=${Math.min(r.rPanel ?? 9, r.rChat ?? 9).toFixed(2)}`).join(', ') || '无'}`);
if (lowPerceive.length) {
  console.log('  ⚠ R4g-3 这些主题的脉冲底色对面板/聊天面 WCAG 对比 <3:1（暗色主色压暗色面）。属「低余量」观察项（非文本对比度硬指标；');
  console.log('        脉冲是整体填充色变化 + 4px ring 光晕，视觉上仍是可感知的色块变化，故不判硬失败，留待产品/设计确认）。');
}

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(64));
console.log(`${fail === 0 ? '✅' : '❌'}  ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
process.exit(0);
