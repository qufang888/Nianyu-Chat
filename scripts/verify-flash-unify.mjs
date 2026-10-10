#!/usr/bin/env node
// scripts/verify-flash-unify.mjs —— v2.3.102 需求 4「闪动统一」的跨文件一致性门
//
// 这个脚本防的是什么：
//   1) 有人又在组件里手写 `classList.add('setting-flash')` / `classList.remove('model-flash')`
//      —— 绕开统一工具 → 时长/去抖/清类逻辑分叉，回到"有的 5s 有的 3.2s、第二次不闪"的老毛病；
//   2) index.css 的闪动动画被改回两套（或改了时长/次数），与 JS 侧 FLASH_MS 脱钩；
//   3) CSS 侧「1s × 5」与 JS 侧 FLASH_MS 不再严格配对（改了其一忘了另一）。
//
// 断言读真源码。可证伪性：
//   NY_FLASH_UNIFY_BREAK=1  把 index.css 的 `flashPulse 1s linear 5` 改成 `1s linear 3`
//                           → 应红（F1 值不符 + F3 配对不符，3000ms ≠ 5000ms）
//
// 用法：node scripts/verify-flash-unify.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const read = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function lineOf(text, idx) { return idx < 0 ? -1 : text.slice(0, idx).split('\n').length; }
function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const BREAK = process.env.NY_FLASH_UNIFY_BREAK === '1';
if (BREAK) console.log('⚠️  破坏开关已启用：NY_FLASH_UNIFY_BREAK（脚本应当变红并 exit 1）');

let css = read('src/styles/index.css');
const flashTs = read('src/utils/flash.ts');
const animCtl = read('src/utils/animControl.ts');
if (BREAK) {
  const before = css;
  css = css.replace('flashPulse 1s linear 5', 'flashPulse 1s linear 3');
  if (css === before) console.log('   （NY_FLASH_UNIFY_BREAK 未命中任何文本，破坏可能无效）');
}

// ──────────────────────────── F1/F2/F3 ────────────────────────────
section('F1–F3 index.css 闪动动画与 flash.ts 严格配对');
const rule = css.match(/\.setting-flash\s*,\s*\.model-flash\s*\{([^}]*)\}/);
const animVal = rule ? ((rule[1].match(/animation\s*:\s*([^;]+);/) || [])[1] || '').trim().replace(/\s+/g, ' ') : '';
check('F1 `.setting-flash, .model-flash` 使用共享 keyframe，值为 `flashPulse 1s linear 5`',
  animVal === 'flashPulse 1s linear 5', rule ? `实际="${animVal}"` : '未找到 `.setting-flash, .model-flash { ... }` 规则');

const parts = animVal.match(/flashPulse\s+([\d.]+)s\s+linear\s+(\d+)/);
const durS = parts ? Number(parts[1]) : NaN;
const iter = parts ? Number(parts[2]) : NaN;
const totalMs = durS * 1000 * iter;
const flashMs = Number((flashTs.match(/export const FLASH_MS\s*=\s*(\d+)/) || [])[1]);

check('F2 flash.ts 导出 `FLASH_MS = 5000`', flashMs === 5000, `实际 FLASH_MS=${flashMs}`);
check(`F3 CSS 时长×次数 = FLASH_MS（${durS}s × ${iter} = ${totalMs}ms vs FLASH_MS=${flashMs}ms）`,
  Number.isFinite(totalMs) && totalMs === flashMs, `配对不符`);

// ──────────────────────────── F4/F5 ────────────────────────────
section('F4–F5 闪动统一走 flashElement（src/ 无手写 classList 闪动）');
const files = walk(path.join(ROOT, 'src'));
const bad = [];
let callSites = 0;
for (const abs of files) {
  const code = fs.readFileSync(abs, 'utf8');
  const re = /classList\.(add|remove|toggle|contains)\(\s*['"](setting-flash|model-flash)['"]/g;
  let m;
  while ((m = re.exec(code)) !== null) bad.push(`${rel(abs)}:${lineOf(code, m.index)}`);
  if (rel(abs) !== 'src/utils/flash.ts') callSites += (code.match(/\bflashElement\(/g) || []).length;
}
check('F4 src/ 下不存在手写 `classList.add/remove("setting-flash"|"model-flash")`',
  bad.length === 0, bad.join(', '));
check('F5 闪动统一调用点 ≥ 5 处（防止 F4 因无人调用而空转假通过）',
  callSites >= 5, `实际 ${callSites} 处`);

// ──────────────────────────── F6/F7 ────────────────────────────
section('F6–F7 keyframe 与动画分组');
check('F6 index.css 定义了 `@keyframes flashPulse`', /@keyframes\s+flashPulse\s*\{/.test(css));
const themeGroup = animCtl.slice(animCtl.indexOf("id: 'theme'"), animCtl.indexOf("id: 'scrollbar'"));
check('F7 `.setting-flash` / `.model-flash` 仍登记在 animControl 的 theme 动画组',
  /'\.setting-flash'/.test(themeGroup) && /'\.model-flash'/.test(themeGroup));

// ──────────────────────── F8/F9（v2.3.105 新增）────────────────────────
// 背景：用户反馈「我说正方形你就全部改成正方形了」——本版曾用
//   `.setting-flash, .model-flash { border-radius: var(--radius-sm) !important }`
// 把**所有**闪动目标强制成同一圆角，结果把本来正常的方形界面（.section-title /
// .list-item，实测 radius 本就是 0）也压成了小圆角，属于过度修改。
// 现已改为：闪动形状跟随控件自身，仅对实测确认会渲染成椭圆的目标（.mem-item）收敛圆角。
// F8/F9 把这条「按控件尺寸确定形状、不得一刀切」的约束固化成闸门。
section('F8–F9 闪动形状跟随控件（禁止一刀切统一圆角）');
const flashRuleBlk = css.match(/\.setting-flash\s*,\s*\.model-flash\s*\{([^}]*)\}/);
check('F8 `.setting-flash, .model-flash` 不再声明 border-radius（形状交给控件自身）',
  !!flashRuleBlk && !/border-radius/.test(flashRuleBlk[1]),
  flashRuleBlk && /border-radius/.test(flashRuleBlk[1]) ? `规则里仍有 border-radius：${flashRuleBlk[1].trim()}` : '');
// 更宽松但同样能兜住回归：整个 flash 相关段落里不得出现 !important 的 border-radius
const flashArea = css.slice(Math.max(0, css.indexOf('.setting-flash') - 600), css.indexOf('.setting-flash') + 1600);
check('F9 闪动规则不含 `border-radius … !important`（禁止强制统一形状）',
  !/border-radius\s*:[^;}]*!important/.test(flashArea),
  /border-radius\s*:[^;}]*!important/.test(flashArea) ? '存在 !important 的 border-radius' : '');
// 确认针对椭圆目标的**局部**修正确实存在（mem-item 横向撑满 + 大圆角 = 扁椭圆）
check('F10 记忆条目(.mem-item，16:1 扁长 + 22px 圆角)有局部圆角收敛规则',
  /\.mem-item\.setting-flash/.test(css) && /\.mem-item\.model-flash/.test(css));

// ──────────────────────────── 汇总 ────────────────────────────
console.log('\n' + '='.repeat(70));
console.log(`${fail === 0 ? '✅' : '❌'}  ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
process.exit(0);
