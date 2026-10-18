#!/usr/bin/env node
// v2.3.116 回归门禁：冷启动启动界面 + 悬浮球拖拽单光标 + 光标进入吸附
// 守住：
//   ① 拖球期间球窗独占光标（主进程广播 ball:dragging，面板压制自身动态光标）
//   ② 冷启动启动界面（whenReady 冷启动才建、主界面 ready-to-show 即关、launch.html 就位）
//   ③ preload/主进程/渲染端三处接线一致
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  PASS ', msg); }
  else { fail++; console.log('  FAIL ', msg); }
};

const preload = read('electron/preload.ts');
const fbMain = read('electron/floatingBall.ts');
const fbRender = read('src/floating-ball.ts');
const main = read('electron/main.ts');

console.log('=== A. 悬浮球拖拽单光标（整机一个光标）===');
ok(/onBallDragging: \(cb: \(dragging: boolean\) => void\)/.test(preload), 'preload 类型声明 onBallDragging');
ok(/ipcRenderer\.on\('ball:dragging'/.test(preload), 'preload 监听 ball:dragging');
ok(/panelWindow\.webContents\.send\('ball:dragging', true\)/.test(fbMain), '主进程 drag-start 广播 ball:dragging=true');
ok(/panelWindow\.webContents\.send\('ball:dragging', false\)/.test(fbMain), '主进程 finishDrag 广播 ball:dragging=false');
ok(/api\.onBallDragging\(/.test(fbRender), '面板渲染端订阅 onBallDragging');
ok(/suppressPanelCursor/.test(fbRender) && /dispatchEvent\(new MouseEvent\('mouseout'\)\)/.test(fbRender),
  '拖球期间面板立即门控 + 合成 mouseout 隐藏自身光标');
ok(/if \(ballDragging\) return;/.test(fbRender), '面板 mouseenter/mousemove 拖拽期直接 return（不激活光标）');

console.log('=== A2. 单光标所有权（v2.3.117 修悬浮球+面板同时亮光标）===');
ok(/onPanelCursorWindow: \(cb: \(owns: boolean\) => void\)/.test(preload), 'preload 类型声明 onPanelCursorWindow');
ok(/ipcRenderer\.on\('panel:cursor-window'/.test(preload), 'preload 监听 panel:cursor-window');
ok(/lastCursorOwner/.test(fbMain) && /owner === 'ball'/.test(fbMain) && /owner === 'panel'/.test(fbMain),
  '主进程轮询计算光标所有权并推送 ball/panel cursor-window');
ok(/panelWindow\.webContents\.send\('panel:cursor-window', owner === 'panel'\)/.test(fbMain),
  '主进程向面板窗推送 cursor-window=是否为 owner');
ok(/api\.onPanelCursorWindow\(/.test(fbRender) && /if \(!owns\) suppressPanelCursor\(\);/.test(fbRender),
  '面板非 owner 时立即隐藏自身动态光标');

console.log('=== A3. 球窗光标所有权 level 推送（v2.3.118 修快速掠过光标静止残留）===');
ok(/const prevOwner = lastCursorOwner;/.test(fbMain), '轮询记录上一帧 owner（prevOwner）');
ok(/ballWindow\.webContents\.send\('ball:cursor-window', owner === 'ball'\);/.test(fbMain) &&
   !/if \(owner !== lastCursorOwner\) \{[\s\S]{0,200}?ballWindow\.webContents\.send\('ball:cursor-window'/.test(fbMain),
  '球窗 cursor-window 每轮 level 推送（不再仅 edge，快速掠过也强制隐藏）');
ok(/prevOwner !== owner && panelWindow/.test(fbMain), '面板窗仍 edge 推送（仅所有权变化时）');

console.log('=== B. 冷启动启动界面已移除（v2.3.120）===');
ok(!existsSync(join(root, 'public/launch.html')), 'public/launch.html 已删除');
ok(!/showLaunchWindow|LAUNCH_I18N|launchWindow/.test(main), '主进程启动界面代码已移除');
ok(!/appendSwitch\('disable-gpu-rasterization'\)/.test(main), '已撤销 disable-gpu-rasterization（修整窗 CPU 光栅导致的拖动卡顿）');
const bat = existsSync(join(root, '启动念语.bat')) ? read('启动念语.bat') : '';
ok(/if not exist "dist\\index\.html"/.test(bat) && !/msedge/.test(bat) && !/NIANYU_LAUNCHER/.test(bat),
  'bat 直接跑已构建版本（仅缺 dist 才构建；无外挂启动界面）');

console.log('=== C. 悬浮球右键菜单单光标（v2.3.119/120）===');
ok(/onBallMenuOpen: \(cb: \(\) => void\)/.test(preload), 'preload 类型声明 onBallMenuOpen');
ok(/ipcRenderer\.on\('ball:menu-open'/.test(preload), 'preload 监听 ball:menu-open');
ok(/ballWindow\.webContents\.send\('ball:menu-open'\)/.test(fbMain) && /panelWindow\.webContents\.send\('ball:menu-open'\)/.test(fbMain),
  '主进程菜单弹出即广播 ball:menu-open 给球窗/面板窗');
ok(/api\.onBallMenuOpen\(/.test(fbRender), '球窗/面板窗渲染端订阅 onBallMenuOpen');
ok(/onBallMenuOpen\(\(\) => \{[\s\S]{0,300}?dispatchEvent\(new MouseEvent\('mouseout'\)\)[\s\S]{0,300}?classList\.add\('cursor-hidden'\)/.test(fbRender),
  '球窗收到即隐藏自身光标并补回 cursor-hidden（不露原生光标，杜绝双光标）');
ok(/onBallMenuOpen\(\(\) => \{[\s\S]{0,90}?suppressPanelCursor\(\)[\s\S]{0,140}?classList\.add\('cursor-hidden'\)/.test(fbRender),
  '面板窗收到即 suppressPanelCursor + 补回 cursor-hidden（不露原生光标）');

console.log('=== D. 光标贴指针 + DPR 叠片防护（v2.3.120）===');
const cur = read('src/components/CustomCursor.tsx');
ok(/renderXRef\.current = mouseXRef\.current;/.test(cur) && !/CURSOR_SNAP_PX/.test(cur) && !/lerp\(renderXRef/.test(cur),
  '光标本体一步贴合指针（无 lerp 滞后，修「显示位置与点击位置偏移」）');
ok(/canvasDprRef\.current \|\| 1/.test(cur), 'clearRectClamped 用建画布时的 DPR 换算边界（防 DPR 变化后旧帧清不掉→光标叠片）');
ok(/matchMedia\(`\(resolution: /.test(cur) && /onDprChange/.test(cur), 'DPR 变化（全屏/换显示器/缩放）重设画布');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
