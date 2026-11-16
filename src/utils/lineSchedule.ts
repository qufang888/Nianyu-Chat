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
 *   rate = clamp(n ?? 2, 0, 60)（保留小数精度，不 round）
 *   rate === 0        → 完全不主动说话（连调度器都不创建）
 *   intervalMs = max(1000, round(60000 / rate))   // 最小请求间隔 = 探测判定的唯一依据
 *   tickMs     = clamp(round(intervalMs / 4), 500, 15000)  // 只负责"到点检查"，本身不产生请求
 *
 * v3.0.4 变更（多时间单位）：
 * - 用户可在 UI 选择「分钟 / 小时 / 天」三种单位，但**存储真源仍是条/分钟**（单字段），
 *   单位只是视图层的换算：每小时 N 条 = N/60 条/分，每天 N 条 = N/1440 条/分。
 * - 因此 normalizeSpeakRate 必须**保留小数**：每天 1 条 = 1/1440 ≈ 0.000694444 条/分，
 *   若继续 Math.round 会被抹成 0（=关闭）。精度保留 9 位小数（1e-9 条/分 ≈ 每 1.9 年 1 条，远超需求），
 *   同时保证「每天 1 条」派生出的间隔精确到 86400000ms（12 位时误差 <1ms）。
 * - 派生公式不变：60000 / 0.000694 ≈ 86400000ms（每天 1 条），tickMs 仍钳在 ≤15s，
 *   调度器用 tickMs 心跳 + 时间戳判定，不会把 86400000 直接交给 setTimeout（无 32 位溢出）。
 */

/** 频率下限：0 = 完全不主动说话 */
export const SPEAK_RATE_MIN = 0;
/** 频率上限：60 条/分钟（= 每秒 1 条，配合 1000ms 硬下限） */
export const SPEAK_RATE_MAX = 60;
/** 归一化精度：保留 12 位小数（见文件头 v3.0.4 说明） */
const RATE_PRECISION = 1_000_000_000_000;
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

/**
 * 把任意来源的频率值归一化到合法区间（非法值回退默认 2，0 是合法值）。
 * v3.0.4：保留小数精度——多单位换算需要表达「每天 1 条」这类 <1 条/分的值。
 */
export function normalizeSpeakRate(n?: number | null): number {
  if (n === undefined || n === null) return SPEAK_RATE_DEFAULT;
  const raw = Number(n);
  if (!Number.isFinite(raw)) return SPEAK_RATE_DEFAULT;
  const v = Math.round(raw * RATE_PRECISION) / RATE_PRECISION;
  return Math.min(SPEAK_RATE_MAX, Math.max(SPEAK_RATE_MIN, v));
}

// ===== v3.0.4：多时间单位（分钟 / 小时 / 天）=====
// 单位只作视图层换算；存储真源恒为「条/分钟」（DesktopCharacter.speakRate）。

/** 用户可选的时间单位；缺省 'min' 保证存量数据行为不变 */
export type SpeakRateUnit = 'min' | 'hour' | 'day';

/** 每种单位对应的「1 单位 = 多少分钟」换算系数 */
export const UNIT_MINUTES: Record<SpeakRateUnit, number> = {
  min: 1,
  hour: 60,
  day: 1440,
};

/** 单位合法性兜底：任何非法值回退 'min' */
export function normalizeSpeakRateUnit(u?: string | null): SpeakRateUnit {
  return u === 'hour' || u === 'day' ? u : 'min';
}

/** 把「每单位 N 条」换算成「条/分钟」（存储真源），并做精度归一 */
export function rateToPerMinute(value: number, unit: SpeakRateUnit): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return SPEAK_RATE_DEFAULT;
  return normalizeSpeakRate(Math.round((raw / UNIT_MINUTES[normalizeSpeakRateUnit(unit)]) * RATE_PRECISION) / RATE_PRECISION);
}

/**
 * 把「条/分钟」真源换算成某单位下的展示值（四舍五入到整数，便于滑块整数档位）。
 * 例：2 条/分 → hour 档 120、day 档 2880。
 */
export function rateForUnit(perMinute: number, unit: SpeakRateUnit): number {
  const v = normalizeSpeakRate(perMinute);
  return Math.round(v * UNIT_MINUTES[normalizeSpeakRateUnit(unit)]);
}

/**
 * 某单位下滑块的范围上界（整数档位）。
 * - min 档 60（= 每秒 1 条，硬下限约束）；
 * - hour 档 3600、day 档 86400（均由 60 条/分 × 换算系数派生，保证「显示值 = 实际值」）。
 */
export function rateMaxForUnit(unit: SpeakRateUnit): number {
  return SPEAK_RATE_MAX * UNIT_MINUTES[normalizeSpeakRateUnit(unit)];
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
