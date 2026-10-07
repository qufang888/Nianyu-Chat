// v2.3.96 验证：消息操作栏「淡入 + 轻微上移」的 0.5s 弹出动画
// 用法：node scripts/verify-actionbar-direct-show.mjs
// 可证伪性对照：NY_FORCE_LEGACY=1 node scripts/verify-actionbar-direct-show.mjs  应当失败
//
// 为什么需要它：这是个**纯视觉/CSS 行为**问题 —— tsc 查不出、单看源码也证明不了三件事：
//   1) 「按钮没有被缩放」（transform 链里不含 scale）；
//   2) 「动画真的在 0.5 秒里播完」（不是凭空出现，也不是瞬间跳完）；
//   3) 「动效开关关掉后按钮不会卡在 opacity:0 变成全透明」。
// 所以这里用项目自带的 Electron 真渲染，量 getComputedStyle / getBoundingClientRect，
// 并**按真实时间轴采样**，直接测出「0.5s 内 opacity 从 0 走到 1」。
//
// 架构说明：普通 Node 里 `require('electron')` 返回的是 **electron.exe 路径字符串**，
// BrowserWindow 等 API 只在 Electron 运行时内可用。因此：
//   本脚本(Node) → 起 electron.exe 子进程 → 子进程渲染并量 → JSON 打到 stdout → 本脚本断言。
//
// ── 本脚本踩过的三个坑（都留了档，改动时务必先读）────────────────────
//   ① 两层反引号模板串嵌套 → 内层反引号会**提前终止**外层模板，生成语法错误的探针，
//      Electron 静默退出，表现为「探测进程超时」。
//   ② 两层模板里的 `\\n` 会被还原两次 → 送进渲染进程的是**真实换行符**，
//      落在 JS 字符串字面量里就成了 Illegal token，而 Electron 把真实异常吞成
//      一句无信息量的 "Script failed to execute"。
//   ③ `node --check` 在本机间歇性 EBUSY（Windows 文件占用）。
//   ⇒ 对策：渲染层代码用**单层**模板（RENDER_JS）单独落成一个临时文件，
//      主进程脚本（MAIN）里只做 fs.readFileSync 引用，**不再有任何嵌套**。
//
// 判定标准（用户原话：「没有动画了，直接凭空出现，正常来说应该有动画，弹出动画速度 0.5 秒」）：
//   A. 两态尺寸相同 + transform 无 scale  → 结构上不存在「缩放/放大」动作
//   B. 隐藏态完全不可见（visibility:hidden）+ 保留占位 → 出现时气泡不跳动
//   C. **确实存在 0.5s 的淡入动画**（时长、属性、真实时间轴采样三重验证）
//   D. visibility 不参与过渡（否则退化成 0.5s 淡出 + 可见性抖动）
//   E. 隐藏态点不到（pointer-events:none）
//   F. 用户消息右侧对齐未回归
//   G. **动效关档（两种真实机制都测）后按钮仍完全不透明、不会卡在首帧**
//   H. 静态契约：.msg-action-bar 仍登记在 animControl 的 panel 组里（否则开关对它失效）

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Script } from 'node:vm';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL  ' + name + ' ' + extra); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/** transform 串里是否出现缩放（含 matrix 的 a/d 分量放大与斜切） */
function hasScale(t) {
  if (!t || t === 'none') return false;
  if (/scale/i.test(t)) return true;
  const m = /^matrix(3d)?\(([^)]+)\)$/.exec(t);
  if (m) {
    const n = m[2].split(',').map((x) => parseFloat(x));
    // matrix(a,b,c,d,e,f)：a/d 为缩放分量，b/c 为斜切
    const sc = m[1] === 'matrix3d' ? [n[0], n[5]] : [n[0], n[3]];
    if (sc.some((v) => Math.abs(v - 1) > 1e-6)) return true;
    return Math.abs(n[1]) > 1e-6 || Math.abs(n[2]) > 1e-6;
  }
  return false;
}
/** 从 matrix 里取 translateY 分量（非 matrix 返回 null） */
function translateYOf(t) {
  const m = /^matrix(?:3d)?\(([^)]+)\)$/.exec(t || '');
  if (!m) return null;
  const n = m[1].split(',').map((x) => parseFloat(x));
  return m[0] === 'matrix3d' ? n[13] : n[5];
}

// ---------- 静态契约：.msg-action-bar 必须仍登记在 animControl 的 panel 组 ----------
section('H. 静态契约：动效分组登记（CSS 之外的第一道闸）');
try {
  const ac = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'animControl.ts'), 'utf-8');
  const panelBlock = /id:\s*'panel'[\s\S]*?selectors:\s*\[([\s\S]*?)\]/.exec(ac);
  const has = !!panelBlock && /['"]\.msg-action-bar['"]/.test(panelBlock[1]);
  check('.msg-action-bar 仍登记在 ANIM_GROUPS.panel.selectors 里', has,
    has ? '' : '未找到 —— 动效开关将对操作栏失效（transition 不会被 kill）');
} catch (e) {
  check('读取 src/utils/animControl.ts 成功', false, String(e));
}

// ---------- 找编译产物 ----------
const assetsDir = path.join(ROOT, 'dist', 'assets');
if (!fs.existsSync(assetsDir)) { console.error('找不到 dist/assets —— 请先跑 npm run build'); process.exit(1); }
const cssName = fs.readdirSync(assetsDir).find((x) => /^main-.*\.css$/.test(x));
if (!cssName) { console.error('找不到 dist/assets/main-*.css —— 请先跑 npm run build'); process.exit(1); }
const CSS = fs.readFileSync(path.join(assetsDir, cssName), 'utf-8');
console.log('使用编译产物：' + cssName);

// 可证伪性开关：NY_FORCE_LEGACY=1 时在真实产物 CSS **之后**追加 v2.3.94 的旧实现
//（scale 0.4 → 1）。用途：证明本脚本真能抓到「先很小再放大」和「没有 0.5s 淡入动画」
// 这两类回归 —— 而不只是在新实现上永远全绿。
if (process.env.NY_FORCE_LEGACY === '1') {
  console.log('[对照组] 已注入 v2.3.94 旧实现 scale(0.4) + 0.18s，本轮断言**应当失败**');
  var CSS_INJECTED = CSS + `
.msg-action-bar { visibility: visible; transform-origin: left center; transform: scale(0.4) translateY(6px); transition: transform 0.18s linear; }
.msg-action-bar.is-in { transform: scale(1) translateY(0); }
`;
} else {
  var CSS_INJECTED = CSS;
}

// ---------- 复刻真实的操作栏 DOM 结构（依据 ChatWindow.tsx 的 JSX） ----------
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS_INJECTED}
.msg-row { display:flex; gap:8px; padding:6px 10px; }
.msg-row.user { flex-direction: row-reverse; }
.msg-meta { display:flex; align-items:center; font-size:12px; }
</style></head><body>
<div class="msg-row" id="aiBar">
  <div class="msg-meta">
    <span>tokens 1000</span>
    <div class="msg-action-bar" id="bar">
      <button class="msg-ai-action-btn" id="b1">A</button>
      <button class="msg-ai-action-btn" id="b2">B</button>
      <button class="msg-ai-action-btn" id="b3">C</button>
      <button class="msg-ai-action-btn" id="b4">D</button>
      <button class="msg-ai-action-btn" id="b5">E</button>
    </div>
  </div>
</div>
<div class="msg-row user" id="userBar">
  <div class="msg-meta">
    <span>tokens 500</span>
    <div class="msg-action-bar" id="barUser">
      <button class="msg-ai-action-btn" id="u1">A</button>
    </div>
  </div>
</div>
</body></html>`;

// ===== 产物新鲜度校验（v2.3.96 加）=====
// 为什么要加：本脚本测的是 dist 产物，而**多人并行构建会互相覆盖 dist/** ——
// 如果别人在你验证之后又跑了一次 vite build，脚本读到的产物就与源码不一致，
// 但脚本**不会报错**，会给出「看似通过、实际测的是旧产物」的假绿结论（已真实发生过）。
// 所以这里比对产物与源文件的 mtime：产物比源文件旧 → 直接拒绝运行。
const srcCss = path.join(ROOT, 'src', 'styles', 'index.css');
const cssPathFull = path.join(assetsDir, cssName);
if (fs.existsSync(srcCss) && fs.existsSync(cssPathFull)) {
  const srcMtime = fs.statSync(srcCss).mtimeMs;
  const distMtime = fs.statSync(cssPathFull).mtimeMs;
  if (distMtime < srcMtime) {
    console.error('产物比源码旧 —— 并行构建把 dist/ 覆盖成旧版本了，拒绝运行。');
    console.error('  源码 index.css : ' + new Date(srcMtime).toISOString());
    console.error('  产物 ' + cssName + ' : ' + new Date(distMtime).toISOString());
    console.error('请先运行 npm run build 再重试本脚本。');
    process.exit(2);
  }
}

const stamp = Date.now();
const tmpHtml = path.join(os.tmpdir(), `ny-actionbar-${stamp}.html`);
// ⚠️ 主进程探针必须放在**项目目录内**（scripts/ 下），否则它的 require('electron')
// 会从临时目录向上找 node_modules 而找不到（MODULE_NOT_FOUND）。
const tmpMain = path.join(ROOT, 'scripts', `.ny-actionbar-probe-${stamp}.js`);
const tmpRender = path.join(ROOT, 'scripts', `.ny-actionbar-render-${stamp}.js`);
fs.writeFileSync(tmpHtml, HTML, 'utf-8');

// ---------- 渲染层代码（单层模板，独立落盘 → 无任何嵌套转义） ----------
const RENDER_JS = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const measure = (barId, rowId, btnId) => {
    const bar = document.getElementById(barId);
    const row = document.getElementById(rowId);
    const btn = document.getElementById(btnId);
    const cs = getComputedStyle(bar);
    const br = btn.getBoundingClientRect();
    return {
      visibility: cs.visibility, transform: cs.transform, opacity: cs.opacity,
      transitionDuration: cs.transitionDuration, transitionProperty: cs.transitionProperty,
      pointerEvents: cs.pointerEvents, justify: cs.justifyContent,
      btnW: Math.round(br.width*100)/100, btnH: Math.round(br.height*100)/100,
      rowH: Math.round(row.getBoundingClientRect().height*100)/100,
      barW: Math.round(bar.getBoundingClientRect().width*100)/100,
    };
  };
  const out = {};
  const bar = document.getElementById('bar');

  // ---- 两态静态测量（都在**动画播完之后**取，避免量到中间帧）----
  out.aiHidden = measure('bar','aiBar','b1');
  out.userHidden = measure('barUser','userBar','u1');
  bar.classList.add('is-in');
  document.getElementById('barUser').classList.add('is-in');
  await sleep(900);                       // > 0.5s，确保过渡彻底结束
  out.aiReady = measure('bar','aiBar','b1');
  out.userReady = measure('barUser','userBar','u1');

  // ---- 真实时间轴采样：证明「0.5s 淡入」真的在播，而不是瞬间跳完 ----
  bar.classList.remove('is-in');
  await sleep(700);
  out.axisStart = parseFloat(getComputedStyle(bar).opacity);
  bar.classList.add('is-in');
  // 刚加上 class 的这一帧：过渡刚开始，opacity 还应约等于 0
  //（若是「瞬间跳完」这里就已经是 1 —— 那正是 v2.3.95 被用户否掉的形态）
  out.axisT0 = parseFloat(getComputedStyle(bar).opacity);
  await sleep(250);                       // 约半程
  out.axisMid = parseFloat(getComputedStyle(bar).opacity);
  out.axisMidTransform = getComputedStyle(bar).transform;
  await sleep(600);                       // 总计约 850ms > 0.5s
  out.axisEnd = parseFloat(getComputedStyle(bar).opacity);
  out.axisEndTransform = getComputedStyle(bar).transform;

  // ---- 关档机制一：全部关闭档 = html.anim-off 类（规则在 index.css，产物已含）----
  const root = document.documentElement;
  root.classList.add('anim-off');
  bar.classList.remove('is-in');
  out.offAllHidden = measure('bar','aiBar','b1');
  bar.classList.add('is-in');
  // 关键：同一帧立刻读 —— transition:none 时插值不运行，computed 应**直接是终值 1**
  out.offAllReadyImmediate = measure('bar','aiBar','b1');
  await sleep(120);
  out.offAllReady = measure('bar','aiBar','b1');
  root.classList.remove('anim-off');

  // ---- 关档机制二：自定义档关掉 panel 组 = data-anim-off~="panel" + 门禁 CSS ----
  // 门禁规则逐字复刻 animControl.ts 的 buildGateCss('main') 对 panel 组产出的内容。
  // 换行用 String.fromCharCode(10) 拼，绕开反斜杠转义（本文件已是单层模板，
  // 但仍保持这一写法以免日后被人再包一层）。
  const GATE_CSS = [
    'html[data-anim-off~="panel"] .stories-panel,',
    'html[data-anim-off~="panel"] .msg-action-bar,',
    'html[data-anim-off~="panel"] .scroll-to-bottom,',
    'html[data-anim-off~="panel"] .mini-scroll-to-bottom {',
    '  animation: none !important;',
    '  transition: none !important;',
    '}',
  ].join(String.fromCharCode(10));
  const gate = document.createElement('style');
  gate.textContent = GATE_CSS;
  document.head.appendChild(gate);
  root.setAttribute('data-anim-off', 'panel');
  await sleep(120);
  bar.classList.remove('is-in');
  out.offPanelHidden = measure('bar','aiBar','b1');
  bar.classList.add('is-in');
  out.offPanelReadyImmediate = measure('bar','aiBar','b1');
  await sleep(120);
  out.offPanelReady = measure('bar','aiBar','b1');
  return out;
})()
  // executeJavaScript 会把渲染进程的异常吞成一句无信息量的
  // "Script failed to execute"。这里自己包一层，把**真实错误文本**带回来。
  .catch((e) => ({ __probeError: ((e && e.stack) || String(e)) }))
`;
fs.writeFileSync(tmpRender, RENDER_JS, 'utf-8');

// ---------- 主进程探针（不含任何嵌套模板） ----------
const MAIN = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { offscreen: true } });
  await win.loadURL('file://' + process.env.NY_PROBE_HTML.split('\\\\').join('/'));
  await sleep(500);
  const js = fs.readFileSync(process.env.NY_RENDER_JS, 'utf-8');
  const data = await win.webContents.executeJavaScript(js);
  if (data && data.__probeError) {
    process.stderr.write('PROBE_ERR:' + data.__probeError + String.fromCharCode(10));
    app.exit(2);
  }
  process.stdout.write('PROBE_JSON:' + JSON.stringify(data) + String.fromCharCode(10));
  app.exit(0);
}).catch((e) => { process.stderr.write('PROBE_ERR:' + ((e && e.stack) || e) + String.fromCharCode(10)); app.exit(2); });
`;
fs.writeFileSync(tmpMain, MAIN, 'utf-8');

// ⚠️ 先在**本进程内**编译一遍两个脚本再起 Electron：把「模板转义写错」这类问题
//    从「Electron 静默退出 → 30s 超时」变成一条立刻可见的明确错误。
for (const [label, code] of [['主进程探针', MAIN], ['渲染层脚本', RENDER_JS]]) {
  try {
    new Script(code, { filename: label });
  } catch (e) {
    console.error(label + '有语法错误（已中止，未启动 Electron）：\n' + (e && e.message));
    cleanup();
    process.exit(1);
  }
}

const electronPath = require('electron');
if (!fs.existsSync(electronPath)) { console.error('找不到 electron 可执行文件：' + electronPath); process.exit(1); }

function cleanup() {
  for (const f of [tmpHtml, tmpMain, tmpRender]) { try { fs.unlinkSync(f); } catch { /* 已删 */ } }
}

const probe = await new Promise((resolve, reject) => {
  // ⚠️ 必须清掉 ELECTRON_RUN_AS_NODE：某些环境把它设成 1，
  // 那会让 electron.exe 以纯 Node 模式启动，拿不到 app/BrowserWindow。
  const env = { ...process.env, NY_PROBE_HTML: tmpHtml, NY_RENDER_JS: tmpRender };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [tmpMain], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  // 渲染层固定约 3.2s 定时采样，正常几秒即返回；30s 足够宽松又能快速失败。
  const timer = setTimeout(() => { child.kill(); reject(new Error('探测进程超时\n' + err.slice(-600))); }, 30000);
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('close', (code) => {
    clearTimeout(timer);
    const line = out.split('\n').find((l) => l.startsWith('PROBE_JSON:'));
    if (!line) { reject(new Error('探测进程未输出（code=' + code + '）\nstdout:' + out.slice(-400) + '\nstderr:' + err.slice(-800))); return; }
    try { resolve(JSON.parse(line.slice('PROBE_JSON:'.length))); } catch (e) { reject(e); }
  });
});

section('A. 核心判定：两态尺寸相同 + transform 无 scale → 不存在缩放/放大动作');
check('AI 方向：按钮宽度两态一致', probe.aiHidden.btnW === probe.aiReady.btnW, `${probe.aiHidden.btnW} vs ${probe.aiReady.btnW}`);
check('AI 方向：按钮高度两态一致', probe.aiHidden.btnH === probe.aiReady.btnH, `${probe.aiHidden.btnH} vs ${probe.aiReady.btnH}`);
check('操作栏占位宽度两态一致（无跳变）', Math.abs(probe.aiHidden.barW - probe.aiReady.barW) < 0.5, `${probe.aiHidden.barW} vs ${probe.aiReady.barW}`);
check('AI 方向隐藏态 transform 不含 scale', !hasScale(probe.aiHidden.transform), probe.aiHidden.transform);
check('AI 方向就绪态 transform 不含 scale', !hasScale(probe.aiReady.transform), probe.aiReady.transform);
check('用户方向就绪态 transform 不含 scale', !hasScale(probe.userReady.transform), probe.userReady.transform);
check('就绪态 transform 为恒等（none 或 translateY=0）',
  probe.aiReady.transform === 'none' || translateYOf(probe.aiReady.transform) === 0, probe.aiReady.transform);

section('B. 隐藏态「完全不可见」而非「小一号残留」+ 占位保留');
check('AI 方向隐藏态 visibility = hidden', probe.aiHidden.visibility === 'hidden', String(probe.aiHidden.visibility));
check('用户方向隐藏态 visibility = hidden', probe.userHidden.visibility === 'hidden', String(probe.userHidden.visibility));
check('AI 方向隐藏态 opacity = 0', Math.abs(parseFloat(probe.aiHidden.opacity)) < 0.001, probe.aiHidden.opacity);
check('AI 方向行高两态一致（气泡不跳动）', probe.aiHidden.rowH === probe.aiReady.rowH, `${probe.aiHidden.rowH} vs ${probe.aiReady.rowH}`);
check('用户方向行高两态一致', probe.userHidden.rowH === probe.userReady.rowH, `${probe.userHidden.rowH} vs ${probe.userReady.rowH}`);

section('C. 确实存在 0.5s 的弹出动画（用户原话：正常来说应该有动画，速度 0.5 秒）');
check('就绪态 opacity = 1（动画终点完全不透明）', Math.abs(parseFloat(probe.aiReady.opacity) - 1) < 0.001, probe.aiReady.opacity);
check('transition-duration 含 0.5s', /(^|,\s*)0\.5s(,|\s|$)/.test(String(probe.aiReady.transitionDuration)), String(probe.aiReady.transitionDuration));
check('transition-property 含 opacity', /opacity/.test(String(probe.aiReady.transitionProperty)), String(probe.aiReady.transitionProperty));
check('transition-property 含 transform', /transform/.test(String(probe.aiReady.transitionProperty)), String(probe.aiReady.transitionProperty));
check('时间轴起点 opacity 约 0（起点是隐藏态）', probe.axisStart < 0.05, String(probe.axisStart));
check('加 .is-in 的首帧 opacity 仍约 0（**不是**瞬间跳到 1）', probe.axisT0 < 0.05, String(probe.axisT0));
check('半程(250ms) opacity 落在 0 与 1 之间（动画确实在插值）',
  probe.axisMid > 0.05 && probe.axisMid < 0.98, String(probe.axisMid));
check('半程 transform 不含 scale（动的是位移不是缩放）', !hasScale(probe.axisMidTransform), probe.axisMidTransform);
check('半程 translateY 介于 0 与 4px 之间（确实在向上归位）', (() => {
  const y = translateYOf(probe.axisMidTransform);
  return y !== null && y > 0.05 && y < 3.95;
})(), probe.axisMidTransform);
check('终点(>850ms) opacity = 1（0.5s 后已播完）', Math.abs(probe.axisEnd - 1) < 0.001, String(probe.axisEnd));
check('终点 transform 不含 scale', !hasScale(probe.axisEndTransform), probe.axisEndTransform);

section('D. visibility 不参与过渡（否则退化成 0.5s 淡出 + 可见性抖动）');
check('transition-property 不含 visibility', !/visibility/i.test(String(probe.aiReady.transitionProperty)), String(probe.aiReady.transitionProperty));

section('E. 隐藏态点不到');
check('AI 方向隐藏态 pointer-events = none', probe.aiHidden.pointerEvents === 'none', String(probe.aiHidden.pointerEvents));
check('AI 方向就绪态 pointer-events = auto', probe.aiReady.pointerEvents === 'auto', String(probe.aiReady.pointerEvents));

section('F. 用户消息（右侧）对齐未回归');
check('用户方向就绪态 justify-content = flex-end', probe.userReady.justify === 'flex-end', String(probe.userReady.justify));

section('G. 动效关档后按钮不会卡在 opacity:0（两种真实机制都测）');
// 机制一：全部关闭档 → html.anim-off（class，不是 data-anim-off）
check('all-off：隐藏态 opacity 仍为 0（兜底规则没有废掉门控）',
  Math.abs(parseFloat(probe.offAllHidden.opacity)) < 0.001, probe.offAllHidden.opacity);
check('all-off：隐藏态 visibility 仍为 hidden（兜底规则没有废掉门控）',
  probe.offAllHidden.visibility === 'hidden', String(probe.offAllHidden.visibility));
check('all-off：就绪态同一帧 opacity 即为 1（**不卡在首帧/不卡在透明**）',
  Math.abs(parseFloat(probe.offAllReadyImmediate.opacity) - 1) < 0.001, probe.offAllReadyImmediate.opacity);
check('all-off：就绪态 visibility = visible', probe.offAllReady.visibility === 'visible', String(probe.offAllReady.visibility));
check('all-off：就绪态 transition-duration = 0s',
  /^0s/.test(String(probe.offAllReady.transitionDuration)), String(probe.offAllReady.transitionDuration));
check('all-off：就绪态 transform 不含 scale', !hasScale(probe.offAllReady.transform), probe.offAllReady.transform);
check('all-off：两态按钮宽度仍一致', Math.abs(probe.offAllHidden.btnW - probe.offAllReady.btnW) < 0.5,
  `${probe.offAllHidden.btnW} vs ${probe.offAllReady.btnW}`);
// 机制二：自定义档关掉 panel 组 → data-anim-off~="panel" + 门禁 CSS
check('panel-off：隐藏态 opacity 仍为 0（兜底规则没有废掉门控）',
  Math.abs(parseFloat(probe.offPanelHidden.opacity)) < 0.001, probe.offPanelHidden.opacity);
check('panel-off：隐藏态 visibility 仍为 hidden',
  probe.offPanelHidden.visibility === 'hidden', String(probe.offPanelHidden.visibility));
check('panel-off：就绪态同一帧 opacity 即为 1（**最关键一条：不卡在透明**）',
  Math.abs(parseFloat(probe.offPanelReadyImmediate.opacity) - 1) < 0.001, probe.offPanelReadyImmediate.opacity);
check('panel-off：120ms 后 opacity 仍为 1（不会被后续帧打回 0）',
  Math.abs(parseFloat(probe.offPanelReady.opacity) - 1) < 0.001, probe.offPanelReady.opacity);
check('panel-off：就绪态 visibility = visible', probe.offPanelReady.visibility === 'visible', String(probe.offPanelReady.visibility));
check('panel-off：就绪态 transition-duration = 0s（过渡确被门禁 kill）',
  /^0s/.test(String(probe.offPanelReady.transitionDuration)), String(probe.offPanelReady.transitionDuration));
check('panel-off：就绪态 transform 不含 scale', !hasScale(probe.offPanelReady.transform), probe.offPanelReady.transform);

console.log('\n' + '='.repeat(62));
console.log('实测数据（AI 方向）');
console.log(`  隐藏态: visibility=${probe.aiHidden.visibility} opacity=${probe.aiHidden.opacity} transform=${probe.aiHidden.transform} transition=${probe.aiHidden.transitionDuration} 按钮=${probe.aiHidden.btnW}x${probe.aiHidden.btnH} 行高=${probe.aiHidden.rowH}`);
console.log(`  就绪态: visibility=${probe.aiReady.visibility} opacity=${probe.aiReady.opacity} transform=${probe.aiReady.transform} transition=${probe.aiReady.transitionDuration} / ${probe.aiReady.transitionProperty} 按钮=${probe.aiReady.btnW}x${probe.aiReady.btnH} 行高=${probe.aiReady.rowH}`);
console.log(`  时间轴: 起点=${probe.axisStart} → 首帧=${probe.axisT0} → 250ms=${probe.axisMid} (${probe.axisMidTransform}) → 850ms=${probe.axisEnd}`);
console.log(`  all-off 关档: 隐藏 ${probe.offAllHidden.opacity}/${probe.offAllHidden.visibility} → 就绪(同帧) ${probe.offAllReadyImmediate.opacity} → 就绪 ${probe.offAllReady.opacity}/${probe.offAllReady.visibility} transition=${probe.offAllReady.transitionDuration}`);
console.log(`  panel-off 关档: 隐藏 ${probe.offPanelHidden.opacity}/${probe.offPanelHidden.visibility} → 就绪(同帧) ${probe.offPanelReadyImmediate.opacity} → 就绪 ${probe.offPanelReady.opacity}/${probe.offPanelReady.visibility} transition=${probe.offPanelReady.transitionDuration}`);
console.log('='.repeat(62));
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  - ' + f)); }
cleanup();
process.exit(fail === 0 ? 0 : 1);