// v2.3.101 需求 2 验证：消息气泡入场动画（头像渐显 → 气泡向中间弹出）
// 用法：node scripts/verify-bubble-anim.mjs
//
// 可证伪性对照（每条都必须能失败）：
//   NY_KILL_KEYFRAME=1   node scripts/verify-bubble-anim.mjs   应当失败（删掉 msgBubbleIn 关键帧）
//   NY_BASE_HIDDEN=1     node scripts/verify-bubble-anim.mjs   应当失败（把 opacity:0 写进 .bubble 基态）
//
// 这条是「用户明确提了但极易做漏/退化」的需求：
//   ① 关掉动画后消息绝不能永久不可见（本文件 5198-5206 的血泪教训）；
//   ② AI 从左侧、用户从右侧，方向不能反；
//   ③ 主窗与小窗必须同时生效（小窗极易被漏改）。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const FORCE = {
  killKeyframe: process.env.NY_KILL_KEYFRAME === '1',
  baseHidden: process.env.NY_BASE_HIDDEN === '1',
};

let pass = 0,
  fail = 0;
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

let css = read('src/styles/index.css');
if (FORCE.killKeyframe) {
  css = css.replace(/@keyframes msgBubbleIn[\s\S]*?\n}/, '');
  console.log('  (NY_KILL_KEYFRAME=1 → 已删掉 @keyframes msgBubbleIn)');
}
if (FORCE.baseHidden) {
  css = css + '\n.msg-row .bubble { opacity: 0; }\n';
  console.log('  (NY_BASE_HIDDEN=1 → 已给 .msg-row .bubble 基态加了 opacity:0)');
}

section('1. 关键帧存在且方向正确');
check('@keyframes msgAvatarIn 存在', /@keyframes\s+msgAvatarIn\s*\{/.test(css));
check('@keyframes msgBubbleIn 存在', /@keyframes\s+msgBubbleIn\s*\{/.test(css));

{
  const m = /@keyframes\s+msgAvatarIn\s*\{([\s\S]*?)\n\}/.exec(css);
  const body = m ? m[1] : '';
  check('头像关键帧 from 含 opacity:0（渐显起点）', /from\s*\{[^}]*opacity:\s*0/.test(body));
  // v2.3.107 需求 2（用户二次明确）：入场要「从左往右展开」，**不是放大**。
  // 故头像与气泡关键帧都不得再出现 scale —— 这条断言就是防止以后有人把 scale 加回来。
  check('头像关键帧不含 scale（用户要求：不要放大）', !/scale\(/.test(body));
}
{
  const m = /@keyframes\s+msgBubbleIn\s*\{([\s\S]*?)\n\}/.exec(css);
  const body = m ? m[1] : '';
  check('气泡关键帧 from 含 opacity:0', /from\s*\{[^}]*opacity:\s*0/.test(body));
  // v2.3.107 需求 2（用户二次明确「左边不动右边展开 / 右边不动左边展开，而不是整个气泡平移」）：
  // 用 clip-path 做单边固定的展开，且**不得**再整体平移或缩放。
  check('气泡关键帧用 clip-path 做单边展开', /clip-path/.test(body));
  check('气泡关键帧不含 scale（用户要求：不是放大）', !/scale\(/.test(body));
  check('气泡关键帧不含 translateX（用户要求：整个气泡不要平移）', !/translateX\(/.test(body));
  check(
    '气泡 fill-mode 为 backwards（终态不保留 → box-shadow 不被裁）',
    /\.msg-row\.anim-enter\s+\.bubble\s*\{[^}]*animation:[^;}]*\bbackwards\b/.test(css)
  );
}
{
  // 展开锚点：AI（头像在左）→ 左固定、右展开（inset 右侧 100%）；用户（头像在右）→ 右固定、左展开
  const ai = /\.msg-row\.ai\.anim-enter\s*\{[^}]*--bubble-clip-from:\s*inset\(([^)]*)\)/.exec(css);
  const u = /\.msg-row\.user\.anim-enter\s*\{[^}]*--bubble-clip-from:\s*inset\(([^)]*)\)/.exec(css);
  check('AI 气泡：左边不动、右边展开（inset 第 2 个值 = 100%）', !!ai && /0\s+100%/.test(ai[1]));
  check('用户气泡：右边不动、左边展开（inset 第 4 个值 = 100%）', !!u && /100%\s*\)?$/.test(u[1].trim()) || !!u && /0\s+0\s+0\s+100%/.test(u[1]));
  check('展开保留圆角（inset 带 round）', !!ai && /round/.test(ai[1]));
}

section('2. 应用规则：先头像、后气泡，且为线性');
check(
  '.msg-row.anim-enter .avatar 应用 msgAvatarIn',
  /\.msg-row\.anim-enter\s+\.avatar\s*\{[^}]*animation:\s*msgAvatarIn/.test(css)
);
check(
  '.msg-row.anim-enter .bubble 应用 msgBubbleIn',
  /\.msg-row\.anim-enter\s+\.bubble\s*\{[^}]*animation:\s*msgBubbleIn/.test(css)
);
check(
  '气泡有 animation-delay（实现「先头像后气泡」的错峰）',
  /\.msg-row\.anim-enter\s+\.bubble\s*\{[^}]*animation-delay:\s*calc\(/.test(css)
);
check(
  '计时函数为 linear（需求：线性动画）',
  /\.msg-row\.anim-enter\s+\.avatar\s*\{[^}]*animation:[^;]*linear/.test(css) &&
    /\.msg-row\.anim-enter\s+\.bubble\s*\{[^}]*animation:[^;]*linear/.test(css)
);
check(
  '时长随全局速度缩放（calc(... * var(--anim-speed, 1))）',
  /msgAvatarIn\s+calc\([^)]*var\(--anim-speed/.test(css) &&
    /msgBubbleIn\s+calc\([^)]*var\(--anim-speed/.test(css)
);

section('3. 展开锚点：AI 头在左 → 左固定右展开；用户头在右 → 右固定左展开');
// v2.3.107：方向不再用位移 --msg-enter-dx（用户明确不要整体平移），改为 clip-path 锚点。
check(
  '.msg-row.ai.anim-enter 定义 --bubble-clip-from',
  /\.msg-row\.ai\.anim-enter\s*\{[^}]*--bubble-clip-from/.test(css)
);
check(
  '.msg-row.user.anim-enter 定义 --bubble-clip-from',
  /\.msg-row\.user\.anim-enter\s*\{[^}]*--bubble-clip-from/.test(css)
);
check(
  '不再使用 --msg-enter-dx 位移变量（气泡不整体平移）',
  !/--msg-enter-dx\s*:/.test(css)
);

section('4. 关掉动画后消息必须仍可见（关键回归防线）');
// 基态不得含 opacity:0 —— 否则被 .anim-off * 的 animation:none!important 抹掉动画后永久不可见。
{
  const baseBubble = /\.msg-row\s+\.bubble\s*\{([^}]*)\}/.exec(css);
  const body = baseBubble ? baseBubble[1] : '';
  check(
    '.msg-row .bubble 基态不含 opacity:0',
    baseBubble ? !/opacity:\s*0(?!\.)/.test(body.replace(/\s+/g, ' ')) : true,
    baseBubble ? body.trim().replace(/\s+/g, ' ') : '（未找到 .msg-row .bubble 单独基态块，视为不违规）'
  );
}
// 动画只挂在带 anim-enter 的行上：非入场行不挂关键帧。
check(
  '关键帧仅在 .anim-enter 上挂载（非入场行不受影响）',
  !/@keyframes\s+msg(Bubble|Avatar)In/.test(css.replace(/\s+/g, ' ')) ||
    !/\.msg-row\s+\.bubble\s*\{[^}]*animation:\s*msgBubbleIn/.test(css)
);

section('5. 触发端：主窗与小窗都实现 entering 批次 + anim-enter');
for (const f of ['src/components/ChatWindow.tsx', 'src/components/MiniChat.tsx']) {
  const s = read(f);
  const name = f.split('/').pop();
  // v2.3.107 需求 2：单条 enteringId 升级为「批次 map」（id → 错峰序号），
  // 以便打开聊天时末尾若干条错峰入场；故这里断言批次状态而非旧的 enteringId。
  check(`${name} 有 entering 批次状态`, /const \[entering,\s*setEntering\]/.test(s));
  check(`${name} 有 enterRef 基线`, /enterRef/.test(s));
  check(`${name} 用 useLayoutEffect（绘制前打标记，避免闪一下）`, /useLayoutEffect/.test(s));
  check(`${name} 清空时机用 animMs(0.6)（与 CSS 时长同步缩放）`, /animMs\(0\.6\)/.test(s));
  check(`${name} 把 anim-enter 挂到 .msg-row`, /anim-enter/.test(s));
  check(
    `${name} 打开聊天时整批入场（enteringChat 分支 + 末尾 ENTER_BATCH 条）`,
    /enteringChat/.test(s) && /ENTER_BATCH/.test(s)
  );
  check(`${name} 把 --msg-enter-stagger 下发到行上（错峰延迟）`, /--msg-enter-stagger/.test(s));
}

section('5b. 打开聊天也播（v2.3.107 需求 2）—— CSS 消费错峰变量');
{
  const css = read('src/styles/index.css');
  check(
    'CSS 的 .msg-row.anim-enter .bubble 延迟含 --msg-enter-stagger',
    /\.msg-row\.anim-enter\s+\.bubble\s*\{[^}]*animation-delay:\s*calc\(\(0\.08s \+ var\(--msg-enter-stagger/.test(css.replace(/\n/g, ' ')) ||
      /--msg-enter-stagger/.test(css)
  );
  check(
    'CSS 的 .msg-row.anim-enter .avatar 延迟含 --msg-enter-stagger',
    /\.msg-row\.anim-enter\s+\.avatar\s*\{[^}]*--msg-enter-stagger/.test(css.replace(/\n/g, ' ')) ||
      /--msg-enter-stagger/.test(css)
  );
  const cw = read('src/components/ChatWindow.tsx');
  check('ChatWindow 导出 ENTER_BATCH / ENTER_STAGGER_MS 供小窗复用', /export const ENTER_BATCH/.test(cw) && /export const ENTER_STAGGER_MS/.test(cw));
  const mc = read('src/components/MiniChat.tsx');
  check('MiniChat 复用主窗的 ENTER_BATCH / ENTER_STAGGER_MS（单一真源）', /ENTER_BATCH/.test(mc) && /ENTER_STAGGER_MS/.test(mc));
}

section('6. 动画总控：bubble 分组登记了 .avatar / .bubble');
{
  const anim = read('src/utils/animControl.ts');
  check(
    "animControl.ts 的 bubble 组登记了 .msg-row .avatar",
    /\.msg-row[\s'"]*\.avatar/.test(anim) || /'\.msg-row\s+\.avatar'/.test(anim)
  );
  check(
    "animControl.ts 的 bubble 组登记了 .msg-row .bubble",
    /'\.msg-row\s+\.bubble'/.test(anim)
  );
}

section('7. 真实流式收尾不重播入场动画（防止「闪一下」回归）');
for (const f of ['src/components/ChatWindow.tsx', 'src/components/MiniChat.tsx']) {
  const s = read(f);
  const name = f.split('/').pop();
  check(`${name} 有 suppressEnterIdRef 抑制 ref`, /suppressEnterIdRef/.test(s));
  check(
    `${name} 在真实流式（streamOnRef.current）落库时抑制入场动画`,
    /if \(streamOnRef\.current && data\.message\.id != null\)/.test(s)
  );
  check(
    `${name} 入场检测里对抑制 id 提前返回`,
    /suppressEnterIdRef\.current !== null && lastId === suppressEnterIdRef\.current/.test(s)
  );
}

console.log('\n' + '='.repeat(52));
console.log('断言：' + pass + ' 通过 / ' + fail + ' 失败');
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail === 0 ? 0 : 1);
