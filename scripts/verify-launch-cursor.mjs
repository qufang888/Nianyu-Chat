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
ok(/api\.onPanelCursorWindow\(/.test(fbRender) &&
   /if \(!owns\) suppressPanelCursor\(\);/.test(fbRender) &&
   !/onPanelCursorWindow\(\(owns: boolean\) => \{[\s\S]{0,200}?setInteractive\(/.test(fbRender),
  '面板非 owner 时门控隐藏自身光标（v2.3.126 P2-A：该通道**不再**驱动可交互态 —— 可交互态唯一真源改为 panel:interactive，消除多源打架）');

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
ok(/onBallMenuOpen\(\(\) => \{[\s\S]{0,90}?suppressPanelCursor\(\)[\s\S]{0,320}?if \(dynCursorEnabled\) document\.body\.classList\.add\('cursor-hidden'\)/.test(fbRender),
  '面板窗收到即 suppressPanelCursor + 仅动态光标启用时补回 cursor-hidden（v2.3.126 改条件添加：关闭动态光标时该类无人摘除会导致原生光标永久消失，不得无条件残留）');

console.log('=== D. 光标贴指针 + DPR 叠片防护（v2.3.120）===');
const cur = read('src/components/CustomCursor.tsx');
ok(/renderXRef\.current = mouseXRef\.current;/.test(cur) && !/CURSOR_SNAP_PX/.test(cur) && !/lerp\(renderXRef/.test(cur),
  '光标本体一步贴合指针（无 lerp 滞后，修「显示位置与点击位置偏移」）');
ok(/canvasDprRef\.current \|\| 1/.test(cur), 'clearRectClamped 用建画布时的 DPR 换算边界（防 DPR 变化后旧帧清不掉→光标叠片）');
ok(/matchMedia\(`\(resolution: /.test(cur) && /onDprChange/.test(cur), 'DPR 变化（全屏/换显示器/缩放）重设画布');

console.log('=== E. v2.3.126 五项修复（Bug A-F）===');
const fbR = fbRender; // 悬浮球渲染端
ok(/let dynCursorEnabled = false;/.test(fbR) && /function setupCursorEnabled\(\)/.test(fbR) &&
   /setupCursorEnabled\(\);/.test(fbR),
  '修复1：动态光标开关本窗镜像（setupCursorEnabled 在 mountBall/mountPanel 初始化调用）');
ok((fbR.match(/if \(dynCursorEnabled\) document\.body\.classList\.add\('cursor-hidden'\)/g) || []).length === 2,
  '修复1：球/面板两处 onBallMenuOpen 均改为条件添加 cursor-hidden（不再无条件残留）');
ok(/onPanelShow[\s\S]{0,400}?classList\.add\('cursor-gate-off'\);[\s\S]{0,120}?dispatchEvent\(new MouseEvent\('mouseout'\)\)/.test(fbR) &&
   /onPanelLayout[\s\S]{0,400}?classList\.add\('cursor-gate-off'\)/.test(fbR),
  '修复2a：面板重弹（panel:show / panel:layout）前门控复位，与主进程穿透复位同步');
ok(!/matches\(':hover'\)/.test(fbR.replace(/\/\/[^\n]*/g, '')),
  '修复2b（v2.3.126 P2-A 改写）：.show 后的 :hover 兜底已移除（不可靠 → 会漏恢复 → 面板偶发点不动）；可交互态改由主进程 panel:interactive 权威下发');
ok(/function pushCoveredNow\(\): void \{/.test(fbMain) &&
   (fbMain.match(/pushCoveredNow\(\);/g) || []).length >= 3,
  '修复3：hover/菜单启动沿即时推送 covered=true（pushCoveredNow 定义 + setHoverBall/setHoverPanel/ctx-menu 三处调用）');
ok(/pushCoveredNow[\s\S]{0,900}?lastMainCovered = diff\.main;[\s\S]{0,400}?lastMiniWindowCovered = diff\.mini;/.test(fbMain),
  '修复3（v2.3.126 QA P1 改写）：变化沿缓存写入**实际推的值**（diff.main/diff.mini，true/false 都写）—— 旧实现写死 true 是 5Hz 振荡根因');
ok(/panelWindow\.showInactive\(\);[\s\S]{0,320}?send\('panel:show', \{ h: panelDir, v: panelVDir \}\)/.test(fbMain),
  '修复2d：全屏恢复路径 showFloatingBall 补推 panel:show（渲染端门控同步）');
ok(/const onMouseDown = \(e: MouseEvent\) => \{[\s\S]{0,900}?renderXRef\.current = e\.clientX;[\s\S]{0,600}?drawBodyAt\(e\.clientX, e\.clientY\);/.test(cur),
  '修复4（v2.3.126 改写）：mousedown 瞬间吸附真实指针并**同步重画本体层**（双画布架构下不再走 clearAndDraw）');

console.log('=== E2. v2.3.126 动态光标重做（双画布 + 边缘带 + A4 复位）===');
// ---- A5：v2.3.126 的「画布内钳制」必须已被撤销（钳制 = 人为位移，与用户诉求冲突）----
ok(!/const gx = Math\.max\(0, Math\.min\(cx - hsX/.test(cur) && !/const gy = Math\.max\(0, Math\.min\(cy - hsY/.test(cur),
  'A5：v2.3.126 的画布内钳制已撤销（钳制会让字形平移 = 制造偏移）');
ok(!/const fdx = Math\.max\(0, 14 - cx\);/.test(cur) && !/const fdy = Math\.max\(0, 18 - cy\);/.test(cur),
  'A5：后备箭头路径钳制一并撤销（改由边缘带接管边缘可见性）');
// ---- A2：双画布结构 ----
ok(/const fxCanvasRef = useRef<HTMLCanvasElement \| null>\(null\);/.test(cur) &&
   /const bodyCanvasRef = useRef<HTMLCanvasElement \| null>\(null\);/.test(cur),
  'A2：双画布 ref 存在（fxCanvasRef 特效层 / bodyCanvasRef 本体层）');
ok(/<canvas ref=\{fxCanvasRef\}/.test(cur) && /<canvas ref=\{bodyCanvasRef\}/.test(cur) &&
   /zIndex: 2147483646/.test(cur) && /zIndex: 2147483647/.test(cur),
  'A2：Portal 同时渲染两块画布（本体层 z-index 最高，字形不被弹窗盖住）');
ok(/const clearAndDrawFx = useCallback/.test(cur) && !/const clearAndDraw = useCallback/.test(cur),
  'A2：特效层只画拖尾/粒子（原 clearAndDraw 已改为 clearAndDrawFx，本体不在此层）');
ok(/const drawBodyAt = useCallback/.test(cur) && /bodyPrevRectRef/.test(cur),
  'A2：本体层独立维护「上一帧字形矩形」（不与特效层脏矩形混用 → 拖尾不会被挖洞）');
// ---- A2：本体层同步绘制（不进 rAF 队列）----
ok(/const onMouseMove = \(e: MouseEvent\) => \{[\s\S]{0,2600}?drawBodyAt\(e\.clientX, e\.clientY\);/.test(cur),
  'A2：mousemove 里同步绘制本体层（绘制位置严格 = 事件坐标，无 rAF 一帧滞后）');
ok(!/clearAndDraw\(/.test(cur) && !/drawFrame[\s\S]{0,200}?clearAndDraw\(/.test(cur),
  'A2：本体层已不在 rAF 帧里绘制（显示位置 == 点击位置）');
// ---- A3：边缘带 + 迟滞 ----
ok(/const updateEdgeBand = useCallback/.test(cur) && /EDGE_BAND_HYSTERESIS_PX/.test(cur) &&
   /x >= w - \(bandW \+ EDGE_BAND_HYSTERESIS_PX\)/.test(cur),
  'A3：边缘带判定带迟滞（进入 band / 离开 band+4，避免边界反复横跳闪烁）');
ok(/if \(updateEdgeBand\(x, y\)\) \{ clearBody\(\); return; \}/.test(cur) &&
   /document\.body\.classList\.remove\('cursor-hidden'\);/.test(cur),
  'A3：边缘带内让位给系统原生光标（摘 cursor-hidden 且本体层不画字形）');
ok(/if \(hiddenRef\.current\) \{[\s\S]{0,160}?edgeNativeRef\.current = false;[\s\S]{0,80}?return false;/.test(cur),
  'A3：隐藏态优先（空闲/失焦/门控时不抢原生光标的接管权）');
// ---- A4：跨界面切换状态复位 ----
ok(/window\.addEventListener\('pagehide', onPageHide\)/.test(cur) &&
   /const onPageHide = \(\) => \{ hideCursorImmediate\(\); \}/.test(cur),
  'A4：pagehide 走 hideCursorImmediate 复位');
ok(/const onVisibilityChange = \(\) => \{[\s\S]{0,120}?if \(document\.hidden\) hideCursorImmediate\(\);/.test(cur),
  'A4：visibilitychange(hidden) 走 hideCursorImmediate 复位（rAF 被节流时淡出收尾不可靠）');
ok(/hideCursorImmediate[\s\S]{0,1400}?mouseInsideRef\.current = false;/.test(cur) &&
   /hideCursorImmediate[\s\S]{0,1400}?renderXRef\.current = OFFSCREEN;/.test(cur),
  'A4：复位同时置 mouseInside=false + renderX/Y=OFFSCREEN（下次进入首事件即吸附指针）');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
