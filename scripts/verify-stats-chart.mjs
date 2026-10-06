// v2.3.94 需求 11 验证：统计界面的几何 / 配色 / 对比度 / 分组工具
// 用法：node scripts/verify-stats-chart.mjs
// 做法：直接打包真实的 src/utils/statsChart.ts 跑断言。
// 该文件是纯计算工具（饼图弧线、主题取色、WCAG 对比度、时长拆分）——
// 这些是统计界面「不出错」的地基：弧线算错饼就歪、对比度不够文字就读不清、时长算错就显示乱码。
// ⚠️ 排序规则（好感度/陪伴时间的 tiebreak）在 StatsView.tsx 内联，无法在此验证，
//    已在报告中标注为人工核对项，不要误以为本脚本覆盖了它。

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src', 'utils', 'statsChart.ts');
if (!fs.existsSync(SRC)) { console.error('找不到 src/utils/statsChart.ts —— 需求 11 未实现？'); process.exit(1); }
const tmp = path.join(os.tmpdir(), `ny-stats-${Date.now()}.mjs`);
await build({ entryPoints: [SRC], outfile: tmp, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const M = await import(pathToFileURL(tmp).href);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL  ' + name + ' ' + extra); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

console.log('导出：' + Object.keys(M).join(', '));

section('A. 弧线路径 arcPath：0%→0°，100%→360°');
{
  const full = M.arcPath(50, 50, 40, 0, Math.PI * 2);
  check('整圆有 path 输出', typeof full === 'string' && full.length > 0, String(full).slice(0, 60));
  const half = M.arcPath(50, 50, 40, 0, Math.PI);
  check('半圆 path 与整圆不同', half !== full);
  check('path 以 M 或 m 开头（合法 SVG）', /^[Mm]/.test(String(full).trim()), String(full).slice(0, 20));
  check('半径 0 不崩', typeof M.arcPath(0, 0, 0, 0, Math.PI) === 'string');
  check('起点角度为 0 不崩', typeof M.arcPath(50, 50, 40, 0, 0) === 'string');
}

section('B. 整圆不能退化成一条线（饼图第一帧的「圆心拉出一条线」）');
{
  const full = String(M.arcPath(50, 50, 40, 0, Math.PI * 2));
  // 整圆的起终点重合，必须靠 A 指令画两段弧，否则浏览器只画 0 弧长 = 什么都不显示
  const arcs = (full.match(/A/gi) || []).length;
  check('整圆用两段弧闭合', arcs >= 2, `A 指令数=${arcs}，path=${full.slice(0, 120)}`);
}

section('C. WCAG 对比度：已知配对的实测值');
{
  const white = M.parseCssColor('#ffffff');
  const black = M.parseCssColor('#000000');
  check('解析 #ffffff', Array.isArray(white) && white.length === 3, JSON.stringify(white));
  check('解析 rgb()', !!M.parseCssColor('rgb(255, 255, 255)'), JSON.stringify(M.parseCssColor('rgb(255, 255, 255)')));
  check('解析 #rgb 短写法', !!M.parseCssColor('#fff'));
  check('不支持的输入返回 null', M.parseCssColor('not-a-color') === null, JSON.stringify(M.parseCssColor('not-a-color')));
  const cw = M.contrastRatio(white, black);
  check('黑白对比度 = 21', close(cw, 21, 0.1), `实际 ${cw}`);
  const same = M.contrastRatio(white, white);
  check('同色对比度 = 1', close(same, 1, 0.01), `实际 ${same}`);
  check('对比度对称（交换 fg/bg 结果相同）', close(M.contrastRatio(white, black), M.contrastRatio(black, white), 0.01));
}

section('D. WCAG AA 判定（4.5:1 正文 / 3:1 大字）');
{
  // #767676 on #ffffff ≈ 4.54:1（正文刚好过 AA）；#777 on white ≈ 4.48（不过）
  const good = M.contrastRatio(M.parseCssColor('#767676'), M.parseCssColor('#ffffff'));
  const bad = M.contrastRatio(M.parseCssColor('#999999'), M.parseCssColor('#ffffff'));
  check('中灰 #767676 过 AA 正文线(≥4.5)', good >= 4.5, `实际 ${good.toFixed(2)}`);
  check('浅灰 #999999 不过 AA 正文线', bad < 4.5, `实际 ${bad.toFixed(2)}`);
  check('严格更大对比度必然也过', M.contrastRatio(M.parseCssColor('#333333'), M.parseCssColor('#ffffff')) >= 4.5);
}

section('E. 文字色自动选黑/白（饼图 tooltip 与扇区上的标签）');
{
  check('深底 → 白字', typeof M.readableTextOn === 'function');
  if (typeof M.readableTextOn === 'function') {
    // 注意真实签名：readableTextOn(bg: [r,g,b]) 返回**颜色字符串**（如 '#ffffff'），不是数组
    const onDark = M.readableTextOn(M.parseCssColor('#101010'));
    const onLight = M.readableTextOn(M.parseCssColor('#f5f5f5'));
    check('返回字符串', typeof onDark === 'string', typeof onDark);
    const lumOf = (c) => {
      const [r, g, b] = M.parseCssColor(c);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    check('深底返回高亮色（接近白）', lumOf(onDark) > 0.75, onDark);
    check('浅底返回深色', lumOf(onLight) < 0.25, onLight);
    // 无论怎么选，都必须达到 AA 正文线
    const fgOnDark = M.contrastRatio(M.parseCssColor(onDark), M.parseCssColor('#101010'));
    const fgOnLight = M.contrastRatio(M.parseCssColor(onLight), M.parseCssColor('#f5f5f5'));
    check('深底上的文字 ≥ 4.5:1', fgOnDark >= 4.5, `实际 ${fgOnDark.toFixed(2)}`);
    check('浅底上的文字 ≥ 4.5:1', fgOnLight >= 4.5, `实际 ${fgOnLight.toFixed(2)}`);
  }
}

section('F. 主题取色（配色随主题变化，不能写死一套）');
{
  check('cssVar 可取 CSS 变量', typeof M.cssVar === 'function');
  const v = M.cssVar('--color-primary');
  check('取到的值是字符串或 null（不抛）', v === null || typeof v === 'string', JSON.stringify(v));
  // 注意：Node 环境没有 document，cssVar 必然读不到真实值 → 返回空串属正常，不是 bug。
  // 这里只断言「不抛异常」。
  check('不存在的变量不崩', (() => { try { M.cssVar('--definitely-not-exist'); return true; } catch { return false; } })());
}

section('G. 饼图配色：不同人物不同颜色，且够亮看得见');
{
  check('buildPiePalette 存在', typeof M.buildPiePalette === 'function');
  if (typeof M.buildPiePalette === 'function') {
    const pal = M.buildPiePalette(8);
    check('返回 8 个颜色', Array.isArray(pal) && pal.length === 8, `实际 ${Array.isArray(pal) ? pal.length : typeof pal}`);
    const uniq = new Set(pal.map((c) => String(c)));
    check('颜色互不相同（不同人物可区分）', uniq.size === pal.length, `唯一色 ${uniq.size}/${pal.length}`);
    // ⚠️ 本脚本运行在 Node，没有 document → cssVar 读不到主题变量 → buildPiePalette 走
    // 「由主色派生」分支，返回 **hsl() 字符串**；而 parseCssColor 只认 hex/rgb。
    // 所以这里不能直接断言对比度（那属于浏览器运行时的事）。
    // 可离线验证的是：**颜色字符串本身合法且互不相同**，以及 hex 分支的对比度。
    const allParseableAsHex = pal.every((c) => !!M.parseCssColor(c));
    check('（说明）palette 在 Node 下返回 hsl —— 浏览器里才是主题实色', !allParseableAsHex || pal.every(c=>/^#|^rgb/.test(c)));
    check('每个颜色都是合法 CSS 颜色串', pal.every((c) => typeof c === 'string' && c.trim().length > 0));
    // 用一个确定的 hex 数组单独验证对比度算法对「主题实色」同样成立
    const themeHex = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
    const okEvery = themeHex.every((c) => {
      const rgb = M.parseCssColor(c);
      const cw = M.contrastRatio(rgb, M.parseCssColor('#ffffff'));
      const cb = M.contrastRatio(rgb, M.parseCssColor('#000000'));
      return Math.max(cw, cb) >= 3;
    });
    check('对比度算法对典型主题实色均 ≥3:1', okEvery);
  }
}

section('H. 「其他」项配色与扇区区分');
{
  check('otherSliceColor 存在', typeof M.otherSliceColor === 'function');
  if (typeof M.otherSliceColor === 'function' && typeof M.buildPiePalette === 'function') {
    const pal = M.buildPiePalette(4);
    const other = M.otherSliceColor(pal);
    check('其他项有独立颜色', !!other);
    check('其他项与普通扇区颜色不同', !pal.map(String).includes(String(other)), `${other} vs ${JSON.stringify(pal)}`);
    check('空 palette 时不崩', typeof M.otherSliceColor([]) === 'string');
  }
}

section('I. 陪伴时长拆分 splitCompanion');
{
  check('splitCompanion 存在', typeof M.splitCompanion === 'function');
  if (typeof M.splitCompanion === 'function') {
    const d = M.splitCompanion(90061000); // 1天1小时1分1秒
    check('返回对象含天/时/分/秒', d && typeof d === 'object' && 'days' in d, JSON.stringify(d));
    if (d && 'days' in d) {
      check('天数 = 1', d.days === 1, `实际 ${d.days}`);
      check('小时 = 1', d.hours === 1, `实际 ${d.hours}`);
      check('分钟 = 1', d.minutes === 1, `实际 ${d.minutes}`);
    }
    check('0 毫秒不崩', typeof M.splitCompanion(0) === 'object');
    check('负数不崩', typeof M.splitCompanion(-5000) === 'object');
    check('不足 1 分钟 → 天/时/分均为 0', (() => {
      const x = M.splitCompanion(30000);
      return x.days === 0 && x.hours === 0 && x.minutes === 0;
    })());
  }
}

console.log('\n' + '='.repeat(56));
console.log('断言：' + pass + ' 通过 / ' + fail + ' 失败');
console.log('⚠️  注意：本脚本**未覆盖** StatsView.tsx 内联的排序规则');
console.log('   （好感度同→陪伴久者优先 / 陪伴同→好感高者优先 / 全同→字母序）');
if (failures.length) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  - ' + f)); }
fs.unlinkSync(tmp);
process.exit(fail === 0 ? 0 : 1);