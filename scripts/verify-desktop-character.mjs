// ============================================================================
// V3 验证：桌面角色（捉宠角色）
// 用法：node scripts/verify-desktop-character.mjs
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
// 这个功能是「第 5 个独立渲染文档 + 主进程物理层 + 自研素材协议 + 三种模型渲染器」
// 的组合，任何一环掉链子都是**静默失败**：窗口透明但点不到、素材 404、模型白屏、
// 右键菜单在某个主题下变成深底深字……靠人眼回归 14 套主题 × 4 类角色包不现实。
// 因此把「不可回退的结构契约」固化成断言：窗口参数、弹簧常数、穿透路由、
// 协议安全、渲染器分发、i18n 10 处、动画分组登记、合规措辞。
//
// ── 可证伪性（G 段自证）────────────────────────────────────────────────────
//   · 把桌宠 level 抬回 `screen-saver`（与悬浮球同级）→ A 段红
//   · 去掉路径穿越判断 → C 段红
//   · 把 dynamic import 改成静态 → D 段红
//   · 删掉 character 动画分组 → F 段红
//   · 某处置顶说明写回「与悬浮球同级」→ G2 段红
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
let pass = 0;
const failures = [];

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
    return fs.readFileSync(path.join(ROOT, p), 'utf-8');
  } catch {
    return '';
  }
};
/**
 * 去掉源码里的注释（// 与 /* *\/），只留可执行代码。
 * 用途：「必须不含某串」的断言不应被注释里的说明文字命中 ——
 * 例如注释里写「不能用 readAnimSpeed(document)」是在解释原因，不算残留调用。
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const section = (s) => console.log('\n===== ' + s + ' =====');

// ---------- 读取源文件 ----------
const mainDc = read('electron/desktopCharacter.ts');
const assets = read('electron/characterAssets.ts');
const appTsx = read('src/character/CharacterApp.tsx');
const modelView = read('src/character/ModelView.tsx');
const threeView = read('src/character/ThreeModelView.tsx');
const vrmPose = read('src/character/vrmPose.ts');
const l2dView = read('src/character/Live2DView.tsx');
const coll = read('src/components/CharacterCollection.tsx');
const stage = read('src/components/CharacterStage.tsx');
const charCss = read('src/styles/character.css');
const indexCss = read('src/styles/index.css');
const panelCss = read('src/styles/character-panel.css');
const settings = read('src/components/Settings.tsx');
const sidebar = read('src/components/Sidebar.tsx');
const appRoot = read('src/App.tsx');
const anim = read('src/utils/animControl.ts');
const vite = read('vite.config.ts');
const charHtml = read('character.html');
const charEntry = read('src/character.tsx');
const preload = read('electron/preload.ts');
const electronMain = read('electron/main.ts');
const types = read('src/types.ts');
const trans = read('src/i18n/translations.ts');
const assetsTs = read('electron/characterAssets.ts');
const themeCtx = read('src/theme/ThemeContext.tsx');
const aboutModal = read('src/components/AboutModal.tsx');
const windowLevels = read('electron/windowLevels.ts');
const floatingBall = read('electron/floatingBall.ts');
const chatWin = read('src/components/ChatWindow.tsx');
const miniChat = read('src/components/MiniChat.tsx');
const ipcTs = read('src/ipc.ts');
const dbTs = read('electron/db.ts');
const LOCALE_CODES = ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'];
const localeStageZoom = LOCALE_CODES.map((code) => {
  try {
    return JSON.parse(read(`src/i18n/locales/${code}.json`))['characters.stageZoom'] || '';
  } catch {
    return '';
  }
});

// ============================================================================
section('A. 窗口与物理层（electron/desktopCharacter.ts）');
// ============================================================================
check('存在独立渲染入口 character.html 且挂载 /src/character.tsx', /src\/character\.tsx/.test(charHtml));
check('vite 多页入口登记 character.html', /character:\s*path\.resolve\(__dirname,\s*'character\.html'\)/.test(vite));
check('透明无边框无阴影且不占任务栏',
  /transparent:\s*true/.test(mainDc) && /frame:\s*false/.test(mainDc) &&
  /hasShadow:\s*false/.test(mainDc) && /skipTaskbar:\s*true/.test(mainDc));
// v3.0.1-beta.9：不再要求「与悬浮球同级」，改为锁定稳定的三层契约。
check('置顶层级走统一常量：悬浮球 > 桌宠 > 小窗（windowLevels.ts）',
  /applyAlwaysOnTop\([^)]*DESKTOP_CHARACTER_LEVEL\)/.test(mainDc) &&
  /FLOATING_BALL_LEVEL:\s*AlwaysOnTopLevel\s*=\s*'screen-saver'/.test(windowLevels) &&
  /DESKTOP_CHARACTER_LEVEL:\s*AlwaysOnTopLevel\s*=\s*'pop-up-menu'/.test(windowLevels) &&
  /MINI_WINDOW_LEVEL:\s*AlwaysOnTopLevel\s*=\s*'floating'/.test(windowLevels));
check('悬浮球三窗与桌宠不再同 level（level 字面量不散落在业务文件）',
  /applyAlwaysOnTop\([^)]*FLOATING_BALL_LEVEL\)/.test(floatingBall) &&
  !/setAlwaysOnTop\([^)]*'screen-saver'\)/.test(floatingBall) &&
  !/setAlwaysOnTop\([^)]*'screen-saver'\)/.test(mainDc));
check('默认整体穿透且开启 forward', /setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/.test(mainDc));
check('弹簧参数 K=200 / C=30 / 子步 1/120',
  /SPRING_K\s*=\s*200/.test(mainDc) && /SPRING_C\s*=\s*30/.test(mainDc) && /SUBSTEP\s*=\s*1\s*\/\s*120/.test(mainDc));
check('拖拽目标取设备光标（screen.getCursorScreenPoint）', /screen\.getCursorScreenPoint\(\)/.test(mainDc));
check('惯性滑停存在（摩擦 0.9 / 阈值 24）', /\*=\s*0\.9/.test(mainDc) && /<\s*24/.test(mainDc));
check('与悬浮球非重叠避让（getBallWindowBounds + BALL_GAP）',
  /getBallWindowBounds/.test(mainDc) && /BALL_GAP/.test(mainDc) && /function avoidBall/.test(mainDc));
check('拖拽期间锁定可交互（dragging 分支先于 ignore 判定）',
  /if\s*\(dragging\)\s*\{[\s\S]{0,80}setIgnoreMouseEvents\(false\)/.test(mainDc));
check('穿透锁定期间忽略一切可交互请求',
  /if\s*\(rt\.passThroughLocked\)\s*\{[\s\S]{0,120}setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/.test(mainDc));
// v3.0.1-beta.13 多窗口：主开关开启时应为「每个 enabled 角色」各建一个窗口，
// 不再有「隐藏窗口 showInactive」的单窗重开语义（createDesktopCharacter 已对隐藏窗口 showInactive，
// 但那是单角色补窗逻辑，不是全局开关契约）。改为断言 setDesktopCharacterEnabled 链式建窗。
check('主开关开启会为每个 enabled 角色建窗（setDesktopCharacterEnabled → showAllDesktopCharacters → createDesktopCharacter(id)）',
  /export function setDesktopCharacterEnabled\(v: boolean\)[\s\S]{0,600}showAllDesktopCharacters\(\)/.test(mainDc) &&
  /export function showAllDesktopCharacters\(\)[\s\S]{0,300}createDesktopCharacter\(c\.id\)/.test(mainDc));

// ============================================================================
section('A2. Windows Z 序兜底（moveTop）+ QA Round 1 返工契约 + Round 2 N1 可见性守卫');
// ============================================================================
// Windows 上 Electron 的 level 不参与 z_order 计算（base_window.cc 里
// z_order = top ? kFloatingWindow : kNormal），只靠 level 无法保证「悬浮球压住桌宠」。
// 以下断言锁定构造性兜底：实现存在 + 每条关键路径都真的调用了重申。
// v3.0.1-beta.9 QA Round 2 N1：MoveTop() 的 Windows flags 含 SWP_SHOWWINDOW，
// 对隐藏窗口调用会把 WS_VISIBLE 置位、令窗口可见但 Chromium visible_ 不同步 →
// 空白浮窗 + 收起功能失效。故必须「只对可见窗口 moveTop()」，并把启动期 create 重申
// 延后到球窗 ready-to-show 之后、ball-show 重申移到 showInactive() 之后。
const zPlatformDocOk = (src) =>
  /macOS/.test(src) && /Windows/.test(src) &&
  /不参与/.test(src) && /moveTop\(\)/.test(src) &&
  !/由系统保证顺序/.test(src) && !/不再依赖创建顺序/.test(src);
check('windowLevels.ts 如实标注 macOS/Windows 差异且要求 moveTop 兜底', zPlatformDocOk(windowLevels));
check('reassertFloatingBallOnTop 对悬浮球三窗调用 moveTop()（构造性兜底）',
  /export function reassertFloatingBallOnTop\(reason: string\)/.test(floatingBall) &&
  /ballWindow\.moveTop\(\)/.test(floatingBall) &&
  /panelWindow\.moveTop\(\)/.test(floatingBall) &&
  /menuWindow\.moveTop\(\)/.test(floatingBall));
const Z_BALL_REASONS = ['create', 'ball-aot-on', 'ball-show', 'poll'];
const Z_DC_REASONS = ['dc-ready', 'dc-enable', 'dc-aot-on', 'dc-show-window'];
for (const r of Z_BALL_REASONS) {
  check(`Z 序兜底覆盖悬浮球关键路径「${r}」（确有调用，非仅函数定义）`,
    floatingBall.includes(`reassertFloatingBallOnTop('${r}')`));
}
for (const r of Z_DC_REASONS) {
  check(`Z 序兜底覆盖桌宠关键路径「${r}」（确有调用，非仅函数定义）`,
    mainDc.includes(`reassertFloatingBallOnTop('${r}')`));
}
check('轮询里 1s 节流 + probe 条件（覆盖点击桌宠抬升焦点）',
  /Z_ORDER_REASSERT_MS\s*=\s*1000/.test(floatingBall) &&
  /Z_ORDER_REASSERT_MS\s*&&\s*ballPeerOnTopProbe\?\.\(\)/.test(floatingBall) &&
  /reassertFloatingBallOnTop\('poll'\)/.test(floatingBall));
check('main.ts 作为协调层注入 probe（避免 floatingBall ↔ desktopCharacter 成环）',
  /setBallPeerOnTopProbe\(/.test(electronMain) && /getDesktopCharacterWindow\(\)/.test(electronMain) &&
  !/from '\.\/desktopCharacter'/.test(floatingBall));
check('桌宠分支有 streamControllers busy guard（不中断用户正在进行的 AI 回复）',
  /if \(streamControllers\.has\(p\.chatId\)\)\s*\{[\s\S]{0,180}error: 'busy'/.test(electronMain));
check('stream:done 载荷透传 silent，失败清理带 noMemory',
  /broadcast\('stream:done', \{ streamId, message, silent \}\)/.test(electronMain) &&
  /noMemory: true/.test(electronMain));
check('主窗 / 小窗 onDone 均有 silent 与 noMemory 守卫',
  /!data\.silent/.test(chatWin) && /!data\.noMemory/.test(chatWin) &&
  /!data\.silent/.test(miniChat) && /!data\.noMemory/.test(miniChat));

// ---------- v3.0.1-beta.9 QA Round 2 N1：moveTop() 可见性守卫 + 启动期时序 ----------
// 花括号配对抽取函数体，避免命中文件里其它 isVisible()（单光标仲裁 / setHover 等）。
function extractFnBody(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return '';
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, k + 1);
    }
  }
  return '';
}
const zVisGuardOk = (src) => {
  const body = extractFnBody(src, 'export function reassertFloatingBallOnTop(');
  return (
    /!ballWindow\.isDestroyed\(\)\s*&&\s*ballWindow\.isVisible\(\)\)\s*ballWindow\.moveTop\(\)/.test(body) &&
    /!panelWindow\.isDestroyed\(\)\s*&&\s*panelWindow\.isVisible\(\)\)\s*panelWindow\.moveTop\(\)/.test(body) &&
    /!menuWindow\.isDestroyed\(\)\s*&&\s*menuWindow\.isVisible\(\)\)\s*menuWindow\.moveTop\(\)/.test(body)
  );
};
check('N1：三窗 moveTop() 均带 isVisible() 可见性守卫（隐藏窗口一律跳过）', zVisGuardOk(floatingBall));
// create 重申必须延后到球窗 ready-to-show 的 showInactive() 之后，且不得再位于 loadURL 之前的隐藏期。
const zCreateDeferredOk = (src) => {
  const c = src.indexOf("reassertFloatingBallOnTop('create')");
  const r = src.indexOf("ballWindow.once('ready-to-show'");
  const show = src.indexOf('ballWindow.showInactive()', r);
  const load = src.indexOf('ballWindow.loadURL');
  return r > 0 && load > 0 && c > r && show > r && c > show && c > load;
};
check("N1：create 重申延后到 ready-to-show 的 showInactive() 之后（不在 loadURL 之前的隐藏期）",
  zCreateDeferredOk(floatingBall));
// ball-show 从全屏 / 托盘恢复时，reassert 必须在 showInactive() 之后才不会空转。
const zBallShowBody = extractFnBody(floatingBall, 'export function showFloatingBall()');
check("N1：ball-show 重申位于 showFloatingBall() 内 showInactive() 之后（守卫下仍生效）",
  /ballWindow\.showInactive\(\)/.test(zBallShowBody) &&
  zBallShowBody.indexOf("reassertFloatingBallOnTop('ball-show')") > zBallShowBody.indexOf('ballWindow.showInactive()'));
check('N1：poll 重申前置门控球窗可见（守卫后该路径不会空转）',
  /if \(!ballWindow \|\| ballWindow\.isDestroyed\(\) \|\| !ballWindow\.isVisible\(\)\) return;/.test(floatingBall));
check('N1：注释写明 SWP_SHOWWINDOW / WS_VISIBLE / 状态机失同步来由（防后续误删守卫）',
  /SWP_SHOWWINDOW/.test(floatingBall) && /WS_VISIBLE/.test(floatingBall) &&
  /状态机/.test(floatingBall) && /请勿删除/.test(floatingBall));

// ============================================================================
section('B. 命中路由与交互（src/character/CharacterApp.tsx）');
// ============================================================================
check('命中区选择器含角色/气泡/菜单三类', /HIT_SELECTOR\s*=\s*'\.dc-character,\s*\.dc-bubble,\s*\.dc-menu'/.test(appTsx));
check('用 elementFromPoint + dcSetIgnore 动态切穿透', /document\.elementFromPoint/.test(appTsx) && /dcSetIgnore\(/.test(appTsx));
check('拖拽门槛 5px', /DRAG_THRESHOLD\s*=\s*5/.test(appTsx));
check('只有角色命中箱 pointerdown 才抓取（不监听全窗左键）',
  /onPointerDown=\{beginPointer\}/.test(appTsx) && !/window\.addEventListener\('pointerdown'/.test(appTsx));
check('单击先给反馈、绑定对话才跳转', /api\.dcOpenChat\(bound\)/.test(appTsx) && /boundChat/.test(appTsx));
check('点气泡不算点角色（只有 from===\'character\' 才跳转）',
  /from: 'character' \| 'bubble'/.test(appTsx) && /d\?\.from === 'character'\) onCharacterClick\(\)/.test(appTsx));
check('右键菜单 6 项齐备（锁定/置顶/绑定/舞台/管理/隐藏）',
  ['menuLockPass', 'menuOnTop', 'menuBind', 'menuStage', 'menuManage', 'menuHide'].every((k) => appTsx.includes(k)));
check('右键菜单色走主题变量（无硬编码十六进制）', !/#[0-9a-fA-F]{6}/.test(charCss.split('/* ===== 右键菜单')[1]?.split('/* 毛玻璃')[0] || ''));

// ============================================================================
section('C. 素材层（electron/characterAssets.ts）');
// ============================================================================
check('注册 nychar 私有协议', /registerSchemesAsPrivileged/.test(electronMain) && /scheme:\s*'nychar'/.test(electronMain));
check('协议特权含 supportFetchAPI + corsEnabled + standard',
  /scheme:\s*'nychar'[\s\S]{0,220}supportFetchAPI:\s*true[\s\S]{0,120}corsEnabled:\s*true/.test(electronMain));
check('协议回写 Access-Control-Allow-Origin', /Access-Control-Allow-Origin/.test(assets));
check('路径穿越防护（resolve + startsWith 前缀判断）',
  /path\.resolve\(root,\s*\.\.\.parts\)/.test(assets) && /startsWith\(root \+ path\.sep\)/.test(assets));
check('zip 解压前校验条目路径与总体积', /unsafe entry/.test(assets) && /MAX_PACKAGE_BYTES/.test(assets));
check('入口识别优先级 model3.json > vrm > glb > model.json > 图片',
  assets.indexOf("e === 'model3.json'") < assets.indexOf("e === 'vrm'") &&
  assets.indexOf("e === 'vrm'") < assets.indexOf("e === 'glb'") &&
  assets.indexOf("e === 'glb'") < assets.indexOf("e === 'model.json'") &&
  assets.indexOf("e === 'model.json'") < assets.indexOf('IMAGE_EXT.has'));
check('不使用系统原生文件对话框（走主题化 requestFilePick）',
  /requestFilePick\(/.test(assets) && !/dialog\.show(Open|Save)Dialog/.test(assets));
check('删除角色同时删除磁盘目录（id 形状白名单）', /dc_\[a-z0-9\]\+_\[a-z0-9\]\+/.test(assets) && /fs\.rmSync\(path\.join\(charactersRoot\(\), id\)/.test(assets));
check('运行库目录独立且不打包第三方运行时', /character-runtime/.test(assets) && !/live2dcubismcore\.min\.js['"]\s*,?\s*\)?\s*;?\s*\/\/\s*ship/.test(assets));

// ============================================================================
section('D. 渲染分发（ModelView / ThreeModelView / Live2DView）');
// ============================================================================
check('ModelView 分发 4 类渲染器', /kind === 'placeholder'/.test(modelView) && /kind === 'live2d'/.test(modelView) &&
  /kind === 'vrm' \|\| character\.kind === 'glb'/.test(modelView) && /dc-modelimg/.test(modelView));
check('素材 URL 走 nychar 且逐段编码', /nychar:\/\/model\//.test(modelView) && /encodeURIComponent/.test(modelView));
check('three 为动态 import（不进首屏 bundle）',
  /await import\('three'\)/.test(threeView) && !/^import .*from 'three'/.test(threeView));
check('GLTFLoader 动态 import', /await import\('three\/examples\/jsm\/loaders\/GLTFLoader\.js'\)/.test(threeView));
check('VRM 通过 @pixiv/three-vrm 动态加载并 rotateVRM0', /await import\('@pixiv\/three-vrm'\)/.test(threeView) && /rotateVRM0/.test(threeView));
check('3D 包围盒归一化并居中', /new THREE\.Box3\(\)\.setFromObject/.test(threeView) && /group\.scale\.setScalar/.test(threeView));
check('3D 卸载时释放几何/材质/渲染器', /geometry\?\.dispose/.test(threeView) && /renderer\?\.dispose/.test(threeView));
check('Live2D 按版本动态选 cubism4 / cubism2 入口',
  /pixi-live2d-display\/cubism4/.test(l2dView) && /pixi-live2d-display\/cubism2/.test(l2dView));
check('Live2D 运行时缺失先给原因（不白屏）', /missing-cubism4/.test(l2dView) && /dcRuntimeStatus\(\)/.test(l2dView));
check('Live2D 口型/眨眼用核心参数驱动', /ParamMouthOpenY/.test(l2dView) && /ParamEyeLOpen/.test(l2dView));
check('画布不吃指针事件（拖拽仍由外层接管）', /pointer-events:\s*none/.test(charCss));

// ============================================================================
section('E. 主界面接线');
// ============================================================================
check('侧边栏新增「捉宠角色」入口', /key: 'characters'/.test(sidebar) && /nav\.characters/.test(sidebar));
check('App 视图按需渲染 CharacterCollection（React.lazy + Suspense）',
  /lazy\(\(\) =>[\s\S]{0,200}CharacterCollection/.test(appRoot) &&
  /view === 'characters' && \(\s*<React\.Suspense/.test(appRoot));
check('App 处理角色窗导航（open-collection / open-chat）',
  /onDcOpenCollection/.test(appRoot) && /onDcOpenChat/.test(appRoot));
check('拖拽导入先问角色层认领（dcImportPaths）', /dcImportPaths\(paths\)/.test(appRoot));
check('设置页有桌面角色区块与索引条目', /id="sec-desktopcharacter"/.test(settings) && /id: 'sec-desktopcharacter'/.test(settings));
check('设置区块含启用/置顶/穿透锁定/管理/运行库五项',
  ['dcEnable', 'dcAlwaysOnTop', 'dcPassThrough', 'dcManage', 'dcRuntimeDir'].every((k) => settings.includes(k)));
check('面板/舞台样式已被主窗样式表 @import（否则面板裸样式）',
  /@import '\.\/character-panel\.css'/.test(read('src/styles/index.css')));
check('角色窗样式由角色入口引入', /styles\/character\.css/.test(charEntry));
check('面板支持导入文件/导入文件夹/删除/绑定/舞台',
  ['dcPickImport', 'dcDeleteCharacter', 'boundChat', 'CharacterStage'].every((k) => coll.includes(k)));
check('角色面板「显示」勾 = 该角色实际在桌面出现（受总开关「桌面显示」门控：关时为空且不可点）',
  /checked=\{\s*c\.enabled && snap\.runtime\.enabled\s*\}/.test(coll) &&
  /disabled=\{\s*!snap\.runtime\.enabled\s*\}/.test(coll));
check('舞台支持拖动旋转与滚轮缩放', /rotateY\(/.test(stage) && /onWheel/.test(stage) && /setZoom/.test(stage));
check('舞台用 AnalyserNode 驱动口型', /createAnalyser/.test(stage) && /getByteFrequencyData/.test(stage));
check('舞台 TTS 复用既有 api.textToSpeech', /api\.textToSpeech\(/.test(stage));
check('preload 暴露 6 个素材层方法',
  ['dcPickImport', 'dcImportPaths', 'dcDeleteCharacter', 'dcRuntimeDir', 'dcRuntimeStatus', 'dcOpenRuntimeDir'].every((k) => preload.includes(k)));
check('类型层新增 entry / CharacterImportResult', /entry\?: string/.test(types) && /interface CharacterImportResult/.test(types));

// ============================================================================
section('F. 动效三档受控');
// ============================================================================
check('AnimDocKind 含 character（第 5 个文档）', /'main' \| 'floating' \| 'notify' \| 'character'/.test(anim));
check("ANIM_GROUPS 登记 character 分组且带 docSelectors.character",
  /id: 'character'/.test(anim) && /character: \['\.dc-svg'/.test(anim));
check('角色窗走统一 applyAnimControl（不再手写 data-anim-off）',
  /applyAnimControl\(document, s, 'character'\)/.test(appTsx) && !/data-anim-off'\)/.test(appTsx));
check('character.css 覆盖 all-off 与自定义档两种选择器',
  /html\.anim-off \.dc-svg/.test(charCss) && /html\[data-anim-off~='character'\] \.dc-svg/.test(charCss));

// ============================================================================
section('G. i18n 10 处 + 可证伪性');
// ============================================================================
const KEYS = [
  'nav.characters', 'settings.desktopCharacter', 'settings.dcEnable', 'settings.dcPassThrough',
  'settings.soundThemeUser', 'characters.title', 'characters.importFile', 'characters.menuHide',
  'characters.errCubism4', 'characters.stageTitle', 'animCtl.groupCharacter',
];
for (const k of KEYS) {
  const n = (trans.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length;
  check(`translations.ts 含 ${k}（zh+en 共 2 处）`, n === 2, `实得 ${n}`);
}
for (const lang of ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']) {
  let json = {};
  try {
    json = JSON.parse(read(`src/i18n/locales/${lang}.json`));
  } catch {
    json = {};
  }
  const miss = KEYS.filter((k) => typeof json[k] !== 'string' || !json[k].trim());
  check(`locales/${lang}.json 含 11 个角色键且非空`, miss.length === 0, miss.join(','));
}

// 可证伪性：篡改源串后，对应断言必须变红
{
  const broken1 = windowLevels.replace(
    "DESKTOP_CHARACTER_LEVEL: AlwaysOnTopLevel = 'pop-up-menu'",
    "DESKTOP_CHARACTER_LEVEL: AlwaysOnTopLevel = 'screen-saver'"
  );
  check('（可证伪）把桌宠 level 抬回 screen-saver 后层级契约断言失效',
    !/DESKTOP_CHARACTER_LEVEL:\s*AlwaysOnTopLevel\s*=\s*'pop-up-menu'/.test(broken1));
  const broken2 = assets.replace('!abs.startsWith(root + path.sep)', 'true');
  check('（可证伪）去掉穿越判断后 C 段断言失效', !/startsWith\(root \+ path\.sep\)/.test(broken2));
  const broken3 = threeView.replace("await import('three')", "import * as three from 'three'");
  check('（可证伪）改成静态 import 后 D 段断言失效', !/await import\('three'\)/.test(broken3));
  // v3.0.1-beta.9 P0：变异后 A2 段「实现存在 / 路径覆盖」断言必须同时失效
  const brokenZ1 = floatingBall.replaceAll('.moveTop()', '/* stripped */');
  check('（可证伪）去掉 moveTop 后 Z 序兜底实现断言失效', !/ballWindow\.moveTop\(\)/.test(brokenZ1));
  const brokenZ2 = floatingBall.replace("reassertFloatingBallOnTop('poll')", '/* stripped */');
  check('（可证伪）删掉轮询路径调用后路径覆盖断言失效',
    !brokenZ2.includes("reassertFloatingBallOnTop('poll')"));
  const brokenZ3 = windowLevels.replace('不参与', '参与');
  check('（可证伪）抹掉「level 不参与 z_order」后平台注释断言失效', !zPlatformDocOk(brokenZ3));
  const brokenZ4 = windowLevels.replace(
    '**不要把本文件的 level 当作跨平台的 Z 序保证。**',
    '不同 level 由系统保证顺序，不再依赖创建顺序 / 焦点。'
  );
  check('（可证伪）写回「由系统保证顺序」旧表述后平台注释断言失效', !zPlatformDocOk(brokenZ4));
  // v3.0.1-beta.9 QA Round 2 N1：删掉守卫 / 把 create 挪回隐藏期，A2 段断言必须同时失效
  const brokenN1a = floatingBall.replace(' && ballWindow.isVisible()', '');
  check('（可证伪）删掉球窗 isVisible() 守卫后 N1 守卫断言失效', !zVisGuardOk(brokenN1a));
  const brokenN1b = floatingBall
    .replace("    reassertFloatingBallOnTop('create');\n    broadcastUnread();", '    broadcastUnread();')
    .replace('  startCursorPoll();', "  reassertFloatingBallOnTop('create');\n  startCursorPoll();");
  check('（可证伪）把 create 重申挪回 loadURL 之前后 N1 时序断言失效', !zCreateDeferredOk(brokenN1b));
}

// 可证伪性（v3.0.1-beta.13 多窗口）：变异源串后，A 段建窗契约 / A4 段多窗口断言必须变红
{
  // 回退到单例 dcWindow：A4「窗口集合为多窗口 Map」断言应失效
  const brokenMw1 = mainDc
    .replace('const dcWindows = new Map<string, BrowserWindow>();', 'let dcWindow: BrowserWindow | null = null;');
  check('（可证伪）回退到单例 dcWindow 后多窗口 Map 断言失效',
    !/const dcWindows = new Map<string, BrowserWindow>\(\)/.test(brokenMw1) && /let dcWindow/.test(brokenMw1));
  // createDesktopCharacter 去掉 id 形参：A4 签名断言失效
  const brokenMw2 = mainDc.replace('export function createDesktopCharacter(id: string)', 'export function createDesktopCharacter()');
  check('（可证伪）createDesktopCharacter 去掉 id 形参后签名断言失效',
    !/export function createDesktopCharacter\(id: string\)/.test(brokenMw2));
  // refreshDesktopCharacter 不再按 id 建窗：A 段建窗链 / A4 遍历断言失效
  const brokenMw3 = mainDc.replaceAll('createDesktopCharacter(c.id);', '/* no per-id create */');
  check('（可证伪）refresh 不再逐一建窗后建窗链断言失效',
    !/export function refreshDesktopCharacter\(\)[\s\S]{0,700}createDesktopCharacter\(c\.id\)/.test(brokenMw3) &&
    !/export function showAllDesktopCharacters\(\)[\s\S]{0,300}createDesktopCharacter\(c\.id\)/.test(brokenMw3));
  // hideActiveCharacter 改成关全部窗口：A4「仅关闭一个窗口」断言失效
  const brokenMw4 = mainDc.replaceAll('destroyDesktopCharacter(id);', 'destroyDesktopCharacter();');
  check('（可证伪）hideActiveCharacter 改成关全部窗口后单窗销毁断言失效',
    !/destroyDesktopCharacter\(id\)/.test(brokenMw4));
  // sendState 不再遍历 dcWindows：A4 遍历断言失效
  const brokenMw5 = mainDc.replaceAll('for (const [cid, w] of dcWindows)', '/* single window */');
  check('（可证伪）sendState 不再遍历 dcWindows 后遍历断言失效',
    !/for \(const \[cid, w\] of dcWindows\)/.test(brokenMw5));
  // 删除 dc-ready Z 序重申：A2 路径覆盖断言失效
  const brokenMw6 = mainDc.replace("reassertFloatingBallOnTop('dc-ready')", '/* stripped */');
  check('（可证伪）删除 dc-ready Z 序重申后 A2 路径覆盖断言失效',
    !brokenMw6.includes("reassertFloatingBallOnTop('dc-ready')"));
  // setDesktopCharacterEnabled 不再建窗：A 段主开关建窗断言失效
  const brokenMw7 = mainDc.replace('showAllDesktopCharacters();', '/* no create */');
  check('（可证伪）setDesktopCharacterEnabled 不再建窗后 A 段断言失效',
    !/export function setDesktopCharacterEnabled\(v: boolean\)[\s\S]{0,600}showAllDesktopCharacters\(\)/.test(brokenMw7));
}

// ============================================================================
section('G2. 置顶人物说明文案与三层层级契约一致（10 处 value，QA Round 1 尾审补漏）');
// ============================================================================
// Bug 1 把桌宠从「与悬浮球同层 screen-saver」降到 pop-up-menu，Windows 另加 moveTop 兜底。
// 但 settings.dcAlwaysOnTopDesc 是「置顶人物」开关上用户可见的 Hint（Settings.tsx），
// 曾仍写「与悬浮球同级」，与修复后的行为直接矛盾。此处锁死 10 处文案都表达「悬浮球之下」，
// 且不含任何「同级 / same level」旧措辞，防止改 level 时漏改用户可见文案。
const AOT_DESC_KEY = 'settings.dcAlwaysOnTopDesc';
const aotDescValues = [];
const transAotRe = new RegExp(`'${AOT_DESC_KEY.replace('.', '\\.')}':\\s*'([^']*)'`, 'g');
let aotMatch;
while ((aotMatch = transAotRe.exec(trans)) !== null) {
  aotDescValues.push(['translations.ts', aotMatch[1]]);
}
for (const lang of ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']) {
  let value = '';
  try {
    value = JSON.parse(read(`src/i18n/locales/${lang}.json`))[AOT_DESC_KEY] || '';
  } catch {
    value = '';
  }
  aotDescValues.push([`locales/${lang}.json`, value]);
}
check('settings.dcAlwaysOnTopDesc 在 10 处齐全且非空',
  aotDescValues.length === 10 && aotDescValues.every(([, v]) => typeof v === 'string' && v.trim().length > 0),
  `实得 ${aotDescValues.length} 处`);
// 10 种语言里「与悬浮球同级」的旧措辞（可证伪：任一处回归即红）
const STALE_SAME_LEVEL = /同级|同級|same level|mismo nivel|même niveau|gleiche ebene|mesmo nível|тот же уровень|同じ階層|같은 층/i;
check('10 处置顶说明均不再宣称「与悬浮球同级」（旧契约清零）',
  aotDescValues.every(([, v]) => !STALE_SAME_LEVEL.test(v)),
  aotDescValues.filter(([, v]) => STALE_SAME_LEVEL.test(v)).map(([f]) => f).join(','));
check('zh 写明「悬浮球之下」、en 写明「below the floating ball」（与新层级一致）',
  /悬浮球之下/.test(trans) && /below the floating ball/i.test(trans));
check('（可证伪）某处置顶说明写回「同级」后旧契约断言失效',
  !aotDescValues.map(([f, v], i) => (i === 0 ? '与悬浮球同级，始终浮在其它窗口之上。' : v))
    .every((v) => !STALE_SAME_LEVEL.test(v)));

// ============================================================================
section('H. 合规：无第三方品牌资产与「复刻」措辞');
// ============================================================================
const NEW_FILES = [
  'electron/desktopCharacter.ts', 'electron/characterAssets.ts', 'src/character/CharacterApp.tsx',
  'src/character/ModelView.tsx', 'src/character/ThreeModelView.tsx', 'src/character/Live2DView.tsx',
  'src/character/PlaceholderCharacter.tsx', 'src/character/behaviors.ts',
  'src/components/CharacterCollection.tsx', 'src/components/CharacterStage.tsx',
  'src/styles/character.css', 'src/styles/character-panel.css',
  'electron/windowLevels.ts',
];
const DENY_BRAND = ['shimeji', 'shizuku', '伪春菜', '桌宠模拟器', '桌面宠物大师', 'desktop goose', 'goosegoose'];
const DENY_WORD = ['模仿', '仿制', '复刻', '照搬', '复现某'];
for (const f of NEW_FILES) {
  const c = read(f);
  const hitB = DENY_BRAND.find((w) => c.toLowerCase().includes(w.toLowerCase()));
  const hitW = DENY_WORD.find((w) => c.includes(w));
  check(`${path.basename(f)} 无第三方品牌名/复刻措辞`, !hitB && !hitW, `${hitB || ''}${hitW || ''}`);
}
check('默认角色为原创几何绘制（无外链图片/模型）',
  /<svg/.test(read('src/character/PlaceholderCharacter.tsx')) && !/https?:\/\//.test(read('src/character/PlaceholderCharacter.tsx')));
check('软件不打包第三方 Live2D 运行时（public 下无 cubism core）',
  !fs.existsSync(path.join(ROOT, 'public/live2d')) && !fs.existsSync(path.join(ROOT, 'public/character-runtime')));

// ============================================================================
section('A3. 隐藏角色与「显示」勾同步（v3.0.1-beta.12）');
// ============================================================================
// 根因：右键菜单「隐藏角色」原来只 dcWindow.hide() 整个窗口，从不改 enabled，
// 导致「桌宠角色」面板里该角色的「显示」勾保持不变。修复：新增 dc:hide-character，
// 隐藏时把当前激活角色的 enabled 置 false，使面板「显示」勾同步取消；
// 主开关 runtime.enabled（桌面显示）不动，仅改单角色 enabled 与 activeId。
check('新增 hideActiveCharacter 函数（隐藏角色时关闭当前角色桌面显示，可收 sender）',
  /export function hideActiveCharacter\(/.test(mainDc));
check('hideActiveCharacter 核心：把当前角色 enabled 置 false',
  /export function hideActiveCharacter\([\s\S]{0,1700}enabled:\s*false/.test(mainDc));
check('dc:hide-character IPC 已注册且把 sender 转交 hideActiveCharacter',
  /ipcMain\.on\('dc:hide-character',\s*\(e\)\s*=>\s*hideActiveCharacter\(e\.sender\)\)/.test(mainDc));
check('「隐藏角色」只改单角色 enabled、不动主开关 runtime.enabled（且不调 setDesktopCharacterEnabled）',
  /export function hideActiveCharacter\([\s\S]{0,1700}desktopCharacters: next/.test(mainDc) &&
  !/setDesktopCharacterEnabled/.test(
    mainDc.slice(
      mainDc.indexOf('export function hideActiveCharacter('),
      mainDc.indexOf('export function hideActiveCharacter(') + 1700,
    ),
  ) &&
  !/patchRuntime\(\{ enabled:/.test(
    mainDc.slice(
      mainDc.indexOf('export function hideActiveCharacter('),
      mainDc.indexOf('export function hideActiveCharacter(') + 1700,
    ),
  ));
check('CharacterApp 菜单 menuHide 调用 api.dcHideCharacter(charId)（而非仅 hide 窗口）',
  /menuHide[\s\S]{0,160}api\.dcHideCharacter\(charId\)/.test(appTsx));
check('preload 暴露 dcHideCharacter 通道（指向 dc:hide-character，带 id）',
  /dcHideCharacter:\s*\(id[^)]*\)\s*=>\s*ipcRenderer\.send\('dc:hide-character',\s*id\)/.test(preload));
check('src/ipc.ts 暴露 dcHideCharacter 通道（透传 id）',
  /dcHideCharacter:\s*\(id[^)]*\)\s*=>\s*raw\.dcHideCharacter\(id\)/.test(ipcTs));

// ============================================================================
section('A4. 多窗口同显（v3.0.1-beta.13 架构重构）');
// ============================================================================
// 旧版是单例 `let dcWindow`，只显示 activeCharacter() 那一个角色；现改为每个 enabled
// 角色各拥独立窗口（Map<id, BrowserWindow>），可同时出现。以下锁死多窗口核心契约：
// 集合类型、按 id 建窗入口、refresh 遍历建窗、hide 只关单窗、state/cursor 按窗遍历、身份反查。
check('窗口集合为多窗口 Map（dcWindows = Map<id, BrowserWindow>）',
  /const dcWindows = new Map<string, BrowserWindow>\(\)/.test(mainDc));
check('已无单例残留（无 let dcWindow 全局单例）', !/\blet dcWindow\b/.test(mainDc));
check('createDesktopCharacter 按 id 建窗（多窗口入口，签名带 id）',
  /export function createDesktopCharacter\(id: string\)/.test(mainDc));
check('refreshDesktopCharacter 按 enabled 遍历逐一建窗（勾=建窗、空=关窗）',
  /export function refreshDesktopCharacter\(\)[\s\S]{0,700}createDesktopCharacter\(c\.id\)/.test(mainDc));
check('showAllDesktopCharacters 为每个 enabled 角色建窗（已存在则跳过）',
  /export function showAllDesktopCharacters\(\)[\s\S]{0,300}createDesktopCharacter\(c\.id\)/.test(mainDc));
check('hideActiveCharacter 仅关闭一个窗口（destroyDesktopCharacter(id)，不调无参全关）',
  /export function hideActiveCharacter\([\s\S]{0,2200}destroyDesktopCharacter\(id\)/.test(mainDc) &&
  !/destroyDesktopCharacter\(\);/.test(
    mainDc.slice(
      mainDc.indexOf('export function hideActiveCharacter('),
      mainDc.indexOf('export function hideActiveCharacter(') + 2200,
    ),
  ));
check('sendState 按窗口遍历各发各自角色（非单窗广播）',
  /function sendState\(id\?/.test(mainDc) &&
  /for \(const \[cid, w\] of dcWindows\)/.test(mainDc));
check('startCursorBroadcast 按窗口遍历推光标（多窗口眼神跟随）',
  /function startCursorBroadcast\(\)/.test(mainDc) &&
  /for \(const \[, w\] of dcWindows\)/.test(mainDc));
check('窗口对象挂 _charId 以便从 IPC sender 反查角色',
  /\(win as unknown as \{ _charId: string \}\)\._charId = id/.test(mainDc));
check('winToId 用 BrowserWindow.fromWebContents 反查归属角色',
  /function winToId\(sender: unknown\)/.test(mainDc) &&
  /BrowserWindow\.fromWebContents\(sender as/.test(mainDc));
check('每角色独立拖拽状态（dragStates = Map<id, DragState>）且单一全局 60Hz 定时器驱动',
  /const dragStates = new Map<string, DragState>\(\)/.test(mainDc) &&
  /function dragTick\(\)/.test(mainDc) &&
  /for \(const \[id, st\] of dragStates\)/.test(mainDc));
check('级联偏移常量存在（多角色避免完全重叠）', /CASCADE_OFFSET\s*=\s*28/.test(mainDc));

// ============================================================================
section('A5. 桌宠 4 bug 修复（菜单响应 / 拖拽贴边 / 拖动收尾 / Z 序动画）');
// ============================================================================
// Bug 1：右键菜单「绑定 / 舞台 / 管理」点击无反应。真因是 onMove 在光标掠过角色→菜单间透明
// 缝隙时 applyInteractive(false)+setMenuOpen(false)，窗口变穿透后收不到 mousemove、菜单被卸载。
check('Bug1 菜单打开期间 onMove 不关闭菜单（menuOpenRef 分支不调 setMenuOpen(false)）',
  /if \(menuOpenRef\.current\) \{[\s\S]{0,240}applyInteractive\(true\);[\s\S]{0,60}return;/.test(appTsx) &&
  !/if \(!hit && menuOpenRef\.current\) setMenuOpen\(false\)/.test(appTsx));
check('Bug1 菜单关闭走显式 outside-pointerdown + Escape（捕获期监听）',
  /document\.addEventListener\('pointerdown',\s*onOutsideDown,\s*true\)/.test(appTsx) &&
  /window\.addEventListener\('keydown',\s*onKey\)/.test(appTsx) &&
  /e\.key === 'Escape'/.test(appTsx));
check('Bug1 舞台入口走带 id 的 dcOpenStage（真正打开该角色 CharacterStage，非仅面板）',
  /key: 'stage'[\s\S]{0,140}api\.dcOpenStage\(/.test(appTsx) &&
  /dcOpenStage:\s*\(id[^)]*\)\s*=>\s*ipcRenderer\.send\('dc:open-stage',\s*id\)/.test(preload) &&
  /ipcMain\.on\('dc:open-stage'/.test(mainDc) &&
  /webContents\.send\('dc:open-stage'/.test(mainDc));
check('Bug1 主窗接 dc:open-stage → 切角色面板 + 带 nonce 舞台请求；面板按 id 打开 stageChar',
  /api\.onDcOpenStage\(/.test(appRoot) &&
  /setDcStageRequest\(\{ id, nonce: Date\.now\(\) \}\)/.test(appRoot) &&
  /stageRequest=\{dcStageRequest\}/.test(appRoot) &&
  /snap\.characters\.find\(\(x\) => x\.id === (id|stageRequest\.id)\)/.test(coll) &&
  /setStageChar\(c\)/.test(coll));
check('Bug1 绑定/管理两条路径仍在（bound→dcOpenChat，unbound→dcOpenCollection）',
  /if \(bound\) api\.dcOpenChat\(bound\);\s*else api\.dcOpenCollection\(\)/.test(appTsx));

// Bug 2：拖不到上半部 + 贴不到左边沿。真因是 clampPos 按整窗 340×420 矩形钳制。
check('Bug2 clampPos 按角色可见区（CHAR_BODY_W/H + scale）钳制，允许透明窗越出 workArea',
  /function clampPos\(x: number, y: number, id\?: string\)/.test(mainDc) &&
  /CHAR_BODY_W\s*=\s*190/.test(mainDc) && /CHAR_BODY_H\s*=\s*228/.test(mainDc) &&
  /const halfW = \(CHAR_BODY_W \* scale\) \/ 2/.test(mainDc) &&
  /const minX = wa\.x - \(centerX - halfW\)/.test(mainDc) &&
  /const minY = wa\.y - \(bodyBottom - bodyH\)/.test(mainDc));
check('Bug2 clampPos 传入角色 id（创建/移动/弹簧/惯性/重定位全部带 id，用各自 scale）',
  /clampPos\(avoided\.x, avoided\.y, id\)/.test(mainDc) &&
  /clampPos\(b\.x, b\.y, id\)/.test(mainDc) &&
  /clampPos\(st\.curX, st\.curY, id\)/.test(mainDc) &&
  /clampPos\(nx, ny, id\)/.test(mainDc) &&
  /clampPos\(Number\(x\) \|\| 0, Number\(y\) \|\| 0, id\)/.test(mainDc));
check('Bug2 保留 avoidBall 悬浮球避让且 clamp 在其后（不冲突）',
  /const avoided = avoidBall\(x, y\);[\s\S]{0,80}clampPos\(avoided\.x, avoided\.y, id\)/.test(mainDc));

// Bug 3：偶发松开仍处拖动状态。renderer window 级兜底 + 主进程看门狗。
check('Bug3 renderer pointer capture 设在 currentTarget（稳定元素，非 e.target）',
  /\(e\.currentTarget as HTMLElement\)\.setPointerCapture\?\.\(e\.pointerId\)/.test(appTsx));
check('Bug3 window 级 pointerup/pointercancel/blur 兜底发 dc:drag-end',
  /window\.addEventListener\('pointerup',\s*forceEnd\)/.test(appTsx) &&
  /window\.addEventListener\('pointercancel',\s*forceEnd\)/.test(appTsx) &&
  /window\.addEventListener\('blur',\s*forceEnd\)/.test(appTsx) &&
  /dragRef\.current = null;[\s\S]{0,120}api\.dcDragEnd\(\)/.test(appTsx));
check('Bug3 主进程看门狗：drag-start 起算 + 超时强制 endDragState + 幂等收尾',
  /DRAG_WATCHDOG_MS\s*=\s*9000/.test(mainDc) &&
  /st\.dragStartedAt = Date\.now\(\)/.test(mainDc) &&
  /now - st\.dragStartedAt >= DRAG_WATCHDOG_MS/.test(mainDc) &&
  /function endDragState\(id: string\): void \{[\s\S]{0,120}if \(!st \|\| !st\.dragging\) return;/.test(mainDc) &&
  /ipcMain\.on\('dc:drag-end'[\s\S]{0,180}endDragState\(id\)/.test(mainDc));

// Bug 4：面板展开动画期间被桌宠盖住。showInactive 后立即重申 Z 序。
check('Bug4 expandPanel 在 showInactive 之后立即 reassertFloatingBallOnTop(panel-expand)',
  /panelWindow\.showInactive\(\);[\s\S]{0,320}reassertFloatingBallOnTop\('panel-expand'\)/.test(floatingBall));
check('Bug4 undoCollapse 重播动画路径同样立即重申 Z 序',
  /function undoCollapse\(\)[\s\S]{0,600}panelWindow\.webContents\.send\('panel:show'[\s\S]{0,400}reassertFloatingBallOnTop\('panel-expand'\)/.test(floatingBall));
check('Bug4 未触碰单光标仲裁链（owner/covered 判定与 cursor-gate 门控保持）',
  /function computeCoveredStateNow/.test(floatingBall) &&
  /onMainCursorWindow/.test(appRoot) && /onMiniCursorWindow/.test(miniChat));

// P2-1：历史 boundChat.name 为空/缺失/undefined 时，右键菜单显示 chat id 兜底，不出现「回到「」/undefined」
check('P2-1 状态同步两处（dcGetState / onDcState）用 normalizeBoundChat 规范化 boundChat.name',
  /function normalizeBoundChat\(/.test(appTsx) &&
  /boundChat:\s*\{\s*\.\.\.b,\s*name:\s*b\.id\s*\}/.test(appTsx) &&
  /character:\s*normalizeBoundChat\(s\.character \|\| s\.active\)/.test(appTsx) &&
  // onDcState 路径：仍然对 d.character 做规范化（实现上先存变量 c 再写入 state）
  /normalizeBoundChat\(d\.character\)/.test(appTsx) &&
  /character:\s*c\b/.test(appTsx));
check('P2-1 右键菜单 label 显示层以 bound.name || bound.id 双保险兜底',
  /t\('characters\.menuBackTo',\s*\{\s*name:\s*bound\.name \|\| bound\.id\s*\}\)/.test(appTsx));

// P2-2：看门狗按「光标物理位移」心跳，正常长按 ≥9s 不被误伤；只有光标静止才累计超时
check('P2-2 DragState 含 watchdogCursorX/Y 心跳字段（声明 + 初始化 + 收尾清理）',
  /watchdogCursorX:\s*number/.test(mainDc) && /watchdogCursorY:\s*number/.test(mainDc) &&
  /watchdogCursorX:\s*0/.test(mainDc) && /watchdogCursorY:\s*0/.test(mainDc));
check('P2-2 drag-start 初始化心跳基线为当时物理光标位置',
  /const cur = screen\.getCursorScreenPoint\(\);[\s\S]{0,120}st\.watchdogCursorX = cur\.x[\s\S]{0,120}st\.watchdogCursorY = cur\.y/.test(mainDc));
check('P2-2 看门狗轮询采样光标位移：动则刷新 dragStartedAt + 采样并 continue，静则累计超时',
  /const p = screen\.getCursorScreenPoint\(\);/.test(mainDc) &&
  /p\.x !== st\.watchdogCursorX \|\| p\.y !== st\.watchdogCursorY/.test(mainDc) &&
  /st\.dragStartedAt = now;/.test(mainDc) &&
  /p\.x !== st\.watchdogCursorX \|\| p\.y !== st\.watchdogCursorY[\s\S]{0,200}st\.dragStartedAt = now;[\s\S]{0,80}continue;/.test(mainDc));
check('P2-2 心跳只在看门狗内刷新；springStep 绝不刷新 dragStartedAt（否则 pointerup 丢失后永不兜底）',
  !/dragStartedAt/.test(extractFnBody(mainDc, 'function springStep(')) &&
  /st\.dragStartedAt = 0;\s*st\.watchdogCursorX = 0;\s*st\.watchdogCursorY = 0;/.test(mainDc));

// 可证伪：把 4 项修复各自回退，对应断言必须变红
{
  const b1 = appTsx.replace(/if \(menuOpenRef\.current\) \{[\s\S]{0,120}return;\s*\}/, '');
  check('（可证伪）回退菜单打开守卫后 Bug1 断言失效',
    !/if \(menuOpenRef\.current\) \{[\s\S]{0,240}applyInteractive\(true\);[\s\S]{0,60}return;/.test(b1));
  const b2 = mainDc.replace('const minY = wa.y - (bodyBottom - bodyH);', 'const minY = wa.y;');
  check('（可证伪）回退整窗钳制后 Bug2 断言失效',
    !/const minY = wa\.y - \(bodyBottom - bodyH\)/.test(b2));
  const b3 = mainDc.replace('now - st.dragStartedAt >= DRAG_WATCHDOG_MS', 'false');
  check('（可证伪）去掉看门狗超时后 Bug3 断言失效',
    !/now - st\.dragStartedAt >= DRAG_WATCHDOG_MS/.test(b3));
  const b4 = floatingBall.replaceAll("reassertFloatingBallOnTop('panel-expand')", '/* stripped */');
  check('（可证伪）删掉 panel-expand 重申后 Bug4 断言失效',
    !b4.includes("reassertFloatingBallOnTop('panel-expand')"));
  const bP21 = appTsx.replace('name: bound.name || bound.id', 'name: bound.name');
  check('（可证伪）回退右键 label 的 id 兜底后 P2-1 断言失效',
    !/name:\s*bound\.name \|\| bound\.id/.test(bP21));
  const bP22 = mainDc.replace('p.x !== st.watchdogCursorX || p.y !== st.watchdogCursorY', 'false');
  check('（可证伪）回退看门狗光标位移心跳后 P2-2 断言失效',
    !/p\.x !== st\.watchdogCursorX \|\| p\.y !== st\.watchdogCursorY/.test(bP22));
}

// ============================================================================
section('I. 本轮 5 项修复 + 2 项增量（每项均可证伪）');
// ============================================================================

// I1：主窗关闭后右键三项无反应 —— 注入 showMainWindow 重建，并在新 renderer 加载完成后补发 IPC
check('I1 注入主窗唤出器：desktopCharacter 导出 setCharacterMainShow，main.ts 用 showMainWindow 注入并刷新引用',
  /export function setCharacterMainShow\(fn: \(\) => void\)/.test(mainDc) &&
  /setCharacterMainShow\(\(\) => \{[\s\S]{0,200}showMainWindow\(\);[\s\S]{0,120}setCharacterMainWindow\(mainWindow\);/.test(electronMain));
check('I1 三条右键导航统一走 withMainWindow（主窗销毁不再直接 return）',
  !/if \(!mainWindowRef \|\| mainWindowRef\.isDestroyed\(\)\) return;/.test(mainDc) &&
  /withMainWindow\(\(win\) => win\.webContents\.send\('dc:open-chat', chat\)\)/.test(mainDc) &&
  /withMainWindow\(\(win\) => win\.webContents\.send\('dc:open-collection'\)\)/.test(mainDc) &&
  /withMainWindow\(\(win\) => win\.webContents\.send\('dc:open-stage', String\(id \|\| ''\)\)\)/.test(mainDc));
check('I1 重建后补发延后到新 webContents 加载完成（否则 IPC 落在空文档上）',
  /mainShowRef\(\);/.test(mainDc) &&
  /target\.webContents\.isLoadingMainFrame\(\)/.test(mainDc) &&
  /target\.webContents\.once\('did-finish-load', send\)/.test(mainDc));

// I2：管理角色落点 —— 进入角色面板前清舞台请求，避免残留 nonce 把面板再次弹到舞台
check('I2 管理角色先清舞台请求再进角色面板；舞台路径仍带 nonce',
  /api\.onDcOpenCollection\(\(\) => \{[\s\S]{0,120}setDcStageRequest\(null\);[\s\S]{0,80}setView\('characters'\);/.test(appRoot) &&
  /api\.onDcOpenStage\(\(id\) => \{[\s\S]{0,120}setDcStageRequest\(\{ id, nonce: Date\.now\(\) \}\)/.test(appRoot));

// I3：滚轮缩放 —— 真因是 --dc-scale 写在子元素上不会向上继承，父元素 transform 永远取默认 1
check('I3 缩放变量写在 .dc-character 自身（父元素 transform 才消费它），不在 .dc-stage 上',
  /className=\{`dc-character\$\{dragging \? ' dragging' : ''\}`\}[\s\S]{0,200}--dc-scale/.test(appTsx) &&
  !/className="dc-stage"[^>]*--dc-scale/.test(appTsx) &&
  /transform: translateX\(-50%\) scale\(var\(--dc-scale, 1\)\)/.test(charCss));
check('I3 滚轮链路完整：onWheel + 0.6~2.0 钳制 + dcSetScale 持久化 + 原生 passive:false 阻止滚动',
  /onWheel=\{onCharacterWheel\}/.test(appTsx) &&
  /Math\.max\(0\.6, Math\.min\(2\.0, Math\.round\(\(cur \+ step\) \* 100\) \/ 100\)\)/.test(appTsx) &&
  /api\.dcSetScale\(c\.id, next\)/.test(appTsx) &&
  /addEventListener\('wheel',[\s\S]{0,200}\{ passive: false \}\)/.test(appTsx));

// I4：桌宠头顶气泡（.dc-bubble）—— 绑定会话 proactive 消息 → showBubble → 线性弹入动画
// v3.0.3：时长不再写死 0.18s，改为「设置基准秒数 × --anim-speed」（可细调 + 受速度倍率影响）。
check('I4 气泡弹入改为 linear 且仍受 character 动画组 all-off / custom 双门控',
  /animation:\s*dcBubbleIn\s+calc\(var\(--dc-bubble-anim,\s*0\.18s\)\s*\*\s*var\(--anim-speed,\s*1\)\)\s*linear/.test(charCss) &&
  !/dcBubbleIn 0\.18s ease/.test(charCss) &&
  /html\.anim-off \.dc-bubble/.test(charCss) &&
  /html\[data-anim-off~='character'\] \.dc-bubble/.test(charCss));
check('I4 绑定会话有消息走 proactive → showBubble → .dc-bubble 链路',
  /api\.proactive\(\{[\s\S]{0,160}source: 'character'/.test(appTsx) &&
  /showBubble\(text\)/.test(appTsx) &&
  /className=\{`dc-bubble\$\{bubbleClosing \? ' closing' : ''\}`\}/.test(appTsx));

// I5：右键菜单弹入 + 收回，均 linear；三档开关关掉时立即卸载
// v3.0.3：0.14s → 0.20s（用户拍板：默认时长上调 + 幅度加 scale 0.96→1），且改为变量化。
check('I5 菜单弹入/收回均为 linear（dcMenuOut + .dc-menu.closing，仍受 character 组门控）',
  /animation:\s*dcMenuIn\s+calc\(var\(--dc-menu-anim,\s*0\.20s\)\s*\*\s*var\(--anim-speed,\s*1\)\)\s*linear/.test(charCss) &&
  /\.dc-menu\.closing \{[\s\S]{0,240}animation:\s*dcMenuOut\s+calc\(var\(--dc-menu-anim,\s*0\.20s\)[^}]*linear forwards/.test(charCss) &&
  /@keyframes dcMenuOut/.test(charCss) &&
  /html\[data-anim-off~='character'\] \.dc-menu/.test(charCss));
check('I5 三条关闭路径统一 closeMenu：延迟卸载 + 动画被关立即卸载（setTimeout 兜底）',
  /const closeMenu = useCallback/.test(appTsx) &&
  /root\.classList\.contains\('anim-off'\)/.test(appTsx) &&
  /includes\('character'\)/.test(appTsx) &&
  /menuAnimMs\(/.test(appTsx) &&
  /setTimeout\(\(\) => \{[\s\S]{0,240}setMenuOpen\(false\)[\s\S]{0,160}menuAnimMs\(/.test(appTsx) &&
  /if \(e\.key === 'Escape'\) closeMenu\(\)/.test(appTsx) &&
  /className=\{`dc-menu\$\{menuClosing \? ' closing' : ''\}`\}/.test(appTsx));

// I6：角色舞台滑块（新增一个 i18n key，10 处齐全）
check('I6 舞台新增模型大小滑块（range + 共用阈值常量 + applyZoom + i18n 10 处齐全）',
  /type="range"/.test(stage) &&
  /min=\{STAGE_ZOOM_MIN\}/.test(stage) && /max=\{STAGE_ZOOM_MAX\}/.test(stage) && /step=\{STAGE_ZOOM_STEP\}/.test(stage) &&
  /onChange=\{\(e\) => applyZoom\(Number\(e\.target\.value\)\)\}/.test(stage) &&
  /t\('characters\.stageZoom'\)/.test(stage) &&
  /'characters\.stageZoom': '模型大小'/.test(trans) &&
  /'characters\.stageZoom': 'Model size'/.test(trans) &&
  localeStageZoom.length === 8 && localeStageZoom.every((v) => typeof v === 'string' && v.length > 0));
// I7：其它菜单项通道完整性（lock / aot / chat / stage / manage / hide）
check('I7 六项菜单 IPC 通道齐全且隐藏角色走 sender 归属（不多关其它角色）',
  ["key: 'lock'", "key: 'aot'", "key: 'chat'", "key: 'stage'", "key: 'manage'", "key: 'hide'"].every((k) => appTsx.includes(k)) &&
  /api\.dcSetPassThroughLock\(/.test(appTsx) && /api\.dcSetAlwaysOnTop\(/.test(appTsx) && /api\.dcHideCharacter\(charId\)/.test(appTsx) &&
  /ipcMain\.on\('dc:set-pass-through-lock'/.test(mainDc) &&
  /ipcMain\.on\('dc:set-always-on-top'/.test(mainDc) &&
  /ipcMain\.on\('dc:hide-character',\s*\(e\)\s*=>\s*hideActiveCharacter\(e\.sender\)\)/.test(mainDc));

// 可证伪：把每项实现回退，对应断言必须变红
{
  const m1 = mainDc.replace('    mainShowRef();', '    /* stripped */');
  check('（可证伪）删掉主窗重建调用后 I1 断言失效', !/mainShowRef\(\);/.test(m1));
  const m1b = mainDc.replace("target.webContents.once('did-finish-load', send)", 'send()');
  check('（可证伪）去掉 did-finish-load 延迟投递后 I1 断言失效',
    !/target\.webContents\.once\('did-finish-load', send\)/.test(m1b));

  const m2 = appRoot.replace(/setDcStageRequest\(null\);/, '');
  check('（可证伪）删掉舞台请求清理后 I2 断言失效',
    !/api\.onDcOpenCollection\(\(\) => \{[\s\S]{0,120}setDcStageRequest\(null\)/.test(m2));

  const m3 = appTsx.replace(/className=\{`dc-character\$\{dragging \? ' dragging' : ''\}`\}[\s\S]{0,200}--dc-scale/,
    "className=\"dc-character\"");
  check('（可证伪）把 --dc-scale 挪回子元素后 I3 断言失效',
    !/className=\{`dc-character\$\{dragging \? ' dragging' : ''\}`\}[\s\S]{0,200}--dc-scale/.test(m3));

  const m4 = charCss.replace('animation: dcBubbleIn 0.18s linear', 'animation: dcBubbleIn 0.18s ease');
  check('（可证伪）气泡动画改回 ease 后 I4 断言失效', !/animation: dcBubbleIn 0\.18s linear/.test(m4));

  const m5 = charCss.replace('animation: dcMenuOut 0.14s linear forwards', '/* stripped */');
  check('（可证伪）删掉菜单收回动画后 I5 断言失效', !/\.dc-menu\.closing \{[\s\S]{0,200}animation: dcMenuOut 0\.14s linear forwards/.test(m5));
  const m5b = appTsx.replace("if (e.key === 'Escape') closeMenu();", "if (e.key === 'Escape') setMenuOpen(false);");
  check('（可证伪）Escape 不走统一收尾后 I5 断言失效', !/if \(e\.key === 'Escape'\) closeMenu\(\)/.test(m5b));

  const m6 = stage.replace('type="range"', 'type="text"');
  check('（可证伪）去掉舞台滑块后 I6 断言失效', !/type="range"/.test(m6));

  const m7 = mainDc.replace("ipcMain.on('dc:hide-character', (e) => hideActiveCharacter(e.sender));", '/* stripped */');
  check('（可证伪）删掉隐藏角色 IPC 后 I7 断言失效',
    !/ipcMain\.on\('dc:hide-character',\s*\(e\)\s*=>\s*hideActiveCharacter\(e\.sender\)\)/.test(m7));
}

// ============================================================================
section('J. QA 复检发现的 2 个 P2 + 新增「新消息实时弹气泡」（每项均可证伪）');
// ============================================================================

// J1（P2-1）：从角色舞台直接点「管理角色」时，舞台必须关闭、落到角色面板。
// 根因：App 只清了 dcStageRequest（prop），面板内部已 set 的 stageChar 未清，
// 面板不重挂载 → CharacterStage 继续盖在面板上，表现为「管理角色却停在舞台」。
check('J1 舞台请求被撤销时同步关闭已打开的 CharacterStage（否则「管理角色」停在舞台）',
  /if \(!stageRequest \|\| !stageRequest\.id\) \{[\s\S]{0,240}setStageChar\(null\);/.test(coll));
check('J1 关闭舞台不破坏既有 nonce 去重与异步重试逻辑',
  /stageRequest\.nonce !== lastStageNonceRef\.current/.test(coll) &&
  /lastStageNonceRef\.current = stageRequest\?\.nonce/.test(coll) &&
  /pendingStageIdRef/.test(coll));
// v3.0.4 P1：舞台拖动缩放时窗口突然消失 —— 缩放广播触发 refresh 后误跑关闭分支。
// 修法：关闭只依赖 stageRequest，打开由 pendingStageIdRef 承接，且关闭分支不得依赖 snap.characters。
check('v3.0.4 舞台开关 effect 已拆分：关闭只认 stageRequest，不被 snap.characters 碰动',
  /if \(!stageRequest \|\| !stageRequest\.id\) \{[\s\S]{0,160}setStageChar\(null\);/.test(coll) &&
  /\}, \[stageRequest\]\);/.test(coll) &&
  /pendingStageIdRef/.test(coll) &&
  /\}, \[snap\.characters, stageRequest\?\.nonce\]\);/.test(coll));
check('v3.0.4 仅 scale 变化广播跳过 reload（降低缩放期间重渲染）',
  /changed\[0\] === 'scale'/.test(coll) && /if \(keys\.length === 1/.test(coll));

// J2（P2-2）：主窗重建后「第一次」点击仍可能丢 IPC —— 裸 ipcRenderer.on 无缓存重放。
// 修法：preload 层给 dc:open-chat / dc:open-collection / dc:open-stage 做「意图缓存 + 订阅后重放」。
check('J2 preload 提供「缓存 + 订阅后重放」订阅器（subscribeWithReplay），带 pending 槽与订阅态标记',
  /function subscribeWithReplay<T>\(/.test(preload) &&
  /type PendingIntent<T> = \{ value: T \| null; subscribed: boolean \}/.test(preload) &&
  /pending\.subscribed = true;/.test(preload) &&
  /pending\.value = map\(raw\);/.test(preload) &&
  /cb\(v\);/.test(preload));
check('J2 三条导航通道均走 subscribeWithReplay（订阅建立时重放缓存意图）',
  /onDcOpenChat: \(cb\) => subscribeWithReplay\('dc:open-chat', pendingDcOpenChat, cb, \(raw\) => raw\)/.test(preload) &&
  /onDcOpenCollection: \(cb\) =>\s*\n?\s*subscribeWithReplay\('dc:open-collection', pendingDcOpenCollection, cb, \(\) => undefined\)/.test(preload) &&
  /onDcOpenStage: \(cb\) => subscribeWithReplay\('dc:open-stage', pendingDcOpenStage, cb, \(raw\) => raw\)/.test(preload));
check('J2 三个 pending 槽与 subscribed 标记独立存在（互不串台）',
  /const pendingDcOpenChat: PendingIntent<any> = \{ value: null, subscribed: false \}/.test(preload) &&
  /const pendingDcOpenCollection: PendingIntent<void> = \{ value: null, subscribed: false \}/.test(preload) &&
  /const pendingDcOpenStage: PendingIntent<string> = \{ value: null, subscribed: false \}/.test(preload));

// J3（新增功能）：绑定对话来了新消息（AI 回复 / 用户消息）→ 实时弹到桌宠头顶气泡。
// 钩在 DataManager.addMessage（所有新消息的唯一落库入口），按角色 boundChat 匹配后定向推送。
check('J3 消息写入中央单点挂钩：db.addMessage 落库后触发 onChatMessageAdded',
  /export function setChatMessageAddedListener\(fn: \(\(msg: ChatMessage\) => void\) \| null\)/.test(dbTs) &&
  /this\.store\.messages\.push\(full\);[\s\S]{0,200}onChatMessageAdded\?\.\(full\);/.test(dbTs));
check('J3 main.ts 注册监听器并转发到桌宠定向推送',
  /setChatMessageAddedListener\(/.test(electronMain) &&
  /pushChatMessageToCharacters/.test(electronMain) &&
  /import \{[^}]*pushChatMessageToCharacters[^}]*\} from '\.\/desktopCharacter'/.test(electronMain));
check('J3 桌宠侧按角色 boundChat 匹配后定向推送到该角色窗（多窗口不串台）',
  /export function pushChatMessageToCharacters\(/.test(mainDc) &&
  /bound\.type !== type \|\| bound\.id !== id/.test(mainDc) &&
  /w\.webContents\.send\('dc:chat-message', \{ content, senderType: msg\.sender_type \}\)/.test(mainDc));
check('J3 过滤规则：跳过 proactive（避免与主动消息气泡重复弹）/ 失败消息 / system / 空内容',
  /if \(msg\.from_proactive === true\) return;/.test(mainDc) &&
  /if \(msg\.status === 'failed'\) return;/.test(mainDc) &&
  /if \(msg\.sender_type !== 'ai' && msg\.sender_type !== 'user'\) return;/.test(mainDc) &&
  /if \(!raw\) return;/.test(mainDc));
check('J3 渲染层订阅 dc:chat-message 并复用 showBubble（沿用既有线性气泡动画与开关门控）',
  /api\.onDcChatMessage\(/.test(appTsx) &&
  /sanitizeBubbleText\(d\?\.content \|\| ''\)/.test(appTsx) &&
  /showBubble\(text\)/.test(appTsx) &&
  /onDcChatMessage: \(cb: \(d: \{ content: string; senderType\?: string \}\) => void\) => \(\) => void;/.test(preload) &&
  /onDcChatMessage: \(cb\) => raw\.onDcChatMessage\(cb\)/.test(ipcTs));

// 可证伪：把 J 段三处修复分别回退，对应断言必须变红
{
  const j1 = coll.replace('setStageChar(null);', '/* stripped */');
  check('（可证伪）删掉舞台撤销时的 setStageChar(null) 后 J1 断言失效',
    !/if \(!stageRequest \|\| !stageRequest\.id\) \{[\s\S]{0,200}setStageChar\(null\);/.test(j1));

  const j2 = preload.replace(/subscribeWithReplay\('dc:open-chat', pendingDcOpenChat, cb, \(raw\) => raw\)/, '/* stripped */');
  check('（可证伪）让 dc:open-chat 退回裸 ipcRenderer.on 后 J2 断言失效',
    !/onDcOpenChat: \(cb\) => subscribeWithReplay/.test(j2));

  const j3 = mainDc.replace("w.webContents.send('dc:chat-message', { content, senderType: msg.sender_type });", '/* stripped */');
  check('（可证伪）删掉新消息定向推送后 J3 断言失效',
    !/w\.webContents\.send\('dc:chat-message'/.test(j3));

  const j4 = dbTs.replace('onChatMessageAdded?.(full);', '/* stripped */');
  check('（可证伪）摘掉 addMessage 的消息钩子后 J3 断言失效',
    !/onChatMessageAdded\?\.\(full\);/.test(j4));
}

// ============================================================================
section('K. v3.0.3 桌宠增量（共享真源 / 频率派生 / 动画同源 / 舞台同步 / 高清渲染）');
// ============================================================================
const lineScheduleSrc = read('src/utils/lineSchedule.ts');
const bubbleTimingSrc = read('src/utils/bubbleTiming.ts');

// ---------- K1. 共享真源模块存在且自洽 ----------
check('K1 频率派生真源 src/utils/lineSchedule.ts 存在且导出约定接口',
  /export function normalizeSpeakRate/.test(lineScheduleSrc) &&
  /export function deriveLineSchedule\s*\(/.test(lineScheduleSrc) &&
  /export function deriveLineScheduleForCharacter/.test(lineScheduleSrc) &&
  /export const LINE_MIN_INTERVAL_MS = 1000/.test(lineScheduleSrc) &&
  /export const SPEAK_RATE_MAX = 60/.test(lineScheduleSrc) &&
  /export const SPEAK_RATE_DEFAULT = 2/.test(lineScheduleSrc));
check('K1 气泡时长真源 src/utils/bubbleTiming.ts 存在且导出约定接口',
  /export function countBubbleChars/.test(bubbleTimingSrc) &&
  /export function bubbleHoldSeconds/.test(bubbleTimingSrc) &&
  /export function bubbleHoldMs/.test(bubbleTimingSrc) &&
  /export function readCharacterAnimParams/.test(bubbleTimingSrc) &&
  /export const BUBBLE_STEP_CHARS = 20/.test(bubbleTimingSrc));
check('K1 两个真源模块零 DOM 依赖（可被 electron 主进程直接 import）',
  !/\bdocument\b|\bwindow\b|\bHTMLElement\b/.test(lineScheduleSrc) &&
  !/\bdocument\b|\bwindow\b|\bHTMLElement\b/.test(bubbleTimingSrc));

// ---------- K2. 主进程护栏按角色频率派生（方案 A） ----------
check('K2 主进程不再有固定的 30s 护栏常量（CHARACTER_LINE_MIN_GAP_MS 已删除）',
  !/CHARACTER_LINE_MIN_GAP_MS/.test(electronMain));
check('K2 主进程护栏改为「渲染层派生值 + 按对话反查角色」两路来源',
  /targetIntervalMs/.test(electronMain) &&
  /deriveLineSchedule/.test(electronMain) &&
  /deriveGapFromBoundCharacter/.test(electronMain) &&
  /Math\.max\(LINE_MIN_INTERVAL_MS/.test(electronMain));
check('K2 主进程与渲染层共用同一份 deriveLineSchedule（同源派生，不可能漂移）',
  /import \{[^}]*deriveLineSchedule[^}]*\} from '\.\.\/src\/utils\/lineSchedule'/.test(electronMain) &&
  /from '\.\.\/utils\/lineSchedule'/.test(appTsx) &&
  /deriveLineScheduleForCharacter/.test(appTsx));
check('K2 主进程节流窗口按对话分键（快角色不被慢角色压住）',
  /const characterLineLastAt = new Map<string, number>\(\)/.test(electronMain) &&
  /characterLineLastAt\.get\(key\)/.test(electronMain) &&
  /characterLineLastAt\.set\(key, now\)/.test(electronMain));
check('K2 并发锁保留（characterLineInFlight 未被放宽）',
  /let characterLineInFlight = false/.test(electronMain) &&
  /characterLineInFlight = true/.test(electronMain) &&
  /characterLineInFlight = false/.test(electronMain));

// ---------- K3. 渲染层频率调度改造 ----------
check('K3 渲染层不再有写死的 15s/45s 调度常量',
  !/CHARACTER_LINE_TICK_MS/.test(appTsx) &&
  !/CHARACTER_LINE_MIN_INTERVAL_MS/.test(appTsx) &&
  !/CHARACTER_BUBBLE_MS/.test(appTsx));
check('K3 频率为 0 时连调度定时器都不创建（零请求/零气泡/零写库）',
  /if \(!sch\.enabled\) return;/.test(appTsx) &&
  /deriveLineScheduleForCharacter/.test(appTsx));
check('K3 调度器为自续期 setTimeout（频率改动即时生效，无需重启）',
  /setTimeout\(\(\) => \{[\s\S]{0,900}schedule\(\);/.test(appTsx) &&
  !/setInterval\(/.test(appTsx));
check('K3 请求携带派生好的 targetIntervalMs（主进程护栏据此兜底）',
  /targetIntervalMs: sch\.intervalMs/.test(appTsx) &&
  /targetIntervalMs\?: number/.test(preload) &&
  /targetIntervalMs\?: number/.test(ipcTs));

// ---------- K4. 气泡双向动画 + 按字数时长 ----------
check('K4 气泡有收回态（.dc-bubble.closing）与 dcBubbleOut 关键帧',
  /\.dc-bubble\.closing \{[\s\S]{0,200}dcBubbleOut/.test(charCss) &&
  /@keyframes dcBubbleOut/.test(charCss) &&
  /pointer-events: none/.test(charCss));
check('K4 收回态显式登记进 character 分组（防后续改类名静默失效）',
  /character: \[[^\]]*'\.dc-bubble\.closing'/.test(anim) &&
  /html\.anim-off \.dc-bubble\.closing/.test(charCss) &&
  /html\[data-anim-off~='character'\] \.dc-bubble\.closing/.test(charCss));
check('K4 气泡状态机四阶段（显示 → 停留 → 收回 → 卸载）齐全',
  /const \[bubbleClosing, setBubbleClosing\] = useState\(false\)/.test(appTsx) &&
  /const \[bubbleSeq, setBubbleSeq\] = useState\(0\)/.test(appTsx) &&
  /bubbleHoldTimer/.test(appTsx) &&
  /bubbleOutTimer/.test(appTsx) &&
  /key=\{bubbleSeq\}/.test(appTsx));
check('K4 点气泡文字走收回动画而非瞬间消失（closeBubble）',
  /const closeBubble = useCallback/.test(appTsx) &&
  /closeBubble\(\);/.test(appTsx));
check('K4 气泡停留时长按码点字数计算（与设置页同一函数）',
  /bubbleHoldMs\(text,/.test(appTsx) &&
  /bubbleHoldMs/.test(bubbleTimingSrc) &&
  /\[...\.\.\.text\]\.length|\[\.\.\.text\]\.length/.test(bubbleTimingSrc));
check('K4 分档用 ceil（21 字进第 2 档，与 PRD 分档表一致）',
  /Math\.ceil\(/.test(bubbleTimingSrc) &&
  !/Math\.floor\(/.test(bubbleTimingSrc));

// ---------- K5. 菜单动画 0.20s + 幅度 + 速度倍率 ----------
check('K5 菜单动画时长 0.20s（用户拍板）且幅度含 scale 0.96→1',
  /@keyframes dcMenuIn \{[\s\S]{0,200}translateY\(6px\) scale\(0\.96\)/.test(charCss) &&
  /@keyframes dcMenuOut \{[\s\S]{0,200}translateY\(6px\) scale\(0\.96\)/.test(charCss));
check('K5 菜单时长不再写死（改为 --dc-menu-anim 变量 + --anim-speed 倍率）',
  /var\(--dc-menu-anim, 0\.20s\) \* var\(--anim-speed, 1\)/.test(charCss) &&
  !/animation: dcMenuIn 0\.14s linear/.test(charCss) &&
  !/DC_MENU_ANIM_MS/.test(appTsx));
check('K5 JS 侧卸载计时与 CSS 同源（基准秒数 × character 分组倍率）',
  /function menuAnimMs/.test(appTsx) &&
  /getGroupAnimSpeed\(s, 'character'\)/.test(appTsx) &&
  /readCharacterAnimParams\(s\)\.menuSec/.test(appTsx) &&
  // 只看可执行代码：注释里提到 readAnimSpeed 是「为什么不能用它」的说明，不是调用
  !/readAnimSpeed\(/.test(stripComments(appTsx)));
check('K5 气泡侧同样同源（基准秒数 × character 分组倍率）',
  /function bubbleAnimMs/.test(appTsx) &&
  /getGroupAnimSpeed\(settings, 'character'\)/.test(appTsx) &&
  /var\(--dc-bubble-anim, 0\.18s\) \* var\(--anim-speed, 1\)/.test(charCss));
check('K5 角色窗把动画基准秒数写进 CSS 变量（写在 documentElement 上，向下继承）',
  /--dc-menu-anim/.test(appTsx) &&
  /--dc-bubble-anim/.test(appTsx) &&
  /documentElement/.test(appTsx));
check('K5 菜单项先播收回动画再执行业务动作（收回可见）',
  /menuActionTimer/.test(appTsx) &&
  /closeMenu\(\);[\s\S]{0,200}menuActionTimer\.current = setTimeout/.test(appTsx) &&
  /m\.onClick\(\);/.test(appTsx));

// ---------- K6. 舞台 ⇄ 桌面缩放双向同步 ----------
// 只取缩放常量声明块来判定「1.9 是否残留」——注释里提到 1.9（说明已删除）不算残留。
const stageZoomConsts = (stage.match(/const STAGE_ZOOM_[A-Z]+ = [0-9.]+;/g) || []).join(' ');
check('K6 舞台缩放区间放宽到 0.6~2.0（v3.0.9）',
  /const STAGE_ZOOM_MAX = 2\.0/.test(stage) &&
  !/1\.9/.test(stageZoomConsts) &&
  /const STAGE_ZOOM_MIN = 0\.6/.test(stage));
check('K6 存在「实时预览」通道：dc:set-scale-live（渲染→主）与 dc:scale-preview（主→角色窗）',
  /ipcMain\.on\('dc:set-scale-live'/.test(mainDc) &&
  /webContents\.send\('dc:scale-preview'/.test(mainDc) &&
  /dcSetScaleLive/.test(preload) &&
  /dcSetScaleLive/.test(ipcTs) &&
  /onDcScalePreview/.test(preload) &&
  /onDcScalePreview/.test(ipcTs) &&
  /onDcScalePreview/.test(appTsx));
check('K6 预览通道不落盘、不广播（只推给该角色窗改本地 --dc-scale）',
  /dc:set-scale-live[\s\S]{0,400}webContents\.send\('dc:scale-preview'/.test(mainDc) &&
  !/dc:set-scale-live[\s\S]{0,400}saveSettings/.test(mainDc));
check('K6 舞台写回只发生在用户手势里（外部同步只读，绝不回写）',
  /zoomSourceRef/.test(stage) &&
  /api\.dcSetScaleLive\(/.test(stage) &&
  /api\.dcSetScale\(/.test(stage));
check('K6 舞台反向订阅 settings:changed（桌面滚轮 → 舞台滑块 ≤300ms）',
  /api\.onSettingsChanged/.test(stage) &&
  /desktopCharacters/.test(stage));
check('K6 舞台滑块仍是 0.6~2.0 / 步长 0.05，且复用既有 dc:set-scale 提交（整数组覆盖）',
  /min=\{STAGE_ZOOM_MIN\}/.test(stage) &&
  /max=\{STAGE_ZOOM_MAX\}/.test(stage) &&
  /step=\{STAGE_ZOOM_STEP\}/.test(stage) &&
  /api\.dcSetScale\(character\.id, next\)/.test(stage) &&
  /const next = list\.slice\(\);[\s\S]{0,120}next\[idx\] = \{ \.\.\.next\[idx\], scale: clamped \};[\s\S]{0,120}dm\.saveSettings\(\{ desktopCharacters: next \}\)/.test(mainDc));

// ---------- K7. 舞台高清渲染 ----------
check('K7 舞台模型盒子按 --stage-zoom 放大（不再靠 transform: scale 插值）',
  /width: calc\(190px \* var\(--stage-zoom, 1\)\)/.test(panelCss) &&
  /height: calc\(220px \* var\(--stage-zoom, 1\)\)/.test(panelCss));
check('K7 舞台模型 transform 里不再有 scale()（插值放大是模糊根因）',
  !/scale\(\$\{zoom\}\)/.test(stage) &&
  !/scale\([0-9.]+\)/.test(stage.replace(/scaleY\([^)]*\)/g, '')));
// 只看**声明行**（注释里提到 will-change: transform 是解释为何去掉它，不算残留）。
const panelWillChange = (panelCss.match(/^\s*will-change:[^;]+;/gm) || []).join(' ');
check('K7 舞台模型去掉 will-change: transform（合成层会强制 1× 栅格化）',
  !/will-change:\s*transform/.test(panelWillChange) &&
  /will-change:\s*auto/.test(panelWillChange));
check('K7 舞台视口允许滚动且有最小高度（放大后不被裁掉）',
  /overflow: auto/.test(panelCss) &&
  /min-height: 380px/.test(panelCss));
check('K7 3D / Live2D 渲染分辨率随 zoom 提升（缺省 1 ⇒ 桌宠窗行为零变化）',
  /zoom\?: number/.test(modelView) &&
  /zoom\?: number/.test(threeView) &&
  /zoom\?: number/.test(l2dView) &&
  /applyPixelRatio/.test(threeView) &&
  /targetResolution/.test(l2dView));

// ---------- K8. 角色面板频率滑块 ----------
check('K8 角色卡片有频率滑块（单位化范围 / 步长 1）',
  /min=\{0\}/.test(coll) &&
  /max=\{displayMax\}/.test(coll) &&
  /step=\{1\}/.test(coll) &&
  /speakRate/.test(coll));
// v3.0.4：多单位（分钟/小时/天）——单位只作视图换算，真源仍是条/分钟
check('v3.0.4 lineSchedule 提供单位换算函数且保留小数精度',
  /export type SpeakRateUnit = 'min' \| 'hour' \| 'day'/.test(lineScheduleSrc) &&
  /export function rateToPerMinute/.test(lineScheduleSrc) &&
  /export function rateForUnit/.test(lineScheduleSrc) &&
  /export function rateMaxForUnit/.test(lineScheduleSrc) &&
  /Math\.round\(raw \* RATE_PRECISION\) \/ RATE_PRECISION/.test(lineScheduleSrc));
check('v3.0.4 角色卡片有单位选择器（分钟/小时/天，无秒档）',
  /dc-coll-rate-unit/.test(coll) &&
  /value="min"/.test(coll) && /value="hour"/.test(coll) && /value="day"/.test(coll) &&
  !/value="sec"/.test(coll));
check('v3.0.4 滑块显示值与写入值都经共享单位换算函数（单位取角色级偏好）',
  /resolveRateDisplay\(rate, c\.speakRateUnit\)/.test(coll) &&
  /const value = rateForUnit\(rate, unit\);/.test(coll) &&
  /max: rateMaxForUnit\(unit\)/.test(coll) &&
  /rateToPerMinute\(Number\(e\.target\.value\), displayUnit\)/.test(coll));
/** 按选择器字面量抽取一段 CSS 规则/at-rule 的完整块（含花括号），用于「块内不得出现 X」类判定 */
function cssBlock(src, selector) {
  const i = src.indexOf(selector);
  if (i < 0) return '';
  const open = src.indexOf('{', i);
  if (open < 0) return '';
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, k + 1);
    }
  }
  return '';
}
// v3.0.4 P1（第三次反馈）：reduced-motion 只压无限循环的呼吸/游走，菜单与气泡彻底移出该块。
// 判定基于「去注释后的 at-rule 块内容」，避免解释性注释里的类名把断言带偏。
const rmBlock = cssBlock(stripComments(charCss), '@media (prefers-reduced-motion: reduce)');
check('v3.0.4 R4 reduced-motion 块仍存在且继续关闭无限循环的 .dc-svg / .dc-modelimg',
  rmBlock.length > 0 &&
  /\.dc-svg/.test(rmBlock) &&
  /\.dc-modelimg/.test(rmBlock) &&
  /animation: none !important/.test(rmBlock));
check('v3.0.4 R4 reduced-motion 块内不再包含 .dc-bubble / .dc-menu（系统级压制动画的根因已拆除）',
  rmBlock.length > 0 &&
  !/\.dc-bubble/.test(rmBlock) &&
  !/\.dc-menu/.test(rmBlock) &&
  !/animation-duration/.test(rmBlock));
check('v3.0.4 R4 菜单/气泡动画时长仍与 JS 卸载计时同源（--dc-*-anim × --anim-speed）',
  /animation: dcBubbleIn calc\(var\(--dc-bubble-anim, 0\.18s\) \* var\(--anim-speed, 1\)\) linear both/.test(charCss) &&
  /animation: dcMenuIn calc\(var\(--dc-menu-anim, 0\.20s\) \* var\(--anim-speed, 1\)\) linear both/.test(charCss) &&
  /getGroupAnimSpeed\(s, 'character'\)/.test(appTsx));
check('v3.0.4 气泡/菜单弹入动画补 both 填充模式',
  /animation: dcBubbleIn calc\([^;]+\) linear both/.test(charCss) &&
  /animation: dcMenuIn calc\([^;]+\) linear both/.test(charCss));
check('v3.0.4 角色窗不再以 main kind 注入动画门禁（避免覆盖 character 门禁）',
  /animDocKind="character"/.test(charEntry) &&
  /animDocKind !== 'character'\) applyAnimControl\(document, settings, 'main'\)/.test(themeCtx));
check('v3.0.4 关于页删除旧长句、只保留标语，并带版本徽标与 GitHub 按钮',
  !/about\.line1|about\.line2|about\.line3/.test(aboutModal) &&
  /about\.line4/.test(aboutModal) &&
  /updateStatus\(\)/.test(aboutModal) &&
  /openExternal\(/.test(aboutModal) &&
  !/一款面向深度情感交互/.test(trans));
check('K8 频率缺省回落 2 条/分（存量用户升级行为不回退）',
  /normalizeSpeakRate\(c\.speakRate\)/.test(coll));
check('K8 滑块滚轮不改数值（避免与页面滚动打架）',
  /onWheel=\{\(e\) => e\.preventDefault\(\)\}/.test(coll));
check('K8 频率写入走既有整数组覆盖路径（HC-8）',
  /patchCharacter\(c\.id, \{[\s\S]{0,200}speakRate/.test(coll) &&
  /api\.saveSettings\(\{ desktopCharacters: next \}\)/.test(coll));

// ---------- K8b. 频率数字输入框（v3.0.4 R1：用户要求「能直接输入具体数值」） ----------
// 与滑块共用同一真源：输入值单位 = 当前所选单位，写入前经 rateToPerMinute 换回条/分钟。
check('v3.0.4 R1 角色卡片有频率数字输入框（type=number / min=0 / max=displayMax / step=1）',
  /className="dc-coll-rate-input"/.test(coll) &&
  /type="number"/.test(coll) &&
  /min=\{0\}/.test(coll) &&
  /max=\{displayMax\}/.test(coll) &&
  /step=\{1\}/.test(coll));
check('v3.0.4 R1 输入框写入走共享换算（rateToPerMinute(next, displayUnit)）+ 既有整数组覆盖',
  /onCommit=\{\(next\) =>[\s\S]{0,160}rateToPerMinute\(next, displayUnit\)/.test(coll) &&
  /patchCharacter\(c\.id, \{ speakRate: rateToPerMinute\(next, displayUnit\) \}\)/.test(coll));
check('v3.0.4 R1 输入框中间态只存本地草稿，失焦/回车才归一化提交（不写脏数据）',
  /useState<string>\(String\(value\)\)/.test(coll) &&
  /onChange=\{\(e\) => setDraft\(e\.target\.value\)\}/.test(coll) &&
  /onBlur=\{\(\) => \{[\s\S]{0,140}commit\(\);/.test(coll) &&
  /e\.currentTarget\.blur\(\)/.test(coll));
check('v3.0.4 R1 空串/非数字回退当前值、越界钳到 max、负数归零（清空不会误写成 0=关闭）',
  /if \(raw === ''\) return value;/.test(coll) &&
  /if \(!Number\.isFinite\(n\)\) return value;/.test(coll) &&
  /Math\.min\(max, Math\.max\(0, Math\.round\(n\)\)\)/.test(coll));
check('v3.0.4 R1 与滑块双向同步（外部值变化时回写草稿，编辑中不覆盖用户输入）',
  /if \(!editingRef\.current\) setDraft\(String\(value\)\)/.test(coll));
check('v3.0.4 R1 输入框无障碍标签走 i18n（无硬编码文案）',
  /ariaLabel=\{t\('characters\.speakRateInputLabel'\)\}/.test(coll));
// 输入框样式必须走主题变量（14 套主题可读），且不得硬编码色值
const rateInputCss = cssBlock(panelCss, '.dc-coll-rate-input {');
check('v3.0.4 R1 数字输入框样式走主题变量且无硬编码色值',
  rateInputCss.length > 0 &&
  /var\(--color-panel\)/.test(rateInputCss) &&
  /var\(--color-text\)/.test(rateInputCss) &&
  /var\(--color-border\)/.test(rateInputCss) &&
  !/#[0-9a-fA-F]{3,8}\b/.test(rateInputCss));

// ---------- K8c. 频率单位随角色持久化（v3.0.4 P1 回归修复） ----------
// 旧实现的单位是组件级 useState('min')：关面板再打开就回「分钟」，
// 「5 条/天」（真源 0.003472 条/分）在分钟档被 Math.round 抹成 0 ⇒ 显示「0 条/分钟」。
const collCode = stripComments(coll); // 断言「不存在某写法」必须去注释（源码注释里引用了旧实现）
check('v3.0.4 P1 DesktopCharacter 含 speakRateUnit（展示单位偏好随角色持久化）',
  /speakRateUnit\?: SpeakRateUnit;/.test(types) &&
  /主动说话频率的\*\*展示单位偏好\*\*/.test(types));
check('v3.0.4 P1 出厂内置角色「小念」显式写入 speakRateUnit: min',
  /speakRate: 2,[\s\S]{0,220}speakRateUnit: 'min'/.test(types));
check('v3.0.4 P1 角色卡片按 c.speakRateUnit 读单位（不再用组件级单一 state）',
  /resolveRateDisplay\(rate, c\.speakRateUnit\)/.test(collCode) &&
  /value=\{displayUnit\}/.test(collCode) &&
  !/useState<SpeakRateUnit>\('min'\)/.test(collCode));
check('v3.0.4 P1 切换单位走 patchCharacter 持久化（speakRateUnit，整数组覆盖 HC-8）',
  /patchCharacter\(c\.id, \{\s*speakRateUnit: normalizeSpeakRateUnit\(e\.target\.value\)/.test(collCode) &&
  /api\.saveSettings\(\{ desktopCharacters: next \}\)/.test(collCode));
check('v3.0.4 P1 真源 > 0 但该单位不足 1 条时有兜底（绝不输出「0 条/单位」）',
  /tooSmall: rate > 0 && value === 0/.test(collCode) &&
  /rateDisplay\.tooSmall\s*\?/.test(collCode) &&
  /t\('characters\.speakRateLessThanOne'/.test(collCode));
check('v3.0.4 P1 无单位偏好的老数据自动挑一个能显示 ≥1 的单位（min→hour→day）',
  /RATE_UNIT_ORDER: SpeakRateUnit\[\] = \['min', 'hour', 'day'\]/.test(collCode) &&
  /RATE_UNIT_ORDER\.find\(\(u\) => rateForUnit\(rate, u\) >= 1\)/.test(collCode));

// ---------- K13. 关于页去框 / 去句号（v3.0.4 R2） ----------
const aboutSloganCss = cssBlock(indexCss, '.about .about-slogan {');
check('v3.0.4 R2 关于页标语去掉外框（无 border / 无 background）',
  aboutSloganCss.length > 0 &&
  !/border/.test(aboutSloganCss) &&
  !/background/.test(aboutSloganCss));
check('v3.0.4 R2 标语排版保留（字号 / 字重 / 字距 / 上边距）',
  /font-size: calc\(19px \* var\(--font-scale\)\)/.test(aboutSloganCss) &&
  /font-weight: 600/.test(aboutSloganCss) &&
  /letter-spacing: 2px/.test(aboutSloganCss) &&
  /margin-top: 24px/.test(aboutSloganCss));
// 标语去掉句尾句号：translations.ts 的 zh/en + 8 个 locale JSON 共 10 处
const sloganInline = [...trans.matchAll(/'about\.line4':\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
check('v3.0.4 R2 标语在 translations.ts（zh+en）不含句尾句号',
  sloganInline.length === 2 && sloganInline.every((s) => s.trim() !== '' && !/[。.！!]$/.test(s)),
  sloganInline.join(' | '));
check('v3.0.4 R2 标语在 8 个 locale 中也不含句尾句号',
  LOCALE_CODES.every((lang) => {
    let j = {};
    try { j = JSON.parse(read(`src/i18n/locales/${lang}.json`)); } catch { j = {}; }
    const v = j['about.line4'];
    return typeof v === 'string' && v.trim() !== '' && !/[。.！!]$/.test(v);
  }));

// ---------- K14. 桌宠导航被关于弹窗遮挡（v3.0.4 R3） ----------
// AboutModal 根节点是 .modal-mask（fixed / inset:0 / z-index:10001），
// 三个导航 handler 若不关 aboutOpen，view 变了也会被整窗遮罩盖住 ⇒ 表现为「点了没反应」。
check('v3.0.4 R3 关于弹窗仍是全屏 .modal-mask（遮挡根因确认，勿把遮罩改成局部层）',
  /className="modal-mask"/.test(aboutModal) &&
  /\.modal-mask \{[\s\S]{0,400}position: fixed/.test(indexCss) &&
  /\.modal-mask \{[\s\S]{0,400}z-index: 10001/.test(indexCss));
check('v3.0.4 R3 三个桌宠导航 handler 都先 setAboutOpen(false)（管理角色 / 舞台 / 跳会话）',
  /onDcOpenCollection\(\(\) => \{\s*setAboutOpen\(false\);/.test(appRoot) &&
  /onDcOpenStage\(\(id\) => \{\s*setAboutOpen\(false\);/.test(appRoot) &&
  /onDcOpenChat\(async \(chat\) => \{\s*setAboutOpen\(false\);/.test(appRoot));
check('v3.0.4 R3 关于弹窗关闭逻辑仍走 setAboutOpen(false)（未退化成只切 view）',
  /const \[aboutOpen, setAboutOpen\] = useState\(false\)/.test(appRoot) &&
  /<AboutModal onClose=\{\(\) => setAboutOpen\(false\)\}/.test(appRoot));

// ---------- K9. 设置页细调子块（仅自定义档渲染） ----------
check('K9 桌宠动画细调子块存在且含 5 个滑块（菜单/气泡/基准/每档/上限）',
  /animCtl\.groupCharacterDetail/.test(settings) &&
  /animCharacterMenuSec/.test(settings) &&
  /animCharacterBubbleSec/.test(settings) &&
  /animCharacterBubbleBaseSec/.test(settings) &&
  /animCharacterBubbleStepSec/.test(settings) &&
  /animCharacterBubbleMaxSec/.test(settings));
check('K9 细调子块只在「自定义」档渲染（与分组区同规则）',
  /animCustom && \(/.test(settings) &&
  /sec-anim-control/.test(settings));
check('K9 character 分组被关时细调块置灰 + 说明（HC-7 不静默失效）',
  /charGroupOff/.test(settings) &&
  /disabled=\{charGroupOff\}/.test(settings) &&
  /opacity: charGroupOff \? 0\.45 : 1/.test(settings));
check('K9 换算示例与角色窗共用同一函数（示例与实测必然一致）',
  /bubbleHoldSeconds\(/.test(settings) &&
  /bubbleHoldSeconds\(/.test(bubbleTimingSrc));

// ---------- K10. 新增 i18n 键 10 处齐全 ----------
const NEW_KEYS = [
  'characters.speakRate', 'characters.speakRateUnit', 'characters.speakRateOff',
  'characters.speakRateHint', 'characters.speakRateWarn', 'characters.stageSyncHint',
  'animCtl.groupCharacterDetail', 'animCtl.menuAnimMs', 'animCtl.bubbleAnimMs',
  'animCtl.bubbleHoldBase', 'animCtl.bubbleHoldStep', 'animCtl.bubbleHoldMax',
  'animCtl.bubbleHoldPreview', 'animCtl.bubbleHoldDesc',
  'animCtl.groupCharacterDetailOff',
  // v3.0.4：多单位 + 关于页
  'characters.speakRateUnitLabel', 'characters.speakRateUnitMin',
  'characters.speakRateUnitHour', 'characters.speakRateUnitDay',
  // v3.0.4 R1：频率数字输入框的无障碍标签
  'characters.speakRateInputLabel',
  // v3.0.4 P1：真源 > 0 但该单位不足 1 条时的兜底文案（带 {unit} 占位符）
  'characters.speakRateLessThanOne',
  'about.github',
];
for (const k of NEW_KEYS) {
  const n = (trans.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length;
  check(`translations.ts 含 ${k}（zh+en 共 2 处）`, n === 2, `实得 ${n}`);
}
for (const lang of LOCALE_CODES) {
  let json = {};
  try {
    json = JSON.parse(read(`src/i18n/locales/${lang}.json`));
  } catch {
    json = {};
  }
  const miss = NEW_KEYS.filter((k) => typeof json[k] !== 'string' || !json[k].trim());
  check(`locales/${lang}.json 含 ${NEW_KEYS.length} 个新增桌宠/关于键且非空`, miss.length === 0, miss.join(','));
}
check('K10 未新增「实际约 N 条/分」类折中提示（用户拍板取消）',
  !/实际约|实际生效|受请求耗时限制|实际速率/.test(trans) &&
  LOCALE_CODES.every((lang) => {
    let j = {};
    try { j = JSON.parse(read(`src/i18n/locales/${lang}.json`)); } catch { j = {}; }
    return !Object.values(j).some((v) => typeof v === 'string' && /实际约|实际生效|受请求耗时限制/.test(v));
  }));

// ---------- K12. QA 回归修复（D1/D2/O1/O2/O4） ----------
const stageCode = stripComments(stage);
check('D1 舞台有独立的 lastCommittedZoomRef（与回声抑制 ref 分离）',
  /lastCommittedZoomRef\s*=\s*useRef<number \| null>\(null\)/.test(stageCode) &&
  /lastWrittenZoomRef\s*=\s*useRef<number \| null>\(null\)/.test(stageCode));
check('D1 commitZoom 内用 STAGE_ZOOM_EPS 对 lastCommittedZoomRef 判重后才 dcSetScale',
  /lastCommittedZoomRef\.current !== null && Math\.abs\(lastCommittedZoomRef\.current - next\) < STAGE_ZOOM_EPS[\s\S]{0,160}api\.dcSetScale\(/.test(stageCode));
check('D1 判重 return 在 lastCommittedZoomRef 赋值之前（同值不重发）',
  /if \(lastCommittedZoomRef\.current[\s\S]{0,120}return;\s*\}\s*lastCommittedZoomRef\.current = next;/.test(stageCode));
check('D2 设置页关闭说明用独立键 groupCharacterDetailOff（非标题键复读）',
  /\{charGroupOff &&[\s\S]{0,220}t\('animCtl\.groupCharacterDetailOff'\)\}/.test(settings) &&
  !/\{charGroupOff &&[\s\S]{0,220}t\('animCtl\.groupCharacterDetail'\)\}/.test(settings));
check('O1 ThreeModelView 不再用 Math.max(1, zoom) 裁切缩小档',
  !/Math\.max\(1,\s*zoom\)/.test(threeView) &&
  !/Math\.max\(1,\s*zoomRef\.current\)/.test(stripComments(threeView)) &&
  /Math\.max\(0\.6,\s*zoom\)/.test(threeView));
check('O2 zoomSourceRef 在 commitZoom 内真实参与闸门（非死代码）',
  /zoomSourceRef\.current !== 'user'[\s\S]{0,80}return;/.test(stageCode));
check('O4 气泡正文按码点截断，不切 emoji 代理对',
  /const cps = \[\.\.\.s\]/.test(appTsx) &&
  /cps\.slice\(0, CHARACTER_BUBBLE_MAX_CHARS\)\.join\(''\)/.test(appTsx) &&
  !/(^|[^p])s\.slice\(0, CHARACTER_BUBBLE_MAX_CHARS\)/.test(appTsx));
check('O3 30s 兜底只在两路都缺失时触发且带告警（非静默回归）',
  /if \(!characterLineGapWarned\)/.test(electronMain) &&
  /console\.warn\('\[nianyu\] 桌宠语句间隔无法判定，回退 30s 护栏/.test(electronMain) &&
  /gap = 30_000;/.test(electronMain));

// ---------- K11. 可证伪：变异后对应断言必须变红 ----------
{
  // 变异 1：把 ceil 改回 floor ⇒ K4「分档用 ceil」断言失效
  const brokenA = bubbleTimingSrc.replace('Math.ceil(', 'Math.floor(');
  check('（可证伪）把气泡分档 ceil 改成 floor 后 K4 断言失效',
    !/Math\.ceil\(/.test(brokenA) && /Math\.floor\(/.test(brokenA));
  // 变异 2：把菜单 CSS 的 --anim-speed 去掉 ⇒ K5「CSS 接速度倍率」断言失效
  const brokenB = charCss.replace(/ \* var\(--anim-speed, 1\)/g, '');
  check('（可证伪）把菜单/气泡 CSS 的 --anim-speed 去掉后 K5 断言失效',
    !/var\(--anim-speed, 1\)/.test(brokenB));
  // 变异 3：把菜单幅度 scale(0.96) 删掉 ⇒ K5「幅度含 scale」断言失效
  const brokenC = charCss.replace('translateY(6px) scale(0.96)', 'translateY(6px)');
  check('（可证伪）删掉菜单动画的 scale(0.96) 幅度后 K5 断言失效',
    !/@keyframes dcMenuIn \{[\s\S]{0,200}translateY\(6px\) scale\(0\.96\)/.test(brokenC));
  // 变异 4：主进程把护栏改回固定常量 ⇒ K2 断言失效
  const brokenD = electronMain.replace(/Math\.max\(LINE_MIN_INTERVAL_MS, Math\.round\(gap\)\)/, 'CHARACTER_LINE_MIN_GAP_MS');
  check('（可证伪）主进程护栏改回固定常量后 K2 断言失效',
    !/Math\.max\(LINE_MIN_INTERVAL_MS, Math\.round\(gap\)\)/.test(brokenD) && /CHARACTER_LINE_MIN_GAP_MS/.test(brokenD));
  // 变异 5：舞台把 --stage-zoom 的 calc 去掉 ⇒ K7 断言失效
  const brokenE = panelCss.replace('width: calc(190px * var(--stage-zoom, 1));', 'width: 190px;');
  check('（可证伪）舞台模型盒子不再按 --stage-zoom 放大后 K7 断言失效',
    !/width: calc\(190px \* var\(--stage-zoom, 1\)\)/.test(brokenE));
  // 变异 6：恢复 will-change: transform ⇒ K7 断言失效
  const brokenF = panelCss.replace('will-change: auto;', 'will-change: transform;');
  const brokenFWillChange = (brokenF.match(/^\s*will-change:[^;]+;/gm) || []).join(' ');
  check('（可证伪）恢复 will-change: transform 后 K7 断言失效',
    !/will-change:\s*auto/.test(brokenFWillChange) &&
    /will-change:\s*transform/.test(brokenFWillChange));
  // 变异 7：把 .dc-bubble.closing 从分组登记里删掉 ⇒ K4 断言失效
  const brokenG = anim.replace("'.dc-bubble.closing', ", '');
  check('（可证伪）从 character 分组里删掉 .dc-bubble.closing 后 K4 断言失效',
    !/character: \[[^\]]*'\.dc-bubble\.closing'/.test(brokenG));
  // 变异 8：把 getGroupAnimSpeed 换成 readAnimSpeed ⇒ K5 断言失效
  // （变异后代码里出现了 readAnimSpeed( 调用 ⇒ K5 的「不得使用 readAnimSpeed」判定翻红）
  const brokenH = appTsx.split("getGroupAnimSpeed(s, 'character')").join('readAnimSpeed(document)');
  check('（可证伪）把分组倍率换成 readAnimSpeed(document) 后 K5 断言失效',
    !/getGroupAnimSpeed\(s, 'character'\)/.test(brokenH) &&
    /readAnimSpeed\(/.test(stripComments(brokenH)));
  // 变异 9：去掉 D1 判重 ⇒ K12 D1 断言失效
  const brokenI = stageCode.replace(
    /if \(lastCommittedZoomRef\.current !== null && Math\.abs\(lastCommittedZoomRef\.current - next\) < STAGE_ZOOM_EPS\) \{\s*return;\s*\}\s*/,
    '');
  check('（可证伪）删掉 D1 同值判重后 K12 断言失效',
    !/lastCommittedZoomRef\.current !== null && Math\.abs/.test(brokenI));
  // 变异 10：D2 改回标题键 ⇒ K12 D2 断言失效
  const brokenJ = settings.replace("t('animCtl.groupCharacterDetailOff')", "t('animCtl.groupCharacterDetail')");
  check('（可证伪）D2 改回标题键后 K12 断言失效',
    /\{charGroupOff &&[\s\S]{0,220}t\('animCtl\.groupCharacterDetail'\)\}/.test(brokenJ));
  // 变异 11：O1 恢复 Math.max(1, zoom) ⇒ K12 O1 断言失效
  const brokenK = threeView.replace(/Math\.max\(0\.6, zoom\)/g, 'Math.max(1, zoom)');
  check('（可证伪）O1 恢复 Math.max(1, zoom) 后 K12 断言失效',
    /Math\.max\(1,\s*zoom\)/.test(brokenK));
  // 变异 12：把多单位换算改回 Math.round（每天 1 条被抹成 0）⇒ v3.0.4 断言失效
  const brokenL = lineScheduleSrc.replace('Math.round(raw * RATE_PRECISION) / RATE_PRECISION', 'Math.round(raw)');
  check('（可证伪）频率归一改回 Math.round 后多单位断言失效',
    !/Math\.round\(raw \* RATE_PRECISION\) \/ RATE_PRECISION/.test(brokenL));
  // 变异 13：把 .dc-bubble/.dc-menu 塞回 reduced-motion 块 ⇒ R4 断言失效
  const brokenM = charCss.replace(
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.dc-svg/,
    '@media (prefers-reduced-motion: reduce) {\n  .dc-bubble,\n  .dc-menu {\n    animation-duration: 0.01ms !important;\n  }\n  .dc-svg');
  const brokenMRm = cssBlock(stripComments(brokenM), '@media (prefers-reduced-motion: reduce)');
  check('（可证伪）把 .dc-bubble/.dc-menu 塞回 reduced-motion 块后 R4 断言失效',
    /\.dc-bubble/.test(brokenMRm) && /\.dc-menu/.test(brokenMRm));
  // 变异 14：关于页改回旧长句 ⇒ 断言失效
  const brokenN = aboutModal.replace("{t('about.line4')}", "'一款面向深度情感交互的 AI 数字人对话网站'");
  check('（可证伪）关于页恢复旧长句后断言失效',
    /一款面向深度情感交互/.test(brokenN));
  // 变异 15（R1）：输入框写入不再走共享换算 ⇒ K8b 断言失效
  const brokenO = coll.replace('speakRate: rateToPerMinute(next, displayUnit)', 'speakRate: Number(next)');
  check('（可证伪）输入框直写 Number(next) 不再换算后 R1 共享换算断言失效',
    !/patchCharacter\(c\.id, \{ speakRate: rateToPerMinute\(next, displayUnit\) \}\)/.test(brokenO));
  // 变异 16（R1）：清空即写 0 ⇒ 「不写脏数据」断言失效
  const brokenP = coll.replace("if (raw === '') return value;", "if (raw === '') return 0;");
  check('（可证伪）清空直接返回 0 后 R1 脏数据断言失效',
    !/if \(raw === ''\) return value;/.test(brokenP));
  // 变异 17（R2）：标语加回描边与浅色块 ⇒ R2 去框断言失效
  const brokenQ = indexCss.replace(
    /(\.about \.about-slogan \{[^}]*?)padding: 18px 12px;/,
    '$1padding: 18px 12px;\n  border: 1px solid var(--color-border);\n  background: color-mix(in srgb, var(--color-primary) 6%, transparent);');
  const brokenQSlogan = cssBlock(brokenQ, '.about .about-slogan {');
  check('（可证伪）标语加回描边/底色后 R2 断言失效',
    /border/.test(brokenQSlogan) && /background/.test(brokenQSlogan));
  // 变异 18（R3）：导航 handler 不再关关于弹窗 ⇒ R3 断言失效
  const brokenR = appRoot.replace(
    /(onDcOpenCollection\(\(\) => \{)\s*setAboutOpen\(false\);/, '$1');
  check('（可证伪）导航 handler 去掉 setAboutOpen(false) 后 R3 断言失效',
    brokenR !== appRoot &&
    !/onDcOpenCollection\(\(\) => \{\s*setAboutOpen\(false\);/.test(brokenR));
  // 变异 19（P1）：把单位改回组件级 state ⇒ 「按 c.speakRateUnit 读单位」断言失效
  const brokenS = coll.replace(
    'const rateDisplay = resolveRateDisplay(rate, c.speakRateUnit);',
    "const [rateUnit] = useState<SpeakRateUnit>('min');\n            const rateDisplay = resolveRateDisplay(rate, rateUnit);");
  check('（可证伪）单位改回组件级 useState 后 P1「随角色持久化」断言失效',
    brokenS !== coll &&
    /useState<SpeakRateUnit>\('min'\)/.test(stripComments(brokenS)) &&
    !/resolveRateDisplay\(rate, c\.speakRateUnit\)/.test(stripComments(brokenS)));
  // 变异 20（P1）：删掉「不足 1 条」兜底分支 ⇒ P1 兜底断言失效
  const brokenT = coll.replace('rateDisplay.tooSmall', 'false');
  check('（可证伪）去掉 tooSmall 兜底后 P1 兜底断言失效',
    brokenT !== coll && !/rateDisplay\.tooSmall\s*\?/.test(brokenT));
}

// ---------- K15. v3.0.6：VRM 生命感 + 桌宠 3D 分辨率 ----------
check('v3.0.6 VRM 有自驱动呼吸/待机/眨眼（不再静止贴图）',
  /VRM_BREATH_PERIOD_SEC/.test(threeView) &&
  /breathBone\.rotation\.x/.test(threeView) &&
  /headBone,/.test(threeView) && /'head',/.test(threeView) &&
  /autoBlink/.test(threeView) &&
  /VRM_BLINK_MIN_GAP_MS/.test(threeView));
check('v3.0.6 表情名大小写不敏感解析（兼容 VRM0 自定义名 Blink/Joy）',
  /function resolveExpressionNames/.test(threeView) &&
  /function resolveBlinkNames/.test(threeView) &&
  /n\.toLowerCase\(\) === c\.toLowerCase\(\)/.test(threeView) &&
  /blink_l|eyeBlinkLeft/.test(threeView));
// QA P0（v3.0.6）：three-vrm 的 VRMExpression.name 带 VRMExpression_ 前缀，
// 真名在 .expressionName。必须断言读的是真名属性，否则「大小写不敏感」形同虚设。
check('v3.0.6 表情名从 expressionName 读取（QA P0：不能用带前缀的 name）',
  /typeof e\?\.expressionName === 'string' \? e\.expressionName : ''/.test(threeView) &&
  /legacy\.startsWith\('VRMExpression_'\)/.test(threeView) &&
  /\.slice\('VRMExpression_'\.length\)/.test(threeView));
check('v3.0.6 呼吸/待机基于 rest 角度计算，不累加漂移（v3.0.7 统一走 applyBone）',
  /breathBone\.rotation\.x = r\.x - breath \* VRM_BREATH_ANGLE/.test(threeView) &&
  /applyBone\(\s*headBone,/.test(threeView));
check('v3.0.6 VRM0 兼容 rotateVRM0 仍在（老模型朝向）',
  /VRMUtils\.rotateVRM0/.test(threeView));
check('v3.0.6 桌宠传 resolutionScale（最低 1.5× 超采样）',
  /DESKTOP_RESOLUTION_SCALE_MIN = 1\.5/.test(threeView) &&
  /resolutionScale=\{Math\.max\(DESKTOP_RESOLUTION_SCALE_MIN, scale\)\}/.test(appTsx) &&
  /resolutionScale/.test(modelView) &&
  /export const DESKTOP_RESOLUTION_SCALE_MIN/.test(threeView));
check('v3.0.6 pixelRatio 同时含 zoom 与 resolutionScale（舞台行为不变）',
  /dpr \* z \* rs/.test(threeView) &&
  /Math\.min\(MAX_PIXEL_RATIO/.test(threeView) &&
  /\[zoom, resolutionScale\]/.test(threeView));
check('v3.0.6 Live2D 同步支持 resolutionScale（同类模糊一并修）',
  /resolutionScaleRef\.current/.test(l2dView) &&
  /dpr \* z \* rs/.test(l2dView) &&
  /\[zoom, resolutionScale\]/.test(l2dView));
check('v3.0.6 舞台不传 resolutionScale（保持原清晰路径）',
  !/resolutionScale/.test(stage));

// 变异自证 21：去掉自动眨眼调度 ⇒ K15 VRM 生命感断言失效
{
  // 变异 21a：呼吸驱动改成常量（等价于不呼吸）⇒ K15 呼吸断言失效
  const broken = threeView.replace(
    /breathBone\.rotation\.x = r\.x - breath \* VRM_BREATH_ANGLE;/,
    'breathBone.rotation.x = r.x;');
  check('（可证伪）呼吸驱动改成常量后 K15 呼吸断言失效',
    broken !== threeView && !/breathBone\.rotation\.x = r\.x - breath \* VRM_BREATH_ANGLE/.test(broken));
  const broken2 = threeView.replace(
    /autoBlink = Math\.sin\(Math\.PI \* p\);/, 'autoBlink = 0;');
  check('（可证伪）眨眼脉冲改 0 后 K15 眨眼断言失效',
    broken2 !== threeView && !/autoBlink = Math\.sin\(Math\.PI \* p\)/.test(broken2));
  // 变异 22：表情名改精确匹配（VRM0 的 Blink 将识别不到）
  const broken3 = threeView.replace(
    /n\.toLowerCase\(\) === c\.toLowerCase\(\)/, 'n === c');
  check('（可证伪）表情名区分大小写后 K15 兼容断言失效',
    broken3 !== threeView && !/n\.toLowerCase\(\) === c\.toLowerCase\(\)/.test(broken3));
  // 变异 24：表情名读回带前缀的 name（QA P0 回归）⇒ K15 断言失效
  const broken5 = threeView.replace(
    "const real = typeof e?.expressionName === 'string' ? e.expressionName : '';",
    "const real = typeof e?.name === 'string' ? e.name : '';");
  check('（可证伪）表情名改回 name 后 QA P0 断言失效',
    broken5 !== threeView &&
    !/typeof e\?\.expressionName === 'string' \? e\.expressionName : ''/.test(broken5));
  // 变异 23：桌宠不再传 resolutionScale ⇒ 模糊回归
  const broken4 = appTsx.replace(
    'resolutionScale={Math.max(DESKTOP_RESOLUTION_SCALE_MIN, scale)}', '');
  check('（可证伪）桌宠去掉 resolutionScale 后 K15 断言失效',
    broken4 !== appTsx && !/resolutionScale=\{Math\.max\(DESKTOP_RESOLUTION_SCALE_MIN, scale\)\}/.test(broken4));
}

// ---------- K16. v3.0.6：模型包兼容性 ----------
check('v3.0.6 zip 文件名兼容：UTF-8 flag + GBK/CP932 多编码判别',
  /import iconv from 'iconv-lite'/.test(assetsTs) &&
  /function decodeZipName/.test(assetsTs) &&
  /flags_efs \|\| entry\.header\?\.efs/.test(assetsTs) &&
  /iconv\.decode\(raw, 'gbk'\)/.test(assetsTs) &&
  /iconv\.decode\(raw, 'cp932'\)/.test(assetsTs) &&
  /\[\\uff66-\\uff9f\]/.test(assetsTs) &&
  /\[\\u3040-\\u30ff\]/.test(assetsTs));
check('v3.0.6 逐条目按解码后文件名写盘（不用默认 extractAllTo）',
  /fs\.writeFileSync\(target, e\.getData\(\)\)/.test(assetsTs) &&
  !/zip\.extractAllTo\(/.test(assetsTs));
check('v3.0.6 路径穿越按段判断（不误伤合法 .. 文件名）',
  /name\.split\('\/'\)\.some\(\(seg\) => seg === '\.\.'\)/.test(assetsTs));
check('v3.0.6 SVG 立绘纳入支持',
  /'avif', 'svg'/.test(assetsTs) &&
  /MODEL_EXT\.has\(ext\) \|\| IMAGE_EXT\.has\(ext\)/.test(assetsTs) &&
  /extensions: \['png'[^\]]*'svg'/.test(assetsTs));
check('v3.0.6 拖拽单文件用 extOf（兼容 .model3.json 复合后缀）',
  /const ext = extOf\(p\);/.test(assetsTs) &&
  !/const ext = \(p\.split\('\.'\)\.pop\(\) \|\| ''\)\.toLowerCase\(\);/.test(assetsTs));
check('v3.0.6 GLB 多动画选 idle/最长 clip（不只播 [0]）',
  /const prefers = \/\(\?:\\|\^/.test(threeView) &&
  /idle\|loop\|breath\|stand\|taiki\|待機\|アイドル/.test(threeView) &&
  /const named = clips\.find/.test(threeView) &&
  /const longest = clips\.reduce/.test(threeView) &&
  !/mixer\.clipAction\(gltf\.animations\[0\]\)/.test(threeView));
check('v3.0.6 角色切换清空 modelError（错误提示不残留）',
  /setModelError\(''\);[\s\S]{0,80}\[state\.character\?\.id, state\.character\?\.entry\]/.test(appTsx));
check('v3.0.6 iconv-lite 声明为直接依赖',
  /"iconv-lite": "\^0\.7\.3"/.test(read('package.json')));
// ---------- K17. v3.0.7：可见的待机动作（身体/头/手） ----------
// 用区间下限断言（不锁死精确值），日后微调幅度不会误报
const readConst = (name) => {
  const m = threeView.match(new RegExp(`const ${name} = ([0-9.]+);`));
  return m ? parseFloat(m[1]) : NaN;
};
check('v3.0.7 呼吸/头部/手臂/身体幅度达到肉眼可见阈值（>v3.0.6 的不可见幅度）',
  readConst('VRM_BREATH_ANGLE') >= 0.1 &&
  readConst('VRM_BREATH_SCALE') >= 0.025 &&
  readConst('VRM_HEAD_TURN_ANGLE') >= 0.25 &&
  readConst('VRM_HEAD_NOD_ANGLE') >= 0.12 &&
  readConst('VRM_ARM_SWAY_ANGLE') >= 0.14 &&
  readConst('VRM_ARM_SWING_ANGLE') >= 0.14 &&
  readConst('VRM_BODY_SWAY_ANGLE') >= 0.05);
check('v3.0.7 驱动 head / 左右上臂 / hips / spine 骨骼（不止眨眼）',
  /headBone = get\('head'\)/.test(threeView) &&
  /armL = get\('leftUpperArm'\)/.test(threeView) &&
  /armR = get\('rightUpperArm'\)/.test(threeView) &&
  /hipsBone = get\('hips'\)/.test(threeView) &&
  /spineBone = spine/.test(threeView));
check('v3.0.7 呼吸带胸腔缩放起伏（吸气挺胸）',
  /VRM_BREATH_SCALE/.test(threeView) &&
  /breathBone\.scale\.set\(r\.sx \* s, r\.sy \* s, r\.sz \* s\)/.test(threeView));
check('v3.0.7 所有骨骼基于 rest 姿态增量（不累加漂移）',
  /bone\.rotation\.x = r\.x \+ rx/.test(threeView) &&
  /bone\.rotation\.y = r\.y \+ ry/.test(threeView) &&
  /bone\.rotation\.z = r\.z \+ rz/.test(threeView) &&
  /restPose\[key\] = \{/.test(threeView));
check('v3.0.7 双臂左右反相摆动（自然而非整齐划一）',
  /applyBone\(armL, 'leftUpperArm', armSwing[\s\S]{0,80}armWave/.test(threeView) &&
  /applyBone\(armR, 'rightUpperArm', -armSwing[\s\S]{0,80}-armWave/.test(threeView));
// 变异自证 25：把幅度改回 v3.0.6 的不可见值 ⇒ K17 失效
{
  const broken = threeView
    .replace('const VRM_BREATH_ANGLE = 0.12;', 'const VRM_BREATH_ANGLE = 0.019;')
    .replace('const VRM_HEAD_TURN_ANGLE = 0.28;', 'const VRM_HEAD_TURN_ANGLE = 0.023;');
  check('（可证伪）幅度退回 v3.0.6 不可见值后 K17 失效',
    broken !== threeView && !/const VRM_BREATH_ANGLE = 0\.08/.test(broken));
  // 变异 26：去掉手臂驱动 ⇒ K17 失效
  const broken2 = threeView.replace(/applyBone\(armL,[\s\S]{0,180}armWave \* VRM_ARM_SWAY_ANGLE\);/, '');
  check('（可证伪）删掉手臂驱动后 K17 失效',
    broken2 !== threeView && !/applyBone\(armL, 'leftUpperArm'/.test(broken2));
}

// ---------- K18. v3.0.8：VRM 自然站姿 / 视线跟随 / 按角色幅度 ----------
const pose = read('src/character/vrmPose.ts');

// K18-1 三层姿态：rest 快照只读、basePose 一次性探测、writeBone 统一合成。
check('K18-1 三层姿态存在（restPose 冻结 + basePose + writeBone 合成式）',
  /const restPose/.test(threeView) &&
  /restPose\[key\] = \{/.test(threeView) &&
  /basePose: Record<string, Partial<PoseSnapshot>>/.test(pose) &&
  /basePose\[/.test(pose) &&
  /writeBone\(/.test(threeView) &&
  /r\.x \+ b\.x \* blend \+ dx/.test(pose));

// K18-2 自然站姿：世界坐标探测上下臂、atan2 求与竖直夹角、15° 目标与 25° 免修正阈值。
check('K18-2 自然站姿运行时探测（LowerArm / atan2 / 15° 目标 / <25° 不修正）',
  /detectNaturalBase\(vrm, rig\)/.test(threeView) &&
  /getNormalizedBoneNode\?\.\(name\)/.test(pose) &&
  /leftLowerArm/.test(pose) && /rightLowerArm/.test(pose) &&
  /atan2\(Math\.abs\(dirWorld\.x\), -dirWorld\.y\)/.test(pose) &&
  /VRM_BASE_ARM_SLOPE_DEG = 15/.test(pose) &&
  /VRM_ARM_NATURAL_THRESHOLD_DEG = 25/.test(pose));

// K18-3 视线接线：3.4.0 的真实 API 是 target:Object3D + autoUpdate，不存在 lookAt(yaw,pitch)。
check('K18-3 vrm.lookAt.target = gazeMarker（scene 挂载 + autoUpdate 受门禁控制）',
  /vrm\.lookAt\.target = gazeMarker/.test(threeView) &&
  /scene\.add\(gazeMarker\)/.test(threeView) &&
  /autoUpdate = groupOn && !!g\.gaze/.test(threeView) &&
  !/vrm\.lookAt\.lookAt\(/.test(threeView));

// K18-4 视线 prop 全链路：角色窗 dc:cursor 与舞台窗 mousemove 都送到 ThreeModelView。
check('K18-4 eyeX/eyeY 从角色窗与舞台窗贯通到 ThreeModelView',
  /eyeX=\{eye\.x\}/.test(appTsx) && /eyeY=\{eye\.y\}/.test(appTsx) &&
  /eyeX = 0/.test(modelView) &&
  /<ThreeModelView[\s\S]{0,600}eyeX=\{eyeX\}/.test(modelView) &&
  /addEventListener\('mousemove'/.test(stage) &&
  /eyeX=\{eye\.x\}/.test(stage));

// K18-5 数据模型与 UI：幅度按角色、两个子开关按全局。
check('K18-5 motionAmplitude 角色字段 + 卡片滑块 + 两个子开关',
  /motionAmplitude\?: number/.test(types) &&
  /animCharacterIdle\?: boolean/.test(types) &&
  /animCharacterGaze\?: boolean/.test(types) &&
  /motionAmplitude: 1/.test(types) &&
  /patchCharacter\(c\.id, \{ motionAmplitude:/.test(coll) &&
  /MOTION_AMP_STEP = 0\.05/.test(coll) &&
  /animCharacterIdle/.test(settings) && /animCharacterGaze/.test(settings));

// K18-6 三档门禁进入 rAF：所有-off 档不再写骨骼（加载时已落一次自然站姿）。
check('K18-6 VRM rAF 消费 character 三档门禁（不再无条件写骨骼）',
  /gateRef/.test(threeView) &&
  /isGroupEnabled\(settings, 'character'\)/.test(appTsx) &&
  /const groupOn = !!\(g\.motion \|\| g\.gaze\)/.test(threeView) &&
  /if \(groupOn\) \{/.test(threeView) &&
  /autoUpdate = groupOn && !!g\.gaze/.test(threeView));

// K18-7 i18n 10 处：6 新键在 translations.ts（zh+en）与 8 个 JSON 中齐全、非空、占位符一致。
const MOTION_KEYS = [
  'characters.motionAmplitude', 'characters.motionAmplitudeHint', 'characters.motionAmplitudeValue',
  'animCtl.groupCharacterIdle', 'animCtl.groupCharacterGaze', 'animCtl.groupCharacterSubHint',
];
{
  const transOk = MOTION_KEYS.every((key) => {
    const esc = key.replace(/\./g, '\\.');
    return (trans.match(new RegExp(`'${esc}':`, 'g')) || []).length === 2;
  });
  const localesOk = LOCALE_CODES.every((lang) => {
    let json = {};
    try {
      json = JSON.parse(read(`src/i18n/locales/${lang}.json`));
    } catch {
      return false;
    }
    return MOTION_KEYS.every((key) => typeof json[key] === 'string' && json[key].trim()) &&
      json['characters.motionAmplitudeValue'] === '{v}%';
  });
  const placeholdersOk = (trans.match(/'characters\.motionAmplitudeValue': '\{v\}%'/g) || []).length === 2;
  check('K18-7 i18n 10 处一致（6 新键 / 无空值 / {v} 占位符一致）',
    transOk && localesOk && placeholdersOk);
}

// 变异自证：改坏即失败（5 组）
{
  // 1. 删掉 lookAt.target 接线 ⇒ K18-3
  const b1 = threeView.replace('vrm.lookAt.target = gazeMarker;', '');
  check('（可证伪）删掉 lookAt.target 后 K18-3 失效',
    b1 !== threeView && !/vrm\.lookAt\.target = gazeMarker/.test(b1));

  // 2. 删掉自然站姿探测调用 ⇒ K18-2
  const b2 = threeView.replace('detectNaturalBase(vrm, rig);', '');
  check('（可证伪）删掉 detectNaturalBase 调用后 K18-2 失效',
    b2 !== threeView && !/detectNaturalBase\(vrm, rig\)/.test(b2));

  // 3. 只从 ThreeModelView 分支移除 eyeX（占位角色分支仍保留）⇒ K18-4
  const idx = modelView.indexOf('<ThreeModelView');
  const b3 = idx < 0 ? modelView : modelView.slice(0, idx) + modelView.slice(idx).replace('eyeX={eyeX}', '');
  check('（可证伪）ThreeModelView 分支去掉 eyeX 后 K18-4 失效',
    idx >= 0 && b3 !== modelView &&
    !/<ThreeModelView[\s\S]{0,600}eyeX=\{eyeX\}/.test(b3));

  // 4. 幅度默认从 1 改成 0 ⇒ K18-5
  const b4 = types.replace('motionAmplitude: 1,', 'motionAmplitude: 0,');
  check('（可证伪）幅度默认改 0 后 K18-5 失效',
    b4 !== types && !/motionAmplitude: 1/.test(b4));

  // 5. rAF 门禁改硬编码 true ⇒ K18-6
  const b5 = threeView.replace('const groupOn = !!(g.motion || g.gaze);', 'const groupOn = true;');
  check('（可证伪）rAF 门禁改硬编码 true 后 K18-6 失效',
    b5 !== threeView && !/const groupOn = !!\(g\.motion \|\| g\.gaze\)/.test(b5));
}

// ---------- K19. v3.0.9：视线上下方向修正 + 缩放上限 2.0 ----------
check('v3.0.9 视线 pitch 屏幕 Y 翻转（光标往上=抬头，眼球 marker）',
  /pitchRad: -y \* VRM_GAZE_MAX_PITCH_DEG \* DEG2RAD/.test(vrmPose) &&
  /headPos\.y \+ Math\.tan\(pitchRad\) \* VRM_GAZE_DISTANCE/.test(threeView));
check('v3.0.9 头部 gaze.pitch 取反（rotation.x 正值=低头，抬头需负值）',
  /rig\.gaze\.pitch = smooth\(rig\.gaze\.pitch, -pitchRad \* r, dt, VRM_GAZE_SMOOTH_TAU\)/.test(vrmPose) &&
  /\+ gz\.pitch,/.test(threeView));
check('v3.0.9 缩放上限 2.0 主进程/渲染层/类型三处一致',
  /const DC_SCALE_MAX = 2\.0/.test(mainDc) &&
  /Math\.max\(0\.6, Math\.min\(DC_SCALE_MAX, Number\(scale\) \|\| 1\)\)/.test(mainDc) &&
  /const STAGE_ZOOM_MAX = 2\.0/.test(stage) &&
  /显示缩放（0\.6~2\.0/.test(types));
// 变异自证 27：pitch 改回不翻转 ⇒ K19 视线断言失效
{
  const broken = vrmPose.replace(
    'pitchRad: -y * VRM_GAZE_MAX_PITCH_DEG * DEG2RAD,',
    'pitchRad: y * VRM_GAZE_MAX_PITCH_DEG * DEG2RAD,');
  check('（可证伪）pitch 去掉屏幕Y翻转后 K19 视线断言失效',
    broken !== vrmPose && !/pitchRad: -y \* VRM_GAZE_MAX_PITCH_DEG/.test(broken));
  const broken2 = vrmPose.replace(
    'rig.gaze.pitch = smooth(rig.gaze.pitch, -pitchRad * r, dt, VRM_GAZE_SMOOTH_TAU);',
    'rig.gaze.pitch = smooth(rig.gaze.pitch, pitchRad * r, dt, VRM_GAZE_SMOOTH_TAU);');
  check('（可证伪）头部 pitch 去掉取反后 K19 断言失效',
    broken2 !== vrmPose && !/smooth\(rig\.gaze\.pitch, -pitchRad/.test(broken2));
  const broken3 = stage.replace('const STAGE_ZOOM_MAX = 2.0;', 'const STAGE_ZOOM_MAX = 1.6;');
  check('（可证伪）舞台缩放退回 1.6 后 K19 断言失效',
    broken3 !== stage && !/const STAGE_ZOOM_MAX = 2\.0/.test(broken3));
}

// ---------- 汇总 ----------
console.log('\n' + '─'.repeat(70));
if (failures.length === 0) {
  console.log(`✅ 全部通过：${pass} 条断言`);
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 条失败 / 共 ${pass + failures.length} 条：\n`);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
