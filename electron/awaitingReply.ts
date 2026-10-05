// 主动消息「等你回复才发下一条」的等待态状态机（v2.3.93 抽出）
// ============================================================================
// 背景：v2.3.92 起，发出一条主动消息后主进程把该聊天记入 `proactiveAwaitingReply`，
// 在用户回复前阻止该聊天的下一条主动消息（legacy 3s 调度循环 + NHPP 60s 心跳两处门禁）。
// v2.3.93 聊天界面新增「等待你回复」提示 + 「我不回复」按钮，后者必须与「用户真的回复了」
// **完全等价**：同样清空等待集合、同样丢弃冻结基准、同样把计时基准重置为当下。
//
// 为什么抽成独立模块：
//   1. 「用户回复」与「我不回复」两条路径必须共用同一份清理逻辑，抽出来才能保证不会写成两套
//      而逐渐不一致（历史上这类「两条路径」最容易漏掉冻结表/基准重置）；
//   2. 纯函数 + 依赖注入（Maps / broadcast / now）→ 可被 scripts/verify-proactive-skip.mjs
//      用 esbuild 打包真实模块直接驱动，无需拉起整个 Electron（与 proactive.ts 同款做法）。
//
// 状态真源仍是主进程内存（调度全在主进程，多窗口天然一致），渲染层只读 + 发指令。

/** 解除等待态的原因（决定广播载荷，便于渲染层区分来源；清理动作本身完全一致）。 */
export type AwaitingReplyReason =
  /** 用户在该聊天真的发了消息（addUserMessage 路径） */
  | 'user-reply'
  /** 用户在界面点了「我不回复」（proactive:skipAwaitingReply 路径） */
  | 'skip'
  /** 设置里关掉了「等你回复才发下一条」开关（3s 调度循环检测到后全量清空） */
  | 'settings-off'
  /** 聊天被删除（残留状态一并清掉，避免删聊天后卡在等待态） */
  | 'chat-deleted';

/** 等待态变化广播频道（主进程 → 所有窗口）。 */
export const AWAITING_REPLY_CHANNEL = 'proactive:awaiting';

/**
 * 等待态涉及的三个状态容器（由 main.ts 持有并传入，本模块只做状态转移、不自己建容器）。
 * - awaiting：已发出主动消息、正在等用户回复的 chatKey 集合
 * - frozen：冷却期间冻结的已静默时长（ms），解除时必须丢弃（否则下次冷却 elapsed 起点错乱）
 * - idleState：chatKey -> 静默计时基准（lastActivityTs）
 */
export interface AwaitingReplyMaps {
  awaiting: Set<string>;
  frozen: Map<string, number>;
  idleState: Map<string, number>;
}

export interface AwaitingReplyDeps {
  maps: AwaitingReplyMaps;
  /** 广播到所有窗口（注入 main.ts 的 broadcast，避免本模块依赖 electron） */
  broadcast: (channel: string, payload: unknown) => void;
  /** 当前时间（可注入，便于测试断言基准重置） */
  now?: () => number;
  /**
   * 「等你回复才发下一条」开关是否开启（读 settings.idleCooldownUntilReply，默认 true）。
   * 关闭时不存在等待态：UI 不应显示提示，门禁也不应命中。
   */
  isGateOpen?: () => boolean;
}

export interface AwaitingReplyClearResult {
  /** 清理前该聊天是否确实处于等待态（false = 本次调用无实际变化） */
  wasAwaiting: boolean;
  /** 是否清掉了冻结基准 */
  frozenCleared: boolean;
  /** 是否重置了计时基准（dropTimerState=true 时为「整体删除」，此时恒 false） */
  baseReset: boolean;
  /** 计时基准重置后的时间戳（未重置为 null） */
  baseTs: number | null;
}

export interface AwaitingReplyTracker {
  /** 记入等待态（handleProactive 成功后调用） */
  mark: (chatKey: string) => void;
  /** 查询等待态；开关关闭时恒 false（与 proactive.ts 的门禁语义保持一致） */
  isAwaiting: (chatKey: string) => boolean;
  /**
   * 解除等待态 —— 「用户回复」与「我不回复」唯一的清理入口。
   * @param dropTimerState true = 连计时基准一起删除（聊天被删除时用）；false = 基准重置为当下
   */
  clear: (chatKey: string, reason: AwaitingReplyReason, opts?: { dropTimerState?: boolean }) => AwaitingReplyClearResult;
  /** 全量清空（设置开关关闭时用）：清等待集合 + 冻结表，并对每个 chatKey 广播 */
  clearAll: (reason: AwaitingReplyReason) => string[];
}

/**
 * 创建等待态跟踪器。
 * @param deps 状态容器 + 广播 + 时钟 + 开关读取；均可注入，便于真实模块级实测。
 */
export function createAwaitingReplyTracker(deps: AwaitingReplyDeps): AwaitingReplyTracker {
  const { maps, broadcast } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const isGateOpen = deps.isGateOpen ?? ((): boolean => true);

  /** 安全广播：单窗异常不影响状态机（与 main.ts broadcast 的容错语义一致） */
  const emit = (channel: string, payload: unknown): void => {
    try {
      broadcast(channel, payload);
    } catch {
      /* 广播失败不阻断状态转移 */
    }
  };

  const mark = (chatKey: string): void => {
    if (!chatKey) return;
    maps.awaiting.add(chatKey);
    emit(AWAITING_REPLY_CHANNEL, { chatKey, awaiting: true, reason: 'sent' });
  };

  const isAwaiting = (chatKey: string): boolean => {
    if (!chatKey) return false;
    if (!isGateOpen()) return false;
    return maps.awaiting.has(chatKey);
  };

  const clear = (
    chatKey: string,
    reason: AwaitingReplyReason,
    opts?: { dropTimerState?: boolean },
  ): AwaitingReplyClearResult => {
    if (!chatKey) return { wasAwaiting: false, frozenCleared: false, baseReset: false, baseTs: null };
    // 1) 解除调度门禁（legacy 3s 循环 + NHPP 心跳共用这一个 Set）
    const wasAwaiting = maps.awaiting.delete(chatKey);
    // 2) 丢弃冻结基准：残留值会让下次冷却的 elapsed 起点错乱（倒计时走字却不发）
    const frozenCleared = maps.frozen.delete(chatKey);
    // 3) 计时基准：重置为当下 → 下一条主动消息按「刚回复过」重新开始计时（不会解除瞬间补发）
    let baseReset = false;
    let baseTs: number | null = null;
    if (opts?.dropTimerState) {
      // 聊天已删除：连基准一起删掉，避免残留幽灵计时
      maps.idleState.delete(chatKey);
    } else if (maps.idleState.has(chatKey)) {
      baseTs = now();
      maps.idleState.set(chatKey, baseTs);
      baseReset = true;
    }
    // 4) 广播：等回复提示状态（多窗口同步）+ 倒计时基准（前端立即刷新显示）
    emit(AWAITING_REPLY_CHANNEL, { chatKey, awaiting: false, reason });
    if (baseReset && baseTs != null) {
      emit('idle:activity', { chatKey, timestamp: baseTs, reason });
    }
    return { wasAwaiting, frozenCleared, baseReset, baseTs };
  };

  const clearAll = (reason: AwaitingReplyReason): string[] => {
    const keys = [...maps.awaiting];
    for (const key of keys) clear(key, reason);
    // 冻结表可能残留没有对应等待条目的键（历史/异常路径）→ 整体清空，
    // 否则残留值会让下次开启开关后计时起点错乱（与 v2.3.92 原行为一致）
    maps.frozen.clear();
    return keys;
  };

  return { mark, isAwaiting, clear, clearAll };
}
