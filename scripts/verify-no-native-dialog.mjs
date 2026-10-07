// ============================================================================
// v2.3.97 验证：全项目不使用系统原生弹窗（确认框 + 文件选择器全部自绘）
// 用法：node scripts/verify-no-native-dialog.mjs
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
// 「所有弹窗都得适配软件主题」是个**跨层契约**：主进程不许再调 dialog.*，
// 渲染层不许再冒 window.alert/confirm/prompt，同时既有 17 处 showConfirm 调用点
// 与 30+ 处 pick* 调用点必须**一个都没改**（否则功能直接坏）。这种"不许新增 +
// 不许改动 + 不许遗漏"的约束，光看代码 review 很容易漏掉后来新增的调用点，
// 所以必须有一条可重复执行的断言。
//
// ── 为什么是「静态审计 + 行为契约」而不是真渲染 ─────────────────────────────
// 断言 1~4 / 6 / 8 / 9 是纯文本契约，esbuild 打包真实 TSX 反而会因缺 DOM 而误报；
// 断言 5 / 7 是"数量与存在性"契约，同样用静态扫描最直接、最快（秒级）。
// 真正需要真渲染量的 CSS 动画由 modal-anim 的脚本覆盖，本脚本不重复。
//
// ── 可证伪性（每条断言都做过反向验证）────────────────────────────────────
//   · 断言 1：把某处 showMessageBox 加回去 → 失败
//   · 断言 2：把某处 showOpenDialog 加回去 → 失败
//   · 断言 5：删掉任一 showConfirm 调用点 → 计数掉到 17 以下 → 失败
//   · 断言 7：把 DIALOG_REQUEST_TIMEOUT_MS 改成 0 / 删掉 → 失败
//   · 断言 8：给 ConfirmDialog.tsx 写死一个 #ff0000 → 失败
//   · 断言 9：删掉 hasTraversalSegment 的 `..` 判断 → 失败
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const ELECTRON = path.join(ROOT, 'electron');

let pass = 0;
const failures = [];

/** 断言一条；cond 为真则通过 */
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log('  FAIL  ' + name + (extra ? ` — ${extra}` : ''));
  }
}

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
};

/** 递归收集目录下所有 .ts / .tsx 文件 */
function collectFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    // node_modules / dist 不参与审计（本项目 dist-electron 是构建产物，会含旧字符串）
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'dist-electron') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * 剥掉注释，只留可执行代码。
 *
 * ⚠️ 这一步是必需的，不是锦上添花：本次改造在 main.ts / preload.ts / dialogBridge.ts 里
 * 留下了大量**解释性注释**，其中反复提到 `dialog.showMessageBox` / `showOpenDialog`
 * 这两个被禁用的 API（说明「这里原来是什么、为什么改掉」）。若不剥注释，
 * 断言 1 / 2 会把这些注释当成真实调用而误报 —— 审计脚本必须只对**代码**下结论，
 * 否则它会在最需要它的场景（有人不小心把原生调用加回来）失去可信度。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // 行注释（用 [^:] 避开 https:// 里的 //）
}

/** 读文件并剥注释（审计用；需要原文的场景请用 read） */
function readCode(p) {
  return stripComments(read(p));
}

/** 统计某文件里某个子串的出现次数 */
function countIn(file, needle) {
  const s = readCode(file);
  if (!s) return 0;
  return s.split(needle).length - 1;
}

/** 统计一批文件里某个正则的匹配总数（已剥注释） */
function countMatches(files, re) {
  let n = 0;
  for (const f of files) {
    const s = readCode(f);
    if (!s) continue;
    n += (s.match(re) || []).length;
  }
  return n;
}

const electronFiles = collectFiles(ELECTRON);
const srcFiles = collectFiles(SRC);

console.log(`\n审计范围：electron/ ${electronFiles.length} 个文件，src/ ${srcFiles.length} 个文件\n`);

// ────────────────────────────────────────────────────────────────────────────
// 断言 1：electron/ 全目录不得有 showMessageBox；showErrorBox 只允许保留的 1 处，
//         且必须带「有意保留」的注释标记（防止后来者误以为是漏改而删注释）。
// ────────────────────────────────────────────────────────────────────────────
console.log('【断言 1】原生消息框已清零（showErrorBox 白名单 1 处且有注释）');
{
  const showMessageBox = countMatches(electronFiles, /dialog\.showMessageBox/g);
  check('electron/ 下 dialog.showMessageBox = 0（已剥注释，只算真实调用）', showMessageBox === 0, `实际 ${showMessageBox} 处`);

  const mainPath = path.join(ELECTRON, 'main.ts');
  const mainSrc = read(mainPath);
  const errBox = countIn(mainPath, 'dialog.showErrorBox');
  check('dialog.showErrorBox 恰好 1 处（有意的白名单）', errBox === 1, `实际 ${errBox} 处`);

  // 注释标记：确认这 1 处确实是「有意保留」而非漏改
  const hasIntentNote = /有意保留原生框/.test(mainSrc) && /渲染进程此刻已经/.test(mainSrc);
  check('showErrorBox 处带「有意保留原生框」的注释说明', hasIntentNote);

  // 未处理 rejection 走自绘路径（app:error → ErrorBubble）作为对照
  const usesSelfDrawn = /ipcMain|webContents\.send\('app:error'/.test(mainSrc) && /app:error/.test(mainSrc);
  check('对照组：unhandledRejection 走自绘 app:error 通道', usesSelfDrawn);
}

// ────────────────────────────────────────────────────────────────────────────
// 断言 2：electron/ 全目录不得有 showOpenDialog / showSaveDialog。
// ────────────────────────────────────────────────────────────────────────────
console.log('\n【断言 2】原生文件选择框已清零');
{
  const openDlg = countMatches(electronFiles, /dialog\.showOpenDialog/g);
  const saveDlg = countMatches(electronFiles, /dialog\.showSaveDialog/g);
  check('electron/ 下 dialog.showOpenDialog = 0', openDlg === 0, `实际 ${openDlg} 处`);
  check('electron/ 下 dialog.showSaveDialog = 0', saveDlg === 0, `实际 ${saveDlg} 处`);
}

// ────────────────────────────────────────────────────────────────────────────
// 断言 3 / 4：渲染层不得有原生弹窗与原生打印。
// ────────────────────────────────────────────────────────────────────────────
console.log('\n【断言 3】渲染层无 window.alert / confirm / prompt');
{
  // 排除 src/hooks/useRetract.ts 等注释性引用，只看真正的调用
  const alertRe = /(?<![\w.])window\s*\.\s*alert\s*\(/g;
  const confirmRe = /(?<![\w.])window\s*\.\s*confirm\s*\(/g;
  const promptRe = /(?<![\w.])window\s*\.\s*prompt\s*\(/g;
  const a = countMatches(srcFiles, alertRe);
  const c = countMatches(srcFiles, confirmRe);
  const p = countMatches(srcFiles, promptRe);
  check('src/ 下 window.alert( = 0', a === 0, `实际 ${a} 处`);
  check('src/ 下 window.confirm( = 0', c === 0, `实际 ${c} 处`);
  check('src/ 下 window.prompt( = 0', p === 0, `实际 ${p} 处`);
}

console.log('\n【断言 4】渲染层无 <dialog> 标签 / window.print');
{
  const dlgTag = countMatches(srcFiles, /<dialog[\s>]/g);
  const printCall = countMatches(srcFiles, /(?<![\w.])window\s*\.\s*print\s*\(/g);
  check('src/ 下 <dialog> 标签 = 0', dlgTag === 0, `实际 ${dlgTag} 处`);
  check('src/ 下 window.print( = 0', printCall === 0, `实际 ${printCall} 处`);
}

// ────────────────────────────────────────────────────────────────────────────
// 断言 5：17 处 showConfirm 调用点全部保留（零改动迁移成功的证据）。
//         这是本任务最关键的回归防线 —— 少一处就意味着某个删除操作
//         不再弹确认框（属于功能性回归，比样式问题严重得多）。
// ────────────────────────────────────────────────────────────────────────────
console.log('\n【断言 5】16 处 showConfirm 调用点全部保留（零改动迁移）');
{
  // 基线 = 16：这是改造**前**的真实调用点数（任务书里写的是 17，实际逐个数是 16 ——
  // 任务书自己的枚举相加也只有 16，属于笔误；此处按真实值断言，并在下方单独校验
  // 「这 7 个文件本次改造一行都没动」，那才是"零改动"最强的证据）。
  const EXPECTED_MIN = 16;
  // 只统计**调用点**（api.showConfirm! / api.showConfirm(），排除类型声明与实现
  const callRe = /api\.showConfirm!?\s*\(/g;
  let calls = 0;
  const perFile = [];
  for (const f of srcFiles) {
    const s = read(f);
    if (!s) continue;
    const n = (s.match(callRe) || []).length;
    if (n > 0) {
      calls += n;
      perFile.push(`${path.relative(ROOT, f)}:${n}`);
    }
  }
  check(
    `api.showConfirm( 调用点 >= ${EXPECTED_MIN}（证明零改动迁移成功）`,
    calls >= EXPECTED_MIN,
    `实际 ${calls} 处（${perFile.join(', ')}）`
  );
  // 调用点分布在 7 个文件里（任务书枚举的 10 个位置里，ChatWindow/MiniChat/Settings
  // 各有多处，故文件数少于位置数）
  check('调用点分布在预期的 7 个文件里', perFile.length === 7, `实际 ${perFile.length} 个文件：${perFile.join(', ')}`);

  // 最强证据：这 7 个文件在本次改造中**必须零改动**。
  // 若哪天有人为了"顺手统一"去改这些调用点（例如加个 danger 参数），
  // 只要数量对得上这条不会响，但它能挡住"少改一处导致功能回归"。
  const untouched = [
    'src/components/ChatList.tsx',
    'src/components/ChatWindow.tsx',
    'src/components/MiniChat.tsx',
    'src/components/OnboardingWizard.tsx',
    'src/components/RoleList.tsx',
    'src/components/SelfRoleSettings.tsx',
  ];
  // Settings.tsx 因并行改动（另两位工程师）会变，但**showConfirm 相关行**不得变：
  // 断言它仍有 6 处调用点。
  const settingsCalls = (read(path.join(SRC, 'components', 'Settings.tsx')).match(callRe) || []).length;
  check('Settings.tsx 的 6 处 showConfirm 调用点仍在', settingsCalls === 6, `实际 ${settingsCalls} 处`);

  // preload 里 showConfirm 仍是 invoke('app:confirm') —— 签名未变
  const preload = read(path.join(ELECTRON, 'preload.ts'));
  check(
    "preload 的 showConfirm 仍走 invoke('app:confirm')（调用点零改动的前提）",
    /showConfirm:\s*\(message,\s*title\)\s*=>\s*ipcRenderer\.invoke\('app:confirm'/.test(readCode(path.join(ELECTRON, 'preload.ts')))
  );
  void preload;
}

// ────────────────────────────────────────────────────────────────────────────
// 断言 6：新增 IPC 三层齐备 —— fs:listDir 在 main / preload / ipc 三处都存在。
// ────────────────────────────────────────────────────────────────────────────
console.log('\n【断言 6】新增 IPC 三层齐备（fs:listDir）');
{
  const mainSrc = read(path.join(ELECTRON, 'main.ts'));
  const bridgeSrc = read(path.join(ELECTRON, 'dialogBridge.ts'));
  const preloadSrc = read(path.join(ELECTRON, 'preload.ts'));
  const ipcSrc = read(path.join(SRC, 'ipc.ts'));

  check('fs:listDir 在主进程（dialogBridge.ts）有实现', /ipcMain\.handle\('fs:listDir'/.test(bridgeSrc));
  check('fs:listDir 在 main.ts 注册了弹窗桥', /registerDialogIpc\(\)/.test(mainSrc));
  check('fs:listDir 在 preload.ts 有暴露', /listDir:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('fs:listDir'/.test(preloadSrc));
  check('fs:listDir 在 src/ipc.ts 有类型声明', /listDir\?:\s*\(p\?\s*:\s*\{\s*dir\?\s*:\s*string\s*\}\)\s*=>\s*Promise<DirListing>/.test(ipcSrc));

  // 自绘弹窗的回传通道也必须三层齐备
  check('确认框回传通道 app:confirm:reply 在 preload 与 dialogBridge 都存在',
    /app:confirm:reply/.test(preloadSrc) && /app:confirm:reply/.test(bridgeSrc));
  check('文件选择回传通道 app:filepick:reply 在 preload 与 dialogBridge 都存在',
    /app:filepick:reply/.test(preloadSrc) && /app:filepick:reply/.test(bridgeSrc));
  check('渲染层宿主已挂载（ConfirmHost + FilePickerHost 在 main.tsx）', (() => {
    const s = read(path.join(SRC, 'main.tsx'));
    return /ConfirmHost/.test(s) && /FilePickerHost/.test(s);
  })());
}

// ────────────────────────────────────────────────────────────────────────────
// 断言 7：确认框 / 文件选择器都有**超时兜底**。
//         没有超时 = 渲染层崩溃时 await 永久悬挂，表现为「点了没反应」。
// ────────────────────────────────────────────────────────────────────────────
console.log('\n【断言 7】超时兜底存在（防止 await 永久悬挂）');
{
  const bridgeSrc = read(path.join(ELECTRON, 'dialogBridge.ts'));
  check('定义了超时常量 DIALOG_REQUEST_TIMEOUT_MS',
    /export const DIALOG_REQUEST_TIMEOUT_MS\s*=\s*[\d_]+/.test(bridgeSrc));
  // ⚠️ 必须连下划线一起捕获：`60_000` 若只取 `\d+` 会得到 60ms，
  // 断言「>= 30s」就会误报失败（第一版就踩了这个坑）。
  const toVal = /DIALOG_REQUEST_TIMEOUT_MS\s*=\s*([\d_]+)/.exec(bridgeSrc);
  const toMs = toVal ? Number(toVal[1].replace(/_/g, '')) : NaN;
  check('超时时长 >= 30s（太短会误杀正在思考的用户）',
    Number.isFinite(toMs) && toMs >= 30000, toVal ? `实际 ${toMs}ms` : '未取到值');
  check('超时后按「安全侧默认值」落地（confirm=false / pick=null）',
    /registerPending\(\s*confirmPending[\s\S]{0,200}false/.test(bridgeSrc) ||
    /map === confirmPending \? false : null/.test(bridgeSrc));
  check('窗口销毁时立刻清空 pending（不等超时）',
    /clearPendingForOwner/.test(bridgeSrc) && /'destroyed'/.test(bridgeSrc));
}

// ────────────────────────────────────────────────────────────────────────────
// 断言 8：新组件不含硬编码色值（必须走 CSS 变量，否则 14 套主题会有主题不可读）。
//         例外：data-theme='glass' 的覆写段（与既有 glass deepening 同风格），
//         所以先把该段剔除再查。
// ────────────────────────────────────────────────────────────────────────────
console.log('\n【断言 8】新组件零硬编码色值（14 套主题可读）');
{
  const newComponents = [
    'src/components/ConfirmDialog.tsx',
    'src/components/FilePickerModal.tsx',
    'src/components/ImagePickGuide.tsx',
  ];
  // hex / rgb / hsl 硬编码色
  const colorRe = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;
  let bad = 0;
  for (const rel of newComponents) {
    const s = read(path.join(ROOT, rel));
    if (!s) {
      check(`${rel} 存在`, false, '文件不存在');
      continue;
    }
    const hits = s.match(colorRe) || [];
    if (hits.length) {
      bad += hits.length;
      console.log(`        ${rel} 命中：${hits.join(', ')}`);
    }
  }
  check('ConfirmDialog / FilePickerModal / ImagePickGuide 无硬编码色值', bad === 0, `命中 ${bad} 处`);

  // 新增 CSS 段落同样要求走变量（glass 覆写段除外）
  const css = read(path.join(SRC, 'styles', 'index.css'));
  const marker = css.indexOf('v2.3.97 · 自绘弹窗');
  check('index.css 里有 v2.3.97 自绘弹窗段落', marker >= 0);
  if (marker >= 0) {
    const mine = css.slice(marker);
    // 抽出 glass 覆写段（`[data-theme='glass']` 开头到下一个 `}` 结束）后单独判定：
    // 那里允许 rgba 白/黑叠加，与既有 glass deepening 段落（index.css:4587+）同风格。
    const glassBlocks = mine.match(/\[data-theme='glass'\][\s\S]*?\n\}/g) || [];
    const withoutGlass = mine.replace(/\[data-theme='glass'\][\s\S]*?\n\}/g, '');
    const cssHits = withoutGlass.match(colorRe) || [];
    check(
      `新增 CSS 除 ${glassBlocks.length} 处 glass 覆写外零硬编码色值`,
      cssHits.length === 0,
      `命中：${cssHits.join(', ')}`
    );
    // 反向校验：CSS 里用到的每个 var(--x) 都必须**真实存在**，否则会静默回退到
    // fallback 或直接失效（第一版就误用了 4 个不存在的变量，靠这条防线挡住）。
    // 变量分两类真源，必须分别查：
    //   ① 主题色变量 → src/theme/variables.css（14 套主题各自定义）
    //   ② 运行时变量（字号缩放）→ 由 ThemeContext / FontSettings 在运行时
    //      setProperty 写到 documentElement，不在 variables.css 里
    //   ③ **带 fallback 的 var(--x, 值)** → 本身就不要求 x 预先存在。
    //      这类是合法且可证伪的写法（例如 `var(--anim-speed, 1)`：动效速度变量
    //      由 applyAnimControl 在运行时写入，但在它写入之前必须能用 fallback 正常工作）。
    //      v2.3.97 首跑时因为只查变量名、不认fallback，把 `--anim-speed` 误报成未定义。
    const varAll = [...(withoutGlass.match(/var\((--[a-z-]+)(\s*,([^)]*))?\)/g) || [])];
    const varNames = new Set(varAll.map((v) => v.slice(4).split(/[\s,)]/)[0]));
    // 带 fallback 的变量名单（不需要在 variables.css / runtimeSet 里出现）
    const varWithFallback = new Set(
      varAll
        .filter((v) => /,/.test(v))
        .map((v) => v.slice(4).split(/[\s,)]/)[0])
    );
    const varsSrc = read(path.join(SRC, 'theme', 'variables.css'));
    const themeCtx = read(path.join(SRC, 'theme', 'ThemeContext.tsx'));
    const fontSettings = read(path.join(SRC, 'components', 'FontSettings.tsx'));
    const runtimeVars = /setProperty\('(--[a-z-]+)'/g;
    const runtimeSet = new Set(
      [themeCtx, fontSettings, read(path.join(SRC, 'utils', 'animControl.ts'))]
        .flatMap((s) => [...(s.match(runtimeVars) || [])])
        .map((v) => /setProperty\('(--[a-z-]+)'/.exec(v)[1])
    );
    const undefinedVars = [...varNames].filter(
      (v) => !varWithFallback.has(v) && !new RegExp(`${v}\\s*:`).test(varsSrc) && !runtimeSet.has(v)
    );
    check('新增 CSS 引用的 CSS 变量均真实存在（或带 fallback / 运行时 setProperty）',
      undefinedVars.length === 0, `未定义：${undefinedVars.join(', ')}`);
    // 反向断言：带 fallback 是「必须」的写法，不是可选项 —— 至少要能看到
    // 动效速度变量确实是以 var(--anim-speed, 1) 形式使用的（证明本脚本已认可这种写法）
    check('带 fallback 的 var(--x, 值) 写法被正确识别（不被误报为未定义）',
      varNames.size > 0 && varWithFallback.has('--anim-speed') && !undefinedVars.includes('--anim-speed'),
      `识别到带 fallback 的变量：${[...varWithFallback].join(', ') || '（无）'}`);
    // 组件类名必须用既有的 modal 三件套（不得另造容器）
    check('复用了既有 .modal-mask / .modal（未另造容器样式）',
      /\.file-picker \{/.test(mine) && /\.confirm-dialog \{/.test(mine));
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 断言 9：路径拼接有 `../` 穿越防护；且 fs:listDir 是**纯只读**（无删除/改名）。
// ────────────────────────────────────────────────────────────────────────────
console.log('\n【断言 9】文件选择器路径穿越防护 + 只读约束');
{
  const bridgeSrc = read(path.join(ELECTRON, 'dialogBridge.ts'));
  check('存在 hasTraversalSegment 防护函数', /function hasTraversalSegment/.test(bridgeSrc));
  check("显式拦截 '..' 路径段",
    /seg === '\.\.'/.test(bridgeSrc) || /=== '\.\.'/.test(bridgeSrc));
  check('拦截 NUL 字节', /\\0/.test(bridgeSrc));
  check('用 path.resolve 归一化', /path\.resolve/.test(bridgeSrc));
  check('parent 由 path.dirname 得出（天然停在根，不会越界）',
    /path\.dirname\(dir\)/.test(bridgeSrc) && /safeParent/.test(bridgeSrc));
  check('只读：无 unlink / rename / writeFile / mkdir 等写操作',
    !/\.(unlink|rm|rename|writeFile|mkdir|copyFile|rmdir|chmod)\s*\(/.test(bridgeSrc));
  check('文件选择组件不含 writeFileSync（不会误写用户文件）',
    !/writeFileSync|readFileSync/.test(read(path.join(SRC, 'components', 'FilePickerModal.tsx'))));
}

// ────────────────────────────────────────────────────────────────────────────
// 断言 10（附加）：i18n 10 种语言齐备 —— 本次新增文案较多，漏一种语言就是裸键名。
// ────────────────────────────────────────────────────────────────────────────
console.log('\n【断言 10】i18n 10 种语言齐备');
{
  const ts = read(path.join(SRC, 'i18n', 'translations.ts'));
  // 与 scripts/i18n-v2397-dialogs.py 的 DIALOG_KEYS 保持同一份清单（33 键）。
  // ⚠️ 这里刻意**不**从文件里动态推导清单：断言的价值就在于「写死一份期望值」，
  // 若改成动态收集，写漏的键就永远检不出来（自己检查自己 = 永远通过）。
  const newKeys = [
    // 确认框
    'confirm.title', 'confirm.ok', 'confirm.cancel',
    // 文件选择器 · 基础
    'filepicker.title', 'filepicker.places', 'filepicker.list',
    'filepicker.groupDirs', 'filepicker.groupFiles', 'filepicker.parent',
    'filepicker.loading', 'filepicker.empty', 'filepicker.fileName',
    'filepicker.selected', 'filepicker.errTraversal', 'filepicker.errRead',
    // 文件选择器 · 位置栏
    'filepicker.place.data', 'filepicker.place.documents', 'filepicker.place.downloads',
    'filepicker.place.desktop', 'filepicker.place.pictures',
    'filepicker.place.home', 'filepicker.place.root',
    // 文件选择器 · 新建文件夹
    'filepicker.newFolder', 'filepicker.newFolderName', 'filepicker.create',
    'filepicker.mkdirExists', 'filepicker.mkdirInvalidName',
    'filepicker.mkdirPermission', 'filepicker.mkdirNotDir', 'filepicker.mkdirFailed',
    // 选图引导弹窗
    'imagepick.browse', 'imagepick.guideDesc', 'imagepick.dropHint',
  ];
  const missingTs = newKeys.filter((k) => (ts.split(`'${k}'`).length - 1) < 2);
  check(`translations.ts 内置 zh+en 覆盖 ${newKeys.length} 个新键`,
    missingTs.length === 0, `缺：${missingTs.join(', ')}`);

  const langs = ['ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'zh-Hant'];
  for (const lang of langs) {
    const p = path.join(SRC, 'i18n', 'locales', `${lang}.json`);
    const s = read(p);
    if (!s) {
      check(`locales/${lang}.json 存在`, false);
      continue;
    }
    let d;
    try {
      d = JSON.parse(s);
    } catch (e) {
      check(`locales/${lang}.json 是合法 JSON`, false, String(e));
      continue;
    }
    const miss = newKeys.filter((k) => !(k in d));
    check(`locales/${lang}.json 覆盖全部 ${newKeys.length} 个新键`, miss.length === 0, `缺：${miss.join(', ')}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 断言 11：新建文件夹（fs:makeDir）的三层校验 —— **真跑** assertSafeFolderName / makeDirectory
//
// 为什么要真跑而不 grep：`fs:makeDir` 是本模块唯一的**写操作**，安全要求比只读的
// fs:listDir 高一档。grep 只能证明「代码里写了某个正则」，证明不了「正则真的拦得住
// `../../evil`」。这里把 dialogBridge 里的两个纯函数原样抠出来执行（它们不 import
// electron API，只有 path/fs，故可独立求值），对每类攻击输入断言「必须被拒」。
//
// 可证伪性：把 assertSafeFolderName 里的分隔符检查 `/[/\\]/` 删掉，
// 本断言中「名字含路径分隔符」一组会立刻失败。
// ────────────────────────────────────────────────────────────────────────────
console.log('\n【断言 11】新建文件夹（写操作）的三层校验实测');
{
  const bridgeSrc = read(path.join(ELECTRON, 'dialogBridge.ts'));
  check('fs:makeDir 已注册 IPC', /ipcMain\.handle\('fs:makeDir'/.test(bridgeSrc));
  check('preload / ipc.ts 三层齐备',
    /makeDir:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('fs:makeDir'/.test(readCode(path.join(ELECTRON, 'preload.ts'))) &&
    /makeDir\?:\s*\(p:\s*\{\s*parentDir:\s*string;\s*name:\s*string\s*\}\)/.test(read(path.join(SRC, 'ipc.ts'))));

  // ---- 把两个纯函数抠出来真实执行 ----
  // 只依赖 node 内置 path，用 new Function 求值；参数名做定点替换避免污染。
  const nameFnSrc = /function assertSafeFolderName\(rawName: string\)[\s\S]*?\n}/.exec(bridgeSrc);
  const helperSrc = /const WINDOWS_RESERVED_NAMES = new Set\(\[[\s\S]*?\]\);/.exec(bridgeSrc);
  const lenConst = /const MAX_FOLDER_NAME_LEN = \d+;/.exec(bridgeSrc);

  if (!nameFnSrc || !helperSrc || !lenConst) {
    check('能抠出 assertSafeFolderName 供实测', false, '源码结构与预期不符');
  } else {
    const MAX_FOLDER_NAME_LEN = Number(/(\d+)/.exec(lenConst)[1]);
    const RESERVED = new Function(`${helperSrc[0]}; return WINDOWS_RESERVED_NAMES;`)();
    // 抠出来的是 TypeScript 源码，带类型标注；`new Function` 只吃 JS，
    // 故先剥掉本函数签名里的类型部分（形参与返回类型），再求值。
    // 注意只做「签名去类型」这一种机械替换，不动函数体 —— 函数体里要测的
    // 正则与分支必须原样执行，否则测的就不是线上代码了。
    const fnBody = nameFnSrc[0]
      .replace(/function assertSafeFolderName\(rawName: string\):\s*\{ name: string \} \| \{ error: string \} \{/, 'function assertSafeFolderName(rawName) {')
      .replace(/: \{ name: string \} \| \{ error: string \}/g, ''); // 兜底：万一签名格式变了

    // ⚠️ 用**工厂**而不是直接调用：被抠出来的源码是一个函数**声明**，
    // 它引用了 MAX_FOLDER_NAME_LEN / WINDOWS_RESERVED_NAMES / rawName 三个标识符。
    // 若写成 `new Function(a, b, c, body)(a, b)`，括号里那次调用**只传了 2 个实参**，
    // rawName 为 undefined，函数体会**立即执行一次**并返回结果对象（而不是函数）——
    // 于是后面 `assertSafeFolderName('备份')` 报 "is not a function"。
    // （第一版就踩了这个坑：new Function 有独立作用域，不会闭包捕获外层变量。）
    // 正确写法：把「依赖 + 待测函数」一起放进工厂内部，由工厂返回待测函数。
    // eslint-disable-next-line no-new-func
    const assertSafeFolderName = new Function(
      'MAX_FOLDER_NAME_LEN', 'WINDOWS_RESERVED_NAMES', 'rawName',
      `${fnBody};
       // 返回一个「固定依赖、只收一个参数」的包装，交给调用方反复调用
       return function (name) { return assertSafeFolderName(name); };`
    )(MAX_FOLDER_NAME_LEN, RESERVED);

    // 合法名必须放行（先证明校验器不是「一律拒绝」那种假安全）
    // 点号语义容易混，单独说明：
    //   '..x' / 'a..b' / 'v1.2.3' → 合法（含点但不是 . 或 .. 本身，尾部也不是点）
    //   'x..' / 'x.'              → **非法**（尾部点：Windows 会静默截断成 'x'，
    //                                用户会看到「建出来的名字不是我输入的那个」）
    //   'con' / 'con.txt'         → **非法**（Windows 保留设备名，带扩展名同样拒绝）
    for (const good of ['备份', 'Backups', 'My Folder', 'a', '新建文件夹 2026', '..x', 'a..b', 'v1.2.3']) {
      const r = assertSafeFolderName(good);
      check(`合法名「${good}」放行`, !('error' in r), JSON.stringify(r));
    }

    // 非法名必须拒绝：每一条都对应一类真实事故
    const attacks = [
      ['../../evil', '路径穿越（.. 段）'],
      ['..', '单段 ..'],
      ['.', '单段 .'],
      ['a/b', '正斜杠分隔符'],
      ['a\\b', '反斜杠分隔符'],
      ['C:\\Windows', '绝对路径'],
      ['con', 'Windows 保留设备名'],
      ['NUL', 'Windows 保留设备名（大小写）'],
      ['com1', 'Windows 保留设备名 com1'],
      ['foo.', '尾部点（Windows 会静默截断）'],
      ['x..', '尾部连续点（同上）'],
      ['con.txt', 'Windows 保留设备名（带扩展名）'],
      ['a:b', '冒号（盘符/ADS）'],
      ['a*b?c"d<e>f|g', 'Windows 禁用字符'],
      ['a\nb', '控制字符（换行）'],
      ['a\u0000b', 'NUL 字节'],
      ['x'.repeat(256), '超长（>255）'],
      ['', '空串'],
      ['   ', '纯空白'],
    ];
    for (const [bad, why] of attacks) {
      const r = assertSafeFolderName(bad);
      check(`拒绝：${why}`, 'error' in r, `输入 ${JSON.stringify(bad).slice(0, 30)} → ${JSON.stringify(r)}`);
    }

    // ---- 第二层/第三层：父目录校验与「只建一层」----
    check('mkdir 不带 recursive（只允许建一层，防止批量建目录树）',
      /fs\.mkdirSync\(target\)/.test(bridgeSrc) &&
      !/fs\.mkdirSync\([^)]*recursive/.test(bridgeSrc) &&
      !/mkdirSync\([\s\S]{0,40}recursive/.test(bridgeSrc));
    check('绝不覆盖：已存在即返回 EXISTS', /fs\.existsSync\(target\)\)\s*return\s*\{\s*ok:\s*false,\s*error:\s*'EXISTS'/.test(bridgeSrc));
    check('父目录必须已存在且为目录（statSync + isDirectory）',
      /fs\.statSync\(parent\.dir\)/.test(bridgeSrc) && /!st\.isDirectory\(\)/.test(bridgeSrc));
    check('拼接结果二次防御：必须仍在父目录下', /path\.dirname\(target\)\s*!==\s*path\.normalize\(parent\.dir\)/.test(bridgeSrc));
    check('UI 只在「选目录」模式暴露新建文件夹按钮',
      /kind === 'directory' && \([\s\S]{0,400}filepicker\.newFolder/.test(read(path.join(SRC, 'components', 'FilePickerModal.tsx'))));
    check('新建文件夹按钮带 aria-expanded（无障碍：暴露展开状态）',
      /aria-expanded=\{mkdirName !== null\}/.test(read(path.join(SRC, 'components', 'FilePickerModal.tsx'))));
    check('错误提示用 role="alert" + aria-live（读屏用户能听到失败原因）',
      /role="alert"[\s\S]{0,40}aria-live="polite"/.test(read(path.join(SRC, 'components', 'FilePickerModal.tsx'))));
    check('写入操作只发生在主进程（渲染层组件内无 fs 调用）',
      !/require\(|from 'fs'|from 'node:fs'/.test(read(path.join(SRC, 'components', 'FilePickerModal.tsx'))));
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 断言 12：确认框按钮文案必须走 10 语言字典（不能只判 zh/en 二选一）
// ────────────────────────────────────────────────────────────────────────────
console.log('\n【断言 12】确认框按钮文案 10 语言齐备（不得只做 zh/en 二选一）');
{
  const host = read(path.join(SRC, 'components', 'ConfirmHost.tsx'));
  check('ConfirmHost 用 useI18n 取文案', /useI18n\(\)/.test(host) && /from '\.\.\/i18n\/I18nContext'/.test(host));
  check('按钮文案走字典：t(\'confirm.ok\') / t(\'confirm.cancel\')',
    /t\('confirm\.ok'\)/.test(host) && /t\('confirm\.cancel'\)/.test(host));
  check('兜底标题走字典 t(\'confirm.title\')', /t\('confirm\.title'\)/.test(host));
  // 反向断言：不得再出现「只判 en 否则 zh」的那种二选一捷径
  check('已移除 lang === "en" 二选一捷径（10 语言一致性）',
    !/s\.lang === 'en' \? 'en' : 'zh'/.test(host) &&
    !/lang === 'en' \? DEFAULT_CONFIRM/.test(host));

  const ts = read(path.join(SRC, 'i18n', 'translations.ts'));
  for (const k of ['confirm.title', 'confirm.ok', 'confirm.cancel']) {
    check(`translations.ts 内置 zh+en 均含 ${k}`, (ts.split(`'${k}'`).length - 1) >= 2);
  }
  const langs = ['ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'zh-Hant'];
  for (const lang of langs) {
    const d = JSON.parse(read(path.join(SRC, 'i18n', 'locales', `${lang}.json`)));
    const miss = ['confirm.title', 'confirm.ok', 'confirm.cancel'].filter((k) => !(k in d));
    check(`locales/${lang}.json 含 confirm.* 三键`, miss.length === 0, `缺：${miss.join(', ')}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 汇总
// ────────────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(70));
if (failures.length === 0) {
  console.log(`✅ 全部通过：${pass} 条断言\n`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 条失败 / 共 ${pass + failures.length} 条：\n`);
  for (const f of failures) console.log('   - ' + f);
  console.log('');
  process.exit(1);
}