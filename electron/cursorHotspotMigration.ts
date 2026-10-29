/**
 * cursorHotspotMigration —— 动态光标热点单位的存量迁移（v2.3.126 重做）
 * ---------------------------------------------------------------------------
 * **为什么单独成文件**：迁移逻辑必须**可被校验脚本直接执行**（行为级断言，
 * 而不只是源码正则匹配）。electron/db.ts 依赖 electron / skills / src-types，
 * 无法在纯 Node 下加载；把纯逻辑抽到这里后，db.ts 只负责调用与落盘，
 * scripts/verify-cursor-engine.mjs 则可直接转译执行本文件 —— 与
 * electron/cursorCoverState.ts 的做法完全一致。
 *
 * **背景**：旧实现把 hotspotX/hotspotY 存成「28 像素基础尺寸下的绝对像素偏移」，
 * 这套语义只对内置 512×512 的 cursor.png 成立 —— 用户换成自己上传的图后，
 * 热点彻底失准。新语义改为「**比例**」（相对图像自身宽/高，0~1），
 * 与图像原始分辨率、cursorSize 均无关。
 *
 * **幂等**：换算完成后写入 hotspotSpace='ratio'，下次启动若 hotspotSpace !== 'ratio'
 * 才执行迁移 —— 因此绝不会重复换算（否则第二次启动比例会被再除一次 28）。
 */

/** 迁移目标：只需 customCursor 上的这几个字段 */
export interface CursorHotspotMigrationTarget {
  hotspotX?: number;
  hotspotY?: number;
  hotspotSpace?: 'ratio';
  trailMaxLength?: number;
  maxParticles?: number;
}

/** 迁移函数接受的最小宿主结构 */
export interface CursorHotspotMigrationHost {
  customCursor?: CursorHotspotMigrationTarget;
}

/** 旧语义「28 基准尺寸」的基准边长（像素） */
export const LEGACY_HOTSPOT_BASE_SIZE = 28;
/** 旧默认值 0.44（已知错值：把箭头尖端误测为 8/512） */
export const LEGACY_HOTSPOT_WRONG_VALUE = 0.44;
/** 修正后的旧语义值（35/512*28，cursor.png 箭头尖端实测值） */
export const LEGACY_HOTSPOT_FIXED_VALUE = 1.9141;
/** 旧版拖尾点位上限 */
export const LEGACY_TRAIL_MAX_LENGTH = 10;
/** 旧版粒子数上限 */
export const LEGACY_MAX_PARTICLES = 8;
/** 新版拖尾点位上限 */
export const NEW_TRAIL_MAX_LENGTH = 24;
/** 新版粒子上限 */
export const NEW_MAX_PARTICLES = 64;
/** 判定「旧错值」的容差（覆盖浮点写入误差） */
export const LEGACY_TOLERANCE = 0.001;

/**
 * 把「28 基准像素」的热点换算成「比例」语义（原地修改 settings）。
 *
 * 步骤（顺序不能颠倒）：
 *   1) hotspotX ≈ 0.44（旧错值）→ 先改写为 1.9141；
 *   2) hotspotX /= 28、hotspotY /= 28（像素 → 比例）；
 *   3) 写入 hotspotSpace='ratio' 标记已完成换算。
 *
 * 顺带把拖尾/粒子上限提到新引擎硬上限（旧默认 10 / 8 → 新默认 24 / 64）：
 * 只在用户**仍保留旧默认值**时才提升（说明用户没手动调过），自定义过的值一律尊重。
 *
 * @returns true = 本次确实做了迁移（调用方需要把结果落盘）
 */
export function migrateCursorHotspot(settings: CursorHotspotMigrationHost): boolean {
  const c = settings.customCursor;
  if (!c) return false;
  // 已经换算过 → 直接返回（幂等）
  if (c.hotspotSpace === 'ratio') return false;

  // 1) 旧默认错值 0.44 → 实测正确值 1.9141
  if (typeof c.hotspotX === 'number' && Math.abs(c.hotspotX - LEGACY_HOTSPOT_WRONG_VALUE) < LEGACY_TOLERANCE) {
    c.hotspotX = LEGACY_HOTSPOT_FIXED_VALUE;
  }
  // 2) 28 基准像素 → 比例
  if (typeof c.hotspotX === 'number') c.hotspotX = c.hotspotX / LEGACY_HOTSPOT_BASE_SIZE;
  if (typeof c.hotspotY === 'number') c.hotspotY = c.hotspotY / LEGACY_HOTSPOT_BASE_SIZE;

  // 3) 标记已完成换算（下次启动不再重复换算）
  c.hotspotSpace = 'ratio';

  // 4) 拖尾/粒子上限提升到新引擎硬上限（仅当用户仍用旧默认值时）
  if (typeof c.trailMaxLength === 'number' && c.trailMaxLength === LEGACY_TRAIL_MAX_LENGTH) {
    c.trailMaxLength = NEW_TRAIL_MAX_LENGTH;
  }
  if (typeof c.maxParticles === 'number' && c.maxParticles === LEGACY_MAX_PARTICLES) {
    c.maxParticles = NEW_MAX_PARTICLES;
  }

  return true;
}
