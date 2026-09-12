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
const STORE_FILE = 'proactive-nhpp.json';

// ===== 存储（独立文件，新表）=====
let store: ProactiveStore = { priors: {}, candidates: {}, pendingCallbacks: {}, feedback: [], dailyCount: {} };
let storePath = '';

function loadStore(): void {
  try {
    storePath = path.join(app.getPath('userData'), STORE_FILE);
    if (fs.existsSync(storePath)) {
      store = { ...store, ...(JSON.parse(fs.readFileSync(storePath, 'utf-8')) as ProactiveStore) };
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
// λ(t) = baseline(时段) × 后验均值(个性化) × exp(-疲劳 × 近期已发数)
function intensity(chatKey: string, t: Date, now: number): number {
  return baselineAt(t) * priorScale(chatKey) * Math.exp(-FATIGUE_DECAY * recentProactiveCount(chatKey, now));
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
      const cfg = deps!.getDefaultModel();
      if (!cfg) return;
      const prompt =
        '从下面的用户消息中判断是否包含明确的未来约定/承诺（如「一小时后开会」「六点下班」「明天考试」）。' +
        '若有，输出 JSON：{"has":true,"minutes":预计距离现在的分钟数,"summary":"待回访事项的简短描述（含角色关心的语境）"}；没有则输出 {"has":false}。只输出 JSON。\n用户消息：' +
        userContent.slice(0, 300);
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
    } else {
      f.reaction = 'ignored';
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

// ===== 心跳（main.ts 每 60s 调用一次）=====
export function heartbeatProactive(): void {
  try {
    if (!deps) return;
    const s = deps.getSettings();
    if (s.proactiveEngine !== 'nhpp') return;
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
        });
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

// 供日志使用
export const proactiveLog = (category: 'functional' | 'model' | 'other', message: string): void => {
  deps?.logError?.(category, message);
};
