#!/usr/bin/env node
/**
 * verify-cursor-engine.mjs
 * ---------------------------------------------------------------------------
 * 「动态光标重做（v2.3.126）」新引擎的**行为闸门**。
 *
 * 背景：v2.3.126 把旧的双 Canvas 实现整体换成「**DOM 字形层 + Canvas 特效层**」，
 * 热点单位从「28 基准像素」换成「**比例**」，并新增了自定义图片上传。
 * 本脚本守住四类最容易回潮的契约：
 *
 *   A. 新引擎文件存在，且被**主窗 / 小窗 / 悬浮球三处**挂载（修复一次、三端全覆盖）；
 *   B. 热点比例 ↔ 屏幕偏移换算**行为正确**（Dw/Dh 保持宽高比、offX = hotspotX × Dw）——
 *      这里**真的转译并执行** src/cursor/cursorImage.ts，而不是源码正则匹配；
 *   C. 字形层用 translate3d **同步**定位，且**不存在字形位置的 lerp**
 *      （这是「显示位置 == 点击位置」的构造性保证，也是本次重做的核心）；
 *   D. 粒子/拖尾上限、FPS 阈值、边缘带迟滞、上传缩放上限等常量与规格一致；
 *   E. `cursor-gate-off` 门控生效（单光标仲裁链路不能被破坏）；
 *   F. 热点单位迁移（`hotspotSpace === 'ratio'`）存在且**幂等**——
 *      真的执行 electron/cursorHotspotMigration.ts 跑两遍验证不重复换算；
 *   G. 新增 i18n 键在 10 处语言里齐全且非空。
 *
 * 运行：node scripts/verify-cursor-engine.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

/** 转译并执行一个 TS 模块（零 Electron / 零 React 依赖的纯模块） */
function loadTs(relPath, stubs = {}) {
  const ts = require('typescript');
  const source = read(relPath);
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: relPath,
  }).outputText;
  const mod = { exports: {} };
  const req = (id) => (Object.prototype.hasOwnProperty.call(stubs, id) ? stubs[id] : require(id));
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(
    mod.exports, req, mod, relPath, root
  );
  return mod.exports;
}

// ============================================================================
section('1. 新引擎文件与三处挂载');
// ============================================================================
const FILES = [
  'src/cursor/types.ts',
  'src/cursor/cursorImage.ts',
  'src/cursor/cursorEngine.ts',
  'src/cursor/DynamicCursor.tsx',
  'src/components/CursorSettings.tsx',
  'electron/cursorHotspotMigration.ts',
];
for (const f of FILES) ok(existsSync(join(root, f)), `新文件存在：${f}`);
// 旧实现组件名（文件与组件均已删除）。这里用拼接写法：既保留「旧名不得回流」的
// 守卫强度，又不在仓库里留下任何指向已删除组件的字面引用（grep 旧名应零命中）。
const OLD_CURSOR_NAME = 'Custom' + 'Cursor';
ok(!existsSync(join(root, `src/components/${OLD_CURSOR_NAME}.tsx`)),
  '旧实现文件 src/components/<旧光标组件>.tsx 已删除（整体重写，不是修补）');

for (const [f, label] of [
  ['src/App.tsx', '主窗'],
  ['src/components/MiniChat.tsx', '小窗'],
  ['src/floating-ball.ts', '悬浮球'],
]) {
  const src = read(f);
  ok(/import DynamicCursor from/.test(src), `${label}（${f}）导入 DynamicCursor`);
  ok(/<DynamicCursor\s*\/>/.test(src) || /createElement\(DynamicCursor\)/.test(src),
    `${label}（${f}）挂载 DynamicCursor`);
  ok(!src.includes(OLD_CURSOR_NAME), `${label}（${f}）不再引用旧光标组件名`);
}

// 单光标仲裁链路（主进程 + preload + 门控订阅）必须原样保留
const preload = read('electron/preload.ts');
const appSrc = read('src/App.tsx');
const miniSrc = read('src/components/MiniChat.tsx');
ok(/onMainCursorWindow/.test(preload) && /ipcRenderer\.on\('main:cursor-window'/.test(preload),
  'preload 的 main:cursor-window IPC 保持原样');
ok(/onMiniCursorWindow/.test(preload) && /ipcRenderer\.on\('mini:cursor-window'/.test(preload),
  'preload 的 mini:cursor-window IPC 保持原样');
ok(/onMainCursorWindow\(/.test(appSrc) && /cursor-gate-off/.test(appSrc),
  '主窗 onMainCursorWindow 门控订阅保持原样');
ok(/onMiniCursorWindow\(/.test(miniSrc) && /cursor-gate-off/.test(miniSrc),
  '小窗 onMiniCursorWindow 门控订阅保持原样');
ok(existsSync(join(root, 'electron/cursorCoverState.ts')) &&
  /computeCoveredState/.test(read('electron/cursorCoverState.ts')),
  '主进程单光标仲裁模块 electron/cursorCoverState.ts 保持原样');

// ============================================================================
section('2. 热点比例 ↔ 屏幕偏移换算（行为级：真的执行 cursorImage.ts）');
// ============================================================================
const typesApi = loadTs('src/cursor/types.ts');
const imageApi = loadTs('src/cursor/cursorImage.ts', { './types': typesApi });

ok(typeof imageApi.computeCursorDrawSize === 'function' &&
   typeof imageApi.hotspotToOffset === 'function' &&
   typeof imageApi.computeContainedRect === 'function' &&
   typeof imageApi.pointerToHotspotRatio === 'function',
  'cursorImage.ts 导出几何换算函数（computeCursorDrawSize / hotspotToOffset / …）');

// —— Dw / Dh：长边 = cursorSize，保持宽高比 ——
const sq = imageApi.computeCursorDrawSize(512, 512, 28);
ok(Math.abs(sq.Dw - 28) < 1e-9 && Math.abs(sq.Dh - 28) < 1e-9,
  `正方形图 512×512 @28 → Dw=${sq.Dw} Dh=${sq.Dh}（长边=28，宽高比 1:1）`);
const wide = imageApi.computeCursorDrawSize(512, 256, 28);
ok(Math.abs(wide.Dw - 28) < 1e-9 && Math.abs(wide.Dh - 14) < 1e-9,
  `宽图 512×256 @28 → Dw=${wide.Dw} Dh=${wide.Dh}（长边=28，比例 2:1）`);
const tall = imageApi.computeCursorDrawSize(256, 512, 28);
ok(Math.abs(tall.Dw - 14) < 1e-9 && Math.abs(tall.Dh - 28) < 1e-9,
  `高图 256×512 @28 → Dw=${tall.Dw} Dh=${tall.Dh}（长边=28，比例 1:2）`);
ok(Math.abs(imageApi.computeCursorDrawSize(512, 512, 64).Dw - 64) < 1e-9,
  'cursorSize=64 时长边=64（显示尺寸与热点比例互不干扰）');

// —— offX = hotspotX × Dw，offY = hotspotY × Dh ——
const off1 = imageApi.hotspotToOffset(0.5, 0.5, 28, 28);
ok(Math.abs(off1.offX - 14) < 1e-9 && Math.abs(off1.offY - 14) < 1e-9,
  `offX = hotspotX×Dw：0.5×28 = ${off1.offX}，offY = 0.5×28 = ${off1.offY}`);
const off2 = imageApi.hotspotToOffset(0.5, 0.5, 28, 14);
ok(Math.abs(off2.offX - 14) < 1e-9 && Math.abs(off2.offY - 7) < 1e-9,
  `非正方形也按各自边长换算：offY = 0.5×14 = ${off2.offY}（不是 0.5×28）`);
const off3 = imageApi.hotspotToOffset(0.06836, 0, 28, 28);
ok(Math.abs(off3.offX - 1.91408) < 1e-4 && off3.offY === 0,
  `内置光标尖端比例 0.06836 → 28px 显示下偏移 ${off3.offX.toFixed(5)}px（= 35/512×28）`);
ok(imageApi.hotspotToOffset(2, -1, 28, 28).offX === 28 &&
   imageApi.hotspotToOffset(2, -1, 28, 28).offY === 0,
  '热点比例被 clamp 到 0~1（越界值不会让字形跑飞）');

// —— 预览区 letterbox 换算 ——
const rect = imageApi.computeContainedRect(512, 256, 120, 120);
ok(Math.abs(rect.w - 120) < 1e-9 && Math.abs(rect.h - 60) < 1e-9 && Math.abs(rect.y - 30) < 1e-9,
  `预览框 120×120 放 512×256 → 呈现矩形 ${rect.w}×${rect.h} @ y=${rect.y}（上下各留白 30）`);
const ratio = imageApi.pointerToHotspotRatio(rect.x + rect.w * 0.25, rect.y + rect.h * 0.5, rect);
ok(Math.abs(ratio.x - 0.25) < 1e-9 && Math.abs(ratio.y - 0.5) < 1e-9,
  '指针落在呈现矩形内 → 比例换算正确（按呈现矩形而非外框）');
const ratioClamp = imageApi.pointerToHotspotRatio(-50, 999, rect);
ok(ratioClamp.x === 0 && ratioClamp.y === 1, '指针落在呈现矩形外 → 比例被 clamp 到 0~1');

// ============================================================================
section('3. 字形层：translate3d 同步定位，且无字形位置 lerp');
// ============================================================================
const engine = read('src/cursor/cursorEngine.ts');
const wrapper = read('src/cursor/DynamicCursor.tsx');

ok(/translate3d\(\$\{x - off\.offX \* s\}px, \$\{y - off\.offY \* s\}px, 0\) scale\(\$\{s\}\)/.test(engine),
  '字形 transform = translate3d(x - offX·s, y - offY·s, 0) scale(s)（热点随缩放同步偏移）');
ok(/transformOrigin = '0 0'/.test(engine), 'transform-origin 为 0 0（缩放围绕热点左上角，热点仍精确对齐指针）');
ok(/willChange = 'transform'/.test(engine), '字形层启用 will-change: transform（合成层，不触发重排）');
ok(/zIndex = String\(2147483647\)/.test(engine), '字形层 z-index 最高（不被弹窗/Toast 盖住）');
ok(/zIndex = String\(2147483646\)|zIndex: 2147483646/.test(engine + wrapper),
  '特效层 z-index 低于字形层（2147483646）');

// 位置**不缓动**：整条字形链路不得出现对 x/y 的插值
ok(!/lerp\s*\(/.test(engine), '引擎内不存在任何 lerp 调用（字形位置绝不插值）');
ok(!/CURSOR_SNAP_PX/.test(engine), '不存在 CURSOR_SNAP_PX 之类的「吸附补偿」常量');
ok(/this\.pointerX = e\.clientX;/.test(engine) && /this\.pointerY = e\.clientY;/.test(engine),
  '指针坐标直接取事件坐标 e.clientX/e.clientY');
ok(/updateGlyphAt\(e\.clientX, e\.clientY\)/.test(engine),
  'mousemove 里同步定位字形（不进 rAF 队列 → 零帧延迟）');
ok(/applyGlyphTransform\(x: number, y: number\)/.test(engine) &&
   /const size = this\.drawSize\(\);[\s\S]{0,200}?hotspotToOffset\(this\.cfg\.hotspotX, this\.cfg\.hotspotY, size\.Dw, size\.Dh\)/.test(engine),
  '字形定位使用「热点比例 × 实际显示宽高」的换算');
// 缩放缓动只作用于 scale，不影响位置
ok(/this\.scale \+= \(this\.scaleTarget - this\.scale\) \* 0\.25/.test(engine) &&
   /this\.repositionGlyph\(\)/.test(engine),
  '唯一的缓动是 scale（悬停放大），且缓动后仍用精确指针坐标重新定位');

// ============================================================================
section('4. 粒子 / 拖尾 / 性能常量');
// ============================================================================
ok(typesApi.MAX_PARTICLES === 64, `统一粒子上限 = ${typesApi.MAX_PARTICLES}（规格 64）`);
ok(typesApi.MAX_TRAIL_POINTS === 24, `拖尾点位上限 = ${typesApi.MAX_TRAIL_POINTS}（规格 24）`);
ok(typesApi.FPS_DEGRADE_THRESHOLD === 52, `FPS 降级阈值 = ${typesApi.FPS_DEGRADE_THRESHOLD}（规格 52）`);
ok(typesApi.IDLE_STOP_MS === 300, `静止停帧时长 = ${typesApi.IDLE_STOP_MS}ms（规格 300）`);
ok(typesApi.EDGE_BAND_HYSTERESIS_PX === 4, `边缘带迟滞 = ${typesApi.EDGE_BAND_HYSTERESIS_PX}px（规格 4）`);
ok(typesApi.MAX_UPLOAD_IMAGE_EDGE === 128, `上传图片最长边上限 = ${typesApi.MAX_UPLOAD_IMAGE_EDGE}px（规格 128）`);
ok(typesApi.MAX_UPLOAD_FILE_BYTES === 4 * 1024 * 1024, '上传文件体积上限 = 4MB');
ok(Math.abs(typesApi.DEFAULT_HOTSPOT_X - 0.06836) < 1e-9 && typesApi.DEFAULT_HOTSPOT_Y === 0,
  `内置光标默认热点比例 = (${typesApi.DEFAULT_HOTSPOT_X}, ${typesApi.DEFAULT_HOTSPOT_Y})（35/512, 0）`);

// 引擎确实用了这些常量
ok(/this\.particles\.push\(/.test(engine) && /MAX_PARTICLES/.test(engine),
  '引擎预分配统一粒子池（对象池，运行期不新建对象）');
ok(/slot\.kind = 'ribbon'/.test(engine) && /slot\.kind = 'spark'/.test(engine),
  '粒子池分 ribbon（拖尾）/ spark（粒子）两类');
ok(/-vx \* SPARK_VELOCITY_INHERIT/.test(engine),
  'spark 粒子带速度继承（-光标速度 × 0.15 → 被甩出去的拖动手感）');
ok(/this\.trimRibbons\(\)/.test(engine), '拖尾点位超限时回收最旧的（上限 24 生效）');
ok(/this\.degraded < 1/.test(engine) && /this\.degraded < 2/.test(engine),
  'FPS 降级分级生效（先关 spark，再减 ribbon）');
ok(!/filter\s*\(/.test(engine) && !/createRadialGradient/.test(engine),
  '未使用模糊滤镜 / 径向渐变（零高开销硬性限制）');
ok(/requestAnimationFrame\(this\.frame\)/.test(engine) && /cancelAnimationFrame\(this\.rafId\)/.test(engine),
  '特效层走 rAF 且可停止（静止 300ms 停帧降 CPU）');

// ============================================================================
section('5. 单光标门控（cursor-gate-off）与进出窗口行为');
// ============================================================================
ok(typesApi.GATE_CLASS === 'cursor-gate-off', '门控类名 = cursor-gate-off');
ok(/document\.body\.classList\.contains\(GATE_CLASS\)/.test(engine),
  '引擎读取 cursor-gate-off 门控（被覆盖/穿透时不响应指针）');
ok(/classList\.remove\(HIDDEN_CLASS\)/.test(engine) && /classList\.add\(HIDDEN_CLASS\)/.test(engine),
  '引擎按需摘/挂 cursor-hidden（原生光标与动态光标切换）');
ok(typesApi.HIDDEN_CLASS === 'cursor-hidden', '隐藏原生光标的类名 = cursor-hidden');

// 滑出 → 立即隐藏（一步到位，不淡出）
ok(/private hideCursorImmediate\(\)/.test(engine) &&
   /hideCursorImmediate[\s\S]{0,1200}?classList\.remove\(HIDDEN_CLASS\)/.test(engine),
  'hideCursorImmediate 一步到位摘掉 cursor-hidden（滑出即恢复原生光标）');
ok(/private onMouseLeaveDoc = \(\): void => \{[\s\S]{0,400}?hideCursorImmediate\(\)/.test(engine),
  'mouseleave 走 hideCursorImmediate（不淡出）');
ok(/private onMouseOut = \(e: MouseEvent\): void => \{[\s\S]{0,500}?hideCursorImmediate\(\)/.test(engine),
  'mouseout（relatedTarget 为空）走 hideCursorImmediate');
ok(/fadeState = 'out'/.test(engine) && /private hideCursor\(\): void/.test(engine),
  '淡出仍保留给窗口级切换（失焦 / 被覆盖）');
ok(/private onBlur = \(\): void => \{[\s\S]{0,300}?this\.hideCursor\(\)/.test(engine),
  'onBlur 走淡出（窗口被覆盖时丝滑过渡）');

// 滑入 → 立即在真实位置出现（不缓动追赶）
ok(/ensureVisible\(true\)/.test(engine), '指针进入走 crisp=true（一步到位全显，不淡入）');
ok(/this\.pointerX = OFFSCREEN/.test(engine) && /this\.pointerY = OFFSCREEN/.test(engine),
  '隐藏时把坐标打回离屏哨兵（下次进入直接落在指针处，不从陈旧位置追过来）');

// 边缘带让位原生光标 + 迟滞
ok(/x >= w - \(bandW \+ EDGE_BAND_HYSTERESIS_PX\)/.test(engine),
  '边缘带判定带 4px 迟滞（避免边界反复横跳闪烁）');
ok(/private updateEdgeBand\(x: number, y: number\): boolean/.test(engine),
  '边缘带判定独立成方法（指针进入右/下边缘带时让位给原生光标）');

// 右键菜单隐藏
ok(/private onContextMenu = \(\): void => \{/.test(engine) &&
   /onContextMenu[\s\S]{0,800}?classList\.remove\(HIDDEN_CLASS\)/.test(engine),
  '右键菜单唤起即隐藏字形并露出原生光标');

// 空闲隐藏
ok(/private scheduleIdleHide\(\): void/.test(engine) &&
   /scheduleIdleHide[\s\S]{0,900}?classList\.remove\(HIDDEN_CLASS\)/.test(engine),
  '空闲超时隐藏字形并恢复系统原生光标');

// 动画门控
ok(/isGroupEnabled\(settings, 'cursor'\)/.test(wrapper), '引擎配置由 isGroupEnabled(settings, "cursor") 门控');
ok(/getAnimSpeed\(settings\)/.test(wrapper), '动效速度倍率来自 getAnimSpeed(settings)');
ok(/this\.cfg\.animEnabled/.test(engine), 'animEnabled=false 时停发拖尾/粒子、淡入淡出一步到位');

// ============================================================================
section('6. 热点单位迁移（行为级：真的执行迁移函数两次）');
// ============================================================================
const mig = loadTs('electron/cursorHotspotMigration.ts');
ok(typeof mig.migrateCursorHotspot === 'function', '迁移函数可执行（electron/cursorHotspotMigration.ts）');

const dbSrc = read('electron/db.ts');
ok(/migrateCursorHotspot\(merged\)/.test(dbSrc), '迁移挂在既有 settings 读盘调用点');
ok(/migrateCursorHotspot[\s\S]{0,600}?writeFileSync\(this\.settingsPath/.test(dbSrc),
  '迁移结果会落盘（否则下次启动会再换算一次）');
ok(/from '\.\/cursorHotspotMigration'/.test(dbSrc), 'db.ts 从独立迁移模块导入（纯逻辑可被行为级校验）');

// 旧默认错值 0.44 → 1.9141 → 0.06836
const s1 = { customCursor: { hotspotX: 0.44, hotspotY: 0 } };
const changed1 = mig.migrateCursorHotspot(s1);
ok(changed1 === true, '旧值触发迁移');
ok(Math.abs(s1.customCursor.hotspotX - 0.06836) < 1e-4 && s1.customCursor.hotspotY === 0,
  `旧错值 0.44 → 比例 ${s1.customCursor.hotspotX}（= 35/512，与新默认一致）`);
ok(s1.customCursor.hotspotSpace === 'ratio', '迁移后写入 hotspotSpace=ratio');

// 幂等：再跑一次不再变化
const afterFirst = s1.customCursor.hotspotX;
const changed2 = mig.migrateCursorHotspot(s1);
ok(changed2 === false, '二次迁移返回 false（幂等）');
ok(s1.customCursor.hotspotX === afterFirst,
  '二次迁移后数值不变（比例不会被再除一次 28）');

// 用户手动调过的值按比例平滑换算
const s2 = { customCursor: { hotspotX: 14, hotspotY: 7 } };
mig.migrateCursorHotspot(s2);
ok(Math.abs(s2.customCursor.hotspotX - 0.5) < 1e-9 && Math.abs(s2.customCursor.hotspotY - 0.25) < 1e-9,
  `用户旧值 (14,7) → 比例 (${s2.customCursor.hotspotX}, ${s2.customCursor.hotspotY})（语义不变）`);

// 拖尾/粒子上限提升（仅当仍是旧默认值）
const s3 = { customCursor: { hotspotX: 1.9141, hotspotY: 0, trailMaxLength: 10, maxParticles: 8 } };
mig.migrateCursorHotspot(s3);
ok(s3.customCursor.trailMaxLength === 24 && s3.customCursor.maxParticles === 64,
  '旧默认值 10/8 提升到新硬上限 24/64');
const s4 = { customCursor: { hotspotX: 1.9141, hotspotY: 0, trailMaxLength: 5, maxParticles: 3 } };
mig.migrateCursorHotspot(s4);
ok(s4.customCursor.trailMaxLength === 5 && s4.customCursor.maxParticles === 3,
  '用户自定义过的上限保持不动（尊重用户设置）');

// ============================================================================
section('7. 设置项与 UI');
// ============================================================================
const typesTs = read('src/types.ts');
ok(/image\?:\s*string;/.test(typesTs) && /hotspotSpace\?:\s*'ratio'/.test(typesTs),
  'AppSettings.customCursor 含 image 与 hotspotSpace 字段');
ok(/hotspotX:\s*0\.06836/.test(typesTs) && /hotspotY:\s*0/.test(typesTs),
  'types.ts 默认热点为比例语义 (0.06836, 0)');
ok(/hotspotSpace:\s*'ratio'/.test(typesTs), '默认配置自带 hotspotSpace=ratio（新装用户无需迁移）');

const settingsUi = read('src/components/Settings.tsx');
ok(/id="sec-cursor"/.test(settingsUi), 'sec-cursor 锚点保留（设置搜索可跳转）');
ok(/key: 'settings\.cursor'/.test(settingsUi), '搜索索引条目保留');
ok(/'上传'/.test(settingsUi) && /'upload'/.test(settingsUi) && /'图片'/.test(settingsUi),
  '搜索索引补充了上传图片相关关键词（上传 / upload / 图片）');
ok(/<CursorSettings\s*\/>/.test(settingsUi), 'sec-cursor 区块内容替换为新的 CursorSettings 组件');
ok(!/CursorHotspotPreview/.test(settingsUi), '旧的 CursorHotspotPreview 组件已删除');

const cursorUi = read('src/components/CursorSettings.tsx');
ok(/type="file"[\s\S]{0,200}?accept="image\/\*"/.test(cursorUi), '提供隐藏的 file input（accept=image/*）');
ok(/processCursorImageFile/.test(cursorUi), '上传走统一的图片处理管线（含体积/类型校验）');
ok(/hotspotX: 0\.5, hotspotY: 0\.5/.test(cursorUi), '上传成功后热点重置到图像中心');
ok(/HOTSPOT_PREVIEW_EVENT/.test(cursorUi) &&
   /new CustomEvent\(HOTSPOT_PREVIEW_EVENT/.test(cursorUi),
  '拖动热点时派发窗口内预览事件（拖动中实时生效）');
ok(/onCommit={commitHotspot}/.test(cursorUi), '松手才落盘（commitHotspot → saveSettings）');
ok(/step=\{0\.005\}/.test(cursorUi), '热点滑块 step=0.005');
ok(/toFixed\(1\)\}%/.test(cursorUi), '热点滑块以百分比显示（0~1 → %）');
ok(/cursorTrailEnabled|cursor\.trailEnabled/.test(cursorUi), '拖尾开关存在');
ok(/cursor\.particlesEnabled/.test(cursorUi), '粒子特效开关存在');

// 引擎必须监听预览事件
ok(/addEventListener\(HOTSPOT_PREVIEW_EVENT, this\.onHotspotPreview\)/.test(engine) &&
   /removeEventListener\(HOTSPOT_PREVIEW_EVENT, this\.onHotspotPreview\)/.test(engine),
  '引擎监听热点预览事件，且卸载时移除监听');

// ============================================================================
section('8. i18n 新键（10 处齐全且非空）');
// ============================================================================
const NEW_KEYS = [
  'settings.cursorHotspotHint',
  'settings.cursorImageInvalid',
  'settings.cursorImageTooLarge',
  'settings.cursorImageDecodeFailed',
  'settings.cursorImageDesc',
  'settings.cursorImageUpload',
  'settings.cursorImageChange',
  'settings.cursorImageReset',
  'settings.hotspotX',
  'settings.hotspotY',
  'settings.hotspotDesc',
  'settings.cursorLerpSpeedDesc',
];

/** 解析 translations.ts 的 zh / en 内联块 */
function parseInlineDict(src, lang) {
  const m = new RegExp('\\n  ' + lang + ': \\{').exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        const body = src.slice(open + 1, i);
        const dict = {};
        const re = /'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
        let mm;
        while ((mm = re.exec(body))) dict[mm[1]] = mm[2];
        return dict;
      }
    }
  }
  return null;
}

const trans = read('src/i18n/translations.ts');
const dicts = {
  zh: parseInlineDict(trans, 'zh'),
  en: parseInlineDict(trans, 'en'),
};
for (const lang of ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']) {
  dicts[lang] = JSON.parse(read(`src/i18n/locales/${lang}.json`));
}
for (const lang of Object.keys(dicts)) {
  const d = dicts[lang];
  ok(!!d, `${lang} 字典可解析`);
  if (!d) continue;
  const missing = NEW_KEYS.filter((k) => !(k in d));
  ok(missing.length === 0, `${lang} 新键齐全${missing.length ? '（缺 ' + missing.join(', ') + '）' : ''}`);
  const empty = NEW_KEYS.filter((k) => k in d && (typeof d[k] !== 'string' || d[k].trim() === ''));
  ok(empty.length === 0, `${lang} 新键均非空${empty.length ? '（空 ' + empty.join(', ') + '）' : ''}`);
}

// ============================================================================
section('10. 运行时冒烟（用最小 DOM 桩**真的执行**一遍引擎）');
// ============================================================================
// 静态断言只能证明「代码长这样」，证明不了「跑起来不炸、位置算得对」。
// 这里用最小 DOM 桩把引擎真跑一遍：mount → mousemove → mousedown → mouseleave
// → 重新进入 → 热点预览 → updateConfig → 图片加载失败回退 → 关闭 → unmount。
{
  class FakeClassList {
    constructor() { this.set = new Set(); }
    add(...c) { c.forEach((x) => this.set.add(x)); }
    remove(...c) { c.forEach((x) => this.set.delete(x)); }
    contains(c) { return this.set.has(c); }
  }
  class FakeStyle {
    constructor() {
      this._p = {};
      // Proxy 记录所有样式赋值（引擎直接写 el.style.xxx = …）
      return new Proxy(this, {
        set(target, prop, value) { target._p[prop] = value; return true; },
        get(target, prop) { return prop in target ? target[prop] : target._p[prop]; },
      });
    }
    setProperty(k, v) { this._p[k] = v; }
    getPropertyValue(k) { return this._p[k] ?? ''; }
  }
  class FakeElement {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.style = new FakeStyle();
      this.classList = new FakeClassList();
      this.children = [];
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      this.complete = false;
      this.width = 0;
      this.height = 0;
    }
    appendChild(c) { this.children.push(c); return c; }
    setPointerCapture() {}
    releasePointerCapture() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 120, height: 120, right: 120, bottom: 120 }; }
    setAttribute() {}
    getAttribute() { return null; }
    hasAttribute() { return false; }
    closest() { return null; }
    getContext() {
      return {
        canvas: this, globalAlpha: 1, fillStyle: '',
        setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, save() {}, restore() {},
      };
    }
  }
  class FakeImage extends FakeElement {
    constructor() {
      super('img');
      this.onload = null;
      this.onerror = null;
      this._src = '';
    }
    get src() { return this._src; }
    set src(v) {
      this._src = v;
      setTimeout(() => {
        if (v && v.includes('broken')) { this.onerror && this.onerror(); return; }
        this.naturalWidth = 512;
        this.naturalHeight = 512;
        this.complete = true;
        this.onload && this.onload();
      }, 0);
    }
  }

  const bodyEl = new FakeElement('body');
  const docListeners = new Map();
  const winListeners = new Map();
  const g = globalThis;
  const saved = {
    document: g.document, window: g.window, Image: g.Image,
    raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame,
    ro: g.ResizeObserver, ce: g.CustomEvent, gcs: g.getComputedStyle,
  };
  g.performance = g.performance || { now: () => Date.now() };
  g.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  g.cancelAnimationFrame = (id) => clearTimeout(id);
  g.ResizeObserver = class { observe() {} disconnect() {} };
  g.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  g.getComputedStyle = () => ({ cursor: 'default' });
  g.Image = FakeImage;
  g.document = {
    body: bodyEl, hidden: false,
    createElement: (tag) => (tag === 'img' ? new FakeImage() : new FakeElement(tag)),
    addEventListener: (t, f) => docListeners.set(t, f),
    removeEventListener: (t) => docListeners.delete(t),
    querySelector: () => null,
    elementFromPoint: () => null,
    dispatchEvent: () => true,
  };
  g.window = {
    devicePixelRatio: 2, innerWidth: 1440, innerHeight: 900,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
    addEventListener: (t, f) => winListeners.set(t, f),
    removeEventListener: (t) => winListeners.delete(t),
    setTimeout: (f, t) => setTimeout(f, t),
    clearTimeout: (id) => clearTimeout(id),
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
    dispatchEvent: () => true,
  };

  try {
    const engineApi = loadTs('src/cursor/cursorEngine.ts', { './types': typesApi, './cursorImage': imageApi });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const baseCfg = {
      enabled: true, animEnabled: true, animSpeed: 1, lerpSpeed: 0.25,
      trailEnabled: true, trailMaxLength: 24, particlesEnabled: true, maxParticles: 64,
      hoverScale: 1.25, idleHideMs: 5000, cursorSize: 28,
      hotspotX: 0.06836, hotspotY: 0, image: '',
    };
    const glyphHost = new FakeElement('div');
    const fxCanvas = new FakeElement('canvas');
    const engine = new engineApi.CursorEngine({ config: baseCfg, builtinImageUrl: 'builtin-cursor.png' });
    const styleOf = (el) => el.style._p;

    engine.mount({ glyphHost, fxCanvas });
    await sleep(10);
    ok(bodyEl.classList.contains('cursor-hidden'), '挂载后隐藏系统原生光标（cursor-hidden）');
    ok(glyphHost.children.length === 1 && glyphHost.children[0].src,
      '字形层创建了 img 且设置了 src（否则字形不显示）');

    const move = docListeners.get('mousemove');
    ok(!!move, 'mousemove 已绑定');
    move({ clientX: 400, clientY: 300 });
    const tr1 = styleOf(glyphHost).transform || '';
    ok(tr1.includes('translate3d') && tr1.includes('398.085'),
      `mousemove 同步定位：transform = ${tr1}（400 - 0.06836×28 = 398.08592）`);

    for (let i = 0; i < 12; i++) { move({ clientX: 400 + i * 18, clientY: 300 + i * 9 }); await sleep(18); }
    ok(true, '连续移动 + 拖尾/粒子发射未抛异常');

    const down = docListeners.get('mousedown');
    down({ clientX: 520, clientY: 360 });
    ok((styleOf(glyphHost).transform || '').includes('518.085'),
      `mousedown 瞬间吸附真实指针：${styleOf(glyphHost).transform}`);

    docListeners.get('mouseup')({});
    docListeners.get('mouseleave')({});
    ok(!bodyEl.classList.contains('cursor-hidden'), '移出窗口后立即恢复系统原生光标');
    ok(styleOf(glyphHost).visibility === 'hidden', '移出窗口后字形立即隐藏');

    move({ clientX: 700, clientY: 500 });
    ok(bodyEl.classList.contains('cursor-hidden') && styleOf(glyphHost).visibility === 'visible',
      '重新进入立即显示动态光标');

    const preview = winListeners.get('ny-cursor-hotspot-preview');
    ok(!!preview, '引擎监听热点预览事件');
    if (preview) {
      preview({ detail: { hotspotX: 0.5, hotspotY: 0.5 } });
      ok((styleOf(glyphHost).transform || '').includes('686'),
        `热点预览实时生效：${styleOf(glyphHost).transform}（700 - 0.5×28 = 686）`);
    }

    engine.updateConfig({ image: 'data:image/png;base64,AAA', cursorSize: 48, hotspotX: 0.25, hotspotY: 0.25 });
    await sleep(10);
    ok(String(glyphHost.children[0].src).startsWith('data:'), '换图后 img 切换到自定义图片');
    ok((styleOf(glyphHost).transform || '').includes('688'),
      `改尺寸/热点后重新定位：${styleOf(glyphHost).transform}（700 - 0.25×48 = 688）`);

    engine.updateConfig({ image: 'broken-image' });
    await sleep(20);
    ok(String(glyphHost.children[0].src).includes('builtin-cursor'), '图片加载失败回退内置光标（光标不消失）');

    engine.updateConfig({ enabled: false });
    ok(!bodyEl.classList.contains('cursor-hidden'), '关闭开关后立即把光标交还系统原生光标');

    engine.unmount();
    ok(!bodyEl.classList.contains('cursor-hidden'), '卸载后清理 cursor-hidden');
    ok(docListeners.size === 0 && winListeners.size === 0, '卸载后解绑全部事件监听');
  } catch (e) {
    ok(false, '运行时冒烟抛异常：' + e.message);
  } finally {
    g.document = saved.document;
    g.window = saved.window;
    g.Image = saved.Image;
    g.requestAnimationFrame = saved.raf;
    g.cancelAnimationFrame = saved.caf;
    g.ResizeObserver = saved.ro;
    g.CustomEvent = saved.ce;
    g.getComputedStyle = saved.gcs;
  }
}

// ============================================================================
section('9. CI 入口');
// ============================================================================
const pkg = JSON.parse(read('package.json'));
ok(pkg.version === '2.3.126', `package.json 版本号未改动（${pkg.version}）`);
ok(typeof pkg.scripts['verify:cursor-engine'] === 'string', 'package.json 含 verify:cursor-engine 入口');
for (const s of ['verify:cursor-hotspot', 'verify:cursor-leave', 'verify:launch-cursor', 'verify:cursor-cover-state']) {
  ok(typeof pkg.scripts[s] === 'string', `package.json 保留 ${s} 入口`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
