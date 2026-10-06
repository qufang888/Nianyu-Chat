/**
 * v2.3.92 主动消息「等你回复才发下一条」+ 频率自适应 —— 真实机制实测
 * ============================================================================
 * 做法（项目无 jest，沿用 scripts/verify-anim-trimode.mjs 的 esbuild 思路）：
 *   1. esbuild 把**真实的** electron/proactive.ts 打成 CJS（electron/ai/queueManager 外部化）；
 *   2. require 钩子注入 electron stub（app.getPath → 临时目录）→ initProactiveEngine 里的
 *      loadStore() 真的去读我们seed 的 proactive-nhpp.json；
 *   3. 驱动**真实导出函数** heartbeatProactive / rescheduleProactive / markQuickReply /
 *      deriveAwaitingReplyKeys，断言全部基于真实 store 文件内容（无生产代码测试钩子）。
 *
 * legacy 部分：把 main.ts 真实调度循环的冻结/解冻算法逐行等价移植为 legacyTick()，
 *   逻辑与 electron/main.ts:6666-6700 一致，用于验证「真暂停 vs 原来只跳过」。
 *
 * 断言：
 *   A. NHPP 泛化候选：isAwaitingReply=true → 不发送 + 候选仍 pending + candidateTime 未变 + store 未被重采样
 *   B. NHPP 泛化候选：门禁解除 → 正常发出（并写入新反馈）
 *   C. NHPP 定向回访：被同一门禁拦住（不被回访绕过），回访仍 pending
 *   D. NHPP 定向回访：sendProactive 抛异常 → 回访被重排回 pending（v2.3.92 修的永久丢失 bug）
 *   E. legacy：冷却期间不发送 + elapsed 冻结（overdue 不堆积）；解冻后从零重新计时、不立即补发
 *   F. EMA：秒回（markQuickReply）→ replyGapEma 落库 + priors.alpha 上升 → 强度放大
 *   G. EMA：慢回 → 强度缩小，且钳制在 [0.5, 1.5]
 *   H. 重启一致性：deriveAwaitingReplyKeys 正确派生 / 已回复 / 聊天已清空时不派生（不卡死）
 *
 * 用法：export PATH=.../node/22.22.2-5:$PATH && node scripts/verify-proactive-wait.mjs
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const ROOT = resolve(import.meta.dirname, '..');
const workDir = mkdtempSync(join(tmpdir(), 'proactive-verify-'));
const STORE_PATH = join(workDir, 'proactive-nhpp.json');
const req = createRequire(join(workDir, 'harness.cjs'));

// ---------------------------------------------------------------- 1) 打包真实 proactive.ts
const bundle = await build({
  entryPoints: [join(ROOT, 'electron/proactive.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2020',
  write: false,
  logLevel: 'silent',
  external: ['electron', './ai', './queueManager', 'fs', 'path'],
});
const outFile = join(workDir, 'proactive.cjs');
writeFileSync(outFile, bundle.outputFiles[0].text, 'utf-8');

// ---------------------------------------------------------------- 2) require 钩子注入 stub
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return origResolve.call(this, request, ...rest);
};
const electronStub = { app: { getPath: () => workDir } };
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  if (request === './ai') return { queryAI: async () => ({ content: '{"has":false}' }) };
  if (request === './queueManager') return { enqueueAndWait: async () => {} };
  return origLoad.call(this, request, ...rest);
};

/** 加载一份全新的引擎模块实例（模块级 store 为空 → initProactiveEngine 会 loadStore 读 seed 文件） */
function loadEngine() {
  delete Module._cache[outFile];
  return req(outFile);
}
function seedStore(obj) {
  writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2), 'utf-8');
}
function readStore() {
  return JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
}
/** 等待 saveStore 的 500ms 防抖落盘 */
const settle = () => new Promise((r) => setTimeout(r, 700));

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
const HOUR = 3600_000;
const MIN = 60_000;

function baseSettings(over = {}) {
  return {
    proactiveEngine: 'nhpp',
    idleEnabled: true,
    idleCooldownUntilReply: true,
    proactiveDailyLimit: 5,
    proactiveFreshnessMin: 10,
    chatIdleEnabled: {},
    proactiveDnd: { enabled: false },
    ...over,
  };
}
function mkMsg(sender, ts, content = '在吗') {
  return { id: Math.floor(ts / 1000), sender_type: sender, content, timestamp: new Date(ts).toISOString() };
}

// ================================================================= A/B：NHPP 泛化候选门禁
section('A/B  NHPP 泛化候选：等回复门禁（不发送 / 不重采样 / 解除后正常发）');
{
  const KEY = 'single:r1';
  const now = Date.now();
  const dueTime = now - 1000; // 已到期的候选
  seedStore({
    priors: {},
    candidates: { [KEY]: { chatKey: KEY, candidateTime: dueTime, status: 'pending', reason: 'seed' } },
    pendingCallbacks: {},
    feedback: [],
    dailyCount: {},
    replyGapEma: {},
  });
  const sent = [];
  const awaiting = new Set([KEY]);
  let msgs = [mkMsg('user', now - 3 * HOUR, '在吗')]; // 足够旧，绕开新鲜度检查
  const M = loadEngine();
  M.initProactiveEngine({
    getSettings: () => baseSettings(),
    sendProactive: async (ct, ci) => {
      sent.push(`${ct}:${ci}`);
      msgs.push(mkMsg('ai', Date.now(), '在呀'));
      return { ok: true };
    },
    getMessages: () => msgs,
    isBusy: () => false,
    isAwaitingReply: (k) => awaiting.has(k),
    getDefaultModel: () => undefined,
    logError: () => {},
  });

  // --- A1/A2：门禁命中
  M.heartbeatProactive();
  await settle();
  const stA = readStore();
  ok(sent.length === 0, 'A1 门禁命中时不调用 sendProactive', `sendProactive 调用 ${sent.length} 次`);
  ok(stA.candidates[KEY].status === 'pending', 'A2 候选保持 pending', `status=${stA.candidates[KEY].status}`);
  ok(stA.candidates[KEY].candidateTime === dueTime, 'A3 candidateTime 未被推后（不重采样）', `t=${stA.candidates[KEY].candidateTime} 期望 ${dueTime}`);
  ok(stA.feedback.length === 0, 'A4 未写入反馈记录（确实没发）');

  // 再跑3 轮，确认不会因多轮累积而漂移
  for (let i = 0; i < 3; i++) M.heartbeatProactive();
  await settle();
  const stA2 = readStore();
  ok(stA2.candidates[KEY].candidateTime === dueTime && stA2.candidates[KEY].status === 'pending', 'A5 连续多轮心跳后候选仍原地不动');

  // --- B：门禁解除 → 正常发出
  awaiting.delete(KEY);
  M.heartbeatProactive();
  await settle();
  const stB = readStore();
  ok(sent.length === 1 && sent[0] === KEY, 'B1 解除门禁后正常发出', `sent=${JSON.stringify(sent)}`);
  ok(stB.feedback.length === 1 && stB.feedback[0].chatKey === KEY, 'B2 写入反馈记录（recordSent 生效）');
  ok(stB.candidates[KEY].status === 'pending' && stB.candidates[KEY].candidateTime > Date.now(), 'B3 发出后重采样下一次候选');
}

// ================================================================= C/D：定向回访分支
section('C/D  NHPP 定向回访：同一门禁生效 + 失败重排（不再永久丢失）');
{
  const KEY = 'single:r2';
  const now = Date.now();
  seedStore({
    priors: {},
    candidates: {},
    pendingCallbacks: {
      [KEY]: [{ chatKey: KEY, triggerTime: now - 1000, contextSummary: '开会', status: 'pending' }],
    },
    feedback: [],
    dailyCount: {},
    replyGapEma: {},
  });
  const awaiting = new Set([KEY]);
  const sent = [];
  let msgs = [mkMsg('user', now - 3 * HOUR, '我去开会')];
  const M = loadEngine();
  M.initProactiveEngine({
    getSettings: () => baseSettings(),
    sendProactive: async (ct, ci) => {
      sent.push(`${ct}:${ci}`);
      return { ok: true };
    },
    getMessages: () => msgs,
    isBusy: () => false,
    isAwaitingReply: (k) => awaiting.has(k),
    getDefaultModel: () => undefined,
    logError: () => {},
  });
  M.heartbeatProactive();
  await settle();
  const stC = readStore();
  ok(sent.length === 0, 'C1 门禁同样拦住定向回访（不被绕过）');
  ok(stC.pendingCallbacks[KEY][0].status === 'pending', 'C2 回访保持 pending（不标记 sent）');
  ok(stC.pendingCallbacks[KEY][0].triggerTime === now - 1000, 'C3 回访 triggerTime 未被推后');

  // 解除门禁 → 回访发出
  awaiting.delete(KEY);
  M.heartbeatProactive();
  await settle();
  ok(sent.length === 1, 'C4 解除门禁后回访正常发出');
}
{
  // D：sendProactive 抛异常（v2.3.92 之前无 .catch → 回访永久丢失）
  const KEY = 'single:r3';
  const now = Date.now();
  seedStore({
    priors: {},
    candidates: {},
    pendingCallbacks: {
      [KEY]: [{ chatKey: KEY, triggerTime: now - 1000, contextSummary: '吃饭', status: 'pending' }],
    },
    feedback: [],
    dailyCount: {},
    replyGapEma: {},
  });
  let msgs = [mkMsg('user', now - 3 * HOUR, '去吃饭了')];
  const M = loadEngine();
  M.initProactiveEngine({
    getSettings: () => baseSettings(),
    sendProactive: async () => {
      throw new Error('模型炸了');
    },
    getMessages: () => msgs,
    isBusy: () => false,
    isAwaitingReply: () => false,
    getDefaultModel: () => undefined,
    logError: () => {},
  });
  M.heartbeatProactive();
  await new Promise((r) => setTimeout(r, 100));
  await settle();
  const stD = readStore();
  const cb = stD.pendingCallbacks[KEY][0];
  ok(cb.status === 'pending', 'D1 抛异常后回访退回 pending（不再永久丢失）', `status=${cb.status}`);
  ok(cb.triggerTime > Date.now(), 'D2 抛异常后回访被推后 15 分钟重试', `triggerTime 偏移 ${Math.round((cb.triggerTime - now) / MIN)} 分钟`);
}

// ================================================================= E：legacy 真暂停
section('E  legacy 定时：真暂停（冻结 elapsed）vs 原来只跳过');
{
  // 等价移植 electron/main.ts:6664-6700 的循环（冷却处理段为 v2.3.92 新逻辑）
  function makeLegacy() {
    const idleState = new Map(); // chatKey -> lastActivityTs
    const idleCooldownFrozenMs = new Map(); // v2.3.92
    const idleFrozenElapsedMs = new Map();
    const proactiveAwaitingReply = new Set();
    const broadcasts = [];
    const sends = [];
    function tick(s, now) {
      let bestKey = null;
      let bestOverdue = -1;
      for (const [k, tsRaw] of idleState) {
        let ts = tsRaw;
        if ((s.chatIdleEnabled || {})[k] === false) continue;
        // v2.3.92 真暂停
        if (s.idleCooldownUntilReply !== false && proactiveAwaitingReply.has(k)) {
          if (!idleCooldownFrozenMs.has(k)) {
            const base = idleFrozenElapsedMs.get(k);
            idleCooldownFrozenMs.set(k, base != null ? base : Math.max(0, now - ts));
          }
          continue;
        }
        if (idleCooldownFrozenMs.has(k)) {
          idleCooldownFrozenMs.delete(k);
          ts = now;
          idleState.set(k, now);
          broadcasts.push({ chatKey: k, timestamp: now });
        }
        const frozen = idleFrozenElapsedMs.get(k);
        if (frozen == null && !s.__foreground(k) && s.idleSwitchAction !== 'continue') continue;
        const elapsed = frozen != null ? frozen : now - ts;
        const intervalMs = (s.idleInterval || 600) * 1000;
        const overdue = elapsed - intervalMs;
        if (overdue <= 0) continue;
        const score = overdue;
        if (score > bestOverdue) {
          bestOverdue = score;
          bestKey = k;
        }
      }
      if (!bestKey) return { sent: null, bestOverdue, bestKey };
      sends.push(bestKey);
      idleState.set(bestKey, now); // main.ts:6710 触发即重置基准
      return { sent: bestKey, bestOverdue, bestKey };
    }
    return { idleState, idleCooldownFrozenMs, proactiveAwaitingReply, tick, sends, broadcasts };
  }
  const S = baseSettings({ proactiveEngine: 'legacy', idleInterval: 600, idleSwitchAction: 'continue', __foreground: () => true });

  // E1：发出主动消息后进入冷却
  const L = makeLegacy();
  const KEY = 'single:legacy1';
  const t0 = Date.now();
  L.idleState.set(KEY, t0 - 11 * MIN); // 已静默 11 分钟 > 10 分钟间隔
  L.proactiveAwaitingReply.add(KEY); // handleProactive 成功后写入
  // 模拟发出后主进程把基准重置为 now（main.ts:6729 finally），随后 3s tick 首轮命中冷却
  L.idleState.set(KEY, t0);

  // 真实节奏：调度器每 3s 一跳，首轮在 t0+3s 冻结基准
  L.tick(S, t0 + 3000);
  const frozen = L.idleCooldownFrozenMs.get(KEY);
  const r1 = L.tick(S, t0 + 20 * MIN);
  ok(r1.sent === null, 'E1 冷却期间不发送主动消息');
  ok(frozen != null && frozen >= 0, 'E2 冷却期间记录了冻结基准（真暂停）', `frozenElapsed=${Math.round((frozen ?? -1) / 1000)}s`);
  ok(frozen != null && frozen <= 3000, 'E3 冻结值≈进入冷却瞬间的 elapsed（此后不再增长，overdue 不堆积）', `frozen=${frozen}ms（≤一个 tick 周期 3s）`);

  // E4：再等 1 小时，冻结值不得增长
  const t2 = t0 + 80 * MIN;
  L.tick(S, t2);
  ok(L.idleCooldownFrozenMs.get(KEY) === frozen, 'E4 1 小时后冻结值仍不增长（原来只跳过会堆积到 80 分钟）', `frozen=${L.idleCooldownFrozenMs.get(KEY)}ms`);

  // E5：用户回复 → 解除冷却 → 从新基准重新计时，不立即补发
  L.proactiveAwaitingReply.delete(KEY); // addUserMessage 里的 delete
  const r5 = L.tick(S, t2);
  ok(r5.sent === null, 'E5 解除冷却的当轮不立即补发（elapsed 从零重新计时）');
  ok(L.idleCooldownFrozenMs.has(KEY) === false, 'E6 冻结基准已丢弃');
  ok(L.idleState.get(KEY) === t2, 'E7 计时基准被推到现在', `基准偏移=${Math.round((t2 - L.idleState.get(KEY)) / 1000)}s`);
  // E8：重新计时满10 分钟才发
  const r8 = L.tick(S, t2 + 9 * MIN);
  ok(r8.sent === null, 'E8 重新计时 9 分钟仍不发');
  const r9 = L.tick(S, t2 + 10 * MIN + 1000);
  ok(r9.sent === KEY, 'E9 重新计时满一个间隔后才发送');
}

// ================================================================= F/G：回复间隔 EMA
section('F/G  回复间隔 EMA：秒回提频 / 慢回降频 /钳制边界');
{
  // F：秒回 → markQuickReply 立即结算（补 30 分钟盲区）
  const KEY = 'single:r4';
  const sentAt = Date.now() - 90_000; // 90 秒前发出
  seedStore({
    priors: {},
    candidates: {},
    pendingCallbacks: {},
    feedback: [{ chatKey: KEY, sentAt, messageId: 1, reaction: 'none' }],
    dailyCount: {},
    replyGapEma: {},
  });
  let msgs = [mkMsg('ai', sentAt, '在吗'), mkMsg('user', Date.now(), '在呀')];
  const M = loadEngine();
  M.initProactiveEngine({
    getSettings: () => baseSettings(),
    sendProactive: async () => ({ ok: true }),
    getMessages: () => msgs,
    isBusy: () => false,
    isAwaitingReply: () => false,
    getDefaultModel: () => undefined,
    logError: () => {},
  });
  M.markQuickReply(KEY);
  await settle();
  const stF = readStore();
  ok(stF.feedback[0].reaction === 'quick_reply', 'F1 30 分钟内的秒回被立即结算（补盲区）', `reaction=${stF.feedback[0].reaction}`);
  ok(stF.priors[KEY].alpha === 3, 'F2 priors.alpha 2→3（正反馈 +1）', `alpha=${stF.priors[KEY]?.alpha}`);
  const gap = stF.replyGapEma[KEY];
  ok(typeof gap === 'number' && gap > 0 && gap <= 90_000 * 1.05, 'F3 replyGapEma 落库且≈实际回复延迟', `ema=${Math.round(gap / 1000)}s`);

  // F4：30 分钟外的回复不由 markQuickReply 结算（交给 evaluateFeedback）
  const KEY2 = 'single:r5';
  const sentAt2 = Date.now() - 45 * MIN;
  seedStore({
    priors: {},
    candidates: {},
    pendingCallbacks: {},
    feedback: [{ chatKey: KEY2, sentAt: sentAt2, messageId: 1, reaction: 'none' }],
    dailyCount: {},
    replyGapEma: {},
  });
  const msgs2 = [mkMsg('ai', sentAt2, '在吗'), mkMsg('user', Date.now() - 1 * MIN, '在')];
  const M2 = loadEngine();
  M2.initProactiveEngine({
    getSettings: () => baseSettings(),
    sendProactive: async () => ({ ok: true }),
    getMessages: () => msgs2,
    isBusy: () => false,
    isAwaitingReply: () => false,
    getDefaultModel: () => undefined,
    logError: () => {},
  });
  M2.markQuickReply(KEY2);
  const stF2 = readStore();
  ok(stF2.feedback[0].reaction === 'none', 'F4 超出 30 分钟窗口不即时结算（交给 evaluateFeedback）', `reaction=${stF2.feedback[0].reaction}`);
}
{
  // G：强度缩放（通过 reschedule 后的候选分布间接验证 + 直接验 EMA 数值）
  // 直接验证方式：连续两次慢回样本后 EMA 显著大于参考值→ scale < 1；
  // 用 evaluateFeedback 走 ignored 分支（无用户消息）→ EMA 被推向大值。
  const KEY = 'single:r6';
  const now = Date.now();
  seedStore({
    priors: {},
    candidates: {},
    pendingCallbacks: {},
    feedback: [
      { chatKey: KEY, sentAt: now - 5 * HOUR, messageId: 1, reaction: 'none' },
      { chatKey: KEY, sentAt: now - 3 * HOUR, messageId: 2, reaction: 'none' },
    ],
    dailyCount: {},
    replyGapEma: {},
  });
  const msgs = [mkMsg('ai', now - 3 * HOUR, '在吗')]; // 之后无用户消息 → ignored
  const M = loadEngine();
  M.initProactiveEngine({
    getSettings: () => baseSettings(),
    sendProactive: async () => ({ ok: true }),
    getMessages: () => msgs,
    isBusy: () => false,
    isAwaitingReply: () => false,
    getDefaultModel: () => undefined,
    logError: () => {},
  });
  // 触发 evaluateFeedback：需要一个到期候选进入 heartbeat
  M.rescheduleProactive('single', 'r6');
  await settle();
  // 直接改候选为到期（写store 后重载，走evaluateFeedback 路径）
  const st = readStore();
  st.candidates[KEY].candidateTime = now - 1000;
  st.candidates[KEY].status = 'pending';
  seedStore(st);
  const M2 = loadEngine();
  M2.initProactiveEngine({
    getSettings: () => baseSettings({ proactiveFreshnessMin: 0 }),
    sendProactive: async () => ({ ok: true }),
    getMessages: () => msgs,
    isBusy: () => false,
    isAwaitingReply: () => false,
    getDefaultModel: () => undefined,
    logError: () => {},
  });
  M2.heartbeatProactive();
  await settle();
  const stG = readStore();
  const emaSlow = stG.replyGapEma[KEY];
  // 前两条是 seed 的历史反馈（无用户消息 → ignored）；第三条是本轮新发出待判定的
  const judged = stG.feedback.slice(0, 2).map((f) => f.reaction);
  ok(judged.length === 2 && judged.every((r) => r === 'ignored'), 'G1 无用户消息 → 判定为 ignored', JSON.stringify(judged));
  ok(stG.priors[KEY].beta > 2, 'G2 priors.beta 上升（负反馈）', `beta=${stG.priors[KEY]?.beta}`);
  ok(typeof emaSlow === 'number' && emaSlow > 10 * MIN, 'G3 从不回 → EMA 被推向大值（降频信号）', `ema=${Math.round((emaSlow ?? 0) / MIN)}分钟`);
  // 钳制范围：scale = clamp(0.5,1.5, REF/ema)；EMA ≥6h 时 scale=0.5
  const REF = 10 * MIN;
  const scale = Math.max(0.5, Math.min(1.5, REF / Math.min(emaSlow, 6 * HOUR)));
  ok(scale >= 0.5 && scale <= 1.5, 'G4 缩放钳制在 [0.5, 1.5]', `scale=${scale.toFixed(3)}`);
}

// ================================================================= H：重启一致性
section('H  重启一致性：deriveAwaitingReplyKeys（不新增持久化字段，从 feedback[] 派生）');
{
  const now = Date.now();
  // H1：发出后无用户消息 → 应派生为等待中
  seedStore({
    priors: {},
    candidates: {},
    pendingCallbacks: {},
    feedback: [{ chatKey: 'single:h1', sentAt: now - 30 * MIN, messageId: 1, reaction: 'none' }],
    dailyCount: {},
    replyGapEma: {},
  });
  const M1 = loadEngine();
  M1.initProactiveEngine({
    getSettings: () => baseSettings(),
    sendProactive: async () => ({ ok: true }),
    getMessages: (ct, ci) =>
      ci === 'h1'
        ? [mkMsg('user', now - 3 * HOUR, 'hi'), mkMsg('ai', now - 30 * MIN, '主动消息')]
        : [],
    isBusy: () => false,
    isAwaitingReply: () => false,
    getDefaultModel: () => undefined,
    logError: () => {},
  });
  const d1 = M1.deriveAwaitingReplyKeys();
  ok(d1.includes('single:h1'), 'H1 发出后无用户消息 → 恢复等待态', JSON.stringify(d1));

  // H2：用户已回复 → 不恢复（否则永久卡死）
  seedStore({
    priors: {},
    candidates: {},
    pendingCallbacks: {},
    feedback: [{ chatKey: 'single:h2', sentAt: now - 30 * MIN, messageId: 1, reaction: 'none' }],
    dailyCount: {},
    replyGapEma: {},
  });
  const M2 = loadEngine();
  M2.initProactiveEngine({
    getSettings: () => baseSettings(),
    sendProactive: async () => ({ ok: true }),
    getMessages: () => [mkMsg('ai', now - 30 * MIN, '主动消息'), mkMsg('user', now - 20 * MIN, '回了')],
    isBusy: () => false,
    isAwaitingReply: () => false,
    getDefaultModel: () => undefined,
    logError: () => {},
  });
  const d2 = M2.deriveAwaitingReplyKeys();
  ok(!d2.includes('single:h2'), 'H2 用户已回复 → 不恢复（避免永久不发）', JSON.stringify(d2));

  // H3：聊天消息被清空（数据被删改）→ 不恢复（一致性校验1）
  seedStore({
    priors: {},
    candidates: {},
    pendingCallbacks: {},
    feedback: [{ chatKey: 'single:h3', sentAt: now - 30 * MIN, messageId: 1, reaction: 'none' }],
    dailyCount: {},
    replyGapEma: {},
  });
  const M3 = loadEngine();
  M3.initProactiveEngine({
    getSettings: () => baseSettings(),
    sendProactive: async () => ({ ok: true }),
    getMessages: () => [],
    isBusy: () => false,
    isAwaitingReply: () => false,
    getDefaultModel: () => undefined,
    logError: () => {},
  });
  const d3 = M3.deriveAwaitingReplyKeys();
  ok(!d3.includes('single:h3'), 'H3 聊天消息为空 → 不恢复（一致性校验：改了数据不卡死）', JSON.stringify(d3));

  // H4：反馈时间戳异常（未来）→ 不恢复（一致性校验 2）
  seedStore({
    priors: {},
    candidates: {},
    pendingCallbacks: {},
    feedback: [{ chatKey: 'single:h4', sentAt: now + 10 * MIN, messageId: 1, reaction: 'none' }],
    dailyCount: {},
    replyGapEma: {},
  });
  const M4 = loadEngine();
  M4.initProactiveEngine({
    getSettings: () => baseSettings(),
    sendProactive: async () => ({ ok: true }),
    getMessages: () => [mkMsg('ai', now - 30 * MIN, 'x')],
    isBusy: () => false,
    isAwaitingReply: () => false,
    getDefaultModel: () => undefined,
    logError: () => {},
  });
  const d4 = M4.deriveAwaitingReplyKeys();
  ok(!d4.includes('single:h4'), 'H4 时间戳异常 → 不恢复（一致性校验）', JSON.stringify(d4));
}

// ================================================================= i18n 一致性
section('I  i18n 键集合一致性（10 处）');
{
  const fs = await import('node:fs');
  const tr = fs.readFileSync(join(ROOT, 'src/i18n/translations.ts'), 'utf-8');
  const zh = new Set([...tr.matchAll(/^\s*'(settings\.[^']+)':/gm)].map((m) => m[1]));
  // translations.ts 里 zh 与 en 同名键各出现一次，用出现次数判断
  const all = [...tr.matchAll(/'(settings\.[^']+)':/g)].map((m) => m[1]);
  const cnt = new Map();
  for (const k of all) cnt.set(k, (cnt.get(k) || 0) + 1);
  const zhCount = [...cnt.values()].filter((v) => v === 2).length;
  const NEW = ['settings.proactiveAdaptive', 'settings.proactiveAdaptiveDesc'];
  for (const k of NEW) ok(cnt.get(k) === 2, `I1 translations.ts 中「${k}」zh+en 各一处`, `出现 ${cnt.get(k) || 0} 次`);
  const locales = ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'];
  const keySets = locales.map((l) => {
    const o = JSON.parse(fs.readFileSync(join(ROOT, `src/i18n/locales/${l}.json`), 'utf-8'));
    return [l, o];
  });
  const base = Object.keys(keySets[0][1]).sort();
  for (const [l, o] of keySets) {
    ok(Object.keys(o).length === base.length, `I2 ${l}.json 键数与de 一致`, `${Object.keys(o).length} 键`);
    const missing = NEW.filter((k) => !(k in o));
    ok(missing.length === 0, `I3 ${l}.json 含新键`, missing.join(','));
    const empty = NEW.filter((k) => !o[k] || !String(o[k]).trim());
    ok(empty.length === 0, `I4 ${l}.json 新键非空`, empty.join(','));
    ok(String(o['settings.idleCooldown'] || '').trim() !== '' && String(o['settings.idleCooldownDesc'] || '').trim() !== '', `I5 ${l}.json idleCooldown/Desc 非空`);
  }
  console.log(`  ·translations.ts settings.* 键：zh/en 配对 ${zhCount} 个；locales 每份 ${base.length} 键`);
}

// ================================================================= 汇总
console.log(`\n${'='.repeat(60)}`);
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
rmSync(workDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);