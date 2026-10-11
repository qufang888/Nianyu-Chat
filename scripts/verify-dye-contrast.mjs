#!/usr/bin/env node
/**
 * verify-dye-contrast.mjs — v2.3.108 起改职为「取色染色子系统已删净」护栏。
 * ============================================================================
 *
 * 【背景】原闸门（v2.3.101）守「背景取色染色」的 --color-primary-ink 承载面对比度。
 * 该功能在 v2.3.105 被收窄为液态玻璃（liquid）主题专属；v2.3.107 liquid 主题整体删除、
 * v2.3.108 把残留清理干净后，「染色」成为不可达死代码，本闸门的原被测对象不复存在。
 *
 * 【现在的职责】防止 dye 子系统死灰复燃（漏删的运行时代码 / 设置字段 / CSS 挂钩 / oracle 误引）：
 *   A. src/utils/dominantColor.ts 已不存在（产品运行时无取色实现）；
 *   B. src/ 内无任何文件 import dominantColor（测试 oracle scripts/lib/ 除外）；
 *   C. src/types.ts 不存在 dyeFromBackground 设置字段与出厂默认；
 *   D. ChatWindow / MiniChat 无 dyeActive / dyeSeqRef / extractDominantColor 残留；
 *   E. index.css 无 .has-chat-bg 挂钩类（染色激活期的玻璃滚动区类）。
 *
 * 注： WCAG 对比度数学仍由 scripts/lib/dominantColor.ts（测试专用 oracle）提供，
 * 供 verify-chat-ui-contrast / verify-flash-timing 使用，与本护栏互不影响。
 *
 * 运行：node scripts/verify-dye-contrast.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');
const exists = (r) => fs.existsSync(path.join(ROOT, r));

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
    console.log('  FAIL  ' + name + (extra ? '  << ' + extra : ''));
  }
}

console.log('=== A/B. dominantColor 运行时实现已删除，src/ 无引用 ===');
check('A1 src/utils/dominantColor.ts 不存在', !exists('src/utils/dominantColor.ts'));
const srcFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|css)$/.test(e.name)) srcFiles.push(p);
  }
};
walk('src');
const importers = srcFiles.filter((f) => /from\s+'[^']*dominantColor'/.test(read(f)));
check('B1 src/ 内无 dominantColor import', importers.length === 0, importers.join(', '));

console.log('\n=== C. 设置字段已删 ===');
const types = read('src/types.ts');
check('C1 types.ts 无 dyeFromBackground 字段', !/dyeFromBackground/.test(types));

console.log('\n=== D. 组件无 dye 残留 ===');
for (const f of ['src/components/ChatWindow.tsx', 'src/components/MiniChat.tsx']) {
  const s = read(f);
  check(
    'D ' + f + ' 无 dyeActive/dyeSeqRef/extractDominantColor 残留',
    !/dyeActive|dyeSeqRef|extractDominantColor|deriveInkForSurfaces/.test(s)
  );
}

console.log('\n=== E. CSS 挂钩类已删 ===');
const css = read('src/styles/index.css');
check('E1 index.css 无 .has-chat-bg 规则', !/has-chat-bg/.test(css));

console.log('\n' + '='.repeat(64));
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('❌ dye 子系统未彻底删净');
  process.exit(1);
}
console.log('✅ 取色染色子系统已彻底删净（原 v2.3.101 染色对比度闸门随功能退役）');
