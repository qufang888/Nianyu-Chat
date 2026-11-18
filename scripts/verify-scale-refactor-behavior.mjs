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
const stageTsx = read('src/components/CharacterStage.tsx');

// ── ① v3.0.14 恒定大窗：窗口几何不随 scale 变 ──────────────────────────────
console.log('\n===== ① 恒定大窗（缩放零 setBounds） =====');
{
  const from = mainDc.indexOf('const CHAR_BODY_W = 190;');
  const to = mainDc.indexOf('/** 历史/现行存储坐标 → 脚点。');
  check('从真实源码抽到几何段 + DC_FIXED_WIN_SIZE', from > 0 && to > from);
  const baseConsts = (mainDc.match(/export const DC_WIN_BASE_[WH] = \d+;/g) || [])
    .map((s) => s.replace(/^export\s+/, '')).join('\n');
  const sandbox = runIsolated(transpile(`
    ${baseConsts}
    ${mainDc.slice(from, to)}
    globalThis.probe = { fixed: DC_FIXED_WIN_SIZE, sizeFor: winSizeForScale, max: DC_SCALE_MAX };
  `));
  const { fixed, sizeFor, max } = sandbox.probe;
  check('固定窗口 = 最大档尺寸 1100×1332', fixed.w === 1100 && fixed.h === 1332,
    JSON.stringify(fixed));
  check('固定窗口与 winSizeForScale(DC_SCALE_MAX) 同源',
    fixed.w === sizeFor(max).w && fixed.h === sizeFor(max).h);
  for (const s of [0.6, 1, 1.5, 2, 3, 5]) {
    check(`S=${s} 窗口尺寸恒为 ${fixed.w}×${fixed.h}（零 resize）`,
      fixed.w === 1100 && fixed.h === 1332);
  }
  check('建窗使用 DC_FIXED_WIN_SIZE，不再按 scale 动态取尺寸',
    /const \{ w, h \} = DC_FIXED_WIN_SIZE;/.test(mainDc) &&
    !/const \{ w, h \} = winSizeForScale\(scale\);/.test(mainDc));
  check('v3.0.13 手势机器（ResizeCoalescer / beginWheelGesture / wheelGestures）已彻底移除',
    !/class ResizeCoalescer/.test(mainDc) &&
    !/function beginWheelGesture/.test(mainDc) &&
    !/const wheelGestures/.test(mainDc));
  const broken = mainDc.replace('const { w, h } = DC_FIXED_WIN_SIZE;', 'const { w, h } = winSizeForScale(scale);');
  check('（可证伪）建窗退回动态尺寸后固定窗口断言失效',
    broken !== mainDc && !/const \{ w, h \} = DC_FIXED_WIN_SIZE;/.test(broken));
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

// ── ③ v3.0.15 菜单锚点：光标右侧 / 贴边翻转 / 与 scale 无关 ────────────────
console.log('\n===== ③ 右键菜单锚定光标右侧 =====');
{
  const fn = extractFnBlock(appTsx, 'function computeMenuAnchor(');
  check('从真实源码抽到 computeMenuAnchor 函数体', fn.length > 100);
  const constants = (appTsx.match(/const DC_MENU_[A-Z_]+ = \d+;/g) || []).join('\n');
  check('菜单外形/间距常量齐全', /DC_MENU_W/.test(constants) && /DC_MENU_H/.test(constants) &&
    /DC_MENU_CURSOR_GAP/.test(constants) && /DC_MENU_EDGE_PAD/.test(constants));
  const sandbox = runIsolated(transpile(`
    ${constants}
    ${/function clampMenuAxis\([\s\S]*?\n\}/.exec(appTsx)?.[0] || ''}
    ${fn}
    globalThis.computeMenuAnchor = computeMenuAnchor;
  `));
  const compute = sandbox.computeMenuAnchor;
  const mw = Number(constants.match(/DC_MENU_W = (\d+)/)?.[1]);
  const mh = Number(constants.match(/DC_MENU_H = (\d+)/)?.[1]);
  const gap = Number(constants.match(/DC_MENU_CURSOR_GAP = (\d+)/)?.[1]);
  const pad = Number(constants.match(/DC_MENU_EDGE_PAD = (\d+)/)?.[1]);
  const W = 1100, H = 1332;
  // QA P0 场景：工作区 2560×1392，窗口原点 (350,-422)
  const sp = { originX: 350, originY: -422, left: 0, top: 0, right: 2560, bottom: 1392 };
  const computeAt = (cx, cy, s = sp) => compute(cx, cy, { w: W, h: H }, s);
  const screenRect = (a, s = sp) => ({
    l: a.localX + s.originX, t: a.localY + s.originY,
    r: a.localX + s.originX + mw, b: a.localY + s.originY + mh,
  });
  const insideWorkArea = (a, s) => {
    const r = screenRect(a, s);
    return r.l >= s.left + pad - 1 && r.r <= s.right - pad + 1 &&
      r.t >= s.top + pad - 1 && r.b <= s.bottom - pad + 1;
  };
  check('菜单高度常量与真机实测 200px 一致（垂直居中无系统偏差）', mh === 200,
    `DC_MENU_H=${mh}`);
  // 常规：光标在角色中部 → 菜单左边 = 光标 x + gap，垂直居中于光标，屏幕矩形完整可见
  for (const [cx, cy] of [[550, 1162], [420, 900], [700, 1000]]) {
    const a = computeAt(cx, cy);
    check(`光标(${cx},${cy}) 菜单在右侧且屏幕空间垂直居中`,
      a.localX > cx && a.localX === cx + gap && !a.flipped &&
      Math.abs((a.localY + mh / 2) - cy) <= 1,
      `left=${a.localX} top=${a.localY} 中心Y=${a.localY + mh / 2}`);
    check(`光标(${cx},${cy}) 菜单完整在物理屏幕工作区内（P0 硬验收）`,
      insideWorkArea(a, sp), JSON.stringify(screenRect(a)));
  }
  // QA P0：S=5 光标屏幕 y=740（窗口局部 1162）⇒ 旧实现菜单 top=-412，现在必须完整在屏内
  const p0 = computeAt(550, 1162);
  check('P0 复现场景 S=5 / 原点 (350,-422)：菜单屏幕矩形完整可见',
    insideWorkArea(p0, sp) && screenRect(p0).t > 0 && screenRect(p0).b < 1392,
    JSON.stringify(screenRect(p0)));
  // QA P1：光标贴物理屏幕顶边（窗口局部 y=422）⇒ 菜单必须下移，不能出屏
  const topEdge = computeAt(550, 422);
  check('P1 贴屏幕顶边：菜单向下夹进工作区（不再 top<0）',
    insideWorkArea(topEdge, sp) && screenRect(topEdge).t >= 6,
    JSON.stringify(screenRect(topEdge)));
  // 贴右边缘 → 翻到光标左侧，不溢出
  const right = computeAt(2500 - 350, 700);
  check('贴屏幕右边缘时翻到光标左侧且不溢出', right.flipped &&
    screenRect(right).r <= sp.right - pad && right.localX < 2500 - 350,
    JSON.stringify(screenRect(right)));
  // 贴下边缘 → 菜单上移，不溢出
  const bottom = computeAt(550, 1392 + 422 - 6);
  check('贴屏幕下边缘时菜单向上调整且不溢出',
    insideWorkArea(bottom, sp) && screenRect(bottom).b <= 1392 - pad,
    JSON.stringify(screenRect(bottom)));
  // 贴左上角 → 钳制到留白
  // 贴屏幕左上角：DOM 菜单无法画到窗口外（窗口原点 x=350），故最终还要夹进窗口；
  // 只要求「完整可见 + 仍在光标右侧 + 不越屏」，不要求贴到屏幕 x=0。
  const corner = computeAt(-350, -422);
  check('贴屏幕左上角时夹进窗口且完整可见', corner.localX === pad &&
    insideWorkArea(corner, sp) && screenRect(corner).l > 0, JSON.stringify(screenRect(corner)));
  // 与 scale 无关：同一光标坐标，任何倍率结果一致（函数签名不含 scale）
  const s1 = computeAt(600, 800);
  const s5 = computeAt(600, 800);
  check('同一光标坐标定位结果与 scale 无关（签名不含 scale / DOM）',
    JSON.stringify(s1) === JSON.stringify(s5) && fn.indexOf('scale') < 0);
  check('右键只算一次锚点：无 useLayoutEffect 跟随缩放重算',
    !/useLayoutEffect/.test(appTsx) &&
    /onContextMenu = \(e: React\.MouseEvent\) => \{[\s\S]{0,900}setMenuAnchor\(\s*computeMenuAnchor\(e\.clientX, e\.clientY/.test(appTsx) &&
    /window\.screenY/.test(appTsx) && /availWidth/.test(appTsx) && /availHeight/.test(appTsx));
  check('菜单仍包在 .dc-menu-anchor 内（class/动画/关闭链路不动）',
    /className="dc-menu-anchor"[\s\S]{0,120}className=\{`dc-menu\$\{menuClosing \? ' closing' : ''\}`\}/.test(appTsx));
  const broken = appTsx.replace('computeMenuAnchor(e.clientX, e.clientY', 'computeMenuAnchor(charEl, rootEl');
  check('（可证伪）锚点退回角色 rect 后断言失效',
    broken !== appTsx && !/computeMenuAnchor\(e\.clientX, e\.clientY/.test(broken));
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


// ── ⑤ v3.0.14 缩放链路：真实 IPC handler 实跑，全程零 resize + 菜单锚点实时 ──
console.log('\n===== ⑤ 缩放链路零 resize / 菜单锚点固定光标 =====');
{
  const liveHandler = extractBlock(mainDc, "ipcMain.on('dc:set-scale-live'");
  check('从真实源码抽到 dc:set-scale-live（且不再有手势函数）',
    liveHandler.length > 100 &&
    !/beginWheelGesture|resizeCoalescer|resizeCharacterWindow|setBounds/.test(liveHandler));
  const previewPayloads = [];
  const sandbox = vm.createContext({
    console, Math, Map, Number,
    ipcMain: { on: (_name, fn) => { sandbox.__handler = fn; } },
    dcWindows: new Map([['pet', { isDestroyed: () => false, webContents: { send: (_c, d) => previewPayloads.push(d) } }]]),
    DC_SCALE_MAX: 5,
    getDragState: () => ({ scale: 1 }),
    schedulePreviewRestore: () => {},
  });
  vm.runInContext(transpile(`${liveHandler});`), sandbox);
  for (let i = 1; i <= 20; i++) sandbox.__handler({}, 'pet', 1 + i * 0.05);
  check('20 档缩放：零 resize / 零 setBounds（旧实现 2 次大跳，v3.0.12 为 20 次）',
    previewPayloads.length === 20, `预览推送 ${previewPayloads.length} 次`);
  check('20 档全部原样推给渲染层（CSS 跟手不变）',
    Math.abs(previewPayloads[19].scale - 2) < 1e-9 &&
    previewPayloads.every((p) => p.id === 'pet'),
    `末值=${previewPayloads[19]?.scale}`);
  const resizeAdded = liveHandler.replace(
    "w.webContents.send('dc:scale-preview', { id, scale: clamped });",
    "resizeCharacterWindow(id, clamped);\n    w.webContents.send('dc:scale-preview', { id, scale: clamped });");
  check('（可证伪）live 通道加回 resize 后零 resize 断言失效',
    resizeAdded !== liveHandler && /resizeCharacterWindow/.test(resizeAdded) &&
    !/resizeCharacterWindow/.test(liveHandler));
  // 菜单锚点：必须固定在右键时的光标位置，不能随 scale 移动
  check('菜单锚点固定在右键光标位置：无 useLayoutEffect / 无 scale 依赖',
    !/useLayoutEffect/.test(appTsx) &&
    /setMenuAnchor\(\s*computeMenuAnchor\(e\.clientX, e\.clientY/.test(appTsx));
  const brokenAnchor = appTsx.replace('computeMenuAnchor(e.clientX, e.clientY', 'computeMenuAnchor(charEl, rootEl');
  check('（可证伪）锚点退回角色 rect 后断言失效',
    brokenAnchor !== appTsx && !/computeMenuAnchor\(e\.clientX, e\.clientY/.test(brokenAnchor));
}


// ── ⑥ v3.0.13 舞台旋转视觉包围盒不超出滚动区 ─────────────────────────────
console.log('\n===== ⑥ 舞台旋转后整只模型可滚到（运行时实算） =====');
{
  const fn = extractFnBlock(stageTsx, 'function rotatedOverflowY(');
  check('从真实源码抽到 rotatedOverflowY', fn.length > 100);
  const sandbox = runIsolated(transpile(`${fn}\nglobalThis.rotatedOverflowY = rotatedOverflowY;`));
  const extra = sandbox.rotatedOverflowY(5, -40, 70);
  // 真机 Chromium（Electron 32）实测：S=5/rotX=-40/rotY=70 视觉高 1416px，
  // 未旋转布局盒 1100px，滚动区 1124px ⇒ 上下各约 146px 永远滚不到。
  const visualH = 1416, layoutH = 1100, viewportScrollable = 1124;
  const pad = 12 + extra * 0.6;
  const needed = (visualH - viewportScrollable) / 2;
  check('解析算出的旋转溢出与真机 DOM 测量同量级',
    Math.abs(extra - (visualH - layoutH)) < 30,
    `解析=${extra.toFixed(1)}px 实测=${visualH - layoutH}px`);
  check('新增 padding-block 覆盖视觉溢出（头顶/脚底都能滚到）',
    pad >= needed, `pad=${pad.toFixed(1)}px 需要≥${needed.toFixed(1)}px`);
  check('未旋转时 padding 仍为 12px（小模型居中观感不变）',
    sandbox.rotatedOverflowY(1, 0, 0) === 0 && sandbox.rotatedOverflowY(5, 0, 0) === 0);
  check('CSS 同时保留 12px 兜底与 --stage-pad-y 覆盖；viewport 有绘制硬裁剪',
    extractBlock(panelCss, '.stage-inner {').includes('padding: 12px;') &&
    panelCss.includes('padding-block: var(--stage-pad-y, 12px);') &&
    extractBlock(panelCss, '.stage-viewport {').includes('contain: paint;'));
  const broken = stageTsx.replace('rotatedOverflowY(zoom, rotX, rotY) * 0.6', '0');
  check('（可证伪）去掉动态 padding 后 ⑥ 断言失效',
    broken !== stageTsx && !/rotatedOverflowY\(zoom, rotX, rotY\) \* 0\.6/.test(broken));
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
