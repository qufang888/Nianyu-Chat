// ============================================================================
// v3.0.11 行为级验证（不是门禁正则，而是把真实源码的几何段 transpile 后实跑）
//
// 与 scripts/verify-desktop-character.mjs 的区别：
//   - 门禁只检查「代码长什么样」；本脚本检查「代码算出来对不对」。
//   - 直接从 electron/desktopCharacter.ts 抽取几何段，用 typescript.transpileModule
//     去掉类型标注后在 vm 沙箱里执行，调用的是实现本身（改了公式这里立刻变红）。
//
// 用法：node scripts/verify-dynamic-window-behavior.mjs
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const ROOT = process.cwd();
let pass = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? `  [${detail}]` : ''}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL  ${name}${detail ? `  [${detail}]` : ''}`);
  }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------- 从真实源码抽取几何段并在沙箱执行 ----------
const srcPath = process.env.DC_SRC_OVERRIDE || path.join(ROOT, 'electron/desktopCharacter.ts');
const src = fs.readFileSync(srcPath, 'utf8');
const start = src.indexOf('const CHAR_BODY_W = 190;');
const endMarker = '/** 取（或惰性创建）某角色的拖拽状态。 */';
const end = src.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error('无法在 desktopCharacter.ts 中定位几何段');
const geometrySrc = src.slice(start, end);

// 抽取真实 resizeCharacterWindow（QA P1 回归：必须走它，不能只用公式自证）
function extractFunction(srcText, header) {
  const i = srcText.indexOf(header);
  if (i < 0) throw new Error(`无法定位函数: ${header}`);
  const open = srcText.indexOf('{', i);
  let depth = 0;
  for (let k = open; k < srcText.length; k++) {
    if (srcText[k] === '{') depth++;
    else if (srcText[k] === '}') {
      depth--;
      if (depth === 0) return srcText.slice(i, k + 1);
    }
  }
  throw new Error(`函数括号不平衡: ${header}`);
}
const resizeSrc = extractFunction(src, 'function resizeCharacterWindow(');
// QA Round 2：真实 moved 处理器也必须纳入闭环（它是第二层回灌源）
const movedHeader = "win.on('moved', ";
const movedBlock = extractFunction(src, movedHeader);
const movedArrowSrc = movedBlock.slice(movedHeader.length) + ';';

// P2-3：shim 的基准常量不再硬编码，直接从真实源码 transpile 抽取（源码改了这里跟着改）
const baseConstSrc = (src.match(/export const DC_WIN_BASE_[WH] = \d+;/g) || [])
  .map((line) => line.replace(/^export\s+/, ''))
  .join('\n');
if (!/DC_WIN_BASE_W/.test(baseConstSrc) || !/DC_WIN_BASE_H/.test(baseConstSrc)) {
  throw new Error('无法从源码抽取 DC_WIN_BASE_W/H');
}
const baseConstJs = ts.transpileModule(baseConstSrc, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
}).outputText;

// 前置依赖 shim：几何段 + resize 段依赖基准常量、workArea、dragStates、findChar、
// dcWindows、getDragState。fake win 严格模拟 Electron：setBounds 取整、getBounds 回读整数。
const shim = [
  baseConstJs,
  'let __WA = { x: 0, y: 0, width: 4000, height: 3000 };',
  'function workArea() { return __WA; }',
  'const dragStates = new Map();',
  'function findChar() { return null; }',
  'const dcWindows = new Map();',
  'function getDragState(id) {',
  '  let s = dragStates.get(id);',
  '  if (!s) { s = { curX: 0, curY: 0, vx: 0, vy: 0, scale: 1 }; dragStates.set(id, s); }',
  '  return s;',
  '}',
  'function __makeWin(x, y, w, h) {',
  '  const b = { x, y, width: w, height: h };',
  '  const win = {',
  '    isDestroyed: () => false,',
  '    getBounds: () => ({ ...b }),',
  // Electron 真实行为：setBounds 取整、moved 在当前调用栈结束后才发出。
  // 必须延迟到 resize 返回之后再 flush，否则同步触发会被 resize 末尾的 st.curX=c.x 覆盖，
  // 从而假绿地掩盖 QA Round 2 的 moved 回灌闭环（这个坑我自己踩了一次）。
  '    setBounds: (nb) => { b.x = Math.round(nb.x); b.y = Math.round(nb.y); b.width = nb.width; b.height = nb.height; win.__pendingMoved = true; },',
  '    setPosition: (nx, ny) => { b.x = nx; b.y = ny; },',
  '    __bounds: b,',
  '  };',
  '  return win;',
  '}',
  'function __attachMoved(id, win) { win.__onMoved = ' + movedArrowSrc + ' }',
  '',
].join('\n');
const js = ts.transpileModule(shim + geometrySrc + '\n' + resizeSrc, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
}).outputText;
const ctx = vm.createContext({ console });
vm.runInContext(js, ctx);
const { setWA, setScale, api, makeWin, setWindow, attachMoved, getDragState, resize } = vm.runInContext(`({
  setWA: (wa) => { __WA = wa; },
  setScale: (id, s) => { dragStates.set(id, { scale: s }); },
  makeWin: __makeWin,
  setWindow: (id, win) => { dcWindows.set(id, win); },
  attachMoved: (id, win) => { __attachMoved(id, win); },
  getDragState,
  resize: (id, s) => {
    resizeCharacterWindow(id, s);
    const w = dcWindows.get(id);
    if (w && w.__pendingMoved) { w.__pendingMoved = false; if (w.__onMoved) w.__onMoved(); }
  },
  api: {
    DC_WIN_BASE_W, DC_WIN_BASE_H, CHAR_BODY_W, CHAR_BODY_H, CHAR_BODY_BOTTOM_GAP,
    DC_PAD_X, DC_HEAD_TOP, DC_SCALE_MIN, DC_SCALE_MAX, DC_PREVIEW_RESTORE_MS,
    clampScale, winSizeForScale, footFromStored, storedFromFoot, clampAxis, clampPos
  }
})`, ctx);

const SCALES = [1, 1.5, 2, 3, 5];
const GAP = api.CHAR_BODY_BOTTOM_GAP;
console.log('\n===== 1. 角色可见矩形完整落在窗口内（放大后头不被截断）=====');
for (const S of SCALES) {
  const { w, h } = api.winSizeForScale(S);
  const halfW = (api.CHAR_BODY_W * S) / 2;
  const bodyH = api.CHAR_BODY_H * S;
  const marginL = w / 2 - halfW;
  const marginR = w - (w / 2 + halfW);
  const marginTop = h - GAP - bodyH;
  const marginBottom = h - (h - GAP);
  check(`S=${S} 四边余量均 ≥0`,
    marginL >= 0 && marginR >= 0 && marginTop >= 0 && marginBottom >= 0 &&
    near(marginL, 75) && near(marginR, 75) && near(marginTop, 182) && near(marginBottom, 10),
    `win=${w}×${h}, L/R=${marginL}/${marginR}, Top/Bottom=${marginTop}/${marginBottom}`);
}
check('尺寸模型关键档位与拍板一致',
  (() => {
    const a = api.winSizeForScale(1);
    const b = api.winSizeForScale(2);
    const c = api.winSizeForScale(5);
    return a.w === 340 && a.h === 420 && b.w === 530 && b.h === 648 && c.w === 1100 && c.h === 1332;
  })(),
  'S=1→340×420, S=2→530×648, S=5→1100×1332');
check('S<=1 不收缩（保护气泡/菜单固定像素布局）',
  api.winSizeForScale(0.6).w === 340 && api.winSizeForScale(0.6).h === 420);

console.log('\n===== 2. scale 变化时脚点屏幕坐标不变（零坐标迁移）=====');
// 用足够大的工作区，避免 clampPos 介入，单独验证原点补偿公式
setWA({ x: 0, y: 0, width: 4000, height: 3000 });
const origin0 = { x: 1000, y: 1500 };
const w0 = 340;
const h0 = 420;
const foot = { x: origin0.x + w0 / 2, y: origin0.y + h0 - GAP };
const stored0 = api.storedFromFoot(foot.x, foot.y);
check('旧数据无条件满足 foot=(stored.x+170, stored.y+410)',
  near(foot.x, api.footFromStored(stored0.x, stored0.y).x) &&
  near(foot.y, api.footFromStored(stored0.x, stored0.y).y),
  `stored=(${stored0.x},${stored0.y}) → foot=(${foot.x},${foot.y})`);
for (const S of SCALES) {
  setScale('foot-test', S);
  const { w, h } = api.winSizeForScale(S);
  const nx = foot.x - w / 2;
  const ny = foot.y - (h - GAP);
  const c = api.clampPos(nx, ny, 'foot-test');
  const newFoot = { x: c.x + w / 2, y: c.y + h - GAP };
  const stored = api.storedFromFoot(newFoot.x, newFoot.y);
  check(`S=${S} 原点补偿后脚点不变 + 存储坐标不变`,
    near(c.x, nx) && near(c.y, ny) &&
    near(newFoot.x, foot.x) && near(newFoot.y, foot.y) &&
    near(stored.x, stored0.x) && near(stored.y, stored0.y),
    `origin=(${c.x},${c.y}), foot=(${newFoot.x},${newFoot.y}), stored=(${stored.x},${stored.y})`);
}
const size5 = api.winSizeForScale(5);
const dX = (foot.x - size5.w / 2) - origin0.x;
const dY = (foot.y - (size5.h - GAP)) - origin0.y;
check('S:1→5 原点位移 dX=−380 / dY=−912', near(dX, -380) && near(dY, -912), `dX=${dX}, dY=${dY}`);

console.log('\n===== 3. clampAxis 正常/反转区间都能贴边（无空气墙）=====');
check('clampAxis 正常区间 lo<=hi：夹逼 + 两端可达',
  api.clampAxis(500, -75, 895) === 500 &&
  api.clampAxis(-1000, -75, 895) === -75 &&
  api.clampAxis(1000, -75, 895) === 895);
check('clampAxis 反转区间 lo>hi：返回区间端点（文档用例 clampAxis(999,-182,-282)=-182）',
  api.clampAxis(999, -182, -282) === -182 &&
  api.clampAxis(-999, -182, -282) === -282 &&
  api.clampAxis(-240, -182, -282) === -240);
setWA({ x: 0, y: 0, width: 1920, height: 1040 }); // 1080p 典型工作区
setScale('edge-test', 5);
const yTop = api.clampPos(500, 100000, 'edge-test');
const yBottom = api.clampPos(500, -100000, 'edge-test');
check('1080p + S=5 纵向两端都可贴边（旧实现被钳成单值 = 空气墙）',
  near(yTop.y, -182) && near(yBottom.y, -282) && yTop.y !== yBottom.y,
  `yTop=${yTop.y}（头贴 wa 顶）, yBottom=${yBottom.y}（脚贴 wa 底）`);
const xLeft = api.clampPos(-100000, 300, 'edge-test');
const xRight = api.clampPos(100000, 300, 'edge-test');
check('1080p + S=5 横向两端仍可贴边（正常区间未被破坏）',
  near(xLeft.x, -75) && near(xRight.x, 895), `xLeft=${xLeft.x}, xRight=${xRight.x}`);

console.log('\n===== 4. 视线除数乘 scale 后最大转角恒定 =====');
const appTsx = fs.readFileSync(path.join(ROOT, 'src/character/CharacterApp.tsx'), 'utf8');
const stageTsx = fs.readFileSync(path.join(ROOT, 'src/components/CharacterStage.tsx'), 'utf8');
const divisorMatch = appTsx.match(/const DC_EYE_DIVISOR = (\d+)/);
const stageDivisorMatch = stageTsx.match(/const STAGE_EYE_DIVISOR = (\d+)/);
const DC_EYE_DIVISOR = divisorMatch ? Number(divisorMatch[1]) : -1;
check('桌宠/舞台除数基准同值 170', DC_EYE_DIVISOR === 170 && stageDivisorMatch && Number(stageDivisorMatch[1]) === 170);
const MAX_YAW_DEG = 30; // src/character/vrmPose.ts VRM_GAZE_MAX_YAW_DEG
for (const S of SCALES) {
  // 光标固定在「角色半宽的一半」处 —— 与角色同比例移动，模拟手跟着放大后的角色走
  const cursorOffset = (DC_EYE_DIVISOR / 2) * S;
  const newEye = Math.max(-1, Math.min(1, cursorOffset / (DC_EYE_DIVISOR * S)));
  const oldEye = Math.max(-1, Math.min(1, cursorOffset / DC_EYE_DIVISOR));
  const newYaw = newEye * MAX_YAW_DEG;
  const oldYaw = oldEye * MAX_YAW_DEG;
  check(`S=${S} 转角恒定 15°（旧除数会变成 ${oldYaw.toFixed(1)}°）`,
    near(newYaw, 15),
    `eye=${newEye.toFixed(2)}, yaw=${newYaw.toFixed(1)}°, old=${oldYaw.toFixed(1)}°`);
}
check('源码确实把除数乘了 scale / zoom（行为与门禁同源）',
  /\(x - cx\) \/ \(DC_EYE_DIVISOR \* scale\)/.test(appTsx) &&
  /\(y - cy\) \/ \(DC_EYE_DIVISOR \* scale\)/.test(appTsx) &&
  /\(e\.clientX - cx\) \/ \(STAGE_EYE_DIVISOR \* zoom\)/.test(stageTsx) &&
  /\(e\.clientY - cy\) \/ \(STAGE_EYE_DIVISOR \* zoom\)/.test(stageTsx));

console.log('\n===== 5. QA P1 回归：Electron 整数 getBounds 回读下缩放往返不累积漂移 =====');
{
  // 大工作区，排除 clampAxis 介入；stored=(1000,1500) ⇒ foot=(1170,1910)
  setWA({ x: 0, y: 0, width: 4000, height: 3000 });
  const win = makeWin(1000, 1500, 340, 420);
  setWindow('drift', win);
  attachMoved('drift', win); // 关键：接上真实 moved 回灌闭环
  const st = getDragState('drift');
  st.curX = 1000;
  st.curY = 1500;
  st.vx = 0;
  st.vy = 0;
  st.scale = 1;
  const foot0 = api.footFromStored(1000, 1500);
  const footLogical = () => ({
    x: st.curX + api.winSizeForScale(st.scale).w / 2,
    y: st.curY + api.winSizeForScale(st.scale).h - api.CHAR_BODY_BOTTOM_GAP,
  });
  const footPhysical = () => {
    const b = win.getBounds();
    return { x: b.x + b.width / 2, y: b.y + b.height - api.CHAR_BODY_BOTTOM_GAP };
  };
  // 完整走真实 resizeCharacterWindow，步长 0.05（滑块口径），1→5→1 共 3 轮；逐轮留证
  const rounds = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 1; i <= 80; i++) resize('drift', 1 + i * 0.05);
    for (let i = 79; i >= 0; i--) resize('drift', 1 + i * 0.05);
    const f = footLogical();
    rounds.push({ foot: f, stored: api.storedFromFoot(f.x, f.y) });
    check(`第 ${cycle + 1} 轮 1→5→1：脚点与存储坐标逐轮完全不变（0px，非 ≤1px）`,
      near(f.x, foot0.x, 1e-9) && near(f.y, foot0.y, 1e-9) &&
      near(rounds[cycle].stored.x, 1000, 1e-9) && near(rounds[cycle].stored.y, 1500, 1e-9),
      `foot=(${f.x},${f.y}), stored=(${rounds[cycle].stored.x},${rounds[cycle].stored.y})`);
  }
  const logical = footLogical();
  const physical = footPhysical();
  const storedAfter = api.storedFromFoot(logical.x, logical.y);
  check('3 轮 100%→500%→100% 后逻辑脚点零漂移',
    near(logical.x, foot0.x, 1e-6) && near(logical.y, foot0.y, 1e-6),
    `foot=(${logical.x},${logical.y}) 期望 (${foot0.x},${foot0.y})`);
  check('3 轮往返后物理脚点误差 ≤0.5px（setBounds 取整固有限度，不累积）',
    Math.abs(physical.x - foot0.x) <= 0.5 && Math.abs(physical.y - foot0.y) <= 0.5,
    `physical=(${physical.x},${physical.y})`);
  check('3 轮往返后 persistPos 存储坐标不变（重启不跳位）',
    near(storedAfter.x, 1000, 1e-6) && near(storedAfter.y, 1500, 1e-6),
    `stored=(${storedAfter.x},${storedAfter.y})`);
  // 单次 1→5 也要零漂移（QA 实测旧实现 +20px）
  const win2 = makeWin(1000, 1500, 340, 420);
  setWindow('drift2', win2);
  attachMoved('drift2', win2);
  const st2 = getDragState('drift2');
  st2.curX = 1000; st2.curY = 1500; st2.scale = 1;
  for (let i = 1; i <= 80; i++) resize('drift2', 1 + i * 0.05); // 步长 0.05 逐档推到 500%
  const f2 = { x: st2.curX + api.winSizeForScale(5).w / 2, y: st2.curY + api.winSizeForScale(5).h - api.CHAR_BODY_BOTTOM_GAP };
  check('单次 1→5（经 80 档滑块）逻辑脚点零漂移',
    near(f2.x, foot0.x, 1e-6) && near(f2.y, foot0.y, 1e-6),
    `foot=(${f2.x},${f2.y})`);
  // 奇数宽档位专项：w/2 带 .5，但逻辑原点同样带 .5，二者相加仍精确抵消
  for (const s of [1.1, 1.5, 2.5, 3.5, 4.5]) {
    const win3 = makeWin(1000, 1500, 340, 420);
    setWindow('odd' + s, win3);
    attachMoved('odd' + s, win3);
    const st3 = getDragState('odd' + s);
    st3.curX = 1000; st3.curY = 1500; st3.scale = 1;
    resize('odd' + s, s);
    const w = api.winSizeForScale(s).w;
    const h = api.winSizeForScale(s).h;
    const f3 = { x: st3.curX + w / 2, y: st3.curY + h - api.CHAR_BODY_BOTTOM_GAP };
    check(`奇数宽 S=${s}（w=${w}）脚点与存储坐标仍精确为整数`,
      w % 2 === 1 && near(f3.x, foot0.x, 1e-9) && near(f3.y, foot0.y, 1e-9) &&
      near(api.storedFromFoot(f3.x, f3.y).x, 1000, 1e-9),
      `origin.x=${st3.curX}, w/2=${w / 2}, foot.x=${f3.x}`);
  }
}

// ---------- 汇总 ----------
console.log('\n' + '─'.repeat(70));
if (failures.length === 0) {
  console.log(`✅ 行为级验证全部通过：${pass} 条`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 条失败 / 共 ${pass + failures.length} 条：`);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
