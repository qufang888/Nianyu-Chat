#!/usr/bin/env node
// 动态光标「移出窗口即时恢复原生光标」回归门禁（v2.3.126 重做后更新）
// 背景：此前鼠标移出软件走 hideCursor() 的 ~150ms 淡出，导致自定义光标残留 +
// 原生光标延迟出现（用户感知「停留一会再消失」）。改为一步到位的 hideCursorImmediate()。
// v2.3.126 把字形层从 Canvas 换成 DOM（transform 同步定位），本脚本同步跟进新实现：
// 本脚本守住：
//   ① 鼠标移出窗口（mouseleave / mouseout）走即时隐藏，而非淡出；
//   ② 淡出仍保留给「窗口被覆盖 / 切后台」等窗口级切换（不误伤丝滑过渡）；
//   ③ 主窗 / 小窗 / 悬浮球三处都挂了同一个 DynamicCursor —— 修复一次、三端全覆盖；
//   ④ 滑入即在真实指针位置出现（不缓动追赶），字形位置**永不** lerp；
//   ⑤ 单光标仲裁链路（preload IPC / 主进程 / 门控订阅）保持原样。
import { readFileSync } from 'node:fs';
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

const cur = read('src/cursor/cursorEngine.ts');

console.log('=== A. 即时隐藏函数存在且行为正确 ===');
ok(/private hideCursorImmediate\(\): void/.test(cur), 'hideCursorImmediate 已定义');
ok(/hideCursorImmediate[\s\S]{0,1600}?classList\.remove\(HIDDEN_CLASS\)/.test(cur),
  'hideCursorImmediate 移除 cursor-hidden（立即恢复原生光标）');
ok(/hideCursorImmediate[\s\S]{0,2200}?this\.stopLoop\(\)/.test(cur), 'hideCursorImmediate 停止 rAF 循环');
ok(/hideCursorImmediate[\s\S]{0,1600}?this\.clearFx\(\)/.test(cur), 'hideCursorImmediate 清空特效层（无残留光标）');
ok(/hideCursorImmediate[\s\S]{0,1600}?this\.pointerX = OFFSCREEN/.test(cur) &&
   /hideCursorImmediate[\s\S]{0,1700}?this\.pointerY = OFFSCREEN/.test(cur),
  'hideCursorImmediate 把坐标打回离屏哨兵（下次进入吸附到指针，不再从陈旧位置缓动）');
ok(/hideCursorImmediate[\s\S]{0,1600}?this\.inside = false/.test(cur),
  'hideCursorImmediate 置 inside=false（下次进入的第一个事件必然走「离屏吸附」分支）');

console.log('=== B. 鼠标移出窗口走即时隐藏（而非淡出）===');
const grab = (name) => {
  const i = cur.indexOf(`private ${name}`);
  if (i < 0) return '';
  const j = cur.indexOf('};', i);
  return cur.slice(i, j > 0 ? j : i + 400);
};
ok(/hideCursorImmediate\(\)/.test(grab('onMouseLeaveDoc')) && !/this\.hideCursor\(\)/.test(grab('onMouseLeaveDoc')),
  'onMouseLeaveDoc 调用 hideCursorImmediate（不再淡出）');
ok(/hideCursorImmediate\(\)/.test(grab('onMouseOut')) && !/this\.hideCursor\(\)/.test(grab('onMouseOut')),
  'onMouseOut 调用 hideCursorImmediate（不再淡出）');
ok(/if \(e\.relatedTarget\) return;/.test(grab('onMouseOut')),
  'onMouseOut 只在 relatedTarget 为空（真正离开文档）时隐藏');

console.log('=== C. 淡出仍保留给窗口级切换 + 护栏 ===');
ok(/FADE_OUT_MS\s*\*\s*Math\.max\(0\.1, cfg\.animSpeed\)/.test(cur), '窗口级切换淡出（FADE_OUT_MS）仍保留');
ok(/private onBlur = \(\): void => \{[\s\S]{0,320}?this\.hideCursor\(\)/.test(cur),
  'onBlur 仍走 hideCursor（窗口被覆盖时丝滑淡出）');
ok(/if \(this\.hidden && this\.fadeState !== 'in'\) return;/.test(cur),
  'hideCursor 有「已隐藏则不重复淡出」护栏（避免 blur 兜底空转 / 重绘）');

console.log('=== D. 三个界面都挂载同一个 DynamicCursor（修复全覆盖）===');
for (const [f, label] of [
  ['src/App.tsx', '主窗'],
  ['src/components/MiniChat.tsx', '小窗'],
  ['src/floating-ball.ts', '悬浮球'],
]) {
  ok(/DynamicCursor/.test(read(f)), `${label}（${f}）挂载 DynamicCursor`);
  // 旧组件名用拼接写法（守卫强度不变，但仓库里不留指向已删除组件的字面引用）
  ok(!read(f).includes('Custom' + 'Cursor'), `${label}（${f}）不再引用旧光标组件名`);
}

console.log('=== E. 滑入即显 + 字形位置永不 lerp ===');
ok(/private ensureVisible\(crisp: boolean\): void/.test(cur), 'ensureVisible 支持 crisp 参数');
ok(/if \(crisp\) \{[\s\S]{0,200}?this\.opacity = 1;[\s\S]{0,120}?this\.fadeState = 'none';/.test(cur),
  'crisp 分支：指针进入即全显、不淡入（杜绝双光标窗口）');
ok(/this\.ensureVisible\(true\)/.test(cur) && !/private onFocus[\s\S]{0,240}?this\.ensureVisible\(true\)/.test(cur),
  '指针进入（onMouseMove）走 crisp；窗口聚焦（onFocus）保留淡入');
ok(!/lerp\s*\(/.test(cur), '引擎内没有任何 lerp 调用（字形位置绝不插值 → 显示位置 == 点击位置）');
ok(/translate3d\(\$\{x - off\.offX \* s\}px, \$\{y - off\.offY \* s\}px, 0\) scale\(\$\{s\}\)/.test(cur),
  '字形定位 = translate3d(x - offX·s, y - offY·s, 0) scale(s)（热点随缩放同步偏移，位置严格 = 指针坐标）');
ok(/this\.pointerX = e\.clientX;/.test(cur) && /updateGlyphAt\(e\.clientX, e\.clientY\)/.test(cur),
  'mousemove 里用事件坐标同步定位字形（不进 rAF 队列 → 零帧延迟）');

console.log('=== F. 单光标仲裁链路完好（不得被本次重做破坏）===');
const preload = read('electron/preload.ts');
const appSrc = read('src/App.tsx');
const miniSrc = read('src/components/MiniChat.tsx');
ok(/ipcRenderer\.on\('main:cursor-window'/.test(preload) && /ipcRenderer\.on\('mini:cursor-window'/.test(preload),
  'preload 的 main/mini cursor-window IPC 保持原样');
ok(/onMainCursorWindow\(/.test(appSrc) && /classList\.add\('cursor-gate-off'\)/.test(appSrc),
  '主窗 onMainCursorWindow 门控订阅保持原样');
ok(/onMiniCursorWindow\(/.test(miniSrc) && /classList\.add\('cursor-gate-off'\)/.test(miniSrc),
  '小窗 onMiniCursorWindow 门控订阅保持原样');
ok(/document\.body\.classList\.contains\(GATE_CLASS\)/.test(cur),
  '新引擎尊重 cursor-gate-off 门控（被覆盖 / 穿透时不响应指针）');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
