/**
 * 陪伴时长计时（v2.3.94 需求 11）
 * ============================================================================
 * 统计口径：**聊天窗口处于前台可见且窗口有焦点**时，每经过 1 秒记 1 秒。
 * 组件卸载 / 窗口隐藏 / 失焦 → 立即停表并把已累计的增量上报（不丢秒）。
 *
 * 三条硬性约束的实现方式：
 *   ① 停表：所有条件集中在 {@link shouldTick}，失焦/隐藏由 focus/blur/visibilitychange
 *      事件立刻触发停表 + 结算，而不是等下一个 tick（否则会多记最多 1 秒的「看不见的时间」）。
 *   ② **不每 1 秒写盘**：渲染进程每 30 秒（{@link FLUSH_TICKS} 个 tick）才批量上报一次，
 *      主进程 db.addCompanionMs 里还有一层 30s 合并落盘 —— 两层节流叠加，
 *      「每秒一次同步 fs.writeFileSync 整份 settings.json」的卡顿被彻底避免。
 *   ③ 计时状态放**模块级**（本文件的 activeSessions / pending / 单条 ticker），
 *      而不是组件内 useState：同一条消息若渲染多个组件、或同一 key 被多个组件引用，
 *      组件级状态会各算一份、把陪伴时长翻倍；模块级则天然「一个 key 一份」。
 *
 * 主窗与小窗是两个独立 BrowserWindow，各有本模块的一份实例（互不可见），但两者都只上报
 * **增量**给主进程，由主进程做唯一累加（db.addCompanionMs），因此同一个 key 两边同时计时
 * 是**相加**而不是互相覆盖（详见 electron/db.ts 的 addCompanionMs 注释）。
 */
import { api } from '../ipc';

/** 心跳间隔（毫秒）：每 tick 记 1000ms 陪伴时长 */
const TICK_MS = 1000;
/** 每多少个 tick 批量上报一次（30 个 tick ≈ 30 秒），对应需求「不要每 1 秒就写盘」 */
const FLUSH_TICKS = 30;

/** 当前正在计时的会话 key 集合（key = `"chatType:chatId"`） */
const activeSessions = new Set<string>();
/** 已累计但尚未上报的增量（毫秒），key 同上 */
const pending = new Map<string, number>();
/** 全局唯一 ticker（引用计数式：无人计时则 null，避免空转） */
let ticker: ReturnType<typeof setInterval> | null = null;
/** 自上次上报以来经过的 tick 数 */
let ticksSinceFlush = 0;

/** 会话 key 构造：与 settings.companionMs 的 key 口径一致（`"chatType:chatId"`） */
export function companionKeyOf(chatType: string, chatId: string): string {
  return `${chatType}:${chatId}`;
}

/**
 * 是否应该继续走表。
 * 必须同时满足「文档可见」与「窗口有焦点」——只判 visibilityState 是不够的：
 * 窗口被其它窗口遮挡/最小化到后台时 visibilityState 在部分平台仍为 visible，
 * 但用户显然不在看它，不应计入陪伴时长。
 */
function shouldTick(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.visibilityState !== 'visible') return false;
  try {
    return document.hasFocus();
  } catch {
    // 极少数环境 hasFocus 不可用 → 保守起见按「不可见」处理，避免误记
    return false;
  }
}

/** 把 pending 里的增量上报给主进程（主进程累加）。上报失败不阻塞，pending 保持原样等待下轮重试。 */
function flush(): void {
  if (pending.size === 0) return;
  const batch = Array.from(pending.entries());
  pending.clear();
  ticksSinceFlush = 0;
  for (const [key, deltaMs] of batch) {
    try {
      // 刻意不 await：心跳上报无需等待结果；主进程是唯一累加点，重复/丢失由节流窗口兜底
      void api.addCompanionMs(key, deltaMs);
    } catch (e) {
      console.error('陪伴时长上报失败', key, e);
    }
  }
}

function tick(): void {
  if (!shouldTick()) return;
  for (const key of activeSessions) {
    pending.set(key, (pending.get(key) || 0) + TICK_MS);
  }
  ticksSinceFlush += 1;
  if (ticksSinceFlush >= FLUSH_TICKS) flush();
}

function ensureTicker(): void {
  if (ticker !== null) return;
  ticker = setInterval(tick, TICK_MS);
}

/** 停表 + 结算：失焦 / 隐藏 / 页面卸载时调用，把已累计的增量立刻上报，避免丢失。 */
function pauseAndFlush(): void {
  flush();
}

let listenersBound = false;
function bindListeners(): void {
  if (listenersBound || typeof document === 'undefined') return;
  listenersBound = true;
  // 失焦 / 切到后台：立即结算已累计部分（不多记那「最多 1 秒」的不可见时间）
  window.addEventListener('blur', pauseAndFlush);
  window.addEventListener('beforeunload', pauseAndFlush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') pauseAndFlush();
  });
}

/**
 * 开始为某个会话计时（幂等：重复调用只会把同一 key 加进集合，不会起第二份表）。
 *
 * @param chatType 会话类型（'single' / 'group'）
 * @param chatId   会话 id
 * @returns 停表函数：调用后该 key 停止计时并立即结算已累计的增量（组件卸载时务必调用）
 */
export function startCompanionTimer(chatType: string, chatId: string): () => void {
  const key = companionKeyOf(chatType, chatId);
  activeSessions.add(key);
  ensureTicker();
  bindListeners();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    activeSessions.delete(key);
    // 立刻结算该 key 已累计的增量，避免「离开后到下一次上报前」的秒数白等
    const delta = pending.get(key);
    if (delta && delta > 0) {
      pending.delete(key);
      try {
        void api.addCompanionMs(key, delta);
      } catch (e) {
        console.error('陪伴时长结算失败', key, e);
      }
    }
    if (activeSessions.size === 0 && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}