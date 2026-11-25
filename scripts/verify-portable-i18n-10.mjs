/**
 * v3.0.19 闸门 4：一次性口令 / 跨机还原新文案 10 处键集、非空、占位符一致；
 * 自绘组件无裸中文；设置页接线；动画复用 theme 组；样式无新增硬编码色值。
 * 用法：node scripts/verify-portable-i18n-10.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const KEYS = [
  'settings.backupPassTitle',
  'settings.backupPassDesc',
  'settings.backupPassCopy',
  'settings.backupPassCopied',
  'settings.backupPassOnce',
  'settings.backupPassDone',
  'settings.restorePassTitle',
  'settings.restorePassDesc',
  'settings.restorePassWrong',
  'settings.restorePassSubmit',
  'settings.restoreDropHint',
  'settings.backupPortableDesc',
  'settings.passShow',
  'settings.passHide',
  'settings.backupFailed',
];

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/** 从 translations.ts 抽取内联 zh / en 字典（花括号配对）。 */
function parseInline(src, lang) {
  const re = new RegExp(`\\n  ${lang}: \\{`);
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}
/** 从字典源码片段抽取 'key': 'value'（值内可能含转义引号，做最小转义处理）。 */
function parsePairs(fragment) {
  const out = {};
  const re = /'((?:[^'\\]|\\.)+)':\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(fragment))) {
    out[m[1].replace(/\\'/g, "'")] = m[2].replace(/\\'/g, "'").replace(/\\n/g, '\n');
  }
  return out;
}

const transSrc = fs.readFileSync(path.join(ROOT, 'src/i18n/translations.ts'), 'utf-8');
const dicts = { zh: parsePairs(parseInline(transSrc, 'zh') || ''), en: parsePairs(parseInline(transSrc, 'en') || '') };
const localeFiles = ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'];
for (const lang of localeFiles) {
  dicts[lang] = JSON.parse(fs.readFileSync(path.join(ROOT, `src/i18n/locales/${lang}.json`), 'utf-8'));
}
const langs = Object.keys(dicts);

section('A. 10 处语言键集齐全且非空');
ok('字典数 = 10（zh/en + 8 JSON）', langs.length === 10);
for (const key of KEYS) {
  const missing = langs.filter((l) => !(key in dicts[l]));
  ok(`${key} 在 10 处齐全`, missing.length === 0, missing.join(','));
  const empty = langs.filter((l) => typeof dicts[l][key] !== 'string' || !dicts[l][key].trim());
  ok(`${key} 无空值`, empty.length === 0, empty.join(','));
}

section('B. 占位符跨语言逐字一致');
function vars(s) { return [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(','); }
for (const key of KEYS) {
  const base = vars(dicts.zh[key]);
  const bad = langs.filter((l) => vars(dicts[l][key]) !== base);
  ok(`${key} 占位符一致 [${base || '无'}]`, bad.length === 0, bad.join(','));
}

section('C. 文案语义与无裸中文');
ok('zh 描述含 v2 口令 / v1 仍需密钥 / 排除本地配置',
  dicts.zh['settings.backupPortableDesc'].includes('v2') &&
  dicts.zh['settings.backupPortableDesc'].includes('v1') &&
  dicts.zh['settings.backupPortableDesc'].includes('nianyu-master.key') &&
  dicts.zh['settings.backupPortableDesc'].includes('path-config'));
ok('zh 仅显示一次警示含「仅显示这一次」', dicts.zh['settings.backupPassOnce'].includes('仅显示这一次'));
ok('zh 错误口令文案不暴露密钥细节', dicts.zh['settings.restorePassWrong'].includes('口令错误'));
// 与 verify-no-native-dialog.mjs 同一口径：注释是解释性文字，只有**可执行代码**里的
// 中文字面量才算裸中文（仓库注释本身是中文，不能因此误报）。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
for (const rel of [
  'src/components/PassphraseDialog.tsx',
  'src/components/BackupRestoreHost.tsx',
  'src/utils/backupBus.ts',
]) {
  const s = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
  ok(`${rel} 无裸中文（代码全部走 i18n props / t()）`, !/[\u4e00-\u9fff]/.test(s));
}

section('D. 设置页 / 动画 / 样式接线');
const settings = fs.readFileSync(path.join(ROOT, 'src/components/Settings.tsx'), 'utf-8');
ok('设置页备份区渲染 backupPortableDesc', settings.includes("t('settings.backupPortableDesc')"));
ok('设置页创建 / 导出调用 portable 通道', settings.includes('api.createPortableBackup(dest)') && settings.includes('api.exportPortable()'));
ok('设置页创建 / 导出经 bus 一次性展示', (settings.match(/backupBus\.showCreated\(/g) || []).length >= 2);
ok('设置页还原经 bus 请求（三态下沉 Host）', settings.includes("backupBus.requestRestore({ path: zip, source: 'settings' })"));
ok('sec-backup 搜索索引补新关键词', /sec-backup[^\n]*passphrase[^\n]*portable/.test(settings));
const host = fs.readFileSync(path.join(ROOT, 'src/components/BackupRestoreHost.tsx'), 'utf-8');
const dialog = fs.readFileSync(path.join(ROOT, 'src/components/PassphraseDialog.tsx'), 'utf-8');
ok('Dialog / Host 复用 theme 动画组', dialog.includes("'theme'") && host.includes('BackupRestoreHost'));
const anim = fs.readFileSync(path.join(ROOT, 'src/utils/animControl.ts'), 'utf-8');
ok('theme 组已登记 .modal-mask / .quick-import-overlay', anim.includes("'.modal-mask'") && anim.includes("'.quick-import-overlay'"));
const css = fs.readFileSync(path.join(ROOT, 'src/styles/index.css'), 'utf-8');
const passCss = css.slice(css.indexOf('/* ===== v3.0.19 可携带备份'));
ok('新增 CSS 段无硬编码色值', !/#[0-9a-fA-F]{3,8}\b/.test(passCss));
ok('新增 CSS 正文用 var(--color-text)', passCss.includes('var(--color-text)'));
ok('不新增关键帧（复用 theme 组）', !/@keyframes/.test(passCss));

console.log(`\n========== i18n 10 处闸门：${pass} 通过 / ${fail} 失败 ==========`);
process.exitCode = fail ? 1 : 0;
