/**
 * v2.3.93 主动消息「等你回复」提示 + 「我不回复」按钮 —— 真实机制实测
 * ============================================================================
 * 做法（项目无 jest，沿用 scripts/verify-proactive-wait.mjs 的 esbuild 思路）：
 *   1. esbuild 把**真实的** electron/awaitingReply.ts 打成 CJS（零外部依赖，纯状态机）；
 *   2. 直接驱动**真实导出函数** createAwaitingReplyTracker，容器（Set/Map）与 broadcast
 *      都由本脚本注入并记录 —— 断言全部基于真实状态转移结果，无生产代码测试钩子。
 *
 * 关键点：main.ts 的「用户回复」与「我不回复」两条路径都调 tracker.clear()（同一入口），
 *   所以这里对 tracker.clear(key,'user-reply') 与 tracker.clear(key,'skip') 做逐项对比，
 *   证明两条路径的清理效果**完全一致**（等待集合 / 冻结表 / idleState 基准 / 广播）。
 *
 * 为了验证「跳过后按已回复过的状态继续计时（不立即补发）」这条用户最在意的行为，
 * legacy 调度循环按 electron/main.ts 的真实算法等价移植为 legacyTick()（与
 * verify-proactive-wait.mjs 的 E 组同款做法），并把 tracker 的真实状态容器喂给它。
 *
 * 断言：
 *   A. mark → isAwaiting=true；clear('skip') → false
 *   B. skip 后计时基准已重置为当下 → legacy tick 当轮不补发、重新计满一个间隔才发
 *   C. skip vs user-reply：两份状态容器 + 广播序列逐项一致（reason 字段除外）
 *   D. 开关 idleCooldownUntilReply=false → isAwaiting 恒 false（不存在等待态，UI 不显示）
 *   E. 冻结基准在解除时被丢弃（否则下次冷却 elapsed 起点错乱）
 *   F. 边界：空 chatKey / 重复 skip / 未初始化 idleState / chat-deleted 删基准
 *   G. 广播：mark 广播 awaiting=true；clear 广播 awaiting=false + idle:activity（多窗口同步）
 *
 * 用法：export PATH=.../node/22.22.2-5:$PATH && node scripts/verify-proactive-skip.mjs
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = resolve(import.meta.dirname, '..');
const workDir = mkdtempSync(join(tmpdir(), 'awaiting-reply-verify-'));
const req = createRequire(join(workDir, 'harness.cjs'));

// ---------------------------------------------------------------- 1) 打包真实模块
const bundle = await build({
  entryPoints: [join(ROOT, 'electron/awaitingReply.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2020',
  write: false,
  logLevel: 'silent',
});
const outFile = join(workDir, 'awaitingReply.cjs');
writeFileSync(outFile, bundle.outputFiles[0].text, 'utf-8');

/** 加载一份全新的真实模块实例（模块内无状态，状态全在注入的容器里） */
function loadTrackerModule() {
  delete req.cache[outFile];
  return req(outFile);
}

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${extra ? '   [' + extra + ']' : ''}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL  ${label}${extra ? '   [' + extra + ']' : ''}`);
  }
}
function section(t) {
  console.log(`\n=== ${t} ===`);
}
const MIN = 60_000;

/**
 * 造一套完整环境：真实 tracker + 真实状态容器 + 广播记录 + 可注入时钟。
 * @param gateOpen 「等你回复」开关是否开启
 */
function makeEnv({ gateOpen = true, now = 1_000_000 } = {}) {
  const M = loadTrackerModule();
  const awaiting = new Set();
  const frozen = new Map();
  const idleState = new Map();
  const broadcasts = [];
  let clock = now;
  // 开关必须是**可变状态**并由 isGateOpen 闭包读取——mark()/isAwaiting() 每次调用
  // 都会重新读它。用普通参数捕获会测不到「开关中途变化」这个真实场景。
  const gate = { open: gateOpen };
  const tracker = M.createAwaitingReplyTracker({
    maps: { awaiting, frozen, idleState },
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    now: () => clock,
    isGateOpen: () => gate.open,
  });
  return {
    M,
    tracker,
    awaiting,
    frozen,
    idleState,
    gate,
    /** 动态开关「等你回复」功能（tracker 通过 isGateOpen 闭包读 gate.open） */
    setGate: (v) => {
      gate.open = v;
    },
    broadcasts,
    /** 推进注入时钟 */
    advance: (ms) => {
      clock += ms;
      return clock;
    },
    /** 「ms 毫秒之前」的时间戳（不移动时钟，只取过去某刻 —— 用来伪造已静默时长） */
    elapsedAgo: (ms) => clock - ms,
    /** 某频道的广播记录 */
    on: (channel) => broadcasts.filter((b) => b.channel === channel),
  };
}

/** electron/main.ts legacy 3s 调度循环的等价移植（冷却处理段逐行一致） */
function makeLegacy(env) {
  const idleFrozenElapsedMs = new Map();
  const sends = [];
  function tick(settings, nowMs) {
    let bestKey = null;
    let bestOverdue = -1;
    for (const [k, tsRaw] of env.idleState) {
      let ts = tsRaw;
      if ((settings.chatIdleEnabled || {})[k] === false) continue;
      if (settings.idleCooldownUntilReply !== false && env.awaiting.has(k)) {
        if (!env.frozen.has(k)) {
          const base = idleFrozenElapsedMs.get(k);
          env.frozen.set(k, base != null ? base : Math.max(0, nowMs - ts));
        }
        continue;
      }
      if (env.frozen.has(k)) {
        env.frozen.delete(k);
        ts = nowMs;
        env.idleState.set(k, nowMs);
      }
      const frozen = idleFrozenElapsedMs.get(k);
      const elapsed = frozen != null ? frozen : nowMs - ts;
      const intervalMs = (settings.idleInterval || 600) * 1000;
      const overdue = elapsed - intervalMs;
      if (overdue <= 0) continue;
      if (overdue > bestOverdue) {
        bestOverdue = overdue;
        bestKey = k;
      }
    }
    if (!bestKey) return { sent: null, bestOverdue };
    sends.push(bestKey);
    env.idleState.set(bestKey, nowMs);
    return { sent: bestKey, bestOverdue };
  }
  return { tick, sends };
}

const S = { idleCooldownUntilReply: true, idleInterval: 600, chatIdleEnabled: {} };

// ================================================================= A：mark / isAwaiting
section('A  等待态的记入与解除（真实 tracker）');
{
  const env = makeEnv();
  const KEY = 'single:a1';
  ok(env.tracker.isAwaiting(KEY) === false, 'A1 初始不在等待态');
  env.idleState.set(KEY, env.elapsedAgo(11 * MIN)); // 已静默 11 分钟（>10 分钟间隔）
  env.tracker.mark(KEY);
  ok(env.tracker.isAwaiting(KEY) === true, 'A2 mark 后 isAwaiting=true');
  ok(env.awaiting.has(KEY), 'A3 等待集合已写入（调度门禁真源）');
  ok(env.on('proactive:awaiting').length === 1 && env.on('proactive:awaiting')[0].payload.awaiting === true,
    'A4 mark 广播 proactive:awaiting(awaiting=true)');
}

// ================================================================= B：skip 后按「已回复」重新计时
section('B  「我不回复」= 按已回复过的状态继续计时（不立即补发）');
{
  const env = makeEnv();
  const KEY = 'single:b1';
  const L = makeLegacy(env);

  // 模拟一轮完整生命周期：进入 → 静默超时 → 发出主动消息（mark + 基准重置）→ 冷却
  env.idleState.set(KEY, 1_000_000 - 11 * MIN);
  env.tracker.mark(KEY);
  const sentAt = env.advance(0);
  env.idleState.set(KEY, sentAt); // main.ts 发送后把基准重置为 now
  L.tick(S, env.advance(3000)); // 首个 tick 命中冷却 → 冻结基准
  ok(env.frozen.has(KEY), 'B1 冷却期间记录了冻结基准（真暂停）');
  const frozenVal = env.frozen.get(KEY);
  L.tick(S, env.advance(20 * MIN));
  ok(env.frozen.get(KEY) === frozenVal, 'B2 冷却期间冻结值不增长（1 小时也不涨）', `frozen=${frozenVal}ms`);

  // ---- 用户点「我不回复」 ----
  const skipAt = env.advance(0);
  const r = env.tracker.clear(KEY, 'skip');
  ok(r.wasAwaiting === true, 'B3 skip 前确实处于等待态（wasAwaiting=true）');
  ok(env.tracker.isAwaiting(KEY) === false, 'B4 skip 后 isAwaiting=false（提示消失）');
  ok(env.awaiting.size === 0, 'B5 等待集合已清空（下一条主动消息不再被门禁拦住）');
  ok(env.idleState.get(KEY) === skipAt, 'B6 计时基准已重置为「当下」（skip 时刻）',
    `基准偏移=${Math.round(((env.idleState.get(KEY) ?? 0) - skipAt) / 1000)}s`);

  // 关键：不立即补发，重新计满一个间隔才发
  const r1 = L.tick(S, env.advance(0));
  ok(r1.sent === null, 'B7 skip 当轮不立即补发（elapsed 从零重新计时）');
  const r2 = L.tick(S, env.advance(9 * MIN));
  ok(r2.sent === null, 'B8 重新计时 9 分钟仍不发');
  const r3 = L.tick(S, env.advance(1 * MIN + 1000));
  ok(r3.sent === KEY, 'B9 重新计满一个间隔（10 分钟）后才发送', `实际≈${Math.round((9 * MIN + MIN + 1000) / MIN)}min`);
}

// ================================================================= C：两条路径清理效果一致
section('C  skip 与「用户发消息」清理效果逐项一致（同一入口）');
{
  const KEYS = ['single:c1', 'group:c2', 'single:c3'];
  const run = (reason) => {
    const env = makeEnv();
    for (const k of KEYS) {
      env.idleState.set(k, env.elapsedAgo(7 * MIN));
      env.tracker.mark(k);
      // 走一轮调度让冻结基准落地（模拟真实等待过程）
      makeLegacy(env).tick(S, env.advance(3000));
    }
    env.advance(30 * MIN);
    const before = {
      awaiting: env.awaiting.size,
      frozen: env.frozen.size,
      idleState: env.idleState.size,
    };
    for (const k of KEYS) env.tracker.clear(k, reason);
    return {
      before,
      after: {
        awaiting: [...env.awaiting],
        frozen: [...env.frozen],
        idleEntries: [...env.idleState.keys()].length,
        // 基准是否都等于「解除时刻」（用最后推进的时钟值近似：解除在同一个 now 上批量进行）
        allBasesAreNow: KEYS.every((k) => env.idleState.get(k) === env.advance(0)),
      },
      channels: env.broadcasts.map((b) => b.channel).sort(),
      awaitingBroadcasts: env.broadcasts
        .filter((b) => b.channel === 'proactive:awaiting' && b.payload.awaiting === false)
        .map((b) => b.payload.chatKey)
        .sort(),
      idleBroadcastCount: env.on('idle:activity').length,
      reasons: env.broadcasts
        .filter((b) => b.channel === 'proactive:awaiting' && b.payload.awaiting === false)
        .map((b) => b.payload.reason),
    };
  };

  const viaUser = run('user-reply');
  const viaSkip = run('skip');

  ok(viaUser.before.awaiting === 3 && viaUser.before.frozen === 3,
    'C1 前置状态：3 个聊天都在等待且都已冻结', `awaiting=${viaUser.before.awaiting} frozen=${viaUser.before.frozen}`);
  ok(JSON.stringify(viaUser.after) === JSON.stringify(viaSkip.after),
    'C2 两条路径的最终状态逐字节一致（等待集合/冻结表/idleState 基准）',
    `after=${JSON.stringify(viaUser.after)}`);
  ok(JSON.stringify(viaUser.channels) === JSON.stringify(viaSkip.channels),
    'C3 两条路径广播的频道集合一致', `[${viaUser.channels.join(',')}]`);
  ok(JSON.stringify(viaUser.awaitingBroadcasts) === JSON.stringify(viaSkip.awaitingBroadcasts)
    && viaUser.awaitingBroadcasts.length === 3,
    'C4 两条路径都对每个聊天广播了 awaiting=false（多窗口同步）',
    `chatKeys=[${viaUser.awaitingBroadcasts.join(',')}]`);
  ok(viaUser.idleBroadcastCount === 3 && viaSkip.idleBroadcastCount === 3,
    'C5 两条路径都广播了 idle:activity（前端倒计时立即刷新）',
    `user=${viaUser.idleBroadcastCount} skip=${viaSkip.idleBroadcastCount}`);
  ok(viaUser.reasons.every((r) => r === 'user-reply') && viaSkip.reasons.every((r) => r === 'skip'),
    'C6 唯一差异是广播里的 reason 标记（便于前端区分来源，不影响行为）',
    `user=${viaUser.reasons[0]} skip=${viaSkip.reasons[0]}`);
}

// ================================================================= D：开关关闭 → 不存在等待态
section('D  开关 idleCooldownUntilReply=false → 不存在等待态（UI 不显示提示）');
{
  const env = makeEnv({ gateOpen: false });
  const KEY = 'single:d1';
  env.idleState.set(KEY, env.elapsedAgo(30 * MIN));

  // v2.3.93 QA 复核 BUG-E 回归：开关关闭时 mark() 必须直接返回——
  // 既不写集合、也不广播 awaiting:true。原实现漏判 isGateOpen()，
  // 导致 UI（走广播路径）提示永久残留：调度侧被 isAwaiting 挡住不发消息，
  // 但界面却一直显示「正在等你回复」，而 clearAll 在开关关闭时不会再广播清除。
  env.tracker.mark(KEY);
  ok(env.awaiting.has(KEY) === false, 'D1 开关关闭时 mark() 不写入等待集合（不再残留历史状态）');
  ok(env.on('proactive:awaiting').filter((b) => b.payload.awaiting === true).length === 0,
    'D2 开关关闭时 mark() 不广播 awaiting=true（UI 不会误显示提示）');
  ok(env.tracker.isAwaiting(KEY) === false, 'D3 开关关闭时 isAwaiting=false → 前端不显示「等你回复」');

  // 门禁不命中 → 调度不被拦住（与 proactive.ts isGatedByAwaitingReply 语义一致）
  const L = makeLegacy(env);
  const r = L.tick({ ...S, idleCooldownUntilReply: false }, env.advance(0));
  ok(r.sent === KEY, 'D4 开关关闭时调度不被等待态拦住（不门禁）');

  // 开关重新打开后才允许进入等待态（mark 的门禁是动态读取，不是永久拒绝）
  env.setGate(true);
  env.tracker.mark(KEY);
  ok(env.awaiting.has(KEY) === true, 'D5 开关重新打开后 mark() 恢复记入（门禁动态生效）');
  ok(env.tracker.isAwaiting(KEY) === true, 'D6 开关打开时 isAwaiting=true');
  env.setGate(false);

  // clearAll：开关被关掉时主进程清空等待态 + 广播，窗口立即隐藏提示
  env.broadcasts.length = 0;
  const keys = env.tracker.clearAll('settings-off');
  ok(keys.length === 1 && keys[0] === KEY, 'D7 clearAll 返回被清掉的 chatKey 列表');
  ok(env.awaiting.size === 0 && env.frozen.size === 0, 'D8 clearAll 清空等待集合与冻结表');
  ok(env.on('proactive:awaiting').filter((b) => b.payload.awaiting === false).length === 1,
    'D9 clearAll 逐个广播 awaiting=false（各窗口立即隐藏提示）');
}

// ================================================================= E：冻结基准必须被丢弃
section('E  冻结基准在解除时被丢弃（否则下次冷却 elapsed 起点错乱）');
{
  const env = makeEnv();
  const KEY = 'single:e1';
  env.idleState.set(KEY, env.elapsedAgo(20 * MIN));
  env.tracker.mark(KEY);
  makeLegacy(env).tick(S, env.advance(3000)); // 冻结
  ok(env.frozen.has(KEY), 'E1 解除前存在冻结基准');
  const r = env.tracker.clear(KEY, 'skip');
  ok(r.frozenCleared === true, 'E2 clear 报告清掉了冻结基准');
  ok(env.frozen.has(KEY) === false, 'E3 冻结表已无该键');
}

// ================================================================= F：边界
section('F  边界：空 chatKey / 重复 skip / 未初始化 idleState / 删聊天');
{
  const env = makeEnv();
  const r0 = env.tracker.clear('', 'skip');
  ok(r0.wasAwaiting === false && r0.baseReset === false, 'F1 空 chatKey 安全返回（无异常、无广播）');
  ok(env.broadcasts.length === 0, 'F2 空 chatKey 不产生广播');

  // 重复点「我不回复」：第二次无实际变化，不应误报
  const KEY = 'single:f1';
  env.idleState.set(KEY, env.advance(0));
  env.tracker.mark(KEY);
  const first = env.tracker.clear(KEY, 'skip');
  const second = env.tracker.clear(KEY, 'skip');
  ok(first.wasAwaiting === true, 'F3 第一次 skip 报告确实解除了等待');
  ok(second.wasAwaiting === false, 'F4 重复 skip 幂等（wasAwaiting=false，不会误报）');

  // idleState 里没有该聊天：不凭空造基准（否则幽灵计时）
  const KEY2 = 'single:f2';
  env.tracker.mark(KEY2);
  const r2 = env.tracker.clear(KEY2, 'skip');
  ok(r2.baseReset === false && r2.baseTs === null, 'F5 idleState 无该聊天时不创建基准（无幽灵计时）');
  ok(env.idleState.has(KEY2) === false, 'F6 idleState 仍无该键');

  // 删聊天：连基准一起删
  const KEY3 = 'single:f3';
  env.idleState.set(KEY3, env.elapsedAgo(5 * MIN));
  env.tracker.mark(KEY3);
  env.tracker.clear(KEY3, 'chat-deleted', { dropTimerState: true });
  ok(env.awaiting.has(KEY3) === false && env.idleState.has(KEY3) === false,
    'F7 chat-deleted 同时清等待态与计时基准（删聊天不残留等待）');
}

// ================================================================= G：广播载荷
section('G  广播载荷正确（前端据此刷新提示与倒计时）');
{
  const env = makeEnv();
  const KEY = 'single:g1';
  env.idleState.set(KEY, env.advance(0));
  env.tracker.mark(KEY);
  const skipAt = env.advance(1234);
  env.tracker.clear(KEY, 'skip');
  const ev = env.on('proactive:awaiting');
  ok(ev.length === 2, 'G1 mark + clear 各广播一次 proactive:awaiting', `count=${ev.length}`);
  ok(ev[1].payload.chatKey === KEY && ev[1].payload.awaiting === false && ev[1].payload.reason === 'skip',
    'G2 clear 广播含 chatKey / awaiting=false / reason=skip', JSON.stringify(ev[1].payload));
  const ia = env.on('idle:activity');
  ok(ia.length === 1 && ia[0].payload.chatKey === KEY && ia[0].payload.timestamp === skipAt,
    'G3 clear 同步广播 idle:activity（倒计时基准=当下）', `ts 偏移=${(ia[0]?.payload?.timestamp ?? 0) - skipAt}ms`);
  ok(env.on('proactive:awaiting')[0].payload.reason === 'sent', 'G4 mark 广播 reason=sent');
}

// ---------------------------------------------------------------- 收尾
try {
  rmSync(workDir, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}
console.log(`\n${'='.repeat(70)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 条断言）`);
console.log('='.repeat(70));
process.exit(fail === 0 ? 0 : 1);
