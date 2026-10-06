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
  /**
   * v2.3.94 需求 4：chatKey -> 等待期内已发出的主动消息条数。
   * 阈值 > 1 时用它累计：发满阈值才真正进入等待态（进 awaiting 集合）。
   * 用户回复/主动跳过时清零。
   */
  counts?: Map<string, number>;
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
  /**
   * v2.3.94 需求 4：触发等待的主动消息条数阈值（读 settings.idleAwaitingTriggerCount）。
   * - 返回 1 → 旧行为：发出 1 条就进入等待态；
   * - 返回 n → 发满 n 条主动消息后才进入等待态（期间继续发，达到 n 条即停）；
   * - 返回 0 或 >= AWAITING_NEVER（9999）→ **不启用等待功能**（等价「无限条」）。
   */
  getTriggerThreshold?: () => number;
}

/** 「无限条」哨兵值：达到或超过它即视为「不启用等待功能」（设置界面填这个值表示最大档） */
export const AWAITING_NEVER = 9999;

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
  /**
   * 记入一次「已发出主动消息」（handleProactive 成功后调用）。
   * v2.3.94 需求 4：按阈值决定是**累计计数**还是**立即进入等待态**。
   * @returns 本次调用后该聊天是否处于等待态（渲染层据此决定要不要显示提示）
   */
  mark: (chatKey: string) => void;
  /** 查询等待态；开关关闭时恒 false（与 proactive.ts 的门禁语义保持一致） */
  isAwaiting: (chatKey: string) => boolean;
  /** 查询当前累计的主动消息条数（UI 展示「第 n/m 条」用；未计数为 0） */
  count: (chatKey: string) => number;
  /**
   * 解除等待态 —— 「用户回复」与「我不回复」唯一的清理入口。
   * @param dropTimerState true = 连计时基准一起删除（聊天被删除时用）；false = 基准重置为当下
   */
  clear: (chatKey: string, reason: AwaitingReplyReason, opts?: { dropTimerState?: boolean }) => AwaitingReplyClearResult;
  /** 全量清空（设置开关关闭时用）：清等待集合 + 冻结表 + 计数，并对每个 chatKey 广播 */
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
  const getTriggerThreshold = deps.getTriggerThreshold ?? ((): number => 1);

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
    // v2.3.93 QA 复核 BUG-E：开关关闭（idleCooldownUntilReply=false）时不得进入等待态。
    // 漏判后果：调度侧已被 isGatedByAwaitingReply/isAwaiting 挡住不会真发消息，
    // 但 mark() 仍会广播 awaiting:true —— 渲染层正是走广播路径，于是 UI 提示会
    // 永久残留（清不掉，因为开关关闭时 clearAll 不会逐个广播清除）。
    // 与 isAwaiting() 保持同一判据，避免「查得到=false、界面却显示等待」的割裂。
    if (!isGateOpen()) return;

    // v2.3.94 需求 4：阈值化。
    //   - 阈值 1（默认）→ 旧行为：发一条即进入等待态；
    //   - 阈值 n>1       → 先累计计数，发满 n 条才进入等待态（期间继续发）；
    //   - 阈值 0 / ≥9999 → 不启用等待（等价「无限条」），连计数都不记。
    const raw = getTriggerThreshold();
    const threshold = Number.isFinite(raw) ? Math.floor(raw) : 1;
    if (threshold <= 0 || threshold >= AWAITING_NEVER) {
      // 不启用等待：确保此前若处于等待态也要解开（用户可能刚把阈值调到「无限」）
      if (maps.awaiting.has(chatKey)) clear(chatKey, 'settings-off');
      return;
    }

    if (threshold > 1 && maps.counts) {
      const next = (maps.counts.get(chatKey) || 0) + 1;
      maps.counts.set(chatKey, next);
      if (next < threshold) {
        // 还没发满：继续发下一条，但要把计数与「当前 n/m」告诉渲染层，
        // 让用户看得见「再有 (m-n) 条就开始等你回复」。
        emit(AWAITING_REPLY_CHANNEL, {
          chatKey,
          awaiting: false,
          reason: 'counting',
          count: next,
          threshold,
        });
        return;
      }
    }

    maps.awaiting.add(chatKey);
    emit(AWAITING_REPLY_CHANNEL, {
      chatKey,
      awaiting: true,
      reason: 'sent',
      count: maps.counts?.get(chatKey),
      threshold,
    });
  };

  const isAwaiting = (chatKey: string): boolean => {
    if (!chatKey) return false;
    if (!isGateOpen()) return false;
    return maps.awaiting.has(chatKey);
  };

  /** v2.3.94 需求 4：当前已累计的主动消息条数（UI 展示用） */
  const count = (chatKey: string): number => {
    if (!chatKey) return 0;
    return maps.counts?.get(chatKey) || 0;
  };

  const clear = (
    chatKey: string,
    reason: AwaitingReplyReason,
    opts?: { dropTimerState?: boolean },
  ): AwaitingReplyClearResult => {
    if (!chatKey) return { wasAwaiting: false, frozenCleared: false, baseReset: false, baseTs: null };
    // 1) 解除调度门禁（legacy 3s 循环 + NHPP 心跳共用这一个 Set）
    const wasAwaiting = maps.awaiting.delete(chatKey);
    // 1b) v2.3.94 需求 4：计数必须一并清零，否则阈值 >1 时上一轮的 n 会让下一轮提前进入等待态
    maps.counts?.delete(chatKey);
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
    // v2.3.94 需求 4：计数表同样整体清空（阈值 >1 时可能存在「尚未发满、无等待条目」的键）
    maps.counts?.clear();
    return keys;
  };

  return { mark, isAwaiting, count, clear, clearAll };
}
