#!/usr/bin/env node
/**
 * verify-settings-cats.mjs — v2.3.102 需求 3「设置重分类 + 高级设置折叠 + 搜索可达」**独立**验证。
 *
 * ── 本脚本防的是什么回归（存在的理由）──────────────────────────────────────────
 *   需求 3 把设置重分为 7 类并把部分设置移入各类「高级设置」折叠区，同时要求搜索仍能「搜到且点得到」。
 *   最易回归的两点：
 *     · 分类**四元脱节**：SETTING_CATS（导航）/ 面板 `<div id="cat-*">` / catRefs 键 / 搜索索引 cat-* 条目
 *       只要有一处改名或漏改，就会出现「搜索能列出、点进去却落空」的静默 bug → 本门四元一致性即变红。
 *     · 折叠体被改成条件渲染 `{open && <...>}`：则收起态的锚点**不在 DOM**，`document.getElementById`
 *       命中失败 → 「搜到点不到」。本门 R3e/f 断言折叠体**始终挂载**。
 *   立场：**不复用**实现者自己的 verify-settings-index.mjs 解析结果（那是被审对象），独立解析 Settings.tsx。
 *
 * 断言：
 *   R3a SETTING_CATS id 集合（顺序敏感）== 设计规定的 7 类，且顺序完全一致
 *   R3b 面板 <div id="cat-*"> 出现顺序（排除二级页 cat-models）== SETTING_CATS 顺序
 *   R3c catRefs 键集合 == SETTING_CATS id 集合（无失效、无多余）
 *   R3d SettingSearchItem 结构里**没有** cat 字段 → 退而求其次：SETTING_SEARCH_INDEX 中 ^cat- 条目 id 集合 == SETTING_CATS
 *   R3e AdvancedSection 组件内 .advanced-body **无条件渲染**（无 {open && ...} / 三目）
 *   R3f 全文件不存在 `{open &&` / `{open ?` 形式对折叠体/折叠区的条件渲染
 *   R3g goToSetting 的命中判定**不依赖**元素可见性/尺寸（无 offsetParent / clientHeight / getBoundingClientRect）
 *   R3h goToSetting 命中判定确实用 document.getElementById（否则收起态会「搜到点不到」的前提不成立）
 *
 * 用法：node scripts/verify-settings-cats.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const BREAK = process.env.NY_QA_R3_BREAK === '1';
if (BREAK) console.log('⚠️  NY_QA_R3_BREAK=1（把 cat-appearance 改名 cat-look → 分类四元一致/顺序断言应变红）');
const rawCode = fs.readFileSync(path.join(ROOT, 'src/components/Settings.tsx'), 'utf8');
// 去注释：折叠区修复说明的**注释里就写着** `{open && ...}` 示例，会把「条件渲染」误判成命中。
let code = rawCode
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .split('\n')
  .map((l) => (/^\s*\/\//.test(l) ? '' : l))
  .join('\n');
// 破坏：仅改 SETTING_CATS 里的一项 id（模拟「分类整体改名」漂移），其余不动
if (BREAK) {
  code = code.replace(
    "{ id: 'cat-appearance', labelKey: 'settings.catAppearance' },",
    "{ id: 'cat-look', labelKey: 'settings.catAppearance' },"
  );
}
// 条件渲染的 `{open && ...}` 只在「JSX 子表达式位置」出现：`{` 前是空白或 `>`；
// 而 `data-open={open ? ...}` 的 `{` 前是 `=`（属性），不是条件渲染 —— 必须排除。
const CAREFUL_SRC = '(^|[\\s>])\\{\\s*open\\s*(?:&&|\\?)';
const CAREFUL = new RegExp(CAREFUL_SRC);
const CAREFUL_G = new RegExp(CAREFUL_SRC, 'g');

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✔ ' + name); }
  else { fail++; const l = `  ✗ ${name}${extra ? ' — ' + extra : ''}`; failures.push(l); console.log(l); }
};

const EXPECT_ORDER = ['cat-general', 'cat-appearance', 'cat-chat', 'cat-proactive', 'cat-social', 'cat-extensions', 'cat-window'];

// ---------- SETTING_CATS ----------
function extractArrayLiteral(src, name) {
  const start = src.indexOf(`const ${name}`);
  if (start < 0) return null;
  const assign = src.indexOf('=', start);
  const open = src.indexOf('[', assign);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}
const catsLit = extractArrayLiteral(code, 'SETTING_CATS') || '';
const catIds = [...catsLit.matchAll(/\{\s*id:\s*'([^']+)'\s*,\s*labelKey:\s*'([^']+)'\s*\}/g)].map((m) => m[1]);

console.log('=== R3a SETTING_CATS 有序清单 ===');
console.log('  解析到：' + catIds.join(' → '));
check(`R3a SETTING_CATS 顺序 == 设计规定 7 类顺序`,
  catIds.length === 7 && catIds.join(',') === EXPECT_ORDER.join(','),
  `期望 ${EXPECT_ORDER.join(',')} / 实际 ${catIds.join(',')}`);

// ---------- 面板 JSX 顺序 ----------
const panelIds = [...code.matchAll(/<div\s+id="(cat-[a-z-]+)"/g)].map((m) => m[1]);
const panelNoModels = panelIds.filter((x) => x !== 'cat-models');
console.log('\n=== R3b 面板出现顺序 ===');
console.log('  解析到（含二级页）：' + panelIds.join(' → '));
check('R3b 面板出现顺序（排除 cat-models）== SETTING_CATS 顺序',
  panelNoModels.join(',') === catIds.join(','),
  `面板 ${panelNoModels.join(',')} / CATS ${catIds.join(',')}`);
check('R3b cat-models 仍存在且为二级页容器（不在 nav）', panelIds.includes('cat-models') && !catIds.includes('cat-models'));

// ---------- catRefs ----------
const refs = new Set([...code.matchAll(/catRefs\.current\[['"]([^'"]+)['"]\]\s*=/g)].map((m) => m[1]));
console.log('\n=== R3c catRefs ===');
console.log('  catRefs 键：' + [...refs].join(', '));
check('R3c catRefs 键集合 == SETTING_CATS id 集合（无失效/无多余）',
  refs.size === catIds.length && catIds.every((c) => refs.has(c)),
  `多余/缺失：${[...refs].filter((r) => !catIds.includes(r)).join(',') || '无多余'}; 缺失：${catIds.filter((c) => !refs.has(c)).join(',') || '无'}`);

// ---------- 搜索索引 ----------
const idxLit = extractArrayLiteral(code, 'SETTING_SEARCH_INDEX') || '';
const idxIds = [...idxLit.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
const catInIndex = idxIds.filter((x) => x.startsWith('cat-'));
const hasCatField = /\bcat\s*:/.test(idxLit);
console.log('\n=== R3d 搜索索引 ===');
console.log(`  索引共 ${idxIds.length} 条；cat-* 条目：${catInIndex.join(', ')}`);
check('R3d-a 前提核对：SettingSearchItem 是否含 `cat` 字段（任务书假设）', !hasCatField,
  hasCatField ? '含 cat 字段' : '**不含 cat 字段** —— 任务书「每条候选的 cat 取值范围」在本实现里不存在，改用 cat-* 条目 id 集合核对');
check('R3d-b SETTING_SEARCH_INDEX 中 ^cat- 条目 id 集合 == SETTING_CATS id 集合',
  new Set(catInIndex).size === catIds.length && catIds.every((c) => catInIndex.includes(c)),
  `索引 cat-* = ${[...new Set(catInIndex)].sort().join(',')}`);

// ---------- 折叠区始终挂载 ----------
console.log('\n=== R3e/f 折叠区始终挂载 ===');
const advStart = code.indexOf('function AdvancedSection(');
let advBody = '';
if (advStart >= 0) {
  // 取到下一个顶层 function / const 之前（该函数较短）
  const end = code.indexOf('\nconst SETTING_SEARCH_INDEX', advStart);
  advBody = code.slice(advStart, end > advStart ? end : advStart + 2000);
}
check('R3e-1 AdvancedSection 组件存在', advStart >= 0);
check('R3e-2 组件内 .advanced-body 为无条件 JSX（存在 `<div className="advanced-body"`）',
  /<div\s+className="advanced-body"/.test(advBody));
check('R3e-3 组件内**没有** `{open && ...}` / `{open ? ...}` 包裹折叠体',
  !CAREFUL.test(advBody), (advBody.match(CAREFUL) || []).map((s) => s.trim()).join(','));

const openCond = [...code.matchAll(CAREFUL_G)].map((m) => code.slice(0, m.index).split('\n').length);
check('R3f 全文件不存在 `{open &&` / `{open ?` 形式（折叠体不靠 open 条件渲染）', openCond.length === 0,
  openCond.length ? `行号：${openCond.join(', ')}` : '');

// 反向：折叠体是否被包在某个条件里（启发式：AdvancedSection 的 children 是直接 JSX，不是 {cond && <...>}）
// 只要 .advanced-body-inner 直接包 children 即可：
check('R3e-4 折叠体结构为 .advanced-body > .advanced-body-inner > {children}',
  /className="advanced-body"[\s\S]{0,200}?className="advanced-body-inner">\{children\}/.test(advBody));

// ---------- goToSetting ----------
console.log('\n=== R3g/h goToSetting 命中判定 ===');
const gStart = code.indexOf('const goToSetting = (id: string');
const gBody = gStart >= 0 ? code.slice(gStart, gStart + 2600) : '';
check('R3h goToSetting 命中用 document.getElementById(id)（收起态锚点仍在 DOM → 可命中）',
  /document\.getElementById\(id\)/.test(gBody));
check('R3g 命中判定不依赖可见性/尺寸（无 offsetParent / clientHeight / offsetHeight / getBoundingClientRect）',
  !/(offsetParent|clientHeight|offsetHeight|getBoundingClientRect)/.test(gBody),
  (gBody.match(/(offsetParent|clientHeight|offsetHeight|getBoundingClientRect)/g) || []).join(','));
check('R3g-2 命中失败仅因元素**不存在**（`if (!el) return false;` 形式）',
  /if\s*\(!el\)\s*return false;/.test(gBody));
check('R3g-3 目标在折叠区内时**先展开**（setAdvOpen(sectionId, true)）后再定位',
  /setAdvOpen\(sectionId,\s*true\)/.test(gBody) && /closest\('\.advanced-section'\)/.test(gBody));

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(64));
console.log(`${fail === 0 ? '✅' : '❌'}  ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
process.exit(0);
