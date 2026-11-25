/**
 * v3.0.18 日记/加密文案 10 处闸门：键集一致 / 无空值 / 占位符一致 / DiaryView 无裸中文 /
 * 设置锚点与静态索引登记。纯源码级强断言（解析真实字典，不做字符串计数）。
 * 用法：node scripts/verify-diary-i18n-10.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TRANS = path.join(ROOT, 'src/i18n/translations.ts');
const LOCALES = path.join(ROOT, 'src/i18n/locales');
const src = fs.readFileSync(TRANS, 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

function inlineDict(lang) {
  const re = new RegExp(`\\n  ${lang}: \\{`);
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  const body = src.slice(open + 1, end);
  const out = {};
  const kv = /^\s*'([^']+)'\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*$/gm;
  let e;
  while ((e = kv.exec(body)) !== null) out[e[1]] = (e[2] ?? e[3]).replace(/\\'/g, "'");
  return out;
}

const diaries = ['zh', 'en'].map((l) => inlineDict(l));
const others = ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'].map((l) =>
  JSON.parse(fs.readFileSync(path.join(LOCALES, l + '.json'), 'utf8')));
const dicts = [diaries[0], diaries[1], ...others];
const names = ['translations.zh', 'translations.en', ...['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'].map((l) => 'locales/' + l)];

const isDiaryKey = (k) => k === 'nav.diary' || k.startsWith('diary.') || k.startsWith('settings.diary') || k === 'animCtl.groupDiary';
const keys = Object.keys(dicts[0]).filter(isDiaryKey).sort();

section('A. 10 处键集一致');
ok('基准字典日记键数量 >= 45', keys.length >= 45, String(keys.length));
for (let i = 0; i < dicts.length; i++) {
  const own = Object.keys(dicts[i]).filter(isDiaryKey).sort();
  ok(names[i] + ' 键集与 zh 一致', JSON.stringify(own) === JSON.stringify(keys));
}

section('B. 无空值');
for (let i = 0; i < dicts.length; i++) {
  const empty = keys.filter((k) => typeof dicts[i][k] !== 'string' || dicts[i][k].trim() === '');
  ok(names[i] + ' 无空值', empty.length === 0, empty.join(','));
}

section('C. 占位符一致');
function placeholders(s) { return [...String(s).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort().join(','); }
let phBad = [];
for (const k of keys) {
  const want = placeholders(dicts[0][k]);
  if (dicts.some((d) => placeholders(d[k]) !== want)) phBad.push(k);
}
ok('全部日记键占位符集合一致', phBad.length === 0, phBad.join(','));

section('D. DiaryView 无裸中文 / 设置项登记');
const viewSrc = fs.readFileSync(path.join(ROOT, 'src/components/DiaryView.tsx'), 'utf8');
const CJK = /[\u4e00-\u9fff]/;
const hits = [];
let inBlock = false;
viewSrc.split(/\r?\n/).forEach((line, i) => {
  const s = line.trim();
  if (inBlock) { if (s.includes('*/')) inBlock = false; return; }
  if (s.startsWith('/*')) { if (!s.includes('*/')) inBlock = true; return; }
  if (s.startsWith('//') || s.startsWith('*') || s.startsWith('{/*')) return;
  if (!CJK.test(line)) return;
  if (/>[^<>{}]*[\u4e00-\u9fff][^<>{}]*</.test(line) ||
      /(?:title|placeholder|aria-label|alt|label)\s*=\s*"[^"]*[\u4e00-\u9fff][^"]*"/.test(line)) {
    hits.push(i + 1 + ': ' + s.slice(0, 100));
  }
});
ok('DiaryView.tsx 无用户可见裸中文', hits.length === 0, hits.join(' | '));
const setSrc = fs.readFileSync(path.join(ROOT, 'src/components/Settings.tsx'), 'utf8');
ok('sec-diary-privacy 锚点存在', setSrc.includes('id="sec-diary-privacy"'));
ok('ADVANCED_ANCHORS 已登记', /'sec-diary-privacy': 'adv-chat'/.test(setSrc));
ok('SETTING_SEARCH_INDEX 已登记（中英关键词）',
  /\{ id: 'sec-diary-privacy'[\s\S]{0,240}日记[\s\S]{0,120}diary/.test(setSrc));

console.log(`\n${fail === 0 ? '✅' : '❌'} 日记 i18n 10 处闸门：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
