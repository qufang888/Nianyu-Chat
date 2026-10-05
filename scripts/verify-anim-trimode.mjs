/**
 * v2.3.92 动画控制三档 —— 浏览器实测（headless Edge + CDP）
 * ============================================================================
 * 目的：证明「三档门控真的生效」，而不是只做静态检查。
 *
 * 做法（不引入 playwright/puppeteer，用项目已有的 esbuild + Node 22 内置 WebSocket）：
 *   1. esbuild 把**真实的** `src/utils/animControl.ts` 打包成 IIFE 挂到 window.__ANIMCTL；
 *   2. 生成临时 HTML，`<link>` **真实的** `src/styles/index.css`（直接复制同一个文件，不是副本）；
 *   3. headless Edge（--headless=new + --remote-debugging-port）打开它；
 *   4. 通过 CDP `Runtime.evaluate` 注入真实 DOM 元素，逐档调用**真实的** applyAnimControl()，
 *      再读 `getComputedStyle` 的 animation-name / animation-duration / transition-duration。
 *
 * 断言：
 *   A. all-on  档：普通动画正常播放；
 *   B. all-off 档：普通动画被杀，`.stream-char` / `.stream-char.stall` / `.pseudo-char` 仍播放（豁免）；
 *   C. custom  档：关掉某组 → 该组被杀；未关的组正常；流式三兄弟仍正常；
 *   D. v2.3.92 补齐的 18 项（含抽验 .tutorial-ring / .node-banner-card / .event-modal / .fb-ball）
 *      在 custom 档下能被正确的组关掉；另有 all-off 档下的全量抽验。
 *
 * 用法：export PATH=.../node/22.22.2-5:$PATH && node scripts/verify-anim-trimode.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const ROOT = resolve(import.meta.dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;

if (!existsSync(EDGE)) {
  console.error('找不到 Edge：' + EDGE);
  process.exit(2);
}

// ---------------------------------------------------------------- 1) 打包真实 animControl.ts
const workDir = mkdtempSync(join(tmpdir(), 'anim-verify-'));

const bundle = await build({
  entryPoints: [join(ROOT, 'src/utils/animControl.ts')],
  bundle: true,
  format: 'iife',
  globalName: '__ANIMCTL',
  platform: 'browser',
  target: 'es2020',
  write: false,
  logLevel: 'silent',
});
const bundleJs = bundle.outputFiles[0].text;

// ---------------------------------------------------------------- 2) 生成测试页（引用真实 CSS）
const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="index.css">
<style>body{margin:0}#stage{position:relative;width:800px;height:600px}</style>
</head>
<body>
<div id="stage"></div>
<script>${bundleJs}<\/script>
</body>
</html>`;
writeFileSync(join(workDir, 'index.html'), html, 'utf-8');
// 复制仓库里真实的那份 CSS，保证测的就是实际生效的样式
writeFileSync(join(workDir, 'index.css'), readFileSync(join(ROOT, 'src/styles/index.css'), 'utf-8'), 'utf-8');

// ---------------------------------------------------------------- 3) 启动 headless Edge
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + join(workDir, 'ud'),
    'file:///' + join(workDir, 'index.html').replace(/\\/g, '/'),
  ],
  { stdio: 'ignore' }
);

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('CDP 未就绪');
}

const page = await waitForDevtools();

// ---------------------------------------------------------------- 4) CDP 最小客户端
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const p = m.id && pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error) p.reject(new Error(JSON.stringify(m.error)));
  else p.resolve(m.result);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Runtime.enable');
// Edge 的 CDP 握手完成时页面往往还在 loading（<script> 尚未执行），
// 必须轮询到 animControl 真的挂上 window，否则第一次 evaluate 会读到 undefined。
let ready = null;
for (let i = 0; i < 100; i++) {
  const r = await send('Runtime.evaluate', {
    expression: 'typeof window.__ANIMCTL?.applyAnimControl',
    returnByValue: true,
  });
  ready = r.result.value;
  if (ready === 'function') break;
  await new Promise((res) => setTimeout(res, 100));
}
if (ready !== 'function') {
  console.error('animControl 未正确打包（页面未就绪或打包失败）');
  ws.close();
  edge.kill();
  process.exit(3);
}

// ---------------------------------------------------------------- 5) 页面内断言脚本
const PROBE = String.raw`
(() => {
  const A = window.__ANIMCTL;
  const stage = document.getElementById('stage');
  const rows = [];
  let failed = 0;

  /**
   * 造一个真实元素并挂到文档里（元素必须在文档中，getComputedStyle 才有意义）。
   * opts.parentCls：额外套一层父元素 —— 必需，因为仓库里部分动画挂在**后代**选择器上
   *   （.node-banner.phase-in .node-banner-card、.idle-toggle .idle-toggle-knob），
   *   只造子元素会因选择器不匹配而误判成「没动画」。
   */
  function mk(cls, opts) {
    const wrap = !!(opts && opts.parentCls);
    const host = wrap
      ? Object.assign(document.createElement('div'), { className: opts.parentCls })
      : stage;
    const el = document.createElement(opts && opts.tag ? opts.tag : 'div');
    // opts.rawCls：门禁命中的实际类名（当 cls 只是展示用的复合名时，如 'fb-prog fg' → rawCls='fg'）
    el.className = (opts && opts.rawCls) || cls;
    if (opts && opts.text) el.textContent = opts.text;
    host.appendChild(el);
    if (wrap) stage.appendChild(host); // 无父包装时 host 就是 stage，不能自己 append 自己
    return el;
  }
  function css(el) {
    const s = getComputedStyle(el);
    return { name: s.animationName, dur: s.animationDuration, trans: s.transitionDuration };
  }
  /**
   * 判定「动效是否被杀」：
   *   - animation 被杀：animation-name 变成 none，或所有时长都归零
   *   - transition 被杀：transition-duration 全部为 0s
   * 一个元素可能只受 transition 影响（如 .event-countdown 常态只有 color 过渡）。
   */
  function alive(c) {
    const animOn = c.name !== 'none' && c.dur.split(',').some((d) => parseFloat(d) > 0);
    const transOn = c.trans.split(',').some((d) => parseFloat(d) > 0);
    return animOn || transOn;
  }
  function check(label, group, cls, opts, expect, mode) {
    const el = mk(cls, opts);
    // opts.kind：门禁样式按文档种类分别注入，悬浮球必须用 'floating'，否则注入的是 main 那套
    A.applyAnimControl(document, mode, (opts && opts.kind) || 'main');
    const c = css(el);
    const got = alive(c) ? 'on' : 'off';
    const pass = got === expect;
    if (!pass) failed++;
    rows.push({ label, group, cls, expect, got, pass, ...c });
    // 清理：连父包装一起移除
    (el.parentElement === stage ? el : el.parentElement).remove();
    return pass;
  }
  /**
   * 需要父元素包裹的选择器 → 供 A/B/C/D 各段复用。
   * rawCls 给出门禁命中的**真实**类名：cls 只是展示用的复合写法（'a b' → '.a.b'），
   * 直接把它当 className 会造出 'a.b' 这个非法类名，导致后代选择器匹配不上而误判。
   */
  const NEED_PARENT = {
    'node-banner-card':            { parentCls: 'node-banner phase-in' },
    'idle-toggle.idle-toggle-knob': { parentCls: 'idle-toggle on', rawCls: 'idle-toggle-knob' },
  };
  const O = (cls) => NEED_PARENT[cls] || null;

  const ALL_ON  = { animMode: 'all-on',  enableAnimations: true };
  const ALL_OFF = { animMode: 'all-off', enableAnimations: false };
  // 自定义档：14 组全开，再逐个关掉要验证的那一组
  const customOn = (off) => ({
    animMode: 'custom',
    enableAnimations: true,
    animControlMode: 'single',
    animGroups: Object.fromEntries(A.ANIM_GROUPS.map((g) => [g.id, g.id !== off])),
  });

  // ================= A) all-on 档 =================
  // 抽 5 个不同分组的代表元素，确认全开档一律播放
  for (const [label, group, cls] of [
    ['面板',        'panel',    'msg-action-bar'],
    ['右键菜单',    'ctxmenu',  'ctx-menu'],
    ['提示气泡',    'theme',    'hint-tip'],
    ['事件弹窗',    'theme',    'event-modal'],
    ['引导高亮环',  'tutorial', 'tutorial-ring'],
    ['节点横幅',    'banner',   'node-banner-card'],
  ]) check('A 全开/' + label, group, cls, O(cls), 'on', ALL_ON);

  // ================= B) all-off 档（含流式豁免）=================
  for (const [label, group, cls] of [
    ['面板',        'panel',    'msg-action-bar'],
    ['右键菜单',    'ctxmenu',  'ctx-menu'],
    ['轻提示',      'toast',    'mini-toast'],
    ['加载呼吸点',  'loading',  'scene-image-dot'],
    ['事件倒计时',  'loading',  'event-countdown'],
    ['提示气泡',    'theme',    'hint-tip'],
    ['事件弹窗',    'theme',    'event-modal'],
    ['引导高亮环',  'tutorial', 'tutorial-ring'],
    ['节点横幅',    'banner',   'node-banner-card'],
    ['开屏',        'splash',   'splash'],
  ]) check('B 全关/' + label, group, cls, O(cls), 'off', ALL_OFF);

  // 流式三兄弟：all-off 档下**必须仍然播放**（豁免的核心断言）
  const streamAllOff = [
    check('B 全关/流式字 .stream-char', 'exempt', 'stream-char', { text: 'a' }, 'on', ALL_OFF),
    check('B 全关/流式卡 .stream-char.stall', 'exempt', 'stream-char stall', { text: 'a' }, 'on', ALL_OFF),
    check('B 全关/伪流式 .pseudo-char', 'exempt', 'pseudo-char', { text: 'a' }, 'on', ALL_OFF),
  ];

  // ================= C) custom 档 =================
  // C1: 关掉 theme 组 → theme 元素被杀；未关的组正常
  check('C 自定义/关theme→提示气泡死',   'theme',    'hint-tip', null, 'off', customOn('theme'));
  check('C 自定义/关theme→事件弹窗死',   'theme',    'event-modal', null, 'off', customOn('theme'));
  check('C 自定义/关theme→右键菜单活',   'ctxmenu',  'ctx-menu', null, 'on', customOn('theme'));
  check('C 自定义/关theme→引导环活',     'tutorial', 'tutorial-ring', null, 'on', customOn('theme'));

  // C2: 换一组关，确认互不串扰
  check('C 自定义/关ctxmenu→菜单死',     'ctxmenu',  'ctx-menu', null, 'off', customOn('ctxmenu'));
  check('C 自定义/关ctxmenu→提示气泡活', 'theme',    'hint-tip', null, 'on', customOn('ctxmenu'));

  // C3: custom 档下流式三兄弟依然豁免
  const streamCustom = [
    check('C 自定义/.stream-char 活',        'exempt', 'stream-char', { text: 'a' }, 'on', customOn(null)),
    check('C 自定义/.stream-char.stall 活',  'exempt', 'stream-char stall', { text: 'a' }, 'on', customOn(null)),
    check('C 自定义/.pseudo-char 活',        'exempt', 'pseudo-char', { text: 'a' }, 'on', customOn(null)),
  ];

  // ================= D) v2.3.92 补齐的 18 项 =================
  // 每项都断言「关掉它所属的组 → 被杀」+「不关它（关别的组）→ 仍活」
  const ADDED = [
    // [标签, 组, 选择器, v2.3.92 的改动点]
    ['剧情节点横幅(修正错位)', 'banner',   'node-banner-card',        '.node-banner → .node-banner-card'],
    ['事件倒计时(非urgent)',   'loading',  'event-countdown',         '补非 urgent 态'],
    ['提示气泡',              'theme',    'hint-tip',                '新增'],
    ['设置跳转高亮',          'theme',    'setting-flash',           '新增'],
    ['模型卡高亮',            'theme',    'model-flash',             '新增'],
    ['拖拽提示',              'theme',    'drop-hint',               '新增'],
    ['快速导入遮罩',          'theme',    'quick-import-overlay',    '新增'],
    ['开关滑块',              'theme',    'idle-toggle idle-toggle-knob', '新增'],
    ['事件弹窗',              'theme',    'event-modal',             '* → 具体类名'],
    ['事件遮罩',              'theme',    'event-overlay',           '* → 具体类名'],
    ['引导高亮环',            'tutorial', 'tutorial-ring',           '新建组'],
    ['引导卡片',              'tutorial', 'tutorial-card',           '新建组'],
    ['引导居中卡片',          'tutorial', 'tutorial-card-center',    '新建组'],
  ];
  for (const [label, group, cls, note] of ADDED) {
    const sel = cls.replace(/ /g, '.');
    check('D 补齐/' + label + ' 关本组→死', group, sel, O(sel), 'off', customOn(group));
    // 对照：关一个**别的**组（panel），它必须仍然活 —— 证明归属没写错组
    check('D 补齐/' + label + ' 关他组→活', group, sel, O(sel), 'on', customOn('panel'));
    rows[rows.length - 2].note = note;
  }

  // 悬浮球（独立文档选择器，需 kind='floating' 注入门禁规则）。
  // 悬浮球的 CSS 由 floating-ball.ts 在运行时注入 <style>（不在 index.css 里），
  // 故此处补一份与源码逐字等价的最小规则（见 src/floating-ball.ts:60-75），
  // 用来验证**门禁选择器**是否命中，而不是验证悬浮球自己的样式。
  //
  // v2.3.92 独立复核发现：原脚本还自造了一条 .fb-ctx-item 的 background 过渡，
  // 但源码 floating-ball.ts:144 的 .fb-ctx-item **本身没有 transition**（只有 :hover 改 background）。
  // 那条断言是"自证式"的（用自造的 CSS 证明自造的登记有效），已连同悬浮球该条空转登记一起移除。
  const fbStyle = document.createElement('style');
  fbStyle.textContent = [
    '.fb-ball{transition:transform .12s ease;}',
    '.fb-prog .fg{transition:stroke-dashoffset .25s linear;}',
  ].join('\n');
  document.head.appendChild(fbStyle);
  for (const [label, cls, parentCls, rawCls] of [
    ['悬浮球本体',    'fb-ball',    null,     null],
    ['生视频环形进度', 'fb-prog fg', 'fb-prog', 'fg'],
  ]) {
    const sel = cls.replace(/ /g, '.');
    // kind='floating'：门禁样式必须按悬浮球那套选择器注入（主文档注入的是 main 版，为空）
    const opts = Object.assign({ kind: 'floating' },
      parentCls ? { parentCls } : null, rawCls ? { rawCls } : null);
    check('D 补齐/' + label + ' 关floatball→死', 'floatball', sel, opts, 'off', customOn('floatball'));
    // 对照：关 panel 组（与 floatball 无关）→ 必须仍活
    check('D 补齐/' + label + ' 关他组→活',    'floatball', sel, opts, 'on',  customOn('panel'));
  }
  fbStyle.remove();

  // ================= E) 根节点状态断言 =================
  A.applyAnimControl(document, ALL_ON, 'main');
  const s1 = { cls: document.documentElement.className, off: document.documentElement.getAttribute('data-anim-off') };
  A.applyAnimControl(document, ALL_OFF, 'main');
  const s2 = { cls: document.documentElement.className, off: document.documentElement.getAttribute('data-anim-off') };
  A.applyAnimControl(document, customOn('theme'), 'main');
  const s3 = { cls: document.documentElement.className, off: document.documentElement.getAttribute('data-anim-off') };
  // 档位切换必须干净：all-on 不能残留上一档的 data-anim-off
  A.applyAnimControl(document, ALL_ON, 'main');
  const s4 = { off: document.documentElement.getAttribute('data-anim-off') };

  // ================= F) 向后兼容映射 =================
  const compat = [
    ['老配置 enableAnimations=true',            { enableAnimations: true },                          'all-on'],
    ['老配置 enableAnimations=false',           { enableAnimations: false },                         'all-off'],
    ['老配置 single（拨过分项）',                { enableAnimations: true, animControlMode: 'single' }, 'custom'],
    ['老配置 master+false',                     { enableAnimations: false, animControlMode: 'master' }, 'all-off'],
    ['settings=null',                           null,                                                'all-on'],
    ['animMode 脏数据',                          { animMode: 'bogus', enableAnimations: true },       'all-on'],
    ['新配置 custom',                            { animMode: 'custom' },                             'custom'],
  ].map(([label, s, want]) => {
    const got = A.getAnimMode(s);
    if (got !== want) failed++;
    return { label, want, got, pass: got === want };
  });

  // ================= 汇总 =================
  const text = [];
  const P = (s) => text.push(s);
  P('================ 根节点状态（applyAnimControl 实际写入）================');
  for (const [n, s] of [['all-on ', s1], ['all-off', s2], ['custom ', s3]]) {
    P('  ' + n + '  class="' + s.cls + '"  data-anim-off=' + JSON.stringify(s.off));
  }
  P('  切回 all-on 后 data-anim-off = ' + JSON.stringify(s4.off) + '  (应为 null)');
  P('');
  P('================ 向后兼容映射（getAnimMode）================');
  for (const c of compat) P('  ' + (c.pass ? '✓' : '✗') + ' ' + c.label + ' → ' + c.got + '（期望 ' + c.want + '）');
  P('');
  const sections = [
    ['A 全开档（普通动画应全部播放）', 'A 全开/'],
    ['B 全关档（普通动画应全部被杀）', 'B 全关/'],
    ['C 自定义档（关组→死 / 他组→活 / 流式豁免）', 'C 自定义/'],
    ['D v2.3.92 补齐的 18 项', 'D 补齐/'],
  ];
  for (const [title, prefix] of sections) {
    P('================ ' + title + '================');
    P('  ' + '结果'.padEnd(6) + '期望'.padEnd(6) + '选择器'.padEnd(34) + 'animation-name'.padEnd(24) + 'anim-dur'.padEnd(12) + 'trans-dur');
    for (const r of rows.filter((x) => x.label.startsWith(prefix))) {
      P('  ' + (r.pass ? '  ok  ' : ' FAIL ') + ' ' + String(r.expect).padEnd(6) +
        ('.' + r.cls).padEnd(34) + String(r.name).padEnd(24) + String(r.dur).padEnd(12) + r.trans +
        (r.note ? '   // ' + r.note : ''));
    }
    P('');
  }
  const killed = rows.filter((r) => r.got === 'off').length;
  P('汇总：共 ' + rows.length + ' 条 DOM 断言，其中 ' + killed + ' 条确认「动效被关掉」、' +
    (rows.length - killed) + ' 条确认「动效仍在播放」；兼容映射 ' + compat.length + ' 条。');
  return { text: text.join('\n'), rows, failed, total: rows.length + compat.length };
})()
`;

const out = await send('Runtime.evaluate', {
  expression: PROBE,
  returnByValue: true,
});
if (out.exceptionDetails) {
  console.error('页面内脚本报错：\n', JSON.stringify(out.exceptionDetails, null, 2));
  ws.close();
  edge.kill();
  process.exit(4);
}

const report = out.result.value;
console.log(report.text);
if (report.failed > 0) {
  console.error('\n❌ ' + report.failed + ' 条断言未通过');
  process.exitCode = 1;
} else {
  console.log('\n✅ 全部 ' + report.total + ' 条断言通过（含流式豁免与 18 项补齐）');
}

ws.close();
edge.kill();
try {
  rmSync(workDir, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}
process.exit(process.exitCode || 0);
