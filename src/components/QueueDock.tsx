// 请求队列贴边面板（v2.3.46）：仅主界面挂载（App.tsx）；快捷小窗（MiniChat）与悬浮球不支持。
// 主进程为每个模型（限速键）维护真实请求队列（electron/queueManager.ts），
// 本组件通过 queue:snapshot / queue:changed 展示快照，通过 queue:reorder 手动调整发送顺序。
// 贴边图标只能沿右缘上下拖动；点击图标线性弹出/收起面板（本组件 portal 挂 body，
// 不在 .anim-off 子树内，动效开关需内联判定）。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';
import type { QueueSnapshot, QueueLaneInfo } from '../types';

const DRAG_THRESHOLD = 4; // 位移超过该像素判定为拖动（否则视为点击展开/收起）

// 图标纵坐标范围：[8, 视口高-64]，只能贴右缘上下移动
function clampY(y: number): number {
  const max = window.innerHeight - 64;
  return Math.min(Math.max(y, 8), Math.max(8, max));
}

export default function QueueDock() {
  const { t } = useI18n();
  const [snap, setSnap] = useState<QueueSnapshot | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dockY, setDockY] = useState<number>(() => Math.round(window.innerHeight * 0.4));
  const [anim, setAnim] = useState(true); // 动效开关（enableAnimations），内联判定
  const [dragging, setDragging] = useState(false);
  const [dragOverIdx, setDragOverIdx] = useState(-1);
  const [panelH, setPanelH] = useState(0); // 面板实测高度（防面板底部溢出视口）
  const [viewportH, setViewportH] = useState(() => window.innerHeight); // 视口高度（resize 时触发重渲染重算 clamp）
  const [activeKey, setActiveKey] = useState('');
  const [tick, setTick] = useState(0); // 每秒自增，驱动 ETA 本地倒数重渲染

  const snapshotAtRef = useRef(Date.now());
  const dragRef = useRef<{ startY: number; startDockY: number; moved: boolean } | null>(null);
  const dragSrcRef = useRef(-1); // 拖拽排序的源 index
  const panelRef = useRef<HTMLDivElement | null>(null); // 面板元素（实测高度用）

  const lanes = snap?.lanes ?? [];
  const total = snap?.total ?? 0;
  // 当前展示的 lane：优先用户点选的 key，否则第一个；队列消失时自动回退
  const activeLane: QueueLaneInfo | null = useMemo(
    () => lanes.find((l) => l.key === activeKey) || lanes[0] || null,
    [lanes, activeKey]
  );

  // 初始化：位置/动效开关 + 首个快照 + 订阅
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const s = await api.getSettings();
        if (disposed) return;
        if (typeof s.queueDockY === 'number') setDockY(clampY(s.queueDockY));
        setAnim(s.enableAnimations !== false);
      } catch {
        /* 忽略：使用缺省值 */
      }
    })();
    const offSettings = api.onSettingsChanged((_e, patch: Record<string, unknown> | undefined) => {
      if (!patch) return;
      if (typeof patch.enableAnimations === 'boolean') setAnim(patch.enableAnimations);
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

  // 面板实测高度：mount 与内容变化时更新（offsetHeight 不受 transform/opacity 影响，隐藏态也可量）
  useEffect(() => {
    const el = panelRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setPanelH(el.offsetHeight));
    ro.observe(el);
    setPanelH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  // 窗口 resize：触发重渲染，把手/面板 top 重新 clamp（面板高度由 ResizeObserver 自动跟随）
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
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
  const resetDrag = () => {
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

  // 面板顶部与图标对齐（用实测面板高度防溢出视口底部：top ≤ innerHeight − panelH − 12）
  void viewportH; // resize 时经该 state 触发重渲染，保证此处读到最新视口尺寸
  const panelTop = Math.max(8, Math.min(clampY(dockY), window.innerHeight - panelH - 12));

  return createPortal(
    <>
      {/* 贴边把手：22×56px 贴右缘，只能沿右缘上下拖动 */}
      <div
        className={`queue-dock-handle${dragging ? ' dragging' : ''}`}
        style={{ top: clampY(dockY), transition: anim ? 'opacity .18s linear' : 'none' }}
        title={t('queue.dockTip')}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerCancel}
      >
        <span>🕒</span>
        {total > 0 && <span className="queue-dock-badge">{total}</span>}
      </div>

      {/* 完整队列面板：线性弹出/缩回（0.18s linear） */}
      <div
        ref={panelRef}
        className="queue-dock-panel"
        style={{
          top: panelTop,
          transform: expanded ? 'none' : 'translateX(calc(100% + 24px))',
          opacity: expanded ? 1 : 0,
          pointerEvents: expanded ? 'auto' : 'none',
          transition: anim ? 'transform .18s linear, opacity .18s linear' : 'none',
        }}
      >
        <div className="queue-dock-head">
          <span>⏳</span>
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

        {/* 多模型时按模型分页展示（不同模型队列互不影响） */}
        {lanes.length > 1 && (
          <>
            <div className="queue-dock-tabs">
              {lanes.map((l) => (
                <button
                  key={l.key}
                  type="button"
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
