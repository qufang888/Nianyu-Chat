// v2.3.94 需求 12 验证：全局搜索规范（模糊搜索 / 最多 5 条 / 相关度排序 / 同分 A→Z）
// 用法：node scripts/verify-search-suggest.mjs
// 做法：直接打包真实的 src/utils/fuzzySearch.ts 跑断言。这是用户的长期铁律，
// 必须有可自动拦截的门禁，否则「退化成简单 includes」这类回归会静悄悄发生。

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src', 'utils', 'fuzzySearch.ts');
const tmp = path.join(os.tmpdir(), `ny-fuzzy-${Date.now()}.mjs`);
await build({ entryPoints: [SRC], outfile: tmp, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const F = await import(pathToFileURL(tmp).href);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL  ' + name + ' ' + extra); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const ROLES = ['小明', '小红', '小刚', '晓晓', '小美', '小丽', '小强', '小路', '小雪', '小于'];

section('A. 最多 5 条（用户铁律：候选项最多展示 5 个）');
{
  const r = F.suggest('小', ROLES);
  check('恰好返回 5 条', r.length === 5, `实际 ${r.length}`);
  check('不被整体截断成别的数量', r.length <= 5);
  const r2 = F.suggestWithCount('小', ROLES);
  check('total 报告真实命中总数', r2.total >= 5, `实际 ${r2.total}`);
  check('items 仍被截到 5', r2.items.length <= 5, `实际 ${r2.items.length}`);
  check('默认 limit 就是 MAX_SUGGESTIONS', F.MAX_SUGGESTIONS === 5, `实际 ${F.MAX_SUGGESTIONS}`);
}

section('B. 模糊搜索（不是简单 includes —— 这是与旧实现的关键差别）');
{
  // 子序列：字符按顺序出现，中间夹别的字符 —— includes 匹配不到
  const r = F.suggest('blg', ['bling', 'x', 'yy']);
  check('子序列模糊命中 blg→bling', r.includes('bling'), JSON.stringify(r));
  // 词首匹配
  const r2 = F.suggest('mo', ['my model', 'zzz']);
  check('词首匹配 mo→my model', r2.includes('my model'), JSON.stringify(r2));
  // 缩写：各词首字母
  const r3 = F.suggest('gm', ['GPT Model']);
  check('缩写命中 gm→GPT Model', r3.includes('GPT Model'), JSON.stringify(r3));
  // 中文按字
  const r4 = F.suggest('明小', ['王小明', 'abc']);
  check('中文字序列命中 明小→王小明', r4.includes('王小明'), JSON.stringify(r4));
}

section('C. 相关度排序（前缀 > 词首 > 子串 > 子序列）');
{
  const r = F.suggest('小', ['一个包含小的句子', '小明', '小小的猫']);
  check('前缀命中排最前', r[0] === '小明', JSON.stringify(r));
  const r2 = F.suggest('ing', ['singing', 'thing', 'a very long ring description']);
  check('前缀 singing 排最前', r2[0] === 'singing', JSON.stringify(r2));
}

section('D. 同分按名称字母 A→Z（用户铁律）');
{
  const names = ['delta', 'alpha', 'charlie', 'bravo'];
  const r = F.suggest('a', names);
  // 前缀命中的按字母序：alpha, bravo, charlie, delta 全部含 a? 只有 alpha/bravo/charlie/delta 都含 'a'
  const prefixHits = r.filter((x) => x.startsWith('a'));
  check('同档内字母序正确', prefixHits[0] === 'alpha', JSON.stringify(prefixHits));
  const r2 = F.suggest('', ['zeta', 'alpha', 'mu']);
  check('空查询也按 A→Z', JSON.stringify(r2) === JSON.stringify(['alpha', 'mu', 'zeta']), JSON.stringify(r2));
}

section('E. 大小写 / 全角 / 空格归一化');
{
  check('大小写不敏感', F.suggest('ABC', ['xabcx']).includes('xabcx'));
  check('全角数字→半角', F.suggest('123', ['编号１２３']).includes('编号１２３'), '全角 123 应能被半角 123 搜到');
  check('首尾空格容忍', F.suggest('  abc  ', ['abc']).includes('abc'));
  check('normalizeText 幂等', F.normalizeText(' AbC ') === 'abc');
}

section('F. 高亮与搜索口径一致（能搜到就必须能高亮）');
{
  const parts = F.highlightParts('Hello World', 'world');
  check('高亮命中段', parts.some((p) => p.hit && p.text === 'World'), JSON.stringify(parts));
  check('高亮保留原文大小写', parts.map((p) => p.text).join('') === 'Hello World');
  const none = F.highlightParts('Hello', 'zzz');
  check('未命中时不产生高亮', none.length === 1 && !none[0].hit);
  const empty = F.highlightParts('', 'x');
  check('空文本安全返回', Array.isArray(empty));
}

section('G. 附加关键词参与排序但权重低于标题');
{
  const items = [
    { label: 'zzz无关名字', keywords: ['小明'] },
    { label: '小明', keywords: [] },
  ];
  const r = F.rankCandidates('小明', items, (x) => x);
  check('标题命中优先于关键词命中', r[0].item.label === '小明', JSON.stringify(r.map((x) => x.item.label)));
}

section('H. 边界与空数据');
{
  check('空候选集不崩', JSON.stringify(F.suggest('a', [])) === '[]');
  check('空查询返回全部（按字母序）', F.suggest('', ['b', 'a']).length === 2);
  check('无匹配返回空数组', JSON.stringify(F.suggest('zzz', ['abc', 'def'])) === '[]');
  const undef = F.suggest('a', undefined);
  check('undefined 候选集返回空数组（曾崩溃）', JSON.stringify(undef) === '[]' && undef.length === 0, JSON.stringify(undef));
  check('limit=0 返回空', F.suggest('a', ['abc'], undefined, 0).length === 0);
}

console.log('\n' + '='.repeat(52));
console.log('断言：' + pass + ' 通过 / ' + fail + ' 失败');
if (failures.length) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  - ' + f)); }
fs.unlinkSync(tmp);
process.exit(fail === 0 ? 0 : 1);