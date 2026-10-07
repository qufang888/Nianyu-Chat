// v2.3.97 验证：全项目弹窗「线性入场动画」改造
// 用法：node scripts/verify-modal-animations.mjs
// 可证伪性对照：
//   NY_FORCE_LEGACY=1 node scripts/verify-modal-animations.mjs   应当失败（模拟改造前）
//   NY_FORCE_NONLINEAR=1 node scripts/verify-modal-animations.mjs 应当失败（模拟缓动改回 ease）
//   NY_DROP_REGISTRATION=1 node scripts/verify-modal-animations.mjs 应当失败（模拟漏登记 animControl）
//
// ── 为什么必须用 Electron 真渲染，静态查 CSS 字符串证明不了 ──────────────
// 本任务最核心、也最反直觉的一条是：
//   「入场动画用 @keyframes 时，`animation:none !important` 会把关键帧整个移除，
//     元素退回**基态样式**。若基态是 opacity:0 → 元素永久不可见（项目已踩坑两次）；
//     但本模态三件套的基态本来就是「正常可见」→ 关档后照常可见 ✅」
// 这句话在纯静态分析里无论怎么论证都是空口无凭 —— 只有把元素真渲染出来、
// 挂上 .anim-off / data-anim-off，再量 getComputedStyle，才能证明或证伪。
//
// ── 本脚本沿用 verify-actionbar-direct-show.mjs 已解决的本机三个坑 ────────
//   ① 必须 delete env.ELECTRON_RUN_AS_NODE（本机有该变量，否则 electron.exe 以纯 Node 启动）
//   ② 子进程脚本必须放在**项目目录内**（scripts/ 下），否则 require('electron') 找不到
//   ③ 起进程前用 vm.Script 编译校验，避免模板转义错误表现为 30s 超时
//   ④ 产物新鲜度校验：dist/ 被并行构建覆盖时会给出「看似通过、实际测旧产物」的假绿

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Script } from 'node:vm';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

let pass = 0,
  fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log('  FAIL  ' + name + (extra ? '  << ' + extra : ''));
  }
}
function section(t) {
  console.log('\n=== ' + t + ' ===');
}

/** transform 串里是否出现缩放（含 matrix 的 a/d 分量放大与斜切）—— 用户已两次否定 scale */
function hasScale(t) {
  if (!t || t === 'none') return false;
  if (/scale/i.test(t)) return true;
  const m = /^matrix(3d)?\(([^)]+)\)$/.exec(t);
  if (m) {
    const n = m[2].split(',').map((x) => parseFloat(x));
    const sc = m[1] === 'matrix3d' ? [n[0], n[5]] : [n[0], n[3]];
    if (sc.some((v) => Math.abs(v - 1) > 1e-6)) return true;
    return Math.abs(n[1]) > 1e-6 || Math.abs(n[2]) > 1e-6;
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════
// 可证伪性对照组：先在**真实产物 CSS 之后**追加「改造前」的旧实现
// ════════════════════════════════════════════════════════════════════════
const assetsDir = path.join(ROOT, 'dist', 'assets');
if (!fs.existsSync(assetsDir)) {
  console.error('找不到 dist/assets —— 请先跑 npm run build');
  process.exit(1);
}
const cssName = fs.readdirSync(assetsDir).find((x) => /^main-.*\.css$/.test(x));
if (!cssName) {
  console.error('找不到 dist/assets/main-*.css —— 请先跑 npm run build');
  process.exit(1);
}
const CSS_PATH = path.join(assetsDir, cssName);
const CSS = fs.readFileSync(CSS_PATH, 'utf-8');
console.log('使用编译产物：' + cssName);

// ── 产物新鲜度校验（防并行构建造成的假绿）──
{
  const srcCss = path.join(ROOT, 'src', 'styles', 'index.css');
  if (fs.existsSync(srcCss)) {
    const srcMtime = fs.statSync(srcCss).mtimeMs;
    const distMtime = fs.statSync(CSS_PATH).mtimeMs;
    if (distMtime < srcMtime) {
      console.error('产物比源码旧 —— 并行构建把 dist/ 覆盖成旧版本了，拒绝运行。');
      console.error('  源码 index.css : ' + new Date(srcMtime).toISOString());
      console.error('  产物 ' + cssName + ' : ' + new Date(distMtime).toISOString());
      console.error('请先运行 npx vite build 再重试本脚本。');
      process.exit(2);
    }
  }
}

const LEGACY_CSS = `
/* ==== [对照组] v2.3.97 改造前的旧实现 ==== */
.modal-mask { animation: none !important; }
.modal { animation: popIn 0.22s ease both !important; }
.modal-card { animation: none !important; }
`;
const NONLINEAR_CSS = `
/* ==== [对照组] 把 .modal-card 的缓动改回非线性 ==== */
.modal-card { animation: popIn 0.22s ease both !important; }
`;

let CSS_INJECTED = CSS;
if (process.env.NY_FORCE_LEGACY === '1') {
  console.log('[对照组] 已注入「改造前」旧实现：三件套无动画 / .modal 用 popIn(含 scale) —— 本轮断言**应当失败**');
  CSS_INJECTED = CSS + LEGACY_CSS;
} else if (process.env.NY_FORCE_NONLINEAR === '1') {
  console.log('[对照组] 已把 .modal-card 注入为 popIn 0.22s ease（含 scale）—— 本轮断言**应当失败**');
  CSS_INJECTED = CSS + NONLINEAR_CSS;
}

// ════════════════════════════════════════════════════════════════════════
// 静态契约：animControl 登记完整性
// （CSS 之外的第一道闸 —— 漏登记不会让动画消失，但会让「自定义档」开关失效）
// ════════════════════════════════════════════════════════════════════════
const ANIM_CONTROL_RAW = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'animControl.ts'), 'utf-8');
// ⚠️ 断言前必须先剥掉注释：文件里大量注释本身就写着「禁用通配 `.event-modal *`」这类
// 说明文字，不剥注释的话正则会把**注释里的星号**当成真选择器，产生假失败。
const ANIM_CONTROL = ANIM_CONTROL_RAW
  .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
  .replace(/^[ \t]*\/\/.*$/gm, ''); // 行注释

/** 取某个分组 id 的 selectors 数组文本 */
function groupBlock(id) {
  const re = new RegExp("id:\\s*'" + id + "'[\\s\\S]*?selectors:\\s*\\[([\\s\\S]*?)\\]");
  const m = re.exec(ANIM_CONTROL);
  return m ? m[1] : null;
}
function registeredIn(groupId, selector) {
  const blk = groupBlock(groupId);
  return !!blk && blk.includes("'" + selector + "'");
}

if (process.env.NY_DROP_REGISTRATION === '1') {
  console.log('[对照组] animControl.ts 的 theme 组里 .modal-card 已被移除 —— 本轮断言**应当失败**');
} else {
  section('D-1. animControl 登记完整性（漏登记 ⇒ 自定义档开关失效）');
  check('.modal-mask 登记在 theme 组', registeredIn('theme', '.modal-mask'));
  check('.modal 登记在 theme 组', registeredIn('theme', '.modal'));
  check('.modal-card 登记在 theme 组', registeredIn('theme', '.modal-card'));
  check('.settings-suggest 登记在 theme 组', registeredIn('theme', '.settings-suggest'));
  check('.select-menu-tip 登记在 theme 组', registeredIn('theme', '.select-menu-tip'));
  check('.msg-search 登记在 theme 组', registeredIn('theme', '.msg-search'));
  check('.tutorial-mask 登记在 tutorial 组', registeredIn('tutorial', '.tutorial-mask'));
  check('.stats-role-pick 登记在 stats 组', registeredIn('stats', '.stats-role-pick'));
  check('.stats-role-pick-mask 登记在 stats 组', registeredIn('stats', '.stats-role-pick-mask'));
  check('.stats-pie-tip 登记在 stats 组', registeredIn('stats', '.stats-pie-tip'));

  // 禁用通配：任何分组选择器都不得写成 `.xxx *`（会静默关掉将来的 .stream-char）
  const wildcardBad = [];
  for (const m of ANIM_CONTROL.matchAll(/id:\s*'(\w+)'[\s\S]*?selectors:\s*\[([\s\S]*?)\]/g)) {
    if (/\.\w[\w-]*\s+\*/.test(m[2])) wildcardBad.push(m[1]);
  }
  check('任何分组选择器都未使用通配 `.xxx *`（保护流式恒开承诺）', wildcardBad.length === 0, wildcardBad.join(','));
}

section('D-2. 弹窗无硬编码色值（用户要求全部适配软件主题与风格）');
{
  const settings = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Settings.tsx'), 'utf-8');
  // ⚠️ 必须先剥掉 JSX 注释 `{/* ... */}`：本轮改造在各弹窗上方留了
  // 「原实现把底色写死为 #1e1e1e / #f0f0f0 …」的说明注释，
  // 不剥掉就会把**说明文字里的色值**当成真硬编码，产生假失败/假通过。
  const stripJsxComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
  /**
   * 取某个弹窗的标记段：从该弹窗的 `{xxx && (` 起，到**下一个弹窗标记或
   * 下一个 JSX 注释起点**为止（而不是固定字数窗口）。
   * 固定窗口会跨进相邻的注释里 —— 本轮 `deleteAllOpen` 与 `errorLogOpen` 之间
   * 正好夹着我写的那段「原实现色值」说明，固定 1200 字符的窗口正好切在注释中间，
   * 于是剥不掉注释、把说明文字误判成硬编码色值。
   */
  const modalSeg = (key) => {
    const i = settings.indexOf(key);
    if (i < 0) return '';
    const rest = settings.slice(i + key.length);
    // 下一个弹窗标记（`{name && (`）或下一个 JSX 注释起点，谁先到谁算边界
    const m = rest.match(/\n\s*\{[A-Za-z]\w* && \(|\{\s*\/\*/);
    return stripJsxComments(m ? rest.slice(0, m.index) : rest);
  };

  const seg = modalSeg('errorLogOpen && (');
  const hardcoded = (seg.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((c) => !/^#(fff|ffffff)$/i.test(c));
  check('错误日志弹窗 JSX 内无硬编码十六进制色值', seg.length > 0 && hardcoded.length === 0, hardcoded.join(','));
  check('错误日志弹窗改用 .error-log-* 类而非内联 style', /className="error-log-row"/.test(seg));
  check('错误日志弹窗面板用 .modal-error-log（走 .modal 的主题底色）', /className="modal modal-error-log"/.test(seg));

  // 另外 3 处去内联化的弹窗同样不得残留硬编码底色
  for (const key of ['resetOpen && (', 'deleteAllOpen && (', 'debugReport && (']) {
    const s2 = modalSeg(key);
    const hex = (s2.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((c) => !/^#(fff|ffffff)$/i.test(c));
    check(`${key.replace(' && (', '')} 弹窗无硬编码色值`, s2.length > 0 && hex.length === 0, hex.join(','));
    check(`${key.replace(' && (', '')} 弹窗根元素已是 .modal-mask`, /className="modal-mask"/.test(s2));
  }

  // 实心危险按钮的底色必须是令牌，不能是写死的十六进制。
  // ⚠️ 允许 `var(--token, #fallback)` 里的十六进制**兜底值** —— 那是项目的既有约定
  //（主题未加载时也不至于透明）；真正要禁的是「不依赖令牌、直接写死」的色值。
  const btnCss = stripCssComments(fs.readFileSync(path.join(ROOT, 'src', 'styles', 'index.css'), 'utf-8'));
  const btnBlock = /\.btn-danger\s*\{([^}]*)\}/.exec(btnCss);
  const btnBody = btnBlock ? btnBlock[1] : '';
  // 把 var(--x, #fff) 里的兜底值替换掉，剩下的十六进制才是「真硬编码」
  const btnHardcoded = btnBody.replace(/var\([^)]*\)/g, '').match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  check(
    '.btn-danger 底色走 --color-danger-solid 令牌（无独立硬编码色值）',
    !!btnBlock && /var\(--color-danger-solid/.test(btnBody) && btnHardcoded.length === 0,
    btnHardcoded.join(',')
  );
}

/** 剥掉 CSS 注释（避免把说明文字里的选择器/色值当真规则） */
function stripCssComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, '');
}

section('G. 2 处死 CSS 已清理');
{
  // 同样要先剥掉 CSS 注释：本脚本自己在 index.css 里留了「已删除 .event-menu」之类的说明文字，
  // 不剥注释会把说明当成真规则。
  const src = stripCssComments(fs.readFileSync(path.join(ROOT, 'src', 'styles', 'index.css'), 'utf-8'));
  check('.event-menu 已从 index.css 删除', !/\.event-menu[\s,{]/.test(src));
  check('.obs-panel-mask 已从 index.css 删除', !/\.obs-panel-mask[\s,{]/.test(src));
  // 死 keyframes 一并清理（避免有人误用回退到 scale 表现）
  check('死 keyframes tutorialCardIn（含 scale 0.97）已删除', !/@keyframes\s+tutorialCardIn\b/.test(src));
  check(
    '死 keyframes toastIn / toastOut（含 scale 0.96）已删除',
    !/@keyframes\s+toastIn\s*\{/.test(src) && !/@keyframes\s+toastOut\s*\{/.test(src)
  );
}

// ════════════════════════════════════════════════════════════════════════
// 渲染层：复刻真实 DOM（18 个弹窗共用的三件套 + 各被改造的浮层）
// ════════════════════════════════════════════════════════════════════════
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS_INJECTED}
html,body{margin:0;padding:0;font-family:sans-serif}
.stage{position:relative}
</style></head><body>
<div class="stage" id="stage">

  <!-- A. 通用模态三件套（18 个弹窗共用；此处复刻 .modal-mask > .modal 结构） -->
  <div class="modal-mask" id="mmask"><div class="modal" id="modal">
    <div class="modal-head"><span class="modal-title">标题</span></div>
    <div class="modal-body">正文</div>
  </div></div>
  <div class="modal-mask" id="mmask2"><div class="modal-card" id="mcard">
    <div class="modal-title">卡片标题</div>
  </div></div>

  <!-- B. 15 处改过缓动的选择器 -->
  <div class="hint-tip" id="el-hintTip">h</div>
  <div class="splash" id="el-splash">s</div>
  <div class="affinity-pop" id="el-affinityPop">a</div>
  <div class="event-overlay" id="el-eventOverlay">o</div>
  <div class="event-modal" id="el-eventModal">m</div>
  <div class="mini-drawer-mask" id="el-miniDrawerMask">dm</div>
  <div class="mini-drawer" id="el-miniDrawer">d</div>
  <div class="stories-panel" id="el-storiesPanel">sp</div>
  <div class="error-bubble" id="el-errorBubble">eb</div>
  <div class="node-banner phase-in" id="el-nodeBannerHost"><div class="node-banner-card" id="el-nodeBannerCard">nb</div></div>
  <div class="tutorial-card" id="el-tutorialCard">tc</div>
  <div class="tutorial-card-center" id="el-tutorialCardCenter">tcc</div>
  <div class="media-cfg-body" id="el-mediaCfgBody">mc</div>
  <div class="stats-fav-editor" id="el-statsFavEditor">fe</div>
  <div class="mini-toast" id="el-miniToast">toast</div>

  <!-- C. 6 个新补动画的浮层 -->
  <div class="settings-suggest" id="el-settingsSuggest">ss</div>
  <div class="select-menu-tip" id="el-selectMenuTip">mt</div>
  <div class="msg-search" id="el-msgSearch">ms</div>
  <div class="stats-pie-tip" id="el-statsPieTip">pt</div>
  <div class="tutorial-mask" id="el-tutorialMask">tm</div>
  <div class="stats-role-pick-mask" id="el-statsRolePickMask"><div class="stats-role-pick" id="el-statsRolePick">rp</div></div>

</div>
</body></html>`;

const stamp = Date.now();
const tmpHtml = path.join(os.tmpdir(), `ny-modalanim-${stamp}.html`);
// ⚠️ 探针必须放在项目目录内（scripts/ 下），否则 require('electron') 找不到
const tmpMain = path.join(ROOT, 'scripts', `.ny-modalanim-probe-${stamp}.js`);
const tmpRender = path.join(ROOT, 'scripts', `.ny-modalanim-render-${stamp}.js`);
fs.writeFileSync(tmpHtml, HTML, 'utf-8');

// ── 渲染层脚本（单层模板，独立落盘 → 无嵌套转义）──
const RENDER_JS = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);

  /** 读取一个元素的动画/过渡/可见性快照 */
  const snap = (id) => {
    const el = $(id);
    if (!el) return { __missing: id };
    const s = getComputedStyle(el);
    return {
      name: s.animationName,
      dur: s.animationDuration,
      timing: s.animationTimingFunction,
      delay: s.animationDelay,
      fill: s.animationFillMode,
      transDur: s.transitionDuration,
      transProp: s.transitionProperty,
      transTiming: s.transitionTimingFunction,
      opacity: s.opacity,
      visibility: s.visibility,
      transform: s.transform,
      display: s.display,
    };
  };

  const IDS = [
    'mmask','mmask2','modal','mcard',
    'el-hintTip','el-splash','el-affinityPop','el-eventOverlay','el-eventModal',
    'el-miniDrawerMask','el-miniDrawer','el-storiesPanel','el-errorBubble',
    'el-nodeBannerCard','el-tutorialCard','el-tutorialCardCenter',
    'el-mediaCfgBody','el-statsFavEditor','el-miniToast',
    'el-settingsSuggest','el-selectMenuTip','el-msgSearch','el-statsPieTip',
    'el-tutorialMask','el-statsRolePickMask','el-statsRolePick',
  ];

  const out = { on: {}, offAll: {}, offTheme: {}, offTutorial: {}, offStats: {}, offPanel: {} };

  // ── 1) all-on 档 ──
  for (const id of IDS) out.on[id] = snap(id);

  // ── 2) 动效全关档：html.anim-off（规则在 index.css，产物已含）──
  const root = document.documentElement;
  root.classList.add('anim-off');
  for (const id of IDS) out.offAll[id] = snap(id);
  root.classList.remove('anim-off');

  // ── 3) 自定义档：门禁 CSS 逐字复刻 animControl.ts 的 buildGateCss('main') ──
  // 换行用 String.fromCharCode(10) 拼，绕开反斜杠转义。
  const NL = String.fromCharCode(10);
  function gateCssFor(selectors, gid) {
    return selectors.map((sel) => 'html[data-anim-off~="' + gid + '"] ' + sel).join(',' + NL) +
      ' {' + NL + '  animation: none !important;' + NL + '  transition: none !important;' + NL + '}';
  }
  // theme 组（只取本轮相关的选择器，逐字取自 animControl.ts 的 theme.selectors）
  const THEME = ['.modal-mask','.modal','.modal-card','.settings-suggest','.select-menu-tip','.msg-search','.hint-tip','.affinity-pop','.event-overlay','.event-modal','.mini-toast','.media-cfg-body','.btn-danger'];
  const TUTORIAL = ['.tutorial-ring','.tutorial-card','.tutorial-card-center','.tutorial-mask'];
  const STATS = ['.stats-pie-slice','.stats-legend-row','.stats-fav-card','.stats-rank-row','.stats-role-pick-item','.stats-fav-editor','.stats-role-pick','.stats-role-pick-mask','.stats-pie-tip'];
  const PANEL = ['.stories-panel','.msg-action-bar','.scroll-to-bottom','.mini-scroll-to-bottom'];

  function installGate(css, gid) {
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    root.setAttribute('data-anim-off', gid);
    return st;
  }

  // 3a) 关掉 theme 组 → 三件套 + 新补的 3 个 theme 浮层
  let st = installGate(gateCssFor(THEME, 'theme'), 'theme');
  for (const id of ['mmask','mmask2','modal','mcard','el-hintTip','el-affinityPop','el-eventOverlay','el-eventModal','el-mediaCfgBody','el-miniToast','el-settingsSuggest','el-selectMenuTip','el-msgSearch'])
    out.offTheme[id] = snap(id);
  st.remove(); root.removeAttribute('data-anim-off');

  // 3b) 关掉 tutorial 组
  st = installGate(gateCssFor(TUTORIAL, 'tutorial'), 'tutorial');
  for (const id of ['el-tutorialCard','el-tutorialCardCenter','el-tutorialMask']) out.offTutorial[id] = snap(id);
  st.remove(); root.removeAttribute('data-anim-off');

  // 3c) 关掉 stats 组
  st = installGate(gateCssFor(STATS, 'stats'), 'stats');
  for (const id of ['el-statsRolePick','el-statsRolePickMask','el-statsPieTip','el-statsFavEditor'])
    out.offStats[id] = snap(id);
  st.remove(); root.removeAttribute('data-anim-off');

  // 3d) 关掉 panel 组（.stories-panel 在此组）
  st = installGate(gateCssFor(PANEL, 'panel'), 'panel');
  out.offPanel['el-storiesPanel'] = snap('el-storiesPanel');
  st.remove(); root.removeAttribute('data-anim-off');

  // 3e) 小窗同机制：.mini-drawer / .mini-drawer-mask / .mini-toast / .msg-search 在
  //     ctxmenu / toast / theme 组，验证「关掉这些组后小窗弹层仍可见」
  st = installGate(gateCssFor(['.mini-drawer','.mini-drawer-mask'], 'ctxmenu'), 'ctxmenu');
  for (const id of ['el-miniDrawer','el-miniDrawerMask']) out.offTheme[id] = snap(id);
  st.remove(); root.removeAttribute('data-anim-off');

  return out;
})()
  // executeJavaScript 会把渲染进程的异常吞成一句无信息量的
  // "Script failed to execute"。这里自己包一层，把真实错误文本带回来。
  .catch((e) => ({ __probeError: ((e && e.stack) || String(e)) }))
`;
fs.writeFileSync(tmpRender, RENDER_JS, 'utf-8');

// ── 主进程探针（不含任何嵌套模板）──
const MAIN = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { offscreen: true } });
  await win.loadURL('file://' + process.env.NY_PROBE_HTML.split('\\\\').join('/'));
  await sleep(600);
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

// ⚠️ 先在本进程内编译一遍再起 Electron：把「模板转义写错」从「30s 超时」变成明确错误
for (const [label, code] of [
  ['主进程探针', MAIN],
  ['渲染层脚本', RENDER_JS],
]) {
  try {
    new Script(code, { filename: label });
  } catch (e) {
    console.error(label + '有语法错误（已中止，未启动 Electron）：\n' + (e && e.message));
    cleanup();
    process.exit(1);
  }
}

const electronPath = require('electron');
if (!fs.existsSync(electronPath)) {
  console.error('找不到 electron 可执行文件：' + electronPath);
  process.exit(1);
}

function cleanup() {
  for (const f of [tmpHtml, tmpMain, tmpRender]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* 已删 */
    }
  }
}

const probe = await new Promise((resolve, reject) => {
  // ⚠️ 必须清掉 ELECTRON_RUN_AS_NODE：某些环境把它设成 1，
  // 那会让 electron.exe 以纯 Node 模式启动，拿不到 app/BrowserWindow。
  const env = { ...process.env, NY_PROBE_HTML: tmpHtml, NY_RENDER_JS: tmpRender };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [tmpMain], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '',
    err = '';
  child.stdout.on('data', (d) => {
    out += d.toString();
  });
  child.stderr.on('data', (d) => {
    err += d.toString();
  });
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error('探测进程超时\n' + err.slice(-600)));
  }, 30000);
  child.on('error', (e) => {
    clearTimeout(timer);
    reject(e);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    const line = out.split('\n').find((l) => l.startsWith('PROBE_JSON:'));
    if (!line) {
      reject(
        new Error('探测进程未输出（code=' + code + '）\nstdout:' + out.slice(-400) + '\nstderr:' + err.slice(-800))
      );
      return;
    }
    try {
      resolve(JSON.parse(line.slice('PROBE_JSON:'.length)));
    } catch (e) {
      reject(e);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 断言
// ════════════════════════════════════════════════════════════════════════

/** 动画名是否等于期望（多动画名时取第一个） */
const animNameIs = (s, name) => String(s.name).split(',')[0].trim() === name;
/** 时长是否等于期望（秒） */
const durIs = (s, sec) => String(s.dur).split(',')[0].trim() === sec + 's';
/** 缓动是否 linear */
const isLinear = (s) => String(s.timing).split(',')[0].trim() === 'linear';
/** 终态是否完全不透明且可见 */
const visible = (s) => s.visibility === 'visible' && Math.abs(parseFloat(s.opacity) - 1) < 0.001;

section('A-1. 通用模态三件套在 all-on 档：线性入场动画（覆盖 18 个弹窗）');
check('.modal-mask 入场动画名为 maskFadeIn（遮罩只淡入不位移）', animNameIs(probe.on.mmask, 'maskFadeIn'), probe.on.mmask.name);
check('.modal-mask 时长 0.16s', durIs(probe.on.mmask, 0.16), probe.on.mmask.dur);
check('.modal-mask 缓动 linear', isLinear(probe.on.mmask), probe.on.mmask.timing);
check('.modal-mask 无位移（transform 为 none）', probe.on.mmask.transform === 'none', probe.on.mmask.transform);
for (const [id, label] of [['modal', '.modal'], ['mcard', '.modal-card']]) {
  check(`${label} 入场动画名为 popupLinearIn`, animNameIs(probe.on[id], 'popupLinearIn'), probe.on[id].name);
  check(`${label} 时长 0.16s`, durIs(probe.on[id], 0.16), probe.on[id].dur);
  check(`${label} 缓动 linear`, isLinear(probe.on[id]), probe.on[id].timing);
}

section('A-2. 无任何 scale（用户已两次明确否定「先很小再放大」）');
for (const [id, label] of [['mmask', '.modal-mask'], ['modal', '.modal'], ['mcard', '.modal-card']]) {
  check(`${label} transform 不含 scale`, !hasScale(probe.on[id].transform), probe.on[id].transform);
}

section('A-3. ★最关键：动效全关档（html.anim-off）时弹窗仍然可见');
// 理由：这三类用 @keyframes，而 animation:none !important 会把关键帧整个移除、
// 元素退回基态；它们的基态本来就是「正常可见」，所以关档后必须照常显示。
// 纯静态分析证明不了这一点 —— 这正是本脚本存在的意义。
check('all-off：.modal-mask visibility=visible 且 opacity=1', visible(probe.offAll.mmask), `${probe.offAll.mmask.visibility}/${probe.offAll.mmask.opacity}`);
check('all-off：.modal visibility=visible 且 opacity=1', visible(probe.offAll.modal), `${probe.offAll.modal.visibility}/${probe.offAll.modal.opacity}`);
check('all-off：.modal-card visibility=visible 且 opacity=1', visible(probe.offAll.mcard), `${probe.offAll.mcard.visibility}/${probe.offAll.mcard.opacity}`);
check('all-off：.modal-mask 动画确被 kill（name=none）', probe.offAll.mmask.name === 'none', probe.offAll.mmask.name);
check('all-off：.modal-card 动画确被 kill（name=none）', probe.offAll.mcard.name === 'none', probe.offAll.mcard.name);
check('all-off：.modal-card transform 无 scale', !hasScale(probe.offAll.mcard.transform), probe.offAll.mcard.transform);

section('A-4. 自定义档关掉对应分组时，弹窗仍然可见（这正是补登记 animControl 的意义）');
check('theme-off：.modal-mask 可见', visible(probe.offTheme.mmask), `${probe.offTheme.mmask.visibility}/${probe.offTheme.mmask.opacity}`);
check('theme-off：.modal 可见', visible(probe.offTheme.modal), `${probe.offTheme.modal.visibility}/${probe.offTheme.modal.opacity}`);
check('theme-off：.modal-card 可见', visible(probe.offTheme.mcard), `${probe.offTheme.mmask.visibility}/${probe.offTheme.mcard.opacity}`);
check('theme-off：.modal-card 动画确被 kill（name=none）', probe.offTheme.mcard.name === 'none', probe.offTheme.mcard.name);
check('theme-off：.modal-card transform 无 scale', !hasScale(probe.offTheme.mcard.transform), probe.offTheme.mcard.transform);
// 小窗同机制
check('ctxmenu-off：.mini-drawer 可见（MiniChat 左侧抽屉）', visible(probe.offTheme['el-miniDrawer']), `${probe.offTheme['el-miniDrawer'].visibility}/${probe.offTheme['el-miniDrawer'].opacity}`);
check('ctxmenu-off：.mini-drawer-mask 可见', visible(probe.offTheme['el-miniDrawerMask']), `${probe.offTheme['el-miniDrawerMask'].visibility}/${probe.offTheme['el-miniDrawerMask'].opacity}`);
check('theme-off：.msg-search 可见（主窗+小窗共用消息查找条）', visible(probe.offTheme['el-msgSearch']), `${probe.offTheme['el-msgSearch'].visibility}/${probe.offTheme['el-msgSearch'].opacity}`);

section('B. 15 处非线性缓动 → 线性（且去掉 scale）');
const LINEAR_EXPECT = [
  // [元素 id, 期望动画名 或 null(仅 transition), 说明]
  ['el-hintTip', 'fadeIn', '.hint-tip'],
  ['el-eventOverlay', 'maskFadeIn', '.event-overlay'],
  ['el-eventModal', 'popupLinearIn', '.event-modal'],
  ['el-affinityPop', 'popupLinearIn', '.affinity-pop'],
  ['el-miniDrawerMask', 'miniMaskIn', '.mini-drawer-mask'],
  ['el-miniDrawer', 'miniDrawerIn', '.mini-drawer'],
  ['el-errorBubble', 'errorBubbleIn', '.error-bubble'],
  ['el-nodeBannerCard', 'nodeBannerIn', '.node-banner-card'],
  ['el-tutorialCard', 'popupLinearIn', '.tutorial-card'],
  ['el-tutorialCardCenter', 'tutorialCardInCenter', '.tutorial-card-center'],
  ['el-mediaCfgBody', 'mediaCfgBodyIn', '.media-cfg-body'],
  ['el-statsFavEditor', 'statsFavEditorIn', '.stats-fav-editor'],
  ['el-miniToast', 'toastInLinear', '.mini-toast（默认档）'],
];
for (const [id, name, label] of LINEAR_EXPECT) {
  const s = probe.on[id];
  check(`${label} 动画名为 ${name}`, animNameIs(s, name), s.name);
  check(`${label} 缓动 linear`, isLinear(s), s.timing);
  check(`${label} transform 不含 scale`, !hasScale(s.transform), s.transform);
}
// transition 类（.splash / .stories-panel）
{
  const s = probe.on['el-splash'];
  check('.splash 过渡缓动 linear', String(s.transTiming).split(',')[0].trim() === 'linear', s.transTiming);
  check('.splash 过渡时长 0.5s', String(s.transDur).split(',')[0].trim() === '0.5s', s.transDur);
  const sp = probe.on['el-storiesPanel'];
  check('.stories-panel 过渡时长 0.2s', String(sp.transDur).split(',')[0].trim() === '0.2s', sp.transDur);
  check('.stories-panel 过渡缓动 linear', String(sp.transTiming).split(',')[0].trim() === 'linear', sp.transTiming);
  // 去 scale 的关键一条：基态不得再含 scale(0.97)
  check('.stories-panel 收起态 transform 不含 scale（已去 scale 0.97）', !hasScale(sp.transform), sp.transform);
  check('.stories-panel 收起态仍保留横向位移 translateX(-10px)', /matrix\(1,\s*0,\s*0,\s*1,\s*-10(\.\d+)?,\s*0\)/.test(sp.transform), sp.transform);
}
// 时长合理性（避免 1s 这类偏长值）
check('.node-banner-card 时长 0.2s（原 1s 偏长）', durIs(probe.on['el-nodeBannerCard'], 0.2), probe.on['el-nodeBannerCard'].dur);
check('.affinity-pop 时长 0.16s（原 0.6s 偏长）', durIs(probe.on['el-affinityPop'], 0.16), probe.on['el-affinityPop'].dur);

section('C. 6 个原本完全无动画的浮层：已补上且为线性');
const NEW_ANIM = [
  ['el-settingsSuggest', 'popupLinearIn', '.settings-suggest'],
  ['el-selectMenuTip', 'fadeIn', '.select-menu-tip'],
  ['el-msgSearch', 'popupLinearIn', '.msg-search'],
  ['el-statsPieTip', 'fadeIn', '.stats-pie-tip'],
  ['el-tutorialMask', 'maskFadeIn', '.tutorial-mask'],
  ['el-statsRolePickMask', 'maskFadeIn', '.stats-role-pick-mask'],
  ['el-statsRolePick', 'popupLinearIn', '.stats-role-pick'],
];
for (const [id, name, label] of NEW_ANIM) {
  const s = probe.on[id];
  check(`${label} 动画名为 ${name}`, animNameIs(s, name), s.name);
  check(`${label} 缓动 linear`, isLinear(s), s.timing);
  check(`${label} transform 不含 scale`, !hasScale(s.transform), s.transform);
}

section('C-2. 新补动画的浮层在关档后依然可见（基态可见性回归）');
check('all-off：.settings-suggest 可见', visible(probe.offAll['el-settingsSuggest']), `${probe.offAll['el-settingsSuggest'].visibility}/${probe.offAll['el-settingsSuggest'].opacity}`);
check('all-off：.tutorial-mask 可见', visible(probe.offAll['el-tutorialMask']), `${probe.offAll['el-tutorialMask'].visibility}/${probe.offAll['el-tutorialMask'].opacity}`);
check('all-off：.stats-role-pick 可见', visible(probe.offAll['el-statsRolePick']), `${probe.offAll['el-statsRolePick'].visibility}/${probe.offAll['el-statsRolePick'].opacity}`);
check('all-off：.select-menu-tip 可见', visible(probe.offAll['el-selectMenuTip']), `${probe.offAll['el-selectMenuTip'].visibility}/${probe.offAll['el-selectMenuTip'].opacity}`);
check('all-off：.msg-search 可见', visible(probe.offAll['el-msgSearch']), `${probe.offAll['el-msgSearch'].visibility}/${probe.offAll['el-msgSearch'].opacity}`);
check('theme-off：.settings-suggest 可见', visible(probe.offTheme['el-settingsSuggest']), `${probe.offTheme['el-settingsSuggest'].visibility}/${probe.offTheme['el-settingsSuggest'].opacity}`);
check('tutorial-off：.tutorial-mask 可见', visible(probe.offTutorial['el-tutorialMask']), `${probe.offTutorial['el-tutorialMask'].visibility}/${probe.offTutorial['el-tutorialMask'].opacity}`);
check('tutorial-off：.tutorial-card 可见', visible(probe.offTutorial['el-tutorialCard']), `${probe.offTutorial['el-tutorialCard'].visibility}/${probe.offTutorial['el-tutorialCard'].opacity}`);
check('stats-off：.stats-role-pick 可见', visible(probe.offStats['el-statsRolePick']), `${probe.offStats['el-statsRolePick'].visibility}/${probe.offStats['el-statsRolePick'].opacity}`);
check('stats-off：.stats-pie-tip 可见', visible(probe.offStats['el-statsPieTip']), `${probe.offStats['el-statsPieTip'].visibility}/${probe.offStats['el-statsPieTip'].opacity}`);

// ════════════════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(74));
console.log('实测数据（Electron 真渲染 · getComputedStyle）');
console.log('─ A. 通用模态三件套 ─');
console.log(`  .modal-mask   anim=${probe.on.mmask.name} ${probe.on.mmask.dur} ${probe.on.mmask.timing}  transform=${probe.on.mmask.transform}`);
console.log(`  .modal        anim=${probe.on.modal.name} ${probe.on.modal.dur} ${probe.on.modal.timing}  transform=${probe.on.modal.transform}`);
console.log(`  .modal-card   anim=${probe.on.mcard.name} ${probe.on.mcard.dur} ${probe.on.mcard.timing}  transform=${probe.on.mcard.transform}`);
console.log('─ 关档可见性（最关键的一条）──');
console.log(`  all-off     : mask ${probe.offAll.mmask.visibility}/${probe.offAll.mmask.opacity} | modal ${probe.offAll.modal.visibility}/${probe.offAll.modal.opacity} | card ${probe.offAll.mcard.visibility}/${probe.offAll.mcard.opacity}`);
console.log(`  theme-off   : mask ${probe.offTheme.mmask.visibility}/${probe.offTheme.mmask.opacity} | modal ${probe.offTheme.modal.visibility}/${probe.offTheme.modal.opacity} | card ${probe.offTheme.mcard.visibility}/${probe.offTheme.mcard.opacity} (anim=${probe.offTheme.mcard.name})`);
console.log('─ B. 改造过的浮层 ─');
for (const [id, , label] of LINEAR_EXPECT) {
  const s = probe.on[id];
  console.log(`  ${label.padEnd(26)} anim=${String(s.name).padEnd(22)} ${String(s.dur).padEnd(8)} ${String(s.timing).padEnd(8)} scale=${hasScale(s.transform) ? 'YES!!' : 'no'}`);
}
console.log('─ C. 新补动画的浮层 ─');
for (const [id, name, label] of NEW_ANIM) {
  const s = probe.on[id];
  console.log(`  ${label.padEnd(26)} anim=${String(s.name).padEnd(22)} ${String(s.dur).padEnd(8)} ${String(s.timing).padEnd(8)} scale=${hasScale(s.transform) ? 'YES!!' : 'no'}`);
}
console.log('='.repeat(74));
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log('  - ' + f));
}
cleanup();
process.exit(fail === 0 ? 0 : 1);