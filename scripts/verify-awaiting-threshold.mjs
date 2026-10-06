// v2.3.94 需求 4 验证：主动消息「等你回复」触发阈值
// 用法：node scripts/verify-awaiting-threshold.mjs
// 做法：直接打包真实的 electron/awaitingReply.ts（纯函数 + 依赖注入，零 electron 依赖），
// 用可变闭包注入阈值，驱动真实状态机。这是与 v2.3.93 同款的成熟做法。

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'electron', 'awaitingReply.ts');
const tmp = path.join(os.tmpdir(), `ny-awaiting-${Date.now()}.mjs`);
await build({ entryPoints: [SRC], outfile: tmp, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const { createAwaitingReplyTracker, AWAITING_NEVER } = await import(pathToFileURL(tmp).href);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL  ' + name + ' ' + extra); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/** 造一套可控环境：阈值可变（重要：不要写成常量，否则「动态生效」会假通过） */
function makeEnv({ threshold = 1, gateOpen = true } = {}) {
  const awaiting = new Set();
  const frozen = new Map();
  const idleState = new Map([['single:r1', 1000]]);
  const counts = new Map();
  const broadcasts = [];
  const env = { gateOpen, broadcasts };
  const tracker = createAwaitingReplyTracker({
    maps: { awaiting, frozen, idleState, counts },
    broadcast: (ch, p) => broadcasts.push({ ch, ...p }),
    now: () => 9999,
    isGateOpen: () => env.gateOpen,
    getTriggerThreshold: () => threshold,
  });
  // 可变闭包：setThreshold 改的是 env.threshold，getTriggerThreshold 读它
  env.setThreshold = (v) => { threshold = v; };
  env.tracker = tracker; env.awaiting = awaiting; env.counts = counts;
  env.broadcasts = broadcasts;
  return env;
}

section('A. 阈值=1（旧行为）：发一条即进入等待态');
{
  const e = makeEnv({ threshold: 1 });
  e.tracker.mark('single:r1');
  check('立即进入等待态', e.tracker.isAwaiting('single:r1'));
  check('广播 awaiting=true', e.broadcasts.some((b) => b.awaiting === true && b.chatKey === 'single:r1'));
}

section('B. 阈值=3：前 2 条继续发，第 3 条才等待');
{
  const e = makeEnv({ threshold: 3 });
  e.tracker.mark('single:r1');
  check('第1条后不在等待', !e.tracker.isAwaiting('single:r1'), '不该等');
  check('第1条后计数=1', e.tracker.count('single:r1') === 1, `实际 ${e.tracker.count('single:r1')}`);
  e.tracker.mark('single:r1');
  check('第2条后不在等待', !e.tracker.isAwaiting('single:r1'));
  check('第2条后计数=2', e.tracker.count('single:r1') === 2);
  e.tracker.mark('single:r1');
  check('第3条后进入等待态', e.tracker.isAwaiting('single:r1'), '应该等');
  check('计数=3', e.tracker.count('single:r1') === 3);
}

section('C. 阈值=3：计数期间广播 counting 状态（UI 可显示「再有 n 条」）');
{
  const e = makeEnv({ threshold: 3 });
  e.tracker.mark('single:r1');
  e.tracker.mark('single:r1');
  const counting = e.broadcasts.filter((b) => b.reason === 'counting');
  check('有 counting 广播', counting.length === 2, `实际 ${counting.length}`);
  check('counting 携带 count/threshold', counting[0].count === 1 && counting[0].threshold === 3);
  check('counting 时 awaiting=false', counting.every((b) => b.awaiting === false));
  const sent = e.broadcasts.filter((b) => b.reason === 'sent');
  check('发满后才广播 sent', sent.length === 0);
}

section('D. 阈值动态生效（运行中改设置）');
{
  const e = makeEnv({ threshold: 5 });
  e.tracker.mark('single:r1');
  check('阈值5时计数=1', e.tracker.count('single:r1') === 1);
  e.setThreshold(1);
  e.tracker.mark('single:r1');
  check('改成1后立即等待', e.tracker.isAwaiting('single:r1'), '应立即进入等待');
  e.tracker.clear('single:r1', 'user-reply');
  e.setThreshold(3);
  e.tracker.mark('single:r1');
  check('再改回3则重新计数', !e.tracker.isAwaiting('single:r1') && e.tracker.count('single:r1') === 1);
}

section('E. 「无限条」= 不启用等待（阈值 0 与 ≥9999）');
{
  for (const th of [0, AWAITING_NEVER, 99999]) {
    const e = makeEnv({ threshold: th });
    e.tracker.mark('single:r1');
    check(`阈值=${th} → 不进入等待`, !e.tracker.isAwaiting('single:r1'));
    check(`阈值=${th} → 不计数`, e.tracker.count('single:r1') === 0, `实际 ${e.tracker.count('single:r1')}`);
    check(`阈值=${th} → 不广播`, e.broadcasts.length === 0, `实际 ${e.broadcasts.length}`);
  }
}

section('F. 用户回复后计数必须清零（否则下一轮提前等待）');
{
  const e = makeEnv({ threshold: 3 });
  e.tracker.mark('single:r1');
  e.tracker.mark('single:r1');
  check('回复前计数=2', e.tracker.count('single:r1') === 2);
  e.tracker.clear('single:r1', 'user-reply');
  check('回复后计数清零', e.tracker.count('single:r1') === 0, `实际 ${e.tracker.count('single:r1')}`);
  e.tracker.mark('single:r1');
  check('下一轮从 1 重新数', e.tracker.count('single:r1') === 1 && !e.tracker.isAwaiting('single:r1'));
}

section('G. 清全量也清计数（阈值>1 时可能存在无等待条目的键）');
{
  const e = makeEnv({ threshold: 3 });
  e.tracker.mark('single:r1');   // 计数 1，无等待条目
  e.tracker.mark('single:r2');
  check('有两个键在计数', e.counts.size === 2, `实际 ${e.counts.size}`);
  e.tracker.clearAll('settings-off');
  check('计数表已清空', e.counts.size === 0, `实际 ${e.counts.size}`);
}

section('H. 独立开关关闭时不进入等待（v2.3.93 BUG-E 回归）');
{
  const e = makeEnv({ threshold: 1 });
  e.gateOpen = false;
  e.tracker.mark('single:r1');
  check('开关关闭不进入等待', !e.tracker.isAwaiting('single:r1'));
  check('开关关闭不广播 awaiting=true', !e.broadcasts.some((b) => b.awaiting === true));
  check('开关关闭 isAwaiting 恒 false', e.tracker.isAwaiting('single:r1') === false);
}

section('I. 阈值调成「无限」时要解开已有等待（否则卡在等待态）');
{
  const e = makeEnv({ threshold: 1 });
  e.tracker.mark('single:r1');
  check('先进入等待', e.tracker.isAwaiting('single:r1'));
  e.setThreshold(AWAITING_NEVER);
  e.tracker.mark('single:r1');
  check('调成无限后被解开', !e.tracker.isAwaiting('single:r1'), '应解开，否则永久卡住');
}

section('J. 非法阈值输入的兜底');
{
  const e = makeEnv({ threshold: NaN });
  e.tracker.mark('single:r1');
  check('NaN 阈值按 1 处理（进入等待，不崩）', e.tracker.isAwaiting('single:r1'));

  const e2 = makeEnv({ threshold: -5 });
  e2.tracker.mark('single:r1');
  check('负数阈值 = 不启用等待', !e2.tracker.isAwaiting('single:r1'));

  const e3 = makeEnv({ threshold: 2.7 });
  e3.tracker.mark('single:r1');
  e3.tracker.mark('single:r1');
  check('小数阈值向下取整为 2（第2条就等）', e3.tracker.isAwaiting('single:r1'), `count=${e3.tracker.count('single:r1')}`);
}

section('K. 无 counts 容器时（旧调用方式）不崩，退化为阈值1');
{
  const awaiting = new Set(); const frozen = new Map(); const idleState = new Map();
  const broadcasts = [];
  const tracker = createAwaitingReplyTracker({
    maps: { awaiting, frozen, idleState },  // 故意不给 counts
    broadcast: (ch, p) => broadcasts.push({ ch, ...p }),
    getTriggerThreshold: () => 3,
  });
  let threw = null;
  try { tracker.mark('single:r1'); } catch (e) { threw = e; }
  check('不抛异常', threw === null, threw ? String(threw) : '');
  check('退化为立即等待（阈值>1 但无容器时至少不卡住）', tracker.isAwaiting('single:r1'));
}

console.log('\n' + '='.repeat(52));
console.log('断言：' + pass + ' 通过 / ' + fail + ' 失败');
if (failures.length) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  - ' + f)); }
fs.unlinkSync(tmp);
process.exit(fail === 0 ? 0 : 1);