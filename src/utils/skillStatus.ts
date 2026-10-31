// ============================================================================
// Skill 状态（聊天气泡下方「本轮已注入 Skill X」状态条）的纯逻辑
// ============================================================================
// 抽成独立模块的原因（v3.0.1-beta.2）：
//   v3.0.1 的实现把状态按 **streamId** 分桶，而 streamId = `${chatId}:${roleId}`
//   **跨轮复用**（同一会话 + 同一角色的每一轮都是同一个字符串）。
//   于是一轮新回复把状态置为「正在调用」时，本会话**所有历史 AI 气泡**都解析到同一个
//   key → 满屏都显示状态条（用户实测：「发送一条消息之后，整个页面上所有的气泡底下
//   都有正在调用 Skill」「以前已经回复过的消息，气泡底下还有正在调用 Skill 的显示」）。
//
//   修复：改按**每轮唯一 replyKey** 分桶（`${streamId}#${轮次}`），
//   并用「消息 id → replyKey」映射把状态挂到**本轮这一条**气泡上。
//
// 本模块只做纯计算与纯状态变换，**不碰 React / IPC / DOM**，
// 因此可被 scripts/verify-skill-status.mjs 直接打包后真实调用（行为级闸门）。
// ============================================================================

export type SkillCallStatus = 'calling' | 'done' | 'fading';

/** 一轮回复对应的状态条目 */
export interface SkillCallEntry {
  status: SkillCallStatus;
  /** 本轮生效的技能名；为空表示没有生效技能 → 不显示状态条 */
  names: string[];
}

/** replyKey -> 状态条目 */
export type SkillCallMap = Record<string, SkillCallEntry>;

/** 消息 id（字符串化）-> replyKey */
export type ReplyKeyMap = Record<string, string>;

/**
 * streamId -> **待结束**的 replyKey 队列（FIFO）。
 *
 * 为什么不能只记「本轮最新 key」：同一 streamId 连续多轮时，**上一轮被���断**也会广播
 * stream:done（main.ts 打断分支），而那个 done 可能**晚于**下一轮的 stream:start 到达
 * （打断是异步 reject，新一轮的 start 在其之前发出）。若只记「最新 key」，
 * 迟到的旧 done 就会把**新一轮**的条目误标成「已完成」。
 * 同一 streamId 的多轮严格按「开始顺序」结束，故用 FIFO 出队即可准确配对。
 */
export type ReplyKeyQueue = Record<string, string[]>;

/** 记录本轮开始（入队） */
export function pushReplyKey(
  queue: ReplyKeyQueue,
  streamId: string,
  replyKey: string,
): ReplyKeyQueue {
  const list = queue[streamId] ? queue[streamId].slice() : [];
  list.push(replyKey);
  return { ...queue, [streamId]: list };
}

/**
 * 取出本轮结束对应的 replyKey（FIFO 出队：先开始的先结束）。
 * 返回 [key, 新队列] —— 队列是纯函数式更新，调用方需把新队列写回 ref。
 */
export function takeReplyKey(
  queue: ReplyKeyQueue,
  streamId: string,
): [string | undefined, ReplyKeyQueue] {
  const list = queue[streamId];
  if (!list || !list.length) return [undefined, queue];
  const head = list[0];
  const rest = list.slice(1);
  const next = { ...queue };
  if (rest.length) next[streamId] = rest;
  else delete next[streamId];
  return [head, next];
}

/** 该 stream 的轮次异常结束（流式出错、无 stream:done）时清掉待结束队列 */
export function clearReplyKeys(queue: ReplyKeyQueue, streamId: string): ReplyKeyQueue {
  if (!queue[streamId]) return queue;
  const next = { ...queue };
  delete next[streamId];
  return next;
}

/** 完成后停留时长（ms）：显示「已完成」→ 渐隐 */
export const SKILL_STATUS_LINGER_MS = 3000;
/** 渐隐时长（ms）：淡出动画结束后移除节点 */
export const SKILL_STATUS_FADE_MS = 420;

/**
 * 生成本轮回复的唯一键。
 * streamId 跨轮复用，必须附加轮次序号才能区分不同的回复轮次。
 */
export function nextReplyKey(streamId: string, seq: number): string {
  return `${streamId}#${seq}`;
}

/**
 * 定位「某条消息」自己的技能状态。
 *
 * @param skillCalls   replyKey -> 状态条目
 * @param message      消息对象：流式占位气泡自带 replyKey 字段；落库后的真实消息靠 msgId 反查
 * @param msgReplyKey  消息 id（字符串化）-> replyKey
 *
 * 返回 null 表示这条气泡**不显示**状态条：
 *   · 没有本轮记录（历史消息 / 其他对话）
 *   · 本轮没有生效技能（names 为空）
 */
export function resolveSkillCallForMessage(
  skillCalls: SkillCallMap,
  message: { id?: number | string | null; replyKey?: string } | null | undefined,
  msgReplyKey: ReplyKeyMap,
): SkillCallEntry | null {
  if (!message) return null;
  const replyKey =
    message.replyKey ||
    (message.id != null ? msgReplyKey[String(message.id)] : undefined);
  if (!replyKey) return null;
  const entry = skillCalls[replyKey];
  if (!entry || !entry.names.length) return null;
  return entry;
}

/**
 * 回填本轮的技能名（IPC 异步返回，可能晚于本轮结束）。
 *
 * 竞态要点：
 *   ① 条目已被移除（渐隐收尾完成）→ **不复活**，否则该气泡会永远卡在「正在调用」；
 *   ② **只补 names，不改 status** —— 本轮若已进入 done/fading 就保持终态，
 *      否则「已完成」会被打回「正在调用」。
 *
 * @returns 是否真的写入了
 */
export function applySkillNames(
  prev: SkillCallMap,
  replyKey: string,
  names: string[],
): { map: SkillCallMap; applied: boolean } {
  const cur = prev[replyKey];
  if (!cur) return { map: prev, applied: false };
  return { map: { ...prev, [replyKey]: { ...cur, names } }, applied: true };
}

/** 轮次结束 → 「已完成」 */
export function markSkillDone(prev: SkillCallMap, replyKey: string): SkillCallMap {
  const cur = prev[replyKey];
  if (!cur) return prev;
  return { ...prev, [replyKey]: { ...cur, status: 'done' } };
}

/** 停留结束 → 渐隐 */
export function markSkillFading(prev: SkillCallMap, replyKey: string): SkillCallMap {
  const cur = prev[replyKey];
  if (!cur) return prev;
  return { ...prev, [replyKey]: { ...cur, status: 'fading' } };
}

/** 渐隐结束 → 移除条目 */
export function removeSkillCall(prev: SkillCallMap, replyKey: string): SkillCallMap {
  if (!prev[replyKey]) return prev;
  const copy = { ...prev };
  delete copy[replyKey];
  return copy;
}

/** 新一轮开始：建立条目（names 待 IPC 回填） */
export function beginSkillCall(prev: SkillCallMap, replyKey: string): SkillCallMap {
  return { ...prev, [replyKey]: { status: 'calling', names: [] } };
}
