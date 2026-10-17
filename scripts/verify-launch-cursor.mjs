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

console.log('=== B. 冷启动启动界面 ===');
ok(existsSync(join(root, 'public/launch.html')), 'public/launch.html 存在');
const launchHtml = existsSync(join(root, 'public/launch.html')) ? read('public/launch.html') : '';
ok(/window\.__setLaunch\s*=/.test(launchHtml), 'launch.html 暴露 window.__setLaunch(text,pct)');
ok(/function showLaunchWindow\(\)/.test(main) && /function closeLaunchWindow\(\)/.test(main), '主进程 showLaunchWindow/closeLaunchWindow 存在');
ok(/if \(firstWindowEver\) showLaunchWindow\(\);/.test(main), 'whenReady 仅冷启动（firstWindowEver）建启动界面');
ok(/closeLaunchWindow\(\); \/\/ v2\.3\.116/.test(main), '主界面 ready-to-show 关闭启动界面');
ok(/LAUNCH_I18N/.test(main) && /getAppLang\(\)/.test(main), '启动文案按应用语言本地化（LAUNCH_I18N + getAppLang）');
ok(/dist\/launch\.html/.test(main), '启动界面加载 dist/launch.html');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
