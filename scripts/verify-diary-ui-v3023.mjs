#!/usr/bin/env node
/**
 * verify-diary-ui-v3023.mjs — v3.0.23 日记背景 / 自适应 / 页内身份切换专项闸门
 *
 * 覆盖：① `.diary-panel` 不透明令牌 + flex 伸展；② 身份下拉数据源为 settings.selfRoles、
 * current 保留值、会话内非持久化、切换清草稿；③ i18n 10 处新键；④ 冻结区相对含光标
 * 修复的新基线零增量；⑤ 真实转译执行 handleIdentityChange 的状态转移。
 *
 * 运行：node scripts/verify-diary-ui-v3023.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = process.cwd();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BASELINE = '2f8e734c13c651975f611d19903d79ad50a62284'; // 含任务 #1 光标修复的 HEAD

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log('  FAIL  ' + name + (extra ? `  <<< ${extra}` : ''));
  }
}
const section = (t) => console.log('\n=== ' + t + ' ===');

const view = read('src/components/DiaryView.tsx');
const css = read('src/styles/index.css');
const pkg = read('package.json');
const zh = read('src/i18n/translations.ts');
const locales = ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'];
const dicts = locales.map((n) => JSON.parse(read(`src/i18n/locales/${n}.json`)));

console.log('='.repeat(64));
console.log('v3.0.23 日记增量闸门 — 背景 / 自适应 / 身份切换');
console.log('='.repeat(64));

section('A. 版本与脚本登记');
ok('package.json 版本 3.0.24', /"version": "3\.0\.24"/.test(pkg));
for (const s of ['verify:cursor-never-blank', 'verify:drag-cursor-gate', 'verify:diary-ui-3022',
  'verify:diary-migrate-3022', 'verify:diary-ui-3023', 'verify:diary-comments-3024']) {
  ok(`既有/新增脚本 ${s} 均保留`, new RegExp(`"${s}"`).test(pkg));
}

section('B. C1/C2/C3：不透明背景 + 宽度/高度自适应');
const panel = css.slice(css.indexOf('.diary-panel {'), css.indexOf('.diary-panel {') + 800);
ok('.diary-panel 不透明承载面用 var(--color-bg)',
  /background:\s*var\(--color-bg\)/.test(panel));
ok('.diary-panel flex:1 1 auto + min-width:0 + min-height:0',
  /flex:\s*1 1 auto/.test(panel) && /min-width:\s*0/.test(panel) && /min-height:\s*0/.test(panel));
ok('日记段未引入半透明背景/滤镜',
  !/color-mix\([^)]*transparent|rgba\([^)]*,\s*0?\.[0-9]|backdrop-filter|opacity:\s*0?\./.test(panel));
const diaryCss = css.slice(css.indexOf('.diary-panel {'), css.indexOf('/* ===== v3.0.19'));
ok('日记样式段零新增硬编码色值', !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(diaryCss));
ok('下拉三条规则仅尺寸/间距（继承全局 select 令牌）',
  /\.diary-identity-picker \{[^}]*display:\s*inline-flex/.test(css) &&
  /\.diary-identity-label \{[^}]*font-size:/.test(css) &&
  /\.diary-identity-select \{[^}]*max-width:/.test(css));
ok('正文 textarea flex:1 + min-height:320 未退化',
  /\.diary-content-input \{[\s\S]{0,220}?flex:\s*1[\s\S]{0,160}?min-height:\s*320px/.test(css));
ok('编辑态无 position:fixed/absolute',
  !/position:\s*(fixed|absolute)/.test(css.slice(css.indexOf('.diary-editor {'), css.indexOf('.diary-editor {') + 700)));

section('C. C4/C5/C6：身份选择器状态机与数据绑定');
ok('会话内 state/ref 齐备（非持久化）',
  /useState<PickerMode>\('current'\)/.test(view) &&
  /useState<string \| null>\(null\)/.test(view) &&
  /useRef<PickerMode>\('current'\)/.test(view) &&
  /effectiveRoleIdRef/.test(view));
ok('下拉数据源为 settings.selfRoles（不是 api.getRoles）',
  /settings\.selfRoles \|\| \[\]/.test(view) && /setSelfRoles\(nextSelfRoles\)/.test(view) &&
  /selfRoles\.map\(/.test(view));
ok('顶部只读 span 已收敛为下拉；第一项复用 diary.currentIdentity',
  /const identityLabel = identity \? t\('diary\.currentIdentity', \{ name: identity\.name \}\) : ''/.test(view) &&
  /<option value="current">\{identityLabel\}<\/option>/.test(view) &&
  !/<span className="diary-identity">/.test(view));
ok('current 保留值 + 选项数=selfRoles.length+1（结构断言）',
  /value=\{pickerMode === 'current' \? 'current' : \(specificRoleId \?\? 'current'\)\}/.test(view));
ok('derived effectiveRoleId 按 mode 分派',
  /const effectiveRoleId =\s*\n\s*pickerMode === 'current' \? \(identity\?\.id \?\? ''\) : \(specificRoleId \?\? identity\?\.id \?\? ''\)/.test(view));
ok('切换清草稿（Q2）', /if \(switched\) \{[\s\S]{0,120}?setEditor\(null\)/.test(view));
ok('设置变更：specific 身份仍存在则保持；被删则回落 current 并清草稿',
  /pickerModeRef\.current === 'specific'/.test(view) &&
  /nextSelfRoles\.some\(\(r\) => r\.id === sid\)/.test(view) &&
  /if \(sid && nextSelfRoles\.some/.test(view));
ok('onDiaryChanged 读 effectiveRoleIdRef（不串身份）',
  /api\.onDiaryChanged\(\(\) => \{[\s\S]{0,240}?effectiveRoleIdRef\.current/.test(view));
ok('新建与各刷新点绑定 effectiveRoleId',
  (view.match(/loadEntries\(effectiveRoleId\)/g) || []).length >= 4 &&
  /emptyEditor\(effectiveRoleId\)/.test(view) &&
  /const effectiveLabel =/.test(view));
ok('save() 仍用 editor.selfRoleId（主进程门控不变）',
  /selfRoleId: editor\.selfRoleId/.test(view) && !/saveSettings/.test(view));
ok('无身份时下拉不渲染（走 v3.0.22 空状态）',
  /\{identity && selfRoles\.length > 0 && \(/.test(view) && /t\('diary\.noIdentity'\)/.test(view));

section('D. 行为级：真执行 handleIdentityChange 状态转移');
function extractArrow(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}
const arrow = extractArrow(view, 'const handleIdentityChange =');
ok('handleIdentityChange 可从真实源码抽取', !!arrow);
if (arrow) {
  const js = ts.transpileModule(`${arrow}\nreturn handleIdentityChange;`, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2020 },
    fileName: 'identity-change-snippet.ts',
  }).outputText;
  const state = {
    mode: 'current', specific: null, effective: 'A', editorCleared: 0, loads: [],
  };
  const refs = {
    pickerModeRef: { current: 'current' },
    specificRoleIdRef: { current: null },
    effectiveRoleIdRef: { current: 'A' },
  };
  const factory = new Function(
    'setPickerMode', 'setSpecificRoleId', 'setEditor', 'setQuery', 'loadEntries',
    'identity', 'pickerModeRef', 'specificRoleIdRef', 'effectiveRoleIdRef',
    js
  );
  const change = factory(
    (v) => { state.mode = v; },
    (v) => { state.specific = v; },
    () => { state.editorCleared++; },
    () => {},
    (id) => { state.loads.push(id); },
    { id: 'A', name: 'A' },
    refs.pickerModeRef, refs.specificRoleIdRef, refs.effectiveRoleIdRef
  );
  change('B');
  ok('current → specific(B)：mode/specific/effective 同步，清草稿，列表切 B',
    state.mode === 'specific' && state.specific === 'B' && refs.effectiveRoleIdRef.current === 'B' &&
    state.editorCleared === 1 && state.loads[0] === 'B');
  change('C');
  ok('specific(B) → specific(C)：换人清草稿，无双列表',
    state.specific === 'C' && state.editorCleared === 2 && state.loads[1] === 'C');
  change('current');
  ok('specific → current：回落设置身份 A、清草稿、列表回 A',
    state.mode === 'current' && state.specific === null && refs.effectiveRoleIdRef.current === 'A' &&
    state.editorCleared === 3 && state.loads[2] === 'A');
  const before = state.editorCleared;
  change('current');
  ok('current 同值：不清草稿（仅刷新列表）', state.editorCleared === before);
}

section('E. i18n 10 处一致');
const hintZh = '在上方下拉切换日记身份；「当前身份」跟随设置变化，切换仅在本次会话有效。';
const labelZh = '日记身份';
const hintEn = 'Use the dropdown above to switch diary identity; "Current Identity" follows Settings and the choice resets on restart.';
const labelEn = 'Diary identity';
ok('zh/en translations.ts 新文案就位',
  zh.includes(`'diary.identityHint': '${hintZh}'`) &&
  zh.includes(`'diary.identityPickerLabel': '${labelZh}'`) &&
  zh.includes(`'diary.identityHint': '${hintEn}'`) &&
  zh.includes(`'diary.identityPickerLabel': '${labelEn}'`));
for (const d of dicts) {
  ok(`${d === dicts[0] ? '8 locale' : ''} diary.identityHint/identityPickerLabel 非空`,
    d['diary.identityHint'] === hintEn && d['diary.identityPickerLabel'] === labelEn);
}
ok('diary.currentIdentity 10 处逐字不变',
  zh.includes("'diary.currentIdentity': '当前身份（{name}）'") &&
  zh.includes("'diary.currentIdentity': 'Current Identity ({name})'") &&
  dicts.every((d) => d['diary.currentIdentity'] === 'Current Identity ({name})'));

section('F. 冻结区 / 并行光标改动保留 / 文档同步');
let diff = '';
try {
  diff = execFileSync('git', ['diff', BASELINE, '--',
    'src/components/MiniChat.tsx', 'src/components/ChatWindow.tsx',
    'electron/cursorCoverState.ts', 'src/App.tsx'], { cwd: ROOT, encoding: 'utf8' });
} catch (e) {
  diff = String(e?.stdout || e?.message || 'git diff failed');
}
ok('冻结区 + App.tsx 相对新基线零增量（日记任务零改动）', diff.trim() === '', diff.slice(0, 200));
const app = read('src/App.tsx');
ok('任务 #1 光标修复仍完整保留',
  /syncNativeCursorHidden/.test(app) && /NATIVE_HIDDEN_CLASS/.test(app) &&
  /CURSOR_FORCE_HIDE_EVENT/.test(app));
ok('版本记录新增 v3.0.23 段且保留 v3.0.22',
  /## v3\.0\.23 \(/.test(read('版本更新记录.md')) && /## v3\.0\.22 \(/.test(read('版本更新记录.md')));
for (const f of ['使用说明.md', 'README.md', '硬编码清单.md']) {
  ok(`${f} 同步 v3.0.23 日记行为`, /3\.0\.23/.test(read(f)));
}
ok('GuideView FAQ 同步页内切身份',
  /3\.0\.23|identityPickerLabel|页内切换|下拉切换/.test(read('src/components/GuideView.tsx')));

console.log('\n' + '='.repeat(64));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
