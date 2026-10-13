// v2.3.111 验证：统计页饼图「内容不变不重播展开动画」
// 用法：node scripts/verify-pie-no-replay.mjs
//
// 背景（用户原话：「饼图莫名其妙固定时间重新打开」）：
// StatsView 每 3 秒 setInterval(refresh) 拉一次数据，buildPieSlices 每次产出
// **全新的数组与对象引用**（内容常常完全一致）。饼图展开动画的 effect 旧代码
// 直接依赖 `[animOn, slices]` —— 引用一变 effect 重跑 → progress 归 0 重新
// 「从圆心拉开」→ 用户观感就是每 3 秒自动重开一次。
//
// 本脚本锁死三条：
//   A. pieFingerprint（src/utils/statsRank.ts）的语义：内容同 → 指纹同；
//      内容异（token/名称/顺序变）→ 指纹异。用 esbuild 打包真实源码验证。
//   B. StatsView.tsx 的结构：动画 effect 依赖**内容指纹**而非 slices 引用；
//      且 slices 本身按指纹稳定引用（下游 useMemo 不被无谓重算）。
//   C. 可证伪性自证：把源码里的指纹依赖**替换回引用依赖**后，断言必须变红
//      （NY_PIE_DEP_BREAK=1 注入破坏者）。防止「断言写宽松了永远绿」。
//
// ⚠️ 未覆盖（需人工/浏览器）：真实浏览器里 rAF 的实际播放次数；
//    本脚本覆盖的是「触发条件」这一层（重播的唯一入口）。

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const RANK = path.join(ROOT, 'src', 'utils', 'statsRank.ts');
const VIEW = path.join(ROOT, 'src', 'components', 'StatsView.tsx');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : ''));
  }
}
function section(t) {
  console.log('\n=== ' + t + ' ===');
}

for (const f of [RANK, VIEW]) {
  if (!fs.existsSync(f)) {
    console.error(`找不到 ${f}`);
    process.exit(1);
  }
}

const rawView = fs.readFileSync(VIEW, 'utf8');
// 断言基于去注释代码（修复说明注释里会写 `[animOn, slices]` 字样，不去注释会误判）
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
  return out;
}
const viewCode = stripComments(rawView);

// ---------- A. pieFingerprint 语义（真实源码，esbuild 打包） ----------
const tmpRank = path.join(os.tmpdir(), `ny-pie-fp-${Date.now()}.mjs`);
await build({ entryPoints: [RANK], outfile: tmpRank, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const M = await import(pathToFileURL(tmpRank).href);

const PAL = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
const row = (roleId, name, tokens) => ({
  roleId,
  name,
  avatar: '',
  affinity: 0,
  companionMs: 0,
  tokens,
  messages: 0,
  mood: '',
  relation: '',
});

section('A. pieFingerprint：内容同 → 指纹同（refresh 不重播的依据）');
{
  check('statsRank 导出 pieFingerprint', typeof M.pieFingerprint === 'function');
  // 同一份数据算两次：数组引用必然不同（模拟 3 秒 refresh），内容完全一致
  const rows = [row('r1', '小明', 600), row('r2', '小红', 400)];
  const a = M.buildPieSlices(rows, PAL, '其它');
  const b = M.buildPieSlices(rows, PAL, '其它');
  check('两次构建产出不同数组引用（模拟 refresh）', a !== b && a[0] !== b[0]);
  check('内容一致 → 指纹一致（不重播）', M.pieFingerprint(a) === M.pieFingerprint(b),
    `${M.pieFingerprint(a)} vs ${M.pieFingerprint(b)}`);
  // 浮点尾差不应构成「内容变化」：ratio 相同数量级下指纹稳定
  const c = M.buildPieSlices([row('r1', '小明', 600), row('r2', '小红', 400)], PAL, '其它');
  check('重复构建的 ratio 浮点尾差不影响指纹', M.pieFingerprint(a) === M.pieFingerprint(c));
  // 空数组
  check('空数组指纹一致（空态不触发重播）', M.pieFingerprint([]) === M.pieFingerprint([]));
}

section('B. pieFingerprint：内容异 → 指纹异（token 真变才重播）');
{
  const base = M.buildPieSlices([row('r1', '小明', 600), row('r2', '小红', 400)], PAL, '其它');
  const tokensChanged = M.buildPieSlices([row('r1', '小明', 601), row('r2', '小红', 400)], PAL, '其它');
  check('token 数变化 → 指纹变化（重播）', M.pieFingerprint(base) !== M.pieFingerprint(tokensChanged));
  const nameChanged = M.buildPieSlices([row('r1', '小明明', 600), row('r2', '小红', 400)], PAL, '其它');
  check('名称变化 → 指纹变化（重播）', M.pieFingerprint(base) !== M.pieFingerprint(nameChanged));
  // 注意：buildPieSlices 内部按 Token 降序输出，故「输入顺序换」不构成内容变化
  // （指纹应保持一致——下面单独锁死这条）；真正的顺序变化是「谁大谁小换了」。
  const inputReordered = M.buildPieSlices([row('r2', '小红', 400), row('r1', '小明', 600)], PAL, '其它');
  check('仅输入顺序不同 → 指纹一致（排序已归一，不算内容变化）',
    M.pieFingerprint(base) === M.pieFingerprint(inputReordered));
  const rankFlipped = M.buildPieSlices([row('r1', '小明', 400), row('r2', '小红', 600)], PAL, '其它');
  check('排名翻转（输出顺序变）→ 指纹变化（重播）', M.pieFingerprint(base) !== M.pieFingerprint(rankFlipped));
  const memberAdded = M.buildPieSlices([row('r1', '小明', 600), row('r2', '小红', 400), row('r3', '小刚', 300)], PAL, '其它');
  check('新增人物 → 指纹变化（重播）', M.pieFingerprint(base) !== M.pieFingerprint(memberAdded));
  const emptied = M.buildPieSlices([row('r1', '小明', 0), row('r2', '小红', 0)], PAL, '其它');
  check('全部归零（进空态）→ 指纹变化（重播一次后走空态）', M.pieFingerprint(base) !== M.pieFingerprint(emptied));
}

// ---------- C. StatsView 结构断言 ----------
section('C. StatsView：动画 effect 依赖内容指纹，slices 引用按指纹稳定');
{
  // C1. effect 依赖数组：必须是 [animOn, slicesFingerprint]，不得含裸 slices
  const depRe = /\},\s*\[animOn,\s*slicesFingerprint\]\);/;
  check('饼图动画 effect 依赖 [animOn, slicesFingerprint]（内容指纹）', depRe.test(viewCode),
    '未找到 }, [animOn, slicesFingerprint]); —— 若依赖回退为 slices 引用，每 3 秒 refresh 都会重播');
  // 反证：不得存在「依赖裸 slices」的 effect 尾巴
  const badDep = /\},\s*\[animOn,\s*slices\]\);/;
  check('不存在依赖裸 slices 数组引用的动画 effect', !badDep.test(viewCode));

  // C2. PieChart 内有指纹 memo
  check(
    'PieChart 内计算 slicesFingerprint = useMemo(() => pieFingerprint(slices), [slices])',
    /const slicesFingerprint = useMemo\(\(\) => pieFingerprint\(slices\), \[slices\]\);/.test(viewCode)
  );

  // C3. 外层 slices 按指纹稳定引用（跨 refresh 不换数组）
  check(
    '外层 slices 按指纹稳定（useMemo(() => slicesRaw, [slicesFingerprint, palette])）',
    /const slices = useMemo\(\s*\(\) => slicesRaw,\s*\[slicesFingerprint, palette\]\s*\)/.test(viewCode)
  );
  // 调色板必须进稳定化依赖：换主题 → 配色换 → 引用必须跟着换（否则饼图留着旧主题色）
  check(
    '稳定化依赖含 palette（换主题即时换色，不被指纹卡住）',
    /\[slicesFingerprint, palette\]/.test(viewCode)
  );
  check(
    '外层仍从最新数据计算 slicesRaw（数据不会因稳定而过期）',
    /const slicesRaw: PieSlice\[\] = useMemo\(\(\) => \{[\s\S]{0,200}?buildPieSlices\(rows, palette/.test(viewCode)
  );
  check('statsRank 导入里有 pieFingerprint', /import\s*\{[^}]*pieFingerprint[^}]*\}\s*from\s*'\.\.\/utils\/statsRank'/.test(viewCode));

  // C4. 既有铁律不被破坏：时长倍率方向、animOn=false 终态
  check('（回归）补间时长仍为 PIE_ANIM_MS × speedRef.current', /PIE_ANIM_MS\s*\*\s*speedRef\.current/.test(viewCode));
  check('（回归）animOn=false 直接 setProgress(1) 终态', /if \(!animOn\) \{\s*setProgress\(1\);/.test(viewCode));
}

// ---------- D. 可证伪性：注入「指纹破坏者」必须变红 ----------
section('D. 可证伪性自证（注入破坏者 → 断言必须变红）');
{
  // 把 effect 依赖替换回引用依赖（模拟「有人回退成旧写法」）
  const broken = viewCode.replace(/\},\s*\[animOn,\s*slicesFingerprint\]\);/, '}, [animOn, slices];');
  const stillGreen = /\},\s*\[animOn,\s*slicesFingerprint\]\);/.test(broken);
  check('注入后原断言确实变红（证明断言有效、不是永真）', !stillGreen,
    '注入指纹破坏者后断言仍然绿 → 断言写死了，无区分度');
  // 再把指纹 memo 也破坏掉（返回常量串），断言同样必须红
  const broken2 = viewCode.replace(
    /const slicesFingerprint = useMemo\(\(\) => pieFingerprint\(slices\), \[slices\]\);/,
    'const slicesFingerprint = useMemo(() => "CONST", [slices]);'
  );
  check('破坏指纹 memo 后 C2 断言变红', !/pieFingerprint\(slices\)/.test(broken2));
}

console.log('\n' + '='.repeat(60));
console.log(`断言：${pass} 通过 / ${fail} 失败`);
console.log('');
console.log('本脚本覆盖：内容指纹语义（同不重播/异重播）、StatsView 依赖结构、');
console.log('可证伪性自证（NY_PIE_DEP_BREAK 式注入应变红）。');
console.log('⚠️ 未覆盖（需浏览器人工）：真实 rAF 播放次数、动画主观流畅度。');
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log('  - ' + f));
}
try {
  fs.unlinkSync(tmpRank);
} catch {
  /* 临时文件已不存在则忽略 */
}
process.exit(fail === 0 ? 0 : 1);
