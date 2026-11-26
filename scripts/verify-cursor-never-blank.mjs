#!/usr/bin/env node
/**
 * verify-cursor-never-blank.mjs — v3.0.23 「动态光标 + 原生光标同时消失」行为闸门
 *
 * 被测故障（用户原话：用着用着动态光标消失，正常光标也不显示）：
 *   covered=true 时渲染端加 GATE_CLASS + NATIVE_HIDDEN_CLASS，合成 mouseout 让引擎隐藏字形；
 *   随后窗口隐藏/重建、covered=false 丢失、拖拽强制结束、焦点切换等路径没有把权威状态
 *   送回渲染端 → gate-off + native-hidden + 引擎 hidden 三态同时成立 → 整机没有光标。
 *
 * 闸门手段：
 *   1) **真执行代码**：用 TypeScript 转译并执行 nativeCursorGuard.ts 的不变量函数、
 *      App.tsx / MiniChat.tsx 的 syncNativeCursorHidden 门控函数、
 *      cursorEngine.ts 的 hideCursorImmediate / enforceNativeCursorFallback 真实方法；
 *   2) **场景驱动**：DOM 桩上跑 covered true→隐藏→再显示、covered=false 丢失、
 *      拖拽强制结束、动态光标开关关闭、焦点切换五条路径，逐断言不变量；
 *   3) **主进程源码闸门**：变化沿缓存作废 / show 重推 / 拖拽重算 / 球窗隐藏不早退。
 *
 * 运行：node scripts/verify-cursor-never-blank.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log('  FAIL  ' + name + (extra ? `  <<< ${extra}` : ''));
  }
}
const section = (title) => console.log('\n=== ' + title + ' ===');

/** 花括号配对抽取函数/方法源码（注释中的括号不进入本仓库被测函数） */
function extractBlock(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}
/** 类方法源码 → 可独立转译的函数声明（TS 会把裸 `foo(): void {` 误判成标签语句） */
function methodToFunction(method) {
  return method.replace(/^(?:private\s+|public\s+|protected\s+)?([A-Za-z_$][\w$]*)\(([^)]*)\)\s*:\s*void\s*\{/, 'function $1($2) {');
}
function transpile(body, fileName = 'snippet.ts') {
  return ts.transpileModule(body, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2020 },
    fileName,
  }).outputText;
}

// ===== 0. 源码与基础设施 =====
const app = read('src/App.tsx');
const mini = read('src/components/MiniChat.tsx');
const guardSrc = read('src/cursor/nativeCursorGuard.ts');
const engineSrc = read('src/cursor/cursorEngine.ts');
const fbMain = read('electron/floatingBall.ts');
const types = read('src/cursor/types.ts');
const coverState = read('electron/cursorCoverState.ts');
const preload = read('electron/preload.ts');
const ipc = read('src/ipc.ts');

console.log('='.repeat(68));
console.log('v3.0.23 双光标消失 BugFix — 行为级闸门（真执行门控函数）');
console.log('='.repeat(68));

section('A. 仲裁基础设施保留（不许删链路换平安）');
check('types.ts 保留 HIDDEN_CLASS / NATIVE_HIDDEN_CLASS / GATE_CLASS',
  /export const HIDDEN_CLASS = 'cursor-hidden';/.test(types) &&
  /export const NATIVE_HIDDEN_CLASS = 'cursor-native-hidden';/.test(types) &&
  /export const GATE_CLASS = 'cursor-gate-off';/.test(types));
check('cursorCoverState.ts 单一真源仍在（computeCoveredState / diffCoverState）',
  /export function computeCoveredState/.test(coverState) && /export function diffCoverState/.test(coverState));
check('preload/ipc 仍导出 covered 与 dragging 通道',
  /onMainCursorWindow/.test(preload) && /onMiniCursorWindow/.test(preload) &&
  /onBallDragging/.test(preload) && /onMainCursorWindow\?/.test(ipc) && /onMiniCursorWindow\?/.test(ipc));
check('主进程光标轮询与变化沿仲裁仍在',
  /setInterval\(\(\) =>/.test(fbMain) && /diffCoverState\(/.test(fbMain));

// ===== 1. 真执行 guard 模块 =====
section('B. 真执行 nativeCursorGuard.ts 的不变量函数');
const guardJs = transpile(
  guardSrc.replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/types';\s*$/m, ''),
  'nativeCursorGuard-snippet.ts'
);
const guardFactory = new Function(
  'GATE_CLASS', 'HIDDEN_CLASS', 'NATIVE_HIDDEN_CLASS',
  `var exports = {};\n${guardJs}\nreturn { hasAuthoritativeGate, isDynamicGlyphVisible, restoreNativeIfNoGlyph, applyCursorNeverBlankGuard, clearAllNativeSuppression };`
);
const G = guardFactory('cursor-gate-off', 'cursor-hidden', 'cursor-native-hidden');
check('guard 模块 5 个函数均可求值',
  ['hasAuthoritativeGate', 'isDynamicGlyphVisible', 'restoreNativeIfNoGlyph', 'applyCursorNeverBlankGuard', 'clearAllNativeSuppression']
    .every((k) => typeof G[k] === 'function'));

/** DOM 桩：classList + 字形宿主（带 style / img），querySelector 与真实 AST 查询同语义 */
function createDom(glyphVisible = false) {
  const set = new Set();
  const host = {
    style: {
      visibility: glyphVisible ? 'visible' : 'hidden',
      display: 'block',
      opacity: glyphVisible ? '1' : '0',
    },
    querySelector: (sel) => (sel === 'img' ? { style: { display: 'block' } } : null),
  };
  return {
    body: {
      classList: {
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        contains: (c) => set.has(c),
      },
      style: { cursor: '' },
    },
    hidden: false,
    querySelector: (sel) => (sel.includes('data-ny-cursor-glyph') ? host : null),
    setGlyphVisible(v) {
      host.style.visibility = v ? 'visible' : 'hidden';
      host.style.opacity = v ? '1' : '0';
    },
    setImgFailed(v) {
      host.querySelector = (sel) => (sel === 'img' ? { style: { display: v ? 'none' : 'block' } } : null);
    },
    set: (c) => set.add(c),
    has: (c) => set.has(c),
    snapshot: () => Array.from(set),
  };
}

{
  const dom = createDom(false);
  dom.set('cursor-gate-off'); dom.set('cursor-native-hidden'); dom.set('cursor-hidden');
  check('权威门控在 → 守卫不解除压制（悬浮球出光标，避免双光标）',
    G.applyCursorNeverBlankGuard(dom, true) === false && dom.has('cursor-native-hidden'));
  dom.body.classList.remove('cursor-gate-off');
  dom.set('cursor-hidden');
  const fixed = G.applyCursorNeverBlankGuard(dom, false);
  check('无门控且无字形 → 守卫解除两层压制并报告已修正',
    fixed === true && !dom.has('cursor-native-hidden') && !dom.has('cursor-hidden'));

  const dom2 = createDom(true);
  dom2.set('cursor-native-hidden');
  check('字形在画 → 守卫不摘压制（杜绝双光标）',
    G.applyCursorNeverBlankGuard(dom2, false) === false && dom2.has('cursor-native-hidden'));
  dom2.setImgFailed(true);
  check('图片彻底加载失败（破图被隐藏）→ 视为无字形并恢复原生',
    G.applyCursorNeverBlankGuard(dom2, false) === true && !dom2.has('cursor-native-hidden'));
}

// ===== 2. 真执行引擎的隐藏与兜底方法 =====
section('C. 真执行 cursorEngine.ts 的 hideCursorImmediate / enforceNativeCursorFallback');
const hideMethod = extractBlock(engineSrc, 'private hideCursorImmediate(): void {');
const fallbackMethod = extractBlock(engineSrc, 'private enforceNativeCursorFallback(): void {');
check('两个引擎方法均可从真实源码抽取', !!hideMethod && !!fallbackMethod);
let engineFactory = null;
if (hideMethod && fallbackMethod) {
  engineFactory = new Function(
    'document', 'HIDDEN_CLASS', 'NATIVE_HIDDEN_CLASS', 'GATE_CLASS', 'OFFSCREEN', 'restoreNativeIfNoGlyph',
    `${transpile(
      `${methodToFunction(hideMethod)}\n${methodToFunction(fallbackMethod)}\nreturn { hideCursorImmediate, enforceNativeCursorFallback };`,
      'engine-snippet.ts'
    )}`
  );
}

function createEngine(dom) {
  let factoryCalls = 0;
  const e = {
    elements: {}, cfg: { enabled: true },
    pointerX: 12, pointerY: 12, prevPointerX: 12, prevPointerY: 12,
    inside: true, hidden: false, edgeNative: false, imgFailed: false,
    fadeState: 'none', opacity: 1, idleTimer: 0,
    cancelIdleHide() {}, resetParticles() {}, clearFx() {}, refreshGlyphVisibility() {}, stopLoop() {},
    hasRenderableGlyph() {
      return this.cfg.enabled && !this.hidden && !this.edgeNative && !this.imgFailed &&
        !dom.has('cursor-gate-off') && this.fadeState === 'none' && this.opacity > 0.001 && this.pointerX > -9000;
    },
  };
  if (engineFactory) {
    const methods = engineFactory(dom, 'cursor-hidden', 'cursor-native-hidden', 'cursor-gate-off', -9000, G.restoreNativeIfNoGlyph);
    e.hideCursorImmediate = methods.hideCursorImmediate.bind(e);
    e.enforceNativeCursorFallback = methods.enforceNativeCursorFallback.bind(e);
    factoryCalls = 1;
  }
  Object.defineProperty(e, 'compiled', { value: factoryCalls === 1 });
  return e;
}
{
  const dom = createDom(true);
  dom.set('cursor-hidden'); dom.set('cursor-native-hidden');
  const engine = createEngine(dom);
  engine.hideCursorImmediate();
  check('真实 hideCursorImmediate 摘掉 HIDDEN_CLASS（保证鼠标移出即恢复原生）',
    engine.hidden === true && !dom.has('cursor-hidden'), dom.snapshot().join(','));
}

// ===== 3. 真执行 App / MiniChat 门控函数 =====
section('D. 真执行主窗/小窗 syncNativeCursorHidden 门控');
function compileGate(src) {
  const fn = extractBlock(src, 'function syncNativeCursorHidden(): void {');
  if (!fn) return null;
  return new Function(
    'cursorEnabledRef', 'coveredRef', 'ballDraggingRef', 'document', 'NATIVE_HIDDEN_CLASS',
    `${transpile(`${fn}\nreturn syncNativeCursorHidden;`, 'gate-snippet.ts')}`
  );
}
const appGate = compileGate(app);
const miniGate = compileGate(mini);
check('主窗/小窗门控函数均可独立求值', typeof appGate === 'function' && typeof miniGate === 'function');

// ===== 4. 场景驱动：八类路径的逐状态不变量 =====
section('E. 场景闸门（关键：任何状态都不得三态同时成立）');
function runScenario(name, factory, gates) {
  const dom = createDom(true);
  const engine = createEngine(dom);
  const refs = { enabled: true, covered: false, dragging: false };
  const delivered = [];
  const state = { dom, engine, refs, delivered, steps: [] };
  const sync = () => {
    for (const gate of gates) {
      gate({ current: refs.enabled }, { current: refs.covered }, { current: refs.dragging }, dom, 'cursor-native-hidden')();
    }
    // 真执行引擎引擎侧不变量（对应 1s 巡检 / focus / visibility 回调）
    engine.enforceNativeCursorFallback();
  };
  const coveredEvent = (v) => {
    refs.covered = v;
    if (v) {
      dom.set('cursor-gate-off');
      // 合成 mouseout 真实语义：inside=false 时被引擎忽略；强制事件才一定生效
      if (engine.inside) engine.hideCursorImmediate();
      engine.hideCursorImmediate();
    } else dom.body.classList.remove('cursor-gate-off');
    sync();
    delivered.push(`covered:${v}`);
  };
  const dragEvent = (v) => {
    refs.dragging = v;
    if (v) dom.set('cursor-gate-off');
    else dom.body.classList.remove('cursor-gate-off');
    sync();
    delivered.push(`dragging:${v}`);
  };
  const hideWindow = () => {
    dom.hidden = true;
    // 渲染端 visibilitychange hidden 分支：清权威残留 + 统一函数 + 不变量守卫（真实代码见源码闸门）
    refs.covered = false; refs.dragging = false;
    dom.body.classList.remove('cursor-gate-off');
    for (const gate of gates) {
      gate({ current: refs.enabled }, { current: refs.covered }, { current: refs.dragging }, dom, 'cursor-native-hidden')();
    }
    G.clearAllNativeSuppression(dom);
    sync();
  };
  const showWindow = (authoritativeCovered) => {
    dom.hidden = false;
    // 主进程 show 沿重推权威电平（electron/floatingBall.ts 的 resyncCoveredOnWindowShow）
    coveredEvent(authoritativeCovered);
    if (!authoritativeCovered) dom.setGlyphVisible(true);
    sync();
  };
  const toggleEnabled = (v) => {
    refs.enabled = v;
    if (!v) {
      dom.body.classList.remove('cursor-gate-off');
      G.clearAllNativeSuppression(dom);
      engine.cfg.enabled = false;
      engine.hidden = true;
    } else {
      engine.cfg.enabled = true;
      dom.setGlyphVisible(true);
    }
    sync();
  };
  const focusSwitch = () => {
    // 失焦 → 引擎隐藏字形；回到窗口 → 主进程 covered 权威重推 false
    engine.hidden = true;
    engine.enforceNativeCursorFallback();
    dom.set('cursor-native-hidden'); // 模拟陈旧压制层
    sync();
    dom.body.classList.remove('cursor-gate-off');
    sync();
  };
  const assertInvariant = (label) => {
    const gateOff = !dom.has('cursor-gate-off');
    const nativeHidden = dom.has('cursor-native-hidden') || dom.has('cursor-hidden');
    const engineHidden = engine.hidden;
    const triple = gateOff && nativeHidden && engineHidden;
    const staleGate = !gateOff && !refs.covered && !refs.dragging;
    state.steps.push({ label, gateOff, nativeHidden, engineHidden, triple, staleGate, classes: dom.snapshot() });
    check(`${name} / ${label}：无三态残留`, !triple, dom.snapshot().join(','));
    check(`${name} / ${label}：无陈旧门控`, !staleGate);
  };
  factory({ coveredEvent, dragEvent, hideWindow, showWindow, toggleEnabled, focusSwitch, assertInvariant, state });
  return state;
}

if (typeof appGate === 'function' && typeof miniGate === 'function') {
  for (const [label, gate] of [['主窗', appGate], ['小窗', miniGate]]) {
    runScenario(`${label} covered true→窗口隐藏→窗口再显示`, ({ coveredEvent, hideWindow, showWindow, assertInvariant }) => {
      coveredEvent(true); assertInvariant('覆盖中');
      hideWindow(); assertInvariant('窗口隐藏');
      showWindow(false); assertInvariant('窗口再显示（权威 false）');
    }, [gate]);

    runScenario(`${label} covered true→false 丢失`, ({ coveredEvent, state, assertInvariant }) => {
      coveredEvent(true); assertInvariant('覆盖中');
      // 主进程推送丢失：渲染端只靠 1s 巡检 / 守卫自愈
      state.dom.body.classList.remove('cursor-gate-off');
      state.engine.enforceNativeCursorFallback();
      G.applyCursorNeverBlankGuard(state.dom, false);
      assertInvariant('covered=false 丢失后自愈');
    }, [gate]);

    runScenario(`${label} 拖拽强制结束`, ({ dragEvent, assertInvariant }) => {
      dragEvent(true); assertInvariant('拖拽中');
      dragEvent(false); assertInvariant('强制结束');
      assertInvariant('强制结束后再巡检');
    }, [gate]);

    runScenario(`${label} 动态光标开关关闭`, ({ coveredEvent, toggleEnabled, assertInvariant }) => {
      coveredEvent(true); assertInvariant('覆盖中');
      toggleEnabled(false); assertInvariant('开关关闭');
      toggleEnabled(true); assertInvariant('开关再开启');
    }, [gate]);

    runScenario(`${label} 焦点切换`, ({ focusSwitch, assertInvariant }) => {
      focusSwitch(); assertInvariant('失焦再聚焦');
    }, [gate]);
  }
}

// ===== 5. 主进程修复源码闸门（变更沿缓存 / show 重推 / 拖拽重算 / 球窗隐藏不早退）=====
section('F. 主进程：权威状态不再丢失');
const pushFn = extractBlock(fbMain, 'function pushCoveredNow(): void {') || '';
check('pushCoveredNow 存在且仍用 diffCoverState 变化沿', /diffCoverState\(/.test(pushFn));
check('推送失败（窗口隐藏/销毁）时主窗缓存作废为 null',
  /lastMainCovered = null;/.test(pushFn), '删除该行 → covered 陈旧残留 → 闸门变红');
check('推送失败（窗口隐藏/销毁）时小窗缓存作废为 null',
  /lastMiniWindowCovered = null;/.test(pushFn));
const resyncFn = extractBlock(fbMain, 'export function resyncCoveredOnWindowShow(') || '';
check('show/restore/focus 沿主动重推权威 covered',
  /resyncCoveredOnWindowShow/.test(fbMain) && /lastMainCovered = null;/.test(resyncFn) && /pushCoveredNow\(\);/.test(resyncFn));
check('主窗/小窗引用注入时挂生命周期监听',
  /attachCoveredResync\(win, 'main'\)/.test(fbMain) && /attachCoveredResync\(win, 'mini'\)/.test(fbMain) &&
  /win\.on\('show', handler\)/.test(fbMain) && /win\.on\('focus', handler\)/.test(fbMain));
const finishDragFn = extractBlock(fbMain, 'function finishDrag(): void {') || '';
check('拖拽强制结束与正常结束汇入同一个 finishDrag',
  /ipcMain\.handle\('ball:drag-end'[\s\S]{0,160}?finishDrag\(\)/.test(fbMain) &&
  /dragLostTicks > DRAG_LOST_TICKS[\s\S]{0,400}?finishDrag\(\)/.test(fbMain));
check('finishDrag 清缓存并重推 covered（拖拽期 owner=ball 的陈旧 true 必被纠正）',
  /lastMainCovered = null;/.test(finishDragFn) && /pushCoveredNow\(\);/.test(finishDragFn));
const pollFn = extractBlock(fbMain, 'function startCursorPoll(): void {') || '';
check('球窗隐藏时轮询不再整体早退（只销毁才停摆）',
  /const ballAlive =/.test(pollFn) && /if \(!ballAlive\) return;/.test(pollFn) &&
  !/isVisible\(\)\) return;/.test(pollFn));
check('菜单矩形带 isVisible 守卫（隐藏菜单不参与 owner 判定）',
  /menuWindow\.isVisible\(\)/.test(fbMain));
check('hideFloatingBall / showFloatingBall 都重推 covered',
  (fbMain.match(/lastMainCovered = null;/g) || []).length >= 5);

// ===== 6. 渲染端「最后一道防线」接线闸门 =====
section('G. 渲染端不变量接线');
for (const [label, src] of [['主窗', app], ['小窗', mini]]) {
  check(`${label} 保留统一门控函数与 dragged ref`,
    /function syncNativeCursorHidden\(\): void/.test(src) && /ballDraggingRef/.test(src));
  check(`${label} covered=true 与拖拽开始都派发无条件强制隐藏事件（mouseout 兜底）`,
    (src.match(/dispatchEvent\(new Event\(CURSOR_FORCE_HIDE_EVENT\)\)/g) || []).length >= 2 &&
    /dispatchEvent\(new MouseEvent\('mouseout'\)\)/.test(src));
  check(`${label} covered/dragging 回调都调用不变量守卫`,
    (src.match(/applyCursorNeverBlankGuard\(document,/g) || []).length >= 3);
  check(`${label} 窗口隐藏时清权威残留（stale gate 自愈）`,
    /if \(document\.hidden\) releaseStaleSuppression\(\)/.test(src));
  check(`${label} 动态光标关闭时两层压制无条件解除`,
    /clearAllNativeSuppression\(document\)/.test(src));
  check(`${label} 拖拽期 gate 与压制层成对升降`,
    /if \(dragging\)[\s\S]{0,120}?document\.body\.classList\.add\(GATE_CLASS\)/.test(src) &&
    /else document\.body\.classList\.remove\(GATE_CLASS\)/.test(src));
  check(`${label} 拖拽开始也派发强制隐藏（杜绝冻结字形 + 球窗字形双现）`,
    /if \(dragging\) \{[\s\S]{0,200}?dispatchEvent\(new Event\(CURSOR_FORCE_HIDE_EVENT\)\)/.test(src));
}
check('引擎挂载时门控已成立则不再加 HIDDEN_CLASS',
  /if \(!this\.isGated\(\)\) document\.body\.classList\.add\(HIDDEN_CLASS\);[\s\S]{0,160}?this\.startLoop\(\);/.test(engineSrc));
check('引擎 unmount / 关闭时无条件清两层压制',
  /clearAllNativeSuppression\(document\)/.test(engineSrc) &&
  (engineSrc.match(/clearAllNativeSuppression\(document\)/g) || []).length >= 2);
check('引擎有 1s 最后一道防线巡检',
  /setInterval\(\(\) => this\.enforceNativeCursorFallback\(\), NATIVE_GUARD_INTERVAL_MS\)/.test(engineSrc));
check('引擎监听强制隐藏事件并解绑',
  /addEventListener\(CURSOR_FORCE_HIDE_EVENT, this\.onForceHide\)/.test(engineSrc) &&
  /removeEventListener\(CURSOR_FORCE_HIDE_EVENT, this\.onForceHide\)/.test(engineSrc));
check('字形宿主带守卫查询标记', /data-ny-cursor-glyph="1"/.test(read('src/cursor/DynamicCursor.tsx')));
check('球/面板窗取消门控时同步兜底',
  /dispatchEvent\(new Event\(CURSOR_FORCE_HIDE_EVENT\)\)/.test(read('src/floating-ball.ts')));

console.log('\n' + '='.repeat(68));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
