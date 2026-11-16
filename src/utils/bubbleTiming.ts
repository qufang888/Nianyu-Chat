/**
 * 桌宠气泡停留时长 / 动画时长的**唯一派生真源**（v3.0.3）。
 *
 * 为什么要单独成文件：
 * - 角色窗（真正决定气泡弹多久）与设置页（换算示例）必须用**同一个函数**，
 *   否则用户看到的"60 字 ≈ 5.0s"与实际停留时间对不上（QA F5 要求示例与实测一致）；
 * - 本文件零 DOM 依赖、零 import，可被任意层安全引用。
 *
 * 分档口径（PRD R6-AC2 分档表为准）：
 *   steps     = ceil(max(0, len - 20) / 20)   // 21 字起进第 2 档
 *   holdSec   = clamp(baseSec + steps * stepSec, baseSec, maxSec)
 *
 * ⚠️ 关于 ceil 与 floor：PRD 正文 R6-AC3 写的是 floor，但同一文档的分档表（R6-AC2）
 * 与验收清单（F1：21/41/61/141 字）都指向 ceil。本实现以**分档表**为准（ceil），
 * 偏差已登记在实现说明中（见设计文档 §1.6.1 / Q-1）。
 */

/** 每多少字进一档 */
export const BUBBLE_STEP_CHARS = 20;
/** 基准停留秒数（默认） */
export const BUBBLE_HOLD_BASE_SEC = 3;
/** 每档递增秒数（默认） */
export const BUBBLE_HOLD_STEP_SEC = 1;
/** 停留上限秒数（默认） */
export const BUBBLE_HOLD_MAX_SEC = 10;

/** 气泡停留分档参数（三个值都可由用户设置） */
export interface BubbleHoldParams {
  /** 基准停留（秒） */
  baseSec: number;
  /** 每 20 字递增（秒） */
  stepSec: number;
  /** 停留上限（秒） */
  maxSec: number;
}

/** 桌宠动画相关的一组参数（从 settings 读出并钳制后的结果） */
export interface CharacterAnimParams {
  /** 菜单弹出/收回时长（秒） */
  menuSec: number;
  /** 气泡弹出/收回时长（秒） */
  bubbleSec: number;
  /** 气泡停留基准（秒） */
  holdBaseSec: number;
  /** 气泡停留每档递增（秒） */
  holdStepSec: number;
  /** 气泡停留上限（秒） */
  holdMaxSec: number;
}

/** settings 里可能存在的桌宠动画字段（部分缺失时按缺省值兜底） */
export interface CharacterAnimSettingsLike {
  animCharacterMenuSec?: number;
  animCharacterBubbleSec?: number;
  animCharacterBubbleBaseSec?: number;
  animCharacterBubbleStepSec?: number;
  animCharacterBubbleMaxSec?: number;
}

/** 把数值钳制到区间内；非法值（NaN / 非有限）回退默认值 */
function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 统计气泡展示文本的"字数"。
 * 用码点计数（`[...text].length`）而非 `text.length`：
 * emoji / 生僻字在 UTF-16 里占 2 个码元，用 .length 会把一个 emoji 算成两个字，
 * 导致这类短气泡莫名多停 1 秒（PRD R6-AC1 明确要求按 Unicode 码点计）。
 */
export function countBubbleChars(text: string): number {
  if (!text) return 0;
  return [...text].length;
}

/**
 * 按字数算停留秒数。
 * @param len 展示文本的码点数
 * @param p 三个可调参数
 */
export function bubbleHoldSeconds(len: number, p: BubbleHoldParams): number {
  const base = Math.max(0, Number(p.baseSec) || 0);
  const step = Math.max(0, Number(p.stepSec) || 0);
  // 上限不得低于基准（否则钳制区间自相矛盾），取二者较大值
  const cap = Math.max(base, Number(p.maxSec) || 0);
  const steps = Math.ceil(Math.max(0, len - BUBBLE_STEP_CHARS) / BUBBLE_STEP_CHARS);
  const hold = base + steps * step;
  return Math.min(cap, Math.max(base, hold));
}

/** 按文本算停留毫秒数（角色窗实际使用） */
export function bubbleHoldMs(text: string, p: BubbleHoldParams): number {
  return Math.round(bubbleHoldSeconds(countBubbleChars(text), p) * 1000);
}

/**
 * 从 settings 里读出桌宠动画参数并做区间钳制 + 缺省兜底。
 * 老用户 settings 里没有这些字段 ⇒ 全部回落默认值，不会出现 NaN 时长。
 */
export function readCharacterAnimParams(s: CharacterAnimSettingsLike | null | undefined): CharacterAnimParams {
  return {
    menuSec: clampNum(s?.animCharacterMenuSec, 0.05, 1, 0.2),
    bubbleSec: clampNum(s?.animCharacterBubbleSec, 0.05, 1, 0.18),
    holdBaseSec: clampNum(s?.animCharacterBubbleBaseSec, 1, 10, BUBBLE_HOLD_BASE_SEC),
    holdStepSec: clampNum(s?.animCharacterBubbleStepSec, 0, 3, BUBBLE_HOLD_STEP_SEC),
    holdMaxSec: clampNum(s?.animCharacterBubbleMaxSec, 3, 30, BUBBLE_HOLD_MAX_SEC),
  };
}
