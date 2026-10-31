// ============================================================================
// 聊天滚动跟随（粘底）策略 —— 主窗 / 小窗共用
// ============================================================================
// 问题（v3.0.1-beta.4）：模型回复期间，用户向上滚动查看历史消息会被**强制拉回底部**。
//   根因：主窗/小窗都在 `useEffect(..., [messages, streamingMsgs])` 里无条件
//   `scrollTo({ top: scrollHeight })`。流式输出时 `streamingMsgs` 每来一个 chunk
//   就变一次 → 每来一个字就强制滚到底 → 用户完全无法向上翻。
//
// 策略：**仅当用户本来就贴着底部时才跟随**（业界通行做法，如 Slack / Telegram / 微信）。
//   · 用户在底部 → 新内容到达时继续跟随（保持「正在聊」的直觉）
//   · 用户向上翻了 → 停止跟随，底部出现「回到底部」按钮，由用户主动点回
//   · 用户自己滚回底部 → 恢复跟随
//
// 判定「贴底」用**像素距离**而非比例：不同缩放/窗口高度下比例不可靠。
// ============================================================================

/** 贴底判定阈值（px）：距离底部小于此值即视为「用户在底部」 */
export const STICK_BOTTOM_THRESHOLD_PX = 120;

/**
 * 判断滚动容器当前是否「贴着底部」。
 * @param el 滚动容器
 * @param threshold 贴底阈值（px），默认 120
 */
export function isNearBottom(el: HTMLElement | null, threshold: number = STICK_BOTTOM_THRESHOLD_PX): boolean {
  if (!el) return true;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distance <= threshold;
}

/**
 * 创建一个「粘底跟随器」。
 *
 * 用法：
 *   const stick = useRef<StickToBottom>(null);
 *   if (!stick.current) stick.current = createStickToBottom();
 *   // 滚动监听里更新用户位置
 *   stick.current.onUserScroll();
 *   // 内容变化时
 *   stick.current.followOnContentChange();
 *
 * 关键点：`followOnContentChange` 只在「用户本来在底部」时才滚动；
 * 用户一旦向上滚动，就不再被强制拉回，直到他手动滚回底部。
 */
export interface StickToBottom {
  /** 用户主动滚动后调用：更新「是否贴底」状态 */
  onUserScroll: () => void;
  /** 内容（消息/流式）变化后调用：贴底时才滚动 */
  followOnContentChange: () => void;
  /** 主动滚到底（点「回到底部」按钮 / 切换会话）后调用：恢复跟随 */
  resumeFollowing: () => void;
  /** 当前是否处于跟随状态 */
  isFollowing: () => boolean;
}

export function createStickToBottom(getEl: () => HTMLElement | null): StickToBottom {
  // 用户当前是否贴底。初始 true（新会话从底部开始）。
  let following = true;

  const check = () => {
    const el = getEl();
    if (!el) return true;
    // 容器内容还没超出可视高度时（没有滚动条），视为始终贴底
    if (el.scrollHeight <= el.clientHeight + 1) return true;
    return isNearBottom(el);
  };

  return {
    onUserScroll: () => {
      following = check();
    },
    followOnContentChange: () => {
      const el = getEl();
      if (!el) return;
      // 容器装得下全部内容 → 本来就「在底部」，直接跟随（无滚动条时 scrollTop 恒为 0）
      if (el.scrollHeight <= el.clientHeight + 1) {
        el.scrollTop = el.scrollHeight;
        following = true;
        return;
      }
      if (!following) return; // 用户已向上翻 → 不打扰
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    },
    resumeFollowing: () => {
      following = true;
      const el = getEl();
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    },
    isFollowing: () => following,
  };
}
