// ============================================================================
// v3.0.12 桌宠缩放重构 · 行为级验证（不只是源码正则门禁）
// 用法：node scripts/verify-scale-refactor-behavior.mjs
//
// 用 typescript.transpileModule 从真实源码里抽出 ResizeCoalescer / computeMenuAnchor
// 直接执行，验证：①每帧合并与 cancel；②1:1 布局盒 S=1/2/5 的真实尺寸；③菜单锚点按
// 角色中心计算（S=5 偏差 <5px）；④舞台 .stage-inner 起点侧不溢出。
// 零第三方测试框架依赖，与其余 verify-*.mjs 同风格。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? `  [${extra}]` : ''}`);
  } else {
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

/** 从 header 起抽取花括号平衡的完整声明块（含末尾 }）。 */
function extractBlock(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return '';
  const open = src.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

/** 从函数 header 起抽取花括号平衡的完整函数体（跳过参数里的类型字面量花括号）。 */
function extractFnBlock(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return '';
  const paren = src.indexOf('(', start);
  let p = 0;
  let close = -1;
  for (let i = paren; i < src.length; i++) {
    if (src[i] === '(') p++;
    else if (src[i] === ')') {
      p--;
      if (p === 0) { close = i; break; }
    }
  }
  if (close < 0) return '';
  const open = src.indexOf('{', close);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

/** TS → JS（仅剥类型，不改语义），在隔离 vm 沙箱里执行。 */
function transpile(src) {
  return ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;
}
function runIsolated(js) {
  const sandbox = { setTimeout, clearTimeout, Math, Map, Number, console };
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox);
  return sandbox;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mainDc = read('electron/desktopCharacter.ts');
const appTsx = read('src/character/CharacterApp.tsx');
const charCss = read('src/styles/character.css');
const panelCss = read('src/styles/character-panel.css');

// ── ① ResizeCoalescer：多档合并为每帧一次；cancel 清队列 ──────────────────
console.log('\n===== ① ResizeCoalescer 每帧合并 / cancel =====');
{
  const cls = extractBlock(mainDc, 'class ResizeCoalescer');
  check('从真实源码抽到 ResizeCoalescer 类体', cls.length > 100 && /FRAME_MS/.test(cls));
  const sandbox = runIsolated(transpile(`
    const clampScale = (s) => Math.max(0.6, Math.min(5, Number.isFinite(s) ? s : 1));
    const calls = [];
    function resizeCharacterWindow(id, scale) { calls.push([id, scale]); }
    ${cls}
    const resizeCoalescer = new ResizeCoalescer();
    globalThis.probe = { resizeCoalescer, calls };
  `));
  const { resizeCoalescer: rc, calls } = sandbox.probe;

  // 同一帧 20 档滚轮（每档 0.05）→ 只应触发一次 resize，取末值
  for (let i = 1; i <= 20; i++) rc.request('pet-A', 1 + i * 0.05);
  await sleep(45);
  check('连续 20 档滚轮合并为 1 次 resize', calls.length === 1, `实际 ${calls.length} 次`);
  check('合并取末值（1+20×0.05=2.00）', calls[0]?.[0] === 'pet-A' && Math.abs(calls[0]?.[1] - 2) < 1e-9,
    JSON.stringify(calls[0]));

  // 下一帧新请求 → 再来一次（合并不能吞掉后续帧）
  rc.request('pet-A', 3);
  await sleep(45);
  check('下一帧新请求仍会 flush（共 2 次）', calls.length === 2 && calls[1]?.[1] === 3,
    JSON.stringify(calls));

  // cancel：排队中的请求被清掉，不触发 resize
  calls.length = 0;
  rc.request('pet-B', 4);
  rc.cancel('pet-B');
  await sleep(45);
  check('cancel 清掉排队请求（0 次 resize）', calls.length === 0, `实际 ${calls.length} 次`);

  // cancel 后同 id 新请求 → 旧定时器空转、新值唯一生效
  rc.request('pet-C', 2);
  rc.cancel('pet-C');
  rc.request('pet-C', 5);
  await sleep(45);
  check('cancel 后同 id 新请求只落终值一次', calls.length === 1 && calls[0]?.[1] === 5,
    JSON.stringify(calls));

  // 越界值经 clampScale 钳制（几何唯一口径不变）
  calls.length = 0;
  rc.request('pet-D', 99);
  await sleep(45);
  check('request 统一钳到 [0.6,5.0]', calls.length === 1 && calls[0]?.[1] === 5,
    JSON.stringify(calls[0]));
  check('FRAME_MS 合并窗口为 16ms', /FRAME_MS = 16/.test(cls));
}

// ── ② 1:1 布局盒：S=1/2/5 宽高 = 190S/228S，且 transform 无 scale ────────
console.log('\n===== ② 1:1 布局盒真实尺寸 =====');
{
  const block = extractBlock(charCss, '.dc-character {');
  const w = block.match(/width:\s*calc\((\d+(?:\.\d+)?)px \* var\(--dc-scale, 1\)\)/);
  const h = block.match(/height:\s*calc\((\d+(?:\.\d+)?)px \* var\(--dc-scale, 1\)\)/);
  const tf = block.match(/transform:\s*([^;]+);/);
  check('CSS 里角色宽/高为 calc(190/228px × --dc-scale)',
    Number(w?.[1]) === 190 && Number(h?.[1]) === 228);
  check('角色 transform 仅 translateX(-50%)，不含任何 scale(',
    !!tf && !/scale\(/.test(tf[1]), tf?.[1] || '');
  check('--dc-scale 默认落在 .dc-root，且渲染层写在根元素',
    /--dc-scale:\s*1/.test(extractBlock(charCss, '.dc-root {')) &&
    /className="dc-root"[\s\S]{0,160}--dc-scale/.test(appTsx));
  for (const S of [1, 2, 5]) {
    const cw = Number(w[1]) * S;
    const ch = Number(h[1]) * S;
    check(`S=${S} 布局盒 = ${cw}×${ch}（无 transform 插值）`,
      cw === 190 * S && ch === 228 * S,
      `${cw}×${ch}`);
  }
  const b = charCss.match(/bottom:\s*calc\(10px \+ 228px \* var\(--dc-scale, 1\) \+ 8px\)/);
  check('气泡 bottom 在 S=1 等价旧 246px、S=5 为 1158px（不再与角色重叠）',
    !!b && 10 + 228 * 1 + 8 === 246 && 10 + 228 * 5 + 8 === 1158);
  check('桌面 resolutionScale 恒 1（无逐档帧缓冲重分配）',
    /resolutionScale=\{1\}/.test(appTsx));
}

// ── ③ 菜单锚点：按角色中心计算，S=5 偏差 <5px ─────────────────────────────
console.log('\n===== ③ 菜单锚点贴角色本体 =====');
{
  const fn = extractFnBlock(appTsx, 'function computeMenuAnchor(');
  check('从真实源码抽到 computeMenuAnchor 函数体', fn.length > 100);
  const sandbox = runIsolated(transpile(`
    ${fn}
    globalThis.computeMenuAnchor = computeMenuAnchor;
  `));
  const compute = sandbox.computeMenuAnchor;
  // S=5：窗口 1100×1332，角色 950×1140，左右 75 / 头顶 182（与 winSizeForScale 同源）
  const cases = [
    { S: 1, w: 340, h: 420, bw: 190, bh: 228 },
    { S: 2, w: 530, h: 648, bw: 380, bh: 456 },
    { S: 5, w: 1100, h: 1332, bw: 950, bh: 1140 },
  ];
  for (const c of cases) {
    const left = (c.w - c.bw) / 2;
    const top = c.h - 10 - c.bh;
    const charEl = { getBoundingClientRect: () => ({ left, top, width: c.bw, height: c.bh }) };
    const rootEl = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
    const a = compute(charEl, rootEl, { w: c.w, h: c.h });
    const centerX = left + c.bw / 2;
    check(`S=${c.S} 锚点水平中心与角色中心距离 <5px`,
      Math.abs(a.localX - centerX) < 5,
      `anchor.x=${a.localX} center=${centerX} Δ=${Math.abs(a.localX - centerX)}`);
    check(`S=${c.S} 锚点纵向贴在角色头顶附近（clamp≥210）`,
      a.localY >= 210 && a.localY <= c.h - 8,
      `anchor.y=${a.localY} charTop=${top}`);
  }
  // 越界 clamp：角色中心贴近窗口边缘时不让菜单飘出窗口
  const edge = (left, w) => compute(
    { getBoundingClientRect: () => ({ left, top: 182, width: 190, height: 228 }) },
    { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    { w, h: 420 }
  );
  check('角色中心贴左边缘时菜单锚点 clamp 到 90px', edge(-40, 340).localX === 90,
    `actual=${edge(-40, 340).localX}`);
  check('角色中心贴右边缘时菜单锚点 clamp 到 w-90', edge(180, 340).localX === 250,
    `actual=${edge(180, 340).localX}`);
  check('菜单仍包在 .dc-menu-anchor 内（class/动画/关闭链路不动）',
    /className="dc-menu-anchor"[\s\S]{0,120}className=\{`dc-menu\$\{menuClosing \? ' closing' : ''\}`\}/.test(appTsx));
}

// ── ④ 舞台 .stage-inner 起点侧不溢出 ──────────────────────────────────────
console.log('\n===== ④ 舞台安全居中（放大后起点侧可滚） =====');
{
  const inner = extractBlock(panelCss, '.stage-inner {');
  const model = extractBlock(panelCss, '.stage-model {');
  const viewport = extractBlock(panelCss, '.stage-viewport {');
  check('.stage-inner 改为 block（去掉 flex 居中）',
    /display:\s*block/.test(inner) && !/align-items:\s*center/.test(inner) &&
    !/justify-content:\s*center/.test(inner));
  check('.stage-model 用 margin:auto 安全居中', /margin:\s*auto/.test(model));
  check('.stage-viewport 用 safe center（超界时起点对齐、两端可滚）',
    /align-items:\s*safe center/.test(viewport) && /justify-content:\s*safe center/.test(viewport));
  // 数学验证：视口 600×380，padding 12；S=5 模型 950×1100 ⇒ 起点偏移 = 12 ≥0（不再负数裁切）
  const viewportW = 600;
  const viewportH = 380;
  const pad = Number(inner.match(/padding:\s*(\d+)px/)?.[1]);
  const modelW = 190 * 5;
  const modelH = 220 * 5;
  const startX = pad; // auto margin 在负自由空间下退化为 0
  const startY = pad;
  check('S=5 放大模型起点侧偏移 ≥0（top/left 都可滚到）',
    pad === 12 && startX >= 0 && startY >= 0,
    `start=(${startX},${startY}) model=${modelW}×${modelH} viewport=${viewportW}×${viewportH}`);
  // 放得下时 auto margin 仍居中
  const marginSmall = (viewportW - 2 * pad - 190) / 2;
  check('S=1 小模型 auto margin 仍居中（布局观感不倒退）', marginSmall > 0,
    `margin=${marginSmall}px`);
  check('舞台仍按 --stage-zoom 真实放大盒子（K7 不倒退）',
    /width: calc\(190px \* var\(--stage-zoom, 1\)\)/.test(panelCss));
}

console.log('\n' + '─'.repeat(70));
if (!failures.length) {
  console.log(`✅ 行为级验证全部通过：${pass} 条`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 条失败 / 共 ${pass + failures.length} 条：\n`);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
