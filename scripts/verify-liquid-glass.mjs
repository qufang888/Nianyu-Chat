// v2.3.107 回归守卫（原 v2.3.97「液态玻璃可读性」闸门已随主题删除而退役）
// ============================================================================
//
// 【背景】v2.3.107 需求 7 按用户要求**整体删除**液态玻璃（liquid）主题：
//   · THEMES 不再收录 → 不可选；
//   · variables.css / index.css 的 [data-theme='liquid'] 段落已删；
//   · 关联设置（liquidFlow / dyeFromBackground 等）UI 一并移除；
//   · 读盘层（electron/db.ts）对老数据 theme==='liquid' 单向迁移为 glass 落盘。
//
// 【本脚本现在的职责】把原「验证 liquid 可读性」闸门改为「验证 liquid 已彻底删净」护栏，
// 防止后续改动让 liquid 死灰复燃（漏删的 CSS 规则块 / 重新进 THEMES / 漏迁移老数据）。
//   A. variables.css 不存在任何 [data-theme='liquid'] 规则块；
//   B. index.css 不存在任何 [data-theme='liquid'] 规则块；
//   C. src/components/Settings.tsx 的 THEMES 不含 key: 'liquid'（不可选）；
//   D. electron/db.ts 对 theme==='liquid' 有单向迁移为 glass 的兜底（loadSettings + reloadAll）；
//   E. ThemeContext 的 isGlass 仍把 liquid 当作历史兜底（不报错即可，运行时已不可达）。
//
// 运行：node scripts/verify-liquid-glass.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');

const vars = read('src/theme/variables.css');
const css = read('src/styles/index.css');
const settings = read('src/components/Settings.tsx');
const db = read('electron/db.ts');
const themeCtx = read('src/theme/ThemeContext.tsx');

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

// 只匹配「真正的规则块开头」，不匹配注释里出现的 liquid 字样（如历史说明、变量命名残留）。
const LIQUID_RULE = /\[data-theme=['"]liquid['"]\]\s*\{/;

console.log('=== A/B. CSS 中 liquid 主题规则块已删除（删净护栏）===');
const varHit = (vars.match(/\[data-theme=['"]liquid['"]\]/g) || []).join(', ') || '(无)';
const cssHit = (css.match(/\[data-theme=['"]liquid['"]\]/g) || []).join(', ') || '(无)';
check('A variables.css 不存在 [data-theme=\'liquid\'] 规则块', !LIQUID_RULE.test(vars), varHit);
check('B index.css 不存在 [data-theme=\'liquid\'] 规则块', !LIQUID_RULE.test(css), cssHit);

console.log('\n=== C. THEMES 不再收录 liquid（不可选）===');
const themesBlock = settings.match(/export const THEMES[\s\S]*?\n\];/);
check('C1 找到 THEMES 定义', !!themesBlock);
check('C2 THEMES 不含 key: \'liquid\'', !!themesBlock && !/key:\s*'liquid'/.test(themesBlock[0]),
  themesBlock ? (themesBlock[0].match(/key:\s*'(\w+)'/g) || []).join(', ') : '');

console.log('\n=== D. 老数据单向迁移兜底（db.ts）===');
check('D1 db.ts 对 theme===\'liquid\' 有迁移为 glass 的兜底',
  /this\.settings\.theme\s*===\s*'liquid'/.test(db) && /saveSettings\(\{\s*theme:\s*'glass'\s*\}\)/.test(db));
check('D2 db.ts reloadAll 同样兜底备份残留的 liquid',
  /reloadAll[\s\S]{0,400}?theme\s*===\s*'liquid'/.test(db));

console.log('\n=== E. liquid 仅作历史兜底，不报错 ===');
check('E1 ThemeContext 仍把 liquid 纳入 isGlass 兜底（运行时不可达即可）',
  /const isGlass\s*=\s*theme\s*===\s*'glass'\s*\|\|\s*theme\s*===\s*'frost'\s*\|\|\s*theme\s*===\s*'liquid'/.test(themeCtx));

console.log('\n' + '='.repeat(64));
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('❌ 液态玻璃未彻底删净');
  process.exit(1);
}
console.log('✅ 液态玻璃主题已彻底删净（无残留 CSS 规则块 / 不可选 / 老数据已迁移）');
