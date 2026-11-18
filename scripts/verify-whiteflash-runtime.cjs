#!/usr/bin/env node
/* ============================================================================
 * v3.0.15 真机白框回归验证（10 次添加/显示桌宠）
 *
 * 关键：直接 require **真实编译产物** dist-electron/electron/desktopCharacter.js，
 * 仅用 Module._load 钩子把 ./db（配置源）与 ./floatingBall（Z 序兜底）替换为安全桩，
 * 其余（createDesktopCharacter / BrowserWindow 参数 / ready-to-show / showInactive）
 * 全部执行产品真实代码；用 desktopCapturer 采样真实屏幕 DWM 合成帧判白框。
 *
 * 运行：
 *   env -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 \
 *     ./node_modules/electron/dist/electron.exe scripts/verify-whiteflash-runtime.cjs
 * ========================================================================== */
const electron = require('electron');
const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = electron;
const path = require('node:path'), fs = require('node:fs'), Module = require('node:module');
if (!app || typeof app.whenReady !== 'function' || !desktopCapturer) { console.error('需 Electron 主进程'); process.exit(2); }
process.on('uncaughtException', e => { console.error(e && e.stack || e); process.exit(3); });
process.on('unhandledRejection', e => { console.error(e && e.stack || e); process.exit(3); });

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.probe-evidence');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CYCLES = Number(process.env.CYCLES || 10);

// ---- 测试配置：完全复刻用户真实设置（alwaysOnTop=false，非置顶）----
const CYCLE = process.env.CYCLE || 'both'; // create | show | both
const CHAR = { id:'wf-pet', name:'白框验证角色', kind:'placeholder', files:[], enabled:true,
  x: 0, y: 0, scale: 1, behavior:false, bubble:false, speakRate:0 };
const RT = { enabled:true, x:0, y:0, alwaysOnTop:false, passThroughLocked:false, activeId:'wf-pet' };
const SETTINGS = { desktopCharacters:[CHAR], animCharacterIdle:true, animCharacterGaze:true,
  characterRuntime: RT };
// 防止 destroy 全部窗口后 Electron 自动退出（verify 进程需存活完成 10 轮）
app.on('window-all-closed', (e) => e.preventDefault());
const fakeDm = {
  getSettings: () => JSON.parse(JSON.stringify(SETTINGS)),
  saveSettings: () => {},
  logError: () => {},
};
const fakeFloatingBall = {
  reassertFloatingBallOnTop: () => {},
  getBallWindowBounds: () => ({ x:-9999, y:-9999, width:0, height:0 }),
  moveTop: () => {},
  setCharacterMainShow: () => {},
};

// ---- 通用 IPC 桩（角色窗启动会触达的通道）----
function installStubs(){
  ipcMain.handle('settings:get', () => SETTINGS);
  ipcMain.handle('dc:get-state', () => ({ runtime:RT, character:CHAR }));
  for (const ch of ['sound:play','dc:set-ignore','dc:drag-start','dc:drag-end','dc:set-always-on-top',
    'dc:set-pass-through-lock','dc:set-enabled','dc:set-active','dc:set-scale','dc:set-scale-live',
    'dc:open-chat','dc:open-collection','dc:open-stage','dc:show-window','dc:hide-character','dc:reposition'])
    ipcMain.on(ch, () => {});
  for (const ch of ['dc:pick-import','dc:import-paths','dc:delete-character','dc:runtime-dir',
    'dc:runtime-status','dc:open-runtime-dir','get-roles','get-chat-list','get-messages'])
    if (!ipcMain.listeners(ch).length) ipcMain.handle(ch, () => null);
}

// ---- 用真实编译模块创建窗口 ----
let dc = null;
function loadRealModule(){
  const orig = Module._load;
  Module._load = function(request, parent, isMain){
    if (parent && /desktopCharacter\.js$/.test(parent.filename || '')) {
      if (request === './db') return { getDataManager: () => fakeDm };
      if (request === './floatingBall') return fakeFloatingBall;
    }
    return orig.apply(this, arguments);
  };
  try {
    dc = require(path.join(ROOT, 'dist-electron', 'electron', 'desktopCharacter.js'));
  } finally { Module._load = orig; }
  if (typeof dc.createDesktopCharacter !== 'function') throw new Error('真实模块未导出 createDesktopCharacter');
}

function whiteRatio(img, rect, scale){
  const c = img.crop({ x:Math.round(rect.x*scale), y:Math.round(rect.y*scale),
    width:Math.round(rect.w*scale), height:Math.round(rect.h*scale) });
  const b = c.toBitmap(); let w=0,n=0;
  for(let i=0;i<b.length;i+=4){ n++; if(b[i]>=245&&b[i+1]>=245&&b[i+2]>=245) w++; }
  return n ? +(w/n).toFixed(3) : 0;
}
async function grab(){
  const d = screen.getPrimaryDisplay();
  const src = await desktopCapturer.getSources({ types:['screen'],
    thumbnailSize:{ width:d.bounds.width*d.scaleFactor, height:d.bounds.height*d.scaleFactor } });
  const img = src[0].thumbnail;
  return { img, scale: img.getSize().width / d.bounds.width };
}
/** 采样窗口顶部中间（远离角色本体）区域的白度；同时读真实窗口的 opacity / aot。 */
async function sampleWindow(){
  const win = dc.getDesktopCharacterWindow('wf-pet');
  if (!win || win.isDestroyed()) return { err:'no window' };
  const b = win.getBounds();
  const d = screen.getPrimaryDisplay();
  const rect = { x:Math.max(d.bounds.x,b.x)+b.width/2-150-d.bounds.x,
    y:Math.max(d.bounds.y,b.y)+60-d.bounds.y, w:300, h:200 };
  const g = await grab();
  return { white: whiteRatio(g.img, rect, g.scale), opacity: win.getOpacity(), aot: win.isAlwaysOnTop(),
    bounds:`${Math.round(b.x)},${Math.round(b.y)} ${b.width}x${b.height}` };
}

async function main(){
  await app.whenReady();
  installStubs();
  loadRealModule();
  console.log(`[verify-whiteflash] 真实模块已加载；CYCLES=${CYCLES} CYCLE=${CYCLE}`);

  const results = [];
  for (let i = 1; i <= CYCLES; i++) {
    // 每次循环先彻底销毁，确保走完整的「创建→显示」链路
    dc.destroyDesktopCharacter();
    await sleep(120);
    dc.createDesktopCharacter('wf-pet');
    // 等真实窗口 ready-to-show + showInactive 完成
    const win = dc.getDesktopCharacterWindow('wf-pet');
    if (!win || win.isDestroyed()) throw new Error(`cycle ${i}: 窗口未创建`);
    await new Promise((resolve) => {
      if (win.isVisible()) return resolve();
      win.once('ready-to-show', () => setTimeout(resolve, 120));
      setTimeout(resolve, 2500); // 兜底
    });
    // 添加场景：连续采样两个时刻，捕捉「过几秒又消失」型白框
    const s1 = await sampleWindow();
    await sleep(500);
    const s2 = await sampleWindow();
    // 显示场景：模拟隐藏后再显示（真实产品路径 showInactive）
    let s3 = null;
    if (CYCLE !== 'create') {
      win.hide();
      await sleep(150);
      if (!win.isVisible()) win.showInactive();
      await sleep(250);
      s3 = await sampleWindow();
    }
    const ok = [s1,s2,s3].every(s => !s || (s.white === 0 && s.opacity < 1));
    results.push({ cycle:i, add:[s1,s2], show:s3, ok });
    console.log(`  第${String(i).padStart(2)}轮 add=[${JSON.stringify(s1)},${JSON.stringify(s2)}] show=${JSON.stringify(s3)} -> ${ok?'PASS':'FAIL'}`);
    if (i === 1) { const g = await grab(); fs.writeFileSync(path.join(OUT,'verify-whiteflash-cycle1.png'), g.img.toPNG()); }
  }
  dc.destroyDesktopCharacter();

  const allPass = results.every(r => r.ok);
  const report = { allPass, cycles:CYCLES, cycle:CYCLE,
    opacityExpected:0.99, results, ts:new Date().toISOString() };
  fs.writeFileSync(path.join(OUT,'verify-whiteflash-runtime.json'), JSON.stringify(report,null,2));
  console.log(`\n[verify-whiteflash] ${allPass ? `✅ ${CYCLES} 次添加/显示零白框` : '❌ 存在白框'} -> .probe-evidence/verify-whiteflash-runtime.json`);
  process.exitCode = allPass ? 0 : 1;
  app.quit();
}
(async()=>{ try{ await main(); } catch(e){ console.error('[verify-whiteflash] 失败:', e&&e.stack||e); process.exitCode=3; app.quit(); } })();
