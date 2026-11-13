#!/usr/bin/env node
/**
 * 剧情节点侧栏回归闸门（结构级，esbuild 不需要）
 *
 * 锁死 v3.0.1-beta.7 ~ beta.11 修复后的行为，防止回退：
 *   1. 悬停开关弹出 → 始终未移入面板则 1.5s 自动收回（STORIES_PEEK_MS=1500）；
 *   2. 移入面板 → 标记 entered，保持展开；移出侧栏 → 立即收回（不等）；
 *   3. 拖动期间不自动缩回（drag.active 守卫所有收回路径）；
 *   4. 上/下边界由地标动态计算：顶部停在 chat-header 底线以下，底部停在 composer .toolbar 顶线以上；
 *   5. 不得回退到「移入即开 / 移出即关」的即时开合；
 *   6. 【beta.11】首帧位置：.stories 按 storyOn 异步条件渲染，Hook 必须在节点**挂载那一刻**
 *      于 paint 前同步 recomputeBounds()，不得把首次钳制推迟到 hover / click / setTimeout；
 *      并用 rAF / document.fonts.ready / ResizeObserver 兜底布局稳定。
 *   7. 【beta.11】动画锚点：面板改为「以图标为锚点」的 scale + opacity 弹出
 *      （transform-origin: left center / scale(0.92) / 展开 transform:none），
 *      不再是抽屉式左滑 translateX(-100%)；过渡受 --anim-speed 与 panel 分组门禁控制。
 *   8. 【beta.11】位置记忆（storiesDockTop / restoreTop / onCommitTop）不得回归；主窗小窗一致。
 *
 * 末尾内置「变异自证」：把源码按典型回退方式改坏后重跑断言，闸门必须变红（fail > 0）。
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readAll() {
  return {
    hook: readFileSync(resolve(root, 'src/hooks/useStoriesPanel.ts'), 'utf8'),
    cw: readFileSync(resolve(root, 'src/components/ChatWindow.tsx'), 'utf8'),
    mini: readFileSync(resolve(root, 'src/components/MiniChat.tsx'), 'utf8'),
    css: readFileSync(resolve(root, 'src/styles/index.css'), 'utf8'),
    anim: readFileSync(resolve(root, 'src/utils/animControl.ts'), 'utf8'),
  };
}

/**
 * 抽取某个「选择器独占一行、右花括号独占一行」的 CSS 规则体。
 * .stories-panel 与 .stories-panel.open 两段都满足这个排版约定。
 */
function cssBlock(src, re) {
  const m = src.match(re);
  return m ? m[1] : '';
}

function runAssertions(f, log) {
  let pass = 0;
  let fail = 0;
  function ok(cond, msg) {
    if (cond) {
      pass++;
      if (log) console.log('  ✓', msg);
    } else {
      fail++;
      if (log) console.log('  ✗', msg);
    }
  }
  const { hook, cw, mini, css, anim } = f;

  const panelBlock = cssBlock(css, /\n\.stories-panel\s*\{([\s\S]*?)\n\}/);
  const openBlock = cssBlock(css, /\n\.stories-panel\.open\s*\{([\s\S]*?)\n\}/);
  // 断言只针对**声明**，不针对注释：块内注释会提到旧版 translateX(-100%) 等字样，
  // 不剔除注释会让「不得出现」类断言误判，也会让「必须出现」类断言被注释蒙混过关。
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const panelDecl = stripComments(panelBlock);
  const openDecl = stripComments(openBlock);
  // 锚定在「首帧挂载钳制」effect 独有的首行 `const el = storiesRef.current;`，
  // 避免误抓到前面那个「记忆位置 initialTop」的 useLayoutEffect（它带 [opts?.initialTop] 依赖）。
  const attachEffect = (hook.match(/\n  useLayoutEffect\(\(\) => \{\n    const el = storiesRef\.current;([\s\S]*?)\n  \}\);/) || ['', ''])[1];

  // ── 1) 计时常量 ──
  ok(/STORIES_PEEK_MS\s*=\s*1500/.test(hook), 'peek 收回时长 = 1500ms（悬停开关后未移入面板自动收回）');
  ok(!/STORIES_CLOSE_MS/.test(hook), '已移除 CLOSE_MS（进入面板后移出改为立即收回）');

  // ── 2) 悬停意图状态机 ──
  ok(/onTabEnter/.test(hook) && /schedulePeek\(\)/.test(hook), 'tab 悬停 → 弹出 + 启动 peek 计时(1.5s)');
  ok(/onPanelEnter/.test(hook) && /enteredRef\.current\s*=\s*true/.test(hook), '面板悬停 → 标记 entered=true（进入后离开即立即收回）');
  ok(
    /onWrapperLeave/.test(hook) && /enteredRef\.current/.test(hook) && /setOpen\(false\)/.test(hook),
    '侧栏离开：曾进面板 → 立即收回（setOpen false，无计时）'
  );
  ok(/onWrapperLeave/.test(hook) && /drag\.current\.active/.test(hook), '拖动期间不自动收回（onWrapperLeave 守卫 drag.active）');
  ok(/schedulePeek/.test(hook) && /drag\.current\.active/.test(hook), 'peek 计时回调守卫 drag.active（拖动中不收）');

  // ── 3) 垂直拖动 + 动态边界 ──
  ok(/onTabPointerDown/.test(hook) && /setPointerCapture/.test(hook), 'tab 可抓拽（pointerdown + 拖动）');
  ok(/recomputeBounds/.test(hook), '存在 recomputeBounds（动态计算上下边界）');
  ok(/offsetParent/.test(hook), '边界换算到 offsetParent 坐标系（与 CSS top/bottom 同参照系）');
  ok(
    /BOTTOM_BOUND_SELECTORS/.test(hook) && /\.composer \.toolbar/.test(hook) && /mini-toolbar/.test(hook),
    '底部地标：composer .toolbar / mini-toolbar（停在输入框上方图标排顶线）'
  );
  ok(/TOP_BOUND_SELECTORS/.test(hook) && /chat-header/.test(hook), '顶部地标：chat-header（停在主动消息/关系值行底线以下）');
  ok(/minTop/.test(hook) && /maxTop/.test(hook), '拖动 top 被钳制在 [顶界线, 底界线] 内（不越过两条横线）');
  ok(/setBottom/.test(hook), 'bottom 由地标动态计算并下发（替代硬编码 120px）');

  // ── 4) 主窗 ──
  ok(/import \{ useStoriesPanel \} from '\.\.\/hooks\/useStoriesPanel'/.test(cw), '主窗导入 useStoriesPanel');
  ok(/bottom: storiesBottom/.test(cw) && /style=\{\{ top: storiesTop, bottom: storiesBottom \}\}/.test(cw), '主窗 .stories 应用动态 top/bottom');
  ok(
    /onTabEnter/.test(cw) && /onPanelEnter/.test(cw) && /onWrapperLeave/.test(cw) && /onTabPointerDown/.test(cw),
    '主窗使用悬停意图 + 拖动 handlers'
  );
  ok(!/onMouseEnter=\{\(\) => setShowStories\(true\)\}/.test(cw), '主窗不再「移入即开」(即时开合已移除)');
  ok(!/onMouseLeave=\{\(\) => \{ if \(editingNodeId === null\) setShowStories\(false\); \}\}/.test(cw), '主窗不再「移出即关」(即时开合已移除)');

  // ── 5) 小窗（与主窗同步）──
  ok(/import \{ useStoriesPanel \} from '\.\.\/hooks\/useStoriesPanel'/.test(mini), '小窗导入 useStoriesPanel');
  ok(/bottom: storiesBottom/.test(mini) && /style=\{\{ top: storiesTop, bottom: storiesBottom \}\}/.test(mini), '小窗 .stories 应用动态 top/bottom');
  ok(
    /onTabEnter/.test(mini) && /onPanelEnter/.test(mini) && /onWrapperLeave/.test(mini) && /onTabPointerDown/.test(mini),
    '小窗使用悬停意图 + 拖动 handlers（与主窗一致）'
  );
  ok(!/onMouseEnter=\{\(\) => setShowStories\(true\)\}/.test(mini), '小窗不再「移入即开」');
  ok(!/onMouseLeave=\{\(\) => \{ if \(editingNodeId === null\) setShowStories\(false\); \}\}/.test(mini), '小窗不再「移出即关」');

  // ── 6) 【beta.11】首帧定位：节点挂载感知，paint 前同步钳制 ──
  ok(/\{storyOn && \(/.test(cw) && /\{storyOn && \(/.test(mini), '主窗/小窗 .stories 均为条件渲染（Hook mount 时节点缺席 → 必须由挂载感知兜住）');
  ok(/ref=\{storiesRef\}/.test(cw) && /ref=\{storiesRef\}/.test(mini), '主窗/小窗均把 storiesRef 挂到 .stories 根节点');
  ok(/attachedElRef/.test(hook) && /disposeSettled/.test(hook), 'Hook 具备「节点挂载感知」与配套清理（attachedElRef / disposeSettled）');
  ok(
    (hook.match(/useLayoutEffect\(\(\) => \{/g) || []).length === 2 &&
      /\}, \[opts\?\.initialTop\]\);/.test(hook) &&
      attachEffect.length > 0,
    'Hook 两个 useLayoutEffect：记忆位置带 [initialTop] 依赖、首帧挂载钳制**无依赖**（每次 commit 的 paint 前检查节点）'
  );
  ok(/useLayoutEffect\(\(\) => \{\s*const el = storiesRef\.current;/.test(hook), '挂载感知 effect 读取 storiesRef.current（ref 在 commit 阶段先于 layout effect 赋值）');
  ok(/attachedElRef\.current === el/.test(attachEffect), '同一节点只钳制一次，避免每次 render 重复 setState');
  ok(/detachSettledRef\.current !== null/.test(attachEffect), 'React 18 StrictMode 二次 setup 时兜底回调已释放则重新登记（开发模式不失效）');
  ok(/attachedElRef\.current = el/.test(attachEffect) && /if \(!el\)/.test(attachEffect), '节点出现才钳制、卸载后复位供下次挂载重新钳制');
  ok(/\n    recomputeBounds\(\);\n/.test(attachEffect), '★首帧：节点挂载即刻**独立同步** recomputeBounds()（paint 前，绝不推迟到 hover/click / 回调内）');
  ok(!/setTimeout/.test(attachEffect), '★首帧：钳制不得被 setTimeout / 定时器延后（延后即产生可见瞬移）');
  ok(/requestAnimationFrame/.test(attachEffect), '布局稳定兜底：rAF 重算（字体 / 地标晚定）');
  ok(/document\.fonts\.ready/.test(attachEffect), '布局稳定兜底：document.fonts.ready 重算');
  ok(/ResizeObserver/.test(attachEffect) && /ro\.observe\(op\)/.test(attachEffect), '布局稳定兜底：ResizeObserver 观察 offsetParent 与地标（切换聊天无需等 resize）');
  ok(/addEventListener\('resize'/.test(attachEffect) && /removeEventListener\('resize'/.test(attachEffect), 'resize 监听与清理成对存在（无监听器泄漏）');
  ok(/cancelAnimationFrame\(raf\)/.test(attachEffect) && /ro\?\.disconnect\(\)/.test(attachEffect), 'rAF / ResizeObserver 在节点卸载时一并释放');
  ok(/useEffect\(\(\) => \(\) => disposeSettled\(\), \[disposeSettled\]\)/.test(hook), 'Hook 卸载时执行 disposeSettled 清理');
  ok(/if \(!el\) return;/.test(hook), 'recomputeBounds 保留空节点 early-return 守卫（不改变既有语义）');

  // ── 7) 【beta.11】动画锚点：从图标弹出，非后方滑入 ──
  ok(panelBlock.length > 0 && openBlock.length > 0, 'CSS 中 .stories-panel / .stories-panel.open 两段规则均可抽取');
  ok(/transform-origin:\s*left center/.test(panelDecl), '★动画锚点：transform-origin: left center（钉在 .stories-tab 图标那一侧）');
  ok(/transform:\s*translateX\(-6px\)\s*scale\(0\.92\)/.test(panelDecl), '★弹出感：基态 scale(0.92) + 朝图标 6px 微移（与 QueueDock 镜像）');
  ok(!/translateX\(-100%\)/.test(panelDecl), '★不再使用抽屉式左滑 translateX(-100%)（不再从后方滑入）');
  ok(/opacity:\s*0/.test(panelDecl) && /visibility:\s*hidden/.test(panelDecl), '基态=收起态（opacity:0 / visibility:hidden），遵守「基态陷阱」正确写法');
  ok(/transform:\s*none/.test(openDecl) && /opacity:\s*1/.test(openDecl) && /visibility:\s*visible/.test(openDecl), '展开态 transform:none / opacity:1 / visibility:visible');
  ok(!/translateX\(0\)/.test(openDecl), '展开态不再写 translateX(0)（旧抽屉式滑入已移除）');
  ok(/transition:/.test(panelDecl) && /transition:/.test(openDecl), '收起态与展开态均保留 CSS 过渡（丝滑开关）');
  // QA 独立回归补强（M6 落盘变异实测发现的漏检）：原断言只查 var(--anim-speed) 存在，
  // 把「* var(--anim-speed)」改成「/ var(--anim-speed)」（倍率方向写反 → 快档变慢档）仍会全绿。
  // 故同时校验「时长类乘倍率」的具体形式并显式排除除法写法；断言总数保持 66 条不变。
  ok(
    /calc\(0\.24s \* var\(--anim-speed, 1\)/.test(panelDecl) &&
      /calc\(0\.24s \* var\(--anim-speed, 1\)/.test(openDecl) &&
      !/\/ var\(--anim-speed/.test(panelDecl) &&
      !/\/ var\(--anim-speed/.test(openDecl),
    '过渡时长乘 var(--anim-speed) 倍率（受「动效速度」控制；不得写成除法反向）'
  );
  ok(/visibility 0s linear calc\(/.test(panelDecl) && /visibility 0s linear 0s/.test(openDecl), 'visibility 用「0s + 延时」切换（关档时直接落基态，不卡展开末态）');
  ok(/\.anim-off\s*,/.test(css) && /transition:\s*none\s*!important/.test(css), '全关档 .anim-off 全局 kill 仍在');
  ok(/data-anim-off~=/.test(anim) && /animation: none !important/.test(anim) && /transition: none !important/.test(anim), '★自定义档 data-anim-off 分组门禁生成规则仍在（animation/transition 双 kill，未被改坏）');
  ok(/'\.stories-panel'/.test(anim) && /'\.stories-panel\.open'/.test(anim), '★panel 分组同时登记基类与展开态（自定义档可独立开关，与 queue 组登记 .expanded 同理）');
  ok(/id: 'panel'/.test(anim), '动画分组定义中 panel 组仍存在（计入高级动画设置）');
  ok(/\.stories\.dragging \.stories-tab\s*\{[\s\S]{0,80}?cursor:\s*grabbing/.test(css), '拖动态抓手光标（beta.7 既有行为不回归）');

  // ── 8) 位置记忆：首帧同步参与、两窗恢复路径统一、无渲染后回灌 ──
  ok(/restoreTop/.test(hook) && /onCommitTop/.test(hook) && /initialTop/.test(hook), 'Hook 保留 restoreTop / onCommitTop / initialTop（位置记忆链路）');
  ok(/storiesDockTop/.test(cw) && /storiesDockTop/.test(mini), '主窗/小窗均读写 settings.storiesDockTop（新聊天不重置）');
  ok(/initialTop:\s*typeof appSettings\?\.storiesDockTop/.test(cw) && /initialTop:\s*typeof settings\?\.storiesDockTop/.test(mini), '★两窗恢复路径统一：均把 settings.storiesDockTop 作为 initialTop 同步传入（首帧 useState 即记忆值）');
  ok(/useTheme/.test(cw) && /useTheme/.test(mini), '两窗均从 ThemeContext 读 settings（不再主窗单独 api.getSettings）');
  ok(!/storiesApi\.restoreTop\(/.test(cw) && !/storiesApi\.restoreTop\(/.test(mini), '★两窗均无「渲染后异步回灌 restoreTop」路径（消除第二条可见跳位）');
  ok(!/storiesRestoredRef/.test(cw) && !/storiesRestoredRef/.test(mini), '两窗均移除 beta.8 的 storiesRestoredRef 一次性回灌状态');
  ok(/const remembered = opts\?\.initialTop/.test(hook) && /\[opts\?\.initialTop\]/.test(hook), '★Hook 用 useLayoutEffect 响应 initialTop 变化（settings 晚到时在 paint 前补齐，而非 useEffect 后跳位）');
  ok(/userMovedRef\.current = true/.test(hook) && /userMovedRef\.current\) return/.test(hook), '★用户拖动后记忆值广播不得覆盖已拖位置（userMovedRef 守卫）');
  ok(/bounds\.current/.test(hook), '记忆值按当前边界钳制（首帧挂载钳制已算好 bounds.current）');
  ok(/commitRef\.current\?\.\(topRef\.current\)/.test(hook), '拖动结束后仍落盘记忆位置（onCommitTop 经 commitRef 调用）');

  return { pass, fail };
}

console.log('=== 剧情节点侧栏回归闸门（v3.0.1-beta.11）===');
const real = readAll();
const mainResult = runAssertions(real, true);

// ── 变异自证：把源码按典型回退方式改坏，闸门必须变红 ──
// 这是「断言可证伪」的自动化证明：任一变异若仍全绿，说明闸门漏检，本闸门自身判失败。
const MUTATIONS = [
  {
    name: '把无依赖 effect 改回带 [recomputeBounds] 依赖（回到 beta.10：只在 mount 跑一次 → 首帧错位）',
    apply: (f) => ({
      ...f,
      hook: f.hook.replace('  });\n\n  // 卸载清理', '  }, [recomputeBounds]);\n\n  // 卸载清理'),
    }),
  },
  {
    name: '删掉 StrictMode 重登记守卫（开发模式兜底被 cleanup 释放后不再恢复）',
    apply: (f) => ({ ...f, hook: f.hook.replace(' && detachSettledRef.current !== null', '') }),
  },
  {
    name: '删掉 ResizeObserver（切换聊天后边界不再跟随布局）',
    apply: (f) => ({ ...f, hook: f.hook.replace(/ResizeObserver/g, 'NoObserver') }),
  },
  {
    name: '删掉 document.fonts.ready（字体晚定造成二次跳位）',
    apply: (f) => ({ ...f, hook: f.hook.replace(/document\.fonts\.ready/g, 'document.fontsNotReady') }),
  },
  {
    name: '把首帧同步钳制延后到 setTimeout（重新出现可见瞬移）',
    apply: (f) => ({
      ...f,
      hook: f.hook.replace(
        '    recomputeBounds();\n\n    // ② 布局稳定兜底',
        '    setTimeout(() => recomputeBounds(), 0);\n\n    // ② 布局稳定兜底'
      ),
    }),
  },
  {
    name: '整行删掉首帧同步钳制（只剩回调内重算，首帧仍错位）',
    apply: (f) => ({
      ...f,
      hook: f.hook.replace('    recomputeBounds();\n\n    // ② 布局稳定兜底', '    // MUTATION: 删掉同步钳制\n\n    // ② 布局稳定兜底'),
    }),
  },
  {
    name: '删掉 transform-origin 锚点（退回从面板中心缩放）',
    apply: (f) => ({ ...f, css: f.css.replace('transform-origin: left center;', '') }),
  },
  {
    name: '退回抽屉式左滑 translateX(-100%)（后方滑入）',
    apply: (f) => ({
      ...f,
      css: f.css.replace('transform: translateX(-6px) scale(0.92);', 'transform: translateX(-100%);'),
    }),
  },
  {
    name: '把展开态移出 panel 分组（自定义档关不掉动画）',
    apply: (f) => ({ ...f, anim: f.anim.replace("'.stories-panel.open',", '') }),
  },
  {
    name: '主窗丢掉 ref={storiesRef}（Hook 永远量不到节点）',
    apply: (f) => ({ ...f, cw: f.cw.replace('ref={storiesRef}', '') }),
  },
  {
    name: '删掉 restoreTop（位置记忆回归）',
    apply: (f) => ({ ...f, hook: f.hook.replace(/restoreTop/g, 'droppedRestore') }),
  },
  {
    name: '主窗改回「渲染后异步 restoreTop 回灌」（重新出现第二条跳位）',
    apply: (f) => ({
      ...f,
      cw: f.cw.replace(
        '  useEffect(() => {',
        '  useEffect(() => { api.getSettings().then((s) => storiesApi.restoreTop(s.storiesDockTop));'
      ),
    }),
  },
  {
    name: '两窗去掉同步 initialTop（记忆位置退回 useEffect 后才生效）',
    apply: (f) => ({
      ...f,
      cw: f.cw.replace('initialTop: typeof appSettings?.storiesDockTop === \'number\' ? appSettings.storiesDockTop : undefined,', ''),
    }),
  },
  {
    name: 'initialTop 响应式改用 useEffect（settings 晚到时 paint 后才跳位）',
    apply: (f) => ({
      ...f,
      hook: f.hook.replace('  }, [opts?.initialTop]);', '  }, []);'),
    }),
  },
  {
    name: '删掉 userMovedRef 守卫（拖动成果被记忆值广播覆盖）',
    apply: (f) => ({ ...f, hook: f.hook.replace('userMovedRef.current = true;', '') }),
  },
];

let selfPass = 0;
let selfFail = 0;
console.log(`\n--- 变异自证（${MUTATIONS.length} 组，要求每组都让闸门变红）---`);
for (const m of MUTATIONS) {
  const r = runAssertions(m.apply(real), false);
  if (r.fail > 0) {
    selfPass++;
    console.log(`  ✓ ${m.name} → ${r.fail} 条断言变红`);
  } else {
    selfFail++;
    console.log(`  ✗ ${m.name} → 闸门漏检（仍全绿）`);
  }
}

const totalFail = mainResult.fail + selfFail;
console.log(`\n==== 结果：${mainResult.pass} 通过 / ${mainResult.fail} 失败；变异自证 ${selfPass}/${MUTATIONS.length} 可证伪 ====`);
process.exit(totalFail ? 1 : 0);
