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

console.log('=== B. 冷启动启动界面 ===');
ok(existsSync(join(root, 'public/launch.html')), 'public/launch.html 存在');
const launchHtml = existsSync(join(root, 'public/launch.html')) ? read('public/launch.html') : '';
ok(/window\.__setLaunch\s*=/.test(launchHtml), 'launch.html 暴露 window.__setLaunch(text,pct)');
const themeCount = (launchHtml.match(/primary:/g) || []).length;
ok(/var THEMES = \{/.test(launchHtml) && /params\.get\('theme'\)/.test(launchHtml) && themeCount >= 15,
  `launch.html 主题适配（THEMES 覆盖 15 套，实测 ${themeCount} 个 primary）`);
ok(/function showLaunchWindow\(\)/.test(main) && /function closeLaunchWindow\(\)/.test(main), '主进程 showLaunchWindow/closeLaunchWindow 存在');
ok(/if \(firstWindowEver\) showLaunchWindow\(\);/.test(main), 'whenReady 仅冷启动（firstWindowEver）建启动界面');
ok(/closeLaunchWindow\(\); \/\/ v2\.3\.116/.test(main), '主界面 ready-to-show 关闭启动界面');
ok(/LAUNCH_I18N/.test(main) && /getAppLang\(\)/.test(main), '启动文案按应用语言本地化（LAUNCH_I18N + getAppLang）');
ok(/dist\/launch\.html/.test(main), '启动界面加载 dist/launch.html');
ok(/const LAUNCH_MIN_MS = \d+;/.test(main) && /LAUNCH_MIN_MS - \(Date\.now\(\) - launchShownAt\)/.test(main),
  '启动界面最短展示时长（LAUNCH_MIN_MS），避免「闪一下就没了」');
ok(/launchShownAt = Date\.now\(\);/.test(main), '启动界面显示时记录时刻（用于最短展示判定）');

console.log('=== C. bat/vbs 启动界面 + GPU 修复（v2.3.118）===');
ok(/loadFile\(html, \{ search: '\?theme='/.test(main), 'Electron 启动窗按当前主题加载（?theme=）');
ok(/if \(process\.env\.NIANYU_LAUNCHER === '1'\) return;/.test(main), 'bat 启动（NIANYU_LAUNCHER=1）时跳过 Electron 启动窗，避免双启动界面');
ok(/function writeLaunchThemeFile\(\)/.test(main) && /\.launch-theme/.test(main), '主进程把当前主题写 .launch-theme 供 bat 读取');
ok(/function closeBatLaunchScreen\(\)/.test(main) && /closeBatLaunchScreen\(\); \/\/ v2\.3\.118/.test(main),
  '主界面就绪时关闭 bat 的 Edge 启动界面（closeBatLaunchScreen）');
ok(/nianyu-launch-profile/.test(main), '按独立 profile 名精准结束 Edge 启动界面实例（不影响其它 Edge 窗口）');
ok(/appendSwitch\('disable-gpu-rasterization'\)/.test(main), '关闭 GPU 光栅化（修 command_buffer_proxy_impl GPU state invalid）');
const bat = existsSync(join(root, '启动念语.bat')) ? read('启动念语.bat') : '';
ok(/msedge/.test(bat) && /launch\.html\?src=bat&theme=/.test(bat), 'bat 打开 Edge 启动界面并传主题');
ok(/set "NIANYU_LAUNCHER=1"/.test(bat) && /nianyu-launch-profile/.test(bat), 'bat 设 NIANYU_LAUNCHER 并用独立 profile');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
