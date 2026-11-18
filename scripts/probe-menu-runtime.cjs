#!/usr/bin/env node
/* ============================================================================
 * v3.0.14 真机复现探针（Electron 主进程运行）
 *
 * 用真实 Electron BrowserWindow + 真实 preload + 真实 dist/character.html，
 * 在多种「窗口尺寸 / 渲染层 scale」组合下，右键并以 DOM + 像素截图记录：
 *   - 窗口 bounds / innerWidth / innerHeight
 *   - .dc-character / .dc-root / .dc-menu-anchor / .dc-menu 的屏幕矩形
 *   - 按 CharacterApp.computeMenuAnchor 现场重算的锚点
 * 同时连续采样滚轮手势期的窗口 bounds 与角色屏幕矩形，定位瞬移发生在哪一档。
 *
 * 历史诊断探针：复现 v3.0.13「预扩/收窗 + 一次性锚点」导致菜单远离角色的现场。
 * v3.0.15 起菜单锚定光标、窗口恒定，F1/F2 的旧数值不再代表产品行为；
 * 修复后验收请用 scripts/verify-runtime-menu-scale.cjs（真机断言 光标右侧 / 贴边翻转 / 零 resize）。
 *
 * 运行：
 *   env -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 \
 *     ./node_modules/electron/dist/electron.exe scripts/probe-menu-runtime.cjs
 * ========================================================================== */
const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const ipcMain = electron.ipcMain;
const path = require('node:path');
const fs = require('node:fs');

if (!app || typeof app.whenReady !== 'function') {
  console.error('必须在 Electron 主进程运行');
  process.exit(2);
}
process.on('uncaughtException', (e) => { console.error(e && e.stack || e); process.exit(3); });

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.probe-evidence');

// 与 electron/desktopCharacter.ts 同源几何
const BW = 340, BH = 420, BODY_W = 190, BODY_H = 228, GAP = 10;
const PAD_X = (BW - BODY_W) / 2;                 // 75
const HEAD_TOP = BH - GAP - BODY_H;              // 182
const sizeFor = (s) => ({
  w: Math.max(BW, Math.ceil(BODY_W * s + 2 * PAD_X)),
  h: Math.max(BH, Math.ceil(BODY_H * s + GAP + HEAD_TOP)),
});

const CHAR = {
  id: 'probe', name: '探针角色', kind: 'placeholder', files: [],
  enabled: true, x: 700, y: 300, scale: 1, behavior: false, bubble: false, speakRate: 0,
};
const RUNTIME = { enabled: true, x: 0, y: 0, alwaysOnTop: true, passThroughLocked: false, activeId: 'probe' };
const SETTINGS = { desktopCharacters: [CHAR], animCharacterIdle: true, animCharacterGaze: true };

let probeWin = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installStubs() {
  ipcMain.handle('settings:get', () => SETTINGS);
  ipcMain.handle('dc:get-state', () => ({ runtime: RUNTIME, character: CHAR }));
  // 角色窗启动/菜单可能触达的通道：全部安全空操作
  const sends = [
    'sound:play', 'dc:set-ignore', 'dc:drag-start', 'dc:drag-end',
    'dc:set-always-on-top', 'dc:set-pass-through-lock', 'dc:set-enabled',
    'dc:set-active', 'dc:set-scale', 'dc:set-scale-live', 'dc:open-chat',
    'dc:open-collection', 'dc:open-stage', 'dc:show-window', 'dc:hide-character',
    'dc:reposition',
  ];
  for (const ch of sends) ipcMain.on(ch, () => {});
  const handles = [
    'dc:pick-import', 'dc:import-paths', 'dc:delete-character', 'dc:runtime-dir',
    'dc:runtime-status', 'dc:open-runtime-dir', 'get-roles', 'get-chat-list', 'get-messages',
  ];
  for (const ch of handles) if (!ipcMain.listeners(ch).length) ipcMain.handle(ch, () => null);
}

const MEASURE = `(() => {
  const charEl = document.querySelector('.dc-character');
  const rootEl = document.querySelector('.dc-root');
  const anchorEl = document.querySelector('.dc-menu-anchor');
  const menuEl = document.querySelector('.dc-menu');
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { l:+r.left.toFixed(1), t:+r.top.toFixed(1), r:+r.right.toFixed(1), b:+r.bottom.toFixed(1), w:+r.width.toFixed(1), h:+r.height.toFixed(1) }; };
  const cr = rect(charEl), rr = rect(rootEl), ar = rect(anchorEl), mr = rect(menuEl);
  // v3.0.15 契约：锚点 = 右键光标，菜单左上角 = 光标 + gap，贴边翻转/钳制。
  // 真实值由 onContextMenu 写入 state；这里只记录锚点 style 与菜单矩形供对照。
  const cs = anchorEl ? getComputedStyle(anchorEl) : null;
  return {
    inner:[window.innerWidth, window.innerHeight], dpr: window.devicePixelRatio,
    scaleVar: getComputedStyle(document.documentElement).getPropertyValue('--dc-scale').trim() || getComputedStyle(rootEl).getPropertyValue('--dc-scale').trim(),
    char:cr, root:rr, anchor:ar, menu:mr,
    anchorStyle: anchorEl ? { left: anchorEl.style.left, top: anchorEl.style.top, cssTop: cs.top, cssLeft: cs.left, transform: cs.transform } : null,
    screenX: window.screenX, screenY: window.screenY,
  };
})()`;

async function setBounds(w, h, foot) {
  // foot = {x,y} 屏幕脚点；反解窗口原点（与 resizeCharacterWindow 同式）
  const x = foot.x - w / 2;
  const y = foot.y - (h - GAP);
  probeWin.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
  await sleep(120);
}

async function setScaleInRenderer(scale) {
  probeWin.webContents.send('dc:scale-preview', { id: 'probe', scale });
  await sleep(120);
}

async function rightClick(forceDom = true) {
  const m = await probeWin.webContents.executeJavaScript(MEASURE);
  if (!m.char) throw new Error('no .dc-character');
  const cx = Math.round((m.char.l + m.char.r) / 2);
  const cy = Math.round(m.char.t + m.char.h * 0.3);
  // 真机原生右键：窗口切可交互后发送。窗口部分离屏时 Chromium 的输入路由可能失效，
  // 故默认再用 DOM 事件触发 React 的真实 onContextMenu 处理器（同一函数、同一锚点计算）。
  probeWin.setIgnoreMouseEvents(false);
  try {
    probeWin.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'right', clickCount: 1 });
    probeWin.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'right', clickCount: 1 });
  } catch (e) {
    console.log('  [warn] sendInputEvent failed:', e.message);
  }
  await sleep(100);
  let has = await probeWin.webContents.executeJavaScript("!!document.querySelector('.dc-menu')");
  if (forceDom && !has) {
    await probeWin.webContents.executeJavaScript(`(()=>{const c=document.querySelector('.dc-character');if(!c)return;
      c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:${cx},clientY:${cy}}));})()`);
  }
  await sleep(150);
  const after = await probeWin.webContents.executeJavaScript(MEASURE);
  probeWin.setIgnoreMouseEvents(true, { forward: true });
  return { cx, cy, native: has, before: m, after };
}

async function closeMenu() {
  // 走 React 的真实关闭链路（Escape → closeMenu → 动画 → 卸载），
  // 不能直接 remove DOM：那样 menuOpen state 仍为 true，下一次右键不会重渲染。
  await probeWin.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  for (let i = 0; i < 20; i++) {
    const has = await probeWin.webContents.executeJavaScript("!!document.querySelector('.dc-menu')");
    if (!has) break;
    await sleep(50);
  }
}

async function snapshot(name) {
  const m = await probeWin.webContents.executeJavaScript(MEASURE);
  const b = probeWin.getBounds();
  const img = await probeWin.capturePage();
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, img.toPNG());
  const gap = (m.menu && m.char) ? +(m.char.t - m.menu.b).toFixed(1) : null;
  console.log('  ' + name + ' bounds=' + JSON.stringify(b) + ' inner=' + JSON.stringify(m.inner));
  console.log('    scale=' + m.scaleVar + ' char=' + JSON.stringify(m.char) + ' menu=' + JSON.stringify(m.menu));
  console.log('    anchor=' + JSON.stringify(m.anchorStyle) + ' 菜单底→角色顶间距=' + gap);
  console.log('    截图=' + file);
  return { name, bounds: b, ...m, gap, screenshot: file };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  installStubs();
  await app.whenReady();

  probeWin = new BrowserWindow({
    width: BW, height: BH, x: 700, y: 300,
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: false, skipTaskbar: true, resizable: false, movable: false,
    hasShadow: false, focusable: true, show: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await probeWin.loadFile(path.join(ROOT, 'dist', 'character.html'), { search: '?id=probe' });
  // 等 React 首帧
  for (let i = 0; i < 60; i++) {
    const ready = await probeWin.webContents.executeJavaScript("!!document.querySelector('.dc-character')").catch(() => false);
    if (ready) break;
    await sleep(100);
  }
  probeWin.webContents.send('dc:state', { runtime: RUNTIME, character: CHAR });
  await sleep(400);

  const results = [];
  const foot = { x: 900, y: 900 };

  console.log('\n===== A. 一致状态：窗口 340×420 + scale=1 =====');
  await setBounds(BW, BH, foot);
  await setScaleInRenderer(1);
  results.push(await snapshot('A-consistent-s1'));
  const clickA = await rightClick();
  console.log('  右键点=' + clickA.cx + ',' + clickA.cy + ' 原生=' + clickA.native + ' 菜单=' + JSON.stringify(clickA.after.menu));
  results.push({ name: 'A-rightclick', ...clickA.after });
  await closeMenu();

  console.log('\n===== B. 一致状态：窗口 1100×1332 + scale=5 =====');
  const s5 = sizeFor(5);
  await setBounds(s5.w, s5.h, foot);
  await setScaleInRenderer(5);
  results.push(await snapshot('B-consistent-s5'));
  const clickB = await rightClick();
  console.log('  右键点=' + clickB.cx + ',' + clickB.cy + ' 原生=' + clickB.native + ' 菜单=' + JSON.stringify(clickB.after.menu));
  results.push({ name: 'B-rightclick', ...clickB.after });
  await closeMenu();

  console.log('\n===== C. v3.0.13 手势期：窗口预扩 1100×1332，渲染层 scale=1.5 =====');
  await setBounds(s5.w, s5.h, foot);
  await setScaleInRenderer(1.5);
  results.push(await snapshot('C-gesture-preexpanded-s1.5'));
  const clickC = await rightClick();
  console.log('  右键点=' + clickC.cx + ',' + clickC.cy + ' 原生=' + clickC.native + ' 菜单=' + JSON.stringify(clickC.after.menu));
  results.push({ name: 'C-rightclick', ...clickC.after });
  await closeMenu();

  console.log('\n===== D. 提交后收窗：窗口 435×534 + scale=1.5 =====');
  const s15 = sizeFor(1.5);
  await setBounds(s15.w, s15.h, foot);
  await setScaleInRenderer(1.5);
  results.push(await snapshot('D-committed-s1.5'));
  const clickD = await rightClick();
  console.log('  右键点=' + clickD.cx + ',' + clickD.cy + ' 原生=' + clickD.native + ' 菜单=' + JSON.stringify(clickD.after.menu));
  results.push({ name: 'D-rightclick', ...clickD.after });
  await closeMenu();

  console.log('\n===== F. 菜单打开后发生滚轮手势（锚点是否随窗口更新？）=====');
  // F1: 小窗一致态打开菜单 → 手势预扩（窗口原点 -912px）→ 观察菜单相对角色
  await setBounds(BW, BH, foot);
  await setScaleInRenderer(1);
  const clickF1 = await rightClick();
  console.log('  F1 开菜单时: menu=' + JSON.stringify(clickF1.after.menu) + ' char=' + JSON.stringify(clickF1.after.char));
  await setBounds(s5.w, s5.h, foot);
  await setScaleInRenderer(1.5);
  results.push(await snapshot('F1-menu-then-preexpand'));
  await closeMenu();
  // F2: 预扩窗内打开菜单 → 手势提交收窗（窗口原点 +684px）→ 观察菜单相对角色
  await setBounds(s5.w, s5.h, foot);
  await setScaleInRenderer(1.5);
  const clickF2 = await rightClick();
  console.log('  F2 开菜单时: menu=' + JSON.stringify(clickF2.after.menu) + ' char=' + JSON.stringify(clickF2.after.char));
  await setBounds(s15.w, s15.h, foot);
  await setScaleInRenderer(1.5);
  results.push(await snapshot('F2-menu-then-commit'));
  await closeMenu();

  console.log('\n===== E. 连续采样：窗口预扩 + 20 档滚轮 + 收窗（瞬移定位） =====');
  await probeWin.webContents.executeJavaScript("document.querySelector('.dc-menu-anchor')?.remove()").catch(() => {});
  await setBounds(BW, BH, foot);
  await setScaleInRenderer(1);
  const samples = [];
  const sample = async (tag) => {
    const b = probeWin.getBounds();
    const r = await probeWin.webContents.executeJavaScript(`(()=>{const e=document.querySelector('.dc-character');if(!e)return null;const r=e.getBoundingClientRect();return {t:+r.top.toFixed(1),b:+r.bottom.toFixed(1),l:+r.left.toFixed(1),w:+r.width.toFixed(1)}})()`);
    // 角色屏幕绝对矩形 = 窗口原点 + 局部 rect
    samples.push({ tag, bx:b.x, by:b.y, bw:b.width, bh:b.height,
      screenCharTop: r ? b.y + r.t : null, screenCharBottom: r ? b.y + r.b : null,
      charW: r ? r.w : null, localTop: r ? r.t : null });
  };
  await sample('before');
  // 手势第一档：预扩
  await setBounds(s5.w, s5.h, foot);
  await sample('pre-expand');
  for (let i = 1; i <= 20; i++) {
    await setScaleInRenderer(1 + i * 0.05);
    if (i % 5 === 0) await sample('tick' + i);
  }
  // 收窗
  const s2 = sizeFor(2);
  await setBounds(s2.w, s2.h, foot);
  await sample('committed');
  console.table(samples);

  console.log('\n===== 汇总 =====');
  for (const r of results) {
    if (!r.menu) continue;
    console.log(r.name + ': 菜单底→角色顶=' + r.gap + 'px  charHead(local)=' + (r.char ? r.char.t : '?') + '  menuBottom(local)=' + r.menu.b);
  }
  fs.writeFileSync(path.join(OUT, 'probe-results.json'), JSON.stringify({ results, samples }, null, 2));
  console.log('证据目录: ' + OUT);
}

(async () => {
  let code = 0;
  try { await main(); } catch (e) { console.error(e && e.stack || e); code = 3; }
  finally { process.exitCode = code; app.quit(); }
})();
