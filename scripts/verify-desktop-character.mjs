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
const section = (s) => console.log('\n===== ' + s + ' =====');

// ---------- 读取源文件 ----------
const mainDc = read('electron/desktopCharacter.ts');
const assets = read('electron/characterAssets.ts');
const appTsx = read('src/character/CharacterApp.tsx');
const modelView = read('src/character/ModelView.tsx');
const threeView = read('src/character/ThreeModelView.tsx');
const l2dView = read('src/character/Live2DView.tsx');
const coll = read('src/components/CharacterCollection.tsx');
const stage = read('src/components/CharacterStage.tsx');
const charCss = read('src/styles/character.css');
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
const windowLevels = read('electron/windowLevels.ts');
const floatingBall = read('electron/floatingBall.ts');
const chatWin = read('src/components/ChatWindow.tsx');
const miniChat = read('src/components/MiniChat.tsx');

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
check('重新开启会 showInactive 隐藏中的窗口', /isVisible\(\)\)\s*w\.showInactive\(\)/.test(mainDc));

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
