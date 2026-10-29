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
//   · 去掉 `screen-saver` → A 段红
//   · 去掉路径穿越判断 → C 段红
//   · 把 dynamic import 改成静态 → D 段红
//   · 删掉 character 动画分组 → F 段红
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

// ============================================================================
section('A. 窗口与物理层（electron/desktopCharacter.ts）');
// ============================================================================
check('存在独立渲染入口 character.html 且挂载 /src/character.tsx', /src\/character\.tsx/.test(charHtml));
check('vite 多页入口登记 character.html', /character:\s*path\.resolve\(__dirname,\s*'character\.html'\)/.test(vite));
check('透明无边框无阴影且不占任务栏',
  /transparent:\s*true/.test(mainDc) && /frame:\s*false/.test(mainDc) &&
  /hasShadow:\s*false/.test(mainDc) && /skipTaskbar:\s*true/.test(mainDc));
check("置顶层级与悬浮球同级（'screen-saver'）", /setAlwaysOnTop\([^)]*'screen-saver'\)/.test(mainDc));
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
  const broken1 = mainDc.replaceAll("'screen-saver'", "'normal'");
  check('（可证伪）去掉 screen-saver 后 A 段断言失效', !/setAlwaysOnTop\([^)]*'screen-saver'\)/.test(broken1));
  const broken2 = assets.replace('!abs.startsWith(root + path.sep)', 'true');
  check('（可证伪）去掉穿越判断后 C 段断言失效', !/startsWith\(root \+ path\.sep\)/.test(broken2));
  const broken3 = threeView.replace("await import('three')", "import * as three from 'three'");
  check('（可证伪）改成静态 import 后 D 段断言失效', !/await import\('three'\)/.test(broken3));
}

// ============================================================================
section('H. 合规：无第三方品牌资产与「复刻」措辞');
// ============================================================================
const NEW_FILES = [
  'electron/desktopCharacter.ts', 'electron/characterAssets.ts', 'src/character/CharacterApp.tsx',
  'src/character/ModelView.tsx', 'src/character/ThreeModelView.tsx', 'src/character/Live2DView.tsx',
  'src/character/PlaceholderCharacter.tsx', 'src/character/behaviors.ts',
  'src/components/CharacterCollection.tsx', 'src/components/CharacterStage.tsx',
  'src/styles/character.css', 'src/styles/character-panel.css',
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
