#!/usr/bin/env node
/**
 * 剧情节点侧栏回归闸门（结构级，esbuild 不需要）
 * 锁死 v3.0.1-beta.6 修复后的行为，防止回退：
 *   1. 悬停开关弹出 → 2s 未移入面板自动收回（STORIES_PEEK_MS=2000）；
 *   2. 移入面板保持展开；
 *   3. 移出侧栏 → 1.5s 后自动收回（STORIES_CLOSE_MS=1500）；
 *   4. 侧栏可垂直拖动（onTabPointerDown + 钳制在父容器）；
 *   5. 不得回退到「移入即开 / 移出即关」的即时开合；
 *   6. 面板过渡仍在（丝滑），拖动态有抓手光标。
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
ok(/STORIES_PEEK_MS\s*=\s*2000/.test(hook), 'peek 收回时长 = 2000ms（悬停开关后未移入面板自动收回）');
ok(/STORIES_CLOSE_MS\s*=\s*1500/.test(hook), '移出收回时长 = 1500ms（移出侧栏后自动收回）');
ok(/onTabEnter/.test(hook) && /schedulePeek\(\)/.test(hook), 'tab 悬停 → 弹出 + 启动 peek 计时');
ok(/onPanelEnter/.test(hook) && /keepOpen\(\)/.test(hook), '面板悬停 → 保持展开（取消 peek）');
ok(/onWrapperLeave/.test(hook) && /scheduleClose\(\)/.test(hook), '侧栏离开 → 启动 1.5s 延迟收回');
ok(/onTabPointerDown/.test(hook) && /setPointerCapture/.test(hook), 'tab 可抓拽（pointerdown + 拖动）');
ok(/minTop/.test(hook) && /maxTop/.test(hook), '拖动 top 被钳制在父容器内（不拖出聊天框）');

// 2) 主窗
ok(/import \{ useStoriesPanel \} from '\.\.\/hooks\/useStoriesPanel'/.test(cw), '主窗导入 useStoriesPanel');
ok(/onTabEnter/.test(cw) && /onPanelEnter/.test(cw) && /onWrapperLeave/.test(cw) && /onTabPointerDown/.test(cw),
  '主窗使用悬停意图 + 拖动 handlers');
ok(!/onMouseEnter=\{\(\) => setShowStories\(true\)\}/.test(cw), '主窗不再「移入即开」(即时开合已移除)');
ok(!/onMouseLeave=\{\(\) => \{ if \(editingNodeId === null\) setShowStories\(false\); \}\}/.test(cw),
  '主窗不再「移出即关」(即时开合已移除)');

// 3) 小窗（与主窗同步）
ok(/import \{ useStoriesPanel \} from '\.\.\/hooks\/useStoriesPanel'/.test(mini), '小窗导入 useStoriesPanel');
ok(/onTabEnter/.test(mini) && /onPanelEnter/.test(mini) && /onWrapperLeave/.test(mini) && /onTabPointerDown/.test(mini),
  '小窗使用悬停意图 + 拖动 handlers（与主窗一致）');
ok(!/onMouseEnter=\{\(\) => setShowStories\(true\)\}/.test(mini), '小窗不再「移入即开」');
ok(!/onMouseLeave=\{\(\) => \{ if \(editingNodeId === null\) setShowStories\(false\); \}\}/.test(mini),
  '小窗不再「移出即关」');

// 4) CSS：过渡（丝滑）+ 拖动抓手
ok(/\.stories-panel\s*\{[\s\S]{0,1000}?transition:/.test(css), '面板含过渡（丝滑开关）');
ok(/\.stories\.dragging \.stories-tab\s*\{[\s\S]{0,80}?cursor:\s*grabbing/.test(css), '拖动态抓手光标');

console.log(`\n==== 结果：${pass} 通过 / ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
