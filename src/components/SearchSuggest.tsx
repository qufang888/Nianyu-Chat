import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRetract } from '../hooks/useRetract';
import { useI18n } from '../i18n/I18nContext';
import { MAX_SUGGESTIONS, highlightParts, rankCandidates, type Searchable } from '../utils/fuzzySearch';

/**
 * SearchSuggest —— 全局搜索候选面板（需求 12「唯一真源」组件）
 * ============================================================================
 * 用户铁律（对念语所有搜索框生效）：
 *   1. 候选项**最多展示 5 个** → 本组件把 `max`（默认 {@link MAX_SUGGESTIONS}）解释为
 *      **同时可见的行数**，面板 `max-height = max * ITEM_HEIGHT`，超出部分由**滚动条**查看；
 *   2. **模糊搜索 + 按关联程度排序** → 排序完全交给 `fuzzySearch.rankCandidates`
 *      （相关度降序 → 标签短优先 → 字母 A→Z），调用方不要再自己 filter；
 *   3. 点击候选 → `onPick(item)`，**跳转与高亮闪动由调用方负责**（本组件只负责选中态）；
 *   4. 键盘 ↑ / ↓ 移动高亮、Enter 选中、Esc 关闭（Esc 会 `stopPropagation`，
 *      避免连带关掉外层弹窗，与 ComboBox/SelectMenu 行为一致）；
 *   5. portal 到 body + fixed 定位 → **不会被父容器裁剪**，天然带滚动条。
 *
 * 之所以自己接管键盘（document 级 keydown）而不是让调用方在 input 上写 onKeyDown：
 * 面板打开时 Enter/↑↓ 的语义必须由面板说了算，若两边都监听会「回车触发两次跳转」。
 * 调用方只需在 input 上保留 onChange / onFocus 即可。
 */

/** 单行高度（px），须与 index.css `.search-suggest-item` 的高度对齐 */
const ITEM_HEIGHT = 34;
/** 面板上下内边距合计（px），须与 index.css `.search-suggest` 的 padding 一致 */
const PANEL_PADDING = 8;
/** 实际渲染的候选上限 = max * 该倍数：既保证「可见 5 行」，又让滚动条能翻到更多 */
const RENDER_FACTOR = 6;

export interface SearchSuggestProps<T> {
  /** 是否展开（一般由「输入框有焦点 + 有查询词」驱动） */
  open: boolean;
  /** 查询词（内部做模糊匹配与排序） */
  query: string;
  /** 候选全集（**不要**由调用方预先 filter，否则相关度排序会失效） */
  items: readonly T[];
  /** 取候选的可搜索文本；缺省要求候选本身是 `{label, keywords?}` */
  getText?: (item: T) => Searchable;
  /** 选中候选（调用方在此做跳转 + 高亮闪动） */
  onPick: (item: T) => void;
  /** 关闭回调（点击面板外 / Esc） */
  onClose?: () => void;
  /** 同时可见的行数，默认 5（用户铁律） */
  max?: number;
  /** 锚点元素（通常是输入框）；不传则不渲染面板 */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** 无结果时的提示文案 */
  emptyHint?: string;
  /** 空查询时是否仍展开（默认 false：搜索框空着不该弹候选） */
  showWhenEmpty?: boolean;
  /** 自定义行内容；默认按 `getText(item).label` + 关键词高亮渲染 */
  renderItem?: (item: T, ctx: { query: string; active: boolean }) => React.ReactNode;
  /** 自定义行 key，缺省用索引 */
  itemKey?: (item: T, index: number) => React.Key;
}

export function SearchSuggest<T>({
  open,
  query,
  items,
  getText,
  onPick,
  onClose,
  max = MAX_SUGGESTIONS,
  anchorRef,
  emptyHint,
  showWhenEmpty = false,
  renderItem,
  itemKey,
}: SearchSuggestProps<T>) {
  const { t } = useI18n();
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; below: boolean }>({
    top: 0, left: 0, width: 0, below: true,
  });
  const panelRef = useRef<HTMLDivElement>(null);
  // getText / onPick / onClose 常由调用方在渲染体里就地创建（每次渲染都是新函数），
  // 若直接进useMemo/effect 依赖，会让排序与键盘监听每帧重算重挂。
  // 这里用 ref 兜一层：依赖里只放真正影响结果的 query/items。
  const getTextRef = useRef(getText);
  getTextRef.current = getText;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const hasQuery = query.trim().length > 0;
  const shouldShow = open && (hasQuery || showWhenEmpty);

  // 相关度排序（唯一真源）：不截断，截断交给下面的 slice
  const ranked = useMemo(
    () => rankCandidates(query, items, (it) => (getTextRef.current ? getTextRef.current(it) : (it as unknown as Searchable))),
    [query, items]
  );
  const total = ranked.length;
  // 「最多展示 5 个」= 可见窗口 5 行；为了滚动条能翻到其余候选，实际渲染更多
  const shown = useMemo(
    () => ranked.slice(0, Math.max(max, 1) * RENDER_FACTOR).map((r) => r.item),
    [ranked, max]
  );

  // 关闭时先播缩入动画再卸载（与 SelectMenu / ComboBox 同一模式）
  const panelUi = useRetract(shouldShow && shown.length > 0 ? rect : null);

  const reposition = useCallback(() => {
    const el = anchorRef?.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const estH = Math.min(Math.max(shown.length, 1), max) * ITEM_HEIGHT + PANEL_PADDING;
    // 下方空间足够则向下展开，否则向上
    const below = r.bottom + estH <= window.innerHeight || r.top > window.innerHeight - r.bottom;
    setRect({ top: r.bottom, left: r.left, width: r.width, below });
  }, [anchorRef, shown.length, max]);

  // 展开时定位；锚点失焦（如 Tab 走到别的输入框）也要收起，
// 否则面板会「开着但看不见输入焦点在哪」，此时 Enter 仍会被本组件抢走
  useLayoutEffect(() => {
    if (!shouldShow) return;
    reposition();
    const el = anchorRef?.current;
    if (!el) return;
    const onBlur = () => onCloseRef.current?.();
    el.addEventListener('blur', onBlur);
    return () => el.removeEventListener('blur', onBlur);
  }, [shouldShow, anchorRef, reposition]);

  // 查询词变化 → 高亮回到首项
  useEffect(() => { setActive(0); }, [query]);

  // 点击面板外关闭 + 滚动/缩放重定位
  useEffect(() => {
    if (!shouldShow) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef?.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      onCloseRef.current?.();
    };
    const onMove = () => reposition();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [shouldShow, anchorRef, reposition]);

  // 键盘：↑↓ 移动、Enter 选中、Esc 关闭（面板打开期间由本组件独占这几个键）
  useEffect(() => {
    if (!shouldShow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // 不冒泡：避免连带关掉外层弹窗
        onCloseRef.current?.();
      } else if (e.key === 'ArrowDown') {
        if (!shown.length) return;
        e.preventDefault();
        setActive((i) => (shown.length ? (i + 1) % shown.length : 0));
      } else if (e.key === 'ArrowUp') {
        if (!shown.length) return;
        e.preventDefault();
        setActive((i) => (shown.length ? (i - 1 + shown.length) % shown.length : 0));
      } else if (e.key === 'Enter') {
        if (!shown.length) return;
        e.preventDefault();
        onPickRef.current(shown[Math.min(active, shown.length - 1)]);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shouldShow, shown, active]);

  // 键盘移动时把高亮项滚入可视区（面板自身滚动）
  useEffect(() => {
    if (!panelUi.shown) return;
    const panel = panelRef.current;
    if (!panel) return;
    const item = panel.querySelector(`[data-idx="${active}"]`) as HTMLElement | null;
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [active, panelUi.shown]);

  if (!anchorRef || (!shouldShow && !panelUi.shown)) return null;

  const rows = panelUi.shown && shown.length > 0 ? (
    shown.map((item, i) => (
      <div
        key={itemKey ? itemKey(item, i) : i}
        data-idx={i}
        role="option"
        aria-selected={i === active}
        className={`search-suggest-item${i === active ? ' active' : ''}`}
        onMouseEnter={() => setActive(i)}
        onMouseDown={(e) => {
          e.preventDefault(); // 保持输入框焦点，避免 blur 抢先关闭
          onPick(item);
        }}
      >
        {renderItem
          ? renderItem(item, { query, active: i === active })
          : highlightParts(
              getTextRef.current ? getTextRef.current(item).label : String((item as any)?.label ?? item),
              query
            ).map((p, k) => (p.hit ? <mark key={k} className="search-hl">{p.text}</mark> : <React.Fragment key={k}>{p.text}</React.Fragment>))
        }
      </div>
    ))
  ) : null;

  // 空结果提示：无候选时用同一个外壳渲染（不参与缩入动画，直接出现）
  const emptyNode =
    shouldShow && shown.length === 0 ? (
      <div className="search-suggest-empty">{emptyHint ?? t('search.noResult')}</div>
    ) : null;

  return createPortal(
    <div
      ref={panelRef}
      className={`search-suggest${panelUi.leaving ? ' leaving' : ''}${panelUi.shown ? '' : ' empty'}`}
      role="listbox"
      aria-label={t('search.title')}
      style={{
        // 「最多展示 5 个」：面板高度锁定为 max 行，多余候选靠滚动条查看
        maxHeight: Math.max(max, 1) * ITEM_HEIGHT + PANEL_PADDING,
        ...(panelUi.shown
          ? panelUi.shown.below
            ? { top: panelUi.shown.top + 2, left: panelUi.shown.left, width: panelUi.shown.width }
            : { bottom: window.innerHeight - panelUi.shown.top + 2, left: panelUi.shown.left, width: panelUi.shown.width }
          : { top: rect.top + 2, left: rect.left, width: rect.width }),
      }}
    >
      {rows}
      {emptyNode}
      {total > shown.length && (
        <div className="search-suggest-foot" aria-hidden>
          {t('search.moreItems', { n: total - shown.length })}
        </div>
      )}
    </div>,
    document.body
  );
}

export default SearchSuggest;