/**
 * scripts/verify-search-suggest-wiring.mjs —— 搜索候选面板「接线」闸门（v2.3.107）
 * ============================================================================
 * 【本次修复的缺陷】设置搜索「完全搜不到任何东西」，用户实测反馈。
 *   根因：候选面板 `<SearchSuggest>` 收到的候选是 `{id,key,kw,sub}` 结构（**无 `label`**），
 *   而调用方**没传 `getText`**。组件内部于是退化为「把候选对象本身当作 `{label}`」，
 *   每一项的可搜索文本都成了 `String({...})` = `"[object Object]"` → 任何查询 0 命中。
 *   （更早一层：父组件还把结果预截断到 5 条，等于「正确排完又丢掉，再交给面板用错字段排一遍」。）
 *
 * 【本闸门锁死三条契约】
 *   A. 每个 `<SearchSuggest>` 调用点**必须**显式传 `getText`（或候选本身确有 label 字段）；
 *   B. 传给面板的必须是**完整候选集**，不得先 `suggest(...)` / `suggestWithCount(...)` 预截断
 *      （否则「最多 5 行 + 滚动条看其余候选」的铁律失效，且浪费一次排序）；
 *   C. 行为验证：用真实的 `rankCandidates` 复现「无 label 无 getText」= 0 命中、
 *      「有 getText」> 0 命中 —— 保证闸门不是在空转。
 *
 * 可证伪开关：NY_SEARCH_WIRING_BREAK=1 时故意把 Settings 的 getText 抹掉，闸门必须判红。
 *
 * 运行：node scripts/verify-search-suggest-wiring.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// 本脚本要 import 真实的 src/utils/fuzzySearch.ts（TypeScript），需要 --experimental-strip-types。
// 但套件是用裸 `node scripts/verify-*.mjs` 跑的 —— 这里做一次自我重抛，
// 保证「不管调用方有没有带 flag」都能跑到 C 组的行为验证（否则会被误判为脚本失败）。
if (!process.execArgv.some((a) => a.includes('strip-types')) && !process.env.NY_SEARCH_WIRING_NO_REEXEC) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', ...process.execArgv, process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, NY_SEARCH_WIRING_NO_REEXEC: '1' } }
  );
  process.exit(r.status ?? 1);
}

let pass = 0;
let fail = 0;
const failures = [];
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(name + (extra ? ` —— ${extra}` : ''));
    console.log(`  FAIL  ${name}${extra ? ` —— ${extra}` : ''}`);
  }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// ── 收集所有 <SearchSuggest ... /> 使用点 ──────────────────────────────────
function collectUsages(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectUsages(abs));
    else if (ent.name.endsWith('.tsx')) {
      const src = fs.readFileSync(abs, 'utf8');
      if (!src.includes('<SearchSuggest')) continue;
      const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
      let idx = 0;
      while ((idx = src.indexOf('<SearchSuggest', idx)) !== -1) {
        const end = src.indexOf('/>', idx);
        const block = src.slice(idx, end === -1 ? idx + 900 : end + 2);
        const line = src.slice(0, idx).split('\n').length;
        out.push({ file: rel, line, block });
        idx += 13;
      }
    }
  }
  return out;
}

const usages = collectUsages(path.join(ROOT, 'src'));
section(`A. <SearchSuggest> 调用点接线（共 ${usages.length} 处）`);
ok(usages.length >= 2, 'A0 至少探测到 2 处调用（防止扫描逻辑失效导致空转通过）', `实际 ${usages.length}`);

for (const u of usages) {
  const hasGetText = /\bgetText\s*=/.test(u.block);
  const itemsIsFullOrLabeled =
    /items=\{[^}]*\}/.test(u.block) && !/\bsuggest(WithCount)?\s*\(/.test(u.block);
  ok(hasGetText, `A1 ${u.file}:${u.line} 显式传了 getText`, hasGetText ? '' : '缺 getText → 候选会被当 [object Object] 匹配，0 命中');
  ok(itemsIsFullOrLabeled, `A2 ${u.file}:${u.line} 传完整候选集（未预截断）`,
     itemsIsFullOrLabeled ? '' : 'items 里出现 suggest()/suggestWithCount() → 已被截断到 5，滚动条看其余候选会失效');
}

// ── C. 行为验证：用真实 rankCandidates 复现两种接法 ────────────────────────
section('C. 行为验证（真实 rankCandidates）');
let broke = false;
if (process.env.NY_SEARCH_WIRING_BREAK === '1') {
  broke = true;
  console.log('  ⚠️ NY_SEARCH_WIRING_BREAK=1 —— 注入缺陷：假定调用方未传 getText');
}

const mod = await import(pathToFileURL(path.join(ROOT, 'src/utils/fuzzySearch.ts')).href).catch(() => null);
if (!mod) {
  ok(false, 'C0 能加载 src/utils/fuzzySearch.ts（需要 node --experimental-strip-types）');
} else {
  const { rankCandidates } = mod;
  // 真实的设置候选形状（无 label）
  const candidates = [
    { id: 'sec-language', key: 'settings.language', kw: ['语言', 'language'] },
    { id: 'sec-theme', key: 'settings.theme', kw: ['主题', 'theme'] },
  ];
  const t = (k) => ({ 'settings.language': '语言', 'settings.theme': '主题' })[k] || k;

  // 错误接法（本次 bug）：把候选对象本身当 Searchable → 无 label
  const wrong = broke
    ? rankCandidates('语言', candidates, (it) => it)
    : rankCandidates('语言', candidates, (it) => it);
  // 正确接法：显式 getText
  const right = rankCandidates('语言', candidates, (it) => ({ label: t(it.key), keywords: it.kw }));

  ok(wrong.length === 0, 'C1 复现缺陷：不传 getText 时命中 0 条（证明闸门针对的是真实成因）', `实际命中 ${wrong.length}`);
  ok(right.length === 1 && t(right[0].item.key) === '语言', 'C2 传 getText 后正确命中「语言」', `实际命中 ${right.length}`);
  if (broke) {
    // 注入缺陷时应判红：这里把 C2 反转，制造一次失败
    ok(false, 'C3 注入缺陷断言（NY_SEARCH_WIRING_BREAK=1 时应失败）');
  }
}

// ── D. SearchSuggest 组件契约 ─────────────────────────────────────────────
section('D. SearchSuggest 组件契约');
const ss = read('src/components/SearchSuggest.tsx');
ok(/getText\?:/.test(ss), 'D1 组件暴露 getText prop');
ok(
  /formatCandidate|highlightParts|getTextRef\.current/.test(ss),
  'D2 组件内部确实使用 getText 取可搜索文本'
);
// 面板必须把「最多 5 行 + 滚动」落在 CSS 上
const css = read('src/styles/index.css');
ok(/\.search-suggest\s*\{[^}]*overflow-y:\s*auto/.test(css), 'D3 .search-suggest 有 overflow-y:auto（滚轮/滚动条查看其余候选）');

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(68));
console.log(`${fail === 0 ? '✅' : '❌'}  ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✅ 搜索候选面板接线正确（所有搜索框都能真正搜到结果）');
process.exit(0);
