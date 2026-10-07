// 请求队列贴边面板（v2.3.46 创建；v2.3.96 改为「以队列图标为锚点」展开）：
// 仅主界面挂载（App.tsx）；快捷小窗（MiniChat）与悬浮球不支持。
// 主进程为每个模型（限速键）维护真实请求队列（electron/queueManager.ts），
// 本组件通过 queue:snapshot / queue:changed 展示快照，通过 queue:reorder 手动调整发送顺序。
//
// ===== v2.3.96 用户反馈与改法 =====
// 反馈原文：「请求队列的面板弹出，应该是从这个队列图标的边缘展开，而不是从软件的边缘展开。」
// 改前：面板 `right: 26px`（贴软件右缘的常量）+ `top: 图标顶`（顶对齐）。
//       340px 宽的面板挂在 22px 图标的下方，且横向贴着窗口边缘 —— 视觉上就是「从软件边缘长出来」。
// 改后：面板位置**全部由图标实测矩形推导**（panelPlacement）：
//   ① 横向 right = 图标实测宽度 + 间隙 → 面板右缘恒紧邻图标左缘，图标一动面板就跟着动；
//   ② 纵向 top = 图标垂直中心 − 面板半高（居中对齐），再 clamp 进视口 ——
//      这同时实现了「靠近上下边缘时的翻转/收缩」：图标在上半屏时面板被下推、
//      在下半屏时面板被上顶，永远不会超出窗口被裁切（详见 panelPlacement 注释）；
//   ③ 面板宽度由 max-width 收窄，保证不超过图标左侧的可用空间。
// 拖动时 dockY 每帧更新 → 面板位置在同一渲染帧重算，实时跟随（非只在打开那一刻算一次）。
//
// 动效：全部收进 index.css 的类规则（.queue-dock-panel 基态=收起态，.expanded=展开态），
// 由 src/utils/animControl.ts 的 queue 分组门禁统一 kill，组件内**不再裸写 inline 动画**。
// 采用「基态=收起态 + transition」而非「基态=展开态 + animation」，理由见 index.css 对应注释
// 与 hooks/useRetract.ts 的「基态陷阱」说明：动画被关掉时直接落到基态（收起），不会关不掉。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { QueueSnapshot, QueueLaneInfo } from '../types';

const DRAG_THRESHOLD = 4; // 位移超过该像素判定为拖动（否则视为点击展开/收起）

/** 面板与图标左缘的水平间隙（px） */
const PANEL_GAP = 6;
/** 面板与视口上下边缘的最小留白（px） */
const PANEL_EDGE = 8;
/** 面板左缘与视口左边缘的最小留白（px） */
const PANEL_EDGE_X = 12;
/** 面板与图标的固定 id 绑定（aria-controls 用） */
const PANEL_ID = 'queue-dock-panel';
/** 图标尺寸兜底值（与 index.css 的 .queue-dock-handle 一致；实测成功前使用） */
const ICON_FALLBACK = { w: 22, h: 56 };

/** 图标纵坐标范围：[8, 视口高-64]，只能贴右缘上下移动 */
function clampY(y: number): number {
  const max = window.innerHeight - 64;
  return Math.min(Math.max(y, 8), Math.max(8, max));
}

export default function QueueDock() {
  const { t } = useI18n();
  const [snap, setSnap] = useState<QueueSnapshot | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dockY, setDockY] = useState<number>(() => Math.round(window.innerHeight * 0.4));
  const [iconSize, setIconSize] = useState(ICON_FALLBACK); // 图标实测尺寸（锚点基准）
  const [dragging, setDragging] = useState(false);
  const [dragOverIdx, setDragOverIdx] = useState(-1);
  const [panelH, setPanelH] = useState(0); // 面板实测高度（定位与防溢出用）
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1024 : window.innerWidth,
    h: typeof window === 'undefined' ? 768 : window.innerHeight,
  }));
  const [activeKey, setActiveKey] = useState('');
  const [tick, setTick] = useState(0); // 每秒自增，驱动 ETA 本地倒数重渲染

  const snapshotAtRef = useRef(Date.now());
  const dragRef = useRef<{ startY: number; startDockY: number; moved: boolean } | null>(null);
  const dragSrcRef = useRef(-1); // 拖拽排序的源 index
  const panelRef = useRef<HTMLDivElement | null>(null); // 面板元素（实测高度用）
  const handleRef = useRef<HTMLButtonElement | null>(null); // 图标元素（实测尺寸用）

  const lanes = snap?.lanes ?? [];
  const total = snap?.total ?? 0;
  // 当前展示的 lane：优先用户点选的 key，否则第一个；队列消失时自动回退
  const activeLane: QueueLaneInfo | null = useMemo(
    () => lanes.find((l) => l.key === activeKey) || lanes[0] || null,
    [lanes, activeKey]
  );

  // 初始化：位置 + 首个快照 + 订阅
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const s = await api.getSettings();
        if (disposed) return;
        if (typeof s.queueDockY === 'number') setDockY(clampY(s.queueDockY));
      } catch {
        /* 忽略：使用缺省值 */
      }
    })();
    const offSettings = api.onSettingsChanged((_e, patch: Record<string, unknown> | undefined) => {
      if (!patch) return;
      if (typeof patch.queueDockY === 'number') setDockY(clampY(patch.queueDockY));
    });
    const offQueue = api.onQueueChanged((data) => {
      setSnap(data);
      snapshotAtRef.current = Date.now();
    });
    api
      .queueSnapshot()
      .then((data) => {
        if (disposed) return;
        setSnap(data);
        snapshotAtRef.current = Date.now();
      })
      .catch(() => {});
    return () => {
      disposed = true;
      offSettings();
      offQueue();
    };
  }, []);

  // 每秒强制重渲染一次，让面板里的预计发出时间本地倒数
  useEffect(() => {
    const timer = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 图标实测尺寸：面板锚点的基准。挂载后 + 主题/字号变化导致尺寸变化时（ResizeObserver）更新，
  // 这样 CSS 里改了图标宽高，面板会自动跟着走，不会又变成「贴软件边缘」。
  useEffect(() => {
    const el = handleRef.current;
    if (!el) return;
    const measure = (): void => {
      const w = el.offsetWidth || ICON_FALLBACK.w;
      const h = el.offsetHeight || ICON_FALLBACK.h;
      setIconSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 面板实测高度：mount 与内容变化时更新（offsetHeight 不受 transform/opacity/visibility 影响，
  // 收起态也可量）。用于纵向居中定位与 max-height 收缩。
  useEffect(() => {
    const el = panelRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setPanelH(el.offsetHeight));
    ro.observe(el);
    setPanelH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  // 窗口 resize：重算视口尺寸 → 面板位置与 max-width/max-height 跟着重算（不依赖展开态）
  useEffect(() => {
    const onResize = (): void => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ETA 文案：快照 etaMs 减去快照后经过的秒数，clamp≥0
  const etaText = (etaMs: number): string => {
    void tick; // 仅为触发重渲染依赖
    const remain = Math.ceil((etaMs - (Date.now() - snapshotAtRef.current)) / 1000);
    return remain <= 0 ? t('queue.etaNow') : t('queue.eta', { sec: remain });
  };

  // ===== 贴边图标拖动（仅垂直方向，right 恒 0）=====
  const onHandlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startY: e.clientY, startDockY: dockY, moved: false };
  };
  const onHandlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dy) > DRAG_THRESHOLD) {
      d.moved = true;
      setDragging(true);
    }
    if (d.moved) setDockY(clampY(d.startDockY + dy));
  };
  // 清理拖动状态（pointerup 与 pointercancel 共用）
  const resetDrag = (): void => {
    dragRef.current = null;
    setDragging(false);
  };
  const onHandlePointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    resetDrag();
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (!d) return;
    if (d.moved) {
      // 拖动结束：位置落盘（仅主界面图标纵坐标）
      const y = clampY(d.startDockY + (e.clientY - d.startY));
      api.saveSettings({ queueDockY: y }).catch(() => {});
    } else {
      // 未拖动 → 视为点击：展开/收起面板
      setExpanded((v) => !v);
    }
  };
  // 系统取消拖拽（如触摸被中断）：仅清理状态，不落盘、不触发展开
  const onHandlePointerCancel = (e: React.PointerEvent) => {
    resetDrag();
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  // 键盘操作：图标是真正的 <button>，但展开/收起逻辑在 pointerup 里判定拖动，
  // 故键盘需单独走 onKeyDown（Enter / 空格），并 preventDefault 避免空格滚动页面。
  // 不绑 onClick：否则鼠标点击会「pointerup 一次 + click 一次」双触发。
  const onHandleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    setExpanded((v) => !v);
  };

  // ===== 面板定位：全部由「图标实测矩形」推导 =====
  // 图标：right:0、宽 iconSize.w、高 iconSize.h、顶 dockY（clamp 后）
  // 面板：右缘紧邻图标左缘 → right = iconSize.w + PANEL_GAP
  //      纵向与图标中心对齐 → top = 图标中心 − 面板半高，再 clamp 进视口
  // 边界翻转/收缩：clamp 天然实现「翻转」——
  //   · 图标靠近上边缘时，居中值 < PANEL_EDGE，面板被下推到 PANEL_EDGE（不会顶出视口）；
  //   · 图标靠近下边缘时，居中值 > 视口高−面板高−PANEL_EDGE，面板被上顶（不会底出视口）；
  //   · 图标贴右缘，右侧无空间，故水平方向只做「收缩」（max-width），不做左右翻转。
  // 面板高度本身也受 max-height 限制（CSS），所以面板再高也不会超出视口。
  // 由于 dockY 每次 pointermove 都更新，本段在每次渲染重算 → 面板实时跟随图标。
  const placement = useMemo(() => {
    const iconTop = clampY(dockY);
    const iconCenterY = iconTop + iconSize.h / 2;
    const right = iconSize.w + PANEL_GAP;
    // 纵向可用高度（视口上下各留 PANEL_EDGE），面板高度超了就由 CSS max-height 内部滚动
    const maxH = Math.max(0, viewport.h - PANEL_EDGE * 2);
    const h = Math.min(panelH, maxH);
    const top = Math.min(
      Math.max(iconCenterY - h / 2, PANEL_EDGE),
      Math.max(PANEL_EDGE, viewport.h - h - PANEL_EDGE)
    );
    // 水平可用宽度：图标左侧留 PANEL_EDGE_X；不足时收窄（面板 CSS 里 width:340px + max-width）
    const maxW = Math.max(120, viewport.w - right - PANEL_EDGE_X);
    return { top, right, maxW };
  }, [dockY, iconSize, panelH, viewport]);

  // 面板定位样式：只输出几何量（top / right / max-width），**不含任何 transition/animation**。
  // 刻意覆盖 CSS 里的兜底值（--queue-dock-panel-right: 26px / max-width calc(...)）：
  // 那两个值只在图标尚未测量完成的首帧生效，测量完成后一律以本处按图标实测推导的值为准。
  const panelStyle = {
    top: placement.top,
    right: placement.right,
    maxWidth: placement.maxW,
  } as React.CSSProperties;

  // 说明：v2.3.96 起本组件**不再内联判定动效开关**（原先靠 isGroupEnabled 拼 inline transition，
  // 那既不受 animControl 门禁管理、也是「裸写动画」）。动画已全部收进 index.css 的类规则，
  // 由 animControl 的 queue 分组（.anim-off / data-anim-off~="queue"）统一 kill。

  // ===== 调序：乐观更新本地快照 + 调用主进程（广播回来后覆盖）=====
  const applyReorder = useCallback(async (key: string, ids: string[]) => {
    setSnap((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        lanes: prev.lanes.map((l) => {
          if (l.key !== key) return l;
          const lockedHead = l.items[0]?.locked ? l.items[0] : null;
          const map = new Map(l.items.map((it) => [it.id, it]));
          const restIds = lockedHead ? ids.filter((id) => id !== lockedHead.id) : ids;
          const rest = restIds.map((id) => map.get(id)).filter(Boolean) as typeof l.items;
          return { ...l, items: lockedHead ? [lockedHead, ...rest] : rest };
        }),
      };
    });
    try {
      await api.queueReorder(key, ids);
    } catch {
      /* 主进程校验失败时以广播快照为准 */
    }
  }, []);

  // ↑↓ 按钮：与相邻项交换（队头倒计时锁定项不可跨越）
  const moveItem = (lane: QueueLaneInfo, index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= lane.items.length) return;
    if (lane.items[index].locked || lane.items[target].locked) return;
    const ids = lane.items.map((it) => it.id);
    const tmp = ids[index];
    ids[index] = ids[target];
    ids[target] = tmp;
    void applyReorder(lane.key, ids);
  };

  // HTML5 拖拽排序
  const onItemDragStart = (lane: QueueLaneInfo, index: number) => {
    if (lane.items[index].locked) return;
    dragSrcRef.current = index;
  };
  const onItemDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragOverIdx !== index) setDragOverIdx(index);
  };
  const onItemDrop = (e: React.DragEvent, lane: QueueLaneInfo, index: number) => {
    e.preventDefault();
    const src = dragSrcRef.current;
    dragSrcRef.current = -1;
    setDragOverIdx(-1);
    if (src < 0 || src === index) return;
    if (lane.items[src]?.locked || lane.items[index]?.locked) return;
    const ids = lane.items.map((it) => it.id);
    const moved = ids.splice(src, 1)[0];
    ids.splice(index, 0, moved);
    void applyReorder(lane.key, ids);
  };

  return createPortal(
    <>
      {/* 贴边把手：22×56px 贴右缘，只能沿右缘上下拖动。
          用 <button> 而非 <div>：图标本身就是一个「展开/收起」控件，
          键盘可达（Enter/空格）+ aria-expanded/aria-haspopup 都依赖原生按钮语义。 */}
      <button
        type="button"
        ref={handleRef}
        id="queue-dock-handle"
        className={`queue-dock-handle${dragging ? ' dragging' : ''}`}
        style={{ top: clampY(dockY) }}
        title={t('queue.dockTip')}
        aria-label={t('queue.title')}
        aria-expanded={expanded}
        aria-haspopup="dialog"
        aria-controls={PANEL_ID}
        onKeyDown={onHandleKeyDown}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerCancel}
      >
        <span aria-hidden="true">🕒</span>
        {total > 0 && (
          <span className="queue-dock-badge" aria-hidden="true">
            {total}
          </span>
        )}
      </button>

      {/* 完整队列面板：从「队列图标」那一侧（右侧）生长展开。
          role="dialog" + aria-modal="false"：它不是模态框（无遮罩、不抢焦点），
          但语义上确实是「由图标唤起的一组控件」，故用 dialog 而非 region。 */}
      <div
        id={PANEL_ID}
        ref={panelRef}
        className={`queue-dock-panel${expanded ? ' expanded' : ''}`}
        style={panelStyle}
        role="dialog"
        aria-modal="false"
        aria-label={t('queue.title')}
      >
        <div className="queue-dock-head">
          <span aria-hidden="true">⏳</span>
          <span>{t('queue.title')}</span>
          <span className="queue-dock-count">{t('queue.count', { n: total })}</span>
          <button
            type="button"
            className="queue-dock-close"
            title={t('common.close')}
            aria-label={t('common.close')}
            onClick={() => setExpanded(false)}
          >
            ×
          </button>
        </div>

        {/* 多模型时按模型分页展示（不同模型队列互不影响）。
            刻意用 role="group" + aria-pressed 而非 role="tablist"：
            tablist 要求必须有 role="tabpanel" 的关联面板与 aria-controls，
            本组件的列表区不是独立可切换面板，硬套 tab 语义会做出「有 tab 无 tabpanel」的
            残缺结构（违反 WCAG 4.1.2）。aria-pressed 的切换按钮组语义准确且无此问题。 */}
        {lanes.length > 1 && (
          <>
            <div className="queue-dock-tabs" role="group" aria-label={t('queue.title')}>
              {lanes.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  aria-pressed={activeLane?.key === l.key}
                  className={`queue-dock-tab${activeLane?.key === l.key ? ' active' : ''}`}
                  onClick={() => setActiveKey(l.key)}
                >
                  {l.modelName}
                </button>
              ))}
            </div>
            <div className="queue-dock-lane-tip">{t('queue.laneTip')}</div>
          </>
        )}

        {!activeLane || activeLane.items.length === 0 ? (
          <>
            <div className="queue-dock-empty">{t('queue.empty')}</div>
            <div className="queue-dock-drag-hint">{t('queue.dragHint')}</div>
          </>
        ) : (
          <>
            {activeLane.items.map((it, idx) => (
              <div
                key={it.id}
                className={`queue-dock-item${dragOverIdx === idx ? ' drag-over' : ''}`}
                draggable={!it.locked}
                onDragStart={() => onItemDragStart(activeLane, idx)}
                onDragOver={(e) => onItemDragOver(e, idx)}
                onDragLeave={() => setDragOverIdx((v) => (v === idx ? -1 : v))}
                onDrop={(e) => onItemDrop(e, activeLane, idx)}
                onDragEnd={() => {
                  dragSrcRef.current = -1;
                  setDragOverIdx(-1);
                }}
              >
                <span className="queue-dock-idx">{idx + 1}</span>
                <span className="queue-dock-label">{it.label}</span>
                {it.locked && <span className="queue-dock-locked">{t('queue.locked')}</span>}
                <span className="queue-dock-eta">{etaText(it.etaMs)}</span>
                <button
                  type="button"
                  className="queue-dock-btn"
                  disabled={it.locked || idx === 0 || !!activeLane.items[idx - 1]?.locked}
                  title={t('queue.moveUp')}
                  aria-label={t('queue.moveUp')}
                  onClick={() => moveItem(activeLane, idx, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="queue-dock-btn"
                  disabled={
                    it.locked || idx === activeLane.items.length - 1 || !!activeLane.items[idx + 1]?.locked
                  }
                  title={t('queue.moveDown')}
                  aria-label={t('queue.moveDown')}
                  onClick={() => moveItem(activeLane, idx, 1)}
                >
                  ↓
                </button>
              </div>
            ))}
            <div className="queue-dock-drag-hint">{t('queue.dragHint')}</div>
          </>
        )}
      </div>
    </>,
    document.body
  );
}
