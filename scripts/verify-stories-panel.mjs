#!/usr/bin/env node
/**
 * 剧情节点侧栏回归闸门（结构级，esbuild 不需要）
 * 锁死 v3.0.1-beta.7 修复后的行为，防止回退：
 *   1. 悬停开关弹出 → 始终未移入面板则 1.5s 自动收回（STORIES_PEEK_MS=1500）；
 *   2. 移入面板 → 标记 entered，保持展开；移出侧栏 → 立即收回（不等）；
 *   3. 拖动期间不自动缩回（drag.active 守卫所有收回路径）；
 *   4. 上/下边界由地标动态计算：顶部停在 chat-header 底线以下，底部停在 composer .toolbar 顶线以上；
 *   5. 不得回退到「移入即开 / 移出即关」的即时开合；
 *   6. 收起改抽屉式左滑 translateX(-100%)，不再卡在图标中间；过渡仍在（丝滑）+ 拖动抓手光标。
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ✓', msg);
  } else {
    fail++;
    console.log('  ✗', msg);
  }
}

const hook = readFileSync(resolve(root, 'src/hooks/useStoriesPanel.ts'), 'utf8');
const cw = readFileSync(resolve(root, 'src/components/ChatWindow.tsx'), 'utf8');
const mini = readFileSync(resolve(root, 'src/components/MiniChat.tsx'), 'utf8');
const css = readFileSync(resolve(root, 'src/styles/index.css'), 'utf8');

console.log('=== 剧情节点侧栏回归闸门 ===');

// 1) 计时常量
ok(/STORIES_PEEK_MS\s*=\s*1500/.test(hook), 'peek 收回时长 = 1500ms（悬停开关后未移入面板自动收回）');
ok(!/STORIES_CLOSE_MS/.test(hook), '已移除 CLOSE_MS（进入面板后移出改为立即收回）');

// 2) 悬停意图状态机
ok(/onTabEnter/.test(hook) && /schedulePeek\(\)/.test(hook), 'tab 悬停 → 弹出 + 启动 peek 计时(1.5s)');
ok(/onPanelEnter/.test(hook) && /enteredRef\.current\s*=\s*true/.test(hook), '面板悬停 → 标记 entered=true（进入后离开即立即收回）');
ok(
  /onWrapperLeave/.test(hook) && /enteredRef\.current/.test(hook) && /setOpen\(false\)/.test(hook),
  '侧栏离开：曾进面板 → 立即收回（setOpen false，无计时）'
);
ok(/onWrapperLeave/.test(hook) && /drag\.current\.active/.test(hook), '拖动期间不自动收回（onWrapperLeave 守卫 drag.active）');
ok(/schedulePeek/.test(hook) && /drag\.current\.active/.test(hook), 'peek 计时回调守卫 drag.active（拖动中不收）');

// 3) 垂直拖动 + 动态边界
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

// 4) 主窗
ok(/import \{ useStoriesPanel \} from '\.\.\/hooks\/useStoriesPanel'/.test(cw), '主窗导入 useStoriesPanel');
ok(/bottom: storiesBottom/.test(cw) && /style=\{\{ top: storiesTop, bottom: storiesBottom \}\}/.test(cw), '主窗 .stories 应用动态 top/bottom');
ok(
  /onTabEnter/.test(cw) && /onPanelEnter/.test(cw) && /onWrapperLeave/.test(cw) && /onTabPointerDown/.test(cw),
  '主窗使用悬停意图 + 拖动 handlers'
);
ok(!/onMouseEnter=\{\(\) => setShowStories\(true\)\}/.test(cw), '主窗不再「移入即开」(即时开合已移除)');
ok(!/onMouseLeave=\{\(\) => \{ if \(editingNodeId === null\) setShowStories\(false\); \}\}/.test(cw), '主窗不再「移出即关」(即时开合已移除)');

// 5) 小窗（与主窗同步）
ok(/import \{ useStoriesPanel \} from '\.\.\/hooks\/useStoriesPanel'/.test(mini), '小窗导入 useStoriesPanel');
ok(/bottom: storiesBottom/.test(mini) && /style=\{\{ top: storiesTop, bottom: storiesBottom \}\}/.test(mini), '小窗 .stories 应用动态 top/bottom');
ok(
  /onTabEnter/.test(mini) && /onPanelEnter/.test(mini) && /onWrapperLeave/.test(mini) && /onTabPointerDown/.test(mini),
  '小窗使用悬停意图 + 拖动 handlers（与主窗一致）'
);
ok(!/onMouseEnter=\{\(\) => setShowStories\(true\)\}/.test(mini), '小窗不再「移入即开」');
ok(!/onMouseLeave=\{\(\) => \{ if \(editingNodeId === null\) setShowStories\(false\); \}\}/.test(mini), '小窗不再「移出即关」');

// 6) CSS：抽屉式左滑收起（不再卡在图标中间）+ 过渡 + 抓手
ok(/\.stories-panel\s*\{[\s\S]{0,1100}?transform:\s*translateX\(-100%\)/.test(css), '收起改抽屉式左滑 translateX(-100%)（解决缩回卡图标中间）');
ok(/\.stories-panel\.open\s*\{[\s\S]{0,200}?transform:\s*translateX\(0\)/.test(css), '展开 transform: translateX(0)');
ok(/\.stories-panel\s*\{[\s\S]{0,1100}?transition:/.test(css), '面板含过渡（丝滑开关）');
ok(/\.stories\.dragging \.stories-tab\s*\{[\s\S]{0,80}?cursor:\s*grabbing/.test(css), '拖动态抓手光标');

console.log(`\n==== 结果：${pass} 通过 / ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
