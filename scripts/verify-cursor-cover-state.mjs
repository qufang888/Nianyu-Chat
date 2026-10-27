#!/usr/bin/env node
/**
 * verify-cursor-cover-state.mjs
 * ---------------------------------------------------------------------------
 * 动态光标「覆盖关系（covered）」**行为**闸门（v2.3.126 QA 打回 P1 的回归防线）。
 *
 * 背景：此前 scripts/verify-launch-cursor.mjs 全是源码正则匹配，**不验证运行时行为**——
 * P1「covered 状态 5Hz 永久振荡」正是在它 50/0 全绿的情况下漏过去的：
 *   pushCoveredNow() 无条件 send('main:cursor-window', true) 并把缓存写成 true，
 *   而 200ms 轮询算的是 `owner!=='main' && inMainNow`（光标在面板内、主窗矩形不含该点
 *   → false）→ 「推 true → 下轮推 false → hover 再推 true」无限循环 → 主窗/小窗动态光标
 *   反复被隐藏 → 肉眼可见的闪烁。
 *
 * 本脚本的关键设计：**真的执行被测代码的判定逻辑**，而不是在脚本里复刻一份。
 * 做法：把覆盖关系判定抽成纯函数模块 electron/cursorCoverState.ts（零 Electron 依赖），
 * 用本地 typescript 转译后直接求值执行 —— 脚本驱动的是**主进程正在用的同一份代码**。
 * 同时对 electron/floatingBall.ts 做源码级断言（确保主进程确实调用了这套共享逻辑、
 * 且没有残留「无条件推 true」），这样「把 pushCoveredNow 改回无条件推 true」时本脚本必 FAIL。
 *
 * 运行：node scripts/verify-cursor-cover-state.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { console.log(`  PASS  ${msg}`); pass++; }
  else { console.log(`  FAIL  ${msg}`); fail++; }
};

// ============================================================================
// 1. 加载被测代码：转译并执行 electron/cursorCoverState.ts（真实判定逻辑）
// ============================================================================
console.log('=== 1. 加载被测代码（electron/cursorCoverState.ts）===');

let api = null;
try {
  const ts = require('typescript');
  const source = read('electron/cursorCoverState.ts');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: 'cursorCoverState.ts',
  }).outputText;
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(
    mod.exports, require, mod, 'cursorCoverState.ts', root
  );
  api = mod.exports;
  ok(!!api && typeof api.computeCoveredState === 'function' && typeof api.diffCoverState === 'function',
    '成功转译并执行被测模块（computeCoveredState / diffCoverState 可用）');
  ok(typeof api.computePanelInteractive === 'function' && typeof api.computeOwner === 'function',
    '面板可交互态判定（computePanelInteractive）与 owner 判定（computeOwner）可用');
} catch (e) {
  ok(false, `加载被测模块失败：${e.message}`);
}

if (!api) {
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}

const { computeCoveredState, computeOwner, diffCoverState, computePanelInteractive, insetRect, PANEL_PAD, PANEL_INTERACTIVE_HYSTERESIS, BALL_PAD } = api;

// ============================================================================
// 2. 几何常量一致性（跨文件：主进程 / 渲染端 / 被测模块必须同源）
// ============================================================================
console.log('=== 2. 几何常量跨文件一致性 ===');
const renderer = read('src/floating-ball.ts');
const mainProc = read('electron/floatingBall.ts');
const mRendererPad = renderer.match(/const PANEL_PAD\s*=\s*(\d+)/);
ok(!!mRendererPad && Number(mRendererPad[1]) === PANEL_PAD,
  `PANEL_PAD 一致：被测模块 ${PANEL_PAD} / 渲染端 ${mRendererPad ? mRendererPad[1] : '未找到'}`);
ok(/PANEL_PAD,/.test(mainProc) && /from '\.\/cursorCoverState'/.test(mainProc),
  '主进程从被测模块导入 PANEL_PAD（不另写常量）');
ok(PANEL_INTERACTIVE_HYSTERESIS === 3, `面板可交互态迟滞 = ${PANEL_INTERACTIVE_HYSTERESIS}px（规格要求 3px）`);
// v2.3.126（收口）：BALL_PAD 必须三处同源 —— 共享模块 / 主进程（从模块导入）/ 渲染端 BALL_L·BALL_T
const mRendererBallPad = renderer.match(/const BALL_L\s*=\s*(\d+)/);
ok(BALL_PAD === 4, `共享模块 BALL_PAD = ${BALL_PAD}（球 DOM 内边距应为 4）`);
ok(!!mRendererBallPad && Number(mRendererBallPad[1]) === BALL_PAD,
  `渲染端 BALL_L/BALL_T = ${mRendererBallPad ? mRendererBallPad[1] : '未找到'} 与共享模块一致`);
ok(/BALL_PAD,/.test(mainProc) && !/const BALL_PAD = \d/.test(mainProc),
  '主进程 BALL_PAD 改从共享模块导入（不再另写常量，杜绝三处漂移）');

// ============================================================================
// 3. 仿真场景：光标停在面板内、主窗矩形不含该点（QA 复现 P1 的场景）
// ============================================================================
// 面板窗 320x460 @ (100,300) → 不透明命中区 = inset 14 → (114,314,292,432)
// 光标 (200,500) 落在不透明区内；主窗矩形 (0,0,800,200) **不含**该点。
const PANEL_WINDOW = { x: 100, y: 300, width: 320, height: 460 };
const PANEL_OPAQUE = insetRect(PANEL_WINDOW, PANEL_PAD);
const BALL_RECT = { x: 40, y: 250, width: 68, height: 68 };
const MAIN_RECT_NO_CURSOR = { x: 0, y: 0, width: 800, height: 200 };
const CURSOR_IN_PANEL = { x: 200, y: 500 };

/** 模拟主进程的推送纪律：每次「推」都现算 + 变化沿 + 缓存写实际推的值 */
function simulatePushDiscipline({ legacy = false, rounds = 12 } = {}) {
  const received = [];
  let lastMain = null;
  let lastMini = null;
  let hoverPanel = false;

  const push = () => {
    if (legacy) {
      // 旧实现（P1 根因）：hover 沿**无条件**推 true 并把缓存写成 true
      pushLegacyHover();
      return;
    }
    const next = computeCoveredState({
      cursorX: CURSOR_IN_PANEL.x,
      cursorY: CURSOR_IN_PANEL.y,
      ballRect: BALL_RECT,
      menuRect: null,
      panelRect: PANEL_OPAQUE,
      mainRect: MAIN_RECT_NO_CURSOR,
      miniRect: null,
      dragging: false,
    });
    const diff = diffCoverState(
      { main: lastMain, mini: lastMini },
      { main: next.main, mini: next.mini }
    );
    if (diff.main !== undefined) {
      lastMain = diff.main;
      received.push(diff.main);
    }
  };

  /** 旧实现的 hover 沿：无条件推 true 并把缓存写成 true（P1 根因） */
  const pushLegacyHover = () => {
    received.push(true);
    lastMain = true;
    lastMini = true;
  };

  /** 旧实现的 200ms 轮询：谓词本身是对的（算 false），但缓存被 hover 沿写成了 true → 推 false */  const pushLegacyPoll = () => {
    const next = computeCoveredState({
      cursorX: CURSOR_IN_PANEL.x,
      cursorY: CURSOR_IN_PANEL.y,
      ballRect: BALL_RECT,
      menuRect: null,
      panelRect: PANEL_OPAQUE,
      mainRect: MAIN_RECT_NO_CURSOR,
      miniRect: null,
      dragging: false,
    });
    if (next.main !== lastMain) {
      lastMain = next.main;
      received.push(next.main);
    }
    if (next.mini !== lastMini) {
      lastMini = next.mini;
      received.push(next.mini);
    }
  };

  for (let i = 0; i < rounds; i++) {
    // 每 100ms 一次 hoverPanel(true)（渲染端 document mousemove 节流 100ms）
    // 旧实现：**没有上升沿守卫** → 每次上报都 pushCoveredNow()（规格指出的放大器）；
    // 新实现：只有上升沿（false→true）才推。
    const rising = !hoverPanel;
    hoverPanel = true;
    if (legacy) pushLegacyHover();
    else if (rising) push();
    // 每 200ms 一次轮询
    if (legacy) pushLegacyPoll();
    else push();
  }
  return received;
}

/** 统计序列中的翻转次数（相邻值不同即计一次） */
function countTransitions(seq) {
  let t = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) t++;
  return t;
}

console.log('=== 3. P1 回归仿真：光标停在面板内、主窗矩形不含该点（12 轮）===');
const seqNew = simulatePushDiscipline({ legacy: false, rounds: 12 });
const seqLegacy = simulatePushDiscipline({ legacy: true, rounds: 12 });
console.log(`  · 新实现（现算 + 变化沿 + 上升沿守卫）主窗收到的 covered 序列 = [${seqNew.join(', ')}]`);
console.log(`  · 旧实现（无条件推 true）主窗收到的 covered 序列 = [${seqLegacy.slice(0, 8).join(', ')}…]（共 ${seqLegacy.length} 条）`);
ok(seqNew.length <= 2, `新实现推送条数收敛（${seqNew.length} 条，≤2）`);
ok(countTransitions(seqNew) <= 1, `新实现 covered 序列翻转次数 = ${countTransitions(seqNew)}（要求 ≤1，不得 false/true 交替）`);
ok(seqNew.every((v) => v === false), '新实现推送的值恒为 false（主窗不在指针下 → 不该被门控）');
ok(countTransitions(seqLegacy) >= 2,
  `对照：旧实现翻转次数 = ${countTransitions(seqLegacy)}（≥2 → 同一断言对回潮会 FAIL，证明本闸门有牙齿）`);

// ============================================================================
// 4. 源码级断言：主进程必须真的用共享逻辑（回潮「无条件推 true」时必 FAIL）
// ============================================================================
console.log('=== 4. 主进程源码级断言（共享逻辑真的被用上）===');
const pushFn = mainProc.match(/function pushCoveredNow\(\): void \{[\s\S]*?\n\}/);
ok(!!pushFn, '找到 pushCoveredNow 实现');
if (pushFn) {
  const body = pushFn[0];
  ok(/computeCoveredStateNow\(\)/.test(body), 'pushCoveredNow 改为**现算**覆盖关系（不再无条件推 true）');
  ok(/diffCoverState\(/.test(body), 'pushCoveredNow 使用共享的 diffCoverState（变化沿）');
  ok(!/send\('main:cursor-window', true\)/.test(body) && !/send\('mini:cursor-window', true\)/.test(body),
    'pushCoveredNow 不再无条件 send(...true)');
  ok(/lastMainCovered = diff\.main/.test(body) && /lastMiniWindowCovered = diff\.mini/.test(body),
    'pushCoveredNow 把缓存写成**实际推的值**（true/false 都写）');
}
ok(/const rising = !hoverPanel;/.test(mainProc) && /if \(rising\) pushCoveredNow\(\);/.test(mainProc),
  'setHoverPanel 有上升沿守卫（不再每次 hover 上报都推）');
ok(/const cover = computeCoveredStateNow\(\);/.test(mainProc) &&
   /const coverDiff = diffCoverState\(/.test(mainProc),
  '200ms 轮询复用同一 computeCoveredState + 同一 diffCoverState（谓词同源）');
ok(/send\('panel:interactive', v\)/.test(mainProc), '主进程下发 panel:interactive 通道');
ok(/panel:interactive/.test(read('electron/preload.ts')) && /onPanelInteractive/.test(read('electron/preload.ts')),
  'preload 暴露 onPanelInteractive');
ok(/onPanelInteractive\?/.test(read('src/ipc.ts')), 'src/ipc.ts 声明 onPanelInteractive 类型');
ok(/api\.onPanelInteractive\(/.test(renderer), '渲染端订阅 onPanelInteractive（可交互态唯一真源）');
const mouseEnterBlk = renderer.match(/panel\.addEventListener\('mouseenter'[\s\S]*?\n  \}\);/);
ok(!!mouseEnterBlk && !/setInteractive\(/.test(mouseEnterBlk[0]),
  'panel.mouseenter 不再自行 setInteractive（多源打架已消除）');
const mouseLeaveBlk = renderer.match(/panel\.addEventListener\('mouseleave'[\s\S]*?\n  \}\);/);
ok(!!mouseLeaveBlk && !/setInteractive\(/.test(mouseLeaveBlk[0]),
  'panel.mouseleave 不再自行 setInteractive');
ok(!/matches\(':hover'\)/.test(renderer.replace(/\/\/[^\n]*/g, '')),
  '渲染端不再用 :hover 自行判定可交互态（不可靠兜底已移除）');

// ============================================================================
// 5. 四种位置的覆盖关系推演（owner / covered / 面板可交互态）
// ============================================================================
console.log('=== 5. 四种位置的覆盖关系推演 ===');
const base = {
  ballRect: BALL_RECT,
  menuRect: null,
  panelRect: PANEL_OPAQUE,
  mainRect: { x: 0, y: 0, width: 800, height: 600 },
  miniRect: null,
  dragging: false,
};
const at = (x, y) => computeCoveredState({ ...base, cursorX: x, cursorY: y });

// ① 光标在面板不透明区 → 面板独占光标 + 面板可交互
const s1 = at(200, 500);
ok(s1.owner === 'panel', `① 面板不透明区 → owner='panel'（实际 '${s1.owner}'）`);
ok(s1.main === true,
  '① 面板不透明区（主窗在其下方）→ 主窗 covered=true 被门控（面板独占光标，不出现双光标）');
ok(s1.mini === false, '① 面板不透明区 → 小窗未被压住，不被门控');
ok(computePanelInteractive(200, 500, PANEL_OPAQUE, false) === true, '① 面板不透明区 → 面板可交互=true');

// ② 光标在面板透明边距 → 面板不接管、点击穿透到下层，且该区域**必须有光标**
const marginX = PANEL_WINDOW.x + 6; // 落在 14px 内边距内
const s2 = at(marginX, 500);
ok(s2.owner === 'main', `② 面板透明边距 → owner 归下层窗口 'main'（实际 '${s2.owner}'）`);
ok(s2.main === false, '② 面板透明边距 → 主窗不被门控 → 该区域由主窗出光标（不得消失）');
ok(computePanelInteractive(marginX, 500, PANEL_OPAQUE, false) === false, '② 面板透明边距 → 面板可交互=false（点击穿透到下层）');
const s2b = at(marginX, 500);
ok(s2b.owner !== 'panel' && s2b.main === false,
  '② 面板透明边距 → 不会「面板不画 + 主窗被门控」的死区（无光标区域）');

// ③ 光标在球体上 → 球独占；主窗被压住时主窗 covered=true
const s3 = computeCoveredState({
  ...base,
  cursorX: BALL_RECT.x + 30,
  cursorY: BALL_RECT.y + 30,
  mainRect: { x: BALL_RECT.x, y: BALL_RECT.y, width: 800, height: 600 },
});
ok(s3.owner === 'ball', `③ 球体上 → owner='ball'（实际 '${s3.owner}'）`);
ok(s3.main === true, '③ 球压住主窗 → 主窗 covered=true（主窗动态光标被门控，避免双光标）');

// ④ 桌面（无任何窗命中）→ 无覆盖关系
const s4 = at(1500, 900);
ok(s4.owner === null, `④ 桌面 → owner=null（实际 '${s4.owner}'）`);
ok(s4.main === false && s4.mini === false, '④ 桌面 → 无 covered 关系（不误门控任何窗口）');

// ⑤ 拖球期间 owner 恒为 'ball'
const s5 = computeCoveredState({
  ...base,
  cursorX: 200,
  cursorY: 500,
  dragging: true,
});
ok(s5.owner === 'ball', `⑤ 拖球中 → owner 恒为 'ball'（实际 '${s5.owner}'，不受面板命中影响）`);

// ===== ⑦ 球窗 4px 透明边距必须从「球的不透明命中区」里剔掉（v2.3.126 收口）=====
// 主进程喂给共享模块的球矩形 = 球窗 bounds 内缩 BALL_PAD（= 球 DOM 实际范围 60×60）。
// 这里用**同样的构造方式**喂给真实代码（insetRect + 共享模块导出的 BALL_PAD）。
const BALL_WINDOW = { x: 100, y: 100, width: 68, height: 68 };
const BALL_OPAQUE = insetRect(BALL_WINDOW, BALL_PAD);
const ballOwnerAt = (x, y) =>
  computeOwner({
    cursorX: x,
    cursorY: y,
    ballRect: BALL_OPAQUE,
    menuRect: null,
    panelRect: PANEL_OPAQUE,
    mainRect: { x: 0, y: 0, width: 800, height: 600 },
    miniRect: null,
    dragging: false,
  });
// ① 球窗 4px 边距（窗内 2px 处）→ 不属于球的不透明区 → owner 归下层窗口
const marginOwner = ballOwnerAt(BALL_WINDOW.x + 2, BALL_WINDOW.y + 30);
ok(marginOwner !== 'ball',
  `① 球窗 4px 边距（x=${BALL_WINDOW.x + 2}）→ owner 不是 'ball'（实际 '${marginOwner}'）→ 该窄条只有下层原生光标`);
ok(marginOwner === 'main', `① 球窗 4px 边距 → owner 归下层窗口 'main'（实际 '${marginOwner}'）`);
// ② 球 DOM 范围内 → owner 仍是 'ball'
const domOwner = ballOwnerAt(BALL_WINDOW.x + BALL_PAD + 1, BALL_WINDOW.y + BALL_PAD + 1);
ok(domOwner === 'ball', `② 球 DOM 内（BALL_PAD+1）→ owner='ball'（实际 '${domOwner}'）`);
ok(ballOwnerAt(BALL_WINDOW.x + BALL_PAD + 30, BALL_WINDOW.y + BALL_PAD + 30) === 'ball',
  '② 球 DOM 中心 → owner=\'ball\'');
// ③ 拖球期间即便光标在球窗边距，owner 仍恒为 'ball'（拖拽保护不被本次改动破坏）
const dragOwner = computeOwner({
  cursorX: BALL_WINDOW.x + 2,
  cursorY: BALL_WINDOW.y + 30,
  ballRect: BALL_OPAQUE,
  menuRect: null,
  panelRect: PANEL_OPAQUE,
  mainRect: { x: 0, y: 0, width: 800, height: 600 },
  miniRect: null,
  dragging: true,
});
ok(dragOwner === 'ball', `③ 拖球中（边距处）→ owner 恒为 'ball'（实际 '${dragOwner}'）`);
// 源码级：主进程必须用 insetRect(…, BALL_PAD) 构造球矩形
ok(/ballRect:[\s\S]{0,200}?insetRect\(ballWin\.getBounds\(\) as CoverRect, BALL_PAD\)/.test(mainProc),
  '源码级：主进程把球矩形构造成 insetRect(bounds, BALL_PAD)（与脚本喂入方式一致）');
ok(!/ballRect:[\s\S]{0,160}?\(ballWin\.getBounds\(\) as CoverRect\)/.test(mainProc),
  '源码级：主进程不再把球窗整窗矩形当不透明区');

// ⑥ 面板可交互态迟滞：进入用 inset 矩形，退出用 inset 再外扩 3px
const justOutside = PANEL_OPAQUE.x - 2; // 在 inset 外、但在 +3px 外扩内
ok(computePanelInteractive(justOutside, 500, PANEL_OPAQUE, false) === false,
  '⑥ 迟滞：未进入时用 inset 矩形判定 → 面板外 2px 不可交互');
ok(computePanelInteractive(justOutside, 500, PANEL_OPAQUE, true) === true,
  '⑥ 迟滞：已进入时用外扩 3px 矩形判定 → 面板外 2px 仍保持可交互（边界不抖）');
ok(computePanelInteractive(PANEL_OPAQUE.x - 5, 500, PANEL_OPAQUE, true) === false,
  '⑥ 迟滞：超出外扩 3px 才退出可交互');

// ============================================================================
// 6. P2-B：CI 入口
// ============================================================================
// （本节仅作提示性断言，CI 实际跑的是 package.json 里的 npm 脚本）
console.log('=== 6. CI 入口（package.json verify 脚本）===');
const pkg = JSON.parse(read('package.json'));
ok(typeof pkg.scripts['verify:cursor-hotspot'] === 'string', 'package.json 含 verify:cursor-hotspot');
ok(typeof pkg.scripts['verify:cursor-cover-state'] === 'string', 'package.json 含 verify:cursor-cover-state');
ok(typeof pkg.scripts['verify:cursor-leave'] === 'string' && typeof pkg.scripts['verify:launch-cursor'] === 'string',
  '既有 verify 入口仍在（未破坏）');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
