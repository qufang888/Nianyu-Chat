#!/usr/bin/env node
/* 白框根因隔离矩阵：逐一测试 alwaysOnTop / setAlwaysOnTop 组合对透明窗 DWM 合成的影响。
 * VARIANT=a..f，通过环境变量选择，每次只跑一个变体，采样 show 后的 DWM 帧白度。 */
const electron = require('electron');
const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = electron;
const path = require('node:path'), fs = require('node:fs');
if (!app || typeof app.whenReady !== 'function') { console.error('需 Electron 主进程'); process.exit(2); }
process.on('uncaughtException', (e) => { console.error(e && e.stack || e); process.exit(3); });
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.probe-evidence');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const V = process.env.VARIANT || 'a';
const CHAR = { id:'pv', name:'探针', kind:'placeholder', files:[], enabled:true, x:700, y:300, scale:1, behavior:false, bubble:false, speakRate:0 };
const RT = { enabled:true, x:0, y:0, alwaysOnTop:true, passThroughLocked:false, activeId:'pv' };
const SET = { desktopCharacters:[CHAR], animCharacterIdle:true, animCharacterGaze:true };
function stubs(){
  ipcMain.handle('settings:get',()=>SET);
  ipcMain.handle('dc:get-state',()=>({runtime:RT,character:CHAR}));
  for(const ch of ['sound:play','dc:set-ignore','dc:drag-start','dc:drag-end','dc:set-always-on-top','dc:set-pass-through-lock','dc:set-enabled','dc:set-active','dc:set-scale','dc:set-scale-live','dc:open-chat','dc:open-collection','dc:open-stage','dc:show-window','dc:hide-character','dc:reposition']) ipcMain.on(ch,()=>{});
  for(const ch of ['dc:pick-import','dc:import-paths','dc:delete-character','dc:runtime-dir','dc:runtime-status','dc:open-runtime-dir','get-roles','get-chat-list','get-messages']) if(!ipcMain.listeners(ch).length) ipcMain.handle(ch,()=>null);
}
function white(img,rect,scale){
  const c=img.crop({x:Math.round(rect.x*scale),y:Math.round(rect.y*scale),width:Math.round(rect.w*scale),height:Math.round(rect.h*scale)});
  const b=c.toBitmap();let w=0,n=0;for(let i=0;i<b.length;i+=4){n++;if(b[i]>=245&&b[i+1]>=245&&b[i+2]>=245)w++;}return +(w/n).toFixed(3);
}
async function grab(){
  const d=screen.getPrimaryDisplay();
  const s=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:d.bounds.width*d.scaleFactor,height:d.bounds.height*d.scaleFactor}});
  const img=s[0].thumbnail;return {img,scale:img.getSize().width/d.bounds.width};
}
async function main(){
  await app.whenReady(); stubs();
  const d=screen.getPrimaryDisplay(); const w=1100,h=1332;
  const x=Math.round(d.bounds.x+d.bounds.width-340-24+170-w/2), y=Math.round(d.bounds.y+d.bounds.height-420-24+410-(h-10));
  // 变体配置
  const CFG = {
    a:{ctor:false, call:null,              desc:'ctor:false, 无 setAlwaysOnTop 调用'},
    b:{ctor:false, call:[false,'pop-up-menu'],desc:'ctor:false, setAlwaysOnTop(false,"pop-up-menu")【真实app】'},
    c:{ctor:false, call:[false,'floating'],desc:'ctor:false, setAlwaysOnTop(false,"floating")'},
    d:{ctor:false, call:[false],           desc:'ctor:false, setAlwaysOnTop(false) 无level'},
    e:{ctor:true,  call:[false,'pop-up-menu'],desc:'ctor:true,  setAlwaysOnTop(false,"pop-up-menu")'},
    f:{ctor:false, call:[true,'pop-up-menu'], desc:'ctor:false, setAlwaysOnTop(true,"pop-up-menu")【对照】'},
  }[V];
  console.log(`[VAR ${V}] ${CFG.desc}`);
  const win=new BrowserWindow({width:w,height:h,x,y,frame:false,transparent:true,backgroundColor:'#00000000',
    alwaysOnTop:CFG.ctor,skipTaskbar:true,resizable:false,movable:false,hasShadow:false,focusable:true,show:false,
    webPreferences:{preload:path.join(ROOT,'dist-electron','electron','preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:false,autoplayPolicy:'no-user-gesture-required'}});
  win.setIgnoreMouseEvents(true,{forward:true});
  if(CFG.call) win.setAlwaysOnTop(...CFG.call);
  const rect={x:Math.max(0,x+150)-d.bounds.x,y:Math.max(0,y+60)-d.bounds.y,w:300,h:200};
  const t0=Date.now();const samples=[];
  win.once('ready-to-show',async()=>{
    win.showInactive();
    for(let i=0;i<5;i++){
      const t=Date.now()-t0;
      const g=await grab();const wr=white(g.img,rect,g.scale);
      samples.push({t,white:wr});
      if(i===0)fs.writeFileSync(path.join(OUT,`matrix-${V}-first.png`),g.img.toPNG());
      await sleep(500);
    }
    console.log(`[VAR ${V}] samples=${JSON.stringify(samples)}`);
    fs.writeFileSync(path.join(OUT,`matrix-${V}.json`),JSON.stringify({variant:V,cfg:CFG,samples},null,2));
    app.quit();
  });
  win.loadFile(path.join(ROOT,'dist','character.html'),{search:'?id=pv'});
}
(async()=>{try{await main();}catch(e){console.error(e&&e.stack||e);process.exitCode=3;app.quit();}})();
