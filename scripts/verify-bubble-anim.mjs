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
  check('头像关键帧含 scale（从略小放大）', /scale\(/.test(body));
}
{
  const m = /@keyframes\s+msgBubbleIn\s*\{([\s\S]*?)\n\}/.exec(css);
  const body = m ? m[1] : '';
  check('气泡关键帧 from 含 opacity:0', /from\s*\{[^}]*opacity:\s*0/.test(body));
  check('气泡关键帧用 translateX 做「从头像向中间弹出」', /translateX\(/.test(body));
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

section('3. 方向：AI 头在左 → 负位移；用户头在右 → 正位移');
check('.msg-row.ai.anim-enter 方向变量为负', /\.msg-row\.ai\.anim-enter\s*\{[^}]*--msg-enter-dx:\s*-\d/.test(css));
check('.msg-row.user.anim-enter 方向变量为正', /\.msg-row\.user\.anim-enter\s*\{[^}]*--msg-enter-dx:\s*\d/.test(css));

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

section('5. 触发端：主窗与小窗都实现 enteringId + anim-enter');
for (const f of ['src/components/ChatWindow.tsx', 'src/components/MiniChat.tsx']) {
  const s = read(f);
  const name = f.split('/').pop();
  check(`${name} 有 enteringId 状态`, /enteringId/.test(s));
  check(`${name} 有 enterRef 基线`, /enterRef/.test(s));
  check(`${name} 用 useLayoutEffect（绘制前打标记，避免闪一下）`, /useLayoutEffect/.test(s));
  check(`${name} 清空时机用 animMs(0.6)（与 CSS 时长同步缩放）`, /animMs\(0\.6\)/.test(s));
  check(`${name} 把 anim-enter 挂到 .msg-row`, /anim-enter/.test(s));
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
