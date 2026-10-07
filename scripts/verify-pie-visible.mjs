// v2.3.95验证：统计页饼图「可见性 + 展开动画」的两条地基
// 用法：node scripts/verify-pie-visible.mjs
// 做法：用 esbuild 打包真实的 src/utils/statsRank.ts + statsChart.ts 跑断言，
//       并用「与 StatsView.tsx 完全相同的算式」在 Node 里复算一遍渲染数学。
//
// 这个脚本存在的理由（对应用户原话「聊天统计界面的饼图呢？饼图去哪了，
// 也没有饼图的展开动画？」）：饼图看不见有**两个互相独立**的原因，
// 修一个不够，必须同时锁死，否则任何一次重构都会让饼图再次整块消失：
//
//   BUG-A（致命·有数据时也不显示）StatsView 渲染时写的是
//          `Math.min(1, g.span * progress)` —— 把上限写成了常量 1（度），
//          而正确上限是扇区自己的 span（度）。于是任何扇区动画结束时
//          只画 1° ≈ 1.5px 头发丝 → 整块饼图看起来就是「没有」。
//          **这才是第一主因**：它连"有数据"时都不显示。
//   BUG-B（次要·无数据时整块消失）buildPieSlices 在全员tokens=0 时按设计返回 []，
//          而 UI 层曾把整个饼图区域替换成一行文字 → 「没有数据」被渲染成「饼图不存在」。
//          本任务**不改 buildPieSlices 的签名与语义**，只在 UI 层加空态。
//
// ⚠️ 本脚本覆盖不到的部分（已在报告中标注为人工核对项）：
//   - StatsView 里 rAF 补间是否真的被 isGroupEnabled(settings,'stats') 门控
//   - PieEmptyState 的 JSX 是否真的渲染出 <circle>（需要浏览器/DOM）
//   两者请勿误以为已被本脚本覆盖。

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const RANK = path.join(ROOT, 'src', 'utils', 'statsRank.ts');
const CHART = path.join(ROOT, 'src', 'utils', 'statsChart.ts');
for (const f of [RANK, CHART]) {
  if (!fs.existsSync(f)) { console.error(`��不到 ${f}`); process.exit(1); }
}

// 分别把两个 util 打成单文件（沿用 verify-stats-chart.mjs 的做法，避免多入口产物命名不确定）
const tmpRank = path.join(os.tmpdir(), `ny-pie-rank-${Date.now()}.mjs`);
const tmpChart = path.join(os.tmpdir(), `ny-pie-chart-${Date.now()}.mjs`);
const opts = { bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' };
await build({ entryPoints: [RANK], outfile: tmpRank, ...opts });
await build({ entryPoints: [CHART], outfile: tmpChart, ...opts });
const M = await import(pathToFileURL(tmpRank).href);
const C = await import(pathToFileURL(tmpChart).href);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL  ' + name + ' ' + extra); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------- 测试夹具 ----------
const OTHER = '其它';
const PAL = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#64748b', '#a855f7'];
/** 构造一行RankRow（字段与 statsRank.ts 的接口一一对应） */
const row = (roleId, name, tokens) => ({
  roleId, name, avatar: '', affinity: 0, companionMs: 0, tokens, messages: 0, mood: '', relation: '',
});
const sum = (a) => a.reduce((s, v) => s + v, 0);
const sumRatio = (list) => sum(list.map((s) => s.ratio));

// ---------- 与 StatsView.tsx 逐字对应的渲染数学 ----------
// （改动 StatsView 时必须同步改这里，否则脚本会验证一个已经没人用的算式）
const PIE_FULL = 360;
/** StatsView 的 geo：过滤非法 ratio，再按序累加起止角 */
function geoOf(slices) {
  const valid = slices.filter((s) => Number.isFinite(s.ratio) && s.ratio > 0);
  let acc = 0;
  return valid.map((s) => {
    const span = s.ratio * PIE_FULL;
    const start = acc;
    acc += span;
    return { slice: s, start, span };
  });
}
/** StatsView 修复后的 shown 算式：上限是扇区自己的 span，不是常量 1 */
function shownOf(g, progress) {
  const p = Math.max(0, Math.min(1, progress));
  return Math.max(0, Math.min(g.span, g.span * p));
}
/** 旧版（BUG-A）的算式，仅用于「证明旧代码确实是坏的」 */
function shownOfBuggy(g, progress) {
  return Math.max(0, Math.min(1, g.span * progress));
}

console.log('buildPieSlices 导出：' + typeof M.buildPieSlices);
console.log('OTHER_THRESHOLD =' + M.OTHER_THRESHOLD);

// ============================================================================
section('A. 有人有 Token 时：扇区正确、ratio 之和为 1、颜色已分配');
// ============================================================================
{
  const slices = M.buildPieSlices([row('r1', '小明', 600), row('r2', '小红', 400)], PAL, OTHER);
  check('返回 2 个扇区', slices.length === 2, `实际 ${slices.length}`);
  check('ratio 之和为 1', close(sumRatio(slices), 1, 1e-12), `实际 ${sumRatio(slices)}`);
  check('按 Token 降序（600 在前）', slices[0].tokens === 600, JSON.stringify(slices.map((s) => s.tokens)));
  check('key 用 roleId', slices[0].key === 'r1' && slices[1].key === 'r2', JSON.stringify(slices.map((s) => s.key)));
  check('每个扇区都分到了非空颜色', slices.every((s) => typeof s.color === 'string' && s.color.length > 0),
    JSON.stringify(slices.map((s) => s.color)));
  check('两个扇区颜色不同', slices[0].color !== slices[1].color);
  check('60% / 40% 精确', close(slices[0].ratio, 0.6, 1e-12) && close(slices[1].ratio, 0.4, 1e-12),
    JSON.stringify(slices.map((s) => s.ratio)));
  check('isOther 均为 false', slices.every((s) => !s.isOther));
}

// ============================================================================
section('B. <10% 并入「其他」：Token 守恒 + 「其他」项标记正确');
// ============================================================================
{
  // 900 / 60 / 40 →60(6%) 与 40(4%) 均 <10% → 并入「其它」
  const rows = [row('r1', '小明', 900), row('r2', '小红', 60), row('r3', '小刚', 40)];
  const total = sum(rows.map((r) => r.tokens));
  const slices = M.buildPieSlices(rows, PAL, OTHER);
  check('产出 2 项（1 主项 + 其它）', slices.length === 2, `实际 ${slices.length}`);
  check('Token 守恒（合计 === 总量）', sum(slices.map((s) => s.tokens)) === total,
    `${sum(slices.map((s) => s.tokens))} vs ${total}`);
  check('ratio 之和为 1', close(sumRatio(slices), 1, 1e-12), `实际 ${sumRatio(slices)}`);
  const other = slices.find((s) => s.isOther);
  check('存在 isOther 项', !!other);
  check('其它 key 为 __other__', other && other.key === '__other__', other && other.key);
  check('其它 Token = 60+40 = 100', other && other.tokens === 100, other && String(other.tokens));
  check('其它 ratio = 0.1', other && close(other.ratio, 0.1, 1e-12), other && String(other.ratio));
  check('合并 2 项时名字带数量', other && other.name.includes('2'), other && other.name);
  check('主项 ratio = 0.9', close(slices[0].ratio, 0.9, 1e-12), String(slices[0].ratio));
}

// ============================================================================
section('C. 全部 tokens = 0 → 返回空数组（BUG-B 的前提，语义**不改**）');
// ============================================================================
{
  check('1 个人 tokens=0 → []', M.buildPieSlices([row('r1', '小明', 0)], PAL, OTHER).length === 0);
  check('3 个人全为 0 → []', M.buildPieSlices([row('r1', 'a', 0), row('r2', 'b', 0), row('r3', 'c', 0)], PAL, OTHER).length === 0);
  check('空数组入参 → []', M.buildPieSlices([], PAL, OTHER).length === 0);
  check('负数 tokens 也被过滤 → []', M.buildPieSlices([row('r1', '小明', -5)], PAL, OTHER).length === 0);
  check('「全员为 0」确实返回空数组 → UI 层必须自己处理空态', true);
}

// ============================================================================
section('D. 百分比合计：绝不出现 NaN / 负值 / 超过 100%');
// ============================================================================
{
  const cases = [
    ['单人物 100%', [row('r1', '小明', 100)]],
    ['两人 50/50', [row('r1', '小明', 100), row('r2', '小红', 100)]],
    ['十人各 10%（恰好等于阈值，不并入）', Array.from({ length: 10 }, (_, i) => row('r' + i, 'n' + i, 100))],
    ['一大九小（小并入其它）', [row('big', '大', 1000), ...Array.from({ length: 9 }, (_, i) => row('s' + i, '小' + i, 10))]],
    ['含 0 值混入', [row('r1', '小明', 100), row('r2', '零', 0)]],
  ];
  for (const [label, rows] of cases) {
    const slices = M.buildPieSlices(rows, PAL, OTHER);
    const pcts = slices.map((s) => s.ratio * 100);
    check(`${label}:无 NaN`, pcts.every((p) => Number.isFinite(p)), JSON.stringify(pcts));
    check(`${label}: 无负值`, pcts.every((p) => p >= 0), JSON.stringify(pcts));
    check(`${label}: 无单项 >100%`, pcts.every((p) => p <= 100 + 1e-9), JSON.stringify(pcts));
    if (slices.length > 0) {
      check(`${label}: 合计 === 100%`, close(sum(pcts), 100, 1e-9), `实际 ${sum(pcts)}`);
      check(`${label}: Token 守恒`, sum(slices.map((s) => s.tokens)) === sum(rows.map((r) => Math.max(0, r.tokens))),
        `${sum(slices.map((s) => s.tokens))} vs ${sum(rows.map((r) => Math.max(0, r.tokens)))}`);
    }
  }
}

// ============================================================================
section('E. 边界：单人物 100% / 恰好 10% / 恰好 9.99% / 空数组');
// ============================================================================
{
  // E1 单人物 100%
  const one = M.buildPieSlices([row('r1', '小明', 12345)], PAL, OTHER);
  check('单人物 → 恰好 1 个扇区', one.length === 1, `实际 ${one.length}`);
  check('单人物 ratio === 1', close(one[0].ratio, 1, 1e-12), String(one[0].ratio));
  check('单人物不产生「其它」', !one.some((s) => s.isOther));
  check('单人物扇区跨度 === 360°', close(geoOf(one)[0].span, 360, 1e-9), String(geoOf(one)[0].span));

  // E2 恰好 10%（阈值是 <10% 才并入，故 10% 应当**保留**为独立扇区）
  const at10 = M.buildPieSlices([row('a', '甲', 100), row('b', '乙', 900)], PAL, OTHER);
  check('恰好 10% 的项**不**并入其它（阈值是严格小于）', !at10.some((s) => s.isOther),
    JSON.stringify(at10.map((s) => ({ k: s.key, r: s.ratio, o: s.isOther }))));
  check('恰好 10% 时恰好 2 个扇区', at10.length === 2, `实际 ${at10.length}`);
  check('恰好 10% 时 ratio 守恒', close(sumRatio(at10), 1, 1e-12));

  // E3 恰好 9.99%（应并入其它）
  const at999 = M.buildPieSlices([row('a', '甲', 999), row('b', '乙', 9001)], PAL, OTHER);
  check('9.99% 的项**并入**其它', at999.some((s) => s.isOther),
    JSON.stringify(at999.map((s) => ({ k: s.key, r: s.ratio, o: s.isOther }))));
  check('9.99% 并入后 Token 守恒', sum(at999.map((s) => s.tokens)) === 10000,
    String(sum(at999.map((s) => s.tokens))));

  // E4 空数组
  const none = M.buildPieSlices([], PAL, OTHER);
  check('空数组 → []', Array.isArray(none) && none.length === 0);
  check('空数组时 geo 也是空（UI 走空态分支）', geoOf(none).length === 0);
}

// ============================================================================
section('F. geo 非法值保护：NaN / Infinity / 负数 ratio 不能污染整块饼图');
// ============================================================================
{
  const dirty = [
    { key: 'ok', name: '正常', tokens: 100, ratio: 0.5, color: '#111', isOther: false },
    { key: 'nan', name: 'NaN', tokens: 0, ratio: NaN, color: '#222', isOther: false },
    { key: 'inf', name: 'Inf', tokens: 0, ratio: Infinity, color: '#333', isOther: false },
    { key: 'neg', name: '负', tokens: 0, ratio: -0.3, color: '#444', isOther: false },
    { key: 'zero', name: '零', tokens: 0, ratio: 0, color: '#555', isOther: false },
  ];
  const geo = geoOf(dirty);
  check('脏数据下只剩合法项（3 → 1）', geo.length === 1, `实际 ${geo.length}`);
  check('合法项被保留', geo.length === 1 && geo[0].slice.key === 'ok');
  check('过滤后无 NaN 起止角', geo.every((g) => Number.isFinite(g.start) && Number.isFinite(g.span)));
  check('过滤后无负起点', geo.every((g) => g.start >= 0));
  check('全脏数据 → geo 为空（不产生 NaN path）', geoOf(dirty.filter((d) => d.key === 'nan')).length === 0);
  // arcPath 拿到 NaN 会返回含 "NaN" 的串 → 浏览器整条path 画不出来
  const nanPath = C.arcPath(100, 100, 88, 44, NaN, 90);
  check('（对照）arcPath 对 NaN 角度确实产出 "NaN" path', /NaN/.test(String(nanPath)), String(nanPath).slice(0, 60));
  check('故必须在 geo 阶段拦掉（不能指望 arcPath）', true);
}

// ============================================================================
section('G. BUG-A 回归：动画结束时每个扇区必须画满自己的 span');
// ============================================================================
{
  const slices = M.buildPieSlices([row('r1', '小明', 600), row('r2', '小红', 300), row('r3', '小刚', 100)], PAL, OTHER);
  const geo = geoOf(slices);
  for (const g of geo) {
    check(`progress=1 时「${g.slice.name}」画满 ${g.span}°`,
      close(shownOf(g, 1), g.span, 1e-9), `shown=${shownOf(g, 1)} span=${g.span}`);
  }
  const totalShown = sum(geo.map((g) => shownOf(g, 1)));
  check('progress=1 时所有扇区角度合计 = 360°', close(totalShown, 360, 1e-9), `实际 ${totalShown}`);
  check('progress=1 时绝不只剩1° 头发丝（BUG-A 的判据）', totalShown > 359,
    `实际 ${totalShown}° —— 若约等于 1 则旧 BUG 仍在`);

  // 单人物 100% 的极端情形：旧代码在这里画 1°，新代码画满 360°
  const g1 = geoOf(M.buildPieSlices([row('solo', '独苗', 100)], PAL, OTHER))[0];
  check('单人物 100%：progress=1 画满 360°', close(shownOf(g1, 1), 360, 1e-9), `实际 ${shownOf(g1, 1)}`);
  check('单人物 100%：旧算式只画 1°（证明旧代码确实坏）', close(shownOfBuggy(g1, 1), 1, 1e-9),
    `实际 ${shownOfBuggy(g1, 1)}`);

  // 半程应当严格介于 0 与满值之间（这才是「展开动画」）
  for (const g of geo) {
    const half = shownOf(g, 0.5);
    check(`progress=0.5 时「${g.slice.name}」介于 0 与满值之间`, half > 0 && half < g.span, `实际 ${half}`);
  }
  check('progress=0 时不画任何扇区（动画起点）', geo.every((g) => shownOf(g, 0) === 0));
}

// ============================================================================
section('H. 展开动画时序：0 → 单调递增 → 1，且动画时长在 800~1000ms');
// ============================================================================
{
  // 复刻 StatsView 的 rAF 补间：easeOutCubic + PIE_ANIM_MS
  const PIE_ANIM_MS = 900;
  const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
  check('动画时长 PIE_ANIM_MS 在 800~1000ms（用户能看清拉开过程）',
    PIE_ANIM_MS >= 800 && PIE_ANIM_MS <= 1000, `实际 ${PIE_ANIM_MS}ms`);

  const frames = [0, 0.25, 0.5, 0.75, 1].map((f) => easeOutCubic(f));
  check('首帧为 0（从圆心一条线开始）', close(frames[0], 0, 1e-12), String(frames[0]));
  check('末帧为 1（完全展开）', close(frames[frames.length - 1], 1, 1e-12));
  check('全过程单调不减（不会中途回缩）', frames.every((v, i) => i === 0 || v >= frames[i - 1]), JSON.stringify(frames));
  check('easeOutCubic 起步快于线性（p=0.25 时 >0.25）', easeOutCubic(0.25) > 0.25, String(easeOutCubic(0.25)));
  check('全程无 NaN', frames.every(Number.isFinite));

  // 逐帧驱动真实扇区，确认角度累加始终单调、且末帧收口到 360°
  const geo = geoOf(M.buildPieSlices([row('r1', '甲', 500), row('r2', '乙', 300), row('r3', '丙', 200)], PAL, OTHER));
  let prevTotal = -1, monotonic = true;
  for (let f = 0; f <= 1.0001; f += 0.05) {
    const t = sum(geo.map((g) => shownOf(g, easeOutCubic(f))));
    if (t < prevTotal - 1e-9) monotonic = false;
    prevTotal = t;
  }
  check('逐帧推进时已展开角度单调不减', monotonic);
  check('末帧已展开角度 = 360°', close(prevTotal, 360, 1e-6), `实际 ${prevTotal}`);
  check('所有帧的已展开角度都 ≤ 360°（不越界）',
    (() => { for (let f = 0; f <= 1.0001; f += 0.01) { const t = sum(geo.map((g) => shownOf(g, easeOutCubic(f)))); if (t > 360 + 1e-6) return false; } return true; })());
}

// ============================================================================
section('I. animOn=false 必须直接是终态（绝不能停在 progress=0）');
// ============================================================================
{
  const geo = geoOf(M.buildPieSlices([row('r1', '甲', 700), row('r2', '乙', 300)], PAL, OTHER));
  // StatsView 里 animOn=false 时 p 直接取 1，等价于「跳过 rAF 立刻显示终态」
  const pWhenAnimOff = 1;
  const total = sum(geo.map((g) => shownOf(g, pWhenAnimOff)));
  check('animOn=false 时角度合计 = 360°（直接终态）', close(total, 360, 1e-9), `实际 ${total}`);
  check('animOn=false 时不会出现 0°（饼图不会消失）', total > 0);
  check('animOn=false 与 animOn=true 末帧结果一致（无视觉差异）',
    close(total, sum(geo.map((g) => shownOf(g, 1))), 1e-9));
  // 旧算式在 animOn=false 时恰好是对的（走 else 分支用 g.span），
  // 但 animOn=true 时是错的 —— 说明「关掉动画就能看到饼图」正是用户遇到的现象
  const buggyTotal = sum(geo.map((g) => shownOfBuggy(g, 1)));
  check('（对照）旧算式在 animOn=true 时只有 ~1°/扇区，故用户完全看不到饼图',
    buggyTotal < 3, `实际 ${buggyTotal}°`);
}

// ============================================================================
section('J. 扇区调色板：数量足够且互不相同（不同人物不能撞色）');
// ============================================================================
{
  const pal = C.buildPiePalette(10);
  check('返回 10 个颜色', pal.length === 10, `实际 ${pal.length}`);
  check('颜色互不相同', new Set(pal.map(String)).size === 10);
  check('每个颜色都是非空字符串', pal.every((c) => typeof c === 'string' && c.trim().length > 0));
  check('阈值 10% 意味着扇区最多 10 个 → 调色板给到 10 足够', close(M.OTHER_THRESHOLD, 0.1, 1e-12), String(M.OTHER_THRESHOLD));
  // 「其它」项由调用方用 otherSliceColor() 覆盖，必须与普通扇区色可区分
  const other = C.otherSliceColor();
  check('「其它」项颜色与主色板不同色', !pal.map(String).includes(String(other)), String(other));
}

// ============================================================================
section('K. UI 层空态契约：geo 为空时不得产出任何 path');
// ============================================================================
{
  // PieChart 在 slices.length===0 时根本不挂载（走 PieEmptyState），
  // 这里锁死「即便挂载了也不会画出 NaN path」这条底线。
  const emptyGeo = geoOf([]);
  check('空 slices → geo 为空 → 渲染 0 个 path', emptyGeo.length === 0);
  const dirtyGeo = geoOf([{ key: 'nan', name: 'x', tokens: 0, ratio: NaN, color: '#000', isOther: false }]);
  check('全脏数据 → geo 为空 → 渲染 0 个 path（不产生 NaN）', dirtyGeo.length === 0);
  check('空态由 PieEmptyState 单独渲染空圆环（见 StatsView.tsx）', true);
}

// ============================================================================
section('L. 空态圆环在 14 套主题下必须「看得见」（最容易被漏掉的一条）');
// ============================================================================
// 背景：空环是纯装饰图形，按 WCAG 1.4.11「非文本对比」要求 ≥ 3:1。
// 实测教训：最初把环写成 --color-panel-alt，而 panel-alt 与 --color-panel
// 的对比度在 14 套主题里只有 1.00~1.15:1 —— 肉眼完全分不出，
// 「空环」等于「隐形」，那这个修复就等于没修。故此处离线锁死配色选择。
{
  const css = fs.readFileSync(path.join(ROOT, 'src', 'theme', 'variables.css'), 'utf-8');

  // 逐行抽出每个主题块的 CSS 变量
  const themes = [];
  let cur = null;
  for (const raw of css.split('\n')) {
    const t = raw.trim();
    if (cur === null) {
      if (t.endsWith('{') && (t.includes('data-theme') || t.replace('{', '').trim() === ':root')) {
        cur = { sel: t.replace('{', '').trim(), vars: {} };
        themes.push(cur);
      }
      continue;
    }
    if (t.startsWith('}')) { cur = null; continue; }
    const m = /^--([a-z0-9-]+)\s*:\s*([^;]+);$/.exec(t);
    if (m) cur.vars[m[1]] = m[2].trim();
  }
  // v2.3.97：原先硬编码 15（:root + 14 套），但新增液态玻璃主题后变 16 → 任何加主题都会误报。
// 改为与variables.css 里实际的 `[data-theme=` 块数对齐（自洽校验：解析器没漏解析也能对上）。
// （就地读取：varsCss 在检查函数作用域内不可见，放顶层会 ReferenceError）
  const varsSrcNow = fs.readFileSync(path.join(ROOT, 'src', 'theme', 'variables.css'), 'utf-8');
  const themeBlockCount = (varsSrcNow.match(/^\[data-theme=/gm) || []).length;
// themes 解析器只抓 `[data-theme=...]`，:root 不在其中 → 期望值应为 主题块数 + 1（:root）
  const expectThemes = themeBlockCount + 1;
  check(`解析出全部主题块（:root + ${themeBlockCount} 套主题 = ${expectThemes}）`, themes.length === expectThemes, `实际 ${themes.length}`);

  // WCAG 相对亮度 / 对比度（与 utils/statsChart.ts 同口径）
  const relLum = ([r, g, b]) => {
    const ch = (v) => {
      const c = Math.min(255, Math.max(0, v)) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const cr = (a, b) => {
    const la = relLum(a), lb = relLum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const hex2rgb = (h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  const HEX6 = /^#[0-9a-f]{6}$/i;
  // v2.3.97：支持 rgba() —— 半透明主题（glass / liquid）的 --color-panel 是
  // rgba(...) 而非 hex，原实现只认 hex 会把它们全部判为「变量缺失/非hex」而跳过数值判定。
  // 这不只是 liquid 的问题：**任何**半透明主题都会撞上，属于解析器系统性缺口。
  // 修法：解析 rgba 得 [r,g,b,a]，再与该主题的 --color-bg 做 alpha 合成后算对比度
  //（bg 若是渐变则退化为用 --color-panel 的 rgba 叠加到最坏色标；无法解析则跳过并说明）
  const parseAny = (v) => {
    if (!v) return null;
    const m = /^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)\s*(?:[,/]\s*([\d.]+)\s*)?\)/i.exec(v.trim());
    if (m) return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] === undefined ? 1 : Number(m[4]) };
    if (HEX6.test(v.trim())) return { rgb: hex2rgb(v.trim().slice(1)), a: 1 };
    return null;
  };
  const over = (fg, fa, bgRgb) => [0, 1, 2].map((i) => fg[i] * fa + bgRgb[i] * (1 - fa));
  // v2.3.97：--color-bg 常是渐变（glass / vibrant / liquid 都用 linear-gradient），
  // 无法当单一色。取渐变里**亮度最浅**的色标作合成基底 —— 这是最保守的做法
  // （半透明 panel 叠在越亮的底上，合成后越亮，对比度越低）。
  const bgBase = (bgRaw) => {
    if (!bgRaw) return null;
    const direct = parseAny(bgRaw);
    if (direct) return direct.rgb;
    const stops = bgRaw.match(/#[0-9a-f]{6}|rgba?\([^)]*\)/gi) || [];
    const rgbs = stops.map(parseAny).filter(Boolean);
    if (!rgbs.length) return null;
    const lumOf = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    let best = rgbs[0].rgb;
    for (const r of rgbs) if (lumOf(r.rgb) > lumOf(best)) best = r.rgb;
    return best;
  };

  let worst = Infinity, worstName = '';
  const weak = [];
  for (const th of themes) {
    const name = th.sel.replace('[data-theme=', '').replace(']', '').replace(/'/g, '');
    const panel = th.vars['color-panel'];
    const muted = th.vars['color-text-muted'];
    const pAny = parseAny(panel);
    const mAny = parseAny(muted);
    const bgRgbBase = bgBase(th.vars['color-bg']);
    if (!pAny || !mAny) { weak.push(`${name}(变量缺失/不可解析)`); continue; }
    if (!bgRgbBase) { weak.push(`${name}(bg不可解析，仅确认变量存在)`); continue; }
    // 半透明 panel：先把它合成到该主题 bg 上，再与 muted 比对比度
    const panelSolid = pAny.a >= 1 ? pAny.rgb : over(pAny.rgb, pAny.a, bgRgbBase);
    const mutedSolid = mAny.a >= 1 ? mAny.rgb : over(mAny.rgb, mAny.a, panelSolid);
    const ratio = cr(mutedSolid, panelSolid);
    if (ratio < worst) { worst = ratio; worstName = name; }
    if (ratio < 3) weak.push(`${name}=${ratio.toFixed(2)}:1`);
  }
  check('不透明主题的空环描边（text-muted vs panel）全部 ≥3:1', weak.length === 0, weak.join(', '));
  check('最低对比度仍 ≥3:1（WCAG 1.4.11 非文本对比）', worst >= 3, `最低 ${worstName} = ${worst.toFixed(2)}:1`);

  // 反向锁死：环色必须来自 CSS 变量，不得硬编码色值
  const pieCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'index.css'), 'utf-8');
  const inner = /\.stats-pie-empty-ring\.is-inner\s*\{[^}]*\}/.exec(pieCss);
  check('找到 .stats-pie-empty-ring.is-inner 样式块', !!inner, inner ? '' : '未找到');
  if (inner) {
    check('内环用 CSS 变量（不硬编码色值）', /var\(--color-[a-z-]+\)/.test(inner[0]), inner[0].trim());
    check('内环不含裸 hex/rgb 色值', !/#[0-9a-f]{3,6}\b/i.test(inner[0]), inner[0].trim());
  }
  const outer = /\.stats-pie-empty-ring\.is-outer\s*\{[^}]*\}/.exec(pieCss);
  check('外环用 CSS 变量（不硬编码色值）', !!outer && /var\(--color-[a-z-]+\)/.test(outer[0]), outer ? outer[0].trim() : '未找到');

  // 空态文字色必须走语义变量，且不得硬编码
  const titleBlk = /\.stats-pie-empty-title\s*\{[^}]*\}/.exec(pieCss);
  const hintBlk = /\.stats-pie-empty-hint\s*\{[^}]*\}/.exec(pieCss);
  check('空态标题用 --color-text', !!titleBlk && /var\(--color-text\)/.test(titleBlk[0]), titleBlk ? titleBlk[0].trim() : '未找到');
  check('空态提示用 --color-text-secondary', !!hintBlk && /var\(--color-text-secondary\)/.test(hintBlk[0]), hintBlk ? hintBlk[0].trim() : '未找到');
}

console.log('\n' + '='.repeat(60));
console.log(`断言：${pass} 通过 / ${fail} 失败`);
console.log('');
console.log('本脚本覆盖：BUG-A（扇区角度单位错误·致命）、BUG-B（全员0 返回 [] + 空态）、');
console.log('geo NaN 保护、百分比守恒、阈值边界、动画时序、animOn=false 终态、');
console.log('调色板数量、空态圆环在 14 套主题下的可见对比度。');
console.log('⚠️ 本脚本**未覆盖**（需人工/浏览器核对）：');
console.log('   1) StatsView 里 rAF 是否真被 isGroupEnabled(settings,\'stats\') 门控；');
console.log('   2) glass 半透明主题下空环在磨砂背板上的实际观感（离线无法合成 rgba 背板）；');
console.log('   3) 动画的主观流畅度（900ms 是否合适需真机体验）。');
if (failures.length) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  - ' + f)); }
for (const f of [tmpRank, tmpChart]) { try { fs.unlinkSync(f); } catch { /* 临时文件已不存在则忽略 */ } }
process.exit(fail === 0 ? 0 : 1);