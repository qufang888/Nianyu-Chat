// NHPP 主动消息引擎（v2.3.17 新增独立模块）
// 三层架构：L1 非齐次泊松过程强度函数（48 个半小时桶 + 疲劳惩罚）→ Lewis-Shedler thinning 采样
//          L2 Gamma-Poisson 贝叶斯在线更新（后验均值 α/β 整体缩放强度）
//          L3 判断层（勿扰/定向回访/新鲜度/每日硬上限，规则优先、LLM 只负责内容生成）
// 隔离约束：数据存独立文件 proactive-nhpp.json（新表），不改现有 store.json/聊天链路；
//          发送复用现有 handleProactive（from_proactive 消息），经由 deps 注入避免循环依赖。
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { AppSettings, ChatMessage } from '../src/types';

// ===== 数据结构（新表）=====
export interface ProactivePrior {
  alpha: number; // Gamma 正反馈累计（每次用户回应 +1）
  beta: number; // Gamma 负反馈累计（忽略 +0.5 / 负面 +2）
  updatedAt: string;
}
export interface ProactiveCandidate {
  chatKey: string;
  candidateTime: number; // 候选触发时间戳（ms）
  status: 'pending' | 'sent' | 'skipped' | 'superseded';
  reason?: string;
}
export interface PendingCallback {
  chatKey: string;
  triggerTime: number;
  contextSummary: string; // 待回访事项摘要（如「用户说一小时后开会，结束后询问情况」）
  sourceMessageId?: number;
  status: 'pending' | 'sent' | 'cancelled';
}
export interface ProactiveFeedback {
  chatKey: string;
  sentAt: number;
  messageId: number;
  reaction: 'quick_reply' | 'ignored' | 'negative' | 'none';
  reactedAt?: number;
}
interface ProactiveStore {
  priors: Record<string, ProactivePrior>;
  candidates: Record<string, ProactiveCandidate>; // chatKey → 当前候选（每聊天仅保留最新 pending）
  pendingCallbacks: Record<string, PendingCallback[]>;
  feedback: ProactiveFeedback[]; // 滚动保留最近 FEEDBACK_KEEP 条
  dailyCount: Record<string, number>; // `${chatKey}|${YYYY-MM-DD}` → 当日已发条数
  replyGapEma: Record<string, number>; // v2.3.92：chatKey → 用户回复延迟的指数滑动平均（ms），参与频率自适应
}

// ===== 硬编码常量（同步登记 硬编码清单.md）=====
const ALPHA0 = 2; // Gamma 先验 α0
const BETA0 = 2; // Gamma 先验 β0（先验均值 α/β = 1，不缩放）
const BASELINE_HIGH = 0.35; // 8:00-24:00 基线强度（条/小时）
const BASELINE_NIGHT = 0.03; // 0:00-8:00 基线强度（条/小时）
const FATIGUE_DECAY = 0.35; // 疲劳惩罚：exp(-0.35 × 近6h已发条数)
const FATIGUE_WINDOW_MS = 6 * 3600_000; // 疲劳统计窗口 6 小时
const SAMPLE_WINDOW_MS = 4 * 3600_000; // thinning 采样前向窗口 4 小时
const FEEDBACK_QUICK_MS = 30 * 60_000; // 发出后 30 分钟内有用户消息 = 正反馈
const FB_ALPHA_STEP = 1; // 正反馈 α += 1
const FB_BETA_IGNORED = 0.5; // 忽略 β += 0.5
const FB_BETA_NEGATIVE = 2; // 负面 β += 2
const FEEDBACK_KEEP = 500; // feedback 滚动保留条数
const NEGATIVE_PAT = /(别\s*(老|再?|总)\s*(找|发|烦)|不要\s*(再)?\s*(发|找)|好烦|闭嘴|别吵|停止.{0,4}(消息|主动))/;
const CALLBACK_PAT = /(开会|考试|上课|吃饭|下班|睡觉|起床|洗澡|出门|回来|到家|到家了|到达|面试| driving|开车|通勤)/;
const CALLBACK_MAX_MIN = 8 * 60; // 承诺回访最大时长 8 小时（超出视为无效抽取）
const CALLBACK_RETRY_MS = 15 * 60_000; // v2.3.92：定向回访发送失败后的重排等待（避免每 60s 心跳热循环重试）
const STORE_FILE = 'proactive-nhpp.json';
// ===== v2.3.92：回复间隔 EMA（频率自适应）=====
const REPLY_GAP_EMA_ALPHA = 0.3; // EMA 平滑系数：gapEma ← gapEma + 0.3×(本次间隔 − gapEma)
const REPLY_GAP_REF_MS = 10 * 60_000; // 参考间隔 10 分钟：等于该值 → 缩放 1.0（不扩缩）
const REPLY_GAP_MAX_MS = 6 * 3600_000; // 间隔上限 6 小时（超过视作「几乎不回」，缩放钳到下限）
const REPLY_GAP_SCALE_MIN = 0.5; // 缩放下限：回复极慢/从不回 → 强度 ×0.5
const REPLY_GAP_SCALE_MAX = 1.5; // 缩放上限：回复很快（秒回）→ 强度 ×1.5

// ===== 存储（独立文件，新表）=====
let store: ProactiveStore = { priors: {}, candidates: {}, pendingCallbacks: {}, feedback: [], dailyCount: {}, replyGapEma: {} };
let storePath = '';

function loadStore(): void {
  try {
    storePath = path.join(app.getPath('userData'), STORE_FILE);
    if (fs.existsSync(storePath)) {
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as Partial<ProactiveStore>;
      // 逐字段合并而非整对象覆盖：老版本存档没有 replyGapEma 字段时保留默认空表（v2.3.92）
      store = {
        priors: raw.priors || {},
        candidates: raw.candidates || {},
        pendingCallbacks: raw.pendingCallbacks || {},
        feedback: Array.isArray(raw.feedback) ? raw.feedback : [],
        dailyCount: raw.dailyCount || {},
        replyGapEma: raw.replyGapEma || {},
      };
    }
  } catch {
    /* 损坏则用默认空结构 */
  }
}
let saveTimer: NodeJS.Timeout | null = null;
function saveStore(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');
    } catch {
      /* ignore */
    }
  }, 500);
}

// ===== 依赖注入（避免与 main.ts 循环依赖）=====
export interface ProactiveDeps {
  getSettings(): AppSettings;
  sendProactive(chatType: string, chatId: string, extraInstruction?: string): Promise<{ ok: boolean; roleId?: string; error?: string }>;
  getMessages(chatType: string, chatId: string): ChatMessage[];
  isBusy(chatId: string): boolean; // 正在生成内容时让路
  // v2.3.92：是否处于「已发主动消息、等用户回复」状态（主进程内存 Set，跨窗口唯一真源）。
  // 命中时调度器**保持候选原样**并跳过本轮，绝不重采样、绝不推后 candidateTime。
  // 未注入时按「不在等待」处理（向后兼容：deps 缺省不改变原有行为）。
  isAwaitingReply?(chatKey: string): boolean;
  getDefaultModel(): import('../src/types').ModelConfig | undefined; // 已应用全局参数回退的默认模型
  logError(category: 'functional' | 'model' | 'other', message: string, detail?: string): void;
}
let deps: ProactiveDeps | null = null;
export function initProactiveEngine(d: ProactiveDeps): void {
  deps = d;
  loadStore();
}

// ===== L1：强度函数 =====
function baselineAt(t: Date): number {
  const h = t.getHours() + t.getMinutes() / 60;
  return h >= 8 && h < 24 ? BASELINE_HIGH : BASELINE_NIGHT;
}
function priorScale(chatKey: string): number {
  const p = store.priors[chatKey];
  const alpha = p?.alpha ?? ALPHA0;
  const beta = p?.beta ?? BETA0;
  return Math.max(0.05, alpha / Math.max(0.1, beta)); // 下限保护，避免后验塌缩到 0
}
function recentProactiveCount(chatKey: string, now: number): number {
  return store.feedback.filter(
    (f) => f.chatKey === chatKey && f.sentAt > now - FATIGUE_WINDOW_MS && f.reaction !== 'quick_reply'
  ).length;
}
// v2.3.92：回复间隔自适应缩放。
// 语义：用户回得越快 → 越愿意被联系 → 提频；回得越慢/从不回 → 降频。
// scale = clamp(0.5, 1.5, REF / emaGap)：emaGap 越小（秒回）比值越大 → 越接近 1.5 上限；
// emaGap 越大（几小时才回/不回）比值越小 → 越接近 0.5 下限。无 EMA 样本时返回 1（不扩缩）。
function replyGapScale(chatKey: string): number {
  const ema = store.replyGapEma[chatKey];
  if (typeof ema !== 'number' || !Number.isFinite(ema) || ema <= 0) return 1;
  const gap = Math.min(ema, REPLY_GAP_MAX_MS);
  const raw = REPLY_GAP_REF_MS / gap;
  return Math.max(REPLY_GAP_SCALE_MIN, Math.min(REPLY_GAP_SCALE_MAX, raw));
}
// 记录一次「用户回复延迟」样本并更新 EMA（指数滑动平均）。gapMs<=0 的脏样本忽略。
function pushReplyGapSample(chatKey: string, gapMs: number): void {
  if (!Number.isFinite(gapMs) || gapMs <= 0) return;
  const prev = store.replyGapEma[chatKey];
  store.replyGapEma[chatKey] =
    typeof prev === 'number' && Number.isFinite(prev) && prev > 0
      ? prev + REPLY_GAP_EMA_ALPHA * (gapMs - prev)
      : gapMs; // 首个样本直接作为初值
}
// λ(t) = baseline(时段) × 后验均值(个性化) × exp(-疲劳 × 近期已发数) × 回复间隔自适应
function intensity(chatKey: string, t: Date, now: number): number {
  const adaptive = (deps?.getSettings().proactiveAdaptiveEnabled ?? true) !== false;
  const gapScale = adaptive ? replyGapScale(chatKey) : 1;
  return baselineAt(t) * priorScale(chatKey) * Math.exp(-FATIGUE_DECAY * recentProactiveCount(chatKey, now)) * gapScale;
}

// Lewis-Shedler thinning：从 λ(t) 采样下一个候选时刻；找不到（强度极低）返回 null
function sampleCandidate(chatKey: string, now: number): number | null {
  const end = now + SAMPLE_WINDOW_MS;
  const hourMs = 3600_000;
  // λ_max：取窗口内最大基线（高时段）× 缩放 × 疲劳（疲劳随时间只会缓解，用当前值做上界是安全的）
  const lambdaMax = intensity(chatKey, new Date(now), now);
  const expected = (lambdaMax * SAMPLE_WINDOW_MS) / hourMs;
  const nCand = poissonSample(Math.max(0.05, expected));
  const accepted: number[] = [];
  for (let i = 0; i < nCand; i++) {
    const t = now + Math.random() * SAMPLE_WINDOW_MS;
    if (Math.random() < intensity(chatKey, new Date(t), now) / Math.max(1e-9, lambdaMax)) accepted.push(t);
  }
  if (accepted.length === 0) {
    // 窗口内无接受点：候选顺延到窗口末端（下轮心跳/交互再重算）
    return end;
  }
  accepted.sort((a, b) => a - b);
  return accepted[0] < end ? accepted[0] : end;
}
function poissonSample(lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.round(lambda + Math.sqrt(lambda) * gauss()); // 大 λ 正态近似
  let k = 0;
  let p = 1;
  const L = Math.exp(-lambda);
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}
function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ===== 重算候选（每次用户交互时调用，覆盖旧候选）=====
export function rescheduleProactive(chatType: string, chatId: string): void {
  try {
    if (!deps) return;
    const s = deps.getSettings();
    if (s.proactiveEngine !== 'nhpp') return; // 仅 NHPP 机制启用时调度
    const chatKey = `${chatType}:${chatId}`;
    const now = Date.now();
    const old = store.candidates[chatKey];
    if (old && old.status === 'pending') old.status = 'superseded'; // 交互覆盖旧候选
    const t = sampleCandidate(chatKey, now) ?? now + SAMPLE_WINDOW_MS;
    store.candidates[chatKey] = { chatKey, candidateTime: t, status: 'pending', reason: 'resampled' };
    saveStore();
  } catch {
    /* ignore */
  }
}

// ===== 勿扰窗口 =====
function inDnd(s: AppSettings, now: Date): { inWindow: boolean; endsAt: number | null } {
  const dnd = s.proactiveDnd;
  if (!dnd?.enabled || !dnd.start || !dnd.end) return { inWindow: false, endsAt: null };
  const [sh, sm] = String(dnd.start).split(':').map(Number);
  const [eh, em] = String(dnd.end).split(':').map(Number);
  if ([sh, sm, eh, em].some((x) => !Number.isFinite(x))) return { inWindow: false, endsAt: null };
  const cur = now.getHours() * 60 + now.getMinutes();
  const startM = sh * 60 + sm;
  const endM = eh * 60 + em;
  const inWindow = startM <= endM ? cur >= startM && cur < endM : cur >= startM || cur < endM; // 支持跨午夜
  if (!inWindow) return { inWindow: false, endsAt: null };
  const ends = new Date(now);
  ends.setHours(eh, em, 0, 0);
  if (ends.getTime() <= now.getTime()) ends.setDate(ends.getDate() + 1); // 窗口结束在明天
  return { inWindow: true, endsAt: ends.getTime() };
}

// ===== 待办回访（显式承诺抽取）=====
// 用户消息含未来承诺（开会/吃饭/下班…）时，用默认模型抽取 {has, minutes, summary}；
// 抽取节流：每聊天 5 分钟最多一次，避免每条消息都调 LLM。
const lastExtract = new Map<string, number>();
export function extractPendingCallback(chatType: string, chatId: string, userContent: string): void {
  try {
    if (!deps) return;
    const s = deps.getSettings();
    if (s.proactiveEngine !== 'nhpp') return;
    if (!userContent || userContent.length < 4) return;
    const chatKey = `${chatType}:${chatId}`;
    const now = Date.now();
    if ((lastExtract.get(chatKey) || 0) > now - 5 * 60_000) return;
    lastExtract.set(chatKey, now);
    const pending = (store.pendingCallbacks[chatKey] || []).filter((c) => c.status === 'pending');
    if (pending.length > 0) return; // 已有待回访，不重复抽取
    if (!CALLBACK_PAT.test(userContent)) return;
    // 动态 import 避免与 main.ts 模块加载期耦合
    void Promise.resolve().then(async () => {
      const { queryAI } = await import('./ai');
      const { enqueueAndWait } = await import('./queueManager');
      const cfg = deps!.getDefaultModel();
      if (!cfg) return;
      const prompt =
        '从下面的用户消息中判断是否包含明确的未来约定/承诺（如「一小时后开会」「六点下班」「明天考试」）。' +
        '若有，输出 JSON：{"has":true,"minutes":预计距离现在的分钟数,"summary":"待回访事项的简短描述（含角色关心的语境）"}；没有则输出 {"has":false}。只输出 JSON。\n用户消息：' +
        userContent.slice(0, 300);
      // v2.3.47：待办回访抽取也遵守模型 QPS 限速（与其他对话路径共享同一队列预算，可在主界面排队面板看到）
      await enqueueAndWait(cfg.id, cfg.qps, '待办回访抽取');
      const res = await queryAI(cfg, [{ role: 'user', content: prompt }], 200);
      const text = res.content || '';
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return;
      const parsed = JSON.parse(m[0]) as { has?: boolean; minutes?: number; summary?: string };
      if (!parsed.has || !parsed.minutes || !parsed.summary) return;
      const minutes = Math.max(5, Math.min(CALLBACK_MAX_MIN, parsed.minutes));
      const list = store.pendingCallbacks[chatKey] || [];
      list.push({
        chatKey,
        triggerTime: Date.now() + minutes * 60_000,
        contextSummary: parsed.summary,
        status: 'pending',
      });
      store.pendingCallbacks[chatKey] = list.slice(-3); // 每聊天最多保留 3 条历史
      saveStore();
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

// ===== L2：贝叶斯反馈评估 =====
/**
 * v2.3.92「等你回复才发下一条」门禁。
 * 命中（该聊天已发主动消息且用户尚未回复）时，调用方必须：
 *   - 保持候选 status='pending'、candidateTime 原样（不重采样、不推后）；
 *   - 直接 continue，让候选留在原地等用户回复；
 *   - 用户回复时 main.ts 调 rescheduleProactive 自然重采样并把旧候选标 superseded。
 * 依赖未注入 isAwaitingReply 时返回 false（向后兼容：等同旧行为）。
 */
function isGatedByAwaitingReply(chatKey: string): boolean {
  try {
    // 独立开关「等你回复才发下一条」：关闭时一律不门禁。
    // 必须在这里判开关——原先只有 legacy 的 3s 调度循环会读它并清等待态，
    // 而那个循环开头就 `if (proactiveEngine === 'nhpp') return`，
    // 导致 NHPP 下关掉开关后 proactiveAwaitingReply 永不清 → 该聊天永久不发主动消息。
    // `?? true` 保持老用户（无该字段）默认开启。
    if ((deps?.getSettings().idleCooldownUntilReply ?? true) === false) return false;
    return deps?.isAwaitingReply?.(chatKey) === true;
  } catch {
    return false;
  }
}
function evaluateFeedback(now: number): void {
  if (!deps) return;
  for (const f of store.feedback) {
    if (f.reaction !== 'none' || now - f.sentAt < FEEDBACK_QUICK_MS) continue;
    const [chatType, chatId] = f.chatKey.split(':');
    const msgs = deps.getMessages(chatType, chatId);
    const after = msgs.filter((m) => m.sender_type === 'user' && new Date(m.timestamp).getTime() > f.sentAt);
    if (after.length > 0) {
      const negative = after.some((m) => NEGATIVE_PAT.test(m.content || ''));
      f.reaction = negative ? 'negative' : 'quick_reply';
      f.reactedAt = new Date(after[0].timestamp).getTime();
      // v2.3.92：回复延迟样本（reactedAt 此前只记录不参与计算）→ EMA → 强度自适应缩放。
      // 语气维度仍由 NEGATIVE_PAT 判定，行为不变；这里只补「回得快/慢」这一维。
      pushReplyGapSample(f.chatKey, f.reactedAt - f.sentAt);
    } else {
      f.reaction = 'ignored';
      // 从不回：把间隔 EMA 往「很久」方向推一档（取窗口上限的一半作为等效慢速样本），
      // 使降频不只依赖 β 的负反馈，还有连续无回应的平滑信号。
      pushReplyGapSample(f.chatKey, Math.min(now - f.sentAt, REPLY_GAP_MAX_MS));
    }
    const p = store.priors[f.chatKey] || { alpha: ALPHA0, beta: BETA0, updatedAt: new Date().toISOString() };
    if (f.reaction === 'quick_reply') p.alpha += FB_ALPHA_STEP;
    else if (f.reaction === 'ignored') p.beta += FB_BETA_IGNORED;
    else p.beta += FB_BETA_NEGATIVE;
    p.updatedAt = new Date().toISOString();
    store.priors[f.chatKey] = p;
  }
  if (store.feedback.length > FEEDBACK_KEEP) store.feedback = store.feedback.slice(-FEEDBACK_KEEP);
}

// ===== 每日计数 =====
function todayKey(chatKey: string, now: Date): string {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `${chatKey}|${d}`;
}

// v2.3.92：定向回访发送失败/抛异常后的重排——把该回访从 'sent' 退回 'pending' 并推后 15 分钟，
// 保证不丢失也不热循环（due 为对象引用，原地更新即可，无需按 chatKey 回查列表）。
function retryCallback(due: PendingCallback): void {
  try {
    if (due.status !== 'sent') return;
    due.status = 'pending';
    due.triggerTime = Date.now() + CALLBACK_RETRY_MS;
    saveStore();
  } catch {
    /* ignore */
  }
}

// ===== 心跳（main.ts 每 60s 调用一次）=====
export function heartbeatProactive(): void {
  try {
    if (!deps) return;
    const s = deps.getSettings();
    if (s.proactiveEngine !== 'nhpp') return;
    // 全局主动消息总开关（经典 / NHPP 通用）——此前 NHPP 心跳漏检该开关（v2.3.28 修复）
    if (s.idleEnabled === false) return;
    const now = Date.now();
    evaluateFeedback(now);
    // 1) 到期的定向回访优先于泛化候选
    for (const [chatKey, list] of Object.entries(store.pendingCallbacks)) {
      const due = list.find((c) => c.status === 'pending' && c.triggerTime <= now);
      if (!due) continue;
      const sep = chatKey.indexOf(':');
      const chatType = chatKey.slice(0, sep);
      const chatId = chatKey.slice(sep + 1);
      if (deps.isBusy(chatId)) continue; // 正在生成，下一轮
      // 该聊天单独关闭了主动消息（经典 / NHPP 引擎通用，v2.3.28）
      if ((s.chatIdleEnabled || {})[chatKey] === false) continue;
      // v2.3.92 等回复门禁（放在 isBusy 之后、合并/发送之前）：
      // 命中即「保持候选等用户回复」——due 仍是 pending、不推后 triggerTime、不重采样。
      // 否则「等回复」会被定向回访绕过。
      if (isGatedByAwaitingReply(chatKey)) continue;
      // 同时段泛化候选合并：标记 superseded，避免连发两条
      const cand = store.candidates[chatKey];
      if (cand && cand.status === 'pending' && Math.abs(cand.candidateTime - due.triggerTime) < 30 * 60_000) {
        cand.status = 'superseded';
        cand.reason = 'merged_with_callback';
      }
      due.status = 'sent';
      saveStore();
      void deps
        .sendProactive(chatType, chatId, `（定向回访）之前用户提到过「${due.contextSummary}」，现在到了约定的时间点。请自然地向用户询问/跟进这件事的结果，语气贴合你与用户的关系。`)
        .then((r) => {
          if (r.ok) recordSent(chatKey, chatType, chatId);
          else retryCallback(due);
        })
        // v2.3.92：原先此分支只有 .then()、无 .catch()，sendProactive 抛异常时该回访永久丢失
        //（既不重排也不恢复 pending）。对齐泛化分支的失败重排写法。
        .catch(() => retryCallback(due));
      return; // 每轮心跳只处理一件发送事务
    }
    // 2) 到期的泛化候选 → 判断层
    for (const [chatKey, cand] of Object.entries(store.candidates)) {
      if (cand.status !== 'pending' || cand.candidateTime > now) continue;
      const sep = chatKey.indexOf(':');
      const chatType = chatKey.slice(0, sep);
      const chatId = chatKey.slice(sep + 1);
      if (!chatId) continue;
      const reschedule = (reason: string) => {
        cand.status = 'skipped';
        cand.reason = reason;
        const t = sampleCandidate(chatKey, Date.now()) ?? Date.now() + SAMPLE_WINDOW_MS;
        store.candidates[chatKey] = { chatKey, candidateTime: t, status: 'pending', reason: 'rescheduled' };
        saveStore();
      };
      if (deps.isBusy(chatId)) continue; // 正在生成，下一轮再看
      // 该聊天单独关闭了主动消息（经典 / NHPP 引擎通用，v2.3.28）——保留候选，待重新开启后继续评估
      if ((s.chatIdleEnabled || {})[chatKey] === false) continue;
      // v2.3.92 等回复门禁：在 isBusy 之后、DND 之前。
      // 命中时**必须**保持 cand.status='pending' 与 candidateTime 原样并 continue——
      // 绝不调 reschedule()、绝不推后 candidateTime（否则语义退化成「跳过/顺延」，
      // 用户回复后会立刻补发一条，正是需求要修的体感问题）。
      if (isGatedByAwaitingReply(chatKey)) continue;
      // 勿扰窗口：顺延到窗口结束后重采样
      const dnd = inDnd(s, new Date(now));
      if (dnd.inWindow) {
        cand.status = 'skipped';
        cand.reason = 'dnd';
        store.candidates[chatKey] = { chatKey, candidateTime: (dnd.endsAt ?? now + 3600_000) + 60_000, status: 'pending', reason: 'after_dnd' };
        saveStore();
        continue;
      }
      // 消息新鲜度：距上一条任意消息不足 N 分钟 → 顺延
      const fresh = s.proactiveFreshnessMin ?? 10;
      const msgs = deps.getMessages(chatType, chatId);
      const last = msgs[msgs.length - 1];
      if (last && now - new Date(last.timestamp).getTime() < fresh * 60_000) {
        reschedule('freshness');
        continue;
      }
      // 每日硬上限：到上限直接不发，仅记录（作为后台统计，不做贝叶斯负反馈）
      const limit = s.proactiveDailyLimit ?? 5;
      if ((store.dailyCount[todayKey(chatKey, new Date(now))] || 0) >= limit) {
        cand.status = 'skipped';
        cand.reason = 'daily_limit';
        saveStore();
        continue;
      }
      // 用户已主动告知结果：若有待回访且用户在其触发前已发过相关消息 → 取消回访（回访队列里 pending 的在上方已优先处理，此处无额外动作）
      // 通过全部检查 → 发送
      cand.status = 'sent';
      saveStore();
      void deps
        .sendProactive(chatType, chatId)
        .then((r) => {
          if (r.ok) recordSent(chatKey, chatType, chatId);
          else reschedule('send_failed');
        })
        .catch(() => reschedule('send_error'));
      return; // 每轮心跳最多发送一条
    }
    saveStore();
  } catch (e: any) {
    try {
      deps?.logError?.('model', `NHPP 心跳异常：${e?.message || String(e)}`);
    } catch {
      /* ignore */
    }
  }
}

// 发送成功后记录反馈条目 + 每日计数 + 立即重采样下一次候选
function recordSent(chatKey: string, chatType: string, chatId: string): void {
  const msgs = deps!.getMessages(chatType, chatId);
  const last = msgs[msgs.length - 1];
  store.feedback.push({
    chatKey,
    sentAt: Date.now(),
    messageId: last?.id ?? 0,
    reaction: 'none',
  });
  const tk = todayKey(chatKey, new Date());
  store.dailyCount[tk] = (store.dailyCount[tk] || 0) + 1;
  const t = sampleCandidate(chatKey, Date.now()) ?? Date.now() + SAMPLE_WINDOW_MS;
  store.candidates[chatKey] = { chatKey, candidateTime: t, status: 'pending', reason: 'next' };
  saveStore();
}

// v2.3.92：补「30 分钟盲区」的即时正反馈。
// 背景：evaluateFeedback 要求「发出后满 FEEDBACK_QUICK_MS(30min) 且 reaction 仍为 none」才判定，
// 因此用户在 30 分钟内秒回时，priors 与 replyGapEma 在整个等待期内都不更新、频率永远升不上去。
// 本函数由主进程在 addUserMessage（唯一用户消息落库入口）里即时调用，
// 对该聊天**最近一条尚未判定**的反馈记录立刻结算，使秒回也能马上提频。
export function markQuickReply(chatKey: string): void {
  try {
    if (!deps) return;
    const s = deps.getSettings();
    if (s.proactiveEngine !== 'nhpp') return;
    const now = Date.now();
    // 取该聊天最近一条尚未判定（reaction==='none'）的反馈
    let target: ProactiveFeedback | null = null;
    for (const f of store.feedback) {
      if (f.chatKey !== chatKey || f.reaction !== 'none') continue;
      if (!target || f.sentAt > target.sentAt) target = f;
    }
    if (!target) return;
    const gap = now - target.sentAt;
    // 一致性校验：必须是「刚发出 30 分钟内」且聊天里确有用户消息在其后。
    // 任一不满足都交给 evaluateFeedback 的常规判定，避免误结算（例如聊天数据被删改后卡死）。
    if (gap <= 0 || gap >= FEEDBACK_QUICK_MS) return;
    const sep = chatKey.indexOf(':');
    if (sep <= 0) return;
    const chatType = chatKey.slice(0, sep);
    const chatId = chatKey.slice(sep + 1);
    if (!chatId) return;
    const msgs = deps.getMessages(chatType, chatId);
    const after = msgs.filter((m) => m.sender_type === 'user' && new Date(m.timestamp).getTime() >= target!.sentAt);
    if (after.length === 0) return;
    const negative = after.some((m) => NEGATIVE_PAT.test(m.content || ''));
    target.reaction = negative ? 'negative' : 'quick_reply';
    target.reactedAt = new Date(after[0].timestamp).getTime();
    pushReplyGapSample(chatKey, target.reactedAt - target.sentAt);
    const p = store.priors[chatKey] || { alpha: ALPHA0, beta: BETA0, updatedAt: new Date().toISOString() };
    if (negative) p.beta += FB_BETA_NEGATIVE;
    else p.alpha += FB_ALPHA_STEP;
    p.updatedAt = new Date().toISOString();
    store.priors[chatKey] = p;
    saveStore();
  } catch {
    /* ignore */
  }
}

// v2.3.92：重启后从 feedback[] 派生「仍在等待回复」的 chatKey 列表。
// proactiveAwaitingReply 是纯内存 Set，重启即丢；若不恢复，重启后会给「用户还没回上一条」的聊天
// 立刻补发一条（正是本次要修的体感问题）。这里不新增持久化字段，从已有反馈记录派生：
//   取该 chatKey 最后一条反馈 → 若 getMessages 显示其 sentAt 之后无任何用户消息 → 视为仍在等待。
// 一致性校验（防止改了聊天数据后永久卡死）：
//   1) 聊天必须仍有消息（消息被清空/删除 → 不恢复，等价于新会话）；
//   2) 最后一条反馈须存在且 sentAt 早于最后一条用户消息的时间戳（若时间线异常 → 不恢复）；
//   3) 仅恢复「最后一条用户消息之前发出」的情况，且反馈记录本身不能是已被用户回应过的（reaction!=='none' 也恢复，
//      因为 evaluateFeedback 的判定基于同一份消息数据，重启后重算更准）。
export function deriveAwaitingReplyKeys(): string[] {
  const out: string[] = [];
  try {
    if (!deps) return out;
    const last = new Map<string, ProactiveFeedback>();
    for (const f of store.feedback) {
      const prev = last.get(f.chatKey);
      if (!prev || f.sentAt > prev.sentAt) last.set(f.chatKey, f);
    }
    const now = Date.now();
    for (const [chatKey, f] of last) {
      const sep = chatKey.indexOf(':');
      if (sep <= 0) continue;
      const chatType = chatKey.slice(0, sep);
      const chatId = chatKey.slice(sep + 1);
      if (!chatId) continue;
      let msgs: ChatMessage[];
      try {
        msgs = deps.getMessages(chatType, chatId);
      } catch {
        continue; // 聊天已删除 → 不恢复
      }
      if (!msgs || msgs.length === 0) continue; // 校验 1：无消息（数据被清）→ 不恢复
      const userTimes = msgs.filter((m) => m.sender_type === 'user').map((m) => new Date(m.timestamp).getTime());
      const lastUserAt = userTimes.length ? Math.max(...userTimes) : -Infinity;
      // sentAt 之后存在用户消息 → 用户已回复，不需要恢复
      if (lastUserAt > f.sentAt) continue;
      // 校验 2：反馈时间戳异常（晚于当前时间 / 早于所有消息）→ 不恢复
      if (f.sentAt > now + 60_000) continue;
      if (f.sentAt < 0) continue;
      // 校验 3：最后一条消息是用户消息且时间早于该反馈 → 时间线矛盾（消息被重排/删改）→ 不恢复
      const lastMsgAt = new Date(msgs[msgs.length - 1].timestamp).getTime();
      if (msgs[msgs.length - 1].sender_type === 'user' && lastMsgAt < f.sentAt) continue;
      out.push(chatKey);
    }
  } catch {
    /* ignore */
  }
  return out;
}

// 供日志使用
export const proactiveLog = (category: 'functional' | 'model' | 'other', message: string): void => {
  deps?.logError?.(category, message);
};
