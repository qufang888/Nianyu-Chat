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
ok(/hideCursorImmediate[\s\S]{0,700}?stopLoop\(\)/.test(cur), 'hideCursorImmediate 停止 rAF 循环');
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
