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
 *   2. 若 PEEK_MS 内未移入面板 → 自动收回；
 *   3. 移入面板 → 取消 peek 计时，保持展开（一直弹出）；
 *   4. 移出整个侧栏 → CLOSE_MS 后自动收回。
 *   编辑节点名称期间（isEditing=true）不触发收回，避免改名时被误关。
 *
 * ── 垂直拖动 ──
 *   抓住 tab 上下拖动，调整侧栏的 `top`（bottom 固定 120px，始终「贴着聊天对话界面」），
 *   `top` 被钳制在父容器内，不会把面板拖出聊天框。
 *
 * 动画：面板显隐沿用 index.css `.stories-panel` 的过渡（受「动效总开关 / 分组」控制），
 * 本 Hook 只切换 `.open` 类与计时器，不触碰过渡本身 → 过渡流畅由 CSS 保证。
 */
export const STORIES_PEEK_MS = 2000; // 悬停开关后若未移入面板，自动收回的时长
export const STORIES_CLOSE_MS = 1500; // 移出侧栏后自动收回的时长

export interface StoriesPanelApi {
  /** 面板是否展开 */
  open: boolean;
  /** 侧栏 top 偏移（px） */
  top: number;
  /** 是否正在拖动 */
  dragging: boolean;
  /** 侧栏根元素 ref（调用方挂到 .stories） */
  storiesRef: RefObject<HTMLDivElement>;
  /** tab 悬停：弹出 + 启动 peek 计时 */
  onTabEnter: () => void;
  /** 面板悬停：取消 peek + 保持展开 */
  onPanelEnter: () => void;
  /** 侧栏整体进入：取消挂起的收回 */
  onWrapperEnter: () => void;
  /** 侧栏整体离开：启动延迟收回（编辑中不收） */
  onWrapperLeave: () => void;
  /** 抓 tab 按下：启动垂直拖动（仅左键） */
  onTabPointerDown: (e: ReactPointerEvent) => void;
  /** 直接设置展开态（如改名结束后的即时收起） */
  setOpen: (v: boolean) => void;
}

export function useStoriesPanel(isEditing: boolean): StoriesPanelApi {
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(64);
  const [dragging, setDragging] = useState(false);
  const storiesRef = useRef<HTMLDivElement>(null);
  const peekTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const drag = useRef<{ active: boolean; startY: number; startTop: number }>({
    active: false,
    startY: 0,
    startTop: 64,
  });
  // 始终持有最新的 isEditing，供计时器回调判断（改名编辑期间不收回）
  const isEditingRef = useRef(isEditing);

  const clearPeek = useCallback(() => {
    if (peekTimer.current !== null) {
      window.clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
  }, []);
  const clearClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  /** 保持展开：清掉所有计时 */
  const keepOpen = useCallback(() => {
    clearPeek();
    clearClose();
    setOpen(true);
  }, [clearPeek, clearClose]);

  /** 启动 peek：PEEK_MS 后收回（编辑中不收回） */
  const schedulePeek = useCallback(() => {
    clearPeek();
    clearClose();
    peekTimer.current = window.setTimeout(() => {
      peekTimer.current = null;
      if (isEditingRef.current) return; // 改名编辑期间不收回
      setOpen(false);
    }, STORIES_PEEK_MS);
  }, [clearPeek, clearClose]);

  /** 启动延迟收回：CLOSE_MS 后收回 */
  const scheduleClose = useCallback(() => {
    clearPeek();
    clearClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, STORIES_CLOSE_MS);
  }, [clearPeek, clearClose]);

  /** tab 悬停：弹出 + 启动 peek */
  const onTabEnter = useCallback(() => {
    keepOpen();
    schedulePeek();
  }, [keepOpen, schedulePeek]);

  /** 面板悬停：取消 peek + 保持展开（移入窗口则一直弹出） */
  const onPanelEnter = useCallback(() => {
    keepOpen();
  }, [keepOpen]);

  /** 侧栏整体离开：CLOSE_MS 后收回（编辑中不收） */
  const onWrapperLeave = useCallback(() => {
    if (isEditing) return;
    scheduleClose();
  }, [isEditing, scheduleClose]);

  /** 侧栏整体进入：取消挂起的收回（移回侧栏时不收） */
  const onWrapperEnter = useCallback(() => {
    clearClose();
  }, [clearClose]);

  /** 抓 tab 拖动（仅左键） */
  const onTabPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      drag.current = { active: true, startY: e.clientY, startTop: top };
      setDragging(true);
      const el = e.currentTarget as HTMLElement;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 部分环境不支持 pointer capture，window 监听兜底 */
      }
    },
    [top]
  );

  // 全局拖动监听（pointermove / pointerup）
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!drag.current.active) return;
      const parent = storiesRef.current?.parentElement;
      const h = parent?.clientHeight ?? window.innerHeight;
      const minTop = 8;
      const maxTop = Math.max(minTop + 120, h - 200);
      const next = Math.min(maxTop, Math.max(minTop, drag.current.startTop + (e.clientY - drag.current.startY)));
      setTop(next);
    };
    const onUp = () => {
      if (drag.current.active) {
        drag.current.active = false;
        setDragging(false);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  // 卸载清理计时器，避免对已卸载组件 setState
  useEffect(
    () => () => {
      clearPeek();
      clearClose();
    },
    [clearPeek, clearClose]
  );

  // 同步最新 isEditing 到 ref（供计时器回调读取）
  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);

  return {
    open,
    top,
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
