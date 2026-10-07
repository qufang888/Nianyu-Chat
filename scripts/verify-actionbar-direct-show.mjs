// v2.3.94 修正验证：消息操作栏「直接出现」而非「先很小再放大」
// 用法：node scripts/verify-actionbar-direct-show.mjs
//
// 为什么需要它：这是个**纯视觉/CSS 行为**问题 —— tsc 查不出、单看源码也证明不了
// 「按钮在隐藏态与就绪态尺寸相同」（那才是「没有放大动作」的硬证据）。
// 所以这里用项目自带的 Electron 真渲染一遍，量 getBoundingClientRect 与 computedStyle。
//
// 架构说明：普通 Node 里 `require('electron')` 返回的是 **electron.exe 路径字符串**，
// BrowserWindow 等 API 只在 Electron 运行时内可用。因此：
//   本脚本(Node) → 起 electron.exe 子进程 → 子进程渲染并量 → JSON 打到 stdout → 本脚本断言。
//
// 判定标准（用户原话：「等消息生成完之后再出现，而不是先很小，最后再放大」）：
//   A. 隐藏态与就绪态**渲染尺寸完全相等** → 结构上不存在「放大」动作
//   B. 隐藏态**完全不可见**（visibility:hidden）→ 不会看到「小一号残留」
//   C. 两态 **transform 为 none**、**transition 时长 0s** → 无缩放/淡入动画
//   D. 占位保留（行高两态相等）→ 按钮出现时气泡不跳动
//   E. 隐藏态 pointer-events:none（点不到）
//   F. 用户消息右侧对齐未回归
//   G. 动效关档与开档一致 → 不会停在 0.4 倍看不见

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL  ' + name + ' ' + extra); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ---------- 找编译产物 ----------
const assetsDir = path.join(ROOT, 'dist', 'assets');
if (!fs.existsSync(assetsDir)) { console.error('找不到 dist/assets —— 请先跑 npm run build'); process.exit(1); }
const cssName = fs.readdirSync(assetsDir).find((x) => /^main-.*\.css$/.test(x));
if (!cssName) { console.error('找不到 dist/assets/main-*.css —— 请先跑 npm run build'); process.exit(1); }
const CSS = fs.readFileSync(path.join(assetsDir, cssName), 'utf-8');
console.log('使用编译产物：' + cssName);

// 可证伪性开关：NY_FORCE_LEGACY=1 时在真实产物 CSS **之后**追加旧实现（scale 0.4 → 1）。
// 用途：证明本脚本真能抓到「先很小再放大」这种回归 —— 而不只是在新实现上永远全绿。
// 用法：NY_FORCE_LEGACY=1 node scripts/verify-actionbar-direct-show.mjs  应当失败
if (process.env.NY_FORCE_LEGACY === '1') {
  console.log('[对照组] 已注入旧实现 scale(0.4)，本轮断言**应当失败**');
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

const stamp = Date.now();
const tmpHtml = path.join(os.tmpdir(), `ny-actionbar-${stamp}.html`);
// ⚠️ 子进程脚本必须放在**项目目录内**（如 scripts/ 下），否则它的require('electron')
// 会从临时目录向上找 node_modules 而找不到（MODULE_NOT_FOUND）。
// 这也是 Electron 官方示例把 main.js 放在项目里的原因。
const tmpMain = path.join(ROOT, 'scripts', `.ny-actionbar-probe-${stamp}.js`);
fs.writeFileSync(tmpHtml, HTML, 'utf-8');

// ---------- 子进程脚本：在 Electron 里真量 ----------
const MAIN = `
const { app, BrowserWindow } = require('electron');
const htmlPath = process.env.NY_PROBE_HTML;
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { offscreen: true } });
  await win.loadURL('file://' + htmlPath.split('\\\\').join('/'));
  await new Promise((r) => setTimeout(r, 400));
  const js = \`(() => {
    const measure = (barId, rowId, btnId) => {
      const bar = document.getElementById(barId);
      const row = document.getElementById(rowId);
      const btn = document.getElementById(btnId);
      const cs = getComputedStyle(bar);
      const br = btn.getBoundingClientRect();
      return {
        visibility: cs.visibility, transform: cs.transform,
        transitionDuration: cs.transitionDuration, transitionProperty: cs.transitionProperty,
        pointerEvents: cs.pointerEvents, justify: cs.justifyContent,
        btnW: Math.round(br.width*100)/100, btnH: Math.round(br.height*100)/100,
        rowH: Math.round(row.getBoundingClientRect().height*100)/100,
        barW: Math.round(bar.getBoundingClientRect().width*100)/100,
      };
    };
    const out = {};
    out.aiHidden = measure('bar','aiBar','b1');
    out.userHidden = measure('barUser','userBar','u1');
    document.getElementById('bar').classList.add('is-in');
    document.getElementById('barUser').classList.add('is-in');
    out.aiReady = measure('bar','aiBar','b1');
    out.userReady = measure('barUser','userBar','u1');
    const s = document.createElement('style');
    s.textContent = 'html[data-anim-off~="all"] *, html[data-anim-off~="all"] *::before, html[data-anim-off~="all"] *::after { animation: none !important; transition: none !important; }';
    document.head.appendChild(s);
    document.documentElement.setAttribute('data-anim-off','all');
    const bar = document.getElementById('bar'), btn = document.getElementById('b1');
    // ⚠️ getComputedStyle 返回的是**活对象**（CSSStyleDeclaration），会随 DOM 变化实时更新。
    //    所以必须**立刻**把值取成基本类型存起来；存引用的话，下面 classList.add 之后
    //    再读就会拿到新值 —— 第一版就踩了这个坑，导致「关档后隐藏态」误报成 visible。
    const snap = () => {
      const cs = getComputedStyle(bar);
      return { visibility: cs.visibility, transform: cs.transform,
               btnW: Math.round(btn.getBoundingClientRect().width*100)/100 };
    };
    bar.classList.remove('is-in');
    out.animOffHidden = snap();
    bar.classList.add('is-in');
    out.animOffReady = snap();
    return out;
  })()\`;
  const data = await win.webContents.executeJavaScript(js);
  process.stdout.write('PROBE_JSON:' + JSON.stringify(data) + '\\n');
  app.exit(0);
}).catch((e) => { process.stderr.write('PROBE_ERR:' + ((e && e.stack) || e) + '\\n'); app.exit(2); });
`;
fs.writeFileSync(tmpMain, MAIN, 'utf-8');

const electronPath = require('electron');
if (!fs.existsSync(electronPath)) { console.error('找不到 electron 可执行文件：' + electronPath); process.exit(1); }

function cleanup() { for (const f of [tmpHtml, tmpMain]) { try { fs.unlinkSync(f); } catch { /* 已删 */ } } }

const probe = await new Promise((resolve, reject) => {
  // ⚠️ 必须清掉 ELECTRON_RUN_AS_NODE：某些环境（本机就是）把它设成了 1，
  // 那会让 electron.exe 以**纯 Node** 模式启动，于是 require('electron') 只有路径字符串、
  // 拿不到 app/BrowserWindow（报 "Cannot read properties of undefined (reading 'whenReady')"）。
  const env = { ...process.env, NY_PROBE_HTML: tmpHtml };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [tmpMain], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  const timer = setTimeout(() => { child.kill(); reject(new Error('探测进程超时\n' + err.slice(-600))); }, 120000);
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('close', (code) => {
    clearTimeout(timer);
    const line = out.split('\n').find((l) => l.startsWith('PROBE_JSON:'));
    if (!line) { reject(new Error('探测进程未输出（code=' + code + '）\nstdout:' + out.slice(-400) + '\nstderr:' + err.slice(-800))); return; }
    try { resolve(JSON.parse(line.slice('PROBE_JSON:'.length))); } catch (e) { reject(e); }
  });
});

section('A. 核心判定：两态尺寸相同 → 结构上不存在「放大」');
check('AI 方向：按钮宽度两态一致', probe.aiHidden.btnW === probe.aiReady.btnW, `${probe.aiHidden.btnW} vs ${probe.aiReady.btnW}`);
check('AI 方向：按钮高度两态一致', probe.aiHidden.btnH === probe.aiReady.btnH, `${probe.aiHidden.btnH} vs ${probe.aiReady.btnH}`);
check('操作栏占位宽度两态一致（无跳变）', Math.abs(probe.aiHidden.barW - probe.aiReady.barW) < 0.5, `${probe.aiHidden.barW} vs ${probe.aiReady.barW}`);

section('B. 隐藏态「完全不可见」而非「小一号残留」');
check('AI 方向隐藏态 visibility = hidden', probe.aiHidden.visibility === 'hidden', String(probe.aiHidden.visibility));
check('用户方向隐藏态 visibility = hidden', probe.userHidden.visibility === 'hidden', String(probe.userHidden.visibility));

section('C. 不存在缩放/淡入动画');
check('AI 方向隐藏态 transform = none', probe.aiHidden.transform === 'none', String(probe.aiHidden.transform));
check('AI 方向就绪态 transform = none', probe.aiReady.transform === 'none', String(probe.aiReady.transform));
check('AI 方向 transition-duration = 0s', /^0s/.test(String(probe.aiReady.transitionDuration)), String(probe.aiReady.transitionDuration));
check('未对 visibility 设过渡（否则退化成淡入）', !/visibility/i.test(String(probe.aiReady.transitionProperty)), String(probe.aiReady.transitionProperty));

section('D. 占位保留：按钮出现时气泡不跳动');
check('AI 方向行高两态一致', probe.aiHidden.rowH === probe.aiReady.rowH, `${probe.aiHidden.rowH} vs ${probe.aiReady.rowH}`);
check('用户方向行高两态一致', probe.userHidden.rowH === probe.userReady.rowH, `${probe.userHidden.rowH} vs ${probe.userReady.rowH}`);

section('E. 隐藏态点不到');
check('AI 方向隐藏态 pointer-events = none', probe.aiHidden.pointerEvents === 'none', String(probe.aiHidden.pointerEvents));
check('AI 方向就绪态 pointer-events = auto', probe.aiReady.pointerEvents === 'auto', String(probe.aiReady.pointerEvents));

section('F. 用户消息（右侧）对齐未回归');
check('用户方向就绪态 justify-content = flex-end', probe.userReady.justify === 'flex-end', String(probe.userReady.justify));

section('G. 动效关档表现一致（不会停在 0.4 倍看不见）');
check('关档后隐藏态 visibility = hidden', probe.animOffHidden.visibility === 'hidden', String(probe.animOffHidden.visibility));
check('关档后就绪态 visibility = visible', probe.animOffReady.visibility === 'visible', String(probe.animOffReady.visibility));
check('关档后 transform 始终 none', probe.animOffHidden.transform === 'none' && probe.animOffReady.transform === 'none', `${probe.animOffHidden.transform} / ${probe.animOffReady.transform}`);
check('关档后两态按钮宽度仍一致', Math.abs(probe.animOffHidden.btnW - probe.animOffReady.btnW) < 0.5, `${probe.animOffHidden.btnW} vs ${probe.animOffReady.btnW}`);

console.log('\n' + '='.repeat(58));
console.log('实测数据（AI 方向）');
console.log(`  隐藏态: visibility=${probe.aiHidden.visibility} transform=${probe.aiHidden.transform} transition=${probe.aiHidden.transitionDuration} 按钮=${probe.aiHidden.btnW}x${probe.aiHidden.btnH} 行高=${probe.aiHidden.rowH}`);
console.log(`  就绪态: visibility=${probe.aiReady.visibility} transform=${probe.aiReady.transform} transition=${probe.aiReady.transitionDuration} 按钮=${probe.aiReady.btnW}x${probe.aiReady.btnH} 行高=${probe.aiReady.rowH}`);
console.log(`  动效关档: 隐藏 ${probe.animOffHidden.visibility}/${probe.animOffHidden.transform} -> 就绪 ${probe.animOffReady.visibility}/${probe.animOffReady.transform}`);
console.log('='.repeat(58));
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  - ' + f)); }
cleanup();
process.exit(fail === 0 ? 0 : 1);