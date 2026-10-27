// v2.3.107 回归守卫（原 v2.3.97「液态玻璃可读性」闸门已随主题删除而退役）
// ============================================================================
//
// 【背景】v2.3.107 需求 7 按用户要求**整体删除**液态玻璃（liquid）主题：
//   · THEMES 不再收录 → 不可选；
//   · variables.css / index.css 的 [data-theme='liquid'] 段落已删；
//   · 关联设置（liquidFlow / dyeFromBackground 等）UI 一并移除；
//   · 读盘层（electron/db.ts）对老数据 theme==='liquid' 单向迁移落盘。
//
// 【v2.3.108 更新】aura（琉璃幻境 / Liquid Aura）作为同设计语言继任主题加入玻璃家族：
//   · 迁移目标由 glass 改为 aura；
//   · ThemeContext isGlass = glass/frost/aura（不再含 liquid）；
//   · THEMES 收录 aura、variables.css 提供 [data-theme='aura'] 令牌块。
//
// 【本脚本现在的职责】「验证 liquid 已彻底删净 + aura 已就位」双护栏，
// 防止后续改动让 liquid 死灰复燃（漏删的 CSS 规则块 / 重新进 THEMES / 漏迁移老数据）。
//   A. variables.css 不存在任何 [data-theme='liquid'] 规则块；
//   B. index.css 不存在任何 [data-theme='liquid'] 规则块；
//   C. src/components/Settings.tsx 的 THEMES 不含 key: 'liquid'（不可选），且含 'aura'；
//   D. electron/db.ts 对 theme==='liquid' 有单向迁移为 aura 的兜底（loadSettings + reloadAll）；
//   E. ThemeContext 的 isGlass = glass/frost/aura（liquid 已彻底退出，不残留兜底）。
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
check('D1 db.ts 对 theme===\'liquid\' 有迁移为 aura 的兜底',
  /this\.settings\.theme(?:\s+as\s+string)?\s*\)?\s*===\s*'liquid'/.test(db) && /saveSettings\(\{\s*theme:\s*'aura'\s*\}\)/.test(db));
check('D2 db.ts reloadAll 同样兜底备份残留的 liquid',
  /reloadAll[\s\S]{0,400}?theme\s*===\s*'liquid'/.test(db));

console.log('\n=== E. 毛玻璃主题已删除，磨砂观感改为每主题开关 ===');
check('E1 ThemeContext 玻璃开关机制就位（data-glass 由 settings.glassEffect 驱动）',
  /if \(settings\.glassEffect\) root\.setAttribute\('data-glass', 'on'\);[\s\S]{0,80}?else root\.removeAttribute\('data-glass'\);/.test(themeCtx));
check('E2 ThemeContext 不再有 glass 主题专属逻辑（isGlass/glassTintScope 已删）',
  !/isGlass|glassTintScope|glassTint|glassBg/.test(themeCtx));
check('E3 ThemeContext 不再引用已删除的 glass 主题', !/theme === 'glass'/.test(themeCtx));
check('E4 variables.css 提供 [data-glass=\'on\'] 开关规则块（模糊令牌）',
  /\[data-glass=['"]on['"]\]\s*\{[\s\S]*?--blur/.test(vars));
check('E5 index.css 有 [data-glass=\'on\'] 半透明承载面规则（color-mix 派生）',
  /\[data-glass='on'\] \.sidebar \{ background: color-mix/.test(css));
check('E6 db.ts 老数据 theme===\'glass\' 迁移为 galaxy 且开 glassEffect',
  /theme as string\) === 'glass'\)\s*\{\s*this\.saveSettings\(\{ theme: 'galaxy', glassEffect: true \}\)/.test(db));
console.log('\n=== F. aura 主题令牌就位 ===');
check('F1 variables.css 存在 [data-theme=\'aura\'] 规则块', /\[data-theme=['"]aura['"]\]\s*\{/.test(vars));
check('F2 aura 块含 auto-contrast 看门狗契约令牌',
  /\[data-theme=['"]aura['"]\]\s*\{[\s\S]*?--auto-contrast-base[\s\S]*?--auto-contrast-flip-text/.test(vars));

console.log('\n' + '='.repeat(64));
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('❌ liquid 未彻底删净或 aura 未就位');
  process.exit(1);
}
console.log('✅ 液态玻璃已彻底删净 + 琉璃幻境（aura）已就位（无残留规则块 / 不可选 / 老数据迁移 aura / 玻璃家族含 aura）');
