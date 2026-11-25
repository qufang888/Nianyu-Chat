#!/usr/bin/env node
/**
 * verify-floating-native-cursor.mjs — v3.0.21 悬浮球双光标回归闸门
 *
 * 防的回归：主窗/小窗被悬浮球（球/面板/菜单）覆盖时，覆盖门控会派发合成 mouseout，
 * DynamicCursor 引擎据此摘掉 `cursor-hidden` 露出原生光标；而悬浮球自己的动态光标仍在显示
 * → 整机两个光标。拖动悬浮球时同理。
 *
 * 修法：新增独立的 `cursor-native-hidden` 压制层，只由「动态光标总开关 + 覆盖关系」驱动，
 * 引擎状态变化不得解除它。本脚本用源码级强断言锁定这条不变量（含 CSS 规则与三处接线），
 * 任何一处被删/改回旧写法都会变红。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log('  FAIL  ' + name + (extra ? `  <<< ${extra}` : ''));
  }
}

const types = read('src/cursor/types.ts');
const css = read('src/styles/index.css');
const floating = read('src/floating-ball.ts');
const app = read('src/App.tsx');
const mini = read('src/components/MiniChat.tsx');

console.log('='.repeat(64));
console.log('v3.0.21 悬浮球原生光标压制层断言');
console.log('='.repeat(64));

// A. 常量单一真源
check(
  'types.ts 定义 NATIVE_HIDDEN_CLASS = cursor-native-hidden',
  /export const NATIVE_HIDDEN_CLASS = 'cursor-native-hidden';/.test(types)
);
check(
  'types.ts 保留 HIDDEN_CLASS / GATE_CLASS（既有链路未删）',
  /export const HIDDEN_CLASS = 'cursor-hidden';/.test(types) &&
    /export const GATE_CLASS = 'cursor-gate-off';/.test(types)
);

// B. CSS 两处都必须有压制规则
const nativeRule = /body\.cursor-native-hidden,\s*body\.cursor-native-hidden \*\s*\{\s*cursor:\s*none\s*!important;\s*\}/;
check('index.css 定义 body.cursor-native-hidden 压制规则', nativeRule.test(css));
check('floating-ball.ts baseCSS 同样定义压制规则', nativeRule.test(floating));
check(
  '既有 body.cursor-hidden 规则仍在（未被替换）',
  /body\.cursor-hidden,\s*body\.cursor-hidden \*\s*\{\s*cursor:\s*none\s*!important;\s*\}/.test(css) &&
    /body\.cursor-hidden, body\.cursor-hidden \*\{cursor:none !important;\}/.test(floating)
);

// C. 球/面板窗：由动态光标总开关驱动压制层；菜单窗不接入
check('floating-ball.ts 引入 NATIVE_HIDDEN_CLASS', /import \{ NATIVE_HIDDEN_CLASS \} from '\.\/cursor\/types';/.test(floating));
check(
  'setupCursorEnabled 用 dynCursorEnabled 切换压制层',
  /document\.body\.classList\.toggle\(NATIVE_HIDDEN_CLASS,\s*dynCursorEnabled\)/.test(floating)
);
check(
  'mountCursor 仍主动摘掉引擎 HIDDEN_CLASS（既有 Bug A/C 修复未回退）',
  /document\.body\.classList\.remove\('cursor-hidden'\)/.test(floating)
);
check(
  'role=menu 不挂 DynamicCursor（菜单窗保留原生光标）',
  /if \(role !== 'menu'\) mountCursor\(\);/.test(floating)
);

// D. 主窗/小窗覆盖门控：covered=true 加压制层，false 移除
for (const [name, src] of [['App.tsx', app], ['MiniChat.tsx', mini]]) {
  check(`${name} 引入 NATIVE_HIDDEN_CLASS`, /NATIVE_HIDDEN_CLASS/.test(src));
  check(
    `${name} covered=true 时按动态光标开关加压制层`,
    /if \(covered\) \{[\s\S]{0,500}?if \(cursorEnabledRef\.current\) document\.body\.classList\.add\(NATIVE_HIDDEN_CLASS\)/.test(src)
  );
  check(
    `${name} covered=false 时移除压制层`,
    /document\.body\.classList\.remove\('cursor-gate-off'\);[\s\S]{0,200}?document\.body\.classList\.remove\(NATIVE_HIDDEN_CLASS\)/.test(src)
  );
  check(
    `${name} 仍派发合成 mouseout（引擎字形仍需立即隐藏）`,
    /document\.dispatchEvent\(new MouseEvent\('mouseout'\)\)/.test(src)
  );
  check(
    `${name} 用 ref 持有最新动态光标开关（避免闭包旧值）`,
    /cursorEnabledRef\.current = !!settings\?\.customCursor\?\.enabled/.test(src)
  );
  check(
    `${name} 关闭动态光标时移除压制层（防原生光标永久隐藏）`,
    /if \(!cursorEnabledRef\.current\) document\.body\.classList\.remove\(NATIVE_HIDDEN_CLASS\)/.test(src)
  );
}

console.log('='.repeat(64));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
