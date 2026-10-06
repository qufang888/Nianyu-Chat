/**
 * 统计页人物排行排序（v2.3.94 需求 11 · 板块二 / 板块三共用）
 * ============================================================================
 * 用户明确指定的排序铁律（逐条实现，见 sortRows 的比较器）：
 *
 *   按「好感度」排：
 *     1. 好感度高的在前；
 *     2. 好感度相同 → **陪伴时间最长的优先**；
 *     3. 两者都相同 → 名称字母 **a→z** 从上到下。
 *
 *   按「陪伴时间」排：
 *     1. 陪伴时间长的在前；
 *     2. 陪伴时间相同 → **好感度高的优先**；
 *     3. 两者都相同 → 名称字母 **a→z** 从上到下。
 *
 * 名称比较用 `localeCompare` 的中英文混排口径（`zh` 环境下按拼音、`en` 下按字母），
 * 但为保证「A→Z」在任何语言下都稳定，先做一次不区分大小写的规范化（normalizeText），
 * 再退化为逐码点比较 —— 这样 "Alice" 与 "alice" 不会被当作两个不同的排序结果乱序跳动。
 */
import { normalizeText } from './fuzzySearch';

/** 排序标准 */
export type RankMode = 'affinity' | 'companion';

/** 排行中的一行（板块二：好感度 + 陪伴时间；板块三：最喜爱人物） */
export interface RankRow {
  roleId: string;
  name: string;
  avatar: string;
  /** 好感度（0~100） */
  affinity: number;
  /** 陪伴时长（毫秒） */
  companionMs: number;
  /** 消耗 Token */
  tokens: number;
  /** 消息数 */
  messages: number;
  /** 心情（可选） */
  mood: string;
  /** 关系（可选） */
  relation: string;
}

/** 名称 A→Z 比较器（大小写不敏感；同分同名时按 roleId 兜底，保证全序、无随机抖动） */
function byName(a: RankRow, b: RankRow): number {
  const na = normalizeText(a.name);
  const nb = normalizeText(b.name);
  if (na < nb) return -1;
  if (na > nb) return 1;
  // 同名（大小写/全半角差异）时用 roleId 兜底，避免 sort 结果依赖引擎稳定性
  return a.roleId < b.roleId ? -1 : a.roleId > b.roleId ? 1 : 0;
}

/**
 * 按用户指定的规则排序（**返回新数组**，不改入参）。
 *
 * @param rows  待排序的行
 * @param mode 排序标准：'affinity' 按好感度 / 'companion' 按陪伴时间
 */
export function sortRows(rows: readonly RankRow[], mode: RankMode): RankRow[] {
  const list = rows.slice();
  if (mode === 'affinity') {
    list.sort((a, b) => {
      if (b.affinity !== a.affinity) return b.affinity - a.affinity; // 好感度降序
      if (b.companionMs !== a.companionMs) return b.companionMs - a.companionMs; // 同分 → 陪伴久者优先
      return byName(a, b); // 都相同 → 名称 a→z
    });
  } else {
    list.sort((a, b) => {
      if (b.companionMs !== a.companionMs) return b.companionMs - a.companionMs; // 陪伴时长降序
      if (b.affinity !== a.affinity) return b.affinity - a.affinity; // 同分 → 好感度高者优先
      return byName(a, b); // 都相同 → 名称 a→z
    });
  }
  return list;
}

/**
 * Token 消耗排名（板块一 · 饼图 / 完整榜单共用）。
 *
 * 排序铁律（用户原话）：**Token 消耗相同的按名称字母顺序 A→Z 从上往下排。**
 * 注意这里的 A→Z 是**唯一**的 tiebreak（不像板块二那样还要看陪伴时间/好感度），
 * 故刻意不调用 sortRows。
 */
export function sortByTokensDesc(rows: readonly RankRow[]): RankRow[] {
  return rows.slice().sort((a, b) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    return byName(a, b);
  });
}

/** 饼图扇区（含「其它」聚合项） */
export interface PieSlice {
  /** 稳定 key：人物为 roleId，聚合项固定为 '__other__' */
  key: string;
  name: string;
  tokens: number;
  /** 占比 0~1 */
  ratio: number;
  /** 扇区颜色（CSS 颜色串） */
  color: string;
  /** 是否为「其它」聚合项 */
  isOther: boolean;
}

/** 占比低于该阈值的扇区全部并入「其它」（用户需求：占比 < 10% 的全部并入「其他」一项） */
export const OTHER_THRESHOLD = 0.1;

/**
 * 由排行数据生成饼图扇区序列。
 *
 * 规则：
 *   - 先按 Token 降序 + 名称 A→Z 排好（{@link sortByTokensDesc}）；
 *   - 累计占比 < 10% 的项并入「其它」（若「其它」自己都不足 10% 也照样单列，
 *     这是用户明确要求的固定聚合项，不做二次合并）；
 *   - 全部项都 ≥10% 时不产生「其它」；
 *   - 数据为空时返回空数组（调用方据此渲染空态，**不画空饼**）。
 *
 * @param rows      已含 token 的排行数据（不必预先排序）
 * @param palette   至少 1 个颜色的调色板（由 buildPiePalette 生成，跟随主题）
 * @param otherName 「其它」项的展示名（走 i18n，由调用方传入）
 */
export function buildPieSlices(
  rows: readonly RankRow[],
  palette: readonly string[],
  otherName: string
): PieSlice[] {
  const sorted = sortByTokensDesc(rows).filter((r) => r.tokens > 0);
  if (sorted.length === 0) return [];
  const total = sorted.reduce((s, r) => s + r.tokens, 0);
  if (total <= 0) return [];

  const main: PieSlice[] = [];
  let otherTokens = 0;
  let otherCount = 0;
  for (const r of sorted) {
    const ratio = r.tokens / total;
    if (ratio < OTHER_THRESHOLD) {
      otherTokens += r.tokens;
      otherCount += 1;
      continue;
    }
    main.push({ key: r.roleId, name: r.name, tokens: r.tokens, ratio, color: '', isOther: false });
  }

  // 调色板按名次分配（名次靠前的人物拿主色，之后拿派生色）
  main.forEach((s, i) => {
    s.color = palette[i % Math.max(1, palette.length)] || palette[0] || 'var(--color-primary)';
  });

  if (otherTokens > 0) {
    main.push({
      key: '__other__',
      name: otherCount > 1 ? `${otherName}（${otherCount}）` : otherName,
      tokens: otherTokens,
      ratio: otherTokens / total,
      color: '', // 由调用方用 otherSliceColor() 覆盖
      isOther: true,
    });
  }
  return main;
}