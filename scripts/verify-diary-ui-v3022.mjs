#!/usr/bin/env node
/**
 * verify-diary-ui-v3022.mjs — v3.0.22 日记界面重做源码闸门
 *
 * 静态强断言：无分册/切换器/孤儿回收 UI、单一当前身份只读展示、无身份空状态与设置跳转、
 * 大输入框与聊天输入框共享变量口径、零新增硬编码色值、旧占位词清零、冻结区零 diff，
 * 并确认上一路拖球光标门控代码完整保留。
 *
 * 运行：node scripts/verify-diary-ui-v3022.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BASELINE = '322908361a47f106f20bdd383bf663d9993e6261'; // 本次日记任务开工时的 HEAD（含拖球光标修复）

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
function section(t) { console.log('\n=== ' + t + ' ==='); }

const view = read('src/components/DiaryView.tsx');
const app = read('src/App.tsx');
const settings = read('src/components/Settings.tsx');
const css = read('src/styles/index.css');
const anim = read('src/utils/animControl.ts');
const main = read('electron/main.ts');
const ipc = read('src/ipc.ts');
const preload = read('electron/preload.ts');
const pkg = read('package.json');

section('A. DiaryView：单一当前身份，无分册/切换器/孤儿回收');
ok('顶部当前身份只读展示（t 传 name）',
  /t\('diary\.currentIdentity',\s*\{\s*name:\s*identity\.name\s*\}\)/.test(view));
ok('身份解析走只读纯函数', /resolveDiaryIdentity\(settings\)/.test(view));
ok('进入日记页先调用 diaryEnsureMigrated', /await api\.diaryEnsureMigrated\(\)/.test(view));
ok('列表/新建固定绑定当前身份',
  /await loadEntries\(next\.id\)/.test(view) &&
  /api\.diaryList\(selfRoleId\)/.test(view) &&
  /emptyEditor\(identity\.id\)/.test(view));
ok('无身份空状态三件套齐全',
  /t\('diary\.noIdentity'\)/.test(view) && /t\('diary\.noIdentityHint'\)/.test(view) &&
  /t\('diary\.goCreateIdentity'\)/.test(view) && /onGoToIdentitySettings\?\.\(\)/.test(view));
ok('无身份时写日记按钮与搜索框均不渲染（条件分支）',
  /\{!identity \? \([\s\S]*?diary-empty-state[\s\S]*?\) : \([\s\S]*?diary-search/.test(view) &&
  /\{identity && \([\s\S]*?diary-primary/.test(view));
for (const dead of ['diary-books', 'currentBook', 'switchBook', 'reassignOrphans', 'diaryListOrphans',
  'diary.orphans', 'diary.bookNone', 'diary.orphanHint', '<select']) {
  ok(`DiaryView 无 ${dead}`, !view.includes(dead));
}
ok('DiaryView 无用户可见旧占位词', !/未指定/.test(view) && !/这一册|本册/.test(view));
ok('错误码映射为 i18n', /DIARY_ERROR_NO_SELF_ROLE/.test(view) && /t\('diary\.errInvalidIdentity'\)/.test(view));
ok('迁移提示使用唯一对外文案', /t\('diary\.migratedHint'\)/.test(view));
ok('保留既有自绘确认框（非原生弹窗）', /api\.showConfirm!\(t\('diary\.confirmDelete'\)\)/.test(view));
ok('DiaryView 无 window.alert/confirm/prompt',
  !/window\.(alert|confirm|prompt)\s*\(/.test(view));

section('B. 设置跳转闭环（tick → sub=self → 锚点高亮）');
ok('App 新增 settingsFocusTick 并传给 Settings',
  /const \[settingsFocusTick, setSettingsFocusTick\] = useState\(0\)/.test(app) &&
  /focusSelfRoleTick=\{settingsFocusTick\}/.test(app));
ok('DiaryView 跳转回调切到设置并自增 tick',
  /onGoToIdentitySettings=\{\(\) => \{[\s\S]{0,200}?setView\('settings'\)[\s\S]{0,120}?setSettingsFocusTick\(\(n\) => n \+ 1\)/.test(app));
ok('Settings 接收 focusSelfRoleTick 并切 sub=self',
  /focusSelfRoleTick\?: number;/.test(settings) &&
  /if \(!focusSelfRoleTick[\s\S]{0,220}?setSub\('self'\)/.test(settings));
ok('Settings 身份分区锚点与 flashElement 高亮',
  /id="self-role-manage"/.test(settings) &&
  /getElementById\('self-role-manage'\)[\s\S]{0,200}?flashElement\(el\)/.test(settings));
ok('设置跳转未使用原生弹窗', !/window\.(alert|confirm|prompt)\s*\(/.test(settings));

section('C. 大输入框 / 输入框外观同口径 / 动画合规');
ok('聊天与日记输入共用同一声明块',
  /\.chat-input,\s*\n\.diary-input \{[\s\S]{0,260}?--input-bg[\s\S]{0,160}?--input-fg/.test(css));
ok('日记输入控件带 .diary-input（搜索/日期/标题/正文四类）',
  (view.match(/className="diary-input/g) || []).length >= 4);
ok('正文 textarea 使用 diary-content-input 且无固定 rows',
  /className="diary-input diary-content-input"/.test(view) && !/rows=\{10\}/.test(view));
ok('正文 textarea flex:1 + min-height:320px',
  /\.diary-content-input \{[\s\S]{0,220}?flex:\s*1[\s\S]{0,160}?min-height:\s*320px/.test(css));
ok('编辑态内联、列表暂隐',
  /\{!editor && \(\s*\n?\s*<div className="diary-entries"/.test(view) && !/position:\s*fixed/.test(css.slice(css.indexOf('.diary-editor {'), css.indexOf('.diary-editor {') + 700)));
ok('日记段删除 --color-input-bg 口径',
  !/--color-input-bg/.test(css.slice(css.indexOf('.diary-panel {'), css.indexOf('.diary-panel {') + 8000)));
const diaryCss = css.slice(css.indexOf('.diary-panel {'), css.indexOf('/* ===== v3.0.19'));
ok('日记样式段零新增硬编码色值', !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(diaryCss), diaryCss.slice(0, 80));
ok('diary 动画分组沿用、未新建分组',
  /id: 'diary'/.test(anim) &&
  /selectors: \['\.diary-panel', '\.diary-card', '\.diary-comment', '\.diary-summary'\]/.test(anim));
ok('CSS 删除无引用分册/孤儿规则',
  !/\.diary-books|\.diary-book\.active|\.diary-orphans|\.diary-orphan-row/.test(css));

section('D. 主进程门控与三端通道');
ok('diary:create 无回退', /assertDiaryCreateSelfRole\(p\?\.selfRoleId\)/.test(main) && !/\|\|\s*'none'/.test(main.slice(main.indexOf("ipcMain.handle('diary:create'"), main.indexOf("ipcMain.handle('diary:update'"))));
ok('diary:ensureMigrated 三端齐备',
  /ipcMain\.handle\('diary:ensureMigrated'/.test(main) &&
  /diaryEnsureMigrated/.test(preload) && /diaryEnsureMigrated/.test(ipc));
ok('types.ts 删除 DiaryBook', !/export interface DiaryBook/.test(read('src/types.ts')));
ok('package.json 3.0.22 + 两个新脚本 + 拖球脚本保留',
  /"version": "3\.0\.22"/.test(pkg) && /verify:diary-migrate-3022/.test(pkg) &&
  /verify:diary-ui-3022/.test(pkg) && /verify:drag-cursor-gate/.test(pkg));

section('E. 文档旧占位词清零 / 冻结区零 diff / 光标改动保留');
for (const f of ['使用说明.md', 'README.md', '硬编码清单.md', '版本更新记录.md', 'src/components/GuideView.tsx']) {
  ok(`${f} 旧占位词零命中`, !/未指定/.test(read(f)));
}
ok('版本记录新增 3.0.22 正式段', /## v3\.0\.22 \(/.test(read('版本更新记录.md')));
let frozenDiff = '';
try {
  frozenDiff = execFileSync('git', ['diff', BASELINE, '--',
    'src/components/MiniChat.tsx', 'src/components/ChatWindow.tsx', 'electron/cursorCoverState.ts'],
    { cwd: ROOT, encoding: 'utf8' });
} catch (e) {
  frozenDiff = String(e?.stdout || e?.message || 'git diff failed');
}
ok('冻结区相对开工基线零 diff', frozenDiff.trim() === '', frozenDiff.slice(0, 200));
ok('上一路光标门控代码完整保留',
  /syncNativeCursorHidden/.test(app) && /ballDraggingRef/.test(app) &&
  /onBallDragging/.test(app) &&
  /onBallDragging/.test(read('src/components/MiniChat.tsx')) &&
  /mainWinRef\.webContents\.send\('ball:dragging', true\)/.test(read('electron/floatingBall.ts')));

console.log('\n' + '='.repeat(64));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
