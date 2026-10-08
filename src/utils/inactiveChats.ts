/**
 * 不常用聊天文件夹 —— 判定与分组共享逻辑（需求 14）
 * ============================================================================
 * 与 `chatOrdering.ts` 同为「主界面 ChatList / 悬浮球 / 小窗」共用的纯逻辑，
 * 保证「谁该被归入不常用聊天」在任何入口都得到同一答案。
 *
 * 判定规则（用户需求）：
 *   1. **自动移入**：某个聊天超过 `inactiveChatDays` 天没在该聊天聊过天
 *      → 依据 `ChatListItem.last_time`（最后一条消息时间）。
 *      ⚠️ **置顶聊天不自动移入**（置顶状态在 `settings.pinnedChats`）——
 *      置顶本身已经是用户「我还在用」的信号，再自动藏起来属于违背用户意图。
 *   2. **手动移入**：`settings.inactiveChats[key] === true`（key = `chatType:chatId`）。
 *      手动优先于自动，且移入时会连带取消置顶（见 `moveChatToInactive`）。
 *   3. **移出**：删掉 `inactiveChats` 的 key 即移出；**不恢复置顶**
 *      （全局不记录「曾置顶」，所以移出后不会出现幽灵置顶）。
 *   4. `last_time` 缺失/非法时**判为常用**（不藏）—— 宁可多显示一条，
 *      也不能把用户刚建、还没产生消息的聊天误判成「不常用」。
 */

import { chatKeyOf, type SortableChat } from './chatOrdering';

/** 判定所需的最少字段：`ChatListItem` 天然满足 */
export type InactivityCandidate = SortableChat & { last_time?: string };

/** 不常用天数阈值的合法范围与默认值（与 Settings 输入框 min/max 一致） */
export const INACTIVE_DAYS_MIN = 1;
export const INACTIVE_DAYS_MAX = 3650;
export const INACTIVE_DAYS_DEFAULT = 30;

/** 把任意输入夹到合法天数区间；非法值回落默认值 30 */
export function clampInactiveDays(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return INACTIVE_DAYS_DEFAULT;
  if (n < INACTIVE_DAYS_MIN) return INACTIVE_DAYS_MIN;
  if (n > INACTIVE_DAYS_MAX) return INACTIVE_DAYS_MAX;
  return n;
}

/**
 * 距今多少「整天」没在该聊天聊过天。
 * 返回 -1 表示时间缺失/非法（调用方应判为常用）。
 */
export function inactiveDays(chat: InactivityCandidate, now: number = Date.now()): number {
  if (!chat.last_time) return -1;
  const t = new Date(chat.last_time).getTime();
  if (Number.isNaN(t)) return -1;
  return Math.floor((now - t) / 86400000);
}

/** 该聊天是否被**手动**标记为不常用（`inactiveChats[key] === true`） */
export function isManuallyInactive(key: string, manual: Record<string, boolean> | undefined): boolean {
  return !!manual && manual[key] === true;
}

/**
 * 该聊天是否被用户**手动豁免**自动判定（`inactiveChats[key] === false`）。
 * 见 {@link moveChatOutOfInactive} 的说明：这是「移出后不许立刻弹回去」的必要状态。
 */
export function isInactivityExempt(key: string, manual: Record<string, boolean> | undefined): boolean {
  return !!manual && manual[key] === false;
}

/**
 * 某个聊天当前是否应归入「不常用聊天」文件夹。
 *
 * @param chat       聊天项（需含 last_time）
 * @param manual     settings.inactiveChats（手动移入标记 `true` / 手动豁免标记 `false`）
 * @param days       settings.inactiveChatDays（阈值，已由 clampInactiveDays 夹过）
 * @param pinned     settings.pinnedChats（置顶聊天不自动移入）
 * @param now        当前时间戳（便于测试注入）
 */
export function isInactiveChat(
  chat: InactivityCandidate,
  manual: Record<string, boolean> | undefined,
  days: number,
  pinned: string[] | undefined,
  now: number = Date.now()
): boolean {
  const key = chatKeyOf(chat);
  // 手动移入优先：手动移入即生效（此时置顶已在移入时被取消）
  if (isManuallyInactive(key, manual)) return true;
  // 置顶聊天不自动移入
  if ((pinned || []).includes(key)) return false;
  const d = inactiveDays(chat, now);
  if (d < 0) return false; // 最近有消息 → 新鲜，不收
  const inactive = d >= clampInactiveDays(days);
  // 手动豁免：仅当「尚未到不常用阈值」时生效；一旦超期，豁免自然失效、自动收回
  if (isInactivityExempt(key, manual) && !inactive) return false;
  return inactive;
}

/** 分组结果：常用聊天 + 不常用聊天（各自保持传入顺序，即已有的排序结果） */
export interface InactivePartition<T> {
  active: T[];
  inactive: T[];
}

/** 把已排序好的聊天列表拆成「常用」与「不常用」两组 */
export function partitionByInactive<T extends InactivityCandidate>(
  sorted: readonly T[],
  manual: Record<string, boolean> | undefined,
  days: number,
  pinned: string[] | undefined,
  now: number = Date.now()
): InactivePartition<T> {
  const active: T[] = [];
  const inactive: T[] = [];
  for (const it of sorted) {
    (isInactiveChat(it, manual, days, pinned, now) ? inactive : active).push(it);
  }
  return { active, inactive };
}

/**
 * 手动移入不常用聊天文件夹，返回要落盘的两个字段。
 * 移入后**置顶状态消失**：从 pinnedChats 里删掉该 key。
 * 刻意不记录「曾置顶」——需求明确要求移出后不恢复置顶。
 */
export function moveChatToInactive(
  key: string,
  manual: Record<string, boolean> | undefined,
  pinned: string[] | undefined
): { inactiveChats: Record<string, boolean>; pinnedChats: string[] } {
  return {
    inactiveChats: { ...(manual || {}), [key]: true },
    pinnedChats: (pinned || []).filter((k) => k !== key),
  };
}

/**
 * 移出不常用聊天文件夹，返回要落盘的 inactiveChats。
 *
 * 写入 **`false`** 而不是删key，原因是：自动判定是纯函数（每次渲染按 `last_time` 重算），
 * 若这里只删标记，一个「本来就超期」的聊天会在下一次 refresh（ChatList 每 1.5s 一次）
 * 立刻又弹回文件夹里 —— 用户点「移出」却看起来毫无效果。
 * 写 `false` 表示「用户明确把它留在常用区」，被 `isInactiveChat` 的豁免分支尊重。
 * 该聊天一旦重新产生消息（`last_time` 变新），豁免自然失效、也不需要清理。
 *
 * 只动 inactiveChats：**不恢复 pinnedChats**（移入时已删过 key，
 * 这里若再加回就等于「恢复置顶」，违反需求）。
 */
export function moveChatOutOfInactive(
  key: string,
  manual: Record<string, boolean> | undefined
): Record<string, boolean> {
  return { ...(manual || {}), [key]: false };
}