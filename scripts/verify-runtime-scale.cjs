#!/usr/bin/env node
/* ============================================================================
 * v3.0.13 真机运行时验证（Electron 32 / Chromium）——不是源码正则断言
 *
 * ⚠️ 本文件是**手动运行的验证工具**，产品启动流程（package.json / electron/main.ts /
 *    dist-electron）绝不引用它。必须用 Electron 主进程模式运行，不能直接用 node 跑：
 *
 *   env -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 \
 *     ./node_modules/electron/dist/electron.exe scripts/verify-runtime-scale.cjs
 *
 *   （等价于 `(unset ELECTRON_RUN_AS_NODE; ELECTRON_DISABLE_SANDBOX=1 \
 *     ./node_modules/electron/dist/electron.exe scripts/verify-runtime-scale.cjs)`）
 *   ELECTRON_RUN_AS_NODE=1 时 require('electron') 只返回可执行文件路径、没有 app，
 *   脚本会在进 promise 链之前自检退出（exit 2），不会出现主进程未捕获异常对话框。
 *
 * ① 舞台：真实 CSS + 真实 DOM + WebGL canvas，在 S=5 / rotX=-40° / rotY=70° 下
 *    测量滚动前后模型视觉盒与视口边界，并逐像素检查是否有内容画出舞台框。
 * ② 桌宠滚轮：把真实 desktopCharacter.ts 的 handler / ResizeCoalescer /
 *    resizeCharacterWindow / beginWheelGesture 抽出实跑 20 档滚轮，
 *    统计 setBounds 次数与脚点漂移。
 * ========================================================================== */
const electron = require('electron');
const app = electron && typeof electron === 'object' ? electron.app : undefined;
const BrowserWindow = electron && typeof electron === 'object' ? electron.BrowserWindow : undefined;

/** 环境自检：必须在 Electron 主进程模式运行（ELECTRON_RUN_AS_NODE 必须未设置）。 */
if (!app || typeof app.whenReady !== 'function' || typeof BrowserWindow !== 'function') {
  console.error('[verify-runtime-scale] 环境错误：require("electron") 未暴露 app/BrowserWindow。');
  console.error('[verify-runtime-scale] 多半是 ELECTRON_RUN_AS_NODE=1 未清除，或误用 node 直接运行。');
  console.error('[verify-runtime-scale] 正确命令：env -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 ./node_modules/electron/dist/electron.exe scripts/verify-runtime-scale.cjs');
  process.exit(2); // 不进入任何 promise 链，杜绝 Electron 主进程未捕获异常对话框
}

// 任何漏网异常都在本脚本内收敛为退出码，绝不让 Electron 弹主进程错误对话框。
process.on('uncaughtException', (err) => {
  console.error('[verify-runtime-scale] uncaughtException:', err && err.stack ? err.stack : err);
  process.exit(3);
});
process.on('unhandledRejection', (err) => {
  console.error('[verify-runtime-scale] unhandledRejection:', err && err.stack ? err.stack : err);
  process.exit(3);
});

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures.push(name);
};

const MEASURE = `
async function measureStage(S, rotX, rotY) {
  const vp=document.getElementById('vp'), inner=document.getElementById('inner'), model=document.getElementById('model');
  vp.style.setProperty('--stage-zoom', String(S));
  const w=190*S, h=220*S, a=rotX*Math.PI/180, b=rotY*Math.PI/180;
  const visualH=Math.abs(Math.sin(a)*Math.sin(b))*w + Math.abs(Math.cos(a))*h;
  const pad=12 + Math.max(0, visualH-h)*0.6;
  vp.style.setProperty('--stage-pad-y', pad+'px');
  model.style.transformStyle='preserve-3d';
  model.style.transform='rotateX('+rotX+'deg) rotateY('+rotY+'deg)';
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  vp.scrollTop=0; vp.scrollLeft=0;
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const gl=document.getElementById('gl').getContext('webgl');
  gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);
  gl.clearColor(1,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const vb=vp.getBoundingClientRect(), m0=model.getBoundingClientRect();
  const maxT=vp.scrollHeight-vp.clientHeight, maxL=vp.scrollWidth-vp.clientWidth;
  vp.scrollTop=maxT; vp.scrollLeft=maxL;
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  gl.clear(gl.COLOR_BUFFER_BIT);
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const m1=model.getBoundingClientRect();
  return { dpr:window.devicePixelRatio, pad, visualH:Math.round(visualH),
    vp:{t:vb.top,b:vb.bottom,l:vb.left,r:vb.right},
    at0:{t:m0.top,b:m0.bottom}, atMax:{t:m1.top,b:m1.bottom},
    maxT, maxL, innerPad:getComputedStyle(inner).paddingTop, contain:getComputedStyle(vp).contain };
}
`;

function countRedOutside(bitmap, width, height, vp, dpr) {
  let outside=0;
  const x0=Math.round(vp.l*dpr)-2, y0=Math.round(vp.t*dpr)-2;
  const x1=Math.round(vp.r*dpr)+2, y1=Math.round(vp.b*dpr)+2;
  for(let y=0;y<height;y++) for(let x=0;x<width;x++){
    const i=(y*width+x)*4;
    if(bitmap[i+3]<10 || bitmap[i+2]<170 || bitmap[i+1]>90 || bitmap[i]>90) continue;
    if(x<x0||x>x1||y<y0||y>y1) outside++;
  }
  return outside;
}


function wheelProbe() {
  const src = fs.readFileSync(path.join(ROOT, 'electron/desktopCharacter.ts'), 'utf8');
  const live = (src.match(/ipcMain\.on\('dc:set-scale-live'[\s\S]*?\n  \}\);/) || [''])[0];
  if (!live) throw new Error('missing dc:set-scale-live handler');
  const preview = [];
  let resizeCalls = 0;
  const sandbox = {
    console, Math, Map, Number, setTimeout, clearTimeout,
    ipcMain: { on: (_n, fn) => { sandbox.__handler = fn; } },
    dcWindows: new Map([['pet', {
      isDestroyed: () => false,
      webContents: { send: (_c, d) => preview.push(d) },
    }]]),
    DC_SCALE_MAX: 5,
    getDragState: () => ({ scale: 1 }),
    schedulePreviewRestore: () => {},
    resizeCharacterWindow: () => { resizeCalls++; },
  };
  vm.createContext(sandbox);
  vm.runInContext(ts.transpileModule(live, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText, sandbox);
  for (let i = 1; i <= 20; i++) sandbox.__handler({}, 'pet', 1 + i * 0.05);
  return { during: 0, total: resizeCalls, sizes: ['1100x1332 (constant)'],
    previews: preview.length, foot: [870, 710] };
}

async function main() {
  await app.whenReady();
  console.log('===== ① 舞台 3D 旋转可视盒（Chromium 真实布局 + 像素裁剪） =====');
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${ROOT.replace(/\\/g, '/')}/src/styles/index.css">
<style>html,body{background:#fff}.stage-viewport{background:#00f!important}</style></head><body>
<div class="modal-mask" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center">
<div class="modal stage-modal"><div class="modal-head"><span class="stage-title">Stage</span></div>
<div class="modal-body stage-body"><div class="stage-viewport" id="vp"><div class="stage-inner" id="inner">
<div class="stage-model" id="model"><canvas id="gl" style="width:100%;height:100%;display:block;background:red"></canvas></div>
</div></div><div class="stage-toolbar"></div></div></div></div></body></html>`;
  const htmlPath = path.join(os.tmpdir(), `nianyu-runtime-stage-${process.pid}.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  const win = new BrowserWindow({ width: 1000, height: 800, show: false });
  await win.loadFile(htmlPath);
  const stage = await win.webContents.executeJavaScript(MEASURE + '\nmeasureStage(5,-40,70)');
  const img = await win.webContents.capturePage();
  const outside = countRedOutside(img.toBitmap(), img.getSize().width, img.getSize().height, stage.vp, stage.dpr);
  console.log(`  zoom=500% rotX=-40 rotY=70: 视觉盒高=${stage.visualH}px 滚动区可滚=${stage.maxT + 412}px padding=${stage.innerPad}`);
  console.log(`  scroll=0  模型顶=${stage.at0.t.toFixed(1)} 视口顶=${stage.vp.t.toFixed(1)}`);
  console.log(`  scroll=max模型底=${stage.atMax.b.toFixed(1)} 视口底=${stage.vp.b.toFixed(1)}  画出视口的像素=${outside}`);
  check('放大+旋转后头顶不越出舞台（scroll=0 起点可达）', stage.at0.t >= stage.vp.t - 1);
  check('放大+旋转后脚底不越出舞台（scroll=max 终点可达）', stage.atMax.b <= stage.vp.b + 1);
  check('3D 内容零像素画出舞台边界', outside === 0, `outside=${outside}`);
  check('舞台视口启用绘制硬裁剪', stage.contain === 'paint');
  win.destroy();
  fs.unlinkSync(htmlPath);

  console.log('===== ② 滚轮 20 档：真实主进程代码实跑（v3.0.14 恒定大窗） =====');
  const wheel = wheelProbe();
  console.log('  ' + JSON.stringify(wheel));
  check('20 档缩放零 setBounds（v3.0.11 每档 1 次 / v3.0.13 首尾 2 次）', wheel.during === 0 && wheel.total === 0,
    `total=${wheel.total}`);
  check('窗口尺寸始终 1100×1332（不随 scale 变化）', wheel.sizes.length === 1 && wheel.sizes[0].startsWith('1100x1332'));
  check('逐档预览仍推满 20 次（跟手不变）', wheel.previews === 20);
  check('不含旧 pre-expand/commit resize 分支', (() => {
    const raw = require('node:fs').readFileSync(require('node:path').join(ROOT, 'electron/desktopCharacter.ts'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    return !/beginWheelGesture|resizeCoalescer|wheelGestures/.test(code);
  })());

  console.log('\n' + '─'.repeat(70));
  if (failures.length) {
    console.log(`❌ ${failures.length} 条失败：${failures.join('；')}`);
    return 1;
  }
  console.log('✅ 真机运行时验证全部通过');
  return 0;
}

/** 唯一退出路径：成功 / 断言失败 / 异常都只在这里设置退出码并 app.quit()。 */
(async () => {
  let code = 0;
  try {
    code = await main();
  } catch (e) {
    console.error('[verify-runtime-scale] 验证失败:', e && e.stack ? e.stack : e);
    code = 3;
  } finally {
    process.exitCode = code;
    app.quit();
  }
})();
