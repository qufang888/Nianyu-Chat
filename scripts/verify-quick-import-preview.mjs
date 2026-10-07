// v2.3.97 验证：拖拽文件导入的「预检确认弹窗 + 导入并编辑 + 主进程导航兜底」
// 用法：node scripts/verify-quick-import-preview.mjs
//
// 可证伪性检验（每次改动后都应重跑，并把两次输出贴进报告）：
//   A) 把 handleQuickImport 里的 previewFiles 调用删掉（改回直接导入）→ 第 3 条必须 FAIL
//   B) 把 createMainWindow 里的 will-navigate 拦截删掉→ 第 6 条必须 FAIL
//
// 本脚本是**静态**验证：它检查的是「代码结构与调用顺序」这类能被读出来的事实，
// 不试图证明运行时行为（渲染结果、IPC 往返、真机拖拽）。
// 唯一带一点动态性质的是第 4 条（用正则切出 handler 函数体后 grep 副作用调用），
// 切的是**当前源码文本**，不是运行时代码。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readLines = (p) => read(p).split(/\r?\n/);

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
function section(t) {
  console.log('\n=== ' + t + ' ===');
}

const MAIN = 'electron/main.ts';
const PRELOAD = 'electron/preload.ts';
const IPC = 'src/ipc.ts';
const TYPES = 'src/types.ts';
const APP = 'src/App.tsx';
const LIB = 'src/components/Library.tsx';
const MODAL = 'src/components/QuickImportPreviewModal.tsx';

const mainText = read(MAIN);
const mainLines = mainText.split(/\r?\n/);
const preloadText = read(PRELOAD);
const ipcText = read(IPC);
const typesText = read(TYPES);
const appText = read(APP);
const appLines = appText.split(/\r?\n/);
const libText = read(LIB);
const modalText = fs.existsSync(path.join(ROOT, MODAL)) ? read(MODAL) : '';

/** 找第一处包含 needle 的行号（1-based）；找不到返回 -1 */
function lineOf(text, needle, from = 0) {
  const lines = text.split(/\r?\n/);
  for (let i = from; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return -1;
}

/** 取出 `ipcMain.handle('X', ...)` 整个函数体的文本（按花括号配平） */
function handlerBody(text, channel) {
  const start = text.indexOf(`ipcMain.handle('${channel}'`);
  if (start < 0) return null;
  return blockAfter(text, start);
}

/** 取出 `function NAME(` / `NAME = (` / `NAME = useCallback(` 整个函数体的文本（按花括号配平） */
function funcBody(text, name) {
  const re = new RegExp(
    `(?:function\\s+${name}\\s*\\(|\\b${name}\\s*=\\s*(?:useCallback\\s*\\(\\s*)?(?:async\\s*)?\\()`
  );
  const m = re.exec(text);
  if (!m) return null;
  return blockAfter(text, m.index);
}

/** 从 from 处找到第一个 '{' 并按花括号配平截出整块 */
function blockAfter(text, from) {
  const open = text.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
section('1. import:previewFiles 三层齐备（main / preload / ipc.ts）');
const previewChanMain = mainText.includes("ipcMain.handle('import:previewFiles'");
const previewChanPreload = /previewFiles:\s*\(paths\)\s*=>\s*ipcRenderer\.invoke\('import:previewFiles'/.test(
  preloadText
);
const previewIpcDecl = /previewFiles:\s*\(paths:\s*string\[\]\)\s*=>\s*Promise<QuickImportPreviewResult>/.test(
  ipcText
);
const previewIpcForward = /previewFiles:\s*\(paths\)\s*=>\s*raw\.previewFiles\(paths\)/.test(ipcText);
check('main.ts 注册了 import:previewFiles handler', previewChanMain);
check('preload.ts 暴露 previewFiles 并 invoke 该 channel', previewChanPreload);
check('src/ipc.ts 有 previewFiles 的类型声明', previewIpcDecl);
check('src/ipc.ts 有 previewFiles 的转发实现', previewIpcForward);
check(
  'preload.ts 的 NianyuAPI 接口里有 previewFiles 声明（否则 tsc 会报未知属性）',
  /previewFiles:\s*\(paths:\s*string\[\]\)/.test(preloadText)
);

// ─────────────────────────────────────────────────────────────
section('2. 既有 import:dropFiles 未被破坏');
check('main.ts 仍注册 import:dropFiles', mainText.includes("ipcMain.handle('import:dropFiles'"));
check('preload.ts 仍暴露 importDroppedFiles', /importDroppedFiles:\s*\(paths\)\s*=>\s*ipcRenderer\.invoke\('import:dropFiles'/.test(preloadText));
check('src/ipc.ts 仍声明+转发 importDroppedFiles', ipcText.includes('importDroppedFiles: (paths) => raw.importDroppedFiles(paths)'));
check(
  'import:dropFiles 内部仍调用 importPluginLogic 真正落库（未被预检逻辑污染）',
  (handlerBody(mainText, 'import:dropFiles') || '').includes('importPluginLogic')
);

// App.tsx 里「确认之后」仍调importDroppedFiles
const appImportOnlyLine = lineOf(appText, 'await api.importDroppedFiles(');
check('App.tsx 仍调用 api.importDroppedFiles（确认后走既有导入通道）', appImportOnlyLine > 0);

// ─────────────────────────────────────────────────────────────
section('3. handleQuickImport 的顺序：先预检 → 弹确认 → 再导入');
const previewCallLine = lineOf(appText, 'api.previewFiles(');
// 用带换行的匹配，避免命中类型名 `<QuickImportPreviewModalState`（那是 TS 类型，不是 JSX 渲染点）。
// 注意 lineOf 是按行匹配的（换行符已被 split 掉），故这里改成在原文里定位再换算行号。
const modalRenderLine = (() => {
  const m = /<QuickImportPreviewModal\s*\r?\n/.exec(appText);
  if (!m) return -1;
  return appText.slice(0, m.index).split(/\r?\n/).length;
})();
const importOnlyHandlerLine = lineOf(appText, 'const onPreviewImportOnly');
check('App.tsx 调用了 api.previewFiles', previewCallLine > 0);
check('App.tsx 渲染了 QuickImportPreviewModal', modalRenderLine > 0);
check(
  '顺序正确：previewFiles 调用点行号 < 确认弹窗渲染行号',
  previewCallLine > 0 && modalRenderLine > 0 && previewCallLine < modalRenderLine,
  `previewFiles@${previewCallLine} vs modal@${modalRenderLine}`
);
// 「确认之后才导入」用**数据流**断言，而不是行号 —— React 函数组件里 JSX 必须排在所有
// const 声明之后，所以「弹窗渲染行号 < 处理函数内的导入调用行号」在语法上不可能成立
// （真要成立就得把处理函数拆到别的文件，反而更难读）。这里断言更强的性质：
//   ① importDroppedFiles 在 App.tsx 里**只出现一次**；
//   ② 那一次位于 onPreviewImportOnly（确认弹窗的 onImportOnly 回调）函数体内；
//   ③ onPreviewImportOnly 只被用作 modal 的 onImportOnly prop，别处不会调它。
// 于是「预检 → 用户确认 → 导入」这条链在数据流上唯一可达，不存在绕过弹窗直接落库的路径。
const importOnlyFuncBody = funcBody(appText, 'onPreviewImportOnly');
check('importDroppedFiles 在 App.tsx 中只出现一次（不存在第二条绕过弹窗的落库路径）',
  (appText.match(/api\.importDroppedFiles\(/g) || []).length === 1);
check('唯一那次 importDroppedFiles 位于 onPreviewImportOnly 函数体内',
  !!importOnlyFuncBody && importOnlyFuncBody.includes('api.importDroppedFiles('));
check('onPreviewImportOnly 只作为确认弹窗的 onImportOnly prop 使用（不会别处直调）',
  (appText.match(/onPreviewImportOnly/g) || []).length === 2); // 定义 1 次 + JSX 传参 1 次
// 「仅导入」的处理函数必须排在弹窗渲染之前定义（React 里 const 需先声明后使用），
// 但它内部的 importDroppedFiles 调用发生在**运行时**（用户点了之后），不是渲染期。
check('导入与编辑的处理函数 onPreviewImportAndEdit 存在', appText.includes('const onPreviewImportAndEdit'));
check(
  'handleQuickImport 本体不再直接落库（预检与落库分离）',
  (() => {
    const s = appText.indexOf('const handleQuickImport');
    if (s < 0) return false;
    // 取到下一个顶层 const 为止
    const rest = appText.slice(s);
    const end = rest.indexOf('\n  const ', 10);
    const body = end > 0 ? rest.slice(0, end) : rest;
    return !body.includes('api.importDroppedFiles(');
  })()
);
check('取消出口 closePreview 只清状态、不做任何落库', /const closePreview = useCallback\(\(\) => setPreview\(null\)/.test(appText));
// 回归防线：「保存第 1 项 + 取消第 2 项」的混合结局下，已保存的那项也必须刷新列表。
// 曾经的 bug：只有 onEditSaved 在队列走完时 setImportTick，全取消路径不刷，
// 于是「保存的那项已落库但列表不刷新」，用户以为没导进去。
check('队列收尾逻辑被 onEditSaved 与 onEditClosed 共用（finishEditQueue）',
  /const finishEditQueue = useCallback/.test(appText) &&
  (appText.match(/finishEditQueue\(/g) || []).length === 2 &&
  /\[editQueue, finishEditQueue\]/.test(appText) &&
  /\[finishEditQueue\]/.test(appText));
check('finishEditQueue 无论有无保存项都会 setImportTick（已保存的项一定会刷新）',
  (() => {
    const b = funcBody(appText, 'finishEditQueue');
    return !!b && b.indexOf('setImportTick') !== -1 && b.indexOf('if (!saved.length) return') !== -1;
  })());
check('记录已保存项用 ref 而非 state（onSaved 里要同步读到）', /savedRef = useRef<QuickImportPreviewItem\[\]>/.test(appText));
check('角色卡保存后跳通讯录、世界书/规则/插件跳资料库对应页签', (() => {
  const b = funcBody(appText, 'finishEditQueue') || '';
  return /kinds\.includes\('role'\)\) setView\('contacts'\)/.test(b) && /setLibraryTab\('worldbook'\)/.test(b);
})());

// ─────────────────────────────────────────────────────────────
section('4. 预检阶段无副作用');
const previewBody = handlerBody(mainText, 'import:previewFiles');
check('能静态切出 import:previewFiles 的函数体', !!previewBody);
if (previewBody) {
  const forbidden = [
    'dm.createRole',
    'dm.updateRole',
    'dm.saveWorldBook',
    'dm.saveRule',
    'dm.savePlugin',
    'dm.addWorldBook',
    'writeBase64Avatar',
    'importPluginLogic',
    'fs.copyFileSync',
    'fs.writeFileSync',
  ];
  for (const f of forbidden) {
    check(`预检 handler 体内没有 ${f}`, !previewBody.includes(f));
  }
  check(
    '预检用的是纯函数 detectImportContent（与 importPluginLogic 共用识别逻辑）',
    previewBody.includes('detectImportContent')
  );
  check('detectImportContent 本身是纯函数（不碰 dm）', (() => {
    const b = funcBody(mainText, 'detectImportContent');
    return !!b && !/\bdm\./.test(b);
  })());
}

// ─────────────────────────────────────────────────────────────
section('5. WorldBookEditor / RuleEditor 已抽离为独立组件');
check('src/components/WorldBookEditor.tsx 存在', fs.existsSync(path.join(ROOT, 'src/components/WorldBookEditor.tsx')));
check('src/components/RuleEditor.tsx 存在', fs.existsSync(path.join(ROOT, 'src/components/RuleEditor.tsx')));
check('Library.tsx 改为 import WorldBookEditor', /import\s*\{[^}]*WorldBookEditor[^}]*\}\s*from\s*'\.\/WorldBookEditor'/.test(libText));
check('Library.tsx 改为 import RuleEditor', /import\s*\{[^}]*RuleEditor[^}]*\}\s*from\s*'\.\/RuleEditor'/.test(libText));
check('Library.tsx 里不再内联定义 WorldBookEditor 组件体', !/const WorldBookEditor: React\.FC/.test(libText));
check('Library.tsx 里不再内联定义 RuleEditor 组件体', !/const RuleEditor: React\.FC/.test(libText));
check('WorldBookEditor 的 props 仍是 { wb, onClose, onSaved }', (() => {
  const p = path.join(ROOT, 'src/components/WorldBookEditor.tsx');
  if (!fs.existsSync(p)) return false;
  const t = read('src/components/WorldBookEditor.tsx');
  return /wb:\s*WorldBook;\s*\n\s*onClose:\s*\(\)\s*=>\s*void;\s*\n\s*onSaved:\s*\(\)\s*=>\s*void;/.test(t);
})());
check('RuleEditor 的 props 仍是 { rule, onClose, onSaved }', (() => {
  const p = path.join(ROOT, 'src/components/RuleEditor.tsx');
  if (!fs.existsSync(p)) return false;
  const t = read('src/components/RuleEditor.tsx');
  return /rule:\s*Rule;\s*onClose:\s*\(\)\s*=>\s*void;\s*onSaved:\s*\(\)\s*=>\s*void/.test(t);
})());
check('Library 的 WorldBookTab 入口仍调用 WorldBookEditor（行为零变化）', /<WorldBookEditor\s+wb=\{editing\}/.test(libText));
check('Library 的 RuleTab 入口仍调用 RuleEditor（行为零变化）', /<RuleEditor\s+rule=\{editing\}/.test(libText));

// ─────────────────────────────────────────────────────────────
section('6. 主进程导航兜底');
const navLine = lineOf(mainText, "mainWindow.webContents.on('will-navigate'");
check("main.ts 注册了 will-navigate 拦截", navLine > 0);
check('拦截逻辑调用了 e.preventDefault()', (() => {
  if (navLine < 0) return false;
  const seg = mainLines.slice(navLine - 1, navLine + 8).join('\n');
  return seg.includes('e.preventDefault()');
})());
check('拦截逻辑调用了 isAppOwnNavigation 白名单', (() => {
  if (navLine < 0) return false;
  const seg = mainLines.slice(navLine - 1, navLine + 8).join('\n');
  return seg.includes('isAppOwnNavigation(url)');
})());
check('注册了 setWindowOpenHandler 一律 deny', mainText.includes("setWindowOpenHandler(() => ({ action: 'deny' }))"));
check('白名单放行 file://（生产 loadFile 不能被拦）', /url\.startsWith\('file:'\)/.test(mainText));
check('白名单放行 localhost（dev 模式 HMR 不能被拦）', /h === 'localhost'/.test(mainText));
check('白名单放行 127.0.0.1（dev server 可能绑回环 IP）', /h === '127\.0\.0\.1'/.test(mainText));
check('白名单放行任意端口（Vite 端口被占用会顺延，不能只写 5173）', !/localhost:5173/.test(
  (mainText.slice(mainText.indexOf('function isAppOwnNavigation'), mainText.indexOf('function isAppOwnNavigation') + 900))
));
check('isAppOwnNavigation 定义在 createMainWindow 之前（函数声明提升，非必需但更易读）',
  lineOf(mainText, 'function isAppOwnNavigation(') > 0 &&
  lineOf(mainText, 'function isAppOwnNavigation(') < lineOf(mainText, 'const splashQuery')
);

// ─────────────────────────────────────────────────────────────
section('7. 预检上限与导入上限一致（都是 20）');
check('main.ts 有单一的 QUICK_IMPORT_MAX_FILES 常量', mainText.includes('const QUICK_IMPORT_MAX_FILES = 20;'));
check(
  'import:previewFiles 用 QUICK_IMPORT_MAX_FILES 截断',
  (previewBody || '').includes('QUICK_IMPORT_MAX_FILES')
);
check(
  'import:dropFiles 也用 QUICK_IMPORT_MAX_FILES（不再各写一个字面量 20）',
  (handlerBody(mainText, 'import:dropFiles') || '').includes('QUICK_IMPORT_MAX_FILES')
);
check(
  'import:dropFiles 里不再残留 slice(0, 20) 字面量',
  !(handlerBody(mainText, 'import:dropFiles') || '').includes('slice(0, 20)')
);
check(
  'import:previewFiles 里不再残留 slice(0, 20) 字面量',
  !(previewBody || '').includes('slice(0, 20)')
);
check('返回值带 truncated / limit，渲染层能提示被截断的个数', /truncated:/.test(previewBody || '') && /limit:/.test(previewBody || ''));

// ─────────────────────────────────────────────────────────────
section('8. 错误类型至少 3 种（不再一律 read_failed）');
check(
  "types.ts 定义了 QuickImportPreviewErrorCode 且含 4 种 code",
  /export type QuickImportPreviewErrorCode\s*=\s*(\n\s*\|?\s*'not_character_png'[\s\S]*'read_failed'[\s\S]*'unsupported'[\s\S]*'unknown'[\s\S]*);/.test(typesText)
);
const errCodes = new Set(
  [...(previewBody || '').matchAll(/code:\s*'(not_character_png|read_failed|unsupported|unknown)'/g)].map((m) => m[1])
);
check(`预检 handler 实际产出 ${errCodes.size} 种错误码（≥3）`, errCodes.size >= 3, [...errCodes].join(','));
check("PNG 无 chara 元数据 → not_character_png", errCodes.has('not_character_png'));
check('扩展名不在白名单 → unsupported', errCodes.has('unsupported'));
check('读文件抛错 → read_failed 且带具体 message', /code: 'read_failed'[\s\S]{0,200}message:/.test(previewBody || ''));
check(
  'types.ts 的 QuickImportResult.error 未被破坏（向后兼容）',
  /error\?:\s*'not_character_png'\s*\|\s*'read_failed'\s*\|\s*'unsupported';/.test(typesText)
);

// ─────────────────────────────────────────────────────────────
section('9. QuickImportPreviewItem 在 types.ts 定义');
check('types.ts 有 export interface QuickImportPreviewItem', typesText.includes('export interface QuickImportPreviewItem'));
for (const f of ['path', 'fileName', 'size', 'ext', 'kind']) {
  check(`QuickImportPreviewItem 含字段 ${f}`, new RegExp(`\\b${f}[?]?:`).test(typesText.split('export interface QuickImportPreviewItem')[1]?.split('\n}')[0] || ''));
}
check('QuickImportPreviewItem 含 rolePreview', /rolePreview\?:\s*QuickImportRolePreview/.test(typesText));
check('QuickImportPreviewItem 含 bookPreview', /bookPreview\?:\s*QuickImportBookPreview/.test(typesText));
check('QuickImportPreviewItem 含 error（含 code + message）', /error\?:\s*\{\s*code:\s*QuickImportPreviewErrorCode;\s*message\?:\s*string/.test(typesText));
check('QuickImportPreviewItem 含 draft（「导入并编辑」的未落库草稿）', /draft\?:\s*QuickImportEditDraft/.test(typesText));
check('QuickImportPreviewItem 含 kind: QuickImportKind', /kind:\s*QuickImportKind/.test(typesText));
check('types.ts 有 QuickImportPreviewResult（items/truncated/limit）', (() => {
  const seg = typesText.split('export interface QuickImportPreviewResult')[1] || '';
  return /items:\s*QuickImportPreviewItem\[\]/.test(seg) && /truncated:\s*number/.test(seg) && /limit:\s*number/.test(seg);
})());

// ─────────────────────────────────────────────────────────────
section('10. i18n 十处齐全、无空值');
const NEW_KEYS = [
  'quickimport.err_unknown',
  'quickimport.preview.title',
  'quickimport.preview.desc',
  'quickimport.preview.loading',
  'quickimport.preview.empty',
  'quickimport.preview.failed',
  'quickimport.preview.cancel',
  'quickimport.preview.importOnly',
  'quickimport.preview.importAndEdit',
  'quickimport.preview.noEditable',
  'quickimport.preview.badLabel',
  'quickimport.preview.badHint',
  'quickimport.preview.truncated',
  'quickimport.preview.entries',
  'quickimport.preview.keys',
  'quickimport.preview.chars',
  'quickimport.preview.tools',
  'quickimport.preview.segments',
  'quickimport.preview.editHint',
  'quickimport.preview.edited',
];

// translations.ts 内嵌 zh / en 两份
const zhSeg = typesText; // placeholder, replaced below
const translations = read('src/i18n/translations.ts');
const zhBlock = translations.split('  zh: {')[1]?.split('\n  en: {')[0] || '';
const enBlock = translations.split('  en: {')[1]?.split('\n  fr: {')[0] || translations.split('  en: {')[1] || '';
check('translations.ts 能定位 zh 块', zhBlock.length > 1000, `zhBlock=${zhBlock.length}`);
check('translations.ts 能定位 en 块', enBlock.length > 1000, `enBlock=${enBlock.length}`);

const missingZh = NEW_KEYS.filter((k) => !zhBlock.includes(`'${k}':`));
const missingEn = NEW_KEYS.filter((k) => !enBlock.includes(`'${k}':`));
check(`zh 内置字典 20 个新key 齐全`, missingZh.length === 0, missingZh.join(','));
check(`en 内置字典 20 个新 key 齐全`, missingEn.length === 0, missingEn.join(','));

for (const lang of ['fr', 'de', 'ja', 'ko', 'es', 'pt', 'ru', 'zh-Hant']) {
  const f = path.join(ROOT, `src/i18n/locales/${lang}.json`);
  const exists = fs.existsSync(f);
  check(`locales/${lang}.json 存在`, exists);
  if (!exists) continue;
  let dict = null;
  try {
    dict = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    check(`locales/${lang}.json 可被 JSON.parse`, false, String(e));
    continue;
  }
  const missing = NEW_KEYS.filter((k) => !(k in dict));
  const empty = NEW_KEYS.filter((k) => k in dict && (dict[k] === '' || dict[k] === null));
  check(`locales/${lang}.json 20 个新 key 齐全`, missing.length === 0, missing.join(','));
  check(`locales/${lang}.json 新 key 无空值`, empty.length === 0, empty.join(','));
}

// 组件里引用的每个 quickimport.preview.* 键都必须在 zh 块里有定义
const usedKeys = new Set(
  [...modalText.matchAll(/quickimport\.preview\.\w+/g)].map((m) => m[0])
);
const usedInApp = new Set([...appText.matchAll(/quickimport\.preview\.\w+/g)].map((m) => m[0]));
for (const k of new Set([...usedKeys, ...usedInApp])) {
  check(`组件用到的 ${k} 在 zh 字典有定义`, zhBlock.includes(`'${k}':`));
}
// 组件用到的 quickimport.err_* 也都要有
const usedErr = new Set([...modalText.matchAll(/quickimport\.err_\$\{it\.error\.code\}/g)].map(() => 'quickimport.err_$DYN'));
check('失败原因用动态键 quickimport.err_${code} 取文案（四种 code 均已定义）',
  NEW_KEYS.includes('quickimport.err_unknown') &&
  ['not_character_png', 'read_failed', 'unsupported'].every((c) => zhBlock.includes(`'quickimport.err_${c}':`))
);

// ─────────────────────────────────────────────────────────────
section('11. 动画门禁登记 & 无障碍');
check('animControl.ts 登记了 .qip-item（其基态是 opacity:0，不登记会导致列表永久不可见）',
  /'\.qip-item'/.test(read('src/utils/animControl.ts')));
check('index.css 里 .qip-item 的入场用 transition（不是 @keyframes，关档时跳终态而非退回透明）',
  (() => {
    const css = read('src/styles/index.css');
    const seg = css.split('.qip-item {')[1]?.split('\n}')[0] || '';
    return seg.includes('transition:') && !seg.includes('animation:');
  })());
check('index.css 有 .anim-off / data-anim-off 下强制可见的兜底规则',
  /\.anim-off \.qip-item/.test(read('src/styles/index.css')));
check('弹窗复用通用模态类（自动继承入场动画）：.modal-mask + .modal',
  modalText.includes('className="modal-mask"') && modalText.includes('className="modal qip-modal"'));
check('弹窗有 role="dialog"', modalText.includes('role="dialog"'));
check('弹窗有 aria-modal="true"', modalText.includes('aria-modal="true"'));
check('弹窗有 aria-labelledby（指向标题）', /aria-labelledby="qip-title"/.test(modalText) && modalText.includes('id="qip-title"'));
check('弹窗 Esc 可取消', /e\.key === 'Escape'/.test(modalText));
check('弹窗有焦点管理：打开时聚焦默认按钮，关闭时归还焦点', modalText.includes('importOnlyRef') && modalText.includes('openerRef'));
check('弹窗有 Tab 焦点循环（键盘用户不会 Tab 到遮罩后的背景）', modalText.includes("e.key !== 'Tab'"));
check('失败项不只靠颜色区分：带 ⚠ 图标 + 文字标签', /qip-badge-bad/.test(modalText) && modalText.includes('⚠') && modalText.includes('badLabel'));
check('颜色全部走主题变量（弹窗样式里没有硬编码 hex/rgb）', (() => {
  const css = read('src/styles/index.css');
  const seg = css.split('v2.3.97：拖拽导入「预检确认弹窗」')[1]?.split('/* ===== v2.3.63')[0] || css.slice(css.indexOf('.qip-modal'), css.indexOf('.qip-modal') + 6000);
  const hits = seg.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g);
  return !hits;
})());
check('组件里没有硬编码颜色', !/#[0-9a-fA-F]{6}\b|rgba?\(/.test(modalText.replace(/data:image\/[a-z+]+;base64,/g, '')));
check('大小格式化有实现（不是 undefined）', /function formatSize/.test(modalText));

// ─────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 条断言）`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);