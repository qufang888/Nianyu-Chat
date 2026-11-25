#!/usr/bin/env node
/**
 * verify-drag-cursor-gate.mjs — v3.0.22 拖球双光标闪烁回归闸门
 *
 * 故障链：拖球时球窗每 16ms 被 safeSetPosition 移动，主进程 200ms 轮询算出的
 * main/mini 覆盖关系随窗口边界反复跳变 → covered true/false 交替 → 主窗/小窗的
 * `cursor-native-hidden` 压制层一加一删 → 原生光标与悬浮球动态光标同时出现且闪烁。
 *
 * 修复：drag-start/finishDrag 复用既有 `ball:dragging` 通道向 main/mini/panel 三窗
 * 广播整段拖拽电平；主窗/小窗用唯一门控函数 `cursorEnabled && (covered || dragging)`
 * 驱动压制层；球/面板三条拖拽收尾路径按 dynCursorEnabled 同步压制层。
 *
 * 本脚本同时做源码级强断言与**行为级真值表执行**（真的转译并执行两处门控函数），
 * 任何一处广播/订阅/取或逻辑被删改都会变红。
 *
 * 运行：node scripts/verify-drag-cursor-gate.mjs
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

/** 按花括号配对抽出源码中的函数声明（含注释里的括号不会进入本仓库的这些函数） */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
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

/** 转译并执行门控函数，返回可对 (enabled, covered, dragging) 求值的函数 */
function compileGate(src) {
  const fn = extractFunction(src, 'syncNativeCursorHidden');
  if (!fn) return null;
  const js = ts.transpileModule(`${fn}\nreturn syncNativeCursorHidden;\n`, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2020 },
    fileName: 'drag-cursor-gate-snippet.ts',
  }).outputText;
  // eslint-disable-next-line no-new-func
  return new Function(
    'cursorEnabledRef',
    'coveredRef',
    'ballDraggingRef',
    'document',
    'NATIVE_HIDDEN_CLASS',
    js
  );
}

const fbMain = read('electron/floatingBall.ts');
const fbRender = read('src/floating-ball.ts');
const preload = read('electron/preload.ts');
const app = read('src/App.tsx');
const mini = read('src/components/MiniChat.tsx');
const types = read('src/cursor/types.ts');

console.log('='.repeat(64));
console.log('v3.0.22 拖球期间常驻压制原生光标 — 行为/源码双闸门');
console.log('='.repeat(64));

section('A. 主进程：drag-start / finishDrag 向三窗成对广播 ball:dragging');
const startIdx = fbMain.indexOf("ipcMain.on('ball:drag-start'");
const finishIdx = fbMain.indexOf('function finishDrag(): void {');
const endIdx = fbMain.indexOf("ipcMain.handle('ball:drag-end'");
check('源码中存在 ball:drag-start / finishDrag / ball:drag-end',
  startIdx >= 0 && finishIdx > startIdx && endIdx > finishIdx);
const startSection = startIdx >= 0 && finishIdx > startIdx ? fbMain.slice(startIdx, finishIdx) : '';
const finishSection = finishIdx >= 0 && endIdx > finishIdx ? fbMain.slice(finishIdx, endIdx) : '';

check('drag-start 向面板窗广播 true（既有链路保留）',
  /panelWindow\.webContents\.send\('ball:dragging', true\)/.test(startSection));
check('drag-start 向主窗广播 true（本次修复新增）',
  /mainWinRef\.webContents\.send\('ball:dragging', true\)/.test(startSection));
check('drag-start 向小窗广播 true（本次修复新增）',
  /miniWinRef\.webContents\.send\('ball:dragging', true\)/.test(startSection));
check('drag-start 三窗广播均带判空/销毁守卫',
  (startSection.match(/!\w+\.isDestroyed\(\)/g) || []).length >= 3);
check('drag-start 每 tick 仍经 safeSetPosition 移动窗口（闪烁根因链路未改）',
  /safeSetPosition\(ballWindow/.test(startSection));

check('finishDrag 向面板窗广播 false（既有链路保留）',
  /panelWindow\.webContents\.send\('ball:dragging', false\)/.test(finishSection));
check('finishDrag 向主窗广播 false（本次修复新增）',
  /mainWinRef\.webContents\.send\('ball:dragging', false\)/.test(finishSection));
check('finishDrag 向小窗广播 false（本次修复新增）',
  /miniWinRef\.webContents\.send\('ball:dragging', false\)/.test(finishSection));
check('finishDrag 三窗广播均带判空/销毁守卫',
  (finishSection.match(/!\w+\.isDestroyed\(\)/g) || []).length >= 3);
check('正常 drag-end 与 mouseup 丢失自愈都汇入 finishDrag（退出路径不漏）',
  /ipcMain\.handle\('ball:drag-end'[\s\S]{0,120}?finishDrag\(\)/.test(fbMain) &&
  /dragLostTicks > DRAG_LOST_TICKS[\s\S]{0,300}?finishDrag\(\)/.test(fbMain));

section('B. 通道复用：不新增 IPC，preload 既有 onBallDragging 原样保留');
check('preload 类型声明 onBallDragging',
  /onBallDragging: \(cb: \(dragging: boolean\) => void\)/.test(preload));
check('preload 监听 ball:dragging 并返回退订函数',
  /ipcRenderer\.on\('ball:dragging', listener\)/.test(preload) &&
  /ipcRenderer\.removeListener\('ball:dragging', listener\)/.test(preload));
check('渲染层契约声明 onBallDragging（走 ...raw 透传，无需新增实现）',
  /onBallDragging\?: \(cb: \(dragging: boolean\) => void\) => \(\) => void;/.test(read('src/ipc.ts')));
check('NATIVE_HIDDEN_CLASS 仍来自 cursor/types.ts 单一真源',
  /export const NATIVE_HIDDEN_CLASS = 'cursor-native-hidden';/.test(types));

section('C. 主窗/小窗：订阅拖拽门 + 统一函数 + 完整退订 + 行为真值表');
for (const [label, src, channel] of [
  ['主窗 App.tsx', app, 'onMainCursorWindow'],
  ['小窗 MiniChat.tsx', mini, 'onMiniCursorWindow'],
]) {
  check(`${label} 保留原覆盖通道 ${channel}`, new RegExp(`api\\.${channel}\\(`).test(src));
  check(`${label} 订阅 api.onBallDragging`,
    /api\.onBallDragging\(\(dragging: boolean\) => \{/.test(src));
  check(`${label} covered 回调更新 coveredRef 后走统一函数`,
    /coveredRef\.current = covered;[\s\S]{0,400}?syncNativeCursorHidden\(\)/.test(src));
  check(`${label} dragging 回调更新 ballDraggingRef 后走统一函数`,
    /ballDraggingRef\.current = dragging;[\s\S]{0,200}?syncNativeCursorHidden\(\)/.test(src));
  check(`${label} cleanup 同时退订覆盖通道与拖拽通道`,
    /return \(\) => \{[\s\S]{0,200}?offCovered\(\);[\s\S]{0,200}?offDragging\(\);/.test(src));
  check(`${label} 合成 mouseout 链路保留（引擎字形仍立即隐藏）`,
    /document\.dispatchEvent\(new MouseEvent\('mouseout'\)\)/.test(src));
  check(`${label} 压制层只在统一函数里添加（无散落的直接 add）`,
    (src.match(/classList\.add\(NATIVE_HIDDEN_CLASS\)/g) || []).length === 1);
  check(`${label} 动态光标开关变化时经统一函数重算`,
    /useEffect\(\(\) => \{\s*syncNativeCursorHidden\(\);/.test(src));

  // 行为级：转译并执行真实门控函数，覆盖全部 8 种输入组合
  const factory = compileGate(src);
  check(`${label} 门控函数可被独立求值`, typeof factory === 'function');
  if (typeof factory === 'function') {
    const set = new Set();
    const doc = {
      body: {
        classList: {
          add: (c) => set.add(c),
          remove: (c) => set.delete(c),
          contains: (c) => set.has(c),
        },
      },
    };
    for (const enabled of [false, true]) {
      for (const covered of [false, true]) {
        for (const dragging of [false, true]) {
          set.clear();
          const sync = factory({ current: enabled }, { current: covered }, { current: dragging }, doc, 'cursor-native-hidden');
          sync();
          const expected = enabled && (covered || dragging);
          const combo = `enabled=${enabled}/covered=${covered}/dragging=${dragging}`;
          check(`${label} 真值表 ${combo}`,
            set.has('cursor-native-hidden') === expected,
            expected ? '应压制原生光标' : '不得压制原生光标');
        }
      }
    }
  }
}

section('D. 球/面板渲染端：三条拖拽路径都按 dynCursorEnabled 同步压制层');
const mousedownIdx = fbRender.indexOf("ball.addEventListener('mousedown'");
const onUpIdx = fbRender.indexOf('function onUp(): void {');
const forceIdx = fbRender.indexOf('api.onBallDragForceEnd(');
const panelIdx = fbRender.indexOf('function mountPanel(): void {');
check('球窗 mousedown / onUp / onBallDragForceEnd 与面板挂载点均存在',
  mousedownIdx >= 0 && onUpIdx > mousedownIdx && forceIdx > onUpIdx && panelIdx > forceIdx);
const near = (from, to, size) => (from >= 0 ? fbRender.slice(from, to > from ? Math.min(to, from + size) : from + size) : '');
const downSection = near(mousedownIdx, onUpIdx, 900);
const upSection = near(onUpIdx, forceIdx, 900);
const forceSection = near(forceIdx, panelIdx, 900);
const setupSection = near(fbRender.indexOf('function setupCursorEnabled(): void {'), fbRender.indexOf('const BALL = 60;'), 1200);

check('mousedown 开始拖拽即同步压制层',
  /classList\.toggle\(NATIVE_HIDDEN_CLASS, dynCursorEnabled\)/.test(downSection));
check('onUp 正常结束同步压制层',
  /classList\.toggle\(NATIVE_HIDDEN_CLASS, dynCursorEnabled\)/.test(upSection));
check('onBallDragForceEnd 强制结束同步压制层',
  /classList\.toggle\(NATIVE_HIDDEN_CLASS, dynCursorEnabled\)/.test(forceSection));
check('setupCursorEnabled 也由 dynCursorEnabled 常驻切换',
  /classList\.toggle\(NATIVE_HIDDEN_CLASS, dynCursorEnabled\)/.test(setupSection));
check('球/面板窗不存在无条件 add(NATIVE_HIDDEN_CLASS)（动态光标关时不残留）',
  !/classList\.add\(NATIVE_HIDDEN_CLASS\)/.test(fbRender));
check('所有压制层切换都以 dynCursorEnabled 为条件（至少 4 处）',
  (fbRender.match(/classList\.toggle\(NATIVE_HIDDEN_CLASS, dynCursorEnabled\)/g) || []).length >= 4);
check('面板窗既有 ball:dragging 门控 + 合成 mouseout 未回退',
  /api\.onBallDragging\(/.test(fbRender) && /suppressPanelCursor/.test(fbRender));

console.log('\n' + '='.repeat(64));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
