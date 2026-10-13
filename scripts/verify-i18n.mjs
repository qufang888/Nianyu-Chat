// v2.3.111 验证：全局 i18n 完整性（10 处语言键集一致 / 无空值 / 占位符一致）
// 用法：node scripts/verify-i18n.mjs
//
// 为什么需要这个脚本：项目有 10 处语言（translations.ts 的 zh/en + locales/ 8 JSON），
// 此前靠人肉同步。v2.3.111 实测暴露出两类问题：
//   ① 新增功能只改 translations.ts，漏改 8 个 locale → 非中英用户裸露原始 key；
//   ② 动态拼接 key（t(`filepicker.place.${pl.key}`)）的命名空间没登记全
//      （Windows 盘符 drive-* 每台机器动态生成，字典里根本不可能穷举）。
// 本脚本把「键集一致 / 非空 / 占位符一致」固化成常驻闸门。
//
// 断言分组：
//   A. 10 处语言键集两两一致（以 translations.ts zh 块为基准）；
//   B. 无空值 / 非字符串值；
//   C. 占位符一致：同一 key 在各语言的 {var} 集合必须相同（防「{v]}」类错位复发）；
//   D. 动态 key 命名空间抽查：已知动态模式（quickimport.* / momentMedia.* /
//      skill.err* / stats.gender.* / settings.font.* / filepicker.place.*）
//      的全部实际取值都在字典里（filepicker.place.drive-* 按设计动态，单独豁免并
//      要求通用格式键 driveFormat 存在）。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TRANS = path.join(ROOT, 'src', 'i18n', 'translations.ts');
const LOCALES_DIR = path.join(ROOT, 'src', 'i18n', 'locales');

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
    console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : ''));
  }
}
function section(t) {
  console.log('\n=== ' + t + ' ===');
}

// ---------- 解析 translations.ts 的 zh / en 两个字典块 ----------
// 文件结构：export const translations: Record<Lang, Dict> = { zh: {...}, en: {...}, de: deDict, ... }
// zh / en 是内联对象字面量，按 `  zh: {` 定位后做花括号配对抽取。
function parseInlineDict(src, lang) {
  const re = new RegExp(`\\n  ${lang}: \\{`);
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const body = src.slice(open + 1, end);
  const entries = {};
  // 只认「整行都是键值对」的行（JSX 文案里可能有撇号，行级匹配足够稳）。
  // 值侧同时兼容单引号与双引号（translations.ts 里两种书写风格混用）。
  const kv = /^\s*'([^']+)'\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*$/gm;
  let e;
  while ((e = kv.exec(body)) !== null) {
    entries[e[1]] = (e[2] ?? e[3]).replace(/\\'/g, "'").replace(/\\"/g, '"');
  }
  return entries;
}

const transSrc = fs.readFileSync(TRANS, 'utf8');
const zh = parseInlineDict(transSrc, 'zh') || {};
const en = parseInlineDict(transSrc, 'en') || {};
const LANGS = ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'];

check('translations.ts 解析出 zh / en 两个字典',
  Object.keys(zh).length > 100 && Object.keys(en).length > 100,
  `实得: zh=${Object.keys(zh).length} / en=${Object.keys(en).length}`);
const localeDicts = {};
for (const l of LANGS) {
  const p = path.join(LOCALES_DIR, `${l}.json`);
  if (!fs.existsSync(p)) {
    check(`locales/${l}.json 存在`, false);
    continue;
  }
  localeDicts[l] = JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------- A. 键集一致 ----------
section('A. 10 处语言键集一致');
{
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  check(`zh 与 en 键集一致（各 ${zhKeys.length} / ${enKeys.length}）`,
    zhKeys.length === enKeys.length && zhKeys.every((k, i) => k === enKeys[i]),
    zhKeys.filter((k) => !(k in en)).concat(Object.keys(en).filter((k) => !(k in zh))).slice(0, 10).join(', '));

  let allOk = true;
  const reports = [];
  for (const l of LANGS) {
    const d = localeDicts[l];
    if (!d) continue;
    const dk = Object.keys(d).sort();
    const missing = zhKeys.filter((k) => !(k in d));
    const extra = dk.filter((k) => !(k in zh));
    const ok = missing.length === 0 && extra.length === 0 && dk.length === zhKeys.length;
    if (!ok) allOk = false;
    reports.push(
      `${l}: ${dk.length} 键` +
        (missing.length ? ` 缺 ${missing.length}（如 ${missing.slice(0, 3).join(', ')}）` : '') +
        (extra.length ? ` 多 ${extra.length}（如 ${extra.slice(0, 3).join(', ')}）` : '')
    );
  }
  for (const r of reports) console.log('        ' + r);
  check(`8 个 locale 与 zh 键集完全一致（基准 ${zhKeys.length} 键）`, allOk);
  // 总量报告（v2.3.111 起 1776；不锁死数字，只报告，防止将来加键时此行提醒同步）
  console.log(`\n  当前键总数：zh=${zhKeys.length} / 各 locale=${Object.keys(localeDicts.de || {}).length}`);
  check('键总数合理（> 1700）', zhKeys.length > 1700 && Object.values(localeDicts).every((d) => Object.keys(d).length > 1700));
}

// ---------- B. 无空值 ----------
section('B. 无空值 / 非字符串值');
{
  const emptyIn = (d, label) => {
    const bad = [];
    for (const [k, v] of Object.entries(d)) {
      if (typeof v !== 'string' || v.trim() === '') bad.push(k);
    }
    check(`${label} 无空值`, bad.length === 0, bad.slice(0, 8).join(', '));
  };
  emptyIn(zh, 'zh');
  emptyIn(en, 'en');
  for (const l of LANGS) emptyIn(localeDicts[l] || {}, l);
}

// ---------- C. 占位符一致 ----------
section('C. 占位符一致（同一 key 的 {var} 集合跨语言相同）');
{
  const phOf = (s) => {
    const set = new Set();
    for (const m of s.matchAll(/\{(\w+)\}/g)) set.add(m[1]);
    return [...set].sort().join(',');
  };
  const bad = [];
  for (const k of Object.keys(zh)) {
    const want = phOf(zh[k] || '');
    const pools = { en: en[k], ...Object.fromEntries(LANGS.map((l) => [l, localeDicts[l]?.[k]])) };
    for (const [l, v] of Object.entries(pools)) {
      if (typeof v !== 'string') continue;
      if (phOf(v) !== want) bad.push(`${k}@${l}（zh:{$ {want}} vs ${l}:{${phOf(v)}}）`);
    }
  }
  check('全部键的占位符跨语言一致', bad.length === 0, bad.slice(0, 8).join(' ; '));
  // 已知的历史错位模式（v2.3.101 修过韩语 "{v]}"）不许复发
  const bracketTypos = [];
  for (const [label, d] of [['zh', zh], ['en', en], ...LANGS.map((l) => [l, localeDicts[l] || {}])]) {
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === 'string' && /\{\w*\]/.test(v)) bracketTypos.push(`${k}@${label}`);
    }
  }
  check('无 "{x]" 型占位符错位', bracketTypos.length === 0, bracketTypos.slice(0, 5).join(', '));
}

// ---------- D. 动态 key 命名空间抽查 ----------
section('D. 动态 t() key 的命名空间已登记全');
{
  // 从源码抓出所有 t(`...`) 模板，抽出静态前缀，逐一核对字典
  const srcFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) srcFiles.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  const dynPrefixes = new Set();
  for (const f of srcFiles) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/t\(\s*`([^`]+)`/g)) {
      const tpl = m[1];
      const prefix = tpl.replace(/\$\{[^}]*\}/g, '').replace(/[^.]*$/, '');
      if (tpl.includes('${')) dynPrefixes.add(prefix);
    }
  }
  console.log('        动态 key 前缀: ' + [...dynPrefixes].sort().join('  '));
  // 已知动态集合的枚举值必须全部登记（唯 drive-* 按设计动态豁免）
  const knownDynamic = {
    'quickimport.': ['role', 'worldbook', 'rule', 'plugin', 'err_not_character_png', 'err_read_failed', 'err_unsupported', 'err_unknown'],
    'momentMedia.': ['image.started', 'image.success', 'image.failed', 'video.started', 'video.success', 'video.failed'],
    'skill.': ['errNoFrontmatter', 'errNoName', 'errNoDescription', 'errBadScope', 'errNoRoleId', 'errNoChatKey', 'errEmptyBody', 'errTooLarge'],
    'stats.gender.': ['male', 'female'],
    'settings.font.': ['system', 'sans', 'pingfang', 'yahei', 'sourcehan', 'sourcehanSerif', 'serif', 'mono', 'rounded', 'kai'],
    'filepicker.place.': ['data', 'documents', 'downloads', 'desktop', 'pictures', 'home', 'root'],
  };
  let dynOk = true;
  const dynMiss = [];
  for (const [prefix, values] of Object.entries(knownDynamic)) {
    for (const v of values) {
      if (!(prefix + v in zh)) {
        dynOk = false;
        dynMiss.push(prefix + v);
      }
    }
  }
  check('已知动态命名空间的枚举值全部登记（zh 字典）', dynOk, dynMiss.join(', '));
  // drive-* 豁免的前提：通用格式键必须存在（v2.3.111 需求 7 的修法）
  check('filepicker.place.driveFormat 已登记（drive-* 动态豁免的兜底）', 'filepicker.place.driveFormat' in zh);
  check('filepicker.place.driveFormat 含 {letter} 占位符', /\{letter\}/.test(zh['filepicker.place.driveFormat'] || ''));
  // 反向：JSX 里不得再「裸渲染」动态盘符 key（需求 7 的根因写法）；
  // 允许在 placeLabel 内部带兜底地调用（driveFormat 优先 + 缺键回退 label）。
  const fpSrc = fs.readFileSync(path.join(ROOT, 'src', 'components', 'FilePickerModal.tsx'), 'utf8');
  check('FilePickerModal 的 JSX 不再直接渲染 t(`filepicker.place.${pl.key}`)',
    !/\{t\(`filepicker\.place\.\$\{pl\.key\}`\)\}/.test(fpSrc));
  check('FilePickerModal 有 drive-* → driveFormat 的优先分支',
    /pl\.key\.startsWith\('drive-'\)/.test(fpSrc) && /filepicker\.place\.driveFormat/.test(fpSrc));
  check('FilePickerModal 有缺键回退 pl.label 的第二重兜底',
    /const s = t\(`filepicker\.place\.\$\{pl\.key\}`\);\s*return s === `filepicker\.place\.\$\{pl\.key\}` \? pl\.label : s;/.test(fpSrc));
}

console.log('\n' + '='.repeat(60));
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail === 0 ? 0 : 1);
