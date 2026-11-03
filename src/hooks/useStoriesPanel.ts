import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

/**
 * 剧情节点侧栏的「悬停意图（hover-intent）+ 垂直拖动」通用 Hook。
 * 主窗（ChatWindow）与小窗（MiniChat）共用，保证两处行为完全一致。
 *
 * ── 悬停意图状态机（与用户诉求一一对应）──
 *   1. 鼠标移到「开关」(tab) 上 → 面板弹出（peek）；
 *   2. 若 STORIES_PEEK_MS(1500ms) 内始终未移入面板 → 自动收回；
 *   3. 移入面板 → 取消 peek、标记 entered=true、保持展开；
 *   4. 移出整个侧栏：
 *        - 曾移入面板(entered) → 立即收回（不用等）；
 *        - 从未移入面板      → 交给 peek 计时（已在 onTabEnter 启动），1.5s 后收回。
 *   编辑节点名称期间（isEditing=true）不触发收回，避免改名时被误关。
 *
 * ── 垂直拖动 ──
 *   抓住 tab 上下拖动，调整侧栏的 `top`；`bottom` 由边界地标动态计算，
 *   始终停在「输入框上方图标排」顶线（绝不越过该线，贴着聊天对话界面）。
 *   `top` 被钳制在 [顶界线+间隙, 底界线-最短高] 内：
 *     - 上界 = 「主动消息/关系值」行（chat-header / mini-header）底线以下；
 *     - 下界 = 输入框上方图标排（composer .toolbar / mini-toolbar）顶线以上。
 *   拖动期间不自动缩回（drag.active 守卫所有收回路径）。
 *
 *   坐标系：top/bottom 是相对 offsetParent 的，故地标与边界均换算到 offsetParent
 *   的 getBoundingClientRect，确保与 CSS 的 top/bottom 同一参照系。
 *
 * 动画：面板显隐沿用 index.css `.stories-panel` 的过渡（抽屉式左滑 + 淡入淡出，受
 * 「动效总开关 / 分组」控制）；本 Hook 只切换 `.open` 类、计时器与 top/bottom，不触碰过渡。
 */
export const STORIES_PEEK_MS = 1500; // 悬停开关后若始终未移入面板，自动收回的时长

// 边界地标候选选择器（主窗 / 小窗类名不同，按顺序匹配第一个存在的）
const TOP_BOUND_SELECTORS = ['.chat-header', '.mini-header', '[data-stories-top-bound]'];
const BOTTOM_BOUND_SELECTORS = [
  '.composer .toolbar',
  '.composer',
  '.mini-toolbar',
  '.mini-composer',
  '[data-stories-bottom-bound]',
];

const TOP_GAP = 6; // 面板顶距「主动消息/关系值」行底线的安全间隙
const BOTTOM_GAP = 4; // 面板底距输入框上方图标排顶线的安全间隙
const MIN_PANEL_H = 120; // 面板最短高度，避免拖成一条线

export interface StoriesPanelApi {
  /** 面板是否展开 */
  open: boolean;
  /** 侧栏 top 偏移（px，相对 offsetParent） */
  top: number;
  /** 侧栏 bottom 偏移（px，相对 offsetParent） */
  bottom: number;
  /** 是否正在拖动 */
  dragging: boolean;
  /** 侧栏根元素 ref（调用方挂到 .stories） */
  storiesRef: RefObject<HTMLDivElement>;
  /** tab 悬停：弹出 + 启动 peek 计时 */
  onTabEnter: () => void;
  /** 面板悬停：取消 peek + 保持展开（标记已进入面板） */
  onPanelEnter: () => void;
  /** 侧栏整体进入：保持展开（无挂起收回处理） */
  onWrapperEnter: () => void;
  /** 侧栏整体离开：曾进面板→立即收；未进→交给 peek */
  onWrapperLeave: () => void;
  /** 抓 tab 按下：启动垂直拖动（仅左键） */
  onTabPointerDown: (e: ReactPointerEvent) => void;
  /** 直接设置展开态（如改名结束后的即时收起） */
  setOpen: (v: boolean) => void;
}

function findBound(doc: Document, selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (el instanceof HTMLElement) return el;
  }
  return null;
}

export function useStoriesPanel(isEditing: boolean): StoriesPanelApi {
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(64);
  const [bottom, setBottom] = useState(120); // 兜底值，mount 后由地标动态计算
  const [dragging, setDragging] = useState(false);
  const storiesRef = useRef<HTMLDivElement>(null);
  const peekTimer = useRef<number | null>(null);
  const drag = useRef<{ active: boolean; startY: number; startTop: number }>({
    active: false,
    startY: 0,
    startTop: 64,
  });
  // 当前边界（拖动时复用，避免每次 move 重查布局）
  const bounds = useRef({ minTop: 8, maxTop: 100000, bottomOffset: 120 });
  // 始终持有最新值，供计时器 / 全局监听回调读取
  const isEditingRef = useRef(isEditing);
  const enteredRef = useRef(false); // 本次展开期间是否曾移入面板

  const clearPeek = useCallback(() => {
    if (peekTimer.current !== null) {
      window.clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
  }, []);

  /** 收起：复位 entered 标记 */
  const doClose = useCallback(() => {
    enteredRef.current = false;
    setOpen(false);
  }, []);

  /** 计算上下边界 + 动态 bottom（基于 offsetParent 坐标系） */
  const recomputeBounds = useCallback(() => {
    const el = storiesRef.current;
    if (!el) return;
    const doc = el.ownerDocument;
    const op = (el.offsetParent as HTMLElement | null) ?? doc.documentElement;
    const opRect = op.getBoundingClientRect();
    const h = op.clientHeight || doc.documentElement.clientHeight;

    // 顶部边界：主动消息/关系值行（chat-header）底线以下
    const topEl = findBound(doc, TOP_BOUND_SELECTORS);
    const topBoundY = topEl ? topEl.getBoundingClientRect().bottom - opRect.top : 0;
    const minTop = Math.max(0, topBoundY + TOP_GAP);

    // 底部边界：输入框上方图标排（composer .toolbar）顶线以上
    const botEl = findBound(doc, BOTTOM_BOUND_SELECTORS);
    const bottomLineY = botEl ? botEl.getBoundingClientRect().top - opRect.top : h - 120;
    const bottomOffset = Math.max(0, h - bottomLineY + BOTTOM_GAP);
    const maxTop = Math.max(minTop + MIN_PANEL_H, bottomLineY - MIN_PANEL_H);

    bounds.current = { minTop, maxTop, bottomOffset };
    setBottom(bottomOffset);
    setTop((t) => Math.min(maxTop, Math.max(minTop, t)));
  }, []);

  /** 启动 peek：PEEK_MS 后收回（拖动 / 编辑中不收） */
  const schedulePeek = useCallback(() => {
    clearPeek();
    peekTimer.current = window.setTimeout(() => {
      peekTimer.current = null;
      if (drag.current.active) return; // 拖动中不收
      if (isEditingRef.current) return; // 编辑中不收
      doClose();
    }, STORIES_PEEK_MS);
  }, [clearPeek, doClose]);

  /** tab 悬停：弹出 + 启动 peek */
  const onTabEnter = useCallback(() => {
    clearPeek();
    setOpen(true);
    schedulePeek();
  }, [clearPeek, schedulePeek]);

  /** 面板悬停：取消 peek + 保持展开（标记已进入面板 → 离开即立即收回） */
  const onPanelEnter = useCallback(() => {
    clearPeek();
    enteredRef.current = true;
    setOpen(true);
  }, [clearPeek]);

  /** 侧栏整体离开 */
  const onWrapperLeave = useCallback(() => {
    if (drag.current.active) return; // 拖动中不收
    if (isEditingRef.current) return; // 编辑中不收
    if (enteredRef.current) {
      doClose(); // 曾移入面板 → 立即收回（不用等）
      return;
    }
    // 从未移入面板：交给 peek 计时（已在 onTabEnter 启动），无需重复
  }, [doClose]);

  /** 侧栏整体进入：保持展开（无挂起收回需要处理） */
  const onWrapperEnter = useCallback(() => {
    // 进入侧栏无需额外动作：peek 仅在未移入面板时生效，进入后由 onPanelEnter 接管
  }, []);

  /** 抓 tab 拖动（仅左键） */
  const onTabPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      clearPeek(); // 拖动期间不触发 peek 收回
      recomputeBounds();
      drag.current = { active: true, startY: e.clientY, startTop: top };
      setDragging(true);
      const el = e.currentTarget as HTMLElement;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 部分环境不支持 pointer capture，window 监听兜底 */
      }
    },
    [top, recomputeBounds]
  );

  // 全局拖动监听（pointermove / pointerup）
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!drag.current.active) return;
      const { minTop, maxTop } = bounds.current;
      const next = Math.min(
        maxTop,
        Math.max(minTop, drag.current.startTop + (e.clientY - drag.current.startY))
      );
      setTop(next);
    };
    const onUp = (e: PointerEvent) => {
      if (!drag.current.active) return;
      drag.current.active = false;
      setDragging(false);
      const rect = storiesRef.current?.getBoundingClientRect();
      const inside =
        !!rect &&
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (!inside) {
        if (enteredRef.current) {
          if (!isEditingRef.current) doClose(); // 拖完松开在面板外且进过面板 → 立即收
        } else {
          schedulePeek(); // 拖完松开在面板外且没进过面板 → 1.5s 收
        }
      } else if (!enteredRef.current) {
        schedulePeek(); // 松手仍在开关上、没进过面板 → 1.5s 收
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [doClose, schedulePeek]);

  // mount：首次计算边界；resize：布局变化时重算
  useEffect(() => {
    recomputeBounds();
    const onResize = () => recomputeBounds();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [recomputeBounds]);

  // 展开时刷新边界（切换聊天 / 输入栏高度变化等）
  useEffect(() => {
    if (open) recomputeBounds();
  }, [open, recomputeBounds]);

  // 同步最新 isEditing 到 ref（供计时器回调读取）
  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);

  // 卸载清理计时器，避免对已卸载组件 setState
  useEffect(
    () => () => {
      clearPeek();
    },
    [clearPeek]
  );

  return {
    open,
    top,
    bottom,
    dragging,
    storiesRef,
    onTabEnter,
    onPanelEnter,
    onWrapperEnter,
    onWrapperLeave,
    onTabPointerDown,
    setOpen,
  };
}

export default useStoriesPanel;
