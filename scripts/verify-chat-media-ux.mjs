#!/usr/bin/env node
/**
 * verify-chat-media-ux.mjs — v3.0.1-beta.4「图片显示位置 / 气泡卡加载态 / 回复期可滚动」行为闸门。
 *
 * ── 覆盖用户反馈的三个缺陷 ───────────────────────────────────────────────────
 *   ① 「发送图片后，图片显示在聊天气泡的下面」→ 图片必须渲染在**气泡内部**；
 *   ② 「对方都回完了，我发的图片那个气泡还在显示『正在加载』」→ 纯图片消息（无文本）
 *      不能落进 bubble-loading 分支；且 bubble-loading 只在**确实无内容**时出现；
 *   ③ 「模型回复时不能向上滚动看以前的消息，每次往上一滚就被强制弄到底部」
 *      → 滚动跟随必须**仅在用户本来就贴着底部时**生效（粘底策略）。
 *
 * ── 断言分组 ─────────────────────────────────────────────────────────────────
 *   A. 图片在气泡内 + 纯图片消息不落 loading 分支（主窗 + 小窗）
 *   B. 粘底跟随策略：**行为级**（驱动真实生产模块 src/utils/stickToBottom.ts）
 *   C. 图片→模型链路：vision 判定与降级提示（主进程 + 前端提示）
 *   D. 文本/结构契约
 *
 * 用法：node scripts/verify-chat-media-ux.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; const l = `  ✗ ${name}${extra ? ' — ' + extra : ''}`; failures.push(l); console.log(l); }
};
const section = (t) => console.log(`\n=== ${t} ===`);
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf-8'); }
  catch { return ''; }
};

const cw = read('src/components/ChatWindow.tsx');
const mc = read('src/components/MiniChat.tsx');
const main = read('electron/main.ts');
const preload = read('electron/preload.ts');
const ipc = read('src/ipc.ts');

// ============================================================ A. 图片位置 + loading 分支
section('A. 图片渲染在气泡内部 + 纯图片消息不落 loading 分支');

for (const [label, src] of [['ChatWindow', cw], ['MiniChat', mc]]) {
  // A1：ImageGrid 必须在 .bubble 容器**之内**（缩进更深 = 在 JSX 深处），
  //     且气泡闭合之后不再有 ImageGrid（否则又跑到气泡外了）。
  const imgIdx = src.indexOf('<ImageGrid');
  check(`${label} 存在 ImageGrid 渲染`, imgIdx >= 0);
  if (imgIdx >= 0) {
    const after = src.slice(imgIdx);
    // 该行之后不应再出现「气泡闭合 + ImageGrid」形态：只允许一处 ImageGrid
    const count = (src.match(/<ImageGrid/g) || []).length;
    check(`${label} ImageGrid 只渲染一处（不会同时在气泡内/外各一份）`, count === 1, `实得 ${count}`);
    // 检查 ImageGrid 出现在 typing-inline 之前 → 说明它在同一个 bubble 容器内
    const bubbleOpen = src.lastIndexOf('className="bubble', imgIdx);
    const typingIdx = src.indexOf('typing-inline', imgIdx);
    check(`${label} ImageGrid 位于气泡容器内部（在其闭合前）`, bubbleOpen >= 0 && typingIdx > imgIdx);
  }

  // A2：条件里必须含 imgs.length > 0 —— 否则纯图片消息（无文本）会落进 bubble-loading
  check(
    `${label} 气泡渲染条件含 imgs.length > 0（纯图片消息不再显示「正在加载」）`,
    /\|\|\s*imgs\.length\s*>\s*0\s*\?/.test(src) || /imgs\.length\s*>\s*0\s*\?/.test(src),
  );

  // A3：bubble-loading 仍保留（AI 空内容时仍需占位），且只由 AI 消息触发
  check(`${label} 保留 bubble-loading 分支（AI 空内容占位）`, src.includes('bubble bubble-loading'));
  // bubble-loading 只应由 **AI** 的空内容触发：
  //   · ChatWindow：typing={m.sender_type === 'ai' && …}
  //   · MiniChat：typing = streaming && !msg.content && !msg.reasoning（streaming 源自 AI 占位气泡）
  const typingAiOnly =
    /typing=\{m\.sender_type === 'ai'/.test(src) ||
    /const typing = streaming && !msg\.content/.test(src);
  check(`${label} bubble-loading 不再由「用户纯图片消息」触发（typing 仅 AI）`, typingAiOnly);
}

// ============================================================ B. 粘底跟随（行为级）
section('B. 回复期间可向上滚动（粘底跟随策略，行为级）');

// 加载**真实生产模块** src/utils/stickToBottom.ts
const { createStickToBottom, isNearBottom } = await import(
  new URL('../src/utils/stickToBottom.ts', import.meta.url).href
);

check('生产模块 src/utils/stickToBottom.ts 可加载', typeof createStickToBottom === 'function');

// 构造一个假滚动容器
function makeEl({ scrollHeight, scrollTop, clientHeight }) {
  return { scrollHeight, scrollTop, clientHeight, scrollTo({ top }) { this.scrollTop = top; } };
}

{
  // 场景 1：用户在底部 → 新内容到达应跟随
  const el = makeEl({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 }); // 距底 0
  const stick = createStickToBottom(() => el);
  stick.onUserScroll();
  el.scrollHeight = 1200; // 新内容到达
  stick.followOnContentChange();
  check('用户贴底时：新内容到达自动跟随到底部', el.scrollTop === 1200, `scrollTop=${el.scrollTop}`);

  // 场景 2：用户向上翻 → 新内容到达**不得**把用户拽回底部（这是用户反馈的核心）
  const el2 = makeEl({ scrollHeight: 1000, scrollTop: 200, clientHeight: 300 }); // 距底 500
  const stick2 = createStickToBottom(() => el2);
  stick2.onUserScroll();                       // 记录「用户已离开底部」
  el2.scrollHeight = 1400;                    // 新内容到达（流式每来一个字就变一次）
  stick2.followOnContentChange();
  check('用户向上翻后：新内容到达**不会**把视图拽回底部（可安心看历史）',
    el2.scrollTop === 200, `scrollTop=${el2.scrollTop}（期望保持 200）`);

  // 场景 3：用户自己滚回底部 → 恢复跟随
  const el3 = makeEl({ scrollHeight: 1000, scrollTop: 200, clientHeight: 300 });
  const stick3 = createStickToBottom(() => el3);
  stick3.onUserScroll();
  el3.scrollTop = 700;                        // 用户手动滚回底部
  stick3.onUserScroll();                      // → 恢复跟随
  el3.scrollHeight = 1300;
  stick3.followOnContentChange();
  check('用户手动滚回底部后：恢复自动跟随', el3.scrollTop === 1300, `scrollTop=${el3.scrollTop}`);

  // 场景 4：手动点「回到底部」→ 恢复跟随
  const el4 = makeEl({ scrollHeight: 1000, scrollTop: 100, clientHeight: 300 });
  const stick4 = createStickToBottom(() => el4);
  stick4.onUserScroll();
  stick4.resumeFollowing();
  el4.scrollHeight = 1500;
  stick4.followOnContentChange();
  check('手动「回到底部」后：恢复自动跟随', el4.scrollTop === 1500, `scrollTop=${el4.scrollTop}`);

  // 场景 5：内容未超出容器（无滚动条）→ 始终跟随，不该卡住
  const el5 = makeEl({ scrollHeight: 200, scrollTop: 0, clientHeight: 300 });
  const stick5 = createStickToBottom(() => el5);
  stick5.onUserScroll();
  el5.scrollHeight = 260;
  stick5.followOnContentChange();
  check('内容未超出容器时：始终跟随（scrollTop 贴底）', el5.scrollTop === 260, `scrollTop=${el5.scrollTop}`);

  // 场景 6：isNearBottom 判定
  check('isNearBottom：距底 <120px 视为贴底', isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 300 }) === true);
  check('isNearBottom：距底 >120px 视为已离开底部', isNearBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 300 }) === false);
}

// ============================================================ C. 图片 → 模型链路
section('C. 图片→模型链路（视觉能力判定 + 降级提示）');

check('主进程提供 chats:visionCapable IPC（前端据此提示用户）',
  main.includes("ipcMain.handle('chats:visionCapable'"));
check('preload 暴露 getChatVisionCapable',
  preload.includes('getChatVisionCapable') && preload.includes("ipcRenderer.invoke('chats:visionCapable'"));
check('src/ipc.ts 声明并转发 getChatVisionCapable',
  ipc.includes('getChatVisionCapable: (chatType: string, chatId: string) => Promise<boolean>;') &&
  ipc.includes('getChatVisionCapable: (chatType, chatId) => raw.getChatVisionCapable(chatType, chatId),'));

check('vision 判定与发送链路同口径（识图模型优先，否则看模型自身 supportsImages）',
  main.includes('const visionCfg = storedImages.length ? getVisionModelConfig(settings) : undefined;') &&
  main.includes('const vision = visionCfg ? true : !!cfg?.supportsImages;'));

check('图片确实进入多模态 content（image_url data URL）',
  main.includes("parts.push({ type: 'image_url', image_url: { url } });") &&
  main.includes('imageToDataUrl(p)'));

check('无视觉能力时降级为**明确告知模型看不见**的占位（避免模型凭空编造）',
  /当前模型不支持视觉输入/.test(main) && /不要猜测或编造/.test(main));

check('前端在待发图片时提示「当前模型看不到图片」',
  cw.includes('getChatVisionCapable') && cw.includes('visionWarn') && cw.includes('chat.imageNoVision'));

// ============================================================ D. 结构契约
section('D. 结构契约');

check('主窗与主窗外的加载态底槽统一走 currentColor（自适应所在气泡）',
  /\.typing \.typing-bar \{[^}]*color-mix\(in srgb, currentColor \d+%,\s*transparent\)/.test(read('src/styles/index.css')));
check('主窗与小窗都使用粘底跟随器',
  cw.includes('createStickToBottom') && mc.includes('createStickToBottom'));
check('主窗与小窗都不再无条件 scrollTo 到底部',
  !/useEffect\(\(\) => \{\s*\n\s*el\.scrollTo\(\{ top: el\.scrollHeight/.test(cw) &&
  !/useEffect\(\(\) => \{\s*\n\s*scrollRef\.current\?\.scrollTo\(\{ top: scrollRef\.current\.scrollHeight/.test(mc));

console.log('\n' + '='.repeat(60));
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(f));
  process.exit(1);
}
process.exit(0);
