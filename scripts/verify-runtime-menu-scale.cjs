#!/usr/bin/env node
/* ============================================================================
 * v3.0.15 真机验证（Electron 32）：右键菜单锚定光标右侧 + 恒定大窗零 resize
 *
 * 运行：
 *   env -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 \
 *     ./node_modules/electron/dist/electron.exe scripts/verify-runtime-menu-scale.cjs
 *
 * 证据：真实 BrowserWindow（frame:false / transparent）+ 真实 preload + 真实 dist/character.html。
 * ① 右键菜单出现在光标右侧（菜单 left > clientX），垂直居中于光标，完整在窗口内
 * ② 贴右边缘右键 → 翻到光标左侧，不溢出；贴下边缘 → 上移；贴左上角 → 钳到 6px
 * ③ 菜单打开期间 20 档缩放：菜单位置完全不变，窗口 bounds 零变化，脚点零漂移
 * ④ 每阶段 capturePage 截图落盘 .probe-evidence/v314-*.png
 * ========================================================================== */
const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const ipcMain = electron.ipcMain;
const path = require('node:path');
const fs = require('node:fs');

if (!app || typeof app.whenReady !== 'function') {
  console.error('必须在 Electron 主进程运行'); process.exit(2);
}
process.on('uncaughtException', (e) => { console.error(e && e.stack || e); process.exit(3); });

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.probe-evidence');
const GAP = 10;           // computeMenuAnchor: DC_MENU_CURSOR_GAP
const PAD = 6;            // computeMenuAnchor: DC_MENU_EDGE_PAD
const WIN_W = 1100, WIN_H = 1332; // = winSizeForScale(DC_SCALE_MAX)
let failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHAR = {
  id: 'v314', name: '验证角色', kind: 'placeholder', files: [],
  enabled: true, x: 700, y: 300, scale: 1, behavior: false, bubble: false, speakRate: 0,
};
const RUNTIME = { enabled: true, x: 0, y: 0, alwaysOnTop: true, passThroughLocked: false, activeId: 'v314' };
const SETTINGS = { desktopCharacters: [CHAR], animCharacterIdle: true, animCharacterGaze: true };

function installStubs() {
  ipcMain.handle('settings:get', () => SETTINGS);
  ipcMain.handle('dc:get-state', () => ({ runtime: RUNTIME, character: CHAR }));
  for (const ch of ['sound:play', 'dc:set-ignore', 'dc:drag-start', 'dc:drag-end',
    'dc:set-always-on-top', 'dc:set-pass-through-lock', 'dc:set-enabled', 'dc:set-active',
    'dc:set-scale', 'dc:set-scale-live', 'dc:open-chat', 'dc:open-collection',
    'dc:open-stage', 'dc:show-window', 'dc:hide-character', 'dc:reposition']) {
    ipcMain.on(ch, () => {});
  }
  for (const ch of ['dc:pick-import', 'dc:import-paths', 'dc:delete-character',
    'dc:runtime-dir', 'dc:runtime-status', 'dc:open-runtime-dir']) {
    if (!ipcMain.listeners(ch).length) ipcMain.handle(ch, () => null);
  }
}

const MEASURE = `(() => {
  const charEl = document.querySelector('.dc-character');
  const rootEl = document.querySelector('.dc-root');
  const anchorEl = document.querySelector('.dc-menu-anchor');
  const menuEl = document.querySelector('.dc-menu');
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { l:+r.left.toFixed(1), t:+r.top.toFixed(1), r:+r.right.toFixed(1), b:+r.bottom.toFixed(1), w:+r.width.toFixed(1), h:+r.height.toFixed(1) }; };
  return {
    inner:[window.innerWidth, window.innerHeight],
    screenOrigin:[window.screenX, window.screenY],
    avail:[screen.availLeft, screen.availTop, screen.availWidth, screen.availHeight],
    scaleVar: getComputedStyle(rootEl || document.documentElement).getPropertyValue('--dc-scale').trim(),
    char: rect(charEl), root: rect(rootEl), anchor: rect(anchorEl), menu: rect(menuEl),
    anchorStyle: anchorEl ? { left: anchorEl.style.left, top: anchorEl.style.top } : null,
  };
})()`;

let win = null;
async function measure(name, shot = true) {
  const m = await win.webContents.executeJavaScript(MEASURE);
  const b = win.getBounds();
  const foot = b.y + (m.char ? m.char.b : WIN_H - GAP);
  if (shot) {
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, `v314-${name}.png`), img.toPNG());
  }
  return { name, bounds: b, foot, ...m };
}

/** 原生右键；若目标点不在角色命中区（如窗口角落），用 DOM 事件走同一 React 处理器。 */
async function rightClickAt(cx, cy, fallbackDom = false) {
  win.setIgnoreMouseEvents(false);
  if (!fallbackDom) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'right', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'right', clickCount: 1 });
  }
  await sleep(340); // 等 dcMenuIn（默认 0.2s + 倍率）播完再测，避免动画中的 scale(0.96) 干扰
  win.setIgnoreMouseEvents(true, { forward: true });
  let after = await win.webContents.executeJavaScript(MEASURE);
  if (!after.menu && fallbackDom) {
    await win.webContents.executeJavaScript(`(()=>{const c=document.querySelector('.dc-character');
      c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:${cx},clientY:${cy}}));})()`);
    await sleep(340);
    after = await win.webContents.executeJavaScript(MEASURE);
  }
  return { native: !!after.menu, cx, cy, after };
}

async function closeMenu() {
  await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  for (let i = 0; i < 20; i++) {
    const has = await win.webContents.executeJavaScript("!!document.querySelector('.dc-menu')");
    if (!has) break;
    await sleep(50);
  }
}

async function setScale(s) {
  win.webContents.send('dc:scale-preview', { id: 'v314', scale: s });
  await sleep(60);
}

/** 本地矩形 → 物理屏幕矩形；并用渲染层上报的 avail 工作区做完整可见断言。 */
function screenRect(m, localRect = m.menu) {
  if (!localRect) return null;
  return {
    l: localRect.l + m.screenOrigin[0], t: localRect.t + m.screenOrigin[1],
    r: localRect.r + m.screenOrigin[0], b: localRect.b + m.screenOrigin[1],
  };
}
function availOf(m) {
  const [l, t, w, h] = m.avail;
  return { left: l, top: t, right: l + w, bottom: t + h };
}
function assertInWorkArea(tag, m) {
  const r = screenRect(m), a = availOf(m);
  check(`${tag} 菜单完整落在物理工作区内（P0 硬验收）`,
    !!r && r.l >= a.left + PAD - 1 && r.r <= a.right - PAD + 1 &&
    r.t >= a.top + PAD - 1 && r.b <= a.bottom - PAD + 1,
    `screenRect=${JSON.stringify(r)} avail=${JSON.stringify(a)}`);
  return r;
}

/** 菜单必须在光标右侧（或翻转后左侧）、垂直居中、完整在窗口内。 */
function assertRightOfCursor(tag, m, cx, cy, flipped = false, checkCenter = true) {
  const menu = m.menu;
  check(`${tag} 菜单已渲染且有正常尺寸`, !!menu && menu.w >= 160 && menu.h >= 190,
    JSON.stringify(menu));
  if (flipped) {
    check(`${tag} 贴右边缘 → 翻到光标左侧`, !!menu && menu.r < cx,
      `menu.r=${menu?.r} cursorX=${cx}`);
  } else {
    check(`${tag} 菜单出现在光标右侧`, !!menu && menu.l > cx + 4,
      `menu.l=${menu?.l} cursorX=${cx} Δ=${menu ? +(menu.l - cx).toFixed(1) : '?'}`);
  }
  if (checkCenter) {
    check(`${tag} 菜单垂直居中于光标（偏差 ≤4px）`,
      !!menu && Math.abs((menu.t + menu.b) / 2 - cy) <= 4,
      `menuCenterY=${menu ? (menu.t + menu.b) / 2 : '?'} cursorY=${cy}`);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  installStubs();
  await app.whenReady();

  // 与产品 createDesktopCharacter 一致：1100×1332，脚点 (900,900) ⇒ 原点 (350,-422)
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H, x: 350, y: -422,
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: false, skipTaskbar: true, resizable: false, movable: false,
    hasShadow: false, focusable: true, show: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'dist', 'character.html'), { search: '?id=v314' });
  for (let i = 0; i < 60; i++) {
    const ready = await win.webContents.executeJavaScript("!!document.querySelector('.dc-character')").catch(() => false);
    if (ready) break;
    await sleep(100);
  }
  win.webContents.send('dc:state', { runtime: RUNTIME, character: CHAR });
  await sleep(300);

  console.log('\n===== ① 光标右侧（scale=1，角色中部右键） =====');
  const beforeBounds = win.getBounds();
  await setScale(1);
  const m0 = await measure('s1-before', false);
  const cx1 = Math.round((m0.char.l + m0.char.r) / 2);
  const cy1 = Math.round(m0.char.t + m0.char.h * 0.3);
  const r1 = await rightClickAt(cx1, cy1);
  const m1 = await measure('s1-menu');
  check('原生右键成功打开菜单', r1.native);
  const s1Screen = assertInWorkArea('scale=1 中部', m1);

  console.log('\n===== ② 菜单打开期间 20 档缩放：菜单固定、窗口零变化 =====');
  const boundsAtMenu = win.getBounds();
  const footAtMenu = m1.foot;
  const anchorAtMenu = m1.anchorStyle;
  const positions = [];
  for (let i = 1; i <= 20; i++) {
    await setScale(1 + i * 0.05);
    if (i % 5 === 0) {
      const m = await measure(`s${(1 + i * 0.05).toFixed(2)}-menu`, false);
      positions.push({ s: +(1 + i * 0.05).toFixed(2), l: m.menu?.l, t: m.menu?.t, foot: m.foot });
    }
  }
  const final = await measure('s2-menu');
  check('20 档缩放期间窗口 bounds 完全不变（零 setBounds）',
    JSON.stringify(final.bounds) === JSON.stringify(boundsAtMenu),
    `前=${JSON.stringify(boundsAtMenu)} 后=${JSON.stringify(final.bounds)}`);
  check('角色屏幕脚点全程零漂移（≤0.5px）',
    Math.abs(final.foot - footAtMenu) <= 0.5, `前=${footAtMenu} 后=${final.foot}`);
  check('菜单位置全程固定（不随角色缩放乱跑，渲染矩形误差 ≤2px）',
    positions.every((p) => Math.abs(p.l - m1.menu.l) <= 2 && Math.abs(p.t - m1.menu.t) <= 2) &&
    Math.abs(final.menu.l - m1.menu.l) <= 2 && Math.abs(final.menu.t - m1.menu.t) <= 2,
    JSON.stringify(positions));
  check('锚点 style 全程不变（只在右键那一刻算一次）',
    JSON.stringify(final.anchorStyle) === JSON.stringify(anchorAtMenu),
    `前=${JSON.stringify(anchorAtMenu)} 后=${JSON.stringify(final.anchorStyle)}`);

  console.log('\n===== ③ QA P0 场景：S=5 + 窗口原点 (350,-422) 原生右键 =====');
  await closeMenu();
  for (let i = 19; i >= 1; i--) await setScale(1 + i * 0.05);
  await setScale(5);
  await sleep(120);
  const m5 = await measure('s5-before', false);
  const cx0 = Math.round((m5.char.l + m5.char.r) / 2);
  const cy0 = Math.round(m5.char.t + m5.char.h * 0.5);
  const r0 = await rightClickAt(cx0, cy0);
  const mP0 = await measure('s5-p0-screen-visible');
  check('P0 场景原生右键成功', r0.native, `cx=${cx0} cy=${cy0}`);
  assertRightOfCursor('P0 S=5 中部', mP0, cx0, cy0);
  const p0Screen = assertInWorkArea('P0 S=5 中部', mP0);

  console.log('\n===== ④ 贴物理屏幕右边缘右键 → 翻到左侧 =====');
  await closeMenu();
  const avail = availOf(mP0);
  const cxR = Math.round(avail.right - mP0.screenOrigin[0] - 30); // 屏幕 x=avail.right-30
  const cyR = Math.round(752);
  const rR = await rightClickAt(cxR, cyR, true); // 屏幕边缘不在角色命中区 → DOM 走同一处理器
  const mR = await measure('s5-screen-right-flip');
  check('贴屏幕右边缘 synthetic 右键成功', rR.native, `cx=${cxR} cy=${cyR}`);
  assertRightOfCursor('屏幕右边缘', mR, cxR, cyR, true);
  const rScreen = assertInWorkArea('屏幕右边缘', mR);

  console.log('\n===== ⑤ 贴屏幕下/上边缘 → 分别夹进工作区 =====');
  await closeMenu();
  const cyB = Math.round(avail.bottom - mP0.screenOrigin[1] - 8);
  const cxB = Math.round((m5.char.l + m5.char.r) / 2);
  const rB = await rightClickAt(cxB, cyB, true);
  const mB = await measure('s5-screen-bottom-edge');
  check('贴屏幕下边缘 synthetic 右键成功', rB.native, `cx=${cxB} cy=${cyB}`);
  assertRightOfCursor('屏幕下边缘', mB, cxB, cyB, false, false);
  const bScreen = assertInWorkArea('屏幕下边缘', mB);
  check('贴屏幕下边缘菜单底边 ≤ avail.bottom−6',
    bScreen && bScreen.b <= avail.bottom - PAD + 1, JSON.stringify(bScreen));
  await closeMenu();
  const cyT = Math.round(avail.top - mP0.screenOrigin[1] + 8);
  const rT = await rightClickAt(cxB, cyT, true);
  const mT = await measure('s5-screen-top-edge');
  check('贴屏幕上边缘 synthetic 右键成功（QA P1）', rT.native, `cx=${cxB} cy=${cyT}`);
  assertRightOfCursor('屏幕上边缘', mT, cxB, cyT, false, false);
  const tScreen = assertInWorkArea('屏幕上边缘', mT);
  check('贴屏幕上边缘菜单顶边 ≥ avail.top+6（QA P1 根治）',
    tScreen && tScreen.t >= avail.top + PAD - 1, JSON.stringify(tScreen));
  await closeMenu();
  const rCorner = await rightClickAt(
    Math.round(avail.left - mP0.screenOrigin[0] + 2),
    Math.round(avail.top - mP0.screenOrigin[1] + 2), true);
  const mCorner = await measure('screen-corner-clamp');
  check('屏幕左上角 synthetic 右键成功', rCorner.native);
  assertInWorkArea('屏幕左上角', mCorner);

  console.log('\n===== 关键数值汇总 =====');
  console.log(JSON.stringify({
    beforeBounds, boundsAtMenu, finalBounds: final.bounds, footAtMenu, finalFoot: final.foot,
    avail, screenOrigin: mP0.screenOrigin,
    s1: { cursor: [cx1, cy1], local: m1.menu, screen: s1Screen, anchor: m1.anchorStyle },
    positions,
    p0: { cursor: [cx0, cy0], local: mP0.menu, screen: p0Screen },
    rightFlip: { cursor: [cxR, cyR], local: mR.menu, screen: rScreen },
    bottom: { cursor: [cxB, cyB], local: mB.menu, screen: bScreen },
    top: { cursor: [cxB, cyT], local: mT.menu, screen: tScreen },
    corner: mCorner.menu,
  }, null, 2));
  fs.writeFileSync(path.join(OUT, 'v314-runtime-results.json'), JSON.stringify({
    beforeBounds, boundsAtMenu, finalBounds: final.bounds, footAtMenu, finalFoot: final.foot,
    avail, screenOrigin: mP0.screenOrigin,
    s1: { cursor: [cx1, cy1], local: m1.menu, screen: s1Screen }, positions,
    p0: { cursor: [cx0, cy0], local: mP0.menu, screen: p0Screen },
    rightFlip: { cursor: [cxR, cyR], local: mR.menu, screen: rScreen },
    bottom: { cursor: [cxB, cyB], local: mB.menu, screen: bScreen },
    top: { cursor: [cxB, cyT], local: mT.menu, screen: tScreen }, corner: mCorner.menu,
  }, null, 2));

  console.log('\n' + '─'.repeat(70));
  if (failures.length) { console.log(`❌ ${failures.length} 条失败：${failures.join('；')}`); return 1; }
  console.log('✅ v3.0.15 真机验证全部通过（光标右侧 / 屏幕空间翻转 / 缩放不漂移 / 零 setBounds）');
  return 0;
}

(async () => {
  let code = 0;
  try { code = await main(); } catch (e) { console.error(e && e.stack || e); code = 3; }
  finally { process.exitCode = code; app.quit(); }
})();
