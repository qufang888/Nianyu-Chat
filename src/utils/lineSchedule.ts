/**
 * 桌宠主动说话频率的**唯一派生真源**（v3.0.3）。
 *
 * 为什么单独成文件：
 * - 渲染层（角色窗调度器）与主进程（第二道防线护栏）都必须用**同一份**换算逻辑，
 *   否则两端算出不同的间隔，表现为「设了 60 条/分，实际只有 2 条/分」这类幽灵 Bug；
 * - 本文件刻意**不 import 任何东西**（零 DOM 依赖、零类型依赖），
 *   这样 electron 主进程可以直接 import 它（见 electron/main.ts）而不引入渲染层依赖。
 *
 * 口径（与 PRD §12.2 逐字一致）：
 *   rate = clamp(round(n ?? 2), 0, 60)
 *   rate === 0        → 完全不主动说话（连调度器都不创建）
 *   intervalMs = max(1000, round(60000 / rate))   // 最小请求间隔 = 探测判定的唯一依据
 *   tickMs     = clamp(round(intervalMs / 4), 500, 15000)  // 只负责"到点检查"，本身不产生请求
 */

/** 频率下限：0 = 完全不主动说话 */
export const SPEAK_RATE_MIN = 0;
/** 频率上限：60 条/分钟（= 每秒 1 条，配合 1000ms 硬下限） */
export const SPEAK_RATE_MAX = 60;
/** 出厂默认频率：存量用户升级后默认 2 条/分钟（派生 30000ms，与 v3.0.2 主进程 30s 护栏同值，行为不回退） */
export const SPEAK_RATE_DEFAULT = 2;
/** 最小请求间隔硬下限（毫秒）= 最多 60 条/分，与用户口径一致 */
export const LINE_MIN_INTERVAL_MS = 1000;

/** 频率调度方案（由设置里的"每分钟几条"派生出来的全部运行时参数） */
export interface LineSchedule {
  /** false ⇔ rate === 0：连定时器都不创建 */
  enabled: boolean;
  /** 归一化后的条/分钟（整数 0~60） */
  rate: number;
  /** 最小请求间隔（毫秒）；0 表示关闭 */
  intervalMs: number;
  /** 探测周期（毫秒）；0 表示关闭 */
  tickMs: number;
}

/** 把任意来源的频率值归一化到合法区间（非法值回退默认 2，0 是合法值） */
export function normalizeSpeakRate(n?: number | null): number {
  if (n === undefined || n === null) return SPEAK_RATE_DEFAULT;
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return SPEAK_RATE_DEFAULT;
  return Math.min(SPEAK_RATE_MAX, Math.max(SPEAK_RATE_MIN, v));
}

/**
 * 由频率派生完整调度方案。
 * 渲染层与主进程共用本函数 ⇒ 护栏与调度不可能漂移（PRD R3-AC15「同源派生」）。
 */
export function deriveLineSchedule(n?: number | null): LineSchedule {
  const rate = normalizeSpeakRate(n);
  if (rate <= 0) return { enabled: false, rate: 0, intervalMs: 0, tickMs: 0 };
  // 下限 1000ms：任何频率都不允许突破"每秒最多一条"，否则 60 条/分会被算成 60000/60=1000 之外的值
  const intervalMs = Math.max(LINE_MIN_INTERVAL_MS, Math.round(60000 / rate));
  const tickMs = Math.min(15000, Math.max(500, Math.round(intervalMs / 4)));
  return { enabled: true, rate, intervalMs, tickMs };
}

/** 由角色配置派生调度方案（角色级 speakRate 缺省 ⇒ 2 条/分） */
export function deriveLineScheduleForCharacter(c?: { speakRate?: number } | null): LineSchedule {
  return deriveLineSchedule(c?.speakRate);
}
