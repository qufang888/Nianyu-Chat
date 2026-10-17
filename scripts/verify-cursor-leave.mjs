#!/usr/bin/env node
// v2.3.114：动态光标「移出窗口即时恢复原生光标」回归门禁
// 背景：此前鼠标移出软件走 hideCursor() 的 ~150ms 淡出，导致自定义光标残留 +
// 原生光标延迟出现（用户感知「停留一会再消失」）。现改为 hideCursorImmediate() 一步到位。
// 本脚本守住：
//   ① 鼠标移出窗口（mouseleave / mouseout）走即时隐藏，而非淡出；
//   ② 淡出仍保留给「窗口被覆盖 / 切后台」等窗口级切换（不误伤丝滑过渡）；
//   ③ 主窗 / 小窗 / 悬浮球三处都挂了同一个 CustomCursor —— 修复一次、三端全覆盖。
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

const cur = read('src/components/CustomCursor.tsx');

console.log('=== A. 即时隐藏函数存在且行为正确 ===');
ok(/const hideCursorImmediate\s*=\s*\(\)\s*=>/.test(cur), 'hideCursorImmediate 已定义');
ok(/hideCursorImmediate[\s\S]{0,500}?classList\.remove\('cursor-hidden'\)/.test(cur),
  'hideCursorImmediate 移除 cursor-hidden（立即恢复原生光标）');
ok(/hideCursorImmediate[\s\S]{0,1000}?stopLoop\(\)/.test(cur), 'hideCursorImmediate 停止 rAF 循环');
ok(/hideCursorImmediate[\s\S]{0,700}?clearRect/.test(cur), 'hideCursorImmediate 清空画布（无残留光标）');

console.log('=== B. 鼠标移出窗口走即时隐藏（而非淡出）===');
const grab = (name) => {
  const i = cur.indexOf(`const ${name}`);
  if (i < 0) return '';
  const j = cur.indexOf('};', i);
  return cur.slice(i, j > 0 ? j : i + 400);
};
ok(/hideCursorImmediate\(\)/.test(grab('onMouseLeaveDoc')) && !/hideCursor\(\)/.test(grab('onMouseLeaveDoc')),
  'onMouseLeaveDoc 调用 hideCursorImmediate（不再淡出）');
ok(/hideCursorImmediate\(\)/.test(grab('onMouseOut')) && !/hideCursor\(\)/.test(grab('onMouseOut')),
  'onMouseOut 调用 hideCursorImmediate（不再淡出）');

console.log('=== C. 淡出仍保留给窗口级切换 + 护栏 ===');
ok(/FADE_OUT_MS\s*\*\s*speedRef\.current/.test(cur), '窗口级切换淡出（FADE_OUT_MS）仍保留');
ok(/const onBlur[\s\S]{0,320}?hideCursor\(\)/.test(cur), 'onBlur 仍走 hideCursor（窗口被覆盖时丝滑淡出）');
ok(/if \(hiddenRef\.current && fadeStateRef\.current !== 'in'\) return;/.test(cur),
  'hideCursor 有「已隐藏则不重复淡出」护栏（避免 blur 兜底空转 / 重绘）');

console.log('=== D. 三个界面都挂载同一个 CustomCursor（修复全覆盖）===');
for (const [f, label] of [
  ['src/App.tsx', '主窗'],
  ['src/components/MiniChat.tsx', '小窗'],
  ['src/floating-ball.ts', '悬浮球'],
]) {
  ok(/CustomCursor/.test(read(f)), `${label}（${f}）挂载 CustomCursor`);
}

console.log('=== E. 进入吸附指针 + 一步到位全显（v2.3.115 修边缘无光标 / 双光标）===');
ok(/hideCursorImmediate[\s\S]{0,900}?renderXRef\.current = OFFSCREEN/.test(cur) &&
   /hideCursorImmediate[\s\S]{0,960}?renderYRef\.current = OFFSCREEN/.test(cur),
  'hideCursorImmediate 把渲染位置打回离屏哨兵（下次进入吸附到指针，不再从陈旧位置缓动）');
ok(/const ensureVisible = \(crisp = false\)/.test(cur), 'ensureVisible 支持 crisp 参数');
ok(/if \(crisp\) \{[\s\S]{0,160}?opacityRef\.current = 1;[\s\S]{0,80}?fadeStateRef\.current = 'none';/.test(cur),
  'crisp 分支：鼠标进入即全显、不淡入（杜绝双光标窗口）');
ok(/renderXRef\.current < OFFSCREEN && mouseXRef\.current > OFFSCREEN/.test(cur),
  'ensureVisible 离屏吸附：渲染位置离屏时落到当前指针');
ok(/ensureVisible\(true\)/.test(cur) && !/onFocus[\s\S]{0,240}?ensureVisible\(true\)/.test(cur),
  '鼠标进入（onMouseMove）走 crisp；窗口聚焦（onFocus）保留淡入');

console.log('=== F. 失焦淡出也复位渲染位 + 进入transition吸附（v2.3.116 修飞入）===');
ok(/hiddenRef\.current = true;\s*\/\/ v2\.3\.116：失焦淡出收尾[\s\S]{0,140}?renderXRef\.current = OFFSCREEN/.test(cur),
  '失焦淡出完成也把 renderX 打回离屏哨兵（下次进入吸附，不失灵）');
ok(/const wasInside = mouseInsideRef\.current;/.test(cur) &&
   /!wasInside \|\| renderXRef\.current < OFFSCREEN/.test(cur),
  'onMouseMove 进入transition吸附：鼠标从窗外进入即落到指针，不飞入');

console.log('=== G. 光标本体紧贴指针（v2.3.117 修「指 A 点 B」）===');
ok(/const CURSOR_SNAP_PX = \d+;/.test(cur), 'CURSOR_SNAP_PX 常量存在（光标本体最大允许滞后像素）');
ok(/dynamicSpeed = dist > CURSOR_SNAP_PX \? 1 :/.test(cur),
  '滞后超过阈值即一步贴合指针（杜绝快速移动+点击时视觉光标与命中判定错位）');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
