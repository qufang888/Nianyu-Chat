// v2.3.94 需求 13 / 14 验证：聊天搜索 与 不常用聊天文件夹
// 用法：node scripts/verify-inactive-folder.mjs
// 做法：直接打包真实的 src/utils/inactiveChats.ts 跑断言（纯函数，零 React/electron 依赖）。
// 这两条都是「用户明确提了但极易做漏」的功能（尤其「置顶不自动移入」「移出不恢复置顶」
// 「移出后不许立刻弹回」），没有门禁就会在下一次重构里悄悄退化。

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src', 'utils', 'inactiveChats.ts');
if (!fs.existsSync(SRC)) { console.error('找不到 src/utils/inactiveChats.ts —— 需求 14 未实现？'); process.exit(1); }
const tmp = path.join(os.tmpdir(), `ny-inactive-${Date.now()}.mjs`);
await build({ entryPoints: [SRC], outfile: tmp, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const M = await import(pathToFileURL(tmp).href);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL  ' + name + ' ' + extra); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 7);
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const chat = (id, daysAgo, extra = {}) => ({ chat_type: 'single', chat_id: id, last_time: iso(daysAgo), chat_name: id, ...extra });

section('A. 导出齐全');
{
  const need = ['partitionByInactive', 'isInactiveChat', 'moveChatToInactive', 'moveChatOutOfInactive', 'clampInactiveDays'];
  const missing = need.filter((k) => typeof M[k] !== 'function');
  check('核心函数都已导出', missing.length === 0, '缺：' + missing.join(','));
  check('阈值常量存在且默认 30', M.INACTIVE_DAYS_DEFAULT === 30);
}

section('B. 天数阈值：超过才移入');
{
  check('1 天未聊 → 常用', M.isInactiveChat(chat('a', 1), {}, 30, [], NOW) === false);
  check('29 天未聊 → 常用', M.isInactiveChat(chat('a', 29), {}, 30, [], NOW) === false);
  check('30 天未聊 → 移入（边界含等号）', M.isInactiveChat(chat('a', 30), {}, 30, [], NOW) === true);
  check('31 天未聊 → 移入', M.isInactiveChat(chat('a', 31), {}, 30, [], NOW) === true);
}

section('C. 阈值可配（设置里改天数立即生效）');
{
  const c = chat('x', 10);
  check('阈值 30 → 10 天不移入', M.isInactiveChat(c, {}, 30, [], NOW) === false);
  check('阈值 7 → 10 天移入', M.isInactiveChat(c, {}, 7, [], NOW) === true);
  check('阈值 1 → 10 天移入', M.isInactiveChat(c, {}, 1, [], NOW) === true);
}

section('D. 置顶聊天不自动移入（用户明确要求）');
{
  const c = chat('p', 99);
  check('置顶聊天即使 99 天没聊也不自动移入', M.isInactiveChat(c, {}, 30, ['single:p'], NOW) === false);
  check('同样条件下未置顶的会移入', M.isInactiveChat(c, {}, 30, [], NOW) === true);
}

section('E. 手动移入：置顶状态消失（用户明确要求）');
{
  const r = M.moveChatToInactive('single:p', {}, ['single:p', 'single:q']);
  check('手动移入写入标记 true', r.inactiveChats['single:p'] === true, JSON.stringify(r.inactiveChats));
  check('置顶被移除', !r.pinnedChats.includes('single:p'), JSON.stringify(r.pinnedChats));
  check('其他置顶不受影响', r.pinnedChats.includes('single:q'), JSON.stringify(r.pinnedChats));
  // 不应记录「曾置顶」
  check('没有记录曾置顶的字段', !JSON.stringify(r).includes('wasPinned') && !JSON.stringify(r).includes('prevPinned'));
}

section('F. 移出后不恢复置顶 + 不立刻弹回（用户明确要求）');
{
  // 注意真实签名：moveChatOutOfInactive(key, manual) 直接返回新的 manual map（不是 {inactiveChats} 包装）
  const manual = { 'single:p': true };
  const out = M.moveChatOutOfInactive('single:p', manual);
  check('移出后不再是 true', out['single:p'] !== true, JSON.stringify(out));
  check('移出写入豁免标记 false（防止立刻弹回）', out['single:p'] === false, JSON.stringify(out));
  check('不影响其他聊天的标记', !('single:q' in out), JSON.stringify(out));
  const c = chat('p', 99);
  check('豁免期间不会被自动判定移回', M.isInactiveChat(c, out, 30, [], NOW) === false);
  // 豁免 = 与「手动移入」对称的手动覆盖：恒生效，不随超期自动失效。
  // （v2.3.100 曾改为「仅仍新鲜时豁免」，使该分支恒不生效 → 移出后立刻弹回；此断言即为回归门禁）
  check('豁免是手动覆盖：即便 9999 天未聊也不被自动收回', M.isInactiveChat(chat('p', 9999), out, 30, [], NOW) === false);
  check('豁免标记下手动判定也为 false', M.isManuallyInactive('single:p', out) === false);
  check('isInactivityExempt 识别正确', M.isInactivityExempt('single:p', out) === true);
  // 移出接口不接收也不返回 pinnedChats → 结构上就不可能「恢复置顶」
  const out2 = M.moveChatOutOfInactive('single:z', {});
  check('移出接口不返回 pinnedChats（结构上无法恢复置顶）', !('pinnedChats' in out2), JSON.stringify(out2));
}

section('G. 手动优先于自动');
{
  const c = chat('m', 1); // 才 1 天没聊（自动不该移入），但手动标了 true
  check('手动标 true 时即便很活跃也移入', M.isInactiveChat(c, { 'single:m': true }, 30, [], NOW) === true);
}

section('H. 分组函数：两堆无重叠、总数不丢');
{
  const manual = { 'single:b': true };
  const items = [
    chat('a', 1),      // 活跃
    chat('b', 1),      // 手动移入
    chat('c', 99),     // 自动移入
    chat('d', 99),     // 置顶 → 不移入
    chat('e', 0.5),    // 今天聊过
  ];
  const pinned = ['single:d'];
  const r = M.partitionByInactive(items, manual, 30, pinned, NOW);
  const a = r.active.map((x) => x.chat_id);
  const b = r.inactive.map((x) => x.chat_id);
  check('活跃堆含 a', a.includes('a'), JSON.stringify(a));
  check('手动移入的 b 在不常用堆', b.includes('b'), JSON.stringify(b));
  check('自动移入的 c 在不常用堆', b.includes('c'), JSON.stringify(b));
  check('置顶的 d 不在不常用堆', !b.includes('d'), JSON.stringify(b));
  check('今天聊过的 e 在活跃堆', a.includes('e'), JSON.stringify(a));
  check('两堆无重叠', !a.some((x) => b.includes(x)));
  check('总数不丢失', a.length + b.length === items.length, `${a.length}+${b.length}`);
  check('保持传入顺序（活跃堆）', JSON.stringify(a) === JSON.stringify(['a', 'd', 'e']), JSON.stringify(a));
}

section('I. 需求 13：搜索候选必须包含不常用文件夹内的聊天');
{
  const items = [chat('in_folder', 99, { chat_name: '老朋友' }), chat('active_one', 1, { chat_name: '老同学' })];
  const r = M.partitionByInactive(items, {}, 30, [], NOW);
  const searchItems = [...r.active, ...r.inactive];
  check('搜索候选 = 活跃 + 不常用（无遗漏）', searchItems.length === 2, `实际 ${searchItems.length}`);
  check('不常用文件夹内的聊天在搜索候选里', searchItems.some((x) => x.chat_id === 'in_folder'));
}

section('J. 边界与阈值钳制');
{
  check('空列表不崩', (() => { const r = M.partitionByInactive([], {}, 30, [], NOW); return r.active.length === 0 && r.inactive.length === 0; })());
  check('缺 last_time 判为常用（不藏）', M.isInactiveChat({ chat_type: 'single', chat_id: 'z' }, {}, 30, [], NOW) === false);
  check('非法 last_time 判为常用', M.isInactiveChat({ chat_type: 'single', chat_id: 'z', last_time: 'not-a-date' }, {}, 30, [], NOW) === false);
  check('未来时间不崩且判为常用', M.isInactiveChat(chat('f', -5), {}, 30, [], NOW) === false);
  check('clamp: 0 → 1', M.clampInactiveDays(0) === 1);
  check('clamp: -99 → 1', M.clampInactiveDays(-99) === 1);
  check('clamp: 99999 → 3650', M.clampInactiveDays(99999) === 3650);
  check('clamp: 非数 → 默认 30', M.clampInactiveDays('abc') === 30);
  check('clamp: 小数向下取整', M.clampInactiveDays(7.9) === 7);
  check('inactiveDays 缺时间返回 -1', M.inactiveDays({ chat_type: 'single', chat_id: 'q' }, NOW) === -1);
}

console.log('\n' + '='.repeat(52));
console.log('断言：' + pass + ' 通过 / ' + fail + ' 失败');
if (failures.length) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  - ' + f)); }
fs.unlinkSync(tmp);
process.exit(fail === 0 ? 0 : 1);