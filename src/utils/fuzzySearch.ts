/**
 * 全局搜索规范 · 模糊搜索与候选项排序（需求 12）
 * ============================================================================
 * 用户硬性铁律（对念语软件所有搜索框生效）：
 *   1. 候选项**最多展示 5 个**（见 MAX_SUGGESTIONS）；
 *   2. 支持**模糊搜索**（不是简单 includes）；
 *   3. 按**关联程度**从上往下排（得分降序）；
 *   4. 点击候选项跳转到对应结果界面并高亮闪动（跳转由调用方负责）；
 *   5. 可以拉候选框旁的**滑动条**查看其余候选项（面板 CSS 自带 overflow-y: auto）。
 *
 * 本文件是「唯一真源」：所有搜索框都应走 `rankCandidates()`，
 * 不要各自写 `filter(o => o.includes(q))`——那会导致相关度排序失效、候选数失控。
 *
 * 打分档位（从高到低，同档再按下表的次序 tiebreak）：
 *   1000  完全相等（忽略大小写）
 *    900  前缀匹配（q 是 text 的开头）
 *    800  词首匹配（q 命中某个「分隔符之后」的开头，如 "tok" 命中 "gpt-token"）
 *    700  子串连续命中（q 整段连续出现在 text 中）
 *    600  子序列命中（q 的字符按顺序出现，允许夹字符数 = skip 惩罚）
 *    500  缩写命中（q 的首字母构成 text 各词首字母，如 "gm" 命中 "GPT Model"）
 *    100  全部字符都能在 text 中找到（乱序，仅作兜底）
 *      0  不命中
 */

/** 候选项默认最多展示条数（用户铁律：最多 5 个） */
export const MAX_SUGGESTIONS = 5;

/** 归一化：转小写 + 全角转半角 + 去除首尾空白。全角数字/字母/标点在搜索时不应与半角混淆。 */
export function normalizeText(s: string): string {
  if (!s) return '';
  // 全角 → 半角（SSE 全角区间 U+FF01-U+FF5E 对应 ASCII U+0021-U+007E，空格 U+3000 → U+0020）
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code === 0x3000) out += ' ';
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else out += ch;
  }
  return out.toLowerCase().trim();
}

/** 拆词：按非字母数字（含 CJK）切分。CJK 逐字成词，保证中文能按字模糊匹配。 */
function tokenize(norm: string): string[] {
  // 连续的 ASCII 字母数字算一个词；CJK 字符各自成一个词
  const tokens = norm.match(/[a-z0-9]+|[^\x00-\x7f]/g);
  return tokens || [];
}

/** 子序列匹配：q 的字符按序出现在 t 中。返回最小 skip 数，未命中返回 -1。 */
function subsequenceSkip(q: string, t: string): number {
  let ti = 0;
  let skips = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    skips += found - ti;
    ti = found + 1;
  }
  return skips;
}

/**
 * CJK 专用的**双向**子序列匹配。
 *
 * 为什么要单独做：汉字没有「词首」概念，用户脑子里想的顺序常常和文本里的顺序相反
 * （人名「王小明」，用户很可能只记得「明小」或「小明王」）。
 * 纯单向子序列只能命中「小明」→ 王小明，命中不了「明小」。
 * 这里额外做一次**反向**子序列（把 t 倒着走 q 的字符），两次任一命中即算命中，
 * 且反向命中时档位降一档（保证「顺向」始终优于「逆向」，正序命中才是更强的相关信号）。
 *
 * 只对含 CJK 的查询启用：纯 ASCII 查询做双向会引入大量误命中（"abc" 能反向命中 "cba" 之类），
 * 得不偿失。
 */
const hasCJK = (s: string): boolean => /[^\x00-\x7f]/.test(s);

function cjkReverseSkip(q: string, t: string): number {
  let ti = t.length - 1;
  let skips = 0;
  for (let qi = q.length - 1; qi >= 0; qi--) {
    const ch = q[qi];
    const found = t.lastIndexOf(ch, ti);
    if (found < 0) return -1;
    skips += ti - found;
    ti = found - 1;
  }
  return skips;
}

/**
 * CJK「无序子集」兜底：忽略顺序，只要求 q 的字符**全部出现**在 t 里。
 *
 * 存在的理由：双向贪心子序列仍有极限。例如人名「王小明」，用户只记得「王明小」
 * 或「明小」时，正向子序列（小在明之后）在文本里找不到，反向也因「王」占位而失败 ——
 * 但这显然都是真实用户会敲出来的查询。这里用「每个字符都能找到」的无序判定兜住，
 * 档位压到 460（低于一切有序匹配），保证它只在「有序全都不命中」时才兜底。
 *
 * ⚠️ 关键实现细节：必须**每次都从整个 t 里找**（不维护单调推进的 ti），
 * 否则「王小明」查「明小」时，明落在 index2 后就再也找不到「小」了 —— 这正是初版写错的地方。
 */
function cjkUnordered(q: string, t: string): number {
  const uniq = new Set(q);
  let skips = 0;
  for (const ch of uniq) {
    const found = t.indexOf(ch);
    if (found < 0) return -1;
    skips += found;
  }
  return skips;
}

/** 命中档位（数值越大越相关）。未命中返回 -1。 */
function hitTier(q: string, t: string): { tier: number; skip: number } {
  if (!q) return { tier: 1000, skip: 0 };
  if (t === q) return { tier: 1000, skip: 0 };
  if (t.startsWith(q)) return { tier: 900, skip: 0 };

  // 词首匹配：q 出现在某个 token 的开头
  const tokens = tokenize(t);
  if (tokens.some((tk) => tk.startsWith(q))) return { tier: 800, skip: 0 };

  if (t.includes(q)) {
    // 连续子串：位置越靠前越好（skip 记录距开头的距离，用于同档内排序）
    return { tier: 700, skip: t.indexOf(q) };
  }

  const skip = subsequenceSkip(q, t);
  if (skip >= 0) {
    // 子序列：跳字越少越好 → 降一档用 skip 拉开距离
    const penalty = skip <= 3 ? 0 : skip <= 8 ? 20 : 50;
    return { tier: 600 - penalty, skip };
  }

  // CJK 反向子序列：只对含中文的查询启用，且档位低于正序（见 cjkReverseSkip 注释）
  if (hasCJK(q)) {
    const rskip = cjkReverseSkip(q, t);
    if (rskip >= 0) {
      const penalty = rskip <= 3 ? 60 : rskip <= 8 ? 90 : 120;
      return { tier: 600 - penalty, skip: rskip };
    }
    // 双向都失败（文本头部/尾部有多余字符导致贪心对不齐）→ 无序子集兜底
    const uskip = cjkUnordered(q, t);
    if (uskip >= 0) return { tier: 460, skip: uskip };
  }

  // 缩写：q 首字母构成 tokens 各词首字母（"gm" → "GPT Model"）
  if (q.length >= 2) {
    const initials = tokens.map((tk) => tk[0]).join('');
    if (initials.startsWith(q) || initials.includes(q)) return { tier: 500, skip: 0 };
  }

  // 兜底：多词 AND（q 按空格拆开后每词都能命中）
  const qs = q.split(/\s+/).filter(Boolean);
  if (qs.length > 1 && qs.every((w) => t.includes(w))) return { tier: 400, skip: 0 };

  return { tier: -1, skip: 0 };
}

/**
 * 候选排序结果。
 * `score` 越大越靠前；`matched` 供调用方做关键词高亮（用 `highlightParts`）。
 */
export interface RankedCandidate<T> {
  item: T;
  score: number;
  /** 命中的查询词（归一化后），用于高亮 */
  matched: string;
}

/** 可直接参与排序的候选形状。`label` 是主匹配文本，`keywords` 是附加关键词。 */
export interface Searchable {
  /** 主文本：人名 / 聊天名 / 设置项名 */
  label: string;
  /** 附加关键词：拼音、别名、说明文字等，参与同档排序但不单独决定档位 */
  keywords?: string[];
}

/**
 * 对候选集排序（不截断）。
 *
 * 排序规则：得分降序 → 标签长度升序（同样相关时短的更可能是用户要找的）
 * → 标签字母/拼音升序（用户铁律：相同数值时按字母顺序 A→Z）。
 *
 * @param query   用户输入
 * @param items   候选数组（原始对象）
 * @param getText 从候选中取出可搜索文本；不传则要求候选本身是 `{label, keywords?}`
 */
export function rankCandidates<T>(
  query: string,
  items: readonly T[],
  getText?: (item: T) => Searchable
): RankedCandidate<T>[] {
  // 容错：调用方可能传入 undefined/null（数据尚未加载完、或过滤结果为空）。
  // 早于任何 items 访问兜住，否则下面 .map 会抛 "Cannot read properties of undefined"。
  if (!Array.isArray(items)) return [];
  const q = normalizeText(query);
  const textOf = getText || ((it: any) => ({ label: String(it?.label ?? it ?? ''), keywords: it?.keywords }));
  const all = items.map((item) => ({ item, s: textOf(item) || { label: '' } }));

  if (!q) {
    // 空查询：按标签 A→Z 稳定排序（铁律：同名/同分时按字母顺序）
    return all
      .map(({ item, s }) => ({ item, score: 0, matched: '', label: normalizeText(s.label) }))
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
      .map(({ item, score, matched }) => ({ item, score, matched }));
  }

  const scored: Array<RankedCandidate<T> & { len: number; label: string }> = [];
  for (const { item, s } of all) {
    const labelNorm = normalizeText(s.label);
    // 主文本与附加关键词取最高档
    let best = hitTier(q, labelNorm);
    let fromKeyword = false;
    for (const kw of s.keywords || []) {
      const k = hitTier(q, normalizeText(kw));
      if (k.tier > best.tier) { best = k; fromKeyword = true; }
    }
    if (best.tier < 0) continue;
    // 关键词命中略降权，保证「标题命中」永远排在「关键词命中」前面
    const score = best.tier * 1000 - Math.min(best.skip, 999) - (fromKeyword ? 100 : 0);
    scored.push({ item, score, matched: q, len: labelNorm.length, label: labelNorm });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.len !== b.len) return a.len - b.len;               // 同相关度：短的优先
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; // 同长度：字母 A→Z
  });
  return scored.map(({ item, score, matched }) => ({ item, score, matched }));
}

/**
 * 排序并截断到 `limit` 条（默认 5，用户铁律）。
 * 这是搜索框最常用的入口。
 */
export function suggest<T>(
  query: string,
  items: readonly T[],
  getText?: (item: T) => Searchable,
  limit: number = MAX_SUGGESTIONS
): T[] {
  return rankCandidates(query, items, getText)
    .slice(0, Math.max(0, limit))
    .map((r) => r.item);
}

/** 供调用方确认「是否有更多候选」以决定是否显示滚动条 / 「还有 N 项」提示 */
export function suggestWithCount<T>(
  query: string,
  items: readonly T[],
  getText?: (item: T) => Searchable,
  limit: number = MAX_SUGGESTIONS
): { items: T[]; total: number } {
  const ranked = rankCandidates(query, items, getText);
  return { items: ranked.slice(0, Math.max(0, limit)).map((r) => r.item), total: ranked.length };
}

/**
 * 把文本按查询词切成 [普通, 命中, 普通, 命中…]，供 <mark> 高亮。
 * 与 {@link rankCandidates} 共用归一化口径，避免「能搜到却不高亮」。
 */
export function highlightParts(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const original = text || '';
  const q = normalizeText(query);
  if (!q) return original ? [{ text: original, hit: false }] : [];

  // 优先按「完整查询词」高亮；命中不了再按空格分词逐个高亮
  const tries = [q, ...q.split(/\s+/).filter((w) => w.length > 0)].sort((a, b) => b.length - a.length);
  for (const needle of tries) {
    const parts = highlightByNeedle(original, needle);
    if (parts.some((p) => p.hit)) return parts;
  }
  return [{ text: original, hit: false }];
}

function highlightByNeedle(text: string, needle: string): Array<{ text: string; hit: boolean }> {
  const lower = text.toLowerCase();
  const out: Array<{ text: string; hit: boolean }> = [];
  let i = 0;
  let found = false;
  while (i < text.length) {
    const idx = lower.indexOf(needle, i);
    if (idx < 0) { out.push({ text: text.slice(i), hit: false }); break; }
    if (idx > i) out.push({ text: text.slice(i, idx), hit: false });
    out.push({ text: text.slice(idx, idx + needle.length), hit: true });
    found = true;
    i = idx + needle.length;
  }
  return found ? out.filter((p) => p.text.length > 0) : [];
}